/**
 * "Espaços" = git worktrees isolados por tarefa (a palavra worktree/branch
 * nunca aparece na UI). Ficam em ESPACOS_DIR/<projeto>/espaco-<N>.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Project } from "../../shared/types.js";
import { ESPACOS_DIR, claudeEnv } from "../config.js";
import { fakeRealGates, isFakeModelActive } from "../debug/flag.js";
import { broadcast } from "../events.js";
import { loadConfigCascata } from "../workflow/config.js";
import { withLimit } from "./limiter.js";
import { withProjectLock } from "./locks.js";
import { git, gitCommit, lastLines, tryGit } from "./proc.js";

const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Installs de espaço (npm/pnpm) em andamento — mortos no shutdown para não virar órfãos. */
const installsDeEspaco = new Set<ChildProcess>();
export function killInstallsDeEspaco(): void {
  for (const child of installsDeEspaco) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }
  installsDeEspaco.clear();
}

/** Converte um título livre em slug seguro para nome de branch. */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos (marcas combinantes do NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : "tarefa";
}

export function createEspaco(
  project: Project,
  espaco: number,
  slug: string,
): Promise<{ branch: string; worktreePath: string }> {
  // Serializa com publish e outros createEspaco do mesmo projeto (index.lock).
  return withProjectLock(project.id, () => doCreateEspaco(project, espaco, slug));
}

