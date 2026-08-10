/**
 * Testes do preview: alocação de porta livre, dedupe de starts concorrentes,
 * env sem segredos da Anthropic no dev server e kill da árvore de processos.
 * Sobe um "dev server" de verdade via npm run num fixture temporário.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../shared/types.js";

// Sem SSE nem store real: o preview só precisa de getTask/updateTask/transcriptAppend.
vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
vi.mock("../server/store.js", () => ({
  getTask: vi.fn(() => undefined),
  updateTask: vi.fn((id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
  transcriptAppend: vi.fn(),
}));

import {
  PreviewQuebradoError,
  autoDetectar,
  parsePreviewRecipe,
  portaLivre,
  previewLogs,
  startPreview,
  stopPreview,
  verificarSaude,
} from "../server/services/preview.js";
import { sanitizePreview } from "../server/workflow/config.js";

function tarefa(worktreePath: string): Task {
  return {
    id: "t-preview",
    projectId: "p1",
    title: "Preview",
    description: "preview",
    step: "teste",
    status: "aguardando",
    espaco: 1,
    branch: "tarefa/preview-1",
    worktreePath,
    gates: [],
    gateFixRounds: 0,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
  };
}

const projeto = { id: "p1" } as Project;

/**
 * Escreve um server.js que grava pid + segredos vistos em info.txt, ESCUTA de
 * verdade numa porta fixa (o health-check precisa de um socket vivo) e serve
 * `corpo`. Lê um marcador no boot (`had`) para provar a ordem setup→cmd. A URL é
 * impressa concatenando a porta (não fica literal no eco do comando).
 */
function escreverServidor(dir: string, porta: number, corpo: string): void {
  writeFileSync(
    join(dir, "server.js"),
    [
      "const http=require('http');const fs=require('fs');",
      "fs.appendFileSync('info.txt',process.pid+'|'+(process.env.ANTHROPIC_API_KEY||'')+'|'+(process.env.ANTHROPIC_AUTH_TOKEN||'')+'\\n');",
      "const had=fs.existsSync('marcador');",
      `http.createServer((req,res)=>{ ${corpo} }).listen(${porta},'127.0.0.1',()=>console.log('http://127.0.0.1:'+${porta}+'/'));`,
      "setInterval(()=>{},1000);",
    ].join("\n"),
  );
}

/** Fixture com dev server auto-detectável (scripts.dev) — responde `corpo` (default 200). */
function fixtureDevServer(porta = 65432, corpo = "res.writeHead(200);res.end('ok')"): string {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-preview-"));
  escreverServidor(dir, porta, corpo);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-preview", version: "1.0.0", scripts: { dev: "node server.js" } }),
  );
  return dir;
}

/** Fixture com bloco `preview` commitado (inhouse.config.json) — cmd/setup/healthPaths. */
function fixtureComPreview(porta: number, corpo: string, preview: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-preview-"));
  escreverServidor(dir, porta, corpo);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-preview", version: "1.0.0" }));
  writeFileSync(join(dir, "inhouse.config.json"), JSON.stringify({ preview }));
  return dir;
}

