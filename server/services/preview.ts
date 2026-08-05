/**
 * Preview: sobe o dev server do worktree numa porta própria por espaço
 * (PREVIEW_PORT_BASE + espaço) e devolve a URL para o iframe da UI.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Project, Task } from "../../shared/types.js";
import { PREVIEW_PORT_BASE, claudeEnv } from "../config.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";
import { lastLines } from "./proc.js";

/** Dev servers ativos, por tarefa. */
const registry = new Map<string, ChildProcess>();
/** Starts em andamento, por tarefa (dedupe: dois cliques = um dev server). */
const emAndamento = new Map<string, Promise<string>>();
/** Todos os processos spawnados ainda vivos (mesmo fora do registry) — o shutdown mata todos. */
const todos = new Set<ChildProcess>();

const START_TIMEOUT_MS = 90_000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/;

interface PkgJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Mata a árvore inteira do dev server (grupo de processo — spawn com detached). */
function matar(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // já morreu
    }
  }, 3000);
  timer.unref();
}

function limparUrl(taskId: string): void {
  const t = store.getTask(taskId);
  if (t && t.previewUrl) {
    const atualizado = store.updateTask(taskId, { previewUrl: undefined });
    broadcast({ type: "task_updated", task: atualizado });
  }
}

/** A porta está livre em 127.0.0.1? (bind de teste; pega também binds em 0.0.0.0) */
function portaDisponivel(porta: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(porta, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Primeira porta livre a partir de `inicio`. O número do espaço é por projeto,
 * então tarefas de projetos diferentes podem calcular a MESMA porta base — sem
 * esta busca, o segundo preview morreria com "porta em uso".
 */
export async function portaLivre(inicio: number): Promise<number> {
  for (let porta = inicio; porta < inicio + 100; porta++) {
    if (await portaDisponivel(porta)) return porta;
  }
  throw new Error("Não achamos uma porta livre para o preview. Feche outros apps e tente de novo.");
}

export function startPreview(task: Task, project: Project): Promise<string> {
  // Já tem um start em andamento para esta tarefa? Reusa a mesma promise —
  // senão o segundo clique subiria um segundo dev server que ninguém mata.
  const pendente = emAndamento.get(task.id);
  if (pendente) return pendente;

  const vivo = registry.get(task.id);
  if (vivo && vivo.exitCode === null && !vivo.killed) {
    const salvo = store.getTask(task.id)?.previewUrl ?? task.previewUrl;
    if (salvo) return Promise.resolve(salvo);
  }

  const p = doStartPreview(task, project).finally(() => {
    emAndamento.delete(task.id);
  });
  emAndamento.set(task.id, p);
  return p;
}

async function doStartPreview(task: Task, _project: Project): Promise<string> {
  const pkgPath = join(task.worktreePath, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error("Este projeto não tem como rodar um preview (package.json não encontrado).");
  }
  let pkg: PkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgJson;
  } catch {
    throw new Error("O package.json do projeto está inválido. Peça uma correção na tarefa.");
  }
  const scripts = pkg.scripts ?? {};
  const script = scripts["dev"] ? "dev" : scripts["start"] ? "start" : null;
  if (!script) {
    throw new Error("Este projeto não tem um comando de preview (script dev ou start no package.json).");
  }

  const porta = await portaLivre(PREVIEW_PORT_BASE + task.espaco);
  const usaVite =
    /\bvite\b/.test(scripts[script] ?? "") ||
    Boolean(pkg.devDependencies?.["vite"] ?? pkg.dependencies?.["vite"]);
  const args = ["run", script];
  if (usaVite) args.push("--", "--port", String(porta), "--strictPort");

  // claudeEnv(): o dev server roda código arbitrário do projeto (vite.config,
  // plugins…) — não pode ver ANTHROPIC_API_KEY/AUTH_TOKEN (decisão 1 da arquitetura).
  const child = spawn("npm", args, {
    cwd: task.worktreePath,
    env: { ...claudeEnv(), PORT: String(porta) },
    detached: true, // grupo de processo próprio → dá para matar a árvore toda
    stdio: ["ignore", "pipe", "pipe"],
  });
  todos.add(child);
  child.on("exit", () => todos.delete(child));

  const url = await new Promise<string>((resolve, reject) => {
    let saida = "";
    let resolvido = false;
    const timer = setTimeout(() => {
      if (resolvido) return;
      resolvido = true;
      matar(child);
      reject(new Error("O app não subiu a tempo. Tente de novo; se continuar, fale com o time técnico."));
    }, START_TIMEOUT_MS);

    const olhar = (d: Buffer) => {
      if (resolvido) return;
      saida = lastLines(saida + String(d).replace(ANSI_RE, ""), 100);
      const m = URL_RE.exec(saida);
      if (m) {
        resolvido = true;
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    child.stdout?.on("data", olhar);
    child.stderr?.on("data", olhar);
    child.on("error", (err) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      reject(new Error("Não foi possível iniciar o preview nesta máquina. Fale com o time técnico.", { cause: err }));
    });
    child.on("exit", () => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      reject(
        new Error("O app não conseguiu iniciar. Peça uma correção na tarefa ou fale com o time técnico.", {
          cause: saida,
        }),
      );
    });
  });

  registry.set(task.id, child);
  // Se o dev server morrer sozinho depois, limpa o estado para a UI não mostrar preview morto.
  child.on("exit", () => {
    if (registry.get(task.id) === child) {
      registry.delete(task.id);
      limparUrl(task.id);
    }
  });

  const atualizado = store.updateTask(task.id, { previewUrl: url });
  broadcast({ type: "preview_ready", taskId: task.id, url });
  broadcast({ type: "task_updated", task: atualizado });
  return url;
}

export async function stopPreview(taskId: string): Promise<void> {
  // Um start ainda em andamento? Quando terminar, derruba o que tiver subido —
  // sem isso, "parar" durante a subida deixaria o dev server rodando órfão.
  const pendente = emAndamento.get(taskId);
  if (pendente) {
    void pendente
      .then(() => {
        const c = registry.get(taskId);
        registry.delete(taskId);
        if (c) matar(c);
        limparUrl(taskId);
      })
      .catch(() => {
        // start falhou: não subiu nada para derrubar
      });
  }
  const child = registry.get(taskId);
  registry.delete(taskId);
  if (child) matar(child);
  limparUrl(taskId);
}

/** Para todos os previews (shutdown do servidor) — inclusive starts em andamento. */
export function stopAllPreviews(): void {
  for (const child of todos) matar(child);
  todos.clear();
  registry.clear();
}
