/**
 * Funil único de ESCRITA do eval de experiência. Regra de ouro: a coleta NUNCA
 * pode derrubar a esteira — toda função pública engole exceções com warn.
 * Arquivos JSONL em EVAL_DIR (1 linha compacta por evento, padrão transcript).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedbackNota, Step, UsoFase } from "../../shared/types.js";
import { EVAL_DIR, ensureDirs } from "../config.js";
import * as store from "../store.js";
import { derivarRegistro } from "./derivar.js";
import type {
  RegistroFeedback,
  RegistroPermissao,
  RegistroRelatorio,
  RegistroTarefa,
} from "./registro.js";

export const TAREFAS_FILE = (): string => join(EVAL_DIR, "tarefas.jsonl");
export const PERMISSOES_FILE = (): string => join(EVAL_DIR, "permissoes.jsonl");
export const FEEDBACK_FILE = (): string => join(EVAL_DIR, "feedback.jsonl");
export const RELATORIOS_INDEX = (): string => join(EVAL_DIR, "relatorios.jsonl");
export const APRENDIZADOS_FILE = (): string => join(EVAL_DIR, "aprendizados.jsonl");

function appendJsonl(file: string, obj: unknown): void {
  appendFileSync(file, JSON.stringify(obj) + "\n");
}

/** Leitura tolerante: linha corrompida é pulada (padrão transcriptRead). */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {
      // linha corrompida (append interrompido): ignora
    }
  }
  return out;
}

export interface FaseMetricas {
  custoUsd: number;
  turnos: number;
  msTotal: number;
  msApi: number;
  tokensIn: number;
  tokensOut: number;
  negacoesAuto: number;
}

/** Acumula as métricas de uma fase no Task.uso (persistido — sobrevive a restart). */
export function acumularFase(taskId: string, m: FaseMetricas): void {
  try {
    const task = store.getTask(taskId);
    if (!task) return;
    const uso = task.uso ?? { porEtapa: {}, falhas: 0, ultimosErros: [] };
    const etapa: Step = task.step;
    const atual: UsoFase = uso.porEtapa[etapa] ?? {
      chamadas: 0, custoUsd: 0, turnos: 0, msTotal: 0, msApi: 0, tokensIn: 0, tokensOut: 0, negacoesAuto: 0,
    };
    uso.porEtapa[etapa] = {
      chamadas: atual.chamadas + 1,
      custoUsd: atual.custoUsd + m.custoUsd,
      turnos: atual.turnos + m.turnos,
      msTotal: atual.msTotal + m.msTotal,
      msApi: atual.msApi + m.msApi,
      tokensIn: atual.tokensIn + m.tokensIn,
      tokensOut: atual.tokensOut + m.tokensOut,
      negacoesAuto: atual.negacoesAuto + m.negacoesAuto,
    };
    store.updateTask(taskId, { uso });
  } catch (err) {
    console.warn("[eval] acumularFase:", err instanceof Error ? err.message : err);
  }
}

/** Registra uma falha exposta ao usuário (fail() da esteira). */
export function registrarFalha(taskId: string, msg: string): void {
  try {
    const task = store.getTask(taskId);
    if (!task) return;
    const uso = task.uso ?? { porEtapa: {}, falhas: 0, ultimosErros: [] };
    uso.falhas += 1;
    const curto = msg.slice(0, 200);
    if (!uso.ultimosErros.includes(curto)) {
      uso.ultimosErros = [...uso.ultimosErros, curto].slice(-3);
    }
    store.updateTask(taskId, { uso });
  } catch (err) {
    console.warn("[eval] registrarFalha:", err instanceof Error ? err.message : err);
  }
}

/** Marca que o re-julgamento pós-plano detectou triagem inicial curta. */
export function marcarTriagemCurta(taskId: string): void {
  try {
    const task = store.getTask(taskId);
    if (!task) return;
    const uso = task.uso ?? { porEtapa: {}, falhas: 0, ultimosErros: [] };
    uso.triagemCurta = true;
    store.updateTask(taskId, { uso });
  } catch (err) {
    console.warn("[eval] marcarTriagemCurta:", err instanceof Error ? err.message : err);
  }
}

export function registrarPermissao(r: Omit<RegistroPermissao, "v" | "ts">): void {
  try {
    ensureDirs();
    appendJsonl(PERMISSOES_FILE(), { v: 1, ts: new Date().toISOString(), ...r });
  } catch (err) {
    console.warn("[eval] registrarPermissao:", err instanceof Error ? err.message : err);
  }
}

export function registrarFeedback(taskId: string, nota: FeedbackNota, texto?: string): void {
  try {
    ensureDirs();
    const r: RegistroFeedback = {
      v: 1, ts: new Date().toISOString(), taskId, nota,
      ...(texto ? { texto: texto.slice(0, 2000) } : {}),
    };
    appendJsonl(FEEDBACK_FILE(), r);
  } catch (err) {
    console.warn("[eval] registrarFeedback:", err instanceof Error ? err.message : err);
  }
}

export function registrarRelatorio(r: Omit<RegistroRelatorio, "v" | "ts">): void {
  try {
    ensureDirs();
    appendJsonl(RELATORIOS_INDEX(), { v: 1, ts: new Date().toISOString(), ...r });
  } catch (err) {
    console.warn("[eval] registrarRelatorio:", err instanceof Error ? err.message : err);
  }
}

/** Flush terminal: lê task + transcript e grava o registro-resumo da tarefa. */
export function registrarTarefaFinalizada(
  taskId: string,
  desfecho: "concluida" | "cancelada",
  motivo?: string,
): void {
  try {
    const task = store.getTask(taskId);
    if (!task) return;
    ensureDirs();
    const transcript = store.transcriptRead(taskId);
    const registro = derivarRegistro(task, transcript, desfecho, motivo);
    appendJsonl(TAREFAS_FILE(), registro);
  } catch (err) {
    console.warn("[eval] registrarTarefaFinalizada:", err instanceof Error ? err.message : err);
  }
}

/**
 * Backfill de primeira subida: se tarefas.jsonl ainda não existe, deriva
 * registros de todas as tarefas já terminais do state.json — o eval nasce
 * com os dados históricos ("os problemas que você não lembra").
 */
export function backfillSeVazio(): void {
  try {
    ensureDirs();
    if (existsSync(TAREFAS_FILE())) return;
    let n = 0;
    for (const task of store.listTasks()) {
      if (task.status !== "concluida" && task.status !== "cancelada") continue;
      const desfecho = task.status;
      const transcript = store.transcriptRead(task.id);
      const registro: RegistroTarefa = derivarRegistro(task, transcript, desfecho, undefined, "backfill");
      appendJsonl(TAREFAS_FILE(), registro);
      n++;
    }
    if (n > 0) console.log(`[eval] backfill: ${n} tarefa(s) histórica(s) registradas.`);
  } catch (err) {
    console.warn("[eval] backfill:", err instanceof Error ? err.message : err);
  }
}
