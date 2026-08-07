/**
 * Preview: sobe o dev server do worktree numa porta própria por espaço
 * (PREVIEW_PORT_BASE + espaço) e devolve a URL para o iframe da UI.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { PreviewConfig, Project, Task } from "../../shared/types.js";
import { DATA_DIR, PREVIEW_PORT_BASE, claudeEnv } from "../config.js";
import { createPreviewSetupGate } from "../claude/permissions.js";
import { runPhase } from "../claude/runner.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";
import { loadConfigCascata, sanitizePreview } from "../workflow/config.js";
import { previewSetupPrompt } from "../workflow/phases.js";
import { lastLines } from "./proc.js";
import { copiarEnvFiles } from "./worktrees.js";

/** Dev servers ativos, por tarefa. */
const registry = new Map<string, ChildProcess>();
/** Starts em andamento, por tarefa (dedupe: dois cliques = um dev server). */
const emAndamento = new Map<string, Promise<string>>();
/** Todos os processos spawnados ainda vivos (mesmo fora do registry) — o shutdown mata todos. */
const todos = new Set<ChildProcess>();

/** Timeout default de subida (cold-starts de monorepo/Next pedem folga). */
const START_TIMEOUT_MS = 120_000;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?/;

/** Onde ficam as receitas de preview aprendidas pelo agente, por projeto. */
const RECEITAS_DIR = join(DATA_DIR, "previews");

interface PkgJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * O projeto não tem como abrir um preview de TELA (lib/CLI/backend, ou não deu
 * para auto-detectar) — não é erro: a UI mostra a degradação graciosa e oferece
 * "Pedir ao Claude para configurar o preview".
 */
export class PreviewIndisponivelError extends Error {}

/**
 * O preview subiu (uma URL apareceu) mas o app não está SAUDÁVEL: uma rota
 * devolveu >=500 ou a conexão foi recusada. Diferente de PreviewIndisponivelError
 * (não há tela) — aqui há tela, mas ela está quebrada (ex.: .env mal configurada
 * numa rota). A UI trata como "subiu com erro" e oferece pedir correção ao Claude.
 */
export class PreviewQuebradoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly rota?: string,
    readonly detalhe?: string,
  ) {
    super(message);
  }
}

function sistema(taskId: string, text: string): void {
  const item = { kind: "system" as const, text, at: new Date().toISOString() };
  store.transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

/** Grava a receita de preview aprendida (por projeto) — 2ª vez vira zero-config. */
function salvarReceita(projectId: string, receita: PreviewConfig): void {
  try {
    mkdirSync(RECEITAS_DIR, { recursive: true });
    writeFileSync(join(RECEITAS_DIR, `${projectId}.json`), JSON.stringify(receita, null, 2));
  } catch {
    // Melhor esforço: não conseguir persistir a receita não impede subir agora.
  }
}

/** Lê a receita aprendida do projeto (sanitizada), se houver. */
function carregarReceita(projectId: string): PreviewConfig | null {
  const file = join(RECEITAS_DIR, `${projectId}.json`);
  if (!existsSync(file)) return null;
  try {
    return sanitizePreview(JSON.parse(readFileSync(file, "utf8"))) ?? null;
  } catch {
    return null;
  }
}

/**
 * Config efetiva de preview: o bloco commitado no projeto (versionado, manda)
 * vence a receita aprendida pelo agente. Sem nenhum, cai na auto-detecção.
 */
function resolvePreview(project: Project, worktreePath: string): PreviewConfig | null {
  const commitada = loadConfigCascata(worktreePath, project.path)?.preview;
  if (commitada) return commitada;
  return carregarReceita(project.id);
}

/**
 * Auto-detecção camada 1 (zero config): gerenciador pelo lockfile e comando a
 * partir de scripts.dev|start. Vale para ~80% dos repos JS de app único.
 * Devolve null quando não há como (sem package.json ou sem script) — vira
 * degradação graciosa. `viteLike` liga a flag --port (Vite/Astro ignoram PORT).
 */
export function autoDetectar(dir: string): { cmd: string; args: string[]; viteLike: boolean } | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: PkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PkgJson;
  } catch {
    return null;
  }
  const scripts = pkg.scripts ?? {};
  const script = scripts["dev"] ? "dev" : scripts["start"] ? "start" : null;
  if (!script) return null;

  // Gerenciador pelo lockfile (pnpm/yarn/bun via corepack; npm é o fallback).
  // `run <script>` funciona igual em npm/pnpm/yarn/bun.
  let cmd = "npm";
  let base: string[] = ["run", script];
  if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-workspace.yaml"))) {
    cmd = "corepack";
    base = ["pnpm", "run", script];
  } else if (existsSync(join(dir, "yarn.lock"))) {
    cmd = "corepack";
    base = ["yarn", "run", script];
  } else if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) {
    cmd = "bun";
    base = ["run", script];
  }

  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  const linha = scripts[script] ?? "";
  const viteLike =
    /\b(vite|astro)\b/.test(linha) || Boolean(deps["vite"] ?? deps["astro"]);
  return { cmd, args: base, viteLike };
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

