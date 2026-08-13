/**
 * Estado do preview como cidadão de primeira classe. Módulo-FOLHA (só store +
 * events): preview.ts, fakePreview.ts e machine.ts importam daqui sem criar
 * ciclo (o conserto automático se inscreve em previewEvents; preview.ts emite).
 */
import { EventEmitter } from "node:events";
import type { PreviewInfo, PreviewStatus } from "../../shared/types.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";

/**
 * Eventos do ciclo de vida do preview. Hoje só "crash":
 *   previewEvents.on("crash", ({ taskId, logsTail }) => …)
 * emitido quando o dev server morre sozinho (não por stop).
 */
export const previewEvents = new EventEmitter();

/**
 * Transiciona o estado do preview de uma tarefa e publica para a UI
 * (`preview_status` + `task_updated`). O `info` SUBSTITUI o estado anterior
 * (cada transição descreve o estado completo); `desde` é preenchido quando o
 * status muda. `previewUrl` é mantido como espelho de `info.url` (compat).
 */
export function setPreviewInfo(taskId: string, info: Omit<PreviewInfo, "desde">): void {
  const task = store.getTask(taskId);
  if (!task) return;
  const anterior = task.preview;
  const preview: PreviewInfo = {
    ...info,
    desde: info.status === anterior?.status ? (anterior?.desde ?? new Date().toISOString()) : new Date().toISOString(),
  };
  const atualizado = store.updateTask(taskId, { preview, previewUrl: preview.url });
  broadcast({ type: "preview_status", taskId, preview });
  broadcast({ type: "task_updated", task: atualizado });
}

/** Status atual (ou "parado" quando a tarefa nunca teve preview). */
export function previewStatusAtual(taskId: string): PreviewStatus {
  return store.getTask(taskId)?.preview?.status ?? "parado";
}
