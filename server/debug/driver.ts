/**
 * Auto-piloto de uma jornada de debug: observa o task e aplica as ações das
 * porteiras humanas (aprovar plano/protótipo/teste, publicar) até o estado
 * terminal. Usado tanto pelo runner headless quanto pela UI (autoDrive).
 */
import { isHumanStep } from "../../shared/types.js";
import type { Step, Task, TaskStatus } from "../../shared/types.js";
import { applyAction } from "../workflow/machine.js";
import * as store from "../store.js";
import type { DebugScenario } from "./scenarios.js";

const TERMINAIS: readonly TaskStatus[] = ["concluida", "cancelada", "falhou"];

export interface DriveResult {
  finalStatus: TaskStatus;
  finalStep: Step;
  /** Steps distintos, na ordem de primeira aparição. */
  steps: Step[];
  timedOut: boolean;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Steps distintos que o task percorreu, pela ordem do histórico. */
export function stepsPercorridos(task: Task): Step[] {
  const seen = new Set<Step>();
  const out: Step[] = [];
  for (const h of task.historico ?? []) {
    if (!seen.has(h.step)) {
      seen.add(h.step);
      out.push(h.step);
    }
  }
  return out;
}

export async function driveToEnd(
  taskId: string,
  scenario: DebugScenario,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<DriveResult> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const pollMs = opts?.pollMs ?? 15;
  const inicio = Date.now();
  let designAplicado = false;
  let ultimoErro: string | undefined;

  while (true) {
    const t = store.getTask(taskId);
    if (!t) {
      return { finalStatus: "falhou", finalStep: "espec", steps: [], timedOut: false, error: "tarefa não encontrada" };
    }
    if (TERMINAIS.includes(t.status)) {
      return { finalStatus: t.status, finalStep: t.step, steps: stepsPercorridos(t), timedOut: false };
    }
    if (Date.now() - inicio > timeoutMs) {
      // Se um applyAction vinha falhando de verdade, o erro aparece aqui em vez
      // de sumir como um "timeout" genérico (o debug existe para expor bugs).
      return { finalStatus: t.status, finalStep: t.step, steps: stepsPercorridos(t), timedOut: true, error: ultimoErro ?? "timeout" };
    }

    if (t.status === "aguardando" && isHumanStep(t.step)) {
      try {
        if (t.step === "aprovacao") {
          if (scenario.setDesign && !designAplicado) {
            await applyAction(taskId, { action: "set_design", valor: scenario.setDesign });
            designAplicado = true;
          } else {
            await applyAction(taskId, {
              action: "approve_plan",
              ...(scenario.bypass === "approve_plan_direto" ? { direto: true } : {}),
            });
          }
        } else if (t.step === "aprovacao_prototipo") {
          await applyAction(taskId, { action: "approve_prototype" });
        } else if (t.step === "teste") {
          await applyAction(taskId, { action: "approve_test" });
        } else if (t.step === "publicar") {
          await applyAction(taskId, { action: "publish", createPr: false });
        }
      } catch (e) {
        // Em geral é corrida (o status mudou entre ler e agir) — reavalia no
        // próximo loop. Mas guardamos o erro: se persistir até o timeout, ele
        // aparece no resultado em vez de sumir silenciosamente.
        ultimoErro = e instanceof Error ? e.message : String(e);
      }
    }

    await sleep(pollMs);
  }
}
