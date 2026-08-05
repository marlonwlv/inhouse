/**
 * Testes do contrato de erro da API: TODA resposta de erro é JSON {error} em
 * pt-BR — inclusive as que nascem em middleware (JSON malformado, body grande)
 * e tentativas de path traversal no id do transcript.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-api-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
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

async function post(path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("contrato de erro em JSON pt-BR", () => {
  it("JSON malformado no body vira 400 JSON (não a página HTML do Express)", async () => {
    const res = await post("/api/projects/clone", "{isso não é json");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/entender os dados/);
  });

  it("body maior que o limite vira 413 JSON amigável", async () => {
    const res = await post("/api/projects/clone", JSON.stringify({ url: "x".repeat(1_200_000) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/grandes demais/);
  });

  it("campo obrigatório ausente vira 400 com instrução", async () => {
    const res = await post("/api/projects/open", JSON.stringify({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Informe/);
  });

  it("ação desconhecida em /action vira 400 sem tocar na tarefa", async () => {
    const res = await post("/api/tasks/qualquer/action", JSON.stringify({ action: "rm -rf" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Ação inválida/);
  });

  it("id de transcript com path traversal cai no 404 (id precisa existir no store)", async () => {
    const id = encodeURIComponent("../../../etc/passwd");
    const res = await fetch(`${baseUrl}/api/tasks/${id}/transcript`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Tarefa não encontrada/);
  });
});
