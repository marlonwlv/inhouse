import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Porta da UI. Escuta APENAS em 127.0.0.1 (decisão de segurança — ver ARCHITECTURE.md). */
export const PORT = Number(process.env.INHOUSE_PORT ?? process.env.INHOUSE_PORT ?? 4400);
export const HOST = "127.0.0.1";

/**
 * Compat de rebrand (Inhouse Builder → Inhouse): instalações antigas têm dados
 * nos caminhos legados; usa-os quando existem e o novo ainda não existe —
 * mover diretórios quebraria os links absolutos dos git worktrees.
 */
function dirComCompat(novo: string, legado: string): string {
  return !existsSync(novo) && existsSync(legado) ? legado : novo;
}

/** Onde ficam os projetos abertos/criados pelo builder (visível ao usuário). */
export const PROJECTS_DIR =
  process.env.INHOUSE_PROJECTS_DIR ??
  process.env.INHOUSE_PROJECTS_DIR ??
  dirComCompat(join(homedir(), "Inhouse"), join(homedir(), "Inhouse"));
/** Worktrees ("espaços") ficam fora do checkout principal. */
export const ESPACOS_DIR = join(PROJECTS_DIR, ".espacos");
/** Estado e transcripts. */
export const DATA_DIR =
  process.env.INHOUSE_DATA_DIR ??
  process.env.INHOUSE_DATA_DIR ??
  dirComCompat(join(homedir(), ".inhouse"), join(homedir(), ".inhouse"));
export const TRANSCRIPTS_DIR = join(DATA_DIR, "transcripts");
/** Dados do eval de experiência (registros JSONL + relatórios do juiz). */
export const EVAL_DIR = join(DATA_DIR, "eval");
export const RELATORIOS_DIR = join(EVAL_DIR, "relatorios");
/** Gatilho automático do relatório: a cada N tarefas finalizadas sem análise. */
export const EVAL_AUTO_A_CADA = Number(process.env.INHOUSE_EVAL_A_CADA ?? 10);

/** Faixa de portas para previews (dev servers dos espaços). */
export const PREVIEW_PORT_BASE = 4500;

/** Timeout para pedidos de permissão sem resposta humana (nega ao expirar). */
export const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Rodadas máximas de auto-correção quando as verificações falham. */
export const MAX_GATE_FIX_ROUNDS = 2;

export function ensureDirs(): void {
  for (const d of [PROJECTS_DIR, ESPACOS_DIR, DATA_DIR, TRANSCRIPTS_DIR, EVAL_DIR, RELATORIOS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

let cachedClaudePath: string | null | undefined;
/**
 * Caminho do Claude Code genuíno da máquina (login do usuário).
 * Override: INHOUSE_CLAUDE_PATH (legado: INHOUSE_CLAUDE_PATH). Se não achar, retorna null (UI mostra aviso).
 */
export function claudePath(): string | null {
  if (cachedClaudePath !== undefined) return cachedClaudePath;
  const override = process.env.INHOUSE_CLAUDE_PATH ?? process.env.INHOUSE_CLAUDE_PATH;
  if (override) return (cachedClaudePath = override);
  try {
    const p = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
    cachedClaudePath = p.length > 0 ? p : null;
  } catch {
    cachedClaudePath = null;
  }
  return cachedClaudePath;
}

/**
 * Ambiente para processos que falam com o Claude: NUNCA deixar vazar API key —
 * a autenticação deve vir do login do CLI (subscription). Padrão vibe-kanban.
 */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  // Evita que a sessão-mãe (este app rodando dentro de um Claude Code) confunda o filho.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}