/** Espera curta (backoff do health-check), sem segurar o event loop no shutdown. */
function espera(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref();
  });
}

/** Veredito do health-check de uma rota. */
interface Saude {
  ok: boolean;
  status?: number;
  rota?: string;
  detalhe?: string;
}

/**
 * Confere que o app realmente SERVE cada rota de healthPaths (default ["/"]):
 * fetch local (127.0.0.1, sem CORS), redirect manual (302 pra /login = saudável).
 * >=500 = quebrado; conexão recusada após retries = quebrado. <500 (inclui 3xx,
 * 401, 404) = saudável. Não lança — devolve o veredito.
 */
export async function verificarSaude(baseUrl: string, cfg?: PreviewConfig | null): Promise<Saude> {
  const rotas = cfg?.healthPaths?.length ? cfg.healthPaths : ["/"];
  for (const rota of rotas) {
    let alvo: string;
    try {
      alvo = new URL(rota, baseUrl).href;
    } catch {
      continue; // rota malformada: ignora
    }
    let conexao = 0; // falhas de conexão (server ainda subindo/compilando)
    let quinhentos = 0; // respostas 5xx (erro real, poucas tentativas)
    let ultimoStatus: number | undefined;
    let ultimoDetalhe: string | undefined;
    let ok = false;
    for (let i = 0; i < 30 && conexao < 15 && quinhentos < 3; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 12_000);
      timer.unref();
      try {
        const res = await fetch(alvo, {
          redirect: "manual",
          signal: ctrl.signal,
          headers: { accept: "text/html,*/*" },
        });
        clearTimeout(timer);
        if (res.status >= 500) {
          quinhentos++;
          ultimoStatus = res.status;
          ultimoDetalhe = (await res.text().catch(() => "")).replace(ANSI_RE, "").slice(0, 500);
          await espera(1000);
          continue;
        }
        ok = true; // <500 (200/3xx/401/404…) = a rota serve
        break;
      } catch (err) {
        clearTimeout(timer);
        conexao++;
        ultimoDetalhe = err instanceof Error ? err.message : String(err);
        await espera(1000);
      }
    }
    if (!ok) return { ok: false, rota, status: ultimoStatus, detalhe: ultimoDetalhe };
  }
  return { ok: true };
}

/** Mensagem amigável (pt-BR) para um preview que subiu mas está quebrado. */
function mensagemQuebrado(s: Saude): string {
  const onde = s.rota && s.rota !== "/" ? ` na tela "${s.rota}"` : "";
  if (s.status && s.status >= 500) {
    return `O app subiu, mas deu erro ${s.status}${onde}. Provavelmente falta configurar algo (ex.: uma variável de ambiente).`;
  }
  return `O app subiu, mas não respondeu${onde}. Pode ser que ele não tenha terminado de iniciar.`;
}

/** Roda um comando de setup (curto, que TERMINA) antes do server. Devolve o exit code (124=timeout). */
function execSetup(cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const ch = spawn("/bin/sh", ["-c", cmd], {
      cwd,
      env,
      detached: true, // grupo próprio: matar() derruba a árvore (docker/child procs)
      stdio: ["ignore", "pipe", "pipe"],
    });
    todos.add(ch);
    const timer = setTimeout(() => {
      matar(ch);
      resolve(124);
    }, 180_000);
    timer.unref();
    ch.on("exit", (code) => {
      todos.delete(ch);
      clearTimeout(timer);
      resolve(code ?? 0);
    });
    ch.on("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
  });
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

  const p = attemptStart(task, project).finally(() => {
    emAndamento.delete(task.id);
  });
  emAndamento.set(task.id, p);
  return p;
}

