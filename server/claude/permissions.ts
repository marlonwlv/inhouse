/**
 * Ponte entre o canUseTool do Agent SDK e a UI de aprovações.
 * O SDK pergunta "posso usar esta ferramenta?" → viramos isso num
 * PermissionRequest visível na UI e esperamos a decisão humana.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionRequest } from "../../shared/types.js";
import { PERMISSION_TIMEOUT_MS } from "../config.js";
import { broadcast } from "../events.js";
import { addPermission, newId, removePermission, transcriptAppend } from "../store.js";

interface Decision {
  allow: boolean;
  /** Mensagem enviada ao Claude quando negado (explica o porquê). */
  denyMessage?: string;
}

interface Pending {
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
function finish(requestId: string, allow: boolean, denyMessage?: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  pending.delete(requestId);
  clearTimeout(p.timer);
  removePermission(requestId);
  broadcast({ type: "permission_resolved", requestId, allowed: allow });
  p.resolve({ allow, denyMessage });
  return true;
}

/**
 * Cria o callback canUseTool de uma tarefa: cada pedido do Claude vira um
 * PermissionRequest na UI e fica aguardando até decisão, timeout ou aborto.
 */
export function createPermissionGate(taskId: string): CanUseTool {
  return async (toolName, input, options): Promise<PermissionResult> => {
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
    broadcast({ type: "permission_request", request });
    transcriptAppend(taskId, {
      kind: "tool",
      op: "?",
      label: request.friendly,
      at: request.createdAt,
    });

    const decision = await new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => {
        finish(id, false, "Sem resposta — negado por segurança");
      }, PERMISSION_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { resolve, timer });
      // Fase abortada (timeout global / cancelamento): não deixar o pedido órfão.
      options.signal.addEventListener(
        "abort",
        () => finish(id, false, "A tarefa foi interrompida — pedido cancelado."),
        { once: true },
      );
    });

    if (decision.allow) {
      return { behavior: "allow", updatedInput: input, toolUseID: options.toolUseID };
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
 * Retorna false se o pedido não existe ou já foi resolvido.
 */
export function resolvePermission(requestId: string, allow: boolean): boolean {
  return finish(
    requestId,
    allow,
    allow ? undefined : "O usuário negou esta ação. Siga sem ela ou proponha uma alternativa.",
  );
}
