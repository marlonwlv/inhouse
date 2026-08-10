/**
 * Biblioteca de workflows: vários workflows nomeados (config de skills da esteira),
 * com um padrão global e override por projeto. Persistida em DATA_DIR/workflows.json.
 * Os 3 presets embutidos (Padrão/Rápido/Completo) são read-only e sempre existem.
 * O `preview` NÃO faz parte do workflow — continua vindo do inhouse.config.json do repo.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GateConfig, InhouseConfig, SkillCatalogItem, WorkflowDef, WorkflowsState } from "../../shared/types.js";
import { DATA_DIR, ensureDirs } from "../config.js";
import { sanitizeSkillsBlock } from "./config.js";

const FILE = join(DATA_DIR, "workflows.json");

/** Skills do preset Padrão — espelha templates/app-starter/inhouse.config.json. */
const PADRAO_SKILLS: NonNullable<InhouseConfig["skills"]> = {
  plano_produto: { simples: [], media: [], grande: [{ skill: "office-hours", args: "{spec}" }] },
  detalhamento: {
    simples: [],
    media: [{ skill: "plan-eng-review" }],
    grande: [{ skill: "plan-eng-review" }, { skill: "plan-design-review", quando: "ui" }],
  },
  verificacoes: [
    { skill: "review", gate: "Review" },
    { skill: "qa", gate: "QA", args: "{previewUrl}", quando: "ui" },
  ],
};

function presets(): WorkflowDef[] {
  return [
    {
      id: "padrao",
      name: "Padrão",
      descricao: "A esteira completa, adaptativa por tamanho da tarefa.",
      origem: "padrao",
      builtin: true,
      skills: PADRAO_SKILLS,
    },
    {
      id: "rapido",
      name: "Rápido",
      descricao: "Sem reviews — vai direto ao ponto, para ajustes pequenos.",
      origem: "padrao",
      builtin: true,
      skills: {},
    },
    {
      id: "completo",
      name: "Completo",
      descricao: "Todos os reviews, incluindo segurança e design.",
      origem: "padrao",
      builtin: true,
      skills: {
        ...PADRAO_SKILLS,
        verificacoes: [
          { skill: "review", gate: "Review" },
          { skill: "security-review", gate: "Segurança" },
          { skill: "qa", gate: "QA", args: "{previewUrl}", quando: "ui" },
        ],
      },
    },
  ];
}

let cache: WorkflowsState | null = null;

/** Só registra as porteiras DESLIGADAS (false); o padrão é ligada. */
function sanitizeGates(raw: unknown): GateConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: GateConfig = {};
  for (const k of ["aprovacao", "aprovacao_prototipo", "teste"] as const) {
    if (r[k] === false) out[k] = false;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Junta os presets (sempre atualizados) com os workflows customizados salvos. */
function normalize(raw: unknown): WorkflowsState {
  const base = presets();
  const r = (raw ?? {}) as Record<string, unknown>;
  const custom: WorkflowDef[] = Array.isArray(r.workflows)
    ? (r.workflows as Record<string, unknown>[])
        .filter((w) => w && !w.builtin && typeof w.id === "string" && typeof w.name === "string")
        .filter((w) => !base.some((b) => b.id === w.id)) // um custom não pode ocupar id de preset
        .map((w) => {
          const gates = sanitizeGates(w.gates);
          return {
            id: String(w.id),
            name: String(w.name).slice(0, 60),
            ...(typeof w.descricao === "string" ? { descricao: w.descricao.slice(0, 200) } : {}),
            origem: w.origem === "ia" ? "ia" : ("manual" as const),
            skills: sanitizeSkillsBlock(w.skills),
            ...(gates ? { gates } : {}),
          };
        })
    : [];
  const workflows = [...base, ...custom];
  const globalAtivo = workflows.some((w) => w.id === r.globalAtivo) ? (r.globalAtivo as string) : "padrao";
  const porProjeto: Record<string, string> = {};
  if (r.porProjeto && typeof r.porProjeto === "object") {
    for (const [k, v] of Object.entries(r.porProjeto as Record<string, unknown>)) {
      if (typeof v === "string" && workflows.some((w) => w.id === v)) porProjeto[k] = v;
    }
  }
  return { workflows, globalAtivo, porProjeto };
}

function load(): WorkflowsState {
  if (cache) return cache;
  ensureDirs();
  if (existsSync(FILE)) {
    try {
      cache = normalize(JSON.parse(readFileSync(FILE, "utf8")));
      return cache;
    } catch {
      // corrompido → recomeça dos presets (não apaga o arquivo antigo)
    }
  }
  cache = normalize({});
  persist();
  return cache;
}

function persist(): void {
  if (!cache) return;
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, FILE);
}

/** Só para testes: força reler o arquivo. */
export function _reset(): void {
  cache = null;
}

export function getState(): WorkflowsState {
  return load();
}

/** Id do workflow ativo para um projeto (override do projeto → padrão global). */
export function activeWorkflowId(projectId?: string): string {
  const s = load();
  return (projectId && s.porProjeto[projectId]) || s.globalAtivo;
}

