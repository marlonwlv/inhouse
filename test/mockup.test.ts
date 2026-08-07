/**
 * Serve do mockup (protótipo). Regressão do bug em que o protótipo de alta
 * fidelidade aparecia CRU: /mockup (sem barra) fazia os assets relativos
 * (styles.css, app.js, *.html) resolverem para /api/tasks/:id/<asset> e dar 404.
 * A correção redireciona /mockup -> /mockup/ para tudo cair em /mockup/*.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../shared/types.js";

let server: Server;
let baseUrl = "";
let taskId = "";

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-mockup-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  mkdirSync(join(base, "data"), { recursive: true }); // o store persiste state.json aqui
  mkdirSync(join(base, "projects"), { recursive: true });
  vi.resetModules();
  const store = await import("../server/store.js");
  const { buildRouter } = await import("../server/api/routes.js");
  const { slugify } = await import("../server/services/worktrees.js");

  const wt = join(base, "espaco");
  const project: Project = {
    id: "p-mk",
    name: "proj",
    kind: "repo",
    path: join(base, "proj"),
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
  store.addProject(project);
  const now = new Date().toISOString();
  const task: Task = {
    id: store.newId(),
    projectId: project.id,
    title: "Auditoria de Presenças",
    description: "x",
    step: "aprovacao_prototipo",
    status: "aguardando",
    espaco: 1,
    branch: "b",
    worktreePath: wt,
    gates: [],
    gateFixRounds: 0,
    createdAt: now,
    updatedAt: now,
  };
  store.addTask(task);
  taskId = task.id;

  const dir = join(wt, "docs", "plans", "mockups", slugify(task.title));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), '<!doctype html><link rel="stylesheet" href="styles.css"><h1>Mock</h1>');
  writeFileSync(join(dir, "styles.css"), "h1{color:red}");

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

describe("serve do mockup (protótipo)", () => {
  it("/mockup sem barra redireciona para /mockup/ (assets relativos resolvem certo)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/mockup`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/api/tasks/${taskId}/mockup/`);
  });

  it("/mockup/ serve o index.html (sem loop de redirect)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/mockup/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<h1>Mock</h1>");
  });

  it("o styles.css relativo agora é servido (era o 404 que deixava o protótipo cru)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/mockup/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("asset na raiz da task (o que o browser pedia antes, sem a barra) continua 404", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/styles.css`);
    expect(res.status).toBe(404);
  });
});
