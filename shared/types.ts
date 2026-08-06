/**
 * Contratos compartilhados do Inhouse.
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

/** Medições de uma fase do Claude (extraídas do result do SDK). */
export interface UsoFase {
  chamadas: number;
  custoUsd: number;
  turnos: number;
  msTotal: number;
  msApi: number;
  tokensIn: number;
  tokensOut: number;
  negacoesAuto: number;
}
/** Acumulado da tarefa para o eval de experiência. */
export interface TaskUso {
  porEtapa: Partial<Record<Step, UsoFase>>;
  falhas: number;
  ultimosErros: string[];
  triagemCurta?: boolean;
}

export interface GateResult {
  name: string; // "TypeScript" | "Lint" | "Testes" | ...
  command: string;
  ok: boolean;
  /** Últimas linhas do output quando falhou (truncado). */
  output?: string;
  durationMs: number;
}

/** Porte da tarefa, julgado na espec (triagem): decide quais skills de plano rodam. */
export type Porte = "simples" | "media" | "grande";

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
  /** O passo foi pausado pelo teto de 1h (não é erro): UI oferece "Continuar assim mesmo". */
  pausadaPorTempo?: boolean;
  /** Porte julgado na espec — controla a cadeia de skills do plano. */
  porte?: Porte;
  /** A TAREFA mexe em interface/jornada de usuário? (julgado na espec e re-julgado pós-plano) */
  temUi?: boolean;
  /** Skills de plano já rodadas nesta tarefa (evita repetir no re-julgamento/feedback). */
  skillsRodadas?: string[];
  /** Modo auto: permissões desta tarefa são concedidas sem perguntar (com registro no chat). */
  autoAprovar?: boolean;
  /** Histórico de passos com início/fim — mostra quanto tempo cada etapa levou. */
  historico?: { step: Step; inicio: string; fim?: string }[];
  /** Medições acumuladas para o eval de experiência (custo/turnos por etapa). */
  uso?: TaskUso;
  /** Arquivada (ISO): some do quadro e o worktree é liberado. Ausente = ativa. */
  arquivadaEm?: string;
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

/** Estado do aviso de versão nova do próprio Inhouse (via git). */
export interface UpdateInfo {
  /** É um clone git com origin? (senão, não dá para checar/atualizar) */
  suportado: boolean;
  /** Há commits novos em origin? */
  disponivel: boolean;
  /** Quantos commits atrás do origin. */
  atras: number;
  checadoEm?: string;
}

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
  | { type: "claude_status"; ok: boolean; version?: string; detail?: string }
  | { type: "update_status"; update: UpdateInfo }
  | { type: "eval_relatorio"; status: "gerando" | "pronto" | "erro"; arquivo?: string; detalhe?: string };

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
// POST /api/tasks/:id/feedback          { nota, texto? } -> { ok: true }
// GET  /api/eval/resumo?fonte=          -> EvalResumo (fonte: "todos" | "meus" | <rótulo>)
// GET  /api/eval/relatorios             -> { relatorios: {ts, arquivo, tarefasAnalisadas, custoUsd?}[] }
// GET  /api/eval/relatorios/:arquivo    -> { conteudo }
// POST /api/eval/relatorios             -> 202 (gera análise; 409 se já gerando)
// GET  /api/eval/fontes                 -> { fontes: string[] } (origens importadas)
// GET  /api/eval/export?transcripts=1   -> bundle JSON (dados locais, download)
// POST /api/eval/import                 { bundle, fonte } -> { importados, pulados }

/** Fonte única dos nomes de ação — rotas validam por aqui; a trava de tipo abaixo
 *  quebra a compilação se este array e o union TaskAction saírem de sincronia. */
export const TASK_ACTIONS = [
  "approve_plan",
  "request_changes",
  "approve_test",
  "publish",
  "retry",
  "auto_mode",
  "plano_rapido",
  "arquivar",
  "desarquivar",
  "cancel",
] as const;

export type TaskAction =
  | { action: "approve_plan" }
  | { action: "request_changes"; message: string } // volta pra execucao (ou plano se veio da aprovacao)
  | { action: "approve_test" } // teste -> publicar (fica aguardando o clique de publicar)
  | { action: "publish"; createPr?: boolean } // merge no main (+ PR opcional)
  | { action: "retry" } // re-roda o passo que falhou
  | { action: "auto_mode"; on: boolean } // permissões automáticas para esta tarefa
  | { action: "plano_rapido" } // pular a cadeia de reviews e ir direto ao plano
  | { action: "arquivar" } // some do quadro + libera o worktree (mantém a branch)
  | { action: "desarquivar" } // reexibe no quadro
  | { action: "cancel"; motivo?: string };

