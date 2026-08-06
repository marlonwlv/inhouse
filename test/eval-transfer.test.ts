/**
 * Export/import do eval entre máquinas (coleta dos dados de quem testa):
 * marca a origem (fonte), é idempotente, filtra o resumo por origem e o export
 * só leva os dados locais desta máquina.
 */
import { appendFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RegistroTarefa } from "../server/eval/registro.js";

type Transfer = typeof import("../server/eval/transfer.js");
type Resumo = typeof import("../server/eval/resumo.js");
type Coleta = typeof import("../server/eval/coleta.js");
type Config = typeof import("../server/config.js");

async function fresh(): Promise<{ transfer: Transfer; resumo: Resumo; coleta: Coleta; config: Config }> {
  const dataDir = mkdtempSync(join(tmpdir(), "inhouse-transfer-"));
  process.env.INHOUSE_DATA_DIR = dataDir;
  process.env.INHOUSE_PROJECTS_DIR = join(dataDir, "projects");
  vi.resetModules();
  const store = await import("../server/store.js");
  store.load();
  const config: Config = await import("../server/config.js");
  config.ensureDirs();
  return {
    transfer: await import("../server/eval/transfer.js"),
    resumo: await import("../server/eval/resumo.js"),
    coleta: await import("../server/eval/coleta.js"),
    config,
  };
}

function tarefa(taskId: string, extra: Partial<RegistroTarefa> = {}): RegistroTarefa {
  return {
    v: 1,
    ts: "2026-08-01T00:00:00.000Z",
    taskId,
    projectId: "p1",
    titulo: "Trocar título",
    desfecho: "concluida",
    criadaEm: "2026-08-01T00:00:00.000Z",
    duracaoTotalMs: 1000,
    etapas: [{ step: "execucao", ms: 1000 }],
    esperaHumanaMs: 0,
    msMaquina: 1000,
    gates: [],
    gateFixRounds: 0,
    pedidosMudanca: [],
    itensTranscript: { user: 1, assistant: 1, tool: 0, system: 0 },
    ...extra,
  };
}

function bundleDe(tarefas: RegistroTarefa[]): unknown {
  return {
    v: 1,
    geradoEm: "2026-08-02T00:00:00.000Z",
    origem: { label: "maria" },
    tarefas,
    permissoes: [],
    feedback: [{ v: 1, ts: "2026-08-01T00:00:01.000Z", taskId: tarefas[0]?.taskId ?? "x", nota: "otimo" }],
    aprendizados: [{ v: 1, ts: "2026-08-01T00:00:02.000Z", chave: "k1", insight: "algo", severidade: 5, ocorrencias: 2 }],
    relatorios: [],
  };
}

describe("importarBundle", () => {
  it("marca a origem, alimenta o resumo por fonte e não conta em 'meus'", async () => {
    const { transfer, resumo } = await fresh();
    const r = transfer.importarBundle(bundleDe([tarefa("a1"), tarefa("a2")]), "maria");
    expect(r.importados).toBe(4); // 2 tarefas + 1 feedback + 1 aprendizado
    expect(r.pulados).toBe(0);

    const maria = resumo.calcularResumo("maria");
    expect(maria.concluidas).toBe(2);
    expect(maria.feedback.otimo).toBe(1);
    expect(maria.aprendizados).toHaveLength(1);

    const meus = resumo.calcularResumo("meus");
    expect(meus.concluidas).toBe(0);

    expect(transfer.fontesDisponiveis()).toEqual(["maria"]);
  });

  it("é idempotente: reimportar o mesmo bundle não duplica", async () => {
    const { transfer, resumo } = await fresh();
    transfer.importarBundle(bundleDe([tarefa("a1")]), "maria");
    const segundo = transfer.importarBundle(bundleDe([tarefa("a1")]), "maria");
    expect(segundo.importados).toBe(0);
    expect(segundo.pulados).toBe(3); // 1 tarefa + 1 feedback + 1 aprendizado já existiam
    expect(resumo.calcularResumo("maria").concluidas).toBe(1);
  });

  it("recusa fonte vazia? (a rota valida) — aqui usa 'import' como rótulo padrão", async () => {
    const { transfer } = await fresh();
    transfer.importarBundle(bundleDe([tarefa("a1")]), "   ");
    expect(transfer.fontesDisponiveis()).toEqual(["import"]);
  });
});

describe("exportarBundle", () => {
  it("leva só os dados locais (sem fonte), nunca os importados", async () => {
    const { transfer, coleta } = await fresh();
    // Uma tarefa local (sem fonte), escrita direto no JSONL.
    appendFileSync(coleta.TAREFAS_FILE(), JSON.stringify(tarefa("local-1")) + "\n");
    // E uma importada de outra máquina.
    transfer.importarBundle(bundleDe([tarefa("maria-1")]), "maria");

    const bundle = transfer.exportarBundle(false);
    expect(bundle.tarefas).toHaveLength(1);
    expect(bundle.tarefas[0]?.taskId).toBe("local-1");
    expect(bundle.tarefas.every((t) => !t.fonte)).toBe(true);
  });
});
