/**
 * Testes dos gates: detecção conforme package.json/tsconfig e execução real
 * de comandos triviais (via npm run) em fixtures temporários.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Sem SSE nem escrita de transcript real nos testes.
vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
vi.mock("../server/store.js", () => ({ transcriptAppend: vi.fn() }));

import { broadcast } from "../server/events.js";
import { detectGates, mensagemTempoEsgotado, runGates } from "../server/services/gates.js";
import {
  VERIFICACAO_TIMEOUT_PADRAO_MIN,
  sanitizeVerificacoes,
  timeoutVerificacoesMs,
} from "../server/workflow/config.js";

/** Cria um diretório temporário com os arquivos dados (caminhos relativos). */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "inhouse-gates-"));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

describe("detectGates", () => {
  it("detecta typecheck, lint e test dos scripts do package.json, nesta ordem", () => {
    const dir = fixture({
      "package.json": JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" },
      }),
    });
    expect(detectGates(dir)).toEqual([
      { name: "TypeScript", command: ["npm", "run", "typecheck"] },
      { name: "Lint", command: ["npm", "run", "lint"] },
      { name: "Testes", command: ["npm", "run", "test"] },
    ]);
  });

  it("sem script typecheck mas com tsconfig.json cai no tsc via npx", () => {
    const dir = fixture({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "tsconfig.json": "{}",
    });
    expect(detectGates(dir)).toEqual([
      { name: "TypeScript", command: ["npx", "tsc", "--noEmit"] },
      { name: "Testes", command: ["npm", "run", "test"] },
    ]);
  });

  it("prefere o tsc local (node_modules/.bin) quando existe", () => {
    const dir = fixture({
      "package.json": JSON.stringify({ scripts: {} }),
      "tsconfig.json": "{}",
      "node_modules/.bin/tsc": "#!/bin/sh\nexit 0\n",
    });
    expect(detectGates(dir)).toEqual([
      { name: "TypeScript", command: ["node_modules/.bin/tsc", "--noEmit"] },
    ]);
  });

  it("sem package.json mas com tsconfig.json ainda detecta o gate de TypeScript", () => {
    const dir = fixture({ "tsconfig.json": "{}" });
    expect(detectGates(dir)).toEqual([{ name: "TypeScript", command: ["npx", "tsc", "--noEmit"] }]);
  });

  it("package.json inválido não derruba a detecção (segue sem scripts)", () => {
    const dir = fixture({ "package.json": "{quebrado", "tsconfig.json": "{}" });
    expect(detectGates(dir)).toEqual([{ name: "TypeScript", command: ["npx", "tsc", "--noEmit"] }]);
  });

  it("projeto sem nada configurado: nenhum gate (pular não é falhar)", () => {
    const dir = fixture({});
    expect(detectGates(dir)).toEqual([]);
  });
});

describe("runGates", () => {
  it("roda um gate que passa e um que falha, capturando o output da falha", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: "node -e \"console.error('lint quebrou de proposito'); process.exit(1)\"",
        },
      }),
    });

    const results = await runGates("t1", dir);
    expect(results).toHaveLength(2);

    const ts = results[0]!;
    expect(ts.name).toBe("TypeScript");
    expect(ts.command).toBe("npm run typecheck");
    expect(ts.ok).toBe(true);
    expect(ts.output).toBeUndefined();
    expect(ts.durationMs).toBeGreaterThanOrEqual(0);

    const lint = results[1]!;
    expect(lint.name).toBe("Lint");
    expect(lint.ok).toBe(false);
    expect(lint.output).toContain("lint quebrou de proposito");

    // Não para no primeiro que falha e emite gate_result para cada um.
    const emitidos = vi
      .mocked(broadcast)
      .mock.calls.filter((c) => c[0].type === "gate_result");
    expect(emitidos).toHaveLength(2);
  });

  it("não vaza ANTHROPIC_API_KEY/AUTH_TOKEN para os comandos das verificações", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-teste-vazamento";
    process.env.ANTHROPIC_AUTH_TOKEN = "tok-teste-vazamento";
    try {
      const dir = fixture({
        "package.json": JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          scripts: {
            // Sai com erro se enxergar qualquer um dos segredos.
            test: 'node -e "process.exit(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? 1 : 0)"',
          },
        }),
      });
      const results = await runGates("t-env", dir);
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });

  it("estouro de tempo vira timedOut com mensagem clara (não é falha de teste)", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: { test: 'node -e "console.log(\'rodando\'); setTimeout(() => {}, 60000)"' },
      }),
    });

    const results = await runGates("t-timeout", dir, { timeoutMs: 1500 });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.output).toContain("Tempo esgotado");
    expect(r.output).toContain("NÃO quer dizer que algo falhou");
    expect(r.durationMs).toBeLessThan(30_000);
  }, 20_000);

  it("usa verificacoes.timeoutMinutos do inhouse.config.json do projeto", () => {
    const dir = fixture({ "inhouse.config.json": JSON.stringify({ verificacoes: { timeoutMinutos: 45 } }) });
    expect(timeoutVerificacoesMs(dir)).toBe(45 * 60_000);
    // Pasta principal vale quando o espaço não tem o arquivo.
    const vazio = fixture({ "package.json": "{}" });
    expect(timeoutVerificacoesMs(vazio, dir)).toBe(45 * 60_000);
  });

  it("limite padrão é 30 min; valor fora de 1–240 é ignorado", () => {
    expect(sanitizeVerificacoes({ timeoutMinutos: 0 })).toBeUndefined();
    expect(sanitizeVerificacoes({ timeoutMinutos: 999 })).toBeUndefined();
    expect(sanitizeVerificacoes({ timeoutMinutos: "20" })).toBeUndefined();
    expect(sanitizeVerificacoes({ timeoutMinutos: 20.4 })).toEqual({ timeoutMinutos: 20 });
    expect(VERIFICACAO_TIMEOUT_PADRAO_MIN).toBe(30);
    expect(mensagemTempoEsgotado(30 * 60_000)).toContain("30 minutos");
  });

  it("comando que nem existe conta como falha, não como exceção", async () => {
    const dir = fixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        scripts: { test: "comando-que-nao-existe-xyz-123" },
      }),
    });

    const results = await runGates("t2", dir);
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("Testes");
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.output).toBeTruthy();
  });
});
