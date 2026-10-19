/**
 * Diferenças de sistema operacional num lugar só (Windows × macOS/Linux).
 *
 * Regras que o resto do server segue:
 * - Nada de shell:true. No Windows, `.cmd`/`.bat` (npm, npx, pnpm, claude via
 *   npm) só rodam por `cmd.exe /d /s /c` — desde o Node 18.20.2/20.12.2
 *   (CVE-2024-27980) o spawn direto deles dá EINVAL. Aqui montamos essa linha
 *   com o escape `^` (mesmo esquema do cross-spawn).
 * - Árvore de processos: no POSIX matamos o grupo (`kill(-pid)`, exige
 *   `detached`); no Windows não há grupo → `taskkill /T /F`.
 * - `detached` no Windows abre uma janela de console nova: só no POSIX.
 *
 * As funções puras recebem a plataforma/ambiente por parâmetro para serem
 * testadas no Linux simulando win32.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type Plataforma = NodeJS.Platform;

export const ehWindows = (plataforma: Plataforma = process.platform): boolean => plataforma === "win32";

function caminhos(plataforma: Plataforma) {
  return plataforma === "win32" ? path.win32 : path.posix;
}

function lerEnv(env: NodeJS.ProcessEnv, nome: string): string | undefined {
  // No Windows as variáveis não diferenciam maiúsculas (Path × PATH).
  if (env[nome] !== undefined) return env[nome];
  const chave = Object.keys(env).find((k) => k.toUpperCase() === nome.toUpperCase());
  return chave ? env[chave] : undefined;
}

function ehArquivo(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export interface ResolverOpts {
  plataforma?: Plataforma;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  existe?: (p: string) => boolean;
}

/**
 * Acha o arquivo real de um comando como o shell acharia. No POSIX devolve o
 * próprio nome (o execvp resolve). No Windows varre cwd (se o nome tem
 * barra) ou o PATH com as extensões do PATHEXT — e, se o nome não tem
 * extensão, IGNORA o arquivo sem extensão (ex.: o shim sh `node_modules/.bin/tsc`,
 * que o Windows não executa; o certo é o `tsc.cmd` ao lado).
 */
