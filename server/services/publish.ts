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
import { classificarErroGitHub, repoDaUrl } from "./githubErro.js";
import type { ErroGitHub } from "./githubErro.js";

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
    const { prUrl, erro } = await publicarComoPR(task, project);
    if (!prUrl) {
      // Sem PR a tarefa não pode "concluir" e perder o espaço: falha visível e
      // recuperável (Tentar de novo), com o motivo.
      throw new Error(
        `A branch foi enviada para o GitHub, mas o Pull Request não abriu. ${erro?.mensagem ?? "Tente de novo em instantes."}`,
      );
    }
    await stopPreview(task.id);
    await removeEspaco(project, task.worktreePath);
    return { prUrl };
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

/**
 * Etapa Revisão: commit final + push + PR — e SÓ isso. O espaço e o preview
 * ficam VIVOS: o loop de ajustes da revisão (o Claude corrigindo apontamentos
 * do time) precisa da branch checked-out, e a pessoa pode seguir testando.
 * A limpeza acontece no merge (mergeRevisao/limparAposMerge).
 */
export function enviarParaRevisao(task: Task, project: Project): Promise<ResultadoPR> {
  if (isFakeModelActive()) {
    return Promise.resolve({ prUrl: "https://github.com/fake/app/pull/1" });
  }
  return withProjectLock(project.id, async () => {
    const pendente = await git(task.worktreePath, "status", "--porcelain");
    if (pendente.length > 0) {
      await git(task.worktreePath, "add", "-A");
      await gitCommit(task.worktreePath, `Tarefa: ${task.title}`);
    }
    return publicarComoPR(task, project);
  });
}

/** Publica com a revisão aprovada: merge do PR via gh + limpeza do espaço. */
export function mergeRevisao(task: Task, project: Project): Promise<void> {
  if (isFakeModelActive()) {
    return stopPreview(task.id);
  }
  return withProjectLock(project.id, async () => {
    if (!task.prUrl) throw new Error("Esta tarefa não tem um Pull Request aberto.");
    try {
      await run("gh", ["pr", "merge", task.prUrl, "--merge"], { cwd: project.path });
    } catch (err) {
      const detalhe = err instanceof RunError ? err.stderr.trim() || err.message : String(err);
      throw new Error(
        `O GitHub recusou o merge (talvez a revisão não esteja aprovada ou a branch precise de atualização). Detalhe: ${detalhe}`,
      );
    }
    await stopPreview(task.id);
    try {
      await removeEspaco(project, task.worktreePath);
    } catch {
      // melhor esforço — o espaço pode ser limpo depois (arquivar)
    }
  });
}

/**
 * Empurra os AJUSTES da revisão para o PR: commit (se houver mudança), push e
 * um comentário avisando o time. Usado pelo "Pedir para o Claude ajustar" e
 * pelo trabalho feito na conversa durante a Revisão.
 */
export function empurrarAjustesRevisao(task: Task, project: Project): Promise<void> {
  if (isFakeModelActive()) return Promise.resolve();
  return withProjectLock(project.id, async () => {
    const pendente = await git(task.worktreePath, "status", "--porcelain");
    if (pendente.length > 0) {
      await git(task.worktreePath, "add", "-A");
      await gitCommit(task.worktreePath, "Ajustes da revisão (via Inhouse)");
    }
    try {
      await git(task.worktreePath, "push");
    } catch (err) {
      const e = classificarErroGitHub(err, repoDaUrl(project.originUrl));
      throw new Error(e.tipo === "outro" ? `Não foi possível enviar os ajustes para o GitHub: ${e.detalhe}` : e.mensagem);
    }
    if (task.prUrl) {
      try {
        await run(
          "gh",
          ["pr", "comment", task.prUrl, "--body", "🤖 Ajustes da revisão aplicados pelo Inhouse — pronto para olhar de novo."],
          { cwd: task.worktreePath },
        );
      } catch {
        // comentário é cortesia; o push é o que importa
      }
    }
  });
}

/** Limpeza quando o TIME mergeou direto no GitHub (detectado pela sondagem). */
export async function limparAposMerge(task: Task, project: Project): Promise<void> {
  await stopPreview(task.id);
  if (isFakeModelActive()) return;
  try {
    await withProjectLock(project.id, () => removeEspaco(project, task.worktreePath));
  } catch {
    // melhor esforço
  }
}

/** Resultado de push + PR: o link, ou o motivo traduzido de não ter link. */
export interface ResultadoPR {
  prUrl?: string;
  erro?: ErroGitHub;
}

const RE_PR = /https:\/\/github\.com\/\S+\/pull\/\d+/;

/**
 * Empurra a branch da tarefa (do próprio espaço) e abre um PR — sem tocar o main.
 * Se o PR não abrir, tenta achar um PR já aberto para a branch (reenvio depois
 * de uma falha anterior); sem link, devolve o motivo em vez de engolir.
 */
async function publicarComoPR(task: Task, project: Project): Promise<ResultadoPR> {
  const repo = repoDaUrl(project.originUrl);
  try {
    await git(task.worktreePath, "push", "-u", "origin", task.branch);
  } catch (err) {
    const e = classificarErroGitHub(err, repo);
    throw new Error(
      e.tipo === "outro" ? `Não foi possível enviar a branch para o GitHub: ${e.detalhe}` : e.mensagem,
      { cause: err },
    );
  }
  let erroCriar: unknown;
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
    const m = RE_PR.exec(stdout);
    if (m) {
      sistema(task.id, `Pull request criado: ${m[0]}`);
      return { prUrl: m[0] };
    }
    erroCriar = new Error(`gh pr create não devolveu o link do PR: ${stdout.trim().slice(0, 200)}`);
  } catch (err) {
    erroCriar = err;
  }
  // Um PR para esta branch pode já existir (envio anterior que perdeu o link).
  try {
    const { stdout } = await run("gh", ["pr", "view", task.branch, "--json", "url,state", "--jq", 'select(.state=="OPEN") | .url'], {
      cwd: task.worktreePath,
    });
    const m = RE_PR.exec(stdout);
    if (m) {
      sistema(task.id, `Pull request já estava aberto: ${m[0]}`);
      return { prUrl: m[0] };
    }
  } catch {
    // sem PR aberto (ou gh indisponível): vale o erro do create
  }
  return { erro: classificarErroGitHub(erroCriar, repo) };
}
