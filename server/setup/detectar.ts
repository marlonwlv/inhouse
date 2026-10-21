/**
 * Detecção do que o InHouse precisa no computador. Tudo passa por uma
 * `Maquina` injetável (SO, env, existe, exec) para os testes simularem Mac,
 * Windows e Linux sem executar nada.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SetupItem, SetupItemId } from "../../shared/types.js";
import { acharGitBash, comandoDoClaude, resolverClaude, resolverExecutavel } from "../platform.js";
import { arquitetura, pastaFerramentas, soAtual } from "./ambiente.js";
import type { SO } from "./ambiente.js";

export interface ResultadoExec {
  code: number | null;
  stdout: string;
  stderr: string;
  /** O executável não existe (ENOENT) ou estourou o tempo. */
  falhaAoIniciar?: "enoent" | "timeout" | "outro";
}

export interface Maquina {
  so: SO;
  arch: "x64" | "arm64" | null;
  env: NodeJS.ProcessEnv;
  casa: string;
  /** Versão do Node que roda este processo (sem o "v"). */
  versaoNode: string;
  existe(p: string): boolean;
  exec(cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<ResultadoExec>;
  /** which/where síncrono (linhas da saída; [] se não achou). */
  procurar(nome: string): string[];
}

export const NODE_MINIMO = 24;

function envSemChave(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Mesma regra do claudeEnv(): nunca deixar uma API key decidir o login.
  const e = { ...env };
  delete e["ANTHROPIC_API_KEY"];
  delete e["ANTHROPIC_AUTH_TOKEN"];
  delete e["ANTHROPIC_BASE_URL"];
  delete e["CLAUDECODE"];
  delete e["CLAUDE_CODE_ENTRYPOINT"];
  return e;
}

/** A máquina de verdade (process.env vivo: o PATH muda depois de instalar). */
export function maquinaReal(): Maquina {
  const so = soAtual();
  let unameM = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : process.arch;
  if (so === "mac") {
    // Node x64 rodando no Rosetta num Mac M1 diria x64; o uname da máquina diz a verdade.
    try {
      unameM = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
    } catch {
      // fica o do processo
    }
  }
  return {
    so,
    arch: arquitetura(so, process.env, unameM),
    env: process.env,
    casa: homedir(),
    versaoNode: process.versions.node,
    existe: existsSync,
    exec: (cmd, args, opts = {}) =>
      new Promise((resolve) => {
        const alvo = so === "windows" ? resolverExecutavel(cmd, { env: opts.env ?? process.env }) : cmd;
        execFile(
          alvo,
          args,
          { timeout: opts.timeoutMs ?? 10_000, env: opts.env ?? process.env, windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
            if (e && e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", falhaAoIniciar: "enoent" });
            if (e && e.killed) return resolve({ code: null, stdout: String(stdout), stderr: String(stderr), falhaAoIniciar: "timeout" });
            const code = e ? (typeof e.code === "number" ? e.code : 1) : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
    procurar: (nome) => {
      try {
        const out = execFileSync(so === "windows" ? "where" : "which", [nome], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

const TEXTOS: Record<SetupItemId, { titulo: string; descricao: string; obrigatorio: boolean }> = {
  node: { titulo: "Node.js", descricao: "O motor que roda o InHouse.", obrigatorio: true },
  git: { titulo: "Git", descricao: "Guarda as versões do seu projeto.", obrigatorio: true },
  gitbash: { titulo: "Git Bash", descricao: "O Claude Code usa no Windows.", obrigatorio: true },
  claude: { titulo: "Claude Code", descricao: "A IA que faz as mudanças no seu projeto.", obrigatorio: true },
  claude_login: { titulo: "Login no Claude", descricao: "Conecta a sua assinatura do Claude.", obrigatorio: true },
  git_identidade: { titulo: "Seu nome no Git", descricao: "Aparece nas versões que o InHouse salva.", obrigatorio: true },
  gh: { titulo: "GitHub CLI", descricao: "Para publicar no GitHub pelo InHouse.", obrigatorio: false },
  gh_login: { titulo: "Login no GitHub", descricao: "Conecta a sua conta do GitHub.", obrigatorio: false },
};

export function itemBase(id: SetupItemId, resto: Partial<SetupItem> & Pick<SetupItem, "estado">): SetupItem {
  return { id, ...TEXTOS[id], ...resto };
}

/** Itens que existem neste SO (Git Bash só no Windows). */
export function itensDoSO(so: SO): SetupItemId[] {
  return ["node", "git", ...(so === "windows" ? (["gitbash"] as const) : []), "claude", "claude_login", "git_identidade", "gh", "gh_login"];
}

function primeiraLinha(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
}

export function versaoDe(saida: string): string | undefined {
  return saida.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
}

// ---------------------------------------------------------------- itens

export async function detectarNode(m: Maquina): Promise<SetupItem> {
  const major = Number(m.versaoNode.split(".")[0]);
  if (major >= NODE_MINIMO) return itemBase("node", { estado: "ok", detalhe: `Pronto · v${m.versaoNode}` });
  return itemBase("node", {
    estado: "aviso",
    acao: "instalar",
    detalhe: `Versão antiga (v${m.versaoNode}). O InHouse pede a ${NODE_MINIMO}; dá para instalar a nova sem senha.`,
  });
}

/** Onde está o git.exe no Windows (PATH, Program Files, LOCALAPPDATA, portátil). */
export function localizarGitWindows(m: Maquina): string | null {
  const w = path.win32;
  const doPath = resolverExecutavel("git", { plataforma: "win32", env: m.env, existe: (p) => m.existe(p), cwd: "" });
  if (/\.exe$/i.test(doPath)) return doPath;
  const candidatos: string[] = [];
  for (const base of [m.env["ProgramFiles"], m.env["ProgramW6432"], m.env["LOCALAPPDATA"] && w.join(m.env["LOCALAPPDATA"], "Programs")]) {
    if (base) candidatos.push(w.join(base, "Git", "cmd", "git.exe"));
  }
  candidatos.push(w.join(pastaFerramentas(m.env, m.casa), "git", "cmd", "git.exe"));
  return candidatos.find((c) => m.existe(c)) ?? null;
}

export async function detectarGit(m: Maquina): Promise<SetupItem> {
  if (m.so === "mac") {
    // /usr/bin/git sem as Command Line Tools é um atalho que ABRE o diálogo da
    // Apple: só executamos git quando o xcode-select confirma as ferramentas.
    const xs = await m.exec("xcode-select", ["-p"], { timeoutMs: 10_000 });
    if (xs.code !== 0) {
      return itemBase("git", { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado (vem com as ferramentas da Apple)." });
    }
  }
  let exe = "git";
  if (m.so === "windows") {
    const achado = localizarGitWindows(m);
    if (!achado) return itemBase("git", { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado." });
    exe = achado;
  }
  const r = await m.exec(exe, ["--version"], { timeoutMs: 10_000 });
  if (r.code === 0) return itemBase("git", { estado: "ok", detalhe: `Pronto · v${versaoDe(r.stdout) ?? "?"}` });
  if (m.so === "linux") {
    return itemBase("git", { estado: "faltando", acao: "manual", detalhe: "No Linux, instale com: sudo apt install git" });
  }
  return itemBase("git", { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado." });
}

export async function detectarGitBash(m: Maquina): Promise<SetupItem> {
  const bash = acharGitBash(m.env, (p) => m.existe(p));
  const portatil = path.win32.join(pastaFerramentas(m.env, m.casa), "git", "bin", "bash.exe");
  const achado = bash ?? (m.existe(portatil) ? portatil : null);
  if (achado) return itemBase("gitbash", { estado: "ok", detalhe: "Pronto" });
  return itemBase("gitbash", { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado." });
}

export function localizarClaude(m: Maquina): string | null {
  return resolverClaude({
    plataforma: m.so === "windows" ? "win32" : m.so === "mac" ? "darwin" : "linux",
    env: m.env,
    casa: m.casa,
    existe: (p) => m.existe(p),
    procurar: (n) => m.procurar(n),
  });
}

export async function detectarClaude(m: Maquina): Promise<{ item: SetupItem; exe: string | null }> {
  const exe = localizarClaude(m);
  if (!exe) return { exe: null, item: itemBase("claude", { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado." }) };
  const c = comandoDoClaude(exe, ["--version"]);
  const r = await m.exec(c.arquivo, c.args, { timeoutMs: 10_000, env: envSemChave(m.env) });
  if (r.code === 0) return { exe, item: itemBase("claude", { estado: "ok", detalhe: `Pronto · v${versaoDe(r.stdout) ?? "?"}` }) };
  return { exe, item: itemBase("claude", { estado: "erro", acao: "instalar", detalhe: "O Claude Code não respondeu. Instale de novo." }) };
}

export async function detectarLoginClaude(m: Maquina, exe: string | null): Promise<SetupItem> {
  if (!exe) return itemBase("claude_login", { estado: "faltando", detalhe: "Instale o Claude Code primeiro." });
  const c = comandoDoClaude(exe, ["auth", "status", "--json"]);
  const r = await m.exec(c.arquivo, c.args, { timeoutMs: 10_000, env: envSemChave(m.env) });
  const json = lerJson(r.stdout);
  if (json && typeof json["loggedIn"] === "boolean") {
    if (json["loggedIn"]) {
      const quem = typeof json["email"] === "string" ? ` · ${json["email"]}` : "";
      return itemBase("claude_login", { estado: "ok", detalhe: `Claude conectado · sua assinatura${quem}` });
    }
    return itemBase("claude_login", { estado: "faltando", acao: "login", detalhe: "Falta entrar na sua conta do Claude." });
  }
  // CLI antigo sem `auth status`: não dá para confirmar, então não trava.
  return itemBase("claude_login", {
    estado: "aviso",
    acao: "login",
    detalhe: "Não deu para confirmar o login nesta versão do Claude Code.",
  });
}

function lerJson(s: string): Record<string, unknown> | null {
  const t = s.trim();
  const ini = t.indexOf("{");
  if (ini < 0) return null;
  try {
    const v = JSON.parse(t.slice(ini));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function lerIdentidade(m: Maquina, git: string): Promise<{ nome?: string; email?: string }> {
  const [n, e] = await Promise.all([
    m.exec(git, ["config", "--global", "user.name"], { timeoutMs: 10_000 }),
    m.exec(git, ["config", "--global", "user.email"], { timeoutMs: 10_000 }),
  ]);
  return {
    nome: n.code === 0 ? primeiraLinha(n.stdout) || undefined : undefined,
    email: e.code === 0 ? primeiraLinha(e.stdout) || undefined : undefined,
  };
}

export function comandoGit(m: Maquina): string {
  return m.so === "windows" ? (localizarGitWindows(m) ?? "git") : "git";
}

export async function detectarIdentidade(
  m: Maquina,
  gitOk: boolean,
): Promise<{ item: SetupItem; identidade: { nome?: string; email?: string } }> {
  if (!gitOk) return { identidade: {}, item: itemBase("git_identidade", { estado: "faltando", detalhe: "Instale o Git primeiro." }) };
  const identidade = await lerIdentidade(m, comandoGit(m));
  if (identidade.nome && identidade.email) {
    return { identidade, item: itemBase("git_identidade", { estado: "ok", detalhe: `${identidade.nome} · ${identidade.email}` }) };
  }
  return { identidade, item: itemBase("git_identidade", { estado: "faltando", acao: "identidade", detalhe: "Falta dizer seu nome e e-mail." }) };
}

export function localizarGh(m: Maquina): string | null {
  const f = pastaFerramentas(m.env, m.casa);
  if (m.so === "windows") {
    const doPath = resolverExecutavel("gh", { plataforma: "win32", env: m.env, existe: (p) => m.existe(p), cwd: "" });
    if (/\.exe$/i.test(doPath)) return doPath;
    const portatil = path.win32.join(f, "gh", "bin", "gh.exe");
    return m.existe(portatil) ? portatil : null;
  }
  const doPath = m.procurar("gh")[0];
  if (doPath) return doPath;
  const portatil = path.posix.join(f, "gh", "bin", "gh");
  return m.existe(portatil) ? portatil : null;
}

export async function detectarGh(m: Maquina): Promise<SetupItem[]> {
  const exe = localizarGh(m);
  if (!exe) {
    return [
      itemBase("gh", { estado: "faltando", acao: "instalar", detalhe: "Opcional · pule se não usa o GitHub." }),
      itemBase("gh_login", { estado: "faltando", detalhe: "Instale o GitHub CLI primeiro." }),
    ];
  }
  const v = await m.exec(exe, ["--version"], { timeoutMs: 10_000 });
  const gh = v.code === 0
    ? itemBase("gh", { estado: "ok", detalhe: `Pronto · v${versaoDe(v.stdout) ?? "?"}` })
    : itemBase("gh", { estado: "erro", acao: "instalar", detalhe: "O GitHub CLI não respondeu." });
  const s = await m.exec(exe, ["auth", "status"], { timeoutMs: 10_000 });
  const login = s.code === 0
    ? itemBase("gh_login", { estado: "ok", detalhe: "GitHub conectado" })
    : itemBase("gh_login", {
        estado: "faltando",
        acao: "manual",
        detalhe: "Opcional. Necessário para baixar repositórios privados. Para conectar, rode gh auth login uma vez no Terminal (o guia explica).",
      });
  return [gh, login];
}

export interface Deteccao {
  itens: SetupItem[];
  identidade: { nome?: string; email?: string };
}

/** Checa tudo em paralelo (cada subprocesso com timeout de 10 s). */
export async function detectarTudo(m: Maquina): Promise<Deteccao> {
  const [node, git, gitbash, claude, gh] = await Promise.all([
    detectarNode(m),
    detectarGit(m),
    m.so === "windows" ? detectarGitBash(m) : Promise.resolve(null),
    detectarClaude(m),
    detectarGh(m),
  ]);
  const [login, ident] = await Promise.all([
    detectarLoginClaude(m, claude.item.estado === "ok" ? claude.exe : null),
    detectarIdentidade(m, git.estado === "ok"),
  ]);
  const itens = [node, git, ...(gitbash ? [gitbash] : []), claude.item, login, ident.item, ...gh];
  return { itens, identidade: ident.identidade };
}

/** Obrigatórios ok (aviso conta como ok). */
export function prontoParaUsar(itens: SetupItem[]): boolean {
  return itens.filter((i) => i.obrigatorio).every((i) => i.estado === "ok" || i.estado === "aviso");
}
