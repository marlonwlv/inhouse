/**
 * Preview fake: roteamento (rota conhecida vs. livre), escaping do path (o único
 * caminho com input arbitrário), reuso do server por tarefa e — o principal — que
 * uma URL malformada digitada na barra NÃO derruba o processo.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/events.js", () => ({ broadcast: () => {} }));
vi.mock("../server/store.js", () => ({
  getTask: () => undefined,
  updateTask: (_id: string, p: Record<string, unknown>) => ({ id: "t", ...p }),
}));

const { startFakePreview, stopFakePreview, stopAllFakePreviews } = await import("../server/debug/fakePreview.js");

afterAll(() => stopAllFakePreviews());

describe("fakePreview", () => {
  it("serve rota conhecida e rota livre, reusa o server e escapa HTML do path", async () => {
    const task = { id: "t1", espaco: 1 } as never;
    const url = await startFakePreview(task);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    expect(await (await fetch(`${url}produtos`)).text()).toContain("Produtos");

    const livre = await (await fetch(`${url}x%3Cscript%3E`)).text();
    expect(livre).toContain("Rota livre");
    expect(livre).not.toContain("<script>"); // path escapado

    // Reusa o mesmo server (mesma URL) em vez de subir outro.
    expect(await startFakePreview(task)).toBe(url);
    stopFakePreview("t1");
  });

  it("URL malformada não derruba o server (decodeURIComponent protegido)", async () => {
    const task = { id: "t2", espaco: 2 } as never;
    const url = await startFakePreview(task);
    const res = await fetch(`${url}%zz`); // percent-encoding inválido
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Rota livre");
    stopFakePreview("t2");
  });
});
