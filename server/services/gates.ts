/**
 * Verificações automáticas ("gates") rodadas no worktree após a execução:
 * TypeScript, Lint e Testes — conforme o que o projeto tiver configurado.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "../../shared/types.js";
import { claudeEnv } from "../config.js";
import { matarFilho, spawnOpcoes, spawnPortatil } from "../platform.js";
import { fakeGateResults } from "../debug/fakeModel.js";
import { isFakeModelActive } from "../debug/flag.js";
import { broadcast } from "../events.js";
import { transcriptAppend } from "../store.js";
import { timeoutVerificacoesMs } from "../workflow/config.js";
import { lastLines } from "./proc.js";

/** Minutos legíveis para as mensagens ("30 minutos", "1 minuto", "90 segundos"). */
export function duracaoLegivel(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} segundos`;
  const min = Math.round(ms / 60_000);
  return min === 1 ? "1 minuto" : `${min} minutos`;
}

/** Texto que acompanha uma verificação interrompida por tempo (não é falha do comando). */
export function mensagemTempoEsgotado(ms: number): string {
  return (
    `Tempo esgotado: a verificação passou do limite de ${duracaoLegivel(ms)} e foi interrompida. ` +
    "Isso NÃO quer dizer que algo falhou — ela só não terminou a tempo."
  );
}

export function detectGates(worktreePath: string): { name: string; command: string[] }[] {
  let scripts: Record<string, string> = {};
  const pkgPath = join(worktreePath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      scripts = pkg.scripts ?? {};
    } catch {
      // package.json inválido: segue sem scripts (gate nenhum via npm)
    }
  }

  const gates: { name: string; command: string[] }[] = [];
  if (scripts["typecheck"]) {
    gates.push({ name: "TypeScript", command: ["npm", "run", "typecheck"] });
  } else if (existsSync(join(worktreePath, "tsconfig.json"))) {
    // Projeto TS sem script typecheck: roda o tsc direto.
    const tscLocal = existsSync(join(worktreePath, "node_modules", ".bin", "tsc"));
    gates.push({
      name: "TypeScript",
      command: tscLocal ? ["node_modules/.bin/tsc", "--noEmit"] : ["npx", "tsc", "--noEmit"],
    });
  }
  if (scripts["lint"]) gates.push({ name: "Lint", command: ["npm", "run", "lint"] });
  if (scripts["test"]) gates.push({ name: "Testes", command: ["npm", "run", "test"] });
  return gates;
}

/** Anuncia um resultado de gate (SSE + transcript), como a UI espera. */
function reportarGate(taskId: string, result: GateResult): void {
  broadcast({ type: "gate_result", taskId, gate: result });
  const item = {
    kind: "system" as const,
    text: `Verificação ${result.name}: ${
      result.ok ? "passou" : result.timedOut ? "não terminou a tempo (limite de tempo esgotado)" : "falhou"
    }`,
    at: new Date().toISOString(),
  };
  transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

/**
 * Roda todos os gates em sequência (não para no primeiro que falhar). Cada um tem
 * o seu limite de tempo: `opts.timeoutMs` ou `verificacoes.timeoutMinutos` do
 * inhouse.config.json (espaço → pasta principal → global), padrão 30 min.
 */
export async function runGates(
  taskId: string,
  worktreePath: string,
  opts: { pastaPrincipal?: string; timeoutMs?: number } = {},
): Promise<GateResult[]> {
  // Modo debug: resultados canned por cenário (null = o cenário pede gates reais).
  const canned = isFakeModelActive() ? fakeGateResults(taskId) : null;
  if (canned) {
    for (const result of canned) reportarGate(taskId, result);
    return canned;
  }

  const timeoutMs = opts.timeoutMs ?? timeoutVerificacoesMs(worktreePath, opts.pastaPrincipal);
  const results: GateResult[] = [];
  for (const gate of detectGates(worktreePath)) {
    const result = await runGate(gate, worktreePath, timeoutMs);
    results.push(result);
    reportarGate(taskId, result);
  }
  return results;
}

function runGate(gate: { name: string; command: string[] }, cwd: string, timeoutMs: number): Promise<GateResult> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const [cmd, ...args] = gate.command;
    // CI=1 evita que test runners (vitest etc.) entrem em modo watch e nunca terminem.
    // claudeEnv(): os scripts do projeto rodam código arbitrário — não podem
    // ver ANTHROPIC_API_KEY/AUTH_TOKEN (decisão 1 da arquitetura).
    // spawnOpcoes(): grupo próprio no POSIX — no estouro de tempo derruba a árvore
    // inteira (npm → sh → vitest/turbo e workers). Matar só o npm deixava os
    // filhos rodando e segurando o stdout: o "close" só vinha quando a suíte
    // terminava sozinha, e o limite nem cortava de verdade.
    const child = spawnPortatil(cmd ?? "", args, {
      ...spawnOpcoes(),
      cwd,
      env: { ...claudeEnv(), CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const coleta = (d: Buffer) => {
      // Mantém só o final do output para não acumular memória em logs longos.
      out = lastLines(out + String(d), 200);
    };
    child.stdout?.on("data", coleta);
    child.stderr?.on("data", coleta);

    let estourou = false;
    const timer = setTimeout(() => {
      estourou = true;
      matarFilho(child, "SIGKILL", true); // grupo no POSIX; Windows: taskkill /T (npm.cmd → cmd.exe → node)
    }, timeoutMs);

    const fim = (ok: boolean, extra?: string) => {
      clearTimeout(timer);
      const result: GateResult = {
        name: gate.name,
        command: gate.command.join(" "),
        ok,
        durationMs: Date.now() - inicio,
      };
      if (!ok) result.output = lastLines([out, extra].filter(Boolean).join("\n"), 60);
      if (estourou) result.timedOut = true;
      resolve(result);
    };

    child.on("error", (err) => fim(false, `Não foi possível rodar o comando: ${err.message}`));
    child.on("close", (code) => {
      if (estourou) fim(false, mensagemTempoEsgotado(timeoutMs));
      else fim(code === 0);
    });
  });
}
