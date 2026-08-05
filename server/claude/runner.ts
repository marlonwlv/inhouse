/**
 * Wrapper do Agent SDK: roda uma fase do workflow numa sessão do Claude Code
 * genuíno da máquina (login/subscription — nunca API key; ver ARCHITECTURE.md).
 */
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { AbortError, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  Options,
  PermissionMode,
  SDKAssistantMessage,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptItem } from "../../shared/types.js";
import { claudeEnv, claudePath } from "../config.js";
import { broadcast } from "../events.js";
import { transcriptAppend } from "../store.js";

/** Timeout de segurança global de uma fase. */
const PHASE_TIMEOUT_MS = 20 * 60 * 1000;

export interface PhaseResult {
  sessionId?: string;
  finalText: string;
  planText?: string;
  success: boolean;
  errorMessage?: string;
}

export interface RunPhaseOpts {
  taskId: string;
  cwd: string;
  prompt: string;
  permissionMode: PermissionMode;
  /** Session id para retomar (resume) uma sessão anterior. */
  resume?: string;
  /** Se omitido, usa o modelo configurado pelo usuário no Claude Code. */
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Caminho curto para exibição: relativo ao espaço da tarefa quando possível. */
function shortPath(p: string, cwd: string): string {
  if (!p) return "(arquivo)";
  const rel = relative(cwd, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

/** Item de transcript (op + label em português) para um tool_use do Claude. */
function toolItem(name: string, input: Record<string, unknown>, cwd: string): TranscriptItem {
  const at = new Date().toISOString();
  const file = String(input["file_path"] ?? input["notebook_path"] ?? "");
  switch (name) {
    case "Write":
      return { kind: "tool", op: "+", label: `Criar arquivo ${shortPath(file, cwd)}`, at };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "tool", op: "✎", label: `Editar ${shortPath(file, cwd)}`, at };
    case "Bash": {
      const cmd = String(input["command"] ?? "");
      return {
        kind: "tool",
        op: "$",
        label: `Rodar: ${truncate(cmd)}`,
        detail: cmd.length > 80 ? cmd : undefined,
        at,
      };
    }
    case "Read":
      return { kind: "tool", op: "?", label: `Ler ${shortPath(file, cwd)}`, at };
    case "Grep":
    case "Glob":
      return { kind: "tool", op: "?", label: "Buscar no código", at };
    case "TodoWrite":
      return { kind: "tool", op: "?", label: "Atualizar lista de passos", at };
    case "Task":
      return {
        kind: "tool",
        op: "?",
        label: `Delegar subtarefa: ${truncate(String(input["description"] ?? ""))}`,
        at,
      };
    case "WebFetch":
      return { kind: "tool", op: "?", label: `Acessar a internet: ${truncate(String(input["url"] ?? ""))}`, at };
    case "WebSearch":
      return { kind: "tool", op: "?", label: `Acessar a internet: ${truncate(String(input["query"] ?? ""))}`, at };
    case "ExitPlanMode":
      return { kind: "tool", op: "?", label: "Plano pronto para sua aprovação", at };
    default:
      if (name.startsWith("mcp__")) {
        const parts = name.split("__").filter(Boolean).slice(1);
        return { kind: "tool", op: "?", label: `Usar ferramenta externa: ${parts.join(": ") || name}`, at };
      }
      return { kind: "tool", op: "?", label: `Usar ${name}`, at };
  }
}

/** Roda uma fase (espec/plano/execução/correção) numa sessão do Claude Code. */
export async function runPhase(opts: RunPhaseOpts): Promise<PhaseResult> {
  const exe = claudePath();
  if (!exe) {
    return {
      finalText: "",
      success: false,
      errorMessage: "Claude Code não encontrado — instale e faça login",
    };
  }

  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, PHASE_TIMEOUT_MS);

  // Últimos bytes do stderr do CLI — só para diagnóstico no console do server.
  let stderrTail = "";

  const options: Options = {
    abortController,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    pathToClaudeCodeExecutable: exe,
    env: claudeEnv(),
    settingSources: ["project"],
    includePartialMessages: true,
    model: opts.model,
    maxTurns: opts.maxTurns,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    canUseTool: opts.canUseTool,
    stderr: (data) => {
      stderrTail = (stderrTail + data).slice(-2000);
    },
  };

  let sessionId: string | undefined;
  let planText: string | undefined;
  let finalText = "";
  let lastAssistantText = "";
  let success = false;
  let resultSeen = false;
  let errorMessage: string | undefined;
  /** Último erro de API visto em mensagem assistant (auth, rate limit...). */
  let apiError: SDKAssistantMessage["error"];

  const handleAssistant = (m: SDKAssistantMessage): void => {
    if (m.error) apiError = m.error;
    let text = "";
    for (const block of m.message.content) {
      if (block.type === "text" && m.parent_tool_use_id === null) {
        text += block.text;
      } else if (block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === "ExitPlanMode" && typeof input["plan"] === "string") {
          planText = input["plan"];
        }
        const item = toolItem(block.name, input, opts.cwd);
        transcriptAppend(opts.taskId, item);
        broadcast({ type: "transcript", taskId: opts.taskId, item });
      }
    }
    // Texto consolidado gravado uma vez por mensagem (os deltas foram só streaming).
    if (text.trim().length > 0) {
      lastAssistantText = text;
      const item: TranscriptItem = { kind: "assistant", text, at: new Date().toISOString() };
      transcriptAppend(opts.taskId, item);
      broadcast({ type: "transcript", taskId: opts.taskId, item });
    }
  };

