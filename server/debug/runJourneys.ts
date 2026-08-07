/**
 * Runner headless da suite de debug (`npm run debug`).
 *
 * Roda toda a matriz de cenários pela máquina de estados REAL (com o modelo e o
 * I/O pesado fingidos), dirige as porteiras no auto-piloto e imprime uma matriz
 * pass/fail comparando a trilha de steps percorrida vs. a esperada.
 *
 * Uso:
 *   npm run debug                     # todos os cenários "stub" (rápido, sem npm)
 *   npm run debug -- --real-gates     # inclui os cenários de gates reais (tsc)
 *   npm run debug -- media-com-design # filtra por id(s) de cenário
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Project } from "../../shared/types.js";
import type { DriveResult } from "./driver.js";
import type { DebugScenario } from "./scenarios.js";

// --- Env ANTES de qualquer import do app (config.ts lê o env já no import). ---
process.env.INHOUSE_FAKE_MODEL = "1";
const realGates = process.argv.includes("--real-gates");
if (realGates) process.env.INHOUSE_FAKE_REAL_GATES = "1";
const raiz = mkdtempSync(join(tmpdir(), "inhouse-debug-"));
process.env.INHOUSE_DATA_DIR = join(raiz, "data");
process.env.INHOUSE_PROJECTS_DIR = join(raiz, "projects");
process.env.INHOUSE_EVAL_A_CADA = "1000000"; // nunca dispara o juiz durante o debug
// Deixa o git commitar sem depender da config global da máquina (CI-friendly).
process.env.GIT_AUTHOR_NAME ||= "Inhouse Debug";
process.env.GIT_AUTHOR_EMAIL ||= "debug@inhouse.local";
process.env.GIT_COMMITTER_NAME ||= "Inhouse Debug";
process.env.GIT_COMMITTER_EMAIL ||= "debug@inhouse.local";

const filtros = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// --- Imports dinâmicos (depois do env). ---
const store = await import("../store.js");
const config = await import("../config.js");
const { git, gitCommit } = await import("../services/proc.js");
const { SCENARIOS } = await import("./scenarios.js");
const { activate, bindTask } = await import("./fakeModel.js");
const { driveToEnd } = await import("./driver.js");
const { startTask, startPreparacao } = await import("../workflow/machine.js");

function arraysIguais<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function criaProjetoDescartavel(): Promise<Project> {
  const templateDir = fileURLToPath(new URL("../../templates/app-starter", import.meta.url));
  const dest = join(config.PROJECTS_DIR, "debug-app");
  cpSync(templateDir, dest, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
  for (const f of ["package.json", "index.html"]) {
    const p = join(dest, f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replaceAll("__APP_NAME__", "debug-app"));
  }
  await git(dest, "init");
  await git(dest, "add", "-A");
  await gitCommit(dest, "Projeto de debug");
  await git(dest, "branch", "-m", "main");
  const project: Project = {
    id: store.newId(),
    name: "debug-app",
    kind: "app",
    path: dest,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
  store.addProject(project);
  return project;
}

interface Linha {
  s: DebugScenario;
  status: "OK" | "FALHOU" | "PULADO";
  r?: DriveResult;
  ms?: number;
  detalhe?: string;
}

async function rodaCenario(projectId: string, s: DebugScenario): Promise<Linha> {
  activate(s);
  const task = s.preparacao
    ? await startPreparacao(projectId)
    : await startTask(projectId, s.label, s.descricao);
  bindTask(task.id, s);

  const t0 = Date.now();
  const r = await driveToEnd(task.id, s);
  const ms = Date.now() - t0;

  const stepsOk = arraysIguais(r.steps, s.expectSteps);
  const finalOk = r.finalStatus === s.expectFinal;
  const ok = stepsOk && finalOk && !r.timedOut;

  const problemas: string[] = [];
  if (r.timedOut) problemas.push("timeout");
  if (!finalOk) problemas.push(`status: esperado ${s.expectFinal}, obtido ${r.finalStatus}`);
  if (!stepsOk) problemas.push(`steps: esperado [${s.expectSteps.join(" → ")}], obtido [${r.steps.join(" → ")}]`);

  return { s, status: ok ? "OK" : "FALHOU", r, ms, detalhe: problemas.join("; ") || undefined };
}

function imprimeMatriz(linhas: Linha[]): void {
  const wId = Math.max(...linhas.map((l) => l.s.id.length), 4);
  console.log("");
  console.log(`  ${"CENÁRIO".padEnd(wId)}  RESULTADO  FINAL       TEMPO`);
  console.log(`  ${"-".repeat(wId)}  ---------  ----------  ------`);
  for (const l of linhas) {
    const icone = l.status === "OK" ? "✅" : l.status === "PULADO" ? "⏭️ " : "❌";
    const final = l.r?.finalStatus ?? "-";
    const tempo = l.ms !== undefined ? `${l.ms}ms` : "-";
    console.log(`  ${l.s.id.padEnd(wId)}  ${icone} ${l.status.padEnd(6)}  ${final.padEnd(10)}  ${tempo}`);
    if (l.detalhe) console.log(`  ${" ".repeat(wId)}     ↳ ${l.detalhe}`);
  }
}

// --- Execução ---
store.load();
config.ensureDirs();
const project = await criaProjetoDescartavel();

const alvo = SCENARIOS.filter((s) => filtros.length === 0 || filtros.includes(s.id));
if (alvo.length === 0) {
  console.error(`Nenhum cenário casou com o filtro: ${filtros.join(", ")}`);
  console.error(`Disponíveis: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

console.log(`\n🐛 Debug suite — ${alvo.length} cenário(s) · projeto descartável em ${project.path}`);
const linhas: Linha[] = [];
for (const s of alvo) {
  if (s.requerRealGates && !realGates) {
    linhas.push({ s, status: "PULADO", detalhe: "precisa de --real-gates (roda tsc de verdade)" });
    console.log(`  ⏭️  ${s.id} — pulado (--real-gates)`);
    continue;
  }
  process.stdout.write(`  ▶ ${s.id} … `);
  const linha = await rodaCenario(project.id, s);
  console.log(linha.status === "OK" ? `ok (${linha.ms}ms)` : `FALHOU`);
  linhas.push(linha);
}

imprimeMatriz(linhas);

const falhas = linhas.filter((l) => l.status === "FALHOU").length;
const pulados = linhas.filter((l) => l.status === "PULADO").length;
const oks = linhas.filter((l) => l.status === "OK").length;
console.log(`\n  ${oks} OK · ${falhas} falhou · ${pulados} pulado\n`);
process.exit(falhas > 0 ? 1 : 0);
