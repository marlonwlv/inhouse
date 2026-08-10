/**
 * Limitador GLOBAL de concorrência de processos pesados (sessões Claude e npm install).
 * Sem isto, N tarefas simultâneas dão spawn de N sessões Claude + N installs ao mesmo
 * tempo, esgotando o orçamento de fork/thread da máquina (EAGAIN — "resource temporarily
 * unavailable"). Um semáforo contável por "tipo" enfileira o excedente e libera conforme
 * os slots vagam. É GLOBAL (não por projeto, ao contrário de withProjectLock em locks.ts).
 */
import { cpus } from "node:os";

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

const nucleos = Math.max(1, cpus().length);
/** Tetos default por tipo — conservadores; overridáveis por env. */
const LIMITES: Record<string, number> = {
  // Sessão Claude é o processo mais caro; deixa folga de CPU pro server + gates.
  claude: envInt("INHOUSE_MAX_CLAUDE", Math.max(1, Math.min(4, nucleos - 2))),
  // npm/pnpm install: pesado em I/O e memória; 2 em paralelo é o teto seguro.
  install: envInt("INHOUSE_MAX_INSTALL", 2),
};

interface Semaforo {
  max: number;
  emUso: number;
  fila: Array<() => void>;
}
const semaforos = new Map<string, Semaforo>();

function get(tipo: string): Semaforo {
  let s = semaforos.get(tipo);
  if (!s) {
    s = { max: LIMITES[tipo] ?? 4, emUso: 0, fila: [] };
    semaforos.set(tipo, s);
  }
  return s;
}

function adquirir(s: Semaforo): Promise<void> {
  if (s.emUso < s.max) {
    s.emUso++;
    return Promise.resolve();
  }
  // Cheio: espera na fila. O slot é transferido direto em `liberar` (emUso não muda).
  return new Promise<void>((resolve) => s.fila.push(resolve));
}

function liberar(s: Semaforo): void {
  const proximo = s.fila.shift();
  if (proximo) proximo(); // passa o slot pra quem esperava (mantém emUso)
  else s.emUso = Math.max(0, s.emUso - 1);
}

/**
 * Adquire um slot do `tipo` e devolve a função que o LIBERA (idempotente).
 * Use quando precisar segurar/soltar o slot manualmente — ex.: soltar o slot de
 * uma sessão Claude enquanto ela espera decisão humana, e re-adquirir depois.
 */
export async function acquire(tipo: string): Promise<() => void> {
  const s = get(tipo);
  await adquirir(s);
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    liberar(s);
  };
}

/** Roda `fn` respeitando o teto global do `tipo`; enfileira o excedente. Libera mesmo em erro. */
export async function withLimit<T>(tipo: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquire(tipo);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Só para testes/inspeção. */
export function limiteInfo(tipo: string): { max: number; emUso: number; fila: number } {
  const s = get(tipo);
  return { max: s.max, emUso: s.emUso, fila: s.fila.length };
}
