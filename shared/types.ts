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
  /** Quando o projeto foi preparado (setup guiado). Ausente = ainda não preparado. */
  preparado?: string;
  createdAt: string; // ISO
}

/** Passos da esteira, na ordem. "concluida" é terminal. */
export const STEPS = [
  "espec",
  "plano", // plano de produto (office-hours): o QUÊ
  "aprovacao", // porteira: aprova o produto
  "detalhamento", // plano técnico (+ design quando faz sentido): o COMO
  "prototipo", // opcional (só com design): mockups HTML/CSS
  "aprovacao_prototipo", // porteira: aprova o visual
  "execucao",
  "verificacoes",
  "teste",
  "publicar",
  "concluida",
] as const;
export type Step = (typeof STEPS)[number];

/** Passos que são porteira humana (losango no mockup). */
export const HUMAN_STEPS: readonly Step[] = ["aprovacao", "aprovacao_prototipo", "teste", "publicar"];

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

/** Arquivo anexado pelo usuário a uma tarefa/mensagem (fica em ANEXOS_DIR, fora do worktree). */
export interface TaskAnexo {
  /** Nome original do arquivo (exibição). */
  nome: string;
  /** MIME informado pelo browser (ex.: "image/png", "application/pdf"). */
  tipo: string;
  /** Caminho absoluto no disco, SEMPRE dentro de ANEXOS_DIR (guarda no server). */
  path: string;
}

export interface Task {
  id: string;
  projectId: string;
  /** "preparacao" = fluxo de setup do repositório (roda no checkout principal, sem esteira/PR). Ausente = tarefa normal. */
  kind?: "preparacao";
  /**
   * "esteira" (padrão) = passa pela esteira completa (espec→plano→…→publicar).
   * "livre" = sem esteira: o usuário conduz o Claude direto e escolhe as skills no prompt.
   * Ausente = "esteira".
   */
  modo?: "esteira" | "livre";
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
  /** O usuário pausou o passo manualmente (não é erro): UI oferece "Retomar" e permite ajustar antes. */
  pausadaManual?: boolean;
  /** A tarefa gerou um protótipo (mockup em docs/plans/mockups/<slug>/) — fica acessível mesmo depois. */
  temPrototipo?: boolean;
  /** Arquivos anexados pelo usuário (contexto para o Claude ler via Read). */
  anexos?: TaskAnexo[];
  /** Porte julgado na espec — controla a cadeia de skills do plano. */
  porte?: Porte;
  /** A TAREFA mexe em interface/jornada de usuário? (julgado na espec e re-julgado pós-plano) */
  temUi?: boolean;
  /** Julgado na espec: é feature de UI com JORNADA NOVA que pede protótipo/design? */
  precisaDesign?: boolean;
  /** Override do usuário para design+protótipo. "auto" = segue precisaDesign. */
  design?: "auto" | "sim" | "nao";
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
// POST /api/anexos                      { files: [{nome,tipo,dataBase64}] } -> { anexos: TaskAnexo[] }
// POST /api/tasks                       { projectId, title?, description, anexos?, modo? } -> Task
// POST /api/tasks/:id/action            TaskAction -> Task
// POST /api/tasks/:id/message           { text, anexos? } -> 202 (steering durante execução)
// GET  /api/tasks/:id/artefatos         -> { temPrototipo, docs: {nome,rel}[] }
// GET  /api/tasks/:id/artefatos/doc?rel= -> { conteudo } (markdown de docs/plans)
// GET  /api/workflows                   -> { workflows, globalAtivo, porProjeto, catalogo }
// POST /api/workflows                   WorkflowDef (id ausente = criar) -> WorkflowDef
// DELETE /api/workflows/:id             -> 200
// POST /api/workflows/:id/ativar        { projectId? } -> WorkflowsState (por projeto ou global)
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
  "approve_prototype",
  "set_design",
  "request_changes",
  "approve_test",
  "publish",
  "retry",
  "auto_mode",
  "plano_rapido",
  "pause",
  "arquivar",
  "desarquivar",
  "cancel",
] as const;

export type TaskAction =
  | { action: "approve_plan"; direto?: boolean } // direto=true pula detalhamento/protótipo, vai pra execução
  | { action: "approve_prototype" } // aprova o protótipo -> execução
  | { action: "set_design"; valor: "auto" | "sim" | "nao" } // liga/desliga design+protótipo desta task
  | { action: "request_changes"; message: string } // volta pra fase de plano/detalhe/protótipo conforme a porteira
  | { action: "approve_test" } // teste -> publicar (fica aguardando o clique de publicar)
  | { action: "publish"; createPr?: boolean } // merge no main (+ PR opcional)
  | { action: "retry" } // re-roda o passo que falhou
  | { action: "auto_mode"; on: boolean } // permissões automáticas para esta tarefa
  | { action: "plano_rapido" } // pular a cadeia de reviews e ir direto ao plano
  | { action: "pause" } // interrompe o passo automático em andamento; retomável via retry
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
  /**
   * Comandos CURTOS e idempotentes (que TERMINAM) rodados pelo Inhouse ANTES do
   * `cmd` a cada start — ex.: ["docker compose up -d"]. Mesmo nível de confiança do
   * `cmd` (ambos via /bin/sh). NÃO coloque o servidor de dev aqui (esse é o `cmd`).
   */
  setup?: string[];
  /**
   * Rotas conferidas no health-check antes de marcar o preview pronto (default: ["/"]).
   * Ex.: ["/", "/backoffice"] — >=500 ou conexão recusada em qualquer uma = quebrado.
   */
  healthPaths?: string[];
  /** Regex custom p/ detectar que subiu (default: procura uma URL http://localhost:porta). */
  readyRegex?: string;
  /** Timeout de subida em ms (default: 120000). */
  timeoutMs?: number;
}

