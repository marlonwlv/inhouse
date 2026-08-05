/**
 * Ciclo de vida de projetos: clonar do GitHub, criar de template, abrir pasta.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../../shared/types.js";
import { DATA_DIR, ESPACOS_DIR, PROJECTS_DIR, claudeEnv, ensureDirs } from "../config.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";
import { git, gitCommit, lastLines, tryGit } from "./proc.js";

/** Templates embutidos vivem no repo do builder, ao lado de server/. */
const TEMPLATES_DIR = fileURLToPath(new URL("../../templates", import.meta.url));

/** Instalações npm em background, rastreadas (não são detached; morrem com o server). */
const backgroundInstalls = new Set<ChildProcess>();

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

  // Instala dependências em background: o usuário já pode ver o projeto na UI.
  // claudeEnv(): scripts postinstall rodam código arbitrário — não podem ver
  // ANTHROPIC_API_KEY/AUTH_TOKEN (decisão 1 da arquitetura).
  const child = spawn("npm", ["install"], {
    cwd: dest,
    env: claudeEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  backgroundInstalls.add(child);
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
    broadcast({
      type: "project_progress",
      projectId: project.id,
      name: slug,
      message: ok ? "Pronto" : "A instalação das dependências falhou. O app pode não rodar — fale com o time técnico.",
    });
  };
  child.on("error", () => encerrar(false));
  child.on("close", (code) => encerrar(code === 0));

  return project;
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