/**
 * Sobe o preview de fato. Chamado pelo startPreview (com dedupe) e diretamente
 * pela esteira no runPreviewCheck — por isso fica FORA do emAndamento (a esteira
 * dá stop/start várias vezes; cair no auto-await do dedupe travaria).
 * Com `opts.verificarSaude` (default true) faz um health-check por rota antes de
 * marcar pronto e lança PreviewQuebradoError se o app subiu mas está quebrado.
 */
export async function attemptStart(
  task: Task,
  project: Project,
  opts: { verificarSaude?: boolean } = {},
): Promise<string> {
  const cfg = resolvePreview(project, task.worktreePath);
  const cwd = cfg?.cwd ? join(task.worktreePath, cfg.cwd) : task.worktreePath;

  // Arquivos de ambiente da receita/config (ex.: .env.local) — idempotente:
  // cobre a receita aprendida pelo agente, que só existe depois de criar o espaço.
  if (cfg?.envFiles?.length) {
    await copiarEnvFiles(project, task.worktreePath, cfg.envFiles);
  }

  const porta = await portaLivre(cfg?.port ?? PREVIEW_PORT_BASE + task.espaco);
  // claudeEnv(): o dev server roda código arbitrário do projeto (vite.config,
  // plugins, etc.) — não pode ver ANTHROPIC_API_KEY/AUTH_TOKEN (decisão 1 da arquitetura).
  const baseEnv = { ...claudeEnv(), PORT: String(porta) };

  // Setup da receita: comandos curtos/idempotentes ANTES do server (docker, migrations…).
  // Mesmo nível de confiança do `cmd` (ambos via /bin/sh); best-effort (só avisa se falhar).
  if (cfg?.setup?.length) {
    for (const c of cfg.setup) {
      sistema(task.id, `Preparando o ambiente do preview: \`${c}\``);
      const code = await execSetup(c, cwd, baseEnv);
      if (code !== 0) sistema(task.id, `Aviso: \`${c}\` terminou com código ${code} — seguindo mesmo assim.`);
    }
  }

  // Comando: bloco/receita `cmd` (roda via shell) OU auto-detecção pelo lockfile.
  let spawnCmd: string;
  let spawnArgs: string[];
  if (cfg?.cmd) {
    spawnCmd = "/bin/sh";
    spawnArgs = ["-c", cfg.cmd];
  } else {
    const det = autoDetectar(cwd);
    if (!det) {
      // Camada 3 — degradação graciosa: nada de erro assustador; a UI oferece
      // "Pedir ao Claude para configurar o preview".
      throw new PreviewIndisponivelError(
        "Este projeto não tem uma tela para pré-visualizar automaticamente.",
      );
    }
    spawnArgs = [...det.args];
    // Vite/Astro ignoram a variável PORT — forçam-se pela flag.
    if (det.viteLike) spawnArgs.push("--", "--port", String(porta), "--strictPort");
    spawnCmd = det.cmd;
  }

  const child = spawn(spawnCmd, spawnArgs, {
    cwd,
    env: baseEnv,
    detached: true, // grupo de processo próprio: dá para matar a árvore toda
    stdio: ["ignore", "pipe", "pipe"],
  });
  todos.add(child);
  child.on("exit", () => todos.delete(child));

  // readyRegex custom (servidores não-JS/sem URL no stdout): quando bate mas não
  // há URL, montamos http://localhost:porta. Já validado no config (compila).
  const readyRe = cfg?.readyRegex ? new RegExp(cfg.readyRegex) : null;
  const timeoutMs = cfg?.timeoutMs ?? START_TIMEOUT_MS;

  const url = await new Promise<string>((resolve, reject) => {
    let saida = "";
    let resolvido = false;
    const timer = setTimeout(() => {
      if (resolvido) return;
      resolvido = true;
      matar(child);
      reject(new Error("O app não subiu a tempo. Tente de novo; se continuar, fale com o time técnico."));
    }, timeoutMs);

    const olhar = (d: Buffer) => {
      if (resolvido) return;
      saida = lastLines(saida + String(d).replace(ANSI_RE, ""), 100);
      const m = URL_RE.exec(saida);
      const url = m ? m[0] : readyRe?.test(saida) ? `http://localhost:${porta}` : null;
      if (url) {
        resolvido = true;
        clearTimeout(timer);
        resolve(url);
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

  // Health-check por rota (backstop determinístico): protege o start mecânico —
  // um app que subiu mas dá 500 numa rota não chega ao usuário como "pronto".
  if (opts.verificarSaude !== false) {
    const saude = await verificarSaude(url, cfg);
    if (!saude.ok) {
      matar(child);
      throw new PreviewQuebradoError(mensagemQuebrado(saude), saude.status, saude.rota, saude.detalhe);
    }
  }

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

// ---------- Camada 2.5: o agente descobre como abrir o preview ----------

/** O projeto tem um bloco `preview` commitado? (config versionada vence receita.) */
export function temPreviewConfigCommitada(project: Project, worktreePath: string): boolean {
  return Boolean(loadConfigCascata(worktreePath, project.path)?.preview);
}

/**
 * Extrai+sanitiza a receita do texto final do agente (bloco ```json ou o último
 * {…}). Se `portaReservada` vier, sobrescreve a porta. Aceita receitas SEM cmd
 * (o auto-detect preenche o comando; o valor está em setup/healthPaths/envFiles).
 */
export function extrairReceita(texto: string, portaReservada?: number): PreviewConfig | null {
  if (!texto) return null;
  let bruto: string | null = null;
  const fences = [...texto.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const ultimo = fences[fences.length - 1];
  if (ultimo) bruto = ultimo[1] ?? null;
  if (!bruto) {
    const ini = texto.indexOf("{");
    const fim = texto.lastIndexOf("}");
    if (ini >= 0 && fim > ini) bruto = texto.slice(ini, fim + 1);
  }
  if (!bruto) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(bruto);
  } catch {
    return null;
  }
  const cfg = sanitizePreview(obj);
  if (!cfg) return null;
  return portaReservada !== undefined ? { ...cfg, port: portaReservada } : cfg;
}

/**
 * Como acima, mas para a camada 2.5 (descoberta): exige "cmd" (sem comando não há
 * o que subir) e força a porta reservada.
 */
export function parsePreviewRecipe(texto: string, portaReservada: number): PreviewConfig | null {
  const cfg = extrairReceita(texto, portaReservada);
  return cfg?.cmd ? cfg : null;
}

/**
 * Aprende a receita descrita pelo agente e guarda por projeto (2ª vez vira rápido).
 * Só persiste se trouxer algo útil (cmd/setup/healthPaths/envFiles/cwd). Devolve a
 * receita aprendida (ou null).
 */
export function aprenderReceita(projectId: string, texto: string): PreviewConfig | null {
  const cfg = extrairReceita(texto);
  if (!cfg) return null;
  const util = cfg.cmd || cfg.setup || cfg.healthPaths || cfg.envFiles || cfg.cwd;
  if (!util) return null;
  salvarReceita(projectId, cfg);
  return cfg;
}

/** Config efetiva de preview (config commitada vence receita) — p/ o health-check. */
export function resolvePreviewConfig(project: Project, worktreePath: string): PreviewConfig | null {
  return resolvePreview(project, worktreePath);
}

/**
 * Camada 2.5: pede ao Claude (na mesma sessão da tarefa) para PREPARAR o ambiente
 * e descrever a receita de preview, guarda-a por projeto (2ª vez vira zero-config)
 * e sobe o preview. Setup-capaz: acceptEdits + gate seguro (env/docker liberados,
 * servidor de dev negado). É o caminho manual quando o preview não subiu sozinho.
 */
export async function configurarPreviewComAgente(task: Task, project: Project): Promise<string> {
  sistema(task.id, "Pedindo ao Claude para preparar e descobrir como abrir o preview deste projeto…");

  const r = await runPhase({
    taskId: task.id,
    cwd: task.worktreePath,
    prompt: previewSetupPrompt(),
    permissionMode: "acceptEdits", // pode preparar o ambiente (env, docker) — Bash no gate seguro
    resume: task.claudeSessionId,
    canUseTool: createPreviewSetupGate(task.id),
    maxTurns: 40,
  });
  if (r.sessionId) store.updateTask(task.id, { claudeSessionId: r.sessionId });

  const receita = aprenderReceita(project.id, r.finalText);
  if (!receita) {
    sistema(task.id, "O Claude não conseguiu descobrir como abrir o preview deste projeto.");
    throw new PreviewIndisponivelError(
      "Não deu para configurar o preview automaticamente. Este projeto pode não ter uma tela para visualizar.",
    );
  }
  const ondeCwd = receita.cwd && receita.cwd !== "." ? ` (em ${receita.cwd})` : "";
  sistema(
    task.id,
    receita.cmd
      ? `Preview configurado — vou subir com \`${receita.cmd}\`${ondeCwd}.`
      : "Preview configurado — vou subir com a detecção automática.",
  );

  const atual = store.getTask(task.id) ?? task;
  return startPreview(atual, project);
}
