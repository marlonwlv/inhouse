/**
 * Publicação: commit final no espaço, merge --no-ff no checkout principal,
 * PR opcional via gh, e limpeza (preview + espaço).
 */
import type { Project, Task } from "../../shared/types.js";
import { isFakeModelActive } from "../debug/flag.js";
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
  // Modo debug: não mexe em git de verdade — o projeto descartável não tem
  // origin e a execução fake não commitou nada publicável. Espelha o real
  // encerrando o preview antes (senão o server fake de preview vaza, já que
  // doPublish — que faria o stopPreview — é pulado aqui).
  if (isFakeModelActive()) {
    return stopPreview(task.id).then(() => (createPr ? { prUrl: "https://github.com/fake/app/pull/1" } : {}));
  }
  // Uma operação git de cada vez por projeto (publish concorrente com outro
  // publish/createEspaco no mesmo repo colide em index.lock/checkout).
  return withProjectLock(project.id, () => doPublish(task, project, createPr));
}

async function doPublish(
  task: Task,
  project: Project,
  _createPr: boolean,
): Promise<{ prUrl?: string }> {
  // 1. Commit final no espaço, se sobrou mudança não commitada.
  const pendente = await git(task.worktreePath, "status", "--porcelain");
  if (pendente.length > 0) {
    await git(task.worktreePath, "add", "-A");
    await gitCommit(task.worktreePath, `Tarefa: ${task.title}`);
  }

  // Caminho A — repo real com origin (ex.: produção): PR-only. NUNCA toca o main
  // (local ou remoto): empurra a branch da tarefa e abre um Pull Request revisável.
  if (project.originUrl) {
    const prUrl = await publicarComoPR(task, project);
    await stopPreview(task.id);
    await removeEspaco(project, task.worktreePath);
    return prUrl ? { prUrl } : {};
  }

  // Caminho B — app de template sem origin (sandbox): merge --no-ff no main LOCAL.
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
  // NÃO auto-commitar o working tree do main — recusa se estiver sujo, para nunca
  // engolir trabalho não salvo de ninguém.
  const sujoMain = await git(project.path, "status", "--porcelain");
  if (sujoMain.length > 0) {
    throw new Error(
      "Há alterações não salvas na pasta principal do projeto. Guarde ou descarte essas alterações antes de publicar.",
    );
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
    if (/conflict|Automatic merge failed/i.test(texto)) {
      throw new Error(
        "As mudanças conflitam com o que já está no projeto. Peça uma atualização da tarefa ou fale com o time técnico.",
      );
    }
    throw new Error("Não foi possível juntar as mudanças ao projeto. Fale com o time técnico.", {
      cause: err,
    });
  }

  await stopPreview(task.id);
  await removeEspaco(project, task.worktreePath);
  return {};
}

/** Empurra a branch da tarefa (do próprio espaço) e abre um PR — sem tocar o main. */
async function publicarComoPR(task: Task, project: Project): Promise<string | undefined> {
  try {
    await git(task.worktreePath, "push", "-u", "origin", task.branch);
  } catch (err) {
    const detalhe = err instanceof RunError ? err.stderr.trim() || err.message : String(err);
    throw new Error(`Não foi possível enviar a branch para o GitHub: ${detalhe}`);
  }
  try {
    const { stdout } = await run(
      "gh",
      [
        "pr",
        "create",
        "--title",
        `Tarefa: ${task.title}`,
        "--body",
        `Criado pelo Inhouse\n\n${task.description}`,
        "--head",
        task.branch,
        "--base",
        project.defaultBranch,
      ],
      { cwd: task.worktreePath },
    );
    const m = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(stdout);
    if (m) sistema(task.id, `Pull request criado: ${m[0]}`);
    else sistema(task.id, "Pull request criado no GitHub.");
    return m?.[0];
  } catch (err) {
    // A branch já subiu; o PR pode ter falhado (gh deslogado, PR já aberto).
    const detalhe = err instanceof RunError ? err.stderr.trim() || err.message : String(err);
    sistema(
      task.id,
      `A branch foi enviada para o GitHub, mas não deu para abrir o Pull Request automaticamente (${detalhe}). Abra o PR a partir da branch "${task.branch}".`,
    );
    return undefined;
  }
}