  const handleMessage = (m: SDKMessage): void => {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      return;
    }
    if (m.type === "stream_event") {
      if (
        m.parent_tool_use_id === null &&
        m.event.type === "content_block_delta" &&
        m.event.delta.type === "text_delta"
      ) {
        broadcast({ type: "chat_delta", taskId: opts.taskId, text: m.event.delta.text });
      }
      return;
    }
    if (m.type === "assistant") {
      handleAssistant(m);
      return;
    }
    if (m.type === "result") {
      resultSeen = true;
      if (m.subtype === "success") {
        finalText = m.result;
        success = !m.is_error;
        if (!success) errorMessage = friendlyError(apiError, undefined);
      } else {
        finalText = lastAssistantText;
        success = false;
        errorMessage =
          m.subtype === "error_max_turns"
            ? "O passo atingiu o limite de etapas e parou. Tente de novo ou divida o pedido em partes menores."
            : friendlyError(apiError, m.errors[0]);
      }
    }
  };

  try {
    const q = query({ prompt: opts.prompt, options });
    for await (const m of q) handleMessage(m);
    if (!resultSeen && !errorMessage) {
      success = false;
      finalText = lastAssistantText;
      errorMessage = "O Claude Code encerrou sem terminar o passo. Tente de novo.";
    }
  } catch (err) {
    success = false;
    finalText = lastAssistantText;
    if (timedOut) {
      errorMessage = "Este passo passou de 20 minutos e foi interrompido por segurança. Tente de novo.";
    } else if (err instanceof AbortError) {
      errorMessage = "O passo foi interrompido.";
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[runner] fase falhou (task ${opts.taskId}): ${detail}\nstderr: ${stderrTail}`);
      errorMessage = friendlyError(apiError, detail);
    }
  } finally {
    clearTimeout(timer);
  }

  return { sessionId, finalText, planText, success, errorMessage };
}

/** Traduz erros do SDK/CLI em mensagem amigável para leigos. */
function friendlyError(apiError: SDKAssistantMessage["error"], detail?: string): string {
  if (apiError === "authentication_failed" || apiError === "oauth_org_not_allowed" || /not logged in|login|authentication/i.test(detail ?? "")) {
    return "O Claude Code não está logado. Abra o terminal, rode `claude` e faça login, depois tente de novo.";
  }
  if (apiError === "rate_limit" || apiError === "overloaded") {
    return "O Claude está sobrecarregado ou atingiu o limite de uso agora. Espere alguns minutos e tente de novo.";
  }
  if (apiError === "billing_error") {
    return "Há um problema com a assinatura do Claude nesta máquina. Verifique sua conta e tente de novo.";
  }
  const suffix = detail ? ` (detalhe técnico: ${truncate(detail, 120)})` : "";
  return `O Claude encontrou um erro neste passo. Tente de novo.${suffix}`;
}

/** Verifica se o Claude Code da máquina responde (usado pela UI no aviso de status). */
export async function claudeStatus(): Promise<{ ok: boolean; version?: string; detail?: string }> {
  const exe = claudePath();
  if (!exe) {
    return { ok: false, detail: "Claude Code não encontrado — instale e faça login" };
  }
  return await new Promise((resolve) => {
    execFile(exe, ["--version"], { timeout: 5000, env: claudeEnv() }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, detail: "O Claude Code não respondeu. Verifique a instalação." });
      } else {
        resolve({ ok: true, version: stdout.trim() });
      }
    });
  });
}
