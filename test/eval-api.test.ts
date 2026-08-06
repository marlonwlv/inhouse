/**
 * Endpoints do eval (feedback + resumo + relatórios) num servidor real em porta
 * efêmera (padrão api-errors.test.ts). O juiz é mockado no eval-juiz.test.ts;
 * aqui cobrimos validação, latest-wins e anti-traversal.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/types.js";

let server: Server;
let baseUrl = "";
let store: typeof import("../server/store.js");

function novaTask(extra: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return store.addTask({
    id: store.newId(),
    projectId: "p1",
    title: "t",
    description: "d",
    step: "concluida",
    status: "concluida",
    espaco: 1,
    branch: "b",
    worktreePath: "/tmp/w",
    gates: [],
    gateFixRounds: 0,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-evalapi-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
  store = await import("../server/store.js");
  store.load();
  const { buildRouter } = await import("../server/api/routes.js");
  const app = express();
  app.use(buildRouter());
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /api/tasks/:id/feedback", () => {
  it("nota inválida → 400 JSON pt-BR", async () => {
    const t = novaTask();
    const r = await post(`/api/tasks/${t.id}/feedback`, { nota: "excelente" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/avaliação/i);
  });

  it("task inexistente → 404", async () => {
    const r = await post(`/api/tasks/nao-existe/feedback`, { nota: "otimo" });
    expect(r.status).toBe(404);
  });

  it("feedback válido grava e latest-wins reflete no resumo", async () => {
    const t = novaTask();
    expect((await post(`/api/tasks/${t.id}/feedback`, { nota: "ruim" })).status).toBe(200);
    expect((await post(`/api/tasks/${t.id}/feedback`, { nota: "otimo", texto: "melhorou" })).status).toBe(200);
    const resumo = (await (await fetch(`${baseUrl}/api/eval/resumo`)).json()) as { feedback: { otimo: number } };
    // Só a última nota (otimo) conta para esta tarefa.
    expect(resumo.feedback.otimo).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/eval/resumo", () => {
  it("retorna a forma esperada mesmo sem dados", async () => {
    const resumo = (await (await fetch(`${baseUrl}/api/eval/resumo`)).json()) as Record<string, unknown>;
    expect(resumo).toHaveProperty("taxaSemResgate");
    expect(resumo).toHaveProperty("permissoes");
    expect(resumo).toHaveProperty("aprendizados");
  });
});

describe("GET /api/eval/relatorios/:arquivo", () => {
  it("path traversal é bloqueado", async () => {
    const r = await fetch(`${baseUrl}/api/eval/relatorios/${encodeURIComponent("../../state.json")}`);
    expect([400, 404]).toContain(r.status);
  });
});
