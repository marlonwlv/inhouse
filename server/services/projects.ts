/**
 * Ciclo de vida de projetos: clonar do GitHub, criar de template, abrir pasta,
 * arquivar/desarquivar e excluir (com guardrails — ver deleteProject/exclusaoInfo).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExclusaoInfo, Project } from "../../shared/types.js";
import { ANEXOS_DIR, DATA_DIR, ESPACOS_DIR, PROJECTS_DIR, TRANSCRIPTS_DIR, claudeEnv, ensureDirs } from "../config.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";
import { forgetProject } from "../workflow/library.js";
import { withLimit } from "./limiter.js";
import { stopPreview } from "./preview.js";
import { git, gitCommit, lastLines, tryGit } from "./proc.js";
import { removeEspaco } from "./worktrees.js";

/** Templates embutidos vivem no repo do builder, ao lado de server/. */
const TEMPLATES_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

/** Instalações npm em background, rastreadas (não são detached; morrem com o server). */
const backgroundInstalls = new Set<ChildProcess>();
/** Install em andamento por projeto — para matar antes de excluir (senão recria a pasta). */
const installsPorProjeto = new Map<string, ChildProcess>();

async function detectDefaultBranch(repoPath: string): Promise<string> {
  const head = await tryGit(repoPath, "symbolic-ref", "refs/remotes/origin/HEAD");
  if (head) return head.replace("refs/remotes/origin/", "");
  const atual = await tryGit(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
  if (atual && atual !== "HEAD") return atual;
  return "main";
}

export async function cloneProject(url: string): Promise<Project> {
  ensureDirs();
  const limpo = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(limpo);
  } catch {
    throw new Error("Endereço inválido. Use um link como https://github.com/organizacao/repositorio.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("Só aceitamos repositórios do GitHub (link começando com https://github.com/).");
  }
  const segs = parsed.pathname.split("/").filter(Boolean);
  const repoSeg = segs[1];
  if (segs.length < 2 || !repoSeg) {
    throw new Error("O link precisa apontar para um repositório: https://github.com/organizacao/repositorio.");
  }
  const name = repoSeg.replace(/\.git$/, "");
  // Nome vira pasta em disco: só caracteres seguros (evita ../ e afins).
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") {
    throw new Error("O nome do repositório tem caracteres que não conseguimos usar. Fale com o time técnico.");
  }
  const target = join(PROJECTS_DIR, name);
  if (existsSync(target)) {
    throw new Error(`Já existe um projeto chamado "${name}" na pasta de projetos do Inhouse. Remova-o antes de baixar de novo.`);
  }

  try {
    await new Promise<void>((resolvePromise, reject) => {
      // GIT_TERMINAL_PROMPT=0: um link errado (ou repositório privado) faz o
      // GitHub pedir usuário/senha; sem isso o git ficaria travado para sempre
      // esperando um prompt que ninguém vê — e o request nunca responderia.
      const child = spawn("git", ["clone", "--progress", limpo, target], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let resto = "";
      let stderrAll = "";
      let ultimaMsg = "";
      let ultimoPct = -1;
      const emitir = (message: string, pct?: number) => {
        if (message === ultimaMsg && (pct ?? -1) === ultimoPct) return;
        ultimaMsg = message;
        ultimoPct = pct ?? -1;
        broadcast({ type: "project_progress", name, message, pct });
      };
      const lerLinha = (line: string) => {
        const rec = /Receiving objects:\s+(\d+)%/.exec(line);
        if (rec) return emitir("Baixando os arquivos do projeto…", Number(rec[1]));
        if (/Resolving deltas:/.test(line)) return emitir("Organizando o histórico do projeto…");
        if (/^Cloning into/.test(line)) return emitir("Começando o download…");
      };
      child.stderr?.on("data", (d: Buffer) => {
        const texto = String(d);
        stderrAll = lastLines(stderrAll + texto, 40);
        resto += texto;
        // git usa \r para reescrever a linha de progresso
        const partes = resto.split(/[\r\n]/);
        resto = partes.pop() ?? "";
        for (const p of partes) lerLinha(p);
      });
      child.on("error", (err) =>
        reject(new Error("Não foi possível rodar o git nesta máquina. Fale com o time técnico.", { cause: err })),
      );
      child.on("close", (code) => {
        if (code === 0) {
          resolvePromise();
        } else {
          reject(
            new Error("Não foi possível baixar o projeto do GitHub. Confira o link e sua conexão com a internet.", {
              cause: stderrAll,
            }),
          );
        }
      });
    });
  } catch (err) {
    // Não deixa clone pela metade travando uma nova tentativa.
    await rm(target, { recursive: true, force: true });
    throw err;
  }

  broadcast({ type: "project_progress", name, message: "Projeto baixado.", pct: 100 });

  const project: Project = {
    id: store.newId(),
    name,
    kind: "repo",
    path: target,
    originUrl: limpo,
    defaultBranch: await detectDefaultBranch(target),
    createdAt: new Date().toISOString(),
  };
  store.addProject(project);
  broadcast({ type: "project_updated", project });
  return project;
}

export async function createFromTemplate(name: string, template: string): Promise<Project> {
  ensureDirs();
  // Mesma normalização do slugify, mas sem o fallback "tarefa": nome vazio é erro.
  const slug = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
    throw new Error("Nome inválido. Use de 2 a 40 letras, números ou hífens (ex.: meu-app).");
  }
  if (!/^[a-z0-9-]+$/.test(template)) throw new Error("Modelo de app desconhecido.");
  const src = join(TEMPLATES_DIR, template);
  if (!existsSync(join(src, "package.json"))) throw new Error("Modelo de app desconhecido.");
  const dest = join(PROJECTS_DIR, slug);
  if (existsSync(dest)) {
    throw new Error(`Já existe um projeto chamado "${slug}". Escolha outro nome.`);
  }

  await cp(src, dest, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules",
  });

  // Personaliza o template com o nome do app.
  for (const f of ["package.json", "index.html"]) {
    const p = join(dest, f);
    if (existsSync(p)) {
      const conteudo = await readFile(p, "utf8");
      await writeFile(p, conteudo.replaceAll("__APP_NAME__", slug));
    }
  }

  try {
    await git(dest, "init");
    await git(dest, "add", "-A");
    await gitCommit(dest, "Projeto criado pelo Inhouse");
    await git(dest, "branch", "-m", "main");
  } catch (err) {
    throw new Error("Não foi possível preparar o controle de versões do projeto. Fale com o time técnico.", {
      cause: err,
    });
  }

  const project: Project = {
    id: store.newId(),
    name: slug,
    kind: "app",
    path: dest,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
  store.addProject(project);
  broadcast({ type: "project_updated", project });

  // Instala dependências em background (o usuário já vê o projeto na UI), atrás do
  // limitador GLOBAL de installs. fire-and-forget: não bloqueia o retorno.
  void withLimit("install", () => new Promise<void>((resolve) => {
    // Se o projeto foi excluído enquanto o install esperava na fila, não spawna
    // (senão recriaria a pasta que a exclusão apagou).
    if (!store.getProject(project.id)) return resolve();
    // claudeEnv(): scripts postinstall rodam código arbitrário — não podem ver
    // ANTHROPIC_API_KEY/AUTH_TOKEN (decisão 1 da arquitetura).
    const child = spawn("npm", ["install"], {
      cwd: dest,
      env: claudeEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    backgroundInstalls.add(child);
    installsPorProjeto.set(project.id, child);
    broadcast({
      type: "project_progress",
      projectId: project.id,
      name: slug,
      message: "Instalando dependências… isso pode levar alguns minutos.",
    });
    let stderrTail = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrTail = lastLines(stderrTail + String(d), 30);
    });
    const encerrar = (ok: boolean) => {
      backgroundInstalls.delete(child);
      installsPorProjeto.delete(project.id);
      broadcast({
        type: "project_progress",
        projectId: project.id,
        name: slug,
        message: ok ? "Pronto" : "A instalação das dependências falhou. O app pode não rodar — fale com o time técnico.",
      });
      resolve();
    };
    child.on("error", () => encerrar(false));
    child.on("close", (code) => encerrar(code === 0));
  }));

  return project;
}

/** Mata todos os npm installs em background (usado no shutdown — evita órfãos). */
export function killBackgroundInstalls(): void {
  for (const child of backgroundInstalls) {
    try {
      child.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }
  backgroundInstalls.clear();
  installsPorProjeto.clear();
}

/** `a` é o próprio `b` ou uma pasta dentro de `b`? */
function dentroDe(a: string, b: string): boolean {
  const rel = relative(b, a);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function openProject(path: string): Promise<Project> {
  ensureDirs();
  const alvo = resolve(path.trim());

  // Pasta pessoal (ou qualquer pasta acima dela, como "/"): abrir aqui faria
  // `git init` + `git add -A` engolir a pasta inteira do usuário — incluindo
  // chaves e segredos (~/.ssh etc.) — para dentro de um repositório. Nunca.
  if (dentroDe(homedir(), alvo)) {
    throw new Error(
      "Essa pasta é ampla demais (sua pasta pessoal ou uma acima dela). Escolha a pasta específica do projeto.",
    );
  }
  // Pastas internas do builder (espaços de tarefas, estado) não são projetos —
  // abri-las quebraria o ciclo de vida das tarefas.
  if (alvo === PROJECTS_DIR || dentroDe(alvo, ESPACOS_DIR) || dentroDe(alvo, DATA_DIR)) {
    throw new Error(
      "Essa pasta é usada internamente pelo Inhouse. Escolha a pasta de um projeto específico.",
    );
  }

  let st;
  try {
    st = await stat(alvo);
  } catch {
    throw new Error("Pasta não encontrada. Confira o caminho e tente de novo.");
  }
  if (!st.isDirectory()) throw new Error("O caminho informado não é uma pasta.");

  const jaAberto = store.listProjects().find((p) => p.path === alvo);
  if (jaAberto) throw new Error(`Esta pasta já está aberta como o projeto "${jaAberto.name}".`);

  const ehRepo = (await tryGit(alvo, "rev-parse", "--is-inside-work-tree")) === "true";
  if (!ehRepo) {
    try {
      await git(alvo, "init");
      await git(alvo, "add", "-A");
      // --allow-empty: a pasta pode estar vazia ou só com arquivos ignorados.
      await gitCommit(alvo, "Projeto aberto no Inhouse", ["--allow-empty"]);
      await git(alvo, "branch", "-m", "main");
    } catch (err) {
      throw new Error("Não foi possível preparar o controle de versões desta pasta. Fale com o time técnico.", {
        cause: err,
      });
    }
  }

  const originUrl = (await tryGit(alvo, "remote", "get-url", "origin")) ?? undefined;
  const project: Project = {
    id: store.newId(),
    name: basename(alvo),
    kind: "repo",
    path: alvo,
    defaultBranch: await detectDefaultBranch(alvo),
    createdAt: new Date().toISOString(),
    ...(originUrl ? { originUrl } : {}),
  };
  store.addProject(project);
  broadcast({ type: "project_updated", project });
  return project;
}

/**
 * A pasta do projeto é GERENCIADA pelo Inhouse (foi criada/baixada por nós, dentro
 * de PROJECTS_DIR) → podemos oferecer apagá-la do disco. Projeto "aberto no lugar"
 * (pasta que já era do usuário) fica fora daqui e NUNCA tem a pasta apagada.
 */
export function gerenciado(project: Project): boolean {
  const alvo = resolve(project.path);
  return dentroDe(alvo, PROJECTS_DIR) && alvo !== resolve(PROJECTS_DIR) && !dentroDe(alvo, ESPACOS_DIR);
}

/** Arquiva/desarquiva: some da grade principal e para os previews. Nada é apagado. */
export async function setArquivado(id: string, on: boolean): Promise<Project> {
  const project = store.getProject(id);
  if (!project) throw new Error("Projeto não encontrado.");
  if (on) {
    // Libera portas/processos dos previews; worktrees, branches e tarefas ficam.
    for (const t of store.listTasks().filter((t) => t.projectId === id)) {
      try {
        await stopPreview(t.id);
      } catch {
        // best-effort
      }
    }
  }
  const project2 = store.updateProject(id, { arquivadoEm: on ? new Date().toISOString() : undefined });
  broadcast({ type: "project_updated", project: project2 });
  return project2;
}

/** Impacto real de excluir — inspeciona o git de verdade para informar o usuário. */
export async function exclusaoInfo(id: string): Promise<ExclusaoInfo> {
  const project = store.getProject(id);
  if (!project) throw new Error("Projeto não encontrado.");
  const tasks = store.listTasks().filter((t) => t.projectId === id);
  const rodando = tasks.filter((t) => t.status === "rodando").length;
  const tarefasAtivas = tasks.filter((t) => t.status === "rodando" || t.status === "aguardando").length;
  const temRemoto = !!project.originUrl;

  const sujo = ((await tryGit(project.path, "status", "--porcelain")) ?? "").trim().length > 0;
  let commitsFrente = 0;
  if (temRemoto) {
    const c = await tryGit(project.path, "rev-list", "--count", `origin/${project.defaultBranch}..HEAD`);
    commitsFrente = c ? Number(c) || 0 : 0;
  }
  // Branches de tarefa (tarefa/*) = trabalho local que nunca foi publicado.
  const branchesRaw = await tryGit(project.path, "for-each-ref", "--format=%(refname:short)", "refs/heads/tarefa");
  const branchesTarefa = branchesRaw ? branchesRaw.split("\n").filter(Boolean).length : 0;

  return {
    projectId: id,
    name: project.name,
    gerenciado: gerenciado(project),
    path: project.path,
    temRemoto,
    rodando,
    tarefasAtivas,
    nTarefas: tasks.length,
    sujo,
    commitsFrente,
    branchesTarefa,
  };
}

/**
 * Exclui um projeto. Guardrails (autoritativos no servidor — nunca confiam no cliente):
 * - recusa se houver tarefa RODANDO (não mata o Claude no meio);
 * - a pasta principal (project.path) só é apagada se `apagarArquivos` E a pasta for
 *   GERENCIADA por nós — projeto "aberto no lugar" nunca tem a pasta do usuário apagada;
 * - sempre limpa o que é nosso: worktrees, previews, transcripts, anexos, override de workflow.
 */
export async function deleteProject(id: string, opts: { apagarArquivos?: boolean } = {}): Promise<void> {
  const project = store.getProject(id);
  if (!project) throw new Error("Projeto não encontrado.");
  const tasks = store.listTasks().filter((t) => t.projectId === id);
  if (tasks.some((t) => t.status === "rodando")) {
    throw new Error("Há uma tarefa em andamento neste projeto. Cancele ou espere terminar antes de excluir.");
  }
  const ehGerenciado = gerenciado(project);
  const apagarPasta = !!opts.apagarArquivos && ehGerenciado; // aberto no lugar: a flag é ignorada

  // 0. Mata um `npm install` inicial ainda em andamento — senão ele RECRIA a pasta
  //    depois do rm (corrida ao excluir um app recém-criado). Espera ele morrer.
  const inst = installsPorProjeto.get(id);
  if (inst) {
    installsPorProjeto.delete(id);
    await new Promise<void>((res) => {
      const done = () => res();
      inst.once("exit", done);
      inst.kill("SIGKILL");
      setTimeout(done, 1500); // não trava se o processo já tinha morrido
    });
  }

  // 1. Para os previews (portas/processos) de todas as tarefas.
  for (const t of tasks) {
    try {
      await stopPreview(t.id);
    } catch {
      // best-effort
    }
  }
  // 2. Remove os worktrees registrados — mantém o repo do usuário limpo mesmo quando
  //    NÃO apagamos a pasta principal (projeto aberto no lugar).
  for (const t of tasks) {
    if (t.worktreePath && dentroDe(t.worktreePath, ESPACOS_DIR) && resolve(t.worktreePath) !== resolve(project.path)) {
      try {
        await removeEspaco(project, t.worktreePath, { keepBranch: true });
      } catch {
        // best-effort
      }
    }
  }
  // 3. Limpa a pasta de espaços do projeto (abrigos .recuperar-*, sobras).
  const espacosDoProjeto = join(ESPACOS_DIR, project.name);
  if (dentroDe(espacosDoProjeto, ESPACOS_DIR) && resolve(espacosDoProjeto) !== resolve(ESPACOS_DIR)) {
    await rm(espacosDoProjeto, { recursive: true, force: true }).catch(() => {});
  }
  // 4. Apaga a pasta principal — SÓ gerenciada e a pedido. Guarda dupla contra "cagada".
  if (apagarPasta) {
    const alvo = resolve(project.path);
    const seguro = dentroDe(alvo, PROJECTS_DIR) && alvo !== resolve(PROJECTS_DIR) && !dentroDe(alvo, ESPACOS_DIR);
    if (!seguro) {
      throw new Error("Por segurança, o Inhouse não apaga esta pasta. Fale com o time técnico.");
    }
    await rm(alvo, { recursive: true, force: true });
  }
  // 5. Estado: remove projeto + tarefas (uma gravação); devolve as tarefas removidas.
  const removidas = store.removeProject(id);
  // 6. Transcripts + anexos das tarefas removidas (best-effort).
  for (const t of removidas) {
    await rm(join(TRANSCRIPTS_DIR, `${t.id}.jsonl`), { force: true }).catch(() => {});
    for (const a of t.anexos ?? []) {
      if (a.path && dentroDe(resolve(a.path), ANEXOS_DIR)) {
        await rm(a.path, { force: true }).catch(() => {});
      }
    }
  }
  // 7. Esquece o override de workflow do projeto.
  forgetProject(id);
  broadcast({ type: "project_removed", projectId: id });
}
