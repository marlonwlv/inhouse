/**
 * Tipos internos dos arquivos JSONL do eval (server-only — a UI consome só o
 * EvalResumo de shared/types.ts, nunca as linhas cruas).
 */
import type { FeedbackNota, Porte, Step, TaskUso } from "../../shared/types.js";

export interface RegistroTarefa {
  v: 1;
  ts: string;
  taskId: string;
  projectId: string;
  titulo: string;
  desfecho: "concluida" | "cancelada";
  motivoCancelamento?: string;
  porte?: Porte;
  temUi?: boolean;
  autoAprovar?: boolean;
  pausadaPorTempo?: boolean;
  criadaEm: string;
  duracaoTotalMs: number;
  /** Soma por step do historico (repetições agregadas). */
  etapas: { step: Step; ms: number }[];
  /** Tempo parado em porteiras humanas (aprovacao/teste/publicar). */
  esperaHumanaMs: number;
  /** Tempo das etapas automáticas. */
  msMaquina: number;
  gates: { name: string; ok: boolean; durationMs: number }[];
  gateFixRounds: number;
  uso?: TaskUso;
  /** Textos literais do usuário pedindo mudanças/steering, com a etapa em que ocorreram. */
  pedidosMudanca: { etapa: "aprovacao" | "teste" | "execucao"; texto: string; ts: string }[];
  itensTranscript: { user: number; assistant: number; tool: number; system: number };
  errorFinal?: string;
  prCriado?: boolean;
  origem?: "backfill";
  /** Máquina de origem quando o registro veio de um import (ex.: "maria"). Ausente = local. */
  fonte?: string;
}

export interface RegistroPermissao {
  v: 1;
  ts: string;
  taskId: string;
  requestId: string;
  tool: string;
  esperaMs: number;
  desfecho: "permitiu" | "negou" | "timeout" | "abortada" | "auto";
  lembrar?: boolean;
  fonte?: string;
}

export interface RegistroFeedback {
  v: 1;
  ts: string;
  taskId: string;
  nota: FeedbackNota;
  texto?: string;
  fonte?: string;
}

export interface RegistroRelatorio {
  v: 1;
  ts: string;
  arquivo: string;
  tarefasAnalisadas: number;
  custoUsd?: number;
  fonte?: string;
}

export interface RegistroAprendizado {
  v: 1;
  ts: string;
  chave: string;
  insight: string;
  severidade: number;
  evidencia?: string;
  ocorrencias: number;
  fonte?: string;
}