export function resolverExecutavel(cmd: string, opts: ResolverOpts = {}): string {
  const plataforma = opts.plataforma ?? process.platform;
  if (!ehWindows(plataforma)) return cmd;
  const p = caminhos(plataforma);
  const env = opts.env ?? process.env;
  const existe = opts.existe ?? ehArquivo;
  const exts = (lerEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const temExt = exts.includes(p.extname(cmd).toLowerCase());
  const candidatosDe = (base: string) => (temExt ? [base] : exts.map((e) => base + e));

  const temBarra = /[\\/]/.test(cmd);
  const dirs = temBarra
    ? [""]
    : [opts.cwd ?? "", ...(lerEnv(env, "PATH") ?? "").split(";")].filter((d, i) => i === 0 || d);
  for (const dir of dirs) {
    const base = temBarra
      ? p.resolve(opts.cwd ?? process.cwd(), cmd)
      : dir
        ? p.join(dir.replace(/^"|"$/g, ""), cmd)
        : "";
    if (!base) continue;
    for (const c of candidatosDe(base)) if (existe(c)) return c;
  }
  return cmd; // não achou: deixa o spawn dar ENOENT com o nome original
}

// Metacaracteres do cmd.exe — escapados com ^ (esquema do cross-spawn).
const META_CMD = /([()\][%!^"`<>&|;, *?])/g;

/** Escapa um argumento para a linha do `cmd.exe /d /s /c "..."`. */
export function escaparArgCmd(arg: string, duplo = true): string {
  // 1) regras do CommandLineToArgvW (barras antes de aspas) e aspas em volta
  let s = `${arg}`;
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  // 2) ^ para o cmd.exe — duas vezes quando o alvo é um .cmd/.bat (ele
  // re-interpreta a linha ao repassar %*).
  s = s.replace(META_CMD, "^$1");
  if (duplo) s = s.replace(META_CMD, "^$1");
  return s;
}

function escaparComandoCmd(arquivo: string): string {
  return arquivo.replace(META_CMD, "^$1");
}

export interface ComandoMontado {
  arquivo: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * Transforma (cmd, args) no que o spawn deve receber nesta plataforma, sem
 * shell:true. No Windows, alvos `.cmd`/`.bat` viram `cmd.exe /d /s /c "<linha>"`.
 */
export function montarComando(cmd: string, args: string[], opts: ResolverOpts = {}): ComandoMontado {
  const plataforma = opts.plataforma ?? process.platform;
  if (!ehWindows(plataforma)) return { arquivo: cmd, args };
  const arquivo = resolverExecutavel(cmd, opts);
  if (!/\.(cmd|bat)$/i.test(arquivo)) return { arquivo, args };
  const p = caminhos(plataforma);
  const linha = [escaparComandoCmd(p.normalize(arquivo)), ...args.map((a) => escaparArgCmd(a, true))].join(" ");
  const comspec = lerEnv(opts.env ?? process.env, "COMSPEC") || "cmd.exe";
  return { arquivo: comspec, args: ["/d", "/s", "/c", `"${linha}"`], windowsVerbatimArguments: true };
}

/** Opções de spawn que dependem do SO (grupo de processos × janela de console). */
export function spawnOpcoes(plataforma: Plataforma = process.platform): Pick<SpawnOptions, "detached" | "windowsHide"> {
  // POSIX: grupo próprio para matar a árvore com kill(-pid).
  // Windows: detached abriria uma janela de console; a árvore cai via taskkill /T.
  return ehWindows(plataforma) ? { windowsHide: true } : { detached: true, windowsHide: true };
}

/** spawn() portátil: resolve .cmd/.bat no Windows sem shell:true. */
export function spawnPortatil(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const m = montarComando(cmd, args, { env: opts.env, cwd: typeof opts.cwd === "string" ? opts.cwd : undefined });
  return spawn(m.arquivo, m.args, {
    windowsHide: true,
    ...opts,
    ...(m.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
}

/**
 * Comando para rodar uma linha de shell do usuário (receitas de preview/setup
 * do inhouse.config.json, escritas em sintaxe sh: `$PORT`, `&&`).
 * POSIX: /bin/sh -c. Windows: Git Bash (o Claude Code no Windows já exige o
 * Git for Windows), e só sem ele o cmd.exe — que pode não entender a receita.
 */
export function comandoDeShell(
  linha: string,
  opts: { plataforma?: Plataforma; bash?: string | null } = {},
): ComandoMontado & { shell: "sh" | "bash" | "cmd" } {
  const plataforma = opts.plataforma ?? process.platform;
  if (!ehWindows(plataforma)) return { arquivo: "/bin/sh", args: ["-c", linha], shell: "sh" };
  const bash = opts.bash === undefined ? acharGitBash() : opts.bash;
  if (bash) return { arquivo: bash, args: ["-c", linha], shell: "bash" };
  return { arquivo: "cmd.exe", args: ["/d", "/s", "/c", `"${linha}"`], windowsVerbatimArguments: true, shell: "cmd" };
}

let cacheBash: string | null | undefined;
/** Bash do Git for Windows (o mesmo que o Claude Code usa). */
export function acharGitBash(env: NodeJS.ProcessEnv = process.env, existe: (p: string) => boolean = existsSync): string | null {
  if (env === process.env && cacheBash !== undefined) return cacheBash;
  const w = path.win32;
  const candidatos: string[] = [];
  const doClaude = lerEnv(env, "CLAUDE_CODE_GIT_BASH_PATH");
  if (doClaude) candidatos.push(doClaude);
  const gitExe = resolverExecutavel("git", { plataforma: "win32", env, existe, cwd: "" });
  if (/\.exe$/i.test(gitExe)) {
    // ...\Git\cmd\git.exe ou ...\Git\bin\git.exe ou ...\Git\mingw64\bin\git.exe
    let raiz = w.dirname(w.dirname(gitExe));
    if (/mingw64$/i.test(raiz)) raiz = w.dirname(raiz);
    candidatos.push(w.join(raiz, "bin", "bash.exe"));
  }
  for (const base of [lerEnv(env, "ProgramFiles"), lerEnv(env, "ProgramW6432"), lerEnv(env, "LOCALAPPDATA") && w.join(lerEnv(env, "LOCALAPPDATA")!, "Programs")]) {
    if (base) candidatos.push(w.join(base, "Git", "bin", "bash.exe"));
  }
  const achado = candidatos.find((c) => existe(c)) ?? null;
  if (env === process.env) cacheBash = achado;
  return achado;
}

/**
 * Mata o processo e todos os filhos (dev server → node → esbuild…).
 * POSIX: grupo (o filho precisa ter nascido com detached). Windows: taskkill /T /F.
 */
export function matarArvore(
  pid: number | undefined,
  sinal: NodeJS.Signals = "SIGTERM",
  plataforma: Plataforma = process.platform,
): void {
  if (!pid) return;
  if (ehWindows(plataforma)) {
    try {
      // Sem SIGTERM gracioso no Windows: /F sempre (o filho não tem console para Ctrl+C).
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // best-effort
    }
    return;
  }
  try {
    process.kill(-pid, sinal);
  } catch {
    try {
      process.kill(pid, sinal);
    } catch {
      // já morreu
    }
  }
}

/**
 * Mata um filho e a árvore dele. `grupo`: o filho nasceu com spawnOpcoes()
 * (detached no POSIX), então dá para matar o grupo inteiro.
 */
export function matarFilho(child: ChildProcess, sinal: NodeJS.Signals = "SIGKILL", grupo = false): void {
  if (child.pid && (ehWindows() || grupo)) return matarArvore(child.pid, sinal);
  try {
    child.kill(sinal);
  } catch {
    // best-effort
  }
}

/** Compara caminhos: sem diferenciar maiúsculas no Windows (e no macOS padrão). */
export function mesmoCaminho(a: string, b: string, plataforma: Plataforma = process.platform): boolean {
  const p = caminhos(plataforma);
  const na = p.resolve(a).replace(/[\\/]+$/, "");
  const nb = p.resolve(b).replace(/[\\/]+$/, "");
  return ehWindows(plataforma) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// ---------------------------------------------------------------- claude

/**
 * Lê o alvo de um shim do npm (`claude.cmd`): a linha final aponta para
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\cli.js"` (ou um .exe). O SDK
 * do Claude roda .js com node e qualquer outra coisa como binário nativo —
 * um .cmd ele não sabe rodar, então entregamos o alvo.
 */
export function alvoDoShimCmd(conteudo: string, dirDoShim: string): string | null {
  const achados = [...conteudo.matchAll(/"%(?:~)?dp0%?\\?([^"%]+?\.(?:js|cjs|mjs|exe))"/gi)];
  const ultimo = achados.at(-1)?.[1];
  if (!ultimo) return null;
  return path.win32.join(dirDoShim, ultimo.replace(/^\\/, ""));
}

export interface ClaudeOpts {
  plataforma?: Plataforma;
  env?: NodeJS.ProcessEnv;
  casa?: string;
  existe?: (p: string) => boolean;
  ler?: (p: string) => string;
  /** `which`/`where`: devolve as linhas da saída ou [] se falhar. */
  procurar?: (nome: string) => string[];
}

function procurarNoPath(nome: string, plataforma: Plataforma): string[] {
  try {
    const out = execFileSync(ehWindows(plataforma) ? "where" : "which", [nome], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Caminho do Claude Code da máquina, já no formato que o SDK sabe executar
 * (binário nativo ou cli.js). null se não achar.
 * Ordem: INHOUSE_CLAUDE_PATH → PATH (which/where) → locais comuns.
 */
export function resolverClaude(opts: ClaudeOpts = {}): string | null {
  const plataforma = opts.plataforma ?? process.platform;
  const env = opts.env ?? process.env;
  const existe = opts.existe ?? existsSync;
  const ler = opts.ler ?? ((p: string) => readFileSync(p, "utf8"));
  const procurar = opts.procurar ?? ((n: string) => procurarNoPath(n, plataforma));
  const casa = opts.casa ?? homedir();

  const override = lerEnv(env, "INHOUSE_CLAUDE_PATH");
  if (override) return normalizarClaude(override, plataforma, ler);

  if (!ehWindows(plataforma)) {
    const p = procurar("claude")[0];
    if (p) return p;
    const comuns = [
      path.posix.join(casa, ".local", "bin", "claude"),
      path.posix.join(casa, ".claude", "local", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    return comuns.find((c) => existe(c)) ?? null;
  }

  const w = path.win32;
  // `where claude` lista tudo que bate (claude, claude.cmd, claude.exe…):
  // prefere .exe (instalador nativo), depois .cmd (npm -g).
  const achados = procurar("claude").filter((p) => /\.(exe|cmd|bat)$/i.test(p));
  achados.sort((a, b) => Number(/\.exe$/i.test(b)) - Number(/\.exe$/i.test(a)));
  const appData = lerEnv(env, "APPDATA") ?? w.join(casa, "AppData", "Roaming");
  const comuns = [
    w.join(casa, ".local", "bin", "claude.exe"),
    w.join(casa, ".claude", "local", "claude.exe"),
    w.join(appData, "npm", "claude.cmd"),
    w.join(casa, ".claude", "local", "claude.cmd"),
  ];
  for (const c of [...achados, ...comuns.filter((c) => existe(c))]) {
    const n = normalizarClaude(c, plataforma, ler);
    if (n && (n === c || existe(n))) return n;
  }
  return null;
}

function normalizarClaude(p: string, plataforma: Plataforma, ler: (p: string) => string): string | null {
  if (!ehWindows(plataforma) || !/\.(cmd|bat)$/i.test(p)) return p;
  try {
    return alvoDoShimCmd(ler(p), path.win32.dirname(p)) ?? null;
  } catch {
    return null;
  }
}

/** Para rodar o claude fora do SDK (ex.: `--version`): .js vai pelo node. */
export function comandoDoClaude(exe: string, args: string[]): { arquivo: string; args: string[] } {
  if (/\.(c|m)?js$/i.test(exe)) return { arquivo: process.execPath, args: [exe, ...args] };
  return { arquivo: exe, args };
}

// ------------------------------------------------------------ arquivos

const ERROS_TRANSITORIOS = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * rename atômico com nova tentativa: no Windows o antivírus/indexador segura o
 * arquivo de destino por alguns ms e o rename falha com EPERM/EBUSY.
 */
export function renameComRetrySync(de: string, para: string, tentativas = 10): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(de, para);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!ERROS_TRANSITORIOS.has(code) || i >= tentativas - 1) throw err;
      // Espera curta e síncrona (o store grava de forma síncrona).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
    }
  }
}

export async function renameComRetry(de: string, para: string, tentativas = 10): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(de, para);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!ERROS_TRANSITORIOS.has(code) || i >= tentativas - 1) throw err;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
}