/** Config de skills do workflow ativo — o que a máquina de estados consome. */
export function activeConfig(projectId?: string): InhouseConfig {
  const s = load();
  const id = activeWorkflowId(projectId);
  const w = s.workflows.find((x) => x.id === id) ?? s.workflows.find((x) => x.id === "padrao");
  return { skills: w?.skills ?? {} };
}

/** Cria (sem id) ou atualiza (id de custom) um workflow. Presets são read-only. */
export function upsertWorkflow(input: {
  id?: string;
  name: string;
  descricao?: string;
  origem?: "manual" | "ia";
  skills: unknown;
  gates?: unknown;
}): WorkflowDef {
  const s = load();
  const nome = String(input.name ?? "").trim().slice(0, 60);
  if (!nome) throw new Error("Dê um nome ao workflow.");
  const skills = sanitizeSkillsBlock(input.skills);
  const gates = sanitizeGates(input.gates);
  if (input.id) {
    const alvo = s.workflows.find((w) => w.id === input.id);
    if (!alvo) throw new Error("Workflow não encontrado.");
    if (alvo.builtin) throw new Error("Este é um preset e não pode ser editado — duplique para personalizar.");
    alvo.name = nome;
    alvo.descricao = input.descricao?.slice(0, 200);
    alvo.skills = skills;
    if (gates) alvo.gates = gates;
    else delete alvo.gates;
    persist();
    return alvo;
  }
  const novo: WorkflowDef = {
    id: randomUUID(),
    name: nome,
    ...(input.descricao ? { descricao: input.descricao.slice(0, 200) } : {}),
    origem: input.origem === "ia" ? "ia" : "manual",
    skills,
    ...(gates ? { gates } : {}),
  };
  s.workflows.push(novo);
  persist();
  return novo;
}

/** Porteiras exigidas pelo workflow ativo (true = pede a pessoa). "publicar" é sempre humana. */
export function activeGates(projectId?: string): { aprovacao: boolean; aprovacao_prototipo: boolean; teste: boolean } {
  const s = load();
  const g = s.workflows.find((x) => x.id === activeWorkflowId(projectId))?.gates ?? {};
  return {
    aprovacao: g.aprovacao !== false,
    aprovacao_prototipo: g.aprovacao_prototipo !== false,
    teste: g.teste !== false,
  };
}

/** Esquece o override de workflow de um projeto (ao excluí-lo). Idempotente. */
export function forgetProject(projectId: string): void {
  const s = load();
  if (s.porProjeto[projectId] !== undefined) {
    delete s.porProjeto[projectId];
    persist();
  }
}

export function deleteWorkflow(id: string): void {
  const s = load();
  const w = s.workflows.find((x) => x.id === id);
  if (!w) throw new Error("Workflow não encontrado.");
  if (w.builtin) throw new Error("Um preset não pode ser removido.");
  s.workflows = s.workflows.filter((x) => x.id !== id);
  // Quem apontava para ele volta pro padrão.
  if (s.globalAtivo === id) s.globalAtivo = "padrao";
  for (const k of Object.keys(s.porProjeto)) if (s.porProjeto[k] === id) delete s.porProjeto[k];
  persist();
}

/** Define o workflow ativo: global (projectId ausente) ou de um projeto. */
export function setActive(id: string, projectId?: string): WorkflowsState {
  const s = load();
  if (!s.workflows.some((w) => w.id === id)) throw new Error("Workflow não encontrado.");
  if (projectId) s.porProjeto[projectId] = id;
  else s.globalAtivo = id;
  persist();
  return s;
}

// ---------- Catálogo de skills instaladas ----------

const GSTACK_DIR = join(homedir(), ".claude", "skills", "gstack");
/** Skills embutidas do Claude Code (não vêm do gstack). */
const BUILTIN_SKILLS = new Set(["security-review"]);

/** Skills que fazem sentido numa fase de workflow (rótulos amigáveis). */
const CATALOGO: Omit<SkillCatalogItem, "instalada">[] = [
  { skill: "office-hours", rotulo: "Office Hours (plano de produto)", fase: "plano_produto" },
  { skill: "plan-ceo-review", rotulo: "Review de estratégia e escopo", fase: "plano_produto" },
  { skill: "plan-eng-review", rotulo: "Review de engenharia", fase: "detalhamento" },
  { skill: "plan-design-review", rotulo: "Review de design", fase: "detalhamento" },
  { skill: "plan-devex-review", rotulo: "Review de experiência de dev", fase: "detalhamento" },
  { skill: "review", rotulo: "Review de código", fase: "verificacoes" },
  { skill: "qa", rotulo: "QA — testa a tela no navegador", fase: "verificacoes" },
  { skill: "security-review", rotulo: "Review de segurança", fase: "verificacoes" },
  { skill: "design-review", rotulo: "Review visual", fase: "verificacoes" },
];

function skillInstalada(skill: string): boolean {
  if (BUILTIN_SKILLS.has(skill)) return true;
  return existsSync(join(GSTACK_DIR, skill));
}

/** Lista fixa das skills disponíveis para montar workflows (com flag de instalada). */
export function skillCatalog(): SkillCatalogItem[] {
  return CATALOGO.map((c) => ({ ...c, instalada: skillInstalada(c.skill) }));
}
