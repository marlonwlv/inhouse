/**
 * Testes do preview: alocação de porta livre, dedupe de starts concorrentes,
 * env sem segredos da Anthropic no dev server e kill da árvore de processos.
 * Sobe um "dev server" de verdade via npm run num fixture temporário.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, Task } from "../shared/types.js";

// Sem SSE nem store real: o preview só precisa de getTask/updateTask.
vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
vi.mock("../server/store.js", () => ({
  getTask: vi.fn(() => undefined),
  updateTask: vi.fn((id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
}));

import { portaLivre, startPreview, stopPreview } from "../server/services/preview.js";

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
 * Fixture com um "dev server": grava pid + segredos vistos em info.txt e só
 * depois imprime a URL (montada por concatenação — assim o eco do comando pelo
 * npm não contém uma URL literal que resolveria o start cedo demais).
 */
function fixtureDevServer(): string {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-preview-"));
  const devScript =
    `node -e "const fs=require('fs');` +
    `fs.appendFileSync('info.txt',process.pid+'|'+(process.env.ANTHROPIC_API_KEY||'')+'|'+(process.env.ANTHROPIC_AUTH_TOKEN||'')+'\\n');` +
    `console.log('http://127.0.0.1:'+65432+'/');setInterval(function(){},1000)"`;
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-preview", version: "1.0.0", scripts: { dev: devScript } }),
  );
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
});
