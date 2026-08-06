import { describe, expect, it } from "vitest";
import type { Task, TranscriptItem } from "../shared/types.js";
import { derivarRegistro } from "../server/eval/derivar.js";

const T0 = Date.parse("2026-08-06T10:00:00.000Z");
const iso = (offsetMin: number): string => new Date(T0 + offsetMin * 60_000).toISOString();

function baseTask(extra: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    title: "Mudar a cor de um botão",
    description: "mudar a cor",
    step: "concluida",
    status: "concluida",
    espaco: 1,
    branch: "tarefa/x",
    worktreePath: "/tmp/x",
    gates: [{ name: "TypeScript", command: "npm run typecheck", ok: true, durationMs: 1200 }],
    gateFixRounds: 1,
    createdAt: iso(0),
    updatedAt: iso(60),
    ...extra,
  };
}

describe("derivarRegistro", () => {
  it("soma etapas do historico separando espera humana de máquina", () => {
    const task = baseTask({
      historico: [
        { step: "espec", inicio: iso(0), fim: iso(2) },
        { step: "plano", inicio: iso(2), fim: iso(10) },
        { step: "aprovacao", inicio: iso(10), fim: iso(40) }, // 30 min humano
        { step: "execucao", inicio: iso(40), fim: iso(50) },
        { step: "concluida", inicio: iso(50), fim: iso(50) },
      ],
    });
    const r = derivarRegistro(task, [], "concluida");
    expect(r.esperaHumanaMs).toBe(30 * 60_000);
    expect(r.msMaquina).toBe(20 * 60_000);
    expect(r.etapas.find((e) => e.step === "plano")?.ms).toBe(8 * 60_000);
    expect(r.gateFixRounds).toBe(1);
  });

  it("classifica pedidos de mudança pela janela de tempo (aprovacao/teste/execucao)", () => {
    const task = baseTask({
      historico: [
        { step: "aprovacao", inicio: iso(10), fim: iso(40) },
        { step: "execucao", inicio: iso(40), fim: iso(50) },
        { step: "teste", inicio: iso(50), fim: iso(80) },
      ],
    });
    const transcript: TranscriptItem[] = [
      { kind: "user", text: "descrição original", at: iso(0) },
      { kind: "user", text: "muda o tom de verde", at: iso(20) }, // janela aprovacao
      { kind: "user", text: "corrige o alinhamento", at: iso(60) }, // janela teste
      { kind: "user", text: "steering durante execução", at: iso(45) }, // janela execucao
    ];
    const r = derivarRegistro(task, transcript, "concluida");
    expect(r.pedidosMudanca).toHaveLength(3);
    expect(r.pedidosMudanca.map((p) => p.etapa).sort()).toEqual(["aprovacao", "execucao", "teste"]);
    expect(r.pedidosMudanca[0]?.texto).toBe("muda o tom de verde");
  });

  it("tolera tarefa antiga sem historico/uso e transcript vazio", () => {
    const r = derivarRegistro(baseTask({ historico: undefined }), [], "cancelada", "só testando");
    expect(r.etapas).toEqual([]);
    expect(r.esperaHumanaMs).toBe(0);
    expect(r.motivoCancelamento).toBe("só testando");
    expect(r.itensTranscript).toEqual({ user: 0, assistant: 0, tool: 0, system: 0 });
  });

  it("entrada aberta do historico fecha em 'agora' (nunca negativa)", () => {
    const inicioRecente = new Date(Date.now() - 5 * 60_000).toISOString();
    const task = baseTask({ historico: [{ step: "teste", inicio: inicioRecente }] });
    const r = derivarRegistro(task, [], "cancelada");
    expect(r.esperaHumanaMs).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(r.esperaHumanaMs).toBeLessThan(6 * 60_000);
  });

  it("conta itens do transcript por kind (sinal de ruído técnico)", () => {
    const transcript: TranscriptItem[] = [
      { kind: "user", text: "a", at: iso(0) },
      { kind: "assistant", text: "b", at: iso(1) },
      { kind: "tool", op: "$", label: "Rodar: x", at: iso(2) },
      { kind: "tool", op: "✎", label: "Editar y", at: iso(3) },
      { kind: "system", text: "c", at: iso(4) },
    ];
    const r = derivarRegistro(baseTask(), transcript, "concluida");
    expect(r.itensTranscript).toEqual({ user: 1, assistant: 1, tool: 2, system: 1 });
  });
});
