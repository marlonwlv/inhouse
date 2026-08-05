/**
 * Ponte entre o canUseTool do Agent SDK e a UI de aprovações.
 * O SDK pergunta "posso usar esta ferramenta?" → viramos isso num
 * PermissionRequest visível na UI e esperamos a decisão humana.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../../shared/types.js";
import { PERMISSION_TIMEOUT_MS } from "../config.js";
import { broadcast } from "../events.js";
import { addPermission, getTask, newId, removePermission, transcriptAppend } from "../store.js";

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
function finish(requestId: string, allow: boolean, denyMessage?: string, remember?: boolean): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  pending.delete(requestId);
  clearTimeout(p.timer);
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
        finish(id, false, "Sem resposta — negado por segurança");
      }, PERMISSION_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { taskId, resolve, timer });
      // Fase abortada (timeout global / cancelamento): não deixar o pedido órfão.
      options.signal.addEventListener(
        "abort",
        () => finish(id, false, "A tarefa foi interrompida — pedido cancelado."),
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
