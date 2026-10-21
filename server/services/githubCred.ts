/**
 * Credencial do GitHub para o git, vinda do GitHub CLI (gh).
 *
 * Ter o gh instalado e logado não basta: o git só usa a conta do gh depois de
 * `gh auth setup-git` (que mexe na config GLOBAL). Em vez disso passamos o
 * credential helper do gh só no comando (`-c credential.helper=…`) e, depois do
 * clone, gravamos o mesmo helper na config LOCAL do repositório — assim fetch e
 * push daquele projeto (e dos worktrees dele) também usam a conta do gh, sem
 * tocar no ~/.gitconfig da pessoa.
 */
import { contaDoStatus, localizarGh, maquinaReal } from "../setup/detectar.js";
import type { Maquina } from "../setup/detectar.js";

export { contaDoStatus };

export interface EstadoGh {
  /** Caminho do executável do gh; null se não está instalado. */
  gh: string | null;
  logado: boolean;
  conta?: string;
}

export async function estadoGh(m: Maquina = maquinaReal()): Promise<EstadoGh> {
  const gh = localizarGh(m);
  if (!gh) return { gh: null, logado: false };
  const r = await m.exec(gh, ["auth", "status", "--hostname", "github.com"], {
    timeoutMs: 10_000,
    env: { ...m.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
  });
  if (r.code !== 0) return { gh, logado: false };
  const conta = contaDoStatus(`${r.stdout}\n${r.stderr}`);
  return { gh, logado: true, ...(conta ? { conta } : {}) };
}

/** `gh auth token` responde: o git consegue usar a conta do gh. */
export async function ghEntregaCredencial(gh: string, m: Maquina = maquinaReal()): Promise<boolean> {
  const r = await m.exec(gh, ["auth", "token", "--hostname", "github.com"], {
    timeoutMs: 10_000,
    env: { ...m.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
  });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** `gh repo view dono/repo`: a conta logada enxerga o repositório? */
export async function ghVerRepo(gh: string, repo: string, m: Maquina = maquinaReal()): Promise<{ ok: boolean; stderr: string }> {
  const r = await m.exec(gh, ["repo", "view", repo, "--json", "name"], {
    timeoutMs: 30_000,
    env: { ...m.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
  });
  return { ok: r.code === 0, stderr: `${r.stderr}\n${r.code === 0 ? "" : r.stdout}`.trim() };
}

/**
 * Valor do credential.helper que chama o gh. Barras normais e aspas: o git roda
 * helpers "!" num shell (sh também no Git for Windows), e o caminho pode ter
 * espaço ("C:\Program Files\GitHub CLI\gh.exe").
 */
export function helperGh(gh: string): string {
  return `!"${gh.replace(/\\/g, "/")}" auth git-credential`;
}

/**
 * `-c` para o git usar SÓ a conta do gh neste comando. O `credential.helper=`
 * vazio zera os helpers já configurados (keychain/Credential Manager com uma
 * senha velha ou de outra conta) antes de pôr o do gh.
 */
export function argsCredencialGh(gh: string): string[] {
  return ["-c", "credential.helper=", "-c", `credential.helper=${helperGh(gh)}`];
}

/** Pares chave/valor da config local do repo (aplicados com `git config [--add]`). */
export function configLocalGh(gh: string): Array<[string, string]> {
  return [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", helperGh(gh)],
  ];
}
