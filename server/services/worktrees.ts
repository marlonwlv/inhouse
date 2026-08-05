/**
 * "Espaços" = git worktrees isolados por tarefa (a palavra worktree/branch
 * nunca aparece na UI). Ficam em ESPACOS_DIR/<projeto>/espaco-<N>.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../../shared/types.js";
import { ESPACOS_DIR } from "../config.js";
import { broadcast } from "../events.js";
import { git, lastLines, tryGit } from "./proc.js";

const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

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

export async function createEspaco(
  project: Project,
  espaco: number,
  slug: string,
): Promise<{ branch: string; worktreePath: string }> {
  const worktreePath = join(ESPACOS_DIR, project.name, `espaco-${espaco}`);
  await mkdir(join(ESPACOS_DIR, project.name), { recursive: true });

  // Sobra de uma tarefa anterior no mesmo número de espaço: limpa antes.
  if (existsSync(worktreePath)) {
    try {
      await git(project.path, "worktree", "remove", "--force", worktreePath);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      await tryGit(project.path, "worktree", "prune");
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

  await ensureDeps(worktreePath, project.name);
  return { branch, worktreePath };
}

export async function removeEspaco(
  project: Project,
  worktreePath: string,
  opts?: { keepBranch?: boolean },
): Promise<void> {
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
  if (!existsSync(join(worktreePath, "package.json"))) return;
  if (existsSync(join(worktreePath, "node_modules"))) return;

  broadcast({
    type: "project_progress",
    name: projectName,
    message: "Preparando o espaço da tarefa… instalando dependências (pode levar alguns minutos).",
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install"], {
      cwd: worktreePath,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
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
      reject(new Error("Não foi possível rodar o npm nesta máquina. Fale com o time técnico.", { cause: err }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
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
  });

  broadcast({ type: "project_progress", name: projectName, message: "Espaço pronto." });
}
