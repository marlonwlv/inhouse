/**
 * Testes de worktrees com git de verdade: espaço reutilizado com título repetido
 * (branch já existe) ganha sufixo em vez de destruir o histórico antigo, e
 * trabalho não commitado do espaço anterior é preservado no branch antigo.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "../shared/types.js";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));

type WorktreesModule = typeof import("../server/services/worktrees.js");
type ProcModule = typeof import("../server/services/proc.js");

let worktrees: WorktreesModule;
let proc: ProcModule;
let repo = "";
let project: Project;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-worktrees-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
  worktrees = await import("../server/services/worktrees.js");
  proc = await import("../server/services/proc.js");

  repo = join(base, "repo");
  mkdirSync(repo, { recursive: true });
  await proc.git(repo, "init");
  writeFileSync(join(repo, "a.txt"), "conteudo inicial\n");
  await proc.git(repo, "add", "-A");
  await proc.gitCommit(repo, "commit inicial");
  await proc.git(repo, "branch", "-m", "main");

  project = {
    id: "p1",
    name: "demo",
    kind: "repo",
    path: repo,
    defaultBranch: "main",
    createdAt: "2026-08-05T12:00:00.000Z",
  };
});

describe("createEspaco", () => {
  it("espaço reutilizado com o mesmo título: branch ganha sufixo e trabalho pendente é preservado", async () => {
    const r1 = await worktrees.createEspaco(project, 1, "botao");
    expect(r1.branch).toBe("tarefa/botao-1");
    expect(existsSync(r1.worktreePath)).toBe(true);

    // Tarefa "cancelada no meio": sobra trabalho não commitado no espaço.
    writeFileSync(join(r1.worktreePath, "novo.txt"), "trabalho da tarefa antiga\n");

    // Nova tarefa, mesmo título, mesmo número de espaço (retry de tarefa recriada).
    const r2 = await worktrees.createEspaco(project, 1, "botao");
    expect(r2.worktreePath).toBe(r1.worktreePath);
    // O branch antigo existe → o novo ganha sufixo em vez de colidir/destruir.
    expect(r2.branch).toBe("tarefa/botao-1-2");

    // O trabalho não commitado foi preservado num commit do branch antigo…
    const msg = await proc.git(repo, "log", "-1", "--format=%s", "tarefa/botao-1");
    expect(msg).toMatch(/preservado/i);
    // …e o espaço novo nasce limpo a partir do main.
    expect(existsSync(join(r2.worktreePath, "novo.txt"))).toBe(false);
    expect(existsSync(join(r2.worktreePath, "a.txt"))).toBe(true);
  });
});

describe("createEspaco — salvaguarda: não destrói trabalho não preservado", () => {
  it("commit de preservação falha → move o espaço para .recuperar-* e cria um novo limpo, sem apagar nada", async () => {
    const base = mkdtempSync(join(tmpdir(), "inhouse-worktrees-abrigo-"));
    const repo2 = join(base, "repo");
    mkdirSync(repo2, { recursive: true });
    await proc.git(repo2, "init");
    writeFileSync(join(repo2, "a.txt"), "inicial\n");
    await proc.git(repo2, "add", "-A");
    await proc.gitCommit(repo2, "commit inicial");
    await proc.git(repo2, "branch", "-m", "main");

    // Hook que reprova QUALQUER commit → a preservação automática vai falhar,
    // simulando o cenário em que o trabalho não pode ser guardado sozinho.
    const hook = join(repo2, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);

    const proj2: Project = {
      id: "p2",
      name: "abrigo",
      kind: "repo",
      path: repo2,
      defaultBranch: "main",
      createdAt: "2026-08-05T12:00:00.000Z",
    };

    const r1 = await worktrees.createEspaco(proj2, 1, "x");
    // Trabalho não commitado que o commit de preservação NÃO conseguirá salvar.
    writeFileSync(join(r1.worktreePath, "novo.txt"), "trabalho a nao perder\n");

    // Reusa o mesmo número de espaço: a limpeza do espaço antigo é acionada.
    const r2 = await worktrees.createEspaco(proj2, 1, "x");

    // O espaço novo nasce no MESMO caminho, limpo a partir do main…
    expect(r2.worktreePath).toBe(r1.worktreePath);
    expect(existsSync(join(r2.worktreePath, "a.txt"))).toBe(true);
    expect(existsSync(join(r2.worktreePath, "novo.txt"))).toBe(false);

    // …e o trabalho não preservado foi MOVIDO para o lado, não apagado.
    const irmaos = readdirSync(dirname(r1.worktreePath));
    const abrigo = irmaos.find((n) => n.startsWith("espaco-1.recuperar-"));
    expect(abrigo).toBeDefined();
    expect(existsSync(join(dirname(r1.worktreePath), abrigo!, "novo.txt"))).toBe(true);
  });
});

describe("removeEspaco — salvaguarda do checkout principal", () => {
  it("NUNCA remove quando worktreePath é o próprio project.path (não apaga o projeto)", async () => {
    // Cenário da tarefa de preparação: worktreePath === project.path.
    await worktrees.removeEspaco(project, project.path, { keepBranch: true });
    // O checkout principal e seus arquivos continuam intactos.
    expect(existsSync(project.path)).toBe(true);
    expect(existsSync(join(project.path, "a.txt"))).toBe(true);
  });
});
