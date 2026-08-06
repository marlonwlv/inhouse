/**
 * Export/import do eval entre máquinas. Serve para coletar os dados de quem está
 * testando (ex.: o designer) sem servidor central: a máquina de origem gera um
 * bundle (JSON), e a máquina que analisa importa mesclando com a marca de
 * origem (`fonte`), para a tela Experiência filtrar por pessoa.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { TranscriptItem } from "../../shared/types.js";
import { RELATORIOS_DIR, ensureDirs } from "../config.js";
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

export const BUNDLE_VERSION = 1;

export interface EvalBundle {
  v: number;
  geradoEm: string;
  origem?: { label?: string };
  tarefas: RegistroTarefa[];
  permissoes: RegistroPermissao[];
  feedback: RegistroFeedback[];
  aprendizados: RegistroAprendizado[];
  relatorios: RegistroRelatorio[];
  /** Conteúdo markdown dos relatórios, para leitura na outra máquina. */
  relatoriosConteudo?: Record<string, string>;
  /** Opt-in: transcript por tarefa (bundle bem maior). */
  transcripts?: Record<string, TranscriptItem[]>;
}

/** Só os registros locais (sem `fonte`): uma máquina exporta os SEUS dados. */
function locais<T extends { fonte?: string }>(rs: T[]): T[] {
  return rs.filter((r) => !r.fonte);
}

/** Gera o bundle com os dados locais desta máquina. */
export function exportarBundle(incluirTranscripts: boolean, label?: string): EvalBundle {
  const tarefas = locais(readJsonl<RegistroTarefa>(TAREFAS_FILE()));
  const relatorios = locais(readJsonl<RegistroRelatorio>(RELATORIOS_INDEX()));

  const bundle: EvalBundle = {
    v: BUNDLE_VERSION,
    geradoEm: new Date().toISOString(),
    ...(label ? { origem: { label } } : {}),
    tarefas,
    permissoes: locais(readJsonl<RegistroPermissao>(PERMISSOES_FILE())),
    feedback: locais(readJsonl<RegistroFeedback>(FEEDBACK_FILE())),
    aprendizados: locais(readJsonl<RegistroAprendizado>(APRENDIZADOS_FILE())),
    relatorios,
  };

  const conteudo: Record<string, string> = {};
  for (const r of relatorios) {
    const caminho = resolve(RELATORIOS_DIR, r.arquivo);
    if (caminho.startsWith(resolve(RELATORIOS_DIR) + sep) && existsSync(caminho)) {
      try {
        conteudo[r.arquivo] = readFileSync(caminho, "utf8");
      } catch {
        // arquivo ilegível: apenas não vai no bundle
      }
    }
  }
  if (Object.keys(conteudo).length) bundle.relatoriosConteudo = conteudo;

  if (incluirTranscripts) {
    const t: Record<string, TranscriptItem[]> = {};
    for (const tar of tarefas) {
      const itens = store.transcriptRead(tar.taskId);
      if (itens.length) t[tar.taskId] = itens;
    }
    if (Object.keys(t).length) bundle.transcripts = t;
  }
  return bundle;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function asArray<T>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : [];
}

/** Mesmo formato dos IDs locais (randomUUID). Barra um taskId malicioso de um
 *  bundle externo antes que ele chegue a qualquer caminho de arquivo. */
function taskIdSeguro(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/**
 * Mescla um bundle nos JSONL locais, marcando tudo com `fonte`. Idempotente:
 * dedupe por chave natural dentro da mesma fonte (reimportar não duplica).
 * Relatórios (índice + markdown) NÃO são importados — regeram-se localmente.
 */
export function importarBundle(raw: unknown, fonte: string): { importados: number; pulados: number } {
  ensureDirs();
  const fonteTag = (fonte.trim() || "import").slice(0, 40);
  if (!isRecord(raw)) throw new Error("Arquivo de dados inválido.");

  let importados = 0;
  let pulados = 0;

  // escopoGlobal: dedupe contra TODAS as fontes, não só a atual. Usado para
  // chaves globalmente únicas (taskId/requestId são UUIDs) — evita contar em
  // dobro se o mesmo bundle for importado sob dois rótulos ("maria" e "Maria").
  function mesclar<T extends { fonte?: string }>(
    file: string,
    incoming: T[],
    chave: (r: T) => string,
    escopoGlobal = false,
  ): string[] {
    const existentes = new Set(
      readJsonl<T>(file)
        .filter((r) => escopoGlobal || r.fonte === fonteTag)
        .map(chave),
    );
    const novas: string[] = [];
    for (const r of incoming) {
      if (!isRecord(r)) continue;
      const marcado = { ...r, fonte: fonteTag };
      const k = chave(marcado);
      if (!k || existentes.has(k)) {
        pulados++;
        continue;
      }
      existentes.add(k);
      appendFileSync(file, JSON.stringify(marcado) + "\n");
      importados++;
      novas.push(k);
    }
    return novas;
  }

  // Tarefas com taskId fora do formato local são descartadas: um id malicioso
  // (ex.: "../../x") jamais entra nos JSONL nem vira caminho de transcript.
  // taskId/requestId são UUIDs globais → dedupe global. A "chave" de aprendizado
  // (ex.: "plano-lento") é compartilhada entre máquinas → dedupe por fonte.
  const tarefasEntrada = asArray<RegistroTarefa>(raw.tarefas).filter((t) => taskIdSeguro(t.taskId));
  const novasTarefas = mesclar<RegistroTarefa>(TAREFAS_FILE(), tarefasEntrada, (r) => r.taskId, true);
  mesclar<RegistroPermissao>(PERMISSOES_FILE(), asArray(raw.permissoes), (r) => r.requestId, true);
  mesclar<RegistroFeedback>(FEEDBACK_FILE(), asArray(raw.feedback), (r) => `${r.taskId}|${r.ts}`, true);
  mesclar<RegistroAprendizado>(APRENDIZADOS_FILE(), asArray(raw.aprendizados), (r) => r.chave);

  // Transcripts (opt-in no export) das tarefas realmente novas — só se o local
  // ainda não tem, para não duplicar numa reimportação.
  const trans = isRecord(raw.transcripts) ? (raw.transcripts as Record<string, unknown>) : {};
  for (const taskId of novasTarefas) {
    const itens = asArray<TranscriptItem>(trans[taskId]);
    if (itens.length && store.transcriptRead(taskId).length === 0) {
      for (const it of itens) store.transcriptAppend(taskId, it);
    }
  }

  return { importados, pulados };
}

/** Fontes importadas presentes (para o filtro da tela Experiência). */
export function fontesDisponiveis(): string[] {
  const s = new Set<string>();
  for (const t of readJsonl<RegistroTarefa>(TAREFAS_FILE())) {
    if (t.fonte) s.add(t.fonte);
  }
  return [...s].sort();
}
