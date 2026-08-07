/**
 * Anexos (upload + guarda de path) e artefatos (docs/protótipo acessíveis a
 * qualquer momento). Sobe o router real num express, com uma tarefa cujo espaço
 * tem docs e um mockup no disco.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
let anexosDir = "";

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-anexos-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  mkdirSync(join(base, "data"), { recursive: true });
  mkdirSync(join(base, "projects"), { recursive: true });
  vi.resetModules();
  const store = await import("../server/store.js");
  const { buildRouter } = await import("../server/api/routes.js");
  const { slugify } = await import("../server/services/worktrees.js");
  const config = await import("../server/config.js");
  anexosDir = config.ANEXOS_DIR;
  store.load(); // ensureDirs(): cria TRANSCRIPTS_DIR/ANEXOS_DIR (o steer grava transcript)

  const wt = join(base, "espaco");
  const project: Project = {
    id: "p-art",
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
    title: "Filtro de Turmas",
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

  // O espaço é um repo git de verdade: a detecção de "docs da tarefa" compara com a
  // branch base. Base (main) tem docs pré-existentes do repo; a branch da tarefa
  // adiciona/modifica os seus. Só o que a tarefa mexeu deve aparecer.
  const g = (...args: string[]): void => {
    execFileSync("git", args, { cwd: wt, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  };
  const plans = join(wt, "docs", "plans");
  mkdirSync(join(plans, "design"), { recursive: true });
  g("init", "-b", "main");
  g("config", "user.email", "qa@inhouse.test");
  g("config", "user.name", "QA");
  // Docs que JÁ existiam no repo (não são desta tarefa):
  writeFileSync(join(plans, "base-existente.md"), "# Base\nJá existia no repo.");
  writeFileSync(join(plans, "editado.md"), "# Editado\nversão base.");
  g("add", "docs");
  g("commit", "-m", "docs base do repo");
  // Branch da tarefa:
  g("checkout", "-b", "tarefa/filtro-1");
  // Doc pré-existente MODIFICADO pela tarefa (deve aparecer, via diff):
  writeFileSync(join(plans, "editado.md"), "# Editado\nversão alterada pela tarefa.");
  // Docs NOVOS da tarefa, ainda não versionados (devem aparecer, via untracked):
  writeFileSync(join(plans, "plano.md"), "# Plano\nConteúdo do plano.");
  writeFileSync(join(plans, "design", "notas.md"), "# Notas de design");
  // Mockup do protótipo (NÃO é "doc" — vira o botão Protótipo):
  const mock = join(plans, "mockups", slugify(task.title));
  mkdirSync(mock, { recursive: true });
  writeFileSync(join(mock, "index.html"), "<h1>Mock</h1>");

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

describe("anexos: upload", () => {
  it("grava o arquivo em ANEXOS_DIR e devolve o ref com caminho absoluto seguro", async () => {
    const res = await post("/api/anexos", {
      files: [{ nome: "captura.png", tipo: "image/png", dataBase64: Buffer.from("PNGDATA").toString("base64") }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { anexos: { nome: string; tipo: string; path: string }[] };
    expect(body.anexos).toHaveLength(1);
    expect(body.anexos[0]!.nome).toBe("captura.png");
    expect(body.anexos[0]!.path.startsWith(anexosDir)).toBe(true);
    expect(existsSync(body.anexos[0]!.path)).toBe(true);
    expect(readFileSync(body.anexos[0]!.path, "utf8")).toBe("PNGDATA");
  });

  it("aceita data URL (prefixo data:...;base64,) e saneia o nome do arquivo", async () => {
    const res = await post("/api/anexos", {
      files: [{ nome: "../../etc/passwd", tipo: "text/plain", dataBase64: "data:text/plain;base64," + Buffer.from("oi").toString("base64") }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { anexos: { nome: string; path: string }[] };
    // nome sem barras e o arquivo continua DENTRO de ANEXOS_DIR
    expect(body.anexos[0]!.nome).not.toContain("/");
    expect(body.anexos[0]!.path.startsWith(anexosDir)).toBe(true);
  });

  it("recusa upload sem arquivos (400)", async () => {
    const res = await post("/api/anexos", { files: [] });
    expect(res.status).toBe(400);
  });
});

describe("anexos: guarda de path ao referenciar", () => {
  it("rejeita um anexo cujo path está FORA de ANEXOS_DIR (anti leitura arbitrária)", async () => {
    const res = await post(`/api/tasks/${taskId}/message`, {
      text: "veja isto",
      anexos: [{ nome: "passwd", tipo: "", path: "/etc/passwd" }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/anexo/i);
  });

  it("aceita um anexo cujo path foi devolvido pelo upload (dentro de ANEXOS_DIR)", async () => {
    const up = await post("/api/anexos", {
      files: [{ nome: "doc.pdf", tipo: "application/pdf", dataBase64: Buffer.from("%PDF-1.4").toString("base64") }],
    });
    const { anexos } = (await up.json()) as { anexos: { path: string; nome: string; tipo: string }[] };
    const res = await post(`/api/tasks/${taskId}/message`, { text: "leia o anexo", anexos });
    expect(res.status).toBe(202);
  });
});

describe("artefatos: só os docs que a tarefa gerou + protótipo", () => {
  it("lista os .md novos e os modificados vs a base, exclui os pré-existentes e os mockups", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artefatos`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { temPrototipo: boolean; docs: { nome: string; rel: string }[] };
    expect(body.temPrototipo).toBe(true); // mockup no disco
    const rels = body.docs.map((d) => d.rel.replace(/\\/g, "/"));
    expect(rels).toContain("docs/plans/plano.md"); // novo (untracked)
    expect(rels).toContain("docs/plans/design/notas.md"); // novo aninhado
    expect(rels).toContain("docs/plans/editado.md"); // pré-existente MODIFICADO pela tarefa (via diff)
    expect(rels).not.toContain("docs/plans/base-existente.md"); // do repo, intocado → fora
    expect(rels.some((r) => r.includes("mockups"))).toBe(false); // protótipo não é "doc"
  });

  it("lê o conteúdo de um doc pelo rel (relativo à raiz do espaço)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artefatos/doc?rel=docs/plans/plano.md`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conteudo: string };
    expect(body.conteudo).toContain("Conteúdo do plano");
  });

  it("bloqueia path traversal no rel do doc (400)", async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/artefatos/doc?rel=../../../etc/passwd`);
    expect(res.status).toBe(400);
  });
});
