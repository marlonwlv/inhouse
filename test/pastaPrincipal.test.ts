/**
 * Bug "ESTE PASSO FALHOU — Há alterações não salvas na pasta principal": a
 * preparação roda na pasta principal (npm install cria package-lock.json, copia
 * .env.example → .env.local) e o publish do app sem origin recusava para sempre.
 * Git de verdade: preparação + publicação passa; pasta suja por outro motivo
 * não perde nada e não entra em loop; .env nunca vai para o histórico.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../shared/types.js";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
vi.mock("../server/store.js", () => ({ transcriptAppend: vi.fn() }));
vi.mock("../server/services/preview.js", () => ({ stopPreview: async () => {} }));
vi.mock("../server/services/worktrees.js", () => ({ removeEspaco: async () => {} }));
vi.mock("../server/services/locks.js", () => ({ withProjectLock: (_id: string, fn: () => unknown) => fn() }));

type Proc = typeof import("../server/services/proc.js");
type Pasta = typeof import("../server/services/pastaPrincipal.js");
type Pub = typeof import("../server/services/publish.js");
let proc: Proc;
let pasta: Pasta;
let pub: Pub;
let base = "";
let n = 0;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "inhouse-pasta-"));
  proc = await import("../server/services/proc.js");
  pasta = await import("../server/services/pastaPrincipal.js");
  pub = await import("../server/services/publish.js");
});

/** App de template recém-criado: só node_modules/dist no .gitignore (como o app-starter). */
async function novoApp(): Promise<Project> {
  const dir = join(base, `app-${++n}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}\n');
  writeFileSync(join(dir, ".env.example"), "API_KEY=\n");
  writeFileSync(join(dir, "src", "App.tsx"), "export const t = 'oi';\n");
  await proc.git(dir, "init");
  await proc.git(dir, "add", "-A");
  await proc.gitCommit(dir, "Projeto criado pelo Inhouse");
  await proc.git(dir, "branch", "-m", "main");
  return { id: `p${n}`, name: "app", kind: "app", path: dir, defaultBranch: "main", createdAt: "x" };
}

/** O que a preparação faz de verdade na pasta principal. */
function simularPreparacao(dir: string): void {
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, ".env.local"), "API_KEY=segredo\n");
  writeFileSync(join(dir, ".env"), "API_KEY=segredo\n");
  mkdirSync(join(dir, "node_modules", "react"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "react", "index.js"), "x\n");
}

/** Uma tarefa num espaço (worktree) com uma mudança commitável. */
async function novaTarefa(project: Project, arquivo: string, conteudo: string): Promise<Task> {
  const id = `t${++n}`;
  const branch = `tarefa/${id}`;
  const wt = join(base, `espaco-${id}`);
  await proc.git(project.path, "worktree", "add", "-b", branch, wt, "main");
  writeFileSync(join(wt, arquivo), conteudo);
  return {
    id, projectId: project.id, title: `Tarefa ${id}`, description: "x", step: "publicar",
    status: "aguardando", espaco: n, branch, worktreePath: wt, gates: [], gateFixRounds: 0,
    createdAt: "x", updatedAt: "x",
  };
}

const status = (dir: string) => proc.git(dir, "status", "--porcelain", "--untracked-files=all");
const arquivosDoCommit = (dir: string, ref = "HEAD") =>
  proc.git(dir, "show", "--name-only", "--pretty=format:", ref).then((s) => s.split("\n").filter(Boolean));

describe("preparação deixa a pasta principal limpa", () => {
  it("commita o lockfile como 'Preparação do InHouse' e IGNORA .env (nunca commita segredo)", async () => {
    const p = await novoApp();
    simularPreparacao(p.path);
    const g = await pasta.guardarPendencias(p.path, "Preparação do InHouse");
    expect(g?.como).toBe("commit");
    expect(await status(p.path)).toBe("");
    expect(await proc.git(p.path, "log", "-1", "--pretty=%s")).toBe("Preparação do InHouse");
    const noCommit = await arquivosDoCommit(p.path);
    expect(noCommit).toContain("package-lock.json");
    expect(noCommit.some((f) => f.startsWith(".env"))).toBe(false);
    expect(noCommit.some((f) => f.startsWith("node_modules"))).toBe(false);
    // Segredos seguem no disco (o app precisa deles), só fora do histórico.
    expect(readFileSync(join(p.path, ".env.local"), "utf8")).toContain("segredo");
    // Ignorado só localmente: o .gitignore do projeto não foi tocado.
    expect(readFileSync(join(p.path, ".gitignore"), "utf8")).toBe("node_modules\ndist\n");
    expect(readFileSync(join(p.path, ".git", "info", "exclude"), "utf8")).toContain(pasta.MARCA_EXCLUDE);
  });

  it("idempotente: rodar de novo não duplica o bloco nem cria commit vazio", async () => {
    const p = await novoApp();
    simularPreparacao(p.path);
    await pasta.guardarPendencias(p.path, "Preparação do InHouse");
    const antes = await proc.git(p.path, "rev-parse", "HEAD");
    expect(await pasta.guardarPendencias(p.path, "Preparação do InHouse")).toBeNull();
    expect(await proc.git(p.path, "rev-parse", "HEAD")).toBe(antes);
    const ex = readFileSync(join(p.path, ".git", "info", "exclude"), "utf8");
    expect(ex.split(pasta.MARCA_EXCLUDE).length - 1).toBe(1);
  });
});

describe("publicar (app sem origin) nunca vira beco sem saída", () => {
  it("preparação criou .env e mudou o lockfile (sem arrumação prévia) → publicação passa", async () => {
    const p = await novoApp();
    simularPreparacao(p.path); // projetos já preparados antes da correção
    const t = await novaTarefa(p, "src/App.tsx", "export const t = 'novo título';\n");
    await expect(pub.publishTask(t, p, false)).resolves.toEqual({});
    expect(readFileSync(join(p.path, "src", "App.tsx"), "utf8")).toContain("novo título");
    expect(await status(p.path)).toBe("");
    expect(existsSync(join(p.path, ".env.local"))).toBe(true);
    const log = await proc.git(p.path, "log", "--pretty=%s");
    expect(log).toContain("Alterações pendentes da pasta principal");
    // Nenhum commit do histórico carrega .env.
    const tudo = await proc.git(p.path, "log", "--name-only", "--pretty=format:");
    expect(tudo.split("\n").some((f) => /^\.env(\.local)?$/.test(f))).toBe(false);
  });

  it("pasta suja por outro motivo (edição à mão + arquivo novo): não perde nada e não entra em loop", async () => {
    const p = await novoApp();
    writeFileSync(join(p.path, "package.json"), '{"name":"app","editado":"a mão"}\n');
    writeFileSync(join(p.path, "notas.txt"), "minhas notas\n");
    const t1 = await novaTarefa(p, "src/Novo.tsx", "export const a = 1;\n");
    await pub.publishTask(t1, p, false);
    // As alterações da pessoa estão intactas no disco E guardadas no histórico.
    expect(readFileSync(join(p.path, "package.json"), "utf8")).toContain("a mão");
    expect(readFileSync(join(p.path, "notas.txt"), "utf8")).toBe("minhas notas\n");
    const guardado = await proc.git(p.path, "log", "--grep=Alterações pendentes", "--pretty=%H");
    expect(await arquivosDoCommit(p.path, guardado)).toEqual(expect.arrayContaining(["package.json", "notas.txt"]));
    expect(existsSync(join(p.path, "src", "Novo.tsx"))).toBe(true);
    // Sem loop: a próxima publicação passa de primeira.
    writeFileSync(join(p.path, "notas.txt"), "mais notas\n");
    const t2 = await novaTarefa(p, "src/Outro.tsx", "export const b = 2;\n");
    await expect(pub.publishTask(t2, p, false)).resolves.toEqual({});
    expect(readFileSync(join(p.path, "notas.txt"), "utf8")).toBe("mais notas\n");
    expect(await status(p.path)).toBe("");
  });

  it("HEAD solto: guarda num stash nomeado (recuperável) em vez de commitar no vazio", async () => {
    const p = await novoApp();
    await proc.git(p.path, "checkout", "--detach");
    writeFileSync(join(p.path, "notas.txt"), "importante\n");
    const g = await pasta.guardarPendencias(p.path, "teste");
    expect(g?.como).toBe("stash");
    expect(await proc.git(p.path, "stash", "list")).toContain("Inhouse: teste");
    expect(await status(p.path)).toBe("");
  });
});
