/**
 * Higiene da pasta principal (o checkout do projeto, fora dos espaços).
 *
 * A preparação roda de propósito na pasta principal: instala dependências (o
 * que cria/atualiza o lockfile) e copia .env.example → .env/.env.local. Sem
 * arrumação, isso deixava a pasta "suja" para sempre e o publish do Caminho B
 * (app sem origin) recusava toda publicação — um beco sem saída para quem não
 * sabe git. Aqui:
 *  - segredos e arquivos gerados ficam IGNORADOS via .git/info/exclude (local,
 *    nunca entra em commit — um .env jamais vai para o histórico);
 *  - o resto é GUARDADO num commit identificável (ou num stash nomeado, se o
 *    HEAD estiver solto), para nada se perder e tudo ser recuperável.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { git, gitCommit, tryGit } from "./proc.js";

export const MARCA_EXCLUDE = "# Inhouse: arquivos locais (segredos e gerados) — nunca vão para o histórico";

/** Padrões locais: segredos (.env*) e pastas geradas por instalação. */
export const PADROES_LOCAIS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.dist",
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".DS_Store",
  "npm-debug.log*",
  "yarn-error.log*",
];

/**
 * Garante o bloco do Inhouse no .git/info/exclude (idempotente). Só afeta
 * arquivos NÃO rastreados — não muda nada do que já está no histórico.
 */
export async function protegerArquivosLocais(path: string): Promise<void> {
  const rel = await git(path, "rev-parse", "--git-path", "info/exclude");
  const arquivo = isAbsolute(rel) ? rel : join(path, rel);
  let atual = "";
  try {
    atual = await readFile(arquivo, "utf8");
  } catch {
    // ainda não existe
  }
  if (atual.includes(MARCA_EXCLUDE)) return;
  await mkdir(dirname(arquivo), { recursive: true });
  const prefixo = atual.length > 0 && !atual.endsWith("\n") ? "\n" : "";
  await appendFile(arquivo, `${prefixo}\n${MARCA_EXCLUDE}\n${PADROES_LOCAIS.join("\n")}\n`);
}

/** Arquivos com alteração pendente (para mostrar à pessoa / no histórico). */
export async function arquivosPendentes(path: string): Promise<string[]> {
  const out = await git(path, "status", "--porcelain", "--untracked-files=all");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => /^\S{1,2}\s+(.*)$/.exec(l)?.[1] ?? l);
}

export interface Guardado {
  arquivos: string[];
  como: "commit" | "stash";
}

/**
 * Deixa a pasta principal limpa SEM perder nada: ignora o que é local e guarda
 * o resto (commit na branch atual; stash nomeado se o HEAD estiver solto).
 * Devolve null se já estava limpa.
 */
export async function guardarPendencias(path: string, mensagem: string): Promise<Guardado | null> {
  await protegerArquivosLocais(path);
  const arquivos = await arquivosPendentes(path);
  if (arquivos.length === 0) return null;
  const branch = await tryGit(path, "rev-parse", "--abbrev-ref", "HEAD");
  if (!branch || branch === "HEAD") {
    await git(path, "stash", "push", "-u", "-m", `Inhouse: ${mensagem}`);
    return { arquivos, como: "stash" };
  }
  await git(path, "add", "-A");
  await gitCommit(path, mensagem);
  return { arquivos, como: "commit" };
}

/** Resumo curto (até 5 nomes) para a mensagem no chat. */
export function listaCurta(arquivos: string[]): string {
  const max = 5;
  const nomes = arquivos.slice(0, max).join(", ");
  return arquivos.length > max ? `${nomes} e mais ${arquivos.length - max}` : nomes;
}
