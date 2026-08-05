/**
 * Testes da serialização de operações git por projeto (publish/createEspaco
 * concorrentes no mesmo repositório não podem colidir em index.lock).
 */
import { describe, expect, it } from "vitest";
import { withProjectLock } from "../server/services/locks.js";

describe("withProjectLock", () => {
  it("serializa operações do mesmo projeto e não bloqueia projetos diferentes", async () => {
    const ordem: string[] = [];
    let liberaA!: () => void;
    const travaA = new Promise<void>((r) => {
      liberaA = r;
    });

    const p1 = withProjectLock("p1", async () => {
      ordem.push("a-inicio");
      await travaA;
      ordem.push("a-fim");
      return "a";
    });
    const p2 = withProjectLock("p1", async () => {
      ordem.push("b");
      return "b";
    });
    const outro = withProjectLock("p2", async () => {
      ordem.push("outro-projeto");
      return "outro";
    });

    // Outro projeto não espera o lock do p1; "b" segue na fila.
    await outro;
    expect(ordem).toEqual(["a-inicio", "outro-projeto"]);

    liberaA();
    await expect(p1).resolves.toBe("a");
    await expect(p2).resolves.toBe("b");
    expect(ordem).toEqual(["a-inicio", "outro-projeto", "a-fim", "b"]);
  });

  it("erro numa operação não trava a fila do projeto", async () => {
    await expect(
      withProjectLock("p3", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withProjectLock("p3", async () => "ok")).resolves.toBe("ok");
  });
});
