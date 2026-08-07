/**
 * Ponte entre o canUseTool do Agent SDK e a UI de aprovações.
 * O SDK pergunta "posso usar esta ferramenta?" → viramos isso num
 * PermissionRequest visível na UI e esperamos a decisão humana.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../../shared/types.js";
import { PERMISSION_TIMEOUT_MS } from "../config.js";
import { broadcast } from "../events.js";
import { addPermission, getPermission, getTask, newId, removePermission, transcriptAppend } from "../store.js";
import { registrarPermissao } from "../eval/coleta.js";

interface Decision {
  allow: boolean;
  /** "Sempre permitir ações como esta nesta tarefa" (checkbox da UI). */
  remember?: boolean;
  /** Mensagem enviada ao Claude quando negado (explica o porquê). */
  denyMessage?: string;
}

interface Pending {
  taskId: string;
  resolve: (d: Decision) => void;
  timer: NodeJS.Timeout;
}

/** Decisões pendentes: requestId → resolver da Promise que o canUseTool aguarda. */
const pending = new Map<string, Pending>();

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Descrição em português de leigo para o pedido de permissão. */
function friendlyFor(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    return `Executar comando: ${truncate(String(input["command"] ?? ""))}`;
  }
  if (toolName === "WebFetch") {
    return `Acessar a internet: ${truncate(String(input["url"] ?? ""))}`;
  }
  if (toolName === "WebSearch") {
    return `Acessar a internet: ${truncate(String(input["query"] ?? ""))}`;
  }
  if (toolName.startsWith("mcp__")) {
    // mcp__servidor__ferramenta → "servidor: ferramenta"
    const parts = toolName.split("__").filter(Boolean).slice(1);
    return `Usar ferramenta externa: ${parts.join(": ") || toolName}`;
  }
  return `Usar ${toolName}`;
}

/**
 * Conclui um pedido pendente (decisão humana, timeout ou aborto da fase).
 * Retorna false se o id não está (mais) pendente.
 */
function finish(
  requestId: string,
  allow: boolean,
  denyMessage?: string,
  remember?: boolean,
  origem: "humano" | "timeout" | "abort" = "humano",
): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  pending.delete(requestId);
  clearTimeout(p.timer);
  // Eval: latência e desfecho da decisão (o registro ainda tem createdAt aqui).
  const registro = getPermission(requestId);
  if (registro) {
    registrarPermissao({
      taskId: p.taskId,
      requestId,
      tool: registro.toolName,
      esperaMs: Math.max(0, Date.now() - Date.parse(registro.createdAt)),
      desfecho: origem === "humano" ? (allow ? "permitiu" : "negou") : origem === "timeout" ? "timeout" : "abortada",
      ...(remember ? { lembrar: true } : {}),
    });
  }
  removePermission(requestId);
  broadcast({ type: "permission_resolved", requestId, allowed: allow });
  p.resolve({ allow, remember, denyMessage });
  return true;
}

/**
 * Resolve (negando) todos os pedidos pendentes de uma tarefa.
 * Usado pelo cancel da esteira para não deixar cards órfãos na UI.
 */
export function finishAllForTask(taskId: string, denyMessage = "A tarefa foi cancelada."): void {
  for (const [id, p] of [...pending]) {
    if (p.taskId === taskId) finish(id, false, denyMessage);
  }
}

/**
 * Cria o callback canUseTool de uma tarefa: cada pedido do Claude vira um
 * PermissionRequest na UI e fica aguardando até decisão, timeout ou aborto.
 */
