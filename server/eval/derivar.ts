/**
 * Derivação pura do registro de eval a partir de uma Task terminal + transcript.
 * Sem I/O — testável isoladamente. Tolera dados ausentes (tarefas antigas sem
 * historico/uso, transcript vazio): campos ficam zerados/omitidos, nunca lança.
 */
import type { Step, Task, TranscriptItem } from "../../shared/types.js";
import { HUMAN_STEPS } from "../../shared/types.js";
import type { RegistroTarefa } from "./registro.js";

function somaEtapas(task: Task, agora: number): { etapas: { step: Step; ms: number }[]; esperaHumanaMs: number; msMaquina: number } {
  const porStep = new Map<Step, number>();
  let esperaHumanaMs = 0;
  let msMaquina = 0;
  for (const h of task.historico ?? []) {
    const fim = h.fim ? Date.parse(h.fim) : agora;
    const ms = Math.max(0, fim - Date.parse(h.inicio));
    porStep.set(h.step, (porStep.get(h.step) ?? 0) + ms);
    if ((HUMAN_STEPS as readonly string[]).includes(h.step)) esperaHumanaMs += ms;
    else msMaquina += ms;
  }
  return {
    etapas: [...porStep.entries()].map(([step, ms]) => ({ step, ms })),
    esperaHumanaMs,
    msMaquina,
  };
}

/**
 * Classifica cada item `user` (além do primeiro, que é a descrição da tarefa)
 * pela janela de tempo do historico em que caiu: porteira humana de aprovação/
 * teste = pedido de mudança; durante execução/verificações = steering/pós-falha.
 * Sem parsing de texto — só timestamps.
 */
function pedidosMudanca(task: Task, transcript: TranscriptItem[]): RegistroTarefa["pedidosMudanca"] {
  const users = transcript.filter((i) => i.kind === "user");
  const semDescricao = users.slice(1);
  const janelas = (task.historico ?? []).map((h) => ({
    step: h.step,
    de: Date.parse(h.inicio),
    ate: h.fim ? Date.parse(h.fim) : Number.POSITIVE_INFINITY,
  }));
  const out: RegistroTarefa["pedidosMudanca"] = [];
  for (const u of semDescricao) {
    const t = Date.parse(u.at);
    const janela = janelas.find((j) => t >= j.de && t <= j.ate);
    const etapa =
      janela?.step === "aprovacao" ? "aprovacao"
      : janela?.step === "teste" ? "teste"
      : "execucao";
    out.push({ etapa, texto: u.text.slice(0, 500), ts: u.at });
  }
  return out;
}

export function derivarRegistro(
  task: Task,
  transcript: TranscriptItem[],
  desfecho: "concluida" | "cancelada",
  motivo?: string,
  origem?: "backfill",
): RegistroTarefa {
  const agora = Date.now();
  const { etapas, esperaHumanaMs, msMaquina } = somaEtapas(task, agora);
  const contagem = { user: 0, assistant: 0, tool: 0, system: 0 };
  for (const i of transcript) contagem[i.kind]++;

  return {
    v: 1,
    ts: new Date(agora).toISOString(),
    taskId: task.id,
    projectId: task.projectId,
    titulo: task.title.slice(0, 120),
    desfecho,
    ...(motivo ? { motivoCancelamento: motivo.slice(0, 500) } : {}),
    ...(task.porte ? { porte: task.porte } : {}),
    ...(task.temUi !== undefined ? { temUi: task.temUi } : {}),
    ...(task.autoAprovar ? { autoAprovar: true } : {}),
    ...(task.pausadaPorTempo ? { pausadaPorTempo: true } : {}),
    criadaEm: task.createdAt,
    duracaoTotalMs: Math.max(0, agora - Date.parse(task.createdAt)),
    etapas,
    esperaHumanaMs,
    msMaquina,
    gates: (task.gates ?? []).map((g) => ({ name: g.name, ok: g.ok, durationMs: g.durationMs })),
    gateFixRounds: task.gateFixRounds ?? 0,
    ...(task.uso ? { uso: task.uso } : {}),
    pedidosMudanca: pedidosMudanca(task, transcript),
    itensTranscript: contagem,
    ...(task.error ? { errorFinal: task.error.slice(0, 300) } : {}),
    ...(task.prUrl ? { prCriado: true } : {}),
    ...(origem ? { origem } : {}),
  };
}
