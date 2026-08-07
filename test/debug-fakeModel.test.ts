/**
 * Unit do modelo fake: prova que a classificação de fase está certa e que a
 * saída do fake é decodificada pelos MESMOS parsers que a máquina de estados usa
 * (parsePorte/parseUi/parsePrecisaDesign/parseVeredito/parsePreparado).
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunPhaseOpts } from "../server/claude/runner.js";
import type { DebugScenario } from "../server/debug/scenarios.js";

// Sem FS/SSE nos testes: broadcast e o transcript são no-op; getTask dá o título.
vi.mock("../server/events.js", () => ({ broadcast: () => {} }));
vi.mock("../server/store.js", () => ({
  transcriptAppend: () => {},
  getTask: (id: string) => ({ id, title: "Tarefa de teste" }),
}));

const { fakeRunPhase, fakeGateResults, bindTask, resetBindings } = await import("../server/debug/fakeModel.js");
const { parsePorte, parseUi, parsePrecisaDesign, parseVeredito, parsePreparado } = await import(
  "../server/workflow/phases.js"
);

function cenario(over: Partial<DebugScenario>): DebugScenario {
  return {
    id: "x",
    label: "X",
    descricao: "desc",
    porte: "media",
    ui: false,
    design: false,
    gates: "stub-pass",
    expectSteps: [],
    expectFinal: "concluida",
    ...over,
  };
}

function mkOpts(o: Pick<RunPhaseOpts, "permissionMode" | "prompt"> & Partial<RunPhaseOpts>): RunPhaseOpts {
  return { taskId: "t1", cwd: "/tmp", ...o };
}

beforeEach(() => resetBindings());

describe("fakeModel: classificação de fase", () => {
  it("espec (default) emite PORTE/UI/DESIGN legíveis pelos parsers reais", async () => {
    bindTask("t1", cenario({ porte: "grande", ui: true, design: true }));
    const r = await fakeRunPhase(mkOpts({ permissionMode: "default", prompt: "estruture o pedido" }));
    expect(r.success).toBe(true);
    expect(parsePorte(r.finalText)).toBe("grande");
    expect(parseUi(r.finalText)).toBe(true);
    expect(parsePrecisaDesign(r.finalText)).toBe(true);
  });

  it("plano (plan, sem barra) devolve planText + julgamento", async () => {
    bindTask("t1", cenario({ porte: "media", plan: "1. Passo um" }));
    const r = await fakeRunPhase(mkOpts({ permissionMode: "plan", prompt: "Com base na especificação, planeje" }));
    expect(r.planText).toContain("1. Passo um");
    expect(parsePorte(r.finalText)).toBe("media");
  });

  it("skill de plano (plan, com barra) é benigno e não vira plano", async () => {
    bindTask("t1", cenario({}));
    const r = await fakeRunPhase(mkOpts({ permissionMode: "plan", prompt: "/office-hours {spec}" }));
    expect(r.success).toBe(true);
    expect(r.planText).toBeUndefined();
  });

  it("preparação emite PREPARADO conforme o cenário", async () => {
    bindTask("t1", cenario({ prepPronto: true }));
    const ok = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "PREPARAR este projeto para uso" }));
    expect(parsePreparado(ok.finalText)).toBe(true);

    resetBindings();
    bindTask("t1", cenario({ prepPronto: false }));
    const nao = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "PREPARAR este projeto para uso" }));
    expect(parsePreparado(nao.finalText)).toBe(false);
  });

  it("protótipo grava o mockup onde a rota /mockup espera", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "fake-proto-"));
    bindTask("t1", cenario({}));
    const r = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "Agora faça um PROTÓTIPO VISUAL", cwd }));
    expect(r.filesTouched).toBe(true);
    expect(existsSync(join(cwd, "docs", "plans", "mockups", "tarefa-de-teste", "index.html"))).toBe(true);
  });

  it("skill-gate (acceptEdits, com barra) emite VEREDITO conforme o cenário", async () => {
    bindTask("t1", cenario({ skillGateVeredito: "reprovado" }));
    const reprova = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "/review\nVEREDITO?" }));
    expect(parseVeredito(reprova.finalText).ok).toBe(false);

    resetBindings();
    bindTask("t1", cenario({}));
    const aprova = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "/review\nVEREDITO?" }));
    expect(parseVeredito(aprova.finalText).ok).toBe(true);
  });

  it("execução (acceptEdits, sem barra) marca filesTouched", async () => {
    bindTask("t1", cenario({}));
    const r = await fakeRunPhase(mkOpts({ permissionMode: "acceptEdits", prompt: "O usuário aprovou o plano. Execute-o agora" }));
    expect(r.success).toBe(true);
    expect(r.filesTouched).toBe(true);
  });
});

describe("fakeModel: gates canned por cenário", () => {
  it("stub-pass passa; stub-fail-always falha; real delega (null)", () => {
    bindTask("a", cenario({ gates: "stub-pass" }));
    expect(fakeGateResults("a")?.[0]?.ok).toBe(true);

    bindTask("b", cenario({ gates: "stub-fail-always" }));
    expect(fakeGateResults("b")?.[0]?.ok).toBe(false);

    bindTask("c", cenario({ gates: "real" }));
    expect(fakeGateResults("c")).toBeNull();
  });

  it("stub-fail-once falha na 1ª passada e passa na 2ª (auto-correção)", () => {
    bindTask("d", cenario({ gates: "stub-fail-once" }));
    expect(fakeGateResults("d")?.[0]?.ok).toBe(false);
    expect(fakeGateResults("d")?.[0]?.ok).toBe(true);
  });
});
