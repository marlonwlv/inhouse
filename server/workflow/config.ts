/**
 * Config por projeto (inhouse.config.json): mapeia etapas da esteira para
 * skills do Claude Code instaladas na máquina (ex.: suite gstack).
 * Tolerante a erro: arquivo ausente/ inválido = sem skills (esteira genérica).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InhouseConfig, Porte, PreviewConfig, SkillStepConfig } from "../../shared/types.js";
import { DATA_DIR } from "../config.js";

const CONFIG_FILE = "inhouse.config.json";
/** Config global da máquina: vale para todos os projetos que não têm a própria. */
export const GLOBAL_CONFIG_FILE = join(DATA_DIR, "config.json");

function sanitizeSteps(raw: unknown): SkillStepConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps: SkillStepConfig[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    // Nome de skill restrito: vira comando /<skill> dentro da sessão.
    if (typeof o.skill !== "string" || !/^[a-z0-9][a-z0-9:_-]{0,63}$/i.test(o.skill)) continue;
    steps.push({
      skill: o.skill,
      args: typeof o.args === "string" ? o.args : undefined,
      quando: o.quando === "ui" ? "ui" : undefined,
      gate: typeof o.gate === "string" && o.gate.trim() ? o.gate.trim().slice(0, 40) : undefined,
    });
  }
  return steps.length > 0 ? steps : undefined;
}

/** Um caminho relativo seguro dentro do projeto? (sem escapar com `..` nem ser absoluto) */
function caminhoRelativoSeguro(p: string): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return false; // absoluto
  return !p.split(/[/\\]/).includes("..");
}

/**
 * Sanitiza o bloco `preview` (do config OU da receita do agente). Tudo opcional;
 * campos inválidos são descartados. Exportado para a camada 2.5 reaproveitar.
 */