export interface InhouseConfig {
  skills?: {
    /**
     * LEGADO (compat): cadeia única do plano. Prefira plano_produto + detalhamento.
     * Se só isto existir, office-hours vira o plano de produto e o resto o detalhamento.
     */
    plano?: SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>>;
    /** Fase "Plano" (produto, o QUÊ): tipicamente office-hours. Vazio em "simples". */
    plano_produto?: SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>>;
    /** Fase "Detalhamento" (o COMO): plan-eng-review (+ plan-design-review quando design). */
    detalhamento?: SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>>;
    /** Gates extras após as verificações do projeto (veredito APROVADO/REPROVADO). */
    verificacoes?: SkillStepConfig[];
  };
  /** Como subir o preview deste projeto (opcional; auto-detecção cobre o resto). */
  preview?: PreviewConfig;
}

// ---------- Workflows (biblioteca configurável) ----------
// Um workflow nomeado é o config de skills da esteira. A biblioteca guarda vários;
// cada projeto escolhe um (com um padrão global). O `preview` continua vindo do
// inhouse.config.json do repo (não faz parte do workflow).

export interface WorkflowDef {
  id: string;
  name: string;
  descricao?: string;
  /** De onde veio (só metadado p/ a UI). */
  origem?: "padrao" | "manual" | "ia";
  /** Config de skills por fase (mesma forma do inhouse.config.json). */
  skills: NonNullable<InhouseConfig["skills"]>;
  /** Não editável/removível (os presets embutidos). */
  builtin?: boolean;
}

/** Estado da biblioteca de workflows (persistido em DATA_DIR/workflows.json). */
export interface WorkflowsState {
  workflows: WorkflowDef[];
  /** Workflow padrão para projetos sem escolha própria. */
  globalAtivo: string;
  /** Override por projeto: projectId -> workflowId. */
  porProjeto: Record<string, string>;
}

/** Uma skill disponível para montar workflows (lista fixa das instaladas). */
export interface SkillCatalogItem {
  /** Nome da skill (sem barra) — vira /skill. */
  skill: string;
  /** Rótulo amigável em português. */
  rotulo: string;
  /** Em que fase da esteira ela faz sentido. */
  fase: "plano_produto" | "detalhamento" | "verificacoes";
  /** Detectada de fato na máquina? (senão, aparece esmaecida). */
  instalada: boolean;
}

// ---------- Utilidades ----------

export const STEP_LABELS: Record<Step, string> = {
  espec: "Espec",
  plano: "Plano",
  aprovacao: "Sua aprovação",
  detalhamento: "Detalhamento",
  prototipo: "Protótipo",
  aprovacao_prototipo: "Aprovação do protótipo",
  execucao: "Execução",
  verificacoes: "Verificações",
  teste: "Seu teste",
  publicar: "Publicar",
  concluida: "Concluída",
};

export function isHumanStep(s: Step): boolean {
  return (HUMAN_STEPS as readonly string[]).includes(s);
}

/** Esta task roda a fase de design + protótipo? (override do usuário vence a heurística) */
export function rodaDesign(t: Pick<Task, "design" | "precisaDesign">): boolean {
  return t.design === "sim" || (t.design !== "nao" && Boolean(t.precisaDesign));
}

/**
 * Steps que ESTA task percorre, pela natureza dela (porte + design). O fluxo é
 * adaptativo: simples pula detalhamento/protótipo; sem design, pula protótipo.
 * A UI e a máquina usam isto em vez do STEPS global.
 */
export function stepsAtivos(t: Pick<Task, "porte" | "design" | "precisaDesign">): Step[] {
  const simples = (t.porte ?? "media") === "simples";
  const out: Step[] = ["espec", "plano", "aprovacao"];
  if (!simples) out.push("detalhamento");
  if (!simples && rodaDesign(t)) out.push("prototipo", "aprovacao_prototipo");
  out.push("execucao", "verificacoes", "teste", "publicar", "concluida");
  return out;
}

/** Próximo step ativo depois de `atual` (para as transições da máquina). */
export function proximoStep(t: Pick<Task, "porte" | "design" | "precisaDesign">, atual: Step): Step {
  const ativos = stepsAtivos(t);
  const i = ativos.indexOf(atual);
  return i >= 0 && i < ativos.length - 1 ? ativos[i + 1]! : "concluida";
}