async function doCreateEspaco(
  project: Project,
  espaco: number,
  slug: string,
): Promise<{ branch: string; worktreePath: string }> {
  const worktreePath = join(ESPACOS_DIR, project.name, `espaco-${espaco}`);
  await mkdir(join(ESPACOS_DIR, project.name), { recursive: true });

  // Sobra de uma tarefa anterior no mesmo número de espaço: limpa antes — mas
  // NUNCA destruindo trabalho que não tenha sido preservado com segurança.
  if (existsSync(worktreePath)) {
    // Sem pendências → não há nada a perder. Com pendências (ex.: tarefa
    // cancelada no meio da execução): commita no branch antigo para preservar,
    // e só considera preservado se a árvore REALMENTE ficar limpa depois — o
    // commit pode falhar (hook, estado estranho) e não podemos confiar nele cego.
    const pendente = await tryGit(worktreePath, "status", "--porcelain");
    let preservado = pendente === null || pendente.length === 0;
    if (!preservado) {
      await tryGit(worktreePath, "add", "-A");
      try {
        await gitCommit(worktreePath, "Trabalho preservado automaticamente pelo Inhouse");
      } catch {
        // Tratado abaixo: se não commitou, `preservado` continua falso.
      }
      const aindaPendente = await tryGit(worktreePath, "status", "--porcelain");
      preservado = aindaPendente !== null && aindaPendente.length === 0;
    }

    if (preservado) {
      try {
        await git(project.path, "worktree", "remove", "--force", worktreePath);
      } catch {
        await rm(worktreePath, { recursive: true, force: true });
        await tryGit(project.path, "worktree", "prune");
      }
    } else {
      // Preservação NÃO confirmada: em vez de apagar, move a pasta para o lado
      // (recuperável manualmente) e avisa. Só um `rm` cego perderia o trabalho.
      const abrigo = `${worktreePath}.recuperar-${Date.now()}`;
      try {
        // Sem --force: com a árvore suja o git recusa remover (o que queremos).
        await tryGit(project.path, "worktree", "remove", worktreePath);
        await rename(worktreePath, abrigo);
        await tryGit(project.path, "worktree", "prune");
        broadcast({
          type: "project_progress",
          name: project.name,
          message:
            "Havia trabalho não salvo no espaço anterior que não pôde ser guardado automaticamente. " +
            `Nada foi apagado — a pasta foi preservada em ${abrigo}. Se precisar, o time técnico recupera a partir dela.`,
        });
      } catch (err) {
        // Se nem mover foi possível, ABORTA a criação do espaço em vez de destruir.
        throw new Error(
          "Havia trabalho não salvo no espaço anterior e não foi possível preservá-lo com segurança. " +
            "Nada foi apagado. Fale com o time técnico.",
          { cause: err },
        );
      }
    }
  }

  // Se o branch já existe (título repetido em espaço reutilizado), acha um nome livre
  // em vez de destruir histórico antigo.
  let branch = `tarefa/${slug}-${espaco}`;
  let sufixo = 2;
  while ((await tryGit(project.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) !== null) {
    branch = `tarefa/${slug}-${espaco}-${sufixo++}`;
  }

  try {
    await git(project.path, "worktree", "add", "-b", branch, worktreePath, project.defaultBranch);
  } catch (err) {
    throw new Error("Não foi possível criar o espaço de trabalho da tarefa. Tente de novo.", {
      cause: err,
    });
  }

  // Arquivos de ambiente (.env.local etc.) são gitignored: não vêm no worktree.
  // Copia os declarados no bloco `preview` do config — gates e preview precisam.
  const envFiles = loadConfigCascata(worktreePath, project.path)?.preview?.envFiles;
  if (envFiles?.length) await copiarEnvFiles(project, worktreePath, envFiles);

  // Falha ao instalar dependências NÃO derruba a tarefa: plano e execução
  // funcionam sem node_modules — só gates/preview ficarão limitados (e avisamos).
  try {
    await ensureDeps(worktreePath, project.name);
  } catch (err) {
    broadcast({
      type: "project_progress",
      name: project.name,
      message: `Não deu para instalar as dependências do espaço — a tarefa segue, mas verificações e preview podem falhar. Detalhe: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
  return { branch, worktreePath };
}

/**
 * Copia arquivos de ambiente (ex.: .env.local) da pasta principal para o espaço.
 * São gitignored, logo não vêm no worktree, e são a causa nº1 de "subiu mas
 * quebrou". Idempotente: só copia o que existe na origem e ainda falta no destino.
 * Os caminhos já vêm sanitizados (sem `..`/absolutos) pelo config.
 */
export async function copiarEnvFiles(
  project: Project,
  worktreePath: string,
  envFiles: string[],
): Promise<void> {
  for (const rel of envFiles) {
    const origem = join(project.path, rel);
    const destino = join(worktreePath, rel);
    if (!existsSync(origem) || existsSync(destino)) continue;
    try {
      await mkdir(dirname(destino), { recursive: true });
      await cp(origem, destino);
    } catch {
      // Melhor esforço: falha ao copiar um env não pode derrubar a tarefa.
    }
  }
}

export async function removeEspaco(
  project: Project,
  worktreePath: string,
  opts?: { keepBranch?: boolean },
): Promise<void> {
  // Salvaguarda: NUNCA apagar o checkout principal. Sem isto, um worktreePath
  // igual a project.path cairia no rm(recursive) do catch e destruiria o projeto.
  if (!worktreePath || resolve(worktreePath) === resolve(project.path)) return;
  // Descobre o branch antes de remover (para o caso keepBranch === false).
  const branch = await tryGit(worktreePath, "rev-parse", "--abbrev-ref", "HEAD");
  try {
    await git(project.path, "worktree", "remove", "--force", worktreePath);
  } catch {
    // Worktree quebrado/desregistrado: remove a pasta e limpa o registro do git.
    await rm(worktreePath, { recursive: true, force: true });
    await tryGit(project.path, "worktree", "prune");
  }
  // Padrão: o branch fica (histórico). Só apaga se pedirem explicitamente.
  if (opts?.keepBranch === false && branch && branch !== "HEAD") {
    await tryGit(project.path, "branch", "-D", branch);
  }
}

/**
 * Worktrees novos não têm node_modules (git não versiona). Sem isso, gates e
 * preview não funcionam — instala aqui, avisando o usuário pelo SSE.
 */
export async function ensureDeps(worktreePath: string, projectName: string): Promise<void> {
  // Modo debug: manter as jornadas leves — não instala deps por espaço, exceto
  // quando explicitamente pedido (--real-gates), pois aí o tsc precisa rodar.
  if (isFakeModelActive() && !fakeRealGates()) return;
  if (!existsSync(join(worktreePath, "package.json"))) return;
  if (existsSync(join(worktreePath, "node_modules"))) return;

  broadcast({
    type: "project_progress",
    name: projectName,
    message: "Preparando o espaço da tarefa… instalando dependências (pode levar alguns minutos).",
  });

  // Monorepos pnpm (workspace:) quebram com npm install — detecta o gerenciador
  // pelo lockfile. pnpm chega via corepack (embutido no Node), sem instalar nada.
  const usaPnpm =
    existsSync(join(worktreePath, "pnpm-lock.yaml")) ||
    existsSync(join(worktreePath, "pnpm-workspace.yaml"));
  const [cmd, args] = usaPnpm
    ? ["corepack", ["pnpm", "install"]]
    : ["npm", ["install"]];

  // Limitador GLOBAL de installs: no máx. N `npm/pnpm install` em paralelo na máquina.
  await withLimit("install", () => new Promise<void>((resolve, reject) => {
    // claudeEnv(): scripts postinstall de dependências rodam código arbitrário
    // do projeto — não podem ver ANTHROPIC_API_KEY/AUTH_TOKEN.
    const child = spawn(cmd, args, {
      cwd: worktreePath,
      env: claudeEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    installsDeEspaco.add(child); // rastreado para o shutdown matar (evita órfão)
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = lastLines(stderrTail + String(d), 30);
    });
    let estourou = false;
    const timer = setTimeout(() => {
      estourou = true;
      child.kill("SIGKILL");
    }, NPM_INSTALL_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      installsDeEspaco.delete(child);
      reject(new Error("Não foi possível rodar o npm nesta máquina. Fale com o time técnico.", { cause: err }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      installsDeEspaco.delete(child);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            estourou
              ? "A instalação das dependências demorou demais e foi interrompida. Tente de novo."
              : "Não foi possível instalar as dependências do projeto. Verifique a internet e tente de novo.",
            { cause: stderrTail },
          ),
        );
      }
    });
  }));

  broadcast({ type: "project_progress", name: projectName, message: "Espaço pronto." });
}