export function sanitizePreview(raw: unknown): PreviewConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  const out: PreviewConfig = {};
  if (typeof o.cmd === "string" && o.cmd.trim()) out.cmd = o.cmd.trim().slice(0, 400);
  if (typeof o.cwd === "string" && caminhoRelativoSeguro(o.cwd)) out.cwd = o.cwd.trim();
  if (typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port < 65536) {
    out.port = o.port;
  }
  if (Array.isArray(o.envFiles)) {
    const files = o.envFiles.filter(
      (f): f is string => typeof f === "string" && caminhoRelativoSeguro(f),
    );
    if (files.length) out.envFiles = files.slice(0, 20);
  }
  if (Array.isArray(o.setup)) {
    // Comandos de setup: mesma confiança do cmd (rodam via /bin/sh). Só trim + cap.
    const cmds = o.setup
      .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      .map((c) => c.trim().slice(0, 400));
    if (cmds.length) out.setup = cmds.slice(0, 20);
  }
  if (Array.isArray(o.healthPaths)) {
    // Rotas do health-check: têm que ser caminhos absolutos do app (começam com "/").
    const rotas = o.healthPaths
      .filter((p): p is string => typeof p === "string" && p.trim().startsWith("/"))
      .map((p) => p.trim().replace(/\s+/g, "").slice(0, 300));
    if (rotas.length) out.healthPaths = rotas.slice(0, 20);
  }
  if (typeof o.readyRegex === "string" && o.readyRegex.trim()) {
    // Só aceita se compilar — evita quebrar a subida do preview com um regex inválido.
    try {
      new RegExp(o.readyRegex);
      out.readyRegex = o.readyRegex.slice(0, 300);
    } catch {
      // descarta regex inválido
    }
  }
  if (typeof o.timeoutMs === "number" && o.timeoutMs > 0 && o.timeoutMs <= 600_000) {
    out.timeoutMs = Math.round(o.timeoutMs);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Lista OU objeto por porte → sanitizado na mesma forma de entrada. */
function sanitizePlano(
  raw: unknown,
): SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>> | undefined {
  if (Array.isArray(raw)) return sanitizeSteps(raw);
  if (typeof raw === "object" && raw !== null) {
    const o = raw as Record<string, unknown>;
    const out: Partial<Record<Porte, SkillStepConfig[]>> = {};
    for (const porte of ["simples", "media", "grande"] as const) {
      const steps = sanitizeSteps(o[porte]);
      if (steps) out[porte] = steps;
      else if (Array.isArray(o[porte])) out[porte] = []; // lista vazia explícita = pular skills
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** Resolve uma cadeia (lista OU objeto por porte) para um porte. Lista pula "simples". */
function resolvePorte(
  chain: SkillStepConfig[] | Partial<Record<Porte, SkillStepConfig[]>> | undefined,
  porte: Porte,
): SkillStepConfig[] {
  if (!chain) return [];
  if (Array.isArray(chain)) return porte === "simples" ? [] : chain;
  return chain[porte] ?? [];
}

/** É a skill de produto (office-hours)? — separa o "QUÊ" do "COMO" no compat do legado. */
function ehOfficeHours(s: SkillStepConfig): boolean {
  return /office-?hours/i.test(s.skill);
}

/**
 * Fase "Plano" (produto): office-hours. Do bloco plano_produto, ou — compat — só
 * o office-hours do bloco legado `plano`.
 */
export function skillsProduto(cfg: InhouseConfig | null, porte: Porte): SkillStepConfig[] {
  if (cfg?.skills?.plano_produto) return resolvePorte(cfg.skills.plano_produto, porte);
  return resolvePorte(cfg?.skills?.plano, porte).filter(ehOfficeHours);
}

/**
 * Fase "Detalhamento": plan-eng-review (+ plan-design-review quando design). Do
 * bloco detalhamento, ou — compat — tudo do `plano` legado exceto office-hours.
 */
export function skillsDetalhamento(cfg: InhouseConfig | null, porte: Porte): SkillStepConfig[] {
  if (cfg?.skills?.detalhamento) return resolvePorte(cfg.skills.detalhamento, porte);
  return resolvePorte(cfg?.skills?.plano, porte).filter((s) => !ehOfficeHours(s));
}

/** Legado: cadeia de plano única (mantido para os testes/compat existentes). */
export function skillsPlanoPara(cfg: InhouseConfig | null, porte: Porte): SkillStepConfig[] {
  return resolvePorte(cfg?.skills?.plano, porte);
}

/**
 * Cascata de configuração — ninguém precisa lembrar de copiar/commitar nada:
 * 1. arquivo commitado no espaço da tarefa (projeto manda);
 * 2. arquivo na pasta principal do projeto (mesmo sem commit);
 * 3. config global da máquina (~/.inhouse/config.json ou legado) — vale pra todos.
 */
export function loadConfigCascata(
  ...dirs: (string | undefined)[]
): InhouseConfig | null {
  for (const d of dirs) {
    if (!d) continue;
    const cfg = loadConfigFile(join(d, CONFIG_FILE));
    if (cfg) return cfg;
  }
  return loadConfigFile(GLOBAL_CONFIG_FILE);
}

export function loadConfig(worktreePath: string): InhouseConfig | null {
  return loadConfigFile(join(worktreePath, CONFIG_FILE));
}

export function loadConfigFile(file: string): InhouseConfig | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const skills = (raw.skills ?? {}) as Record<string, unknown>;
    const plano = sanitizePlano(skills.plano);
    const plano_produto = sanitizePlano(skills.plano_produto);
    const detalhamento = sanitizePlano(skills.detalhamento);
    const verificacoes = sanitizeSteps(skills.verificacoes);
    const preview = sanitizePreview(raw.preview);
    if (!plano && !plano_produto && !detalhamento && !verificacoes && !preview) return null;
    return { skills: { plano, plano_produto, detalhamento, verificacoes }, ...(preview ? { preview } : {}) };
  } catch (err) {
    console.warn(`[config] ${file} inválido — ignorando:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** O projeto tem UI? (heurística por dependências de frontend no package.json) */
export function temUi(worktreePath: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(worktreePath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.keys(deps).some((d) =>
      /^(react|react-dom|vue|svelte|next|nuxt|vite|@angular\/core|solid-js|preact)$/.test(d),
    );
  } catch {
    return false;
  }
}