// Travas de sincronia (compile-time; sem custo em runtime):
type _TodasAsAcoesNaLista = TaskAction["action"] extends (typeof TASK_ACTIONS)[number] ? true : never;
type _NadaSobrandoNaLista = (typeof TASK_ACTIONS)[number] extends TaskAction["action"] ? true : never;
export const _travaAcoes: [_TodasAsAcoesNaLista, _NadaSobrandoNaLista] = [true, true];

// ---------- Eval de experiência ----------

export const FEEDBACK_NOTAS = ["otimo", "ok", "ruim"] as const;
export type FeedbackNota = (typeof FEEDBACK_NOTAS)[number];

/** Resumo numérico exibido na tela Experiência (calculado dos jsonl do eval). */
export interface EvalResumo {
  /** Métrica norte: publicadas sem resgate / total finalizadas. */
  taxaSemResgate: { publicadasSemResgate: number; finalizadas: number };
  /** Métrica secundária: mediana de tempo humano por tarefa publicada (ms). */
  tempoHumanoMedianoMs: number | null;
  tempoMaquinaMedianoMs: number | null;
  concluidas: number;
  canceladas: number;
  paradasEmFalhou: number;
  permissoes: { total: number; esperaMedianaMs: number | null; timeouts: number; autoPct: number };
  gateMaisReprova: string | null;
  custoTotalUsd: number;
  feedback: { otimo: number; ok: number; ruim: number };
  semDadosDeTempo: number;
  aprendizados: { chave: string; insight: string; severidade: number; ocorrencias: number }[];
  relatorios: number;
  /** Uma análise está sendo gerada agora (fonte da verdade p/ o botão). */
  gerando?: boolean;
}

// ---------- Config por projeto (inhouse.config.json na raiz) ----------
// Mapeia etapas da esteira para skills do Claude Code da máquina (ex.: gstack).
// Sem o arquivo, a esteira roda com os prompts genéricos embutidos.

export interface SkillStepConfig {
  /** Nome da skill/comando (sem a barra). Ex.: "office-hours", "review", "qa". */
  skill: string;
  /** Argumentos; placeholders: {descricao} {spec} {plano} {previewUrl}. */
  args?: string;
  /** "ui": só roda se o projeto tiver dependências de frontend. */
  quando?: "ui";
  /** Nome do gate exibido (etapa verificacoes). Default: nome da skill. */
  gate?: string;
}

/**
 * Como subir o preview (dev server) de um projeto — bloco "preview" do
 * inhouse.config.json OU receita aprendida pelo agente (camada 2.5). Tudo
 * opcional: sem nada, o Inhouse auto-detecta (gerenciador + script dev/start)
 * e, se não der, cai para a degradação graciosa (sem preview de tela).
 */
export interface PreviewConfig {
  /** Comando completo do dev server (ex.: "pnpm --filter web dev"). Roda via shell. */
  cmd?: string;
  /** Subpasta (relativa à raiz do projeto) onde rodar — cobre monorepos. */
  cwd?: string;
  /** Porta desejada; o Inhouse procura a primeira livre a partir dela. */
  port?: number;
  /** Arquivos de ambiente (ex.: [".env.local"]) copiados da pasta principal para o espaço. */
  envFiles?: string[];
  /** Regex custom p/ detectar que subiu (default: procura uma URL http://localhost:porta). */
  readyRegex?: string;
  /** Timeout de subida em ms (default: 120000). */
  timeoutMs?: number;
}

export interface InhouseConfig {
  skills?: {
    /**
     * Cadeia da fase de plano. Duas formas:
     * - lista: vale para portes "media" e "grande" ("simples" pula skills);
     * - objeto por porte: { simples: [...], media: [...], grande: [...] }.
     */
    plano?: SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>>;
    /** Gates extras após as verificações do projeto (veredito APROVADO/REPROVADO). */
    verificacoes?: SkillStepConfig[];
  };
  /** Como subir o preview deste projeto (opcional; auto-detecção cobre o resto). */
  preview?: PreviewConfig;
}

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
