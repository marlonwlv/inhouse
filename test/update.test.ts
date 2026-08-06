/**
 * Aviso de versão nova (via git), com o proc mockado: detecta commits atrás,
 * degrada quando não é clone git, e recusa atualizar com a árvore suja.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class RunError extends Error {
    constructor(public stdout = "", public stderr = "") {
      super(stderr || "run error");
    }
  }
  const state = { isRepo: true, hasOrigin: true, dirty: false, atras: 0, pullFails: false, calls: [] as string[][] };
  return { RunError, state };
});

vi.mock("../server/services/proc.js", () => ({
  RunError: h.RunError,
  tryGit: async (_cwd: string, ...args: string[]) => {
    h.state.calls.push(args);
    // ehRepoInhouse compara o show-toplevel com o REPO_ROOT (a raiz do repo = cwd do vitest).
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return h.state.isRepo ? process.cwd() : null;
    if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") return h.state.isRepo ? "true" : null;
    if (args[0] === "remote" && args[1] === "get-url") return h.state.hasOrigin ? "https://github.com/x/y.git" : null;
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return "main";
    if (args[0] === "status") return h.state.dirty ? " M arquivo.ts" : "";
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-list") return String(h.state.atras);
    return "";
  },
  git: async (_cwd: string, ...args: string[]) => {
    h.state.calls.push(args);
    if (args[0] === "pull" && h.state.pullFails) throw new h.RunError("", "Automatic merge failed");
    return "";
  },
}));

import { aplicarUpdate, checarUpdate } from "../server/services/update.js";

afterEach(() => {
  Object.assign(h.state, { isRepo: true, hasOrigin: true, dirty: false, atras: 0, pullFails: false });
  h.state.calls = [];
});

describe("checarUpdate", () => {
  it("clone git com commits atrás → disponível", async () => {
    h.state.atras = 3;
    expect(await checarUpdate()).toMatchObject({ suportado: true, disponivel: true, atras: 3 });
  });

  it("em dia → não disponível", async () => {
    h.state.atras = 0;
    expect((await checarUpdate()).disponivel).toBe(false);
  });

  it("não é clone git → não suportado (degrada em silêncio)", async () => {
    h.state.isRepo = false;
    const u = await checarUpdate();
    expect(u.suportado).toBe(false);
    expect(u.disponivel).toBe(false);
  });

  it("sem origin → não suportado", async () => {
    h.state.hasOrigin = false;
    expect((await checarUpdate()).suportado).toBe(false);
  });
});

describe("aplicarUpdate", () => {
  it("árvore suja → recusa e NÃO faz pull (não engole alterações locais)", async () => {
    h.state.dirty = true;
    const r = await aplicarUpdate();
    expect(r.ok).toBe(false);
    expect(r.mensagem).toMatch(/alterações locais/i);
    expect(h.state.calls.some((c) => c[0] === "pull")).toBe(false);
  });

  it("árvore limpa → git pull --ff-only e pede reiniciar", async () => {
    const r = await aplicarUpdate();
    expect(r.ok).toBe(true);
    expect(r.mensagem).toMatch(/feche e abra/i);
    expect(h.state.calls.some((c) => c[0] === "pull" && c.includes("--ff-only"))).toBe(true);
  });

  it("pull falha → devolve erro amigável, não lança", async () => {
    h.state.pullFails = true;
    const r = await aplicarUpdate();
    expect(r.ok).toBe(false);
  });
});
