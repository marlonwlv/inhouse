/**
 * Verificações automáticas ("gates") rodadas no worktree após a execução:
 * TypeScript, Lint e Testes — conforme o que o projeto tiver configurado.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "../../shared/types.js";
import { broadcast } from "../events.js";
import { transcriptAppend } from "../store.js";
import { lastLines } from "./proc.js";

const GATE_TIMEOUT_MS = 5 * 60 * 1000;

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

/** Roda todos os gates em sequência (não para no primeiro que falhar). */
export async function runGates(taskId: string, worktreePath: string): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of detectGates(worktreePath)) {
    const result = await runGate(gate, worktreePath);
    results.push(result);
    broadcast({ type: "gate_result", taskId, gate: result });
    const item = {
      kind: "system" as const,
      text: `Verificação ${result.name}: ${result.ok ? "passou" : "falhou"}`,
      at: new Date().toISOString(),
    };
    transcriptAppend(taskId, item);
    broadcast({ type: "transcript", taskId, item });
  }
  return results;
}

function runGate(gate: { name: string; command: string[] }, cwd: string): Promise<GateResult> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const [cmd, ...args] = gate.command;
    // CI=1 evita que test runners (vitest etc.) entrem em modo watch e nunca terminem.
    const child = spawn(cmd ?? "", args, {
      cwd,
      env: { ...process.env, CI: "1" },
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
      child.kill("SIGKILL");
    }, GATE_TIMEOUT_MS);

    const fim = (ok: boolean, extra?: string) => {
      clearTimeout(timer);
      const result: GateResult = {
        name: gate.name,
        command: gate.command.join(" "),
        ok,
        durationMs: Date.now() - inicio,
      };
      if (!ok) result.output = lastLines([out, extra].filter(Boolean).join("\n"), 60);
      resolve(result);
    };

    child.on("error", (err) => fim(false, `Não foi possível rodar o comando: ${err.message}`));
    child.on("close", (code) => {
      if (estourou) fim(false, "Tempo esgotado (5 minutos) — a verificação foi interrompida.");
      else fim(code === 0);
    });
  });
}