/** Espera o processo morrer (kill 0 lança quando o pid não existe mais). */
async function esperaMorrer(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

describe("portaLivre", () => {
  it("pula uma porta ocupada e devolve a próxima livre", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const ocupada = (srv.address() as AddressInfo).port;
    try {
      const livre = await portaLivre(ocupada);
      expect(livre).not.toBe(ocupada);
      expect(livre).toBeGreaterThan(ocupada);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("pula uma porta ocupada SÓ em IPv6 (::) — o caso do next dev órfão", async () => {
    const srv = createServer();
    const ok = await new Promise<boolean>((r) => {
      srv.once("error", () => r(false));
      srv.listen(0, "::", () => r(true));
    });
    if (!ok) return; // IPv6 indisponível nesta máquina — nada a testar
    const ocupada = (srv.address() as AddressInfo).port;
    try {
      const livre = await portaLivre(ocupada);
      expect(livre).not.toBe(ocupada); // antes do fix, entregaria a porta ocupada em ::
      expect(livre).toBeGreaterThan(ocupada);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("startPreview/stopPreview", () => {
  it("dois starts concorrentes = um único dev server, sem segredos no env, morto pelo stop", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-teste-vazamento";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-teste-vazamento";
    const dir = fixtureDevServer();
    const task = tarefa(dir);

    // Dois cliques "ao mesmo tempo" compartilham o mesmo start (dedupe).
    const [u1, u2] = await Promise.all([startPreview(task, projeto), startPreview(task, projeto)]);
    expect(u1).toBe("http://127.0.0.1:65432/");
    expect(u2).toBe(u1);

    const linhas = readFileSync(join(dir, "info.txt"), "utf8").trim().split("\n");
    // Um único processo subiu (sem o dedupe seriam dois — e um ficaria órfão).
    expect(linhas).toHaveLength(1);
    const [pidStr, key, token] = linhas[0]!.split("|");
    // O dev server roda código do projeto: não pode ver os segredos da Anthropic.
    expect(key).toBe("");
    expect(token).toBe("");

    // stopPreview mata a árvore inteira (npm → sh → node) via grupo de processo.
    const pid = Number(pidStr);
    expect(pid).toBeGreaterThan(0);
    await stopPreview(task.id);
    expect(await esperaMorrer(pid)).toBe(true);
  });

  it("guarda os logs (stdout) do dev server para diagnóstico", async () => {
    const dir = fixtureDevServer(65431);
    const task = tarefa(dir);
    await startPreview(task, projeto);
    // O server imprime a URL no boot via console.log — tem que estar nos logs.
    expect(previewLogs(task.id)).toContain("http://127.0.0.1:65431/");
    await stopPreview(task.id);
    // Os logs sobrevivem ao stop (para diagnosticar uma falha depois de derrubar).
    expect(previewLogs(task.id)).toContain("http://127.0.0.1:65431/");
  });
});

describe("health-check no start", () => {
  it("app que dá 500 na raiz não sobe: lança PreviewQuebradoError", async () => {
    const dir = fixtureDevServer(65433, "res.writeHead(500);res.end('boom')");
    const task = tarefa(dir);
    await expect(startPreview(task, projeto)).rejects.toBeInstanceOf(PreviewQuebradoError);
    await stopPreview(task.id);
  });

  it("roda o `setup` da receita ANTES do `cmd` (o server só dá 200 com o marcador)", async () => {
    // O server responde 200 só se `marcador` existir no boot; o setup o cria.
    // Um start bem-sucedido prova que o setup rodou antes do cmd.
    const dir = fixtureComPreview(65435, "res.writeHead(had?200:500);res.end(had?'ok':'no-setup')", {
      cmd: "node server.js",
      setup: ["touch marcador"],
      healthPaths: ["/"],
    });
    const task = tarefa(dir);
    const url = await startPreview(task, projeto);
    expect(url).toBe("http://127.0.0.1:65435/");
    expect(existsSync(join(dir, "marcador"))).toBe(true);
    await stopPreview(task.id);
  });
});

describe("verificarSaude", () => {
  it("200/302 = saudável; 500 = quebrado com status; respeita healthPaths", async () => {
    const { createServer: createHttp } = await import("node:http");
    const srv = createHttp((req, res) => {
      if (req.url === "/bad") {
        res.writeHead(500);
        res.end("boom");
      } else if (req.url === "/red") {
        res.writeHead(302, { location: "/login" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("ok");
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/`;
    try {
      expect((await verificarSaude(base, null)).ok).toBe(true); // raiz 200
      expect((await verificarSaude(base, { healthPaths: ["/red"] })).ok).toBe(true); // 302 = ok
      const ruim = await verificarSaude(base, { healthPaths: ["/bad"] });
      expect(ruim.ok).toBe(false);
      expect(ruim.status).toBe(500);
      expect(ruim.rota).toBe("/bad");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

describe("sanitizePreview", () => {
  it("aceita um bloco válido e descarta caminhos perigosos", () => {
    const cfg = sanitizePreview({
      cmd: "pnpm --filter web dev",
      cwd: "apps/web",
      port: 3000,
      envFiles: [".env.local", "../secret"],
      timeoutMs: 60000,
    });
    expect(cfg?.cmd).toBe("pnpm --filter web dev");
    expect(cfg?.cwd).toBe("apps/web");
    expect(cfg?.port).toBe(3000);
    expect(cfg?.envFiles).toEqual([".env.local"]); // ../secret é rejeitado
    expect(cfg?.timeoutMs).toBe(60000);
  });

  it("sanitiza setup (comandos, descarta vazios/não-string) e healthPaths (só rotas com /)", () => {
    const cfg = sanitizePreview({
      cmd: "x",
      setup: ["docker compose up -d", "   ", 123, "migrate"],
      healthPaths: ["/", "/backoffice", "sem-barra", 5],
    });
    expect(cfg?.setup).toEqual(["docker compose up -d", "migrate"]);
    expect(cfg?.healthPaths).toEqual(["/", "/backoffice"]); // "sem-barra" e 5 rejeitados
  });

  it("rejeita cwd que escapa da pasta e porta inválida", () => {
    const cfg = sanitizePreview({ cmd: "x", cwd: "../..", port: 99999 });
    expect(cfg?.cwd).toBeUndefined();
    expect(cfg?.port).toBeUndefined();
  });

  it("descarta readyRegex inválido mas mantém o resto", () => {
    const cfg = sanitizePreview({ cmd: "x", readyRegex: "(" });
    expect(cfg?.readyRegex).toBeUndefined();
    expect(cfg?.cmd).toBe("x");
  });

  it("objeto vazio ou não-objeto vira undefined", () => {
    expect(sanitizePreview({})).toBeUndefined();
    expect(sanitizePreview(null)).toBeUndefined();
    expect(sanitizePreview("x")).toBeUndefined();
  });
});

describe("parsePreviewRecipe", () => {
  it("extrai de um bloco ```json e força a porta reservada", () => {
    const txt =
      'Descobri o comando.\n```json\n{ "cmd": "pnpm --filter web dev", "cwd": "apps/web", "port": 1234, "envFiles": [".env.local"] }\n```';
    const r = parsePreviewRecipe(txt, 4507);
    expect(r?.cmd).toBe("pnpm --filter web dev");
    expect(r?.cwd).toBe("apps/web");
    expect(r?.port).toBe(4507); // sobrescreve a porta que o agente escreveu
  });

  it("extrai de um objeto solto, sem cerca de código", () => {
    const r = parsePreviewRecipe('resultado final: { "cmd": "npm run dev" } pronto', 4500);
    expect(r?.cmd).toBe("npm run dev");
    expect(r?.port).toBe(4500);
  });

  it("sem cmd válido devolve null", () => {
    expect(parsePreviewRecipe('```json\n{ "port": 3000 }\n```', 4500)).toBeNull();
  });

  it("texto sem JSON devolve null", () => {
    expect(parsePreviewRecipe("não achei como subir", 4500)).toBeNull();
  });
});

describe("autoDetectar", () => {
  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "inh-detect-"));
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }

  it("npm + script dev, sem framework Vite-like", () => {
    const dir = fixtureDir({ "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }) });
    expect(autoDetectar(dir)).toEqual({ cmd: "npm", args: ["run", "dev"], viteLike: false });
  });

  it("pnpm pelo lockfile + vite pela dependência", () => {
    const dir = fixtureDir({
      "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "^5" } }),
      "pnpm-lock.yaml": "",
    });
    const d = autoDetectar(dir);
    expect(d?.cmd).toBe("corepack");
    expect(d?.args).toEqual(["pnpm", "run", "dev"]);
    expect(d?.viteLike).toBe(true);
  });

  it("cai para o script start quando não há dev", () => {
    const dir = fixtureDir({ "package.json": JSON.stringify({ scripts: { start: "next start" } }) });
    expect(autoDetectar(dir)?.args).toEqual(["run", "start"]);
  });

  it("sem script dev/start devolve null (degradação graciosa)", () => {
    const dir = fixtureDir({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) });
    expect(autoDetectar(dir)).toBeNull();
  });

  it("sem package.json devolve null", () => {
    expect(autoDetectar(fixtureDir({}))).toBeNull();
  });
});
