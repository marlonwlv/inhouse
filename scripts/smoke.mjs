#!/usr/bin/env node
/**
 * Smoke test do Inhouse de ponta a ponta, em qualquer SO (roda no CI em
 * Windows, macOS e Linux): sobe o servidor de verdade com o modelo fingido
 * (INHOUSE_FAKE_MODEL=1, sem gastar Claude) em pastas temporárias e confere:
 *
 *  1. a UI e /api/state respondem;
 *  2. criar app pelo modelo: cópia + git init + `npm install` de verdade
 *     (no Windows isso passa pelo npm.cmd → cmd.exe, o ponto mais frágil);
 *  3. abrir uma pasta existente como projeto;
 *  4. criar uma tarefa → o git worktree do espaço aparece em disco;
 *  5. ligar e desligar o preview da tarefa;
 *  6. excluir o projeto;
 *  7. derrubar o servidor e a porta ficar livre.
 *
 * Uso: npm run smoke   (INHOUSE_SMOKE_SEM_INSTALL=1 pula a espera do npm install)
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ehWin = process.platform === "win32";
const raizTmp = mkdtempSync(join(tmpdir(), "inhouse-smoke-"));
const dataDir = join(raizTmp, "data");
const projectsDir = join(raizTmp, "projetos");
const porta = Number(process.env.INHOUSE_SMOKE_PORT ?? 4480 + Math.floor(Math.random() * 15));
const base = `http://127.0.0.1:${porta}`;
let passo = "início";
let servidor;
let saidaServidor = "";

const log = (m) => console.log(`[smoke] ${m}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperar(desc, fn, timeoutMs = 30_000, intervalo = 300) {
  const ate = Date.now() + timeoutMs;
  let ultimo;
  while (Date.now() < ate) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      ultimo = err;
    }
    await dormir(intervalo);
  }
  throw new Error(`tempo esgotado esperando ${desc}${ultimo ? ` (${ultimo.message})` : ""}`);
}

async function api(metodo, caminho, corpo) {
  const r = await fetch(base + caminho, {
    method: metodo,
    headers: corpo ? { "content-type": "application/json" } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = texto;
  }
  if (!r.ok) throw new Error(`${metodo} ${caminho} → ${r.status}: ${texto.slice(0, 300)}`);
  return json;
}

function portaLivre(p) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function matarServidor() {
  if (!servidor?.pid || servidor.exitCode !== null) return;
  if (ehWin) spawnSync("taskkill", ["/pid", String(servidor.pid), "/T", "/F"], { stdio: "ignore" });
  else servidor.kill("SIGTERM");
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });

  passo = "subir o servidor";
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  servidor = spawn(process.execPath, [tsx, "server/index.ts"], {
    env: {
      ...process.env,
      INHOUSE_FAKE_MODEL: "1",
      INHOUSE_EVAL_A_CADA: "1000000",
      INHOUSE_DATA_DIR: dataDir,
      INHOUSE_PROJECTS_DIR: projectsDir,
      INHOUSE_PORT: String(porta),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const coletar = (d) => {
    saidaServidor = (saidaServidor + String(d)).slice(-8000);
  };
  servidor.stdout.on("data", coletar);
  servidor.stderr.on("data", coletar);
  await esperar("o servidor responder", async () => (await fetch(base + "/api/state")).ok, 60_000);
  log(`servidor no ar em ${base}`);

  passo = "UI e estado";
  const html = await (await fetch(base + "/")).text();
  if (!/<html/i.test(html)) throw new Error("GET / não devolveu HTML");
  const estado = await api("GET", "/api/state");
  if (!Array.isArray(estado.projects) || estado.fake !== true) throw new Error("/api/state inesperado");
  log(`UI ok; claude: ${estado.claude?.ok ? estado.claude.version : estado.claude?.detail}`);

  passo = "criar app pelo modelo";
  const app = await api("POST", "/api/projects/from-template", { name: "Smoke App", template: "app-starter" });
  if (!existsSync(join(app.path, ".git"))) throw new Error("projeto do modelo sem .git");
  log(`app do modelo criado em ${app.path}`);
  if (!process.env.INHOUSE_SMOKE_SEM_INSTALL) {
    passo = "npm install do modelo";
    // O install roda em segundo plano; o sinal de pronto é o vite instalado.
    const vite = join(app.path, "node_modules", ".bin", ehWin ? "vite.cmd" : "vite");
    await esperar("o npm install do modelo", () => existsSync(vite), 300_000, 1000);
    log("npm install do modelo concluído");
  }

  passo = "abrir pasta existente";
  const pasta = join(raizTmp, "existente");
  mkdirSync(pasta);
  writeFileSync(join(pasta, "README.md"), "# existente\n");
  writeFileSync(
    join(pasta, "package.json"),
    JSON.stringify({ name: "existente", private: true, scripts: { dev: "node server.js" } }, null, 2),
  );
  writeFileSync(
    join(pasta, "server.js"),
    "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT,()=>console.log('http://localhost:'+process.env.PORT))\n",
  );
  const aberto = await api("POST", "/api/projects/open", { path: pasta });
  log(`pasta aberta como projeto "${aberto.name}"`);

  passo = "criar tarefa (worktree)";
  const tarefa = await api("POST", "/api/tasks", {
    projectId: aberto.id,
    description: "Mudar o título da página inicial",
  });
  const comEspaco = await esperar(
    "o espaço (git worktree) da tarefa",
    async () => {
      const t = (await api("GET", "/api/state")).tasks.find((x) => x.id === tarefa.id);
      return t?.worktreePath && existsSync(t.worktreePath) ? t : null;
    },
    60_000,
  );
  const wt = execFileSync("git", ["-C", aberto.path, "worktree", "list"], { encoding: "utf8" });
  if (!wt.toLowerCase().includes("espaco-")) throw new Error(`worktree não registrado no git:\n${wt}`);
  log(`worktree criado em ${comEspaco.worktreePath}`);

  passo = "preview liga/desliga";
  const pv = await api("POST", `/api/tasks/${tarefa.id}/preview/start`);
  if (!pv.url) throw new Error("preview sem URL");
  await api("POST", `/api/tasks/${tarefa.id}/preview/stop`);
  log(`preview ok (${pv.url})`);

  passo = "excluir projetos";
  // Espera a esteira fingida assentar antes de excluir (excluir com tarefa rodando é 409).
  await esperar(
    "a tarefa sair de execução",
    async () => {
      try {
        await api("DELETE", `/api/projects/${aberto.id}`, { apagarArquivos: false });
        return true;
      } catch (err) {
        if (/→ 409/.test(err.message)) return false;
        throw err;
      }
    },
    60_000,
    1000,
  );
  await api("DELETE", `/api/projects/${app.id}`, { apagarArquivos: true });
  log("projetos excluídos");

  passo = "derrubar o servidor";
  matarServidor();
  await esperar("a porta ficar livre", () => portaLivre(porta), 10_000);
  log("servidor encerrado e porta livre");
}

let codigo = 0;
try {
  await main();
  log("TUDO OK ✅");
} catch (err) {
  codigo = 1;
  console.error(`[smoke] FALHOU no passo "${passo}": ${err.message}`);
  console.error("[smoke] últimas linhas do servidor:\n" + saidaServidor);
} finally {
  matarServidor();
  await dormir(500);
  try {
    rmSync(raizTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // no Windows algum arquivo pode seguir preso por ms; não reprova o smoke
  }
}
process.exit(codigo);
