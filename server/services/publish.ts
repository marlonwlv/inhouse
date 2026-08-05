/**
 * Publicação: commit final no espaço, merge --no-ff no checkout principal,
 * PR opcional via gh, e limpeza (preview + espaço).
 */
import type { Project, Task } from "../../shared/types.js";
import { broadcast } from "../events.js";
import { transcriptAppend } from "../store.js";
import { withProjectLock } from "./locks.js";
import { RunError, git, gitCommit, run, tryGit } from "./proc.js";
import { stopPreview } from "./preview.js";
import { removeEspaco } from "./worktrees.js";

function sistema(taskId: string, text: string): void {
  const item = { kind: "system" as const, text, at: new Date().toISOString() };
  transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

export function publishTask(
  task: Task,
  project: Project,
  createPr: boolean,
): Promise<{ prUrl?: string }> {
  // Uma operação git de cada vez por projeto (publish concorrente com outro
  // publish/createEspaco no mesmo repo colide em index.lock/checkout).
  return withProjectLock(project.id, () => doPublish(task, project, createPr));
}

async function doPublish(
  task: Task,
  project: Project,
  createPr: boolean,
): Promise<{ prUrl?: string }> {
  // 1. Commit final no espaço, se sobrou mudança não commitada.
  const pendente = await git(task.worktreePath, "status", "--porcelain");
  if (pendente.length > 0) {
    await git(task.worktreePath, "add", "-A");
    await gitCommit(task.worktreePath, `Tarefa: ${task.title}`);
  }

  // 2. Merge no checkout principal. Garante que ele está no branch padrão
  //    (alguém pode ter mexido na pasta por fora do builder).
  const branchAtual = await tryGit(project.path, "rev-parse", "--abbrev-ref", "HEAD");
  if (branchAtual !== project.defaultBranch) {
    try {
      await git(project.path, "checkout", project.defaultBranch);
    } catch (err) {
      throw new Error(
        "O projeto principal está em um estado inesperado e não deu para publicar. Fale com o time técnico.",
        { cause: err },
      );
    }
  }
  // Arquivos gerados na pasta principal pelo próprio builder (ex.: package-lock.json
  // do npm install pós-criação) não podem travar o merge: commita antes.
  const sujoMain = await git(project.path, "status", "--porcelain");
  if (sujoMain.length > 0) {
    await git(project.path, "add", "-A");
    await gitCommit(project.path, "Arquivos gerados automaticamente (Inhouse Builder)");
  }
  try {
    await git(
      project.path,
      "merge",
      "--no-ff",
      task.branch,
      "-m",
      `Tarefa: ${task.title} (espaço ${task.espaco})`,
    );
  } catch (err) {
    await tryGit(project.path, "merge", "--abort");
    const texto = err instanceof RunError ? err.stdout + err.stderr : String(err);
    // Main "sujo": alguém editou arquivos na pasta principal por fora do builder
    // e o git se recusa a fazer o merge por cima ("would be overwritten").
    if (/would be overwritten/i.test(texto)) {
      throw new Error(
        "Há alterações não salvas na pasta principal do projeto (feitas por fora do builder). Guarde ou descarte essas alterações e publique de novo.",
      );
    }
    if (/conflict|Automatic merge failed/i.test(texto)) {
      throw new Error(
        "As mudanças conflitam com o que já está no projeto. Peça uma atualização da tarefa ou fale com o time técnico.",
      );
    }
    throw new Error("Não foi possível juntar as mudanças ao projeto. Fale com o time técnico.", {
      cause: err,
    });
  }

  // 3. PR opcional — falha aqui NÃO desfaz a publicação local.
  let prUrl: string | undefined;
  if (createPr && project.originUrl) {
    try {
      await git(project.path, "push", "-u", "origin", task.branch);
      const { stdout } = await run(
        "gh",
        [
          "pr",
          "create",
          "--title",
          `Tarefa: ${task.title}`,
          "--body",
          `Criado pelo Inhouse Builder\n\n${task.description}`,
          "--head",
          task.branch,
          "--base",
          project.defaultBranch,
        ],
        { cwd: project.path },
      );
      // gh imprime a URL do PR no stdout.
      const m = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(stdout);
      if (m) prUrl = m[0];
      sistema(task.id, prUrl ? `Pull request criado: ${prUrl}` : "Pull request criado no GitHub.");
    } catch (err) {
      const detalhe = err instanceof RunError ? err.stderr.trim() || err.message : String(err);
      sistema(
        task.id,
        `As mudanças foram publicadas no projeto local, mas não deu para criar o pull request no GitHub: ${detalhe}`,
      );
    }
  }

  // 4. Limpeza: para o preview e remove o espaço (o branch fica como histórico).
  await stopPreview(task.id);
  await removeEspaco(project, task.worktreePath);

  return prUrl ? { prUrl } : {};
}
