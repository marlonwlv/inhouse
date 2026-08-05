/**
 * Testes de worktrees com git de verdade: espaço reutilizado com título repetido
 * (branch já existe) ganha sufixo em vez de destruir o histórico antigo, e
 * trabalho não commitado do espaço anterior é preservado no branch antigo.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
