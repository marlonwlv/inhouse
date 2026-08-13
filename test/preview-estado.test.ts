/**
 * Testes do preview como estado de primeira classe: transições preview_status,
 * crash que emite evento (e preserva os logs), reinício atômico com separador
 * no registro e a rota reportada entrando na receita (healthPaths).
 * Sobe um dev server DE VERDADE num fixture temporário (como preview.test.ts).
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ServerEvent, Task } from "../shared/types.js";

// DATA_DIR temporário ANTES de importar (config lê o env no import) — a receita
// aprendida (previews/<projectId>.json) não pode vazar para ~/.inhouse.
const TMP = mkdtempSync(join(tmpdir(), "inhouse-preview-estado-"));
process.env.INHOUSE_DATA_DIR = join(TMP, "data");
process.env.INHOUSE_PROJECTS_DIR = join(TMP, "projects");

const mocks = vi.hoisted(() => {
  const tasks = new Map<string, Record<string, unknown>>();
  const events: { type: string }[] = [];
  return {
    tasks,
    events,
    getTask: (id: string) => tasks.get(id),
    updateTask: (id: string, patch: Record<string, unknown>) => {
      const t = tasks.get(id) ?? { id };
      Object.assign(t, patch);
      tasks.set(id, t);
      return t;
    },
    transcriptAppend: () => {},
    getProject: () => ({ id: "p-estado", name: "demo", path: "/tmp" }),
  };
});
vi.mock("../server/events.js", () => ({
  broadcast: (ev: { type: string }) => {
    mocks.events.push(ev);
  },
  addClient: () => {},
}));
vi.mock("../server/store.js", () => ({
  getTask: mocks.getTask,
  updateTask: mocks.updateTask,
  transcriptAppend: mocks.transcriptAppend,
  getProject: mocks.getProject,
}));

const preview = await import("../server/services/preview.js");
const { previewEvents } = await import("../server/services/previewState.js");

function tarefa(id: string, worktreePath: string): Task {
  const t: Task = {
    id,
    projectId: "p-estado",
    title: "Preview estado",
    description: "estado",
    step: "teste",
    status: "aguardando",
    espaco: 1,
    branch: `tarefa/${id}`,
    worktreePath,
    gates: [],
    gateFixRounds: 0,
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
  mocks.tasks.set(id, t as unknown as Record<string, unknown>);
  return t;
}

const projeto = { id: "p-estado", name: "demo", path: "/tmp" } as Project;

/** Fixture com dev server real (escuta de verdade; grava o pid em info.txt). */
function fixtureDevServer(porta: number): string {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-prev-estado-"));
  writeFileSync(
    join(dir, "server.js"),
    [
      "const http=require('http');const fs=require('fs');",
      "fs.appendFileSync('info.txt',process.pid+'\\n');",
      "console.log('boot do fixture');",
      `http.createServer((req,res)=>{res.writeHead(200);res.end('ok')}).listen(${porta},'127.0.0.1',()=>console.log('http://127.0.0.1:'+${porta}+'/'));`,
      "setInterval(()=>{},1000);",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-estado", version: "1.0.0", scripts: { dev: "node server.js" } }),
  );
  return dir;
}

function eventosDeStatus(): { type: string; preview?: { status: string } }[] {
  return mocks.events.filter((e) => e.type === "preview_status") as never;
}

beforeEach(() => {
  mocks.events.length = 0;
});
afterEach(async () => {
  for (const id of [...mocks.tasks.keys()]) await preview.stopPreview(id);
  mocks.tasks.clear();
});

describe("adicionarHealthPath (rota reportada entra na receita)", () => {
  it("cria/mescla a receita do projeto e rejeita rota inválida", () => {
    expect(preview.adicionarHealthPath("p-hp", "/admin/relatorios")).toBe(true);
    expect(preview.adicionarHealthPath("p-hp", "/outra")).toBe(true);
    expect(preview.adicionarHealthPath("p-hp", "/admin/relatorios")).toBe(true); // idempotente
    const file = join(process.env.INHOUSE_DATA_DIR!, "previews", "p-hp.json");
    expect(existsSync(file)).toBe(true);
    const receita = JSON.parse(readFileSync(file, "utf8"));
    expect(receita.healthPaths).toEqual(["/admin/relatorios", "/outra"]);

    expect(preview.adicionarHealthPath("p-hp", "sem-barra")).toBe(false);
    expect(preview.adicionarHealthPath("p-hp", "/com espaço")).toBe(false);
    expect(preview.adicionarHealthPath("p-hp", "/../fuga")).toBe(false);
  });
});

describe("estado de primeira classe", () => {
  it("start publica preparando→no_ar (com porta real) e stop publica parado", async () => {
    const dir = fixtureDevServer(65441);
    const t = tarefa("t-estado-1", dir);
    const url = await preview.startPreview(t, projeto, { verificarSaude: false });
    expect(url).toContain("65441");

    const seq = eventosDeStatus().map((e) => e.preview?.status);
    expect(seq[0]).toBe("preparando");
    expect(seq).toContain("no_ar");

    const st = preview.previewStatus(t.id);
    expect(st.status).toBe("no_ar");
    expect(st.porta).toBe(65441);
    expect(st.url).toContain("65441");
    expect(st.aviso).toContain("fonte da verdade");

    await preview.stopPreview(t.id);
    expect(preview.previewStatus(t.id).status).toBe("parado");
    expect(eventosDeStatus().map((e) => e.preview?.status)).toContain("parado");
  }, 15000);

  it("crash do dev server emite previewEvents 'crash', vira 'problema' e PRESERVA os logs", async () => {
    const dir = fixtureDevServer(65442);
    const t = tarefa("t-estado-2", dir);
    await preview.startPreview(t, projeto, { verificarSaude: false });

    const crash = new Promise<{ taskId: string; logsTail: string }>((resolve) => {
      previewEvents.once("crash", resolve);
    });
    // Mata o node do fixture por fora (como um crash de verdade).
    const pid = Number(readFileSync(join(dir, "info.txt"), "utf8").trim().split("\n")[0]);
    process.kill(pid, "SIGKILL");

    const ev = await crash;
    expect(ev.taskId).toBe(t.id);
    expect(ev.logsTail).toContain("boot do fixture"); // o log do processo morto sobrevive
    expect((mocks.tasks.get(t.id) as { preview?: { status: string } }).preview?.status).toBe("problema");
    expect(preview.previewLogs(t.id)).toContain("boot do fixture");
  }, 15000);

  it("detector: erro em runtime no registro acende preview.alerta com a rota", async () => {
    // Fixture cuja rota /quebrada loga uma linha de erro + uma linha de acesso 5xx.
    const dir = mkdtempSync(join(tmpdir(), "inhouse-prev-estado-"));
    writeFileSync(
      join(dir, "server.js"),
      [
        "const http=require('http');",
        "http.createServer((req,res)=>{",
        "  if(req.url==='/quebrada'){",
        "    console.log('Error: BOOM_ENV not set');",
        "    console.log('GET /quebrada 500 in 12ms');",
        "    res.writeHead(500);res.end('erro');return;",
        "  }",
        "  res.writeHead(200);res.end('ok');",
        `}).listen(65446,'127.0.0.1',()=>console.log('http://127.0.0.1:'+65446+'/'));`,
        "setInterval(()=>{},1000);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "fixture-alerta", version: "1.0.0", scripts: { dev: "node server.js" } }),
    );
    const t = tarefa("t-estado-5", dir);
    const url = await preview.startPreview(t, projeto, { verificarSaude: false });
    expect((mocks.tasks.get(t.id) as { preview?: { alerta?: unknown } }).preview?.alerta).toBeUndefined();

    await fetch(new URL("/quebrada", url)); // navega na tela quebrada
    await vi.waitFor(() => {
      const alerta = (mocks.tasks.get(t.id) as { preview?: { alerta?: { rota?: string; detalhe?: string } } })
        .preview?.alerta;
      expect(alerta?.rota).toBe("/quebrada");
      expect(alerta?.detalhe).toContain("BOOM_ENV");
    }, { timeout: 5000 });

    // O agente enxerga o alerta pela tool preview_status.
    expect(preview.previewStatus(t.id).alerta?.rota).toBe("/quebrada");
  }, 20000);

  it("URL anunciada em porta de OUTRO programa → falha explicada, nunca 'No ar' falso", async () => {
    // Um servidor "intruso" (do próprio teste, fora da árvore do preview) ocupa a porta 65444.
    const { createServer } = await import("node:http");
    const intruso = createServer((_req, res) => res.end("intruso"));
    await new Promise<void>((res) => intruso.listen(65444, "127.0.0.1", () => res()));
    try {
      // Fixture que ESCUTA em 65445 mas ANUNCIA a porta do intruso (65444) —
      // o caso real: dev script com porta fixa que já pertence a outra instância.
      const dir = mkdtempSync(join(tmpdir(), "inhouse-prev-estado-"));
      writeFileSync(
        join(dir, "server.js"),
        [
          "const http=require('http');",
          "http.createServer((req,res)=>{res.end('ok')}).listen(65445,'127.0.0.1',()=>console.log('http://127.0.0.1:'+65444+'/'));",
          "setInterval(()=>{},1000);",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "fixture-intruso", version: "1.0.0", scripts: { dev: "node server.js" } }),
      );
      const t = tarefa("t-estado-4", dir);
      await expect(preview.startPreview(t, projeto, { verificarSaude: false })).rejects.toThrow(/OUTRO programa/);
      expect((mocks.tasks.get(t.id) as { preview?: { status: string } }).preview?.status).toBe("problema");
    } finally {
      intruso.close();
    }
  }, 20000);

  it("restartPreview é atômico, mantém a porta e escreve o separador no registro", async () => {
    const dir = fixtureDevServer(65443);
    const t = tarefa("t-estado-3", dir);
    const url1 = await preview.startPreview(t, projeto, { verificarSaude: false });
    const { url: url2 } = await preview.restartPreview(t.id);
    expect(url2).toBe(url1); // mesma porta → mesma URL (iframe não muda à toa)
    const logs = preview.previewLogs(t.id);
    expect(logs).toContain("reinício do preview");
    // O registro contém os DOIS boots (o de antes do reinício não foi apagado).
    expect(logs.indexOf("boot do fixture")).not.toBe(logs.lastIndexOf("boot do fixture"));
  }, 20000);
});
