/**
 * Coleta do eval com DATA_DIR temporário (padrão de store.test.ts: env antes do
 * import dinâmico + vi.resetModules). Cobre persistência do uso por fase através
 * de restart, escrita JSONL, leitura tolerante e backfill idempotente.
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/types.js";

type Coleta = typeof import("../server/eval/coleta.js");
type Store = typeof import("../server/store.js");

let dataDir = "";

async function fresh(): Promise<{ coleta: Coleta; store: Store }> {
  dataDir = mkdtempSync(join(tmpdir(), "inhouse-eval-"));
  process.env.INHOUSE_DATA_DIR = dataDir;
  process.env.INHOUSE_PROJECTS_DIR = join(dataDir, "projects");
  vi.resetModules();
  const store: Store = await import("../server/store.js");
  store.load();
  const coleta: Coleta = await import("../server/eval/coleta.js");
  return { coleta, store };
}

async function reimport(): Promise<{ coleta: Coleta; store: Store }> {
  vi.resetModules();
  const store: Store = await import("../server/store.js");
  store.load();
  const coleta: Coleta = await import("../server/eval/coleta.js");
  return { coleta, store };
}

function novaTask(store: Store, extra: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return store.addTask({
    id: store.newId(),
    projectId: "p1",
    title: "tarefa de teste",
    description: "desc",
    step: "execucao",
    status: "rodando",
    espaco: 1,
    branch: "b",
    worktreePath: "/tmp/w",
    gates: [],
    gateFixRounds: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

const METRICAS = { custoUsd: 0.5, turnos: 3, msTotal: 60_000, msApi: 30_000, tokensIn: 1000, tokensOut: 200, negacoesAuto: 1 };

describe("coleta do eval", () => {
  it("acumularFase soma no Task.uso e sobrevive a restart", async () => {
    const { coleta, store } = await fresh();
    const t = novaTask(store);
    coleta.acumularFase(t.id, METRICAS);
    coleta.acumularFase(t.id, METRICAS);

    const { store: store2 } = await reimport();
    const depois = store2.getTask(t.id);
    const fase = depois?.uso?.porEtapa.execucao;
    expect(fase?.chamadas).toBe(2);
    expect(fase?.custoUsd).toBeCloseTo(1.0);
    expect(fase?.negacoesAuto).toBe(2);
  });

  it("registrarFalha acumula com dedupe e teto de 3 erros", async () => {
    const { coleta, store } = await fresh();
    const t = novaTask(store);
    for (const m of ["erro A", "erro A", "erro B", "erro C", "erro D"]) coleta.registrarFalha(t.id, m);
    const uso = store.getTask(t.id)?.uso;
    expect(uso?.falhas).toBe(5);
    expect(uso?.ultimosErros).toEqual(["erro B", "erro C", "erro D"]);
  });

  it("registrarTarefaFinalizada escreve 1 linha JSONL válida com transcript", async () => {
    const { coleta, store } = await fresh();
    const t = novaTask(store, { status: "concluida", step: "concluida" });
    store.transcriptAppend(t.id, { kind: "user", text: "faz X", at: new Date().toISOString() });
    coleta.registrarTarefaFinalizada(t.id, "concluida");
    const linhas = readFileSync(coleta.TAREFAS_FILE(), "utf8").trim().split("\n");
    expect(linhas).toHaveLength(1);
    const r = JSON.parse(linhas[0]!);
    expect(r).toMatchObject({ v: 1, taskId: t.id, desfecho: "concluida" });
    expect(r.itensTranscript.user).toBe(1);
  });

  it("funções não lançam com task inexistente", async () => {
    const { coleta } = await fresh();
    expect(() => coleta.acumularFase("nao-existe", METRICAS)).not.toThrow();
    expect(() => coleta.registrarFalha("nao-existe", "x")).not.toThrow();
    expect(() => coleta.registrarTarefaFinalizada("nao-existe", "cancelada")).not.toThrow();
  });

  it("readJsonl pula linha corrompida", async () => {
    const { coleta } = await fresh();
    coleta.registrarPermissao({ taskId: "t", requestId: "r", tool: "Bash", esperaMs: 10, desfecho: "permitiu" });
    appendFileSync(coleta.PERMISSOES_FILE(), "{quebrado\n");
    coleta.registrarPermissao({ taskId: "t", requestId: "r2", tool: "Bash", esperaMs: 20, desfecho: "auto" });
    const lidos = coleta.readJsonl<{ requestId: string }>(coleta.PERMISSOES_FILE());
    expect(lidos.map((r) => r.requestId)).toEqual(["r", "r2"]);
  });

  it("backfillSeVazio deriva só terminais e é idempotente", async () => {
    const { coleta, store } = await fresh();
    novaTask(store, { status: "concluida", step: "concluida" });
    novaTask(store, { status: "cancelada", step: "execucao" });
    novaTask(store, { status: "rodando" }); // não entra
    coleta.backfillSeVazio();
    coleta.backfillSeVazio(); // segunda chamada: arquivo já existe, não duplica
    const linhas = coleta.readJsonl<{ origem?: string }>(coleta.TAREFAS_FILE());
    expect(linhas).toHaveLength(2);
    expect(linhas.every((l) => l.origem === "backfill")).toBe(true);
  });
});
