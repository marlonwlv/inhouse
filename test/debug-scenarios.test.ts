/**
 * Guarda de consistência do catálogo de cenários: pega drift de copy-paste
 * (ids duplicados, expectSteps vazio, flags incoerentes) sem rodar nada pesado.
 */
import { describe, expect, it } from "vitest";
import { SCENARIOS, findScenario } from "../server/debug/scenarios.js";

describe("catálogo de cenários de debug", () => {
  it("ids são únicos e não-vazios, e findScenario acha cada um", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.id.length).toBeGreaterThan(0);
      expect(findScenario(s.id)).toBe(s);
    }
    expect(findScenario("nao-existe")).toBeUndefined();
  });

  it("flags coerentes: requerRealGates ⇒ gates 'real'; expectSteps não-vazio e terminal coerente", () => {
    for (const s of SCENARIOS) {
      if (s.requerRealGates) expect(s.gates).toBe("real");
      expect(s.expectSteps.length).toBeGreaterThan(0);
      const ultimo = s.expectSteps[s.expectSteps.length - 1];
      // concluída termina em "concluida"; falhou pára antes do fim.
      if (s.expectFinal === "concluida") expect(ultimo).toBe("concluida");
    }
  });
});
