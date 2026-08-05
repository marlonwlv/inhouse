/**
 * Contratos compartilhados do Inhouse Builder.
 * Este arquivo é a fonte de verdade entre server, workflow, e frontend.
 * O frontend (public/app.js) consome as mesmas formas via JSON.
 */

// ---------- Domínio ----------

export type ProjectKind = "repo" | "app"; // repo clonado do GitHub | app criado de template

export interface Project {
  id: string;
  name: string;
  kind: ProjectKind;
  /** Checkout principal (main). Worktrees ficam fora dele. */
  path: string;
  /** URL do GitHub quando kind=repo (ou quando o app foi publicado lá). */
  originUrl?: string;
  defaultBranch: string;
  createdAt: string; // ISO
}

/** Passos da esteira, na ordem. "concluida" é terminal. */
export const STEPS = [
  "espec",
  "plano",
  "aprovacao",
  "execucao",
  "verificacoes",
  "teste",
  "publicar",
  "concluida",
] as const;
export type Step = (typeof STEPS)[number];

/** Passos que são porteira humana (losango no mockup). */
export const HUMAN_STEPS: readonly Step[] = ["aprovacao", "teste", "publicar"];

export type TaskStatus =
  | "rodando" // um passo automático está em execução
  | "aguardando" // parado numa porteira humana (ou aguardando permissão)
  | "falhou" // passo automático falhou após retries; precisa de ação
  | "concluida"
  | "cancelada";

export interface GateResult {
  name: string; // "TypeScript" | "Lint" | "Testes" | ...
  command: string;
  ok: boolean;
  /** Últimas linhas do output quando falhou (truncado). */
  output?: string;
  durationMs: number;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  /** Pedido original do usuário, em português. */
  description: string;
  step: Step;
  status: TaskStatus;
  /** Número do espaço isolado (worktree), 1-based, por projeto. */
  espaco: number;
  branch: string;
  worktreePath: string;
  /** Espec estruturada gerada no passo espec (markdown). */
  spec?: string;
  /** Plano gerado no passo plano (markdown), aguardando/já aprovado. */
  plan?: string;
  gates: GateResult[];
  /** Quantas rodadas de auto-correção de gates já rodaram. */
  gateFixRounds: number;
  /** Sessão do Claude Code para resume entre fases/steering. */
  claudeSessionId?: string;
  previewUrl?: string;
  prUrl?: string;
  /** Mensagem de erro amigável quando status=falhou. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionRequest {
  id: string;
  taskId: string;
  toolName: string;
  /** Descrição em português para leigos (gerada pelo server a partir do tool input). */
  friendly: string;
  /** Input bruto da tool (para o "ver detalhes"). */
  input: unknown;
  createdAt: string;
}

// ---------- Transcript (chat por tarefa) ----------

export type TranscriptItem =
  | { kind: "user"; text: string; at: string }
  | { kind: "assistant"; text: string; at: string }
  | { kind: "tool"; op: "+" | "✎" | "$" | "?"; label: string; detail?: string; at: string }
  | { kind: "system"; text: string; at: string }; // mudanças de passo, gates, etc.

// ---------- Eventos SSE (GET /api/events) ----------

export type ServerEvent =
  | { type: "state"; projects: Project[]; tasks: Task[]; permissions: PermissionRequest[] }
  | { type: "task_updated"; task: Task }
  | { type: "project_updated"; project: Project }
  | { type: "project_progress"; projectId?: string; name: string; message: string; pct?: number }
  | { type: "chat_delta"; taskId: string; text: string } // streaming do texto do assistente
  | { type: "transcript"; taskId: string; item: TranscriptItem }
  | { type: "gate_result"; taskId: string; gate: GateResult }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string; allowed: boolean }
  | { type: "preview_ready"; taskId: string; url: string }
  | { type: "claude_status"; ok: boolean; version?: string; detail?: string };

// ---------- API REST ----------
// GET  /api/state                       -> { projects, tasks, permissions, claude: {ok, version} }
// GET  /api/events                      -> SSE de ServerEvent
// POST /api/projects/clone              { url } -> Project (progresso via project_progress)
// POST /api/projects/from-template     { name, template: "app-starter" } -> Project
// POST /api/projects/open               { path } -> Project (registra pasta existente)
// GET  /api/tasks/:id/transcript        -> TranscriptItem[]
// POST /api/tasks                       { projectId, title?, description } -> Task
// POST /api/tasks/:id/action            TaskAction -> Task
// POST /api/tasks/:id/message           { text } -> 202 (steering durante execução)
// POST /api/permissions/:id/decision    { allow, remember? } -> 200
// POST /api/tasks/:id/preview/start     -> { url }
// POST /api/tasks/:id/preview/stop      -> 200

export type TaskAction =
  | { action: "approve_plan" }
  | { action: "request_changes"; message: string } // volta pra execucao (ou plano se veio da aprovacao)
  | { action: "approve_test" } // teste -> publicar (fica aguardando o clique de publicar)
  | { action: "publish"; createPr?: boolean } // merge no main (+ PR opcional)
  | { action: "retry" } // re-roda o passo que falhou
  | { action: "cancel" };

// ---------- Utilidades ----------

export const STEP_LABELS: Record<Step, string> = {
  espec: "Espec",
  plano: "Plano",
  aprovacao: "Sua aprovação",
  execucao: "Execução",
  verificacoes: "Verificações",
  teste: "Seu teste",
  publicar: "Publicar",
  concluida: "Concluída",
};

export function isHumanStep(s: Step): boolean {
  return (HUMAN_STEPS as readonly string[]).includes(s);
}
