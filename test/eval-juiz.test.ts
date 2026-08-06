/**
 * Juiz do eval com runPhase mockado (padrão machine.test): gatilho automático,
 * lock, offline, falha sem escrever índice, e parse+dedupe dos aprendizados.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/types.js";

const h = vi.hoisted(() => ({
  runPhase: vi.fn(),
  claudeStatus: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../server/claude/runner.js", () => ({
  runPhase: h.runPhase,
  claudeStatus: h.claudeStatus,
}));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));

type Coleta = typeof import("../server/eval/coleta.js");
type Juiz = typeof import("../server/eval/juiz.js");
type Store = typeof import("../server/store.js");

const MD_OK = [
  "## Resumo executivo",
  "Metade das tarefas é cancelada.",
  "## Atritos ranqueados",
  '1. Cancelamentos no plano. "demorou demais"',
  "## Comparação com a análise anterior",
  "Sem análise anterior.",
  "## Recomendações",
  "- Reduzir skills no porte simples.",
  "```json",
  '{"aprendizados":[{"chave":"plano-lento","insight":"plano demora demais","severidade":4,"evidencia":"5/6 canceladas"}]}',
  "```",
].join("\n");

async function fresh(): Promise<{ coleta: Coleta; juiz: Juiz; store: Store; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-juiz-"));
  process.env.INHOUSE_DATA_DIR = dir;
  process.env.INHOUSE_PROJECTS_DIR = join(dir, "projects");
  process.env.INHOUSE_EVAL_A_CADA = "10";
  h.runPhase.mockReset();
  h.claudeStatus.mockReset();
  h.claudeStatus.mockResolvedValue({ ok: true });
  vi.resetModules();
  const store: Store = await import("../server/store.js");
  store.load();
  const coleta: Coleta = await import("../server/eval/coleta.js");
  const juiz: Juiz = await import("../server/eval/juiz.js");
  return { coleta, juiz, store, dir };
}

function terminais(store: Store, coleta: Coleta, n: number): void {
  for (let i = 0; i < n; i++) {
    const now = new Date().toISOString();
    const t: Task = store.addTask({
      id: store.newId(), projectId: "p", title: `t${i}`, description: "d",
      step: "concluida", status: "concluida", espaco: 1, branch: "b", worktreePath: "/tmp",
      gates: [], gateFixRounds: 0, createdAt: now, updatedAt: now,
    });
    coleta.registrarTarefaFinalizada(t.id, "concluida");
  }
}

/** Espera o gatilho fire-and-forget assentar (é async interno). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

describe("juiz do eval", () => {
  it("gatilho dispara com 10 finalizadas e escreve relatório + aprendizados", async () => {
    const { coleta, juiz } = await fresh();
    h.runPhase.mockResolvedValue({ success: true, finalText: MD_OK, metricas: { custoUsd: 0.1 } });
    terminais(await import("../server/store.js"), coleta, 10);
    juiz.verificarGatilhoAuto();
    await settle();
    expect(h.runPhase).toHaveBeenCalledTimes(1);
    expect(coleta.readJsonl(coleta.RELATORIOS_INDEX())).toHaveLength(1);
    const apr = coleta.readJsonl<{ chave: string; ocorrencias: number }>(coleta.APRENDIZADOS_FILE());
    expect(apr[0]?.chave).toBe("plano-lento");
    expect(apr[0]?.ocorrencias).toBe(1);
  });

  it("9 finalizadas NÃO disparam", async () => {
    const { coleta, juiz, store } = await fresh();
    h.runPhase.mockResolvedValue({ success: true, finalText: MD_OK });
    terminais(store, coleta, 9);
    juiz.verificarGatilhoAuto();
    await settle();
    expect(h.runPhase).not.toHaveBeenCalled();
  });

  it("Claude offline não dispara e não lança", async () => {
    const { coleta, juiz, store } = await fresh();
    h.claudeStatus.mockResolvedValue({ ok: false });
    terminais(store, coleta, 12);
    juiz.verificarGatilhoAuto();
    await settle();
    expect(h.runPhase).not.toHaveBeenCalled();
  });

  it("falha do juiz não escreve o índice (não gasta o gatilho)", async () => {
    const { coleta, juiz } = await fresh();
    h.runPhase.mockResolvedValue({ success: false, errorMessage: "erro" });
    const r = await juiz.gerarRelatorio("manual");
    expect(r.ok).toBe(false);
    expect(coleta.readJsonl(coleta.RELATORIOS_INDEX())).toHaveLength(0);
  });

  it("reincidência do mesmo aprendizado incrementa ocorrencias", async () => {
    const { coleta, juiz } = await fresh();
    h.runPhase.mockResolvedValue({ success: true, finalText: MD_OK });
    await juiz.gerarRelatorio("manual");
    await juiz.gerarRelatorio("manual");
    const apr = coleta
      .readJsonl<{ chave: string; ocorrencias: number }>(coleta.APRENDIZADOS_FILE())
      .filter((a) => a.chave === "plano-lento");
    expect(apr.at(-1)?.ocorrencias).toBe(2);
  });
});