export function createPermissionGate(taskId: string): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
    // Modo auto da tarefa: concede sem perguntar, registrando no chat.
    if (getTask(taskId)?.autoAprovar) {
      const item = {
        kind: "system" as const,
        text: `Permitido automaticamente (modo auto): ${friendlyFor(toolName, input)}`,
        at: new Date().toISOString(),
      };
      transcriptAppend(taskId, item);
      broadcast({ type: "transcript", taskId, item });
      registrarPermissao({
        taskId,
        requestId: newId(),
        tool: toolName,
        esperaMs: 0,
        desfecho: "auto",
      });
      return {
        behavior: "allow",
        updatedInput: input,
        ...(options.suggestions ? { updatedPermissions: options.suggestions } : {}),
      };
    }
    const id = newId();
    const request: PermissionRequest = {
      id,
      taskId,
      toolName,
      friendly: friendlyFor(toolName, input),
      input,
      createdAt: new Date().toISOString(),
    };
    addPermission(request);
    // O card de permission_request na UI já mostra a ação — o transcript não
    // repete o item (o runner já registrou o tool_use correspondente).
    broadcast({ type: "permission_request", request });

    const decision = await new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        finish(id, false, "Sem resposta — negado por segurança", undefined, "timeout");
      }, PERMISSION_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { taskId, resolve, timer });
      // Fase abortada (timeout global / cancelamento): não deixar o pedido órfão.
      options.signal.addEventListener(
        "abort",
        () => finish(id, false, "A tarefa foi interrompida — pedido cancelado.", undefined, "abort"),
        { once: true },
      );
    });

    if (decision.allow) {
      // "Sempre permitir": devolve as suggestions do SDK como updatedPermissions
      // (escopo "session" = só esta tarefa) para não perguntar de novo.
      const updatedPermissions =
        decision.remember && options.suggestions && options.suggestions.length > 0
          ? options.suggestions.map((s) => ({ ...s, destination: "session" as const }))
          : undefined;
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID: options.toolUseID,
        ...(updatedPermissions ? { updatedPermissions } : {}),
      };
    }
    return {
      behavior: "deny",
      message: decision.denyMessage ?? "Negado pelo usuário.",
      toolUseID: options.toolUseID,
    };
  };
}

// ---------- Gate do preview (fase em que o agente prepara/exercita o preview) ----------

/**
 * Servidor de dev/preview de vida-longa (regra de ouro: quem sobe é o Inhouse).
 * Cobre scripts de package-manager (dev/start/serve/preview) e binários de framework.
 * `vitest` NÃO casa (o \b depois de "vite" exige fronteira) e `vite build` é liberado.
 */
const RE_SERVIDOR_DEV =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:\S+\s+)*(?<![-\w])(?:dev|start|serve|preview)\b|\bnext\s+(?:dev|start)\b|\bvite\b(?!\s+build)|\bastro\s+(?:dev|preview)\b|\bnuxt\s+(?:dev|start)\b|\bremix\s+dev\b|\bng\s+serve\b|\bgatsby\s+develop\b|\b(?:http-server|serve)\b|\bwebpack(?:-dev-server|\s+serve)\b|\bphp\s+-S\b|\brails\s+s(?:erver)?\b|\bpython[0-9.]*\s+-m\s+http\.server\b/i;

/**
 * Comandos de setup seguros e comuns (instalar, subir docker, migrations, inspeção).
 * ANCORADO no início do comando (depois de eventuais `VAR=val`): o verbo seguro tem
 * que ser O COMANDO, não um argumento — senão `rm -rf test` casaria por conter "test".
 */
const RE_SETUP_SEGURO = new RegExp(
  "^(?:\\w+=\\S*\\s+)*(?:" +
    [
      String.raw`(?:npm|pnpm|yarn|bun)\s+(?:install|ci)\b`, // instalar deps
      String.raw`corepack\s+(?:enable|prepare|install)\b`,
      String.raw`docker\s+compose\s+(?:up|start|pull|build|ps|logs)\b`,
      String.raw`docker-compose\s+(?:up|start|pull|build|ps|logs)\b`,
      String.raw`docker\s+(?:ps|start)\b`,
      String.raw`(?:npx\s+)?prisma\s+(?:migrate|generate|db|format)\b`, // migrations/orm
      String.raw`(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:migrate|db:migrate|db:seed|seed|prisma)\b`,
      String.raw`(?:rails|rake)\s+db:[a-z:]+`,
      String.raw`bundle\s+exec\s+rake\s+db:[a-z:]+`,
      String.raw`alembic\s+upgrade\b`,
      String.raw`drizzle-kit\s+\w+`,
      String.raw`knex\s+migrate\b`,
      String.raw`node\s+(?:-v|--version)\b`,
      String.raw`(?:ls|cat|echo|pwd|env|printenv|which|head|tail|grep|mkdir|touch|cp|test)\b`, // inspeção/fs simples
    ].join("|") +
    ")",
  "i",
);

