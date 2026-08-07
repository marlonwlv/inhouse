/**
 * Smoke da matriz de jornadas: dirige CADA cenário stub pela máquina de estados
 * REAL (modelo/gates/preview/publish fingidos) e confere a trilha de steps vs. o
 * esperado. Converte a garantia que antes só existia no CLI (`npm run debug`) em
 * garantia de CI. Cobre driver.ts + fakeModel + os seams de ponta a ponta.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../shared/types.js";

// Env ANTES de importar store/config/máquina (config lê o env no import).
const raiz = mkdtempSync(join(tmpdir(), "inhouse-journeys-"));
process.env.INHOUSE_FAKE_MODEL = "1";
process.env.INHOUSE_DATA_DIR = join(raiz, "data");
process.env.INHOUSE_PROJECTS_DIR = join(raiz, "projects");
process.env.INHOUSE_EVAL_A_CADA = "1000000";
process.env.GIT_AUTHOR_NAME ||= "t";
process.env.GIT_AUTHOR_EMAIL ||= "t@t";
process.env.GIT_COMMITTER_NAME ||= "t";
process.env.GIT_COMMITTER_EMAIL ||= "t@t";

const store = await import("../server/store.js");
const config = await import("../server/config.js");
const { git, gitCommit } = await import("../server/services/proc.js");
const { SCENARIOS } = await import("../server/debug/scenarios.js");
const { activate, bindTask } = await import("../server/debug/fakeModel.js");
const { driveToEnd } = await import("../server/debug/driver.js");
const { startTask, startPreparacao } = await import("../server/workflow/machine.js");

let project: Project;

beforeAll(async () => {
  store.load();
  config.ensureDirs();
  const tpl = fileURLToPath(new URL("../templates/app-starter", import.meta.url));
  const dest = join(config.PROJECTS_DIR, "journeys-app");
  cpSync(tpl, dest, { recursive: true, filter: (s) => basename(s) !== "node_modules" });
  for (const f of ["package.json", "index.html"]) {
    const p = join(dest, f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, "utf8").replaceAll("__APP_NAME__", "journeys-app"));
  }
  await git(dest, "init");
  await git(dest, "add", "-A");
  await gitCommit(dest, "init");
  await git(dest, "branch", "-m", "main");
  project = {
    id: store.newId(),
    name: "journeys-app",
    kind: "app",
    path: dest,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
  store.addProject(project);
});

// Só os cenários stub (sem --real-gates): rápidos, sem npm.
describe("matriz de jornadas (stub)", () => {
  for (const s of SCENARIOS.filter((x) => !x.requerRealGates)) {
    it(
      `${s.id}: trilha e status batem com o esperado`,
      async () => {
        activate(s);
        const task = s.preparacao
          ? await startPreparacao(project.id)
          : await startTask(project.id, s.label, s.descricao);
        bindTask(task.id, s);
        const r = await driveToEnd(task.id, s, { timeoutMs: 15_000 });
        expect(r.timedOut, r.error).toBe(false);
        expect(r.finalStatus).toBe(s.expectFinal);
        expect(r.steps).toEqual(s.expectSteps);
      },
      20_000,
    );
  }
});
