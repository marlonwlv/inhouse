/**
 * Biblioteca de workflows: presets, CRUD de customs, ativo por projeto/global,
 * resolução do config ativo e catálogo de skills.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Lib = typeof import("../server/workflow/library.js");

async function fresh(): Promise<Lib> {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-lib-"));
  process.env.INHOUSE_DATA_DIR = dir;
  process.env.INHOUSE_PROJECTS_DIR = join(dir, "projects");
  vi.resetModules();
  return import("../server/workflow/library.js");
}

describe("biblioteca de workflows", () => {
  let lib: Lib;
  beforeEach(async () => {
    lib = await fresh();
  });

  it("começa com os 3 presets e Padrão como global", () => {
    const s = lib.getState();
    expect(s.workflows.map((w) => w.id).sort()).toEqual(["completo", "padrao", "rapido"]);
    expect(s.workflows.every((w) => w.builtin)).toBe(true);
    expect(s.globalAtivo).toBe("padrao");
  });

  it("activeConfig resolve o Padrão (com office-hours/review) e o Rápido (vazio)", () => {
    // sem projeto → global (padrao)
    const padrao = lib.activeConfig();
    expect(JSON.stringify(padrao.skills)).toContain("office-hours");
    expect(JSON.stringify(padrao.skills)).toContain("review");
    // um projeto apontando para "rapido" → skills vazias
    lib.setActive("rapido", "proj-x");
    const rapido = lib.activeConfig("proj-x");
    expect(rapido.skills).toEqual({});
    // outro projeto sem escolha → ainda global (padrao)
    expect(JSON.stringify(lib.activeConfig("proj-y").skills)).toContain("office-hours");
  });

  it("cria, ativa por projeto e persiste um workflow customizado", () => {
    const novo = lib.upsertWorkflow({
      name: "Meu fluxo",
      skills: { verificacoes: [{ skill: "review" }, { skill: "security-review" }] },
    });
    expect(novo.id).toBeTruthy();
    expect(novo.builtin).toBeUndefined();
    lib.setActive(novo.id, "proj-z");
    expect(lib.activeWorkflowId("proj-z")).toBe(novo.id);
    const cfg = lib.activeConfig("proj-z");
    expect(cfg.skills?.verificacoes?.map((s) => s.skill)).toEqual(["review", "security-review"]);
    // sobrevive a um reload (novo import lê o arquivo)
    lib._reset();
    expect(lib.getState().workflows.some((w) => w.id === novo.id)).toBe(true);
  });

  it("editar um preset é recusado; excluir um custom devolve os projetos ao Padrão", () => {
    expect(() => lib.upsertWorkflow({ id: "padrao", name: "hack", skills: {} })).toThrow(/preset/i);
    const c = lib.upsertWorkflow({ name: "Temp", skills: {} });
    lib.setActive(c.id, "proj-a");
    lib.setActive(c.id); // global também
    lib.deleteWorkflow(c.id);
    expect(lib.getState().globalAtivo).toBe("padrao");
    expect(lib.activeWorkflowId("proj-a")).toBe("padrao");
    expect(() => lib.deleteWorkflow("padrao")).toThrow(/preset/i);
  });

  it("catálogo lista skills com fase e flag de instalada", () => {
    const cat = lib.skillCatalog();
    expect(cat.some((c) => c.skill === "office-hours" && c.fase === "plano_produto")).toBe(true);
    expect(cat.some((c) => c.skill === "review" && c.fase === "verificacoes")).toBe(true);
    // security-review é built-in → sempre instalada
    expect(cat.find((c) => c.skill === "security-review")?.instalada).toBe(true);
  });
});
