/**
 * Limitador global de concorrência (semáforo contável). O teto é lido de env no
 * import, então cada teste reimporta o módulo com o teto desejado.
 */
import { describe, expect, it, vi } from "vitest";

type Lim = typeof import("../server/services/limiter.js");

async function freshLimiter(max: number): Promise<Lim> {
  process.env.INHOUSE_MAX_CLAUDE = String(max);
  vi.resetModules();
  return import("../server/services/limiter.js");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("limiter: withLimit (semáforo global)", () => {
  it("respeita o teto: no máximo N em paralelo, o resto enfileira", async () => {
    const { withLimit } = await freshLimiter(2);
    let emCurso = 0;
    let pico = 0;
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const rodando = gates.map((g) =>
      withLimit("claude", async () => {
        emCurso++;
        pico = Math.max(pico, emCurso);
        await g.promise;
        emCurso--;
      }),
    );
    await tick(); // deixa os microtasks rodarem: só 2 devem ter começado
    expect(emCurso).toBe(2);

    gates.forEach((g) => g.resolve());
    await Promise.all(rodando);
    expect(pico).toBe(2); // nunca passou de 2 simultâneos
    expect(emCurso).toBe(0);
  });

  it("libera o slot mesmo quando fn lança (não trava a fila)", async () => {
    const { withLimit } = await freshLimiter(1);
    await expect(withLimit("claude", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    // Se o slot não fosse liberado no erro, este ficaria preso para sempre.
    let rodou = false;
    await withLimit("claude", async () => { rodou = true; });
    expect(rodou).toBe(true);
  });

  it("limiteInfo reflete teto, em uso e fila", async () => {
    const { withLimit, limiteInfo } = await freshLimiter(1);
    const g = deferred();
    const p = withLimit("claude", async () => { await g.promise; });
    const q = withLimit("claude", async () => {});
    await tick(10);
    const info = limiteInfo("claude");
    expect(info.max).toBe(1);
    expect(info.emUso).toBe(1);
    expect(info.fila).toBe(1);
    g.resolve();
    await Promise.all([p, q]);
    expect(limiteInfo("claude").emUso).toBe(0);
  });
});
