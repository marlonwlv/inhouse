/**
 * Rotas do painel de Debug (/api/debug/*). Montadas APENAS quando o modo fake
 * está ligado (isFakeModelActive) — um servidor normal nunca as expõe.
 */
import type { Router } from "express";
import * as store from "../store.js";
import { startPreparacao, startTask } from "../workflow/machine.js";
import { driveToEnd } from "./driver.js";
import { bindTask } from "./fakeModel.js";
import { activate } from "./fakeModel.js";
import { SCENARIOS, findScenario } from "./scenarios.js";

export function registerDebugRoutes(router: Router): void {
  // Catálogo de cenários (o que a UI mostra no seletor).
  router.get("/api/debug/scenarios", (_req, res) => {
    res.json({
      scenarios: SCENARIOS.map((s) => ({
        id: s.id,
        label: s.label,
        descricao: s.descricao,
        porte: s.porte,
        ui: s.ui,
        design: s.design,
        gates: s.gates,
        bypass: s.bypass ?? null,
        setDesign: s.setDesign ?? null,
        preparacao: Boolean(s.preparacao),
        requerRealGates: Boolean(s.requerRealGates),
        expectSteps: s.expectSteps,
        expectFinal: s.expectFinal,
      })),
    });
  });

  // Dispara um cenário: liga o fake, cria a tarefa e (opcional) dirige as porteiras.
  router.post("/api/debug/run", (req, res) => {
    void (async () => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const projectId = String(body.projectId ?? "");
        const scenarioId = String(body.scenarioId ?? "");
        const autoDrive = body.autoDrive !== false; // default: true
        const scenario = findScenario(scenarioId);
        if (!scenario) return res.status(400).json({ error: "Cenário de debug desconhecido." });
        if (!store.getProject(projectId)) return res.status(404).json({ error: "Projeto não encontrado." });

        activate(scenario);
        const task = scenario.preparacao
          ? await startPreparacao(projectId)
          : await startTask(projectId, scenario.label, scenario.descricao);
        bindTask(task.id, scenario);

        // Auto-piloto no server: as porteiras se aprovam sozinhas (a UI só assiste).
        if (autoDrive) void driveToEnd(task.id, scenario).catch(() => {});

        return res.json({ task, autoDrive });
      } catch (err) {
        return res.status(500).json({ error: err instanceof Error ? err.message : "Erro no debug." });
      }
    })();
  });
}