/** É um comando de servidor de dev? (regra de ouro do preview) */
export function ehServidorDev(cmd: string): boolean {
  return RE_SERVIDOR_DEV.test(cmd);
}

/**
 * Dá para auto-aprovar este comando na fase de preview? Só comandos SIMPLES
 * (sem encadeamento/redirecionamento/subshell) — o encadeamento poderia esconder
 * algo perigoso depois de um comando inocente. curl/wget só para o próprio preview.
 */
export function ehSetupSeguro(cmd: string): boolean {
  const c = cmd.trim();
  if (!c) return false;
  // curl/wget: liberado só quando TODAS as URLs são do preview local (sem exfiltração).
  if (/^(?:curl|wget)\b/i.test(c)) {
    if (/[;`|<>]|\$\(/.test(c)) return false;
    const urls = c.match(/https?:\/\/[^\s"'`]+/gi) ?? [];
    return (
      urls.length > 0 &&
      urls.every((u) => /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:[/?#]|$)/i.test(u))
    );
  }
  // Demais comandos: sem encadeamento e dentro da lista segura.
  if (/[;`|<>]|\$\(|&&|\|\||&\s*$/.test(c)) return false;
  return RE_SETUP_SEGURO.test(c);
}

function sistemaChat(taskId: string, text: string): void {
  const item = { kind: "system" as const, text, at: new Date().toISOString() };
  transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

/**
 * Gate da fase de preview: o agente pode preparar o ambiente (env, docker,
 * migrations) com o setup seguro AUTO-APROVADO e o servidor de dev AUTO-NEGADO
 * (a guarda concreta da regra de ouro — quem sobe o preview é o Inhouse). O resto
 * cai no gate normal. NÃO mexe no step/status da esteira (roda dentro das verificações).
 */
export function createPreviewSetupGate(taskId: string): CanUseTool {
  const base = createPermissionGate(taskId);
  return async (toolName, input, options): Promise<PermissionResult | null> => {
    if (toolName === "Bash") {
      const cmd = String((input as Record<string, unknown>)["command"] ?? "");
      // Regra de ouro vence até o modo auto: nunca deixamos o agente subir o server.
      if (ehServidorDev(cmd)) {
        sistemaChat(taskId, `Preview: bloqueei "${truncate(cmd)}" — quem sobe o servidor é o Inhouse.`);
        return {
          behavior: "deny",
          message:
            "NÃO rode o servidor de desenvolvimento — quem sobe e gerencia o preview é o Inhouse, numa porta própria. " +
            'Se precisa definir COMO subir, descreva o comando no JSON da receita (campo "cmd"), não execute você mesmo. ' +
            "Para conferir uma rota, use curl no preview que já está no ar.",
          ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
        };
      }
      // Setup seguro: libera sem perguntar (o modo auto já faz isso via base).
      if (!getTask(taskId)?.autoAprovar && ehSetupSeguro(cmd)) {
        sistemaChat(taskId, `Preview: liberei automaticamente "${truncate(cmd)}" (preparo seguro).`);
        registrarPermissao({ taskId, requestId: newId(), tool: toolName, esperaMs: 0, desfecho: "auto" });
        return {
          behavior: "allow",
          updatedInput: input,
          ...(options.toolUseID ? { toolUseID: options.toolUseID } : {}),
        };
      }
    }
    return base(toolName, input, options);
  };
}

/**
 * Aplica a decisão vinda da UI (POST /api/permissions/:id/decision).
 * `remember` = "sempre permitir ações como esta nesta tarefa".
 * Retorna false se o pedido não existe ou já foi resolvido.
 */
export function resolvePermission(requestId: string, allow: boolean, remember = false): boolean {
  return finish(
    requestId,
    allow,
    allow ? undefined : "O usuário negou esta ação. Siga sem ela ou proponha uma alternativa.",
    allow && remember,
  );
}
