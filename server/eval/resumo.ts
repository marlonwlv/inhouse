/**
 * Agregados do eval — o EvalResumo consumido pela tela Experiência e o material
 * numérico do juiz. Tudo calculado on-the-fly dos JSONL (volumes pequenos).
 */
import type { EvalResumo } from "../../shared/types.js";
import * as store from "../store.js";
import {
  APRENDIZADOS_FILE,
  FEEDBACK_FILE,
  PERMISSOES_FILE,
  RELATORIOS_INDEX,
  TAREFAS_FILE,
  readJsonl,
} from "./coleta.js";
import type {
  RegistroAprendizado,
  RegistroFeedback,
  RegistroPermissao,
  RegistroRelatorio,
  RegistroTarefa,
} from "./registro.js";

function mediana(valores: number[]): number | null {
  if (valores.length === 0) return null;
  const s = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[meio]! : Math.round((s[meio - 1]! + s[meio]!) / 2);
}

/**
 * Filtra registros por origem: undefined/"todos" = tudo; "meus" = só locais
 * (sem fonte); qualquer outro rótulo = só aquela fonte importada.
 */
function filtrarFonte<T extends { fonte?: string }>(rs: T[], fonte?: string): T[] {
  if (!fonte || fonte === "todos") return rs;
  if (fonte === "meus") return rs.filter((r) => !r.fonte);
  return rs.filter((r) => r.fonte === fonte);
}

/** Inclui as tarefas vivas (locais) na conta? Só quando a fonte abrange o local. */
function incluiLocais(fonte?: string): boolean {
  return !fonte || fonte === "todos" || fonte === "meus";
}

/** "Sem resgate" = concluída sem falha exposta, sem pausa de 1h e sem estourar as rodadas de correção. */
function semResgate(r: RegistroTarefa): boolean {
  if (r.desfecho !== "concluida") return false;
  const falhas = r.uso?.falhas ?? 0;
  return falhas === 0 && !r.pausadaPorTempo && r.gateFixRounds < 2;
}

/** Feedback com latest-wins por taskId (filtrado por fonte). */
export function feedbackPorTarefa(fonte?: string): Map<string, RegistroFeedback> {
  const m = new Map<string, RegistroFeedback>();
  for (const f of filtrarFonte(readJsonl<RegistroFeedback>(FEEDBACK_FILE()), fonte)) m.set(f.taskId, f);
  return m;
}

export function aprendizadosOrdenados(fonte?: string): RegistroAprendizado[] {
  // Dedupe por chave (latest-wins), ordenado por ocorrências × severidade.
  const m = new Map<string, RegistroAprendizado>();
  for (const a of filtrarFonte(readJsonl<RegistroAprendizado>(APRENDIZADOS_FILE()), fonte)) m.set(a.chave, a);
  return [...m.values()].sort(
    (a, b) => b.ocorrencias * b.severidade - a.ocorrencias * a.severidade,
  );
}

export function calcularResumo(fonte?: string): EvalResumo {
  const tarefas = filtrarFonte(readJsonl<RegistroTarefa>(TAREFAS_FILE()), fonte);
  const permissoes = filtrarFonte(readJsonl<RegistroPermissao>(PERMISSOES_FILE()), fonte);
  const relatorios = filtrarFonte(readJsonl<RegistroRelatorio>(RELATORIOS_INDEX()), fonte);
  const feedback = feedbackPorTarefa(fonte);

  const concluidas = tarefas.filter((t) => t.desfecho === "concluida");
  const canceladas = tarefas.filter((t) => t.desfecho === "cancelada");
  const publicadasSemResgate = tarefas.filter(semResgate).length;

  const comTempo = concluidas.filter((t) => t.etapas.length > 0);
  const custoTotalUsd = tarefas.reduce((soma, t) => {
    const porEtapa = t.uso?.porEtapa ?? {};
    return soma + Object.values(porEtapa).reduce((s, f) => s + (f?.custoUsd ?? 0), 0);
  }, 0);

  const gatesReprovados = new Map<string, number>();
  for (const t of tarefas) {
    for (const g of t.gates) {
      if (!g.ok) gatesReprovados.set(g.name, (gatesReprovados.get(g.name) ?? 0) + 1);
    }
  }
  const gateMaisReprova =
    [...gatesReprovados.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const humanas = permissoes.filter((p) => p.desfecho === "permitiu" || p.desfecho === "negou");
  const notas = { otimo: 0, ok: 0, ruim: 0 };
  for (const f of feedback.values()) notas[f.nota]++;

  // Tarefas vivas travadas em "falhou" só entram quando a visão inclui o local
  // (dados importados não têm tarefas vivas nesta máquina).
  const paradasEmFalhou = incluiLocais(fonte)
    ? store.listTasks().filter((t) => t.status === "falhou").length
    : 0;

  return {
    taxaSemResgate: { publicadasSemResgate, finalizadas: tarefas.length },
    tempoHumanoMedianoMs: mediana(comTempo.map((t) => t.esperaHumanaMs)),
    tempoMaquinaMedianoMs: mediana(comTempo.map((t) => t.msMaquina)),
    concluidas: concluidas.length,
    canceladas: canceladas.length,
    paradasEmFalhou,
    permissoes: {
      total: permissoes.length,
      esperaMedianaMs: mediana(humanas.map((p) => p.esperaMs)),
      timeouts: permissoes.filter((p) => p.desfecho === "timeout").length,
      autoPct:
        permissoes.length === 0
          ? 0
          : Math.round((permissoes.filter((p) => p.desfecho === "auto").length / permissoes.length) * 100),
    },
    gateMaisReprova,
    custoTotalUsd: Math.round(custoTotalUsd * 100) / 100,
    feedback: notas,
    semDadosDeTempo: concluidas.length - comTempo.length,
    aprendizados: aprendizadosOrdenados(fonte)
      .slice(0, 8)
      .map((a) => ({ chave: a.chave, insight: a.insight, severidade: a.severidade, ocorrencias: a.ocorrencias })),
    relatorios: relatorios.length,
  };
}
