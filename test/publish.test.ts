/**
 * Segurança do publish: repo com origin = PR-only (não toca o main);
 * app de template com main sujo = recusa (não engole trabalho).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../shared/types.js";

const h = vi.hoisted(() => {
  class RunError extends Error {
    constructor(public stdout = "", public stderr = "") {
      super(stderr || "run error");
    }
  }
  const state = { calls: [] as { fn: string; cwd: string; args: string[] }[], mainSujo: false, ghPrOut: "" };
  return { RunError, state };
});

vi.mock("../server/services/proc.js", () => ({
  RunError: h.RunError,
  git: async (cwd: string, ...args: string[]) => {
    h.state.calls.push({ fn: "git", cwd, args });
    if (args[0] === "status") return h.state.mainSujo && cwd.includes("main") ? " M arquivo.ts" : "";
    if (args[0] === "rev-parse") return "main";
    return "";
  },
  tryGit: async (cwd: string, ...args: string[]) => {
    h.state.calls.push({ fn: "tryGit", cwd, args });
    return "main";
  },
  gitCommit: async (cwd: string, msg: string) => {
    h.state.calls.push({ fn: "gitCommit", cwd, args: [msg] });
  },
  run: async (cmd: string, args: string[], opts: { cwd: string }) => {
    h.state.calls.push({ fn: cmd, cwd: opts.cwd, args });
    return { stdout: h.state.ghPrOut, stderr: "" };
  },
}));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));
vi.mock("../server/store.js", () => ({ transcriptAppend: () => {} }));
vi.mock("../server/services/preview.js", () => ({ stopPreview: async () => {} }));
vi.mock("../server/services/worktrees.js", () => ({ removeEspaco: async () => {} }));
vi.mock("../server/services/locks.js", () => ({ withProjectLock: (_id: string, fn: () => unknown) => fn() }));

import { publishTask } from "../server/services/publish.js";

function task(): Task {
  return {
    id: "t1", projectId: "p1", title: "Trocar título", description: "trocar",
    step: "publicar", status: "aguardando", espaco: 1, branch: "tarefa/x-1",
    worktreePath: "/tmp/espacos/x", gates: [], gateFixRounds: 0,
    createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
  };
}
function project(originUrl?: string): Project {
  return { id: "p1", name: "proj", kind: originUrl ? "repo" : "app", path: "/tmp/main", defaultBranch: "main", createdAt: "x", ...(originUrl ? { originUrl } : {}) };
}

afterEach(() => { h.state.calls = []; h.state.mainSujo = false; h.state.ghPrOut = ""; });

describe("publishTask — segurança", () => {
  it("repo com origin: PR-only — empurra a branch + gh pr create, NUNCA faz merge no main", async () => {
    h.state.ghPrOut = "https://github.com/sua-org/seu-repo/pull/42\n";
    const r = await publishTask(task(), project("https://github.com/sua-org/seu-repo.git"), true);
    expect(r.prUrl).toBe("https://github.com/sua-org/seu-repo/pull/42");
    const push = h.state.calls.find((c) => c.args[0] === "push");
    expect(push?.cwd).toBe("/tmp/espacos/x"); // empurra do espaço, não do main
    expect(h.state.calls.some((c) => c.fn === "gh" && c.args[0] === "pr")).toBe(true);
    // NADA toca o main: sem merge, sem checkout no /tmp/main.
    expect(h.state.calls.some((c) => c.args.includes("merge"))).toBe(false);
    expect(h.state.calls.some((c) => c.cwd === "/tmp/main")).toBe(false);
  });

  it("app sem origin com main sujo: RECUSA (não auto-commita, não engole trabalho)", async () => {
    h.state.mainSujo = true;
    await expect(publishTask(task(), project(), false)).rejects.toThrow(/não salvas/i);
    // Não deve ter commitado nada no main.
    expect(h.state.calls.some((c) => c.fn === "gitCommit" && c.cwd === "/tmp/main")).toBe(false);
  });

  it("app sem origin com main limpo: faz merge --no-ff no main local", async () => {
    await publishTask(task(), project(), false);
    expect(h.state.calls.some((c) => c.args.includes("merge") && c.cwd === "/tmp/main")).toBe(true);
  });
});
