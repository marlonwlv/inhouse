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
  const state = { calls: [] as { fn: string; cwd: string; args: string[] }[], mainSujo: false, ghPrOut: "",
    pushErr: "", prCreateErr: "", prViewOut: "", prViewErr: "" };
  return { RunError, state };
});

vi.mock("../server/services/proc.js", () => ({
  RunError: h.RunError,
  git: async (cwd: string, ...args: string[]) => {
    h.state.calls.push({ fn: "git", cwd, args });
    if (args[0] === "status") return h.state.mainSujo && cwd.includes("main") ? " M arquivo.ts" : "";
    if (args[0] === "rev-parse") return "main";
    if (args[0] === "push" && h.state.pushErr) throw new h.RunError("", h.state.pushErr);
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
    if (args[1] === "create" && h.state.prCreateErr) throw new h.RunError("", h.state.prCreateErr);
    if (args[1] === "view") {
      if (h.state.prViewErr) throw new h.RunError("", h.state.prViewErr);
      return { stdout: h.state.prViewOut, stderr: "" };
    }
    return { stdout: h.state.ghPrOut, stderr: "" };
  },
}));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));
vi.mock("../server/store.js", () => ({ transcriptAppend: () => {} }));
vi.mock("../server/services/preview.js", () => ({ stopPreview: async () => {} }));
vi.mock("../server/services/worktrees.js", () => ({ removeEspaco: async () => {} }));
vi.mock("../server/services/locks.js", () => ({ withProjectLock: (_id: string, fn: () => unknown) => fn() }));

import { classificarErroGitHub, repoDaUrl } from "../server/services/githubErro.js";
import { enviarParaRevisao, publishTask } from "../server/services/publish.js";

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

afterEach(() => {
  h.state.calls = []; h.state.mainSujo = false; h.state.ghPrOut = "";
  h.state.pushErr = ""; h.state.prCreateErr = ""; h.state.prViewOut = ""; h.state.prViewErr = "";
});

describe("publishTask — segurança", () => {
  it("repo com origin: PR-only — empurra a branch + gh pr create, NUNCA faz merge no main", async () => {
    h.state.ghPrOut = "https://github.com/example/repo/pull/42\n";
    const r = await publishTask(task(), project("https://github.com/example/repo.git"), true);
    expect(r.prUrl).toBe("https://github.com/example/repo/pull/42");
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

describe("enviarParaRevisao — o PR não pode sumir em silêncio", () => {
  const origin = "https://github.com/acme/app.git";

  it("PR criado: devolve o link (é ele que mostra o Ver no GitHub e liga a sondagem)", async () => {
    h.state.ghPrOut = "https://github.com/acme/app/pull/7\n";
    expect(await enviarParaRevisao(task(), project(origin))).toEqual({ prUrl: "https://github.com/acme/app/pull/7" });
  });

  it("PR já aberto para a branch (reenvio): recupera o link em vez de ficar sem", async () => {
    h.state.prCreateErr = 'a pull request for branch "tarefa/x-1" into branch "main" already exists:\nhttps://github.com/acme/app/pull/9';
    h.state.prViewOut = "https://github.com/acme/app/pull/9\n";
    const r = await enviarParaRevisao(task(), project(origin));
    expect(r.prUrl).toBe("https://github.com/acme/app/pull/9");
    expect(r.erro).toBeUndefined();
  });

  it("gh sem login: sem link, com o motivo traduzido", async () => {
    h.state.prCreateErr = "To get started with GitHub CLI, please run:  gh auth login";
    h.state.prViewErr = "To get started with GitHub CLI, please run:  gh auth login";
    const r = await enviarParaRevisao(task(), project(origin));
    expect(r.prUrl).toBeUndefined();
    expect(r.erro?.tipo).toBe("sem_login");
  });

  it("push sem permissão de escrita: erro claro dizendo o repo e o que pedir", async () => {
    h.state.pushErr = "remote: Permission to acme/app.git denied to italo.\nfatal: unable to access 'https://github.com/acme/app.git/': The requested URL returned error: 403";
    await expect(enviarParaRevisao(task(), project(origin))).rejects.toThrow(/permissão de escrita no repositório acme\/app.*Write/);
  });
});

describe("classificarErroGitHub", () => {
  it("reconhece gh ausente, sem login, sem permissão e o resto", () => {
    expect(classificarErroGitHub(new Error("spawn gh ENOENT")).tipo).toBe("sem_gh");
    expect(classificarErroGitHub(new Error("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).tipo).toBe("sem_login");
    expect(classificarErroGitHub(new Error("HTTP 401: Bad credentials")).tipo).toBe("sem_login");
    expect(classificarErroGitHub(new Error("pull request create failed: GraphQL: must be a collaborator (createPullRequest)")).tipo).toBe("sem_permissao");
    expect(classificarErroGitHub(new Error("ERROR: Write access to repository not granted.")).tipo).toBe("sem_permissao");
    expect(classificarErroGitHub(new Error("Could not resolve host: github.com")).tipo).toBe("outro");
  });

  it("repoDaUrl entende https e ssh", () => {
    expect(repoDaUrl("https://github.com/marlonwlv/inhouse.git")).toBe("marlonwlv/inhouse");
    expect(repoDaUrl("git@github.com:marlonwlv/inhouse.git")).toBe("marlonwlv/inhouse");
    expect(repoDaUrl("https://gitlab.com/x/y")).toBeNull();
  });
});
