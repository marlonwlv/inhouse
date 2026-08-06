/**
 * Aviso de versão nova do próprio Inhouse. Só funciona quando a instalação é um
 * clone git com `origin` (o caminho recomendado no README). Degrada em silêncio
 * para instalações por ZIP ou quando está offline — nunca derruba nada.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { UpdateInfo } from "../../shared/types.js";
import { RunError, git, tryGit } from "./proc.js";

/** Raiz do repositório do PRÓPRIO Inhouse (server/services/update.ts -> ../../). */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * O REPO_ROOT é, ele mesmo, a raiz de um clone git com origin? (não um subdir
 * dentro de OUTRO repo) — senão git pull/fetch mirariam o repo errado.
 */
async function ehRepoInhouse(): Promise<boolean> {
  const top = await tryGit(REPO_ROOT, "rev-parse", "--show-toplevel");
  const origin = await tryGit(REPO_ROOT, "remote", "get-url", "origin");
  return Boolean(top && origin) && resolve(top!.trim()) === resolve(REPO_ROOT);
}

let cache: UpdateInfo = { suportado: false, disponivel: false, atras: 0 };

export function ultimoUpdate(): UpdateInfo {
  return cache;
}

async function branchAtual(): Promise<string> {
  return (await tryGit(REPO_ROOT, "rev-parse", "--abbrev-ref", "HEAD"))?.trim() || "main";
}

/** Checa se há commits novos em origin/<branch>. Nunca lança. */
export async function checarUpdate(): Promise<UpdateInfo> {
  if (!(await ehRepoInhouse())) {
    cache = { suportado: false, disponivel: false, atras: 0 };
    return cache;
  }
  const branch = await branchAtual();
  // fetch pode falhar (offline) — tryGit engole; seguimos com o que já temos.
  await tryGit(REPO_ROOT, "fetch", "origin", branch, "--quiet");
  const count = await tryGit(REPO_ROOT, "rev-list", "--count", `HEAD..origin/${branch}`);
  const atras = count ? Number.parseInt(count.trim(), 10) || 0 : 0;
  cache = { suportado: true, disponivel: atras > 0, atras, checadoEm: new Date().toISOString() };
  return cache;
}

/**
 * Atualiza o Inhouse com `git pull --ff-only`. Recusa se a pasta estiver suja
 * (não engole alterações locais). Requer reiniciar o server para aplicar.
 */
export async function aplicarUpdate(): Promise<{ ok: boolean; mensagem: string }> {
  if (!(await ehRepoInhouse())) {
    return { ok: false, mensagem: "Esta instalação não é um clone git; baixe a versão nova manualmente." };
  }
  const sujo = await tryGit(REPO_ROOT, "status", "--porcelain");
  if (sujo && sujo.trim().length > 0) {
    return {
      ok: false,
      mensagem: "Há alterações locais no Inhouse. Guarde ou descarte antes de atualizar (git pull).",
    };
  }
  const branch = await branchAtual();
  try {
    await git(REPO_ROOT, "pull", "--ff-only", "origin", branch);
  } catch (err) {
    const detalhe = err instanceof RunError ? err.stderr.trim() || err.message : String(err);
    return { ok: false, mensagem: `Não deu para atualizar automaticamente: ${detalhe}` };
  }
  await checarUpdate();
  return { ok: true, mensagem: "Atualizado! Feche e abra o Inhouse de novo para aplicar a versão nova." };
}
