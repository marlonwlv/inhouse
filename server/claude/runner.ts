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
import { acumularFase } from "../eval/coleta.js";
import type { FaseMetricas } from "../eval/coleta.js";
import { claudeEnv, claudePath } from "../config.js";
import { fakeRunPhase } from "../debug/fakeModel.js";
import { isFakeModelActive } from "../debug/flag.js";
import { broadcast } from "../events.js";
import { transcriptAppend } from "../store.js";

/** Timeout de segurança global de uma fase. */
const PHASE_TIMEOUT_MS = 60 * 60 * 1000;

/** AbortControllers das fases em andamento, por tarefa (o cancel aborta por aqui). */
const phaseAborts = new Map<string, AbortController>();

/**
 * Aborta a fase em andamento de uma tarefa (usado pelo cancel da esteira).
 * Retorna false se não havia fase rodando.
 */
export function abortPhase(taskId: string): boolean {
  const ac = phaseAborts.get(taskId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export interface PhaseResult {
  sessionId?: string;
  finalText: string;
  planText?: string;
  success: boolean;
  errorMessage?: string;
  /** A fase foi interrompida pelo teto de tempo (não é erro — oferecer "Continuar assim mesmo"). */
  timedOut?: boolean;
  /** Medições do SDK (custo/turnos/tokens) — ausente quando a fase morreu sem result. */
  metricas?: FaseMetricas;
  /** A fase editou algum arquivo (Write/Edit/…)? Usado para não re-verificar sem mudança. */
  filesTouched?: boolean;
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
  /**
   * Fontes de settings da sessão. Default: só "project" (isolamento).
   * Fases que rodam skills do usuário (ex.: gstack) incluem "user".
   */
  settingSources?: Options["settingSources"];
  /** Variáveis extras de ambiente (ex.: marcador de sessão spawned p/ gstack). */
  extraEnv?: Record<string, string>;
  /**
   * Não gravar/transmitir transcript (para fases SEM tarefa real, ex.: o juiz do
   * eval). Sem isto, o taskId sintético do juiz (com ":" e ".") faz o sink de
   * transcript recusar o id e derruba a fase inteira.
   */
  semTranscript?: boolean;
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
  // Modo debug: responde instantâneo com as linhas-marcador (ver server/debug).
  if (isFakeModelActive()) return fakeRunPhase(opts);

  const exe = claudePath();
  if (!exe) {
    return {
      finalText: "",
      success: false,
      errorMessage: "Claude Code não encontrado — instale e faça login",
    };
  }

  const abortController = new AbortController();
  phaseAborts.set(opts.taskId, abortController);
  let timedOut = false;
  let phaseDone = false;
  let timer: NodeJS.Timeout | undefined;
  const armTimer = (): void => {
    if (phaseDone || abortController.signal.aborted) return;
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, PHASE_TIMEOUT_MS);
  };
  armTimer();

  // O relógio de segurança da fase não corre enquanto uma permissão espera a
  // decisão humana — quem manda nessa espera é o PERMISSION_TIMEOUT_MS (30min).
  let permissoesPendentes = 0;
  const baseCanUseTool = opts.canUseTool;
  const canUseTool: CanUseTool | undefined = baseCanUseTool
    ? async (toolName, input, options) => {
        permissoesPendentes++;
        if (permissoesPendentes === 1) clearTimeout(timer);
        try {
          return await baseCanUseTool(toolName, input, options);
        } finally {
          permissoesPendentes--;
          if (permissoesPendentes === 0) armTimer();
        }
      }
    : undefined;

  // Últimos bytes do stderr do CLI — só para diagnóstico no console do server.
  let stderrTail = "";

  const options: Options = {
    abortController,
    cwd: opts.cwd,
    permissionMode: opts.permissionMode,
    resume: opts.resume,
    pathToClaudeCodeExecutable: exe,
    env: { ...claudeEnv(), ...opts.extraEnv },
    settingSources: opts.settingSources ?? ["project"],
    includePartialMessages: true,
    model: opts.model,
    maxTurns: opts.maxTurns,
    allowedTools: opts.allowedTools,
    disallowedTools: opts.disallowedTools,
    canUseTool,
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
  let metricas: FaseMetricas | undefined;
  let filesTouched = false;
  /** Último erro de API visto em mensagem assistant (auth, rate limit...). */
  let apiError: SDKAssistantMessage["error"];

  // Fases sem tarefa real (ex.: juiz do eval) não gravam transcript — o taskId
  // sintético nem passaria pela validação do sink.
  const emitir = (item: TranscriptItem): void => {
    if (opts.semTranscript) return;
    transcriptAppend(opts.taskId, item);
    broadcast({ type: "transcript", taskId: opts.taskId, item });
  };

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
        if (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit" || block.name === "NotebookEdit") {
          filesTouched = true;
        }
        emitir(toolItem(block.name, input, opts.cwd));
      }
    }
    // Texto consolidado gravado uma vez por mensagem (os deltas foram só streaming).
    if (text.trim().length > 0) {
      lastAssistantText = text;
      emitir({ kind: "assistant", text, at: new Date().toISOString() });
    }
  };

  const handleMessage = (m: SDKMessage): void => {
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      return;
    }
    if (m.type === "stream_event") {
      if (
        !opts.semTranscript &&
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
      if (typeof m.total_cost_usd === "number" && m.usage) {
        const u = m.usage;
        metricas = {
          custoUsd: m.total_cost_usd,
          turnos: m.num_turns ?? 0,
          msTotal: m.duration_ms ?? 0,
          msApi: m.duration_api_ms ?? 0,
          tokensIn:
            (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          tokensOut: u.output_tokens ?? 0,
          negacoesAuto: m.permission_denials?.length ?? 0,
        };
      }
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
      errorMessage = "Este passo está trabalhando há mais de 1 hora.";
    } else if (err instanceof AbortError) {
      errorMessage = "O passo foi interrompido.";
    } else {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[runner] fase falhou (task ${opts.taskId}): ${detail}\nstderr: ${stderrTail}`);
      errorMessage = friendlyError(apiError, detail);
    }
  } finally {
    phaseDone = true;
    clearTimeout(timer);
    phaseAborts.delete(opts.taskId);
  }

  if (metricas) acumularFase(opts.taskId, metricas);
  return { sessionId, finalText, planText, success, errorMessage, timedOut, metricas, filesTouched };
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
