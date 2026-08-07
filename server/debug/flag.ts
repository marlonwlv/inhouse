/**
 * Modo Debug da esteira. Quando ligado (env INHOUSE_FAKE_MODEL), o modelo (LLM)
 * e o I/O pesado (npm install, dev server, git de publicação) são FINGIDOS, para
 * testar as jornadas de ponta a ponta sem gastar minutos de Claude.
 *
 * Este módulo é uma FOLHA (não importa nada do projeto) de propósito: os seams
 * espalhados pelo server importam `isFakeModelActive` daqui sem criar ciclos.
 */

/** O modo debug está ligado? (early-return de todos os seams). */
export function isFakeModelActive(): boolean {
  return Boolean(process.env.INHOUSE_FAKE_MODEL);
}

/**
 * Atraso artificial por fase (ms), para dar tempo de "assistir" a jornada na UI.
 * Default 0 (o runner headless quer velocidade máxima). Ex.: INHOUSE_FAKE_DELAY_MS=400.
 */
export function fakeDelayMs(): number {
  const n = Number(process.env.INHOUSE_FAKE_DELAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * No modo debug, gates "real" e a instalação de deps por espaço só acontecem
 * quando explicitamente pedido (--real-gates → INHOUSE_FAKE_REAL_GATES=1).
 */
export function fakeRealGates(): boolean {
  return Boolean(process.env.INHOUSE_FAKE_REAL_GATES);
}
