/**
 * Instaladores das ferramentas do InHouse. Regras:
 * - Só por ação explícita (clique na tela ou dois cliques no setup.*).
 * - Sem senha de administrador: Node, gh e PortableGit vão para
 *   ~/.inhouse/ferramentas; Git do winget e o instalador oficial do Claude são
 *   instalações normais do usuário.
 * - Downloads só por HTTPS de domínios fixos, com SHA-256 conferido quando o
 *   publicador oferece (Node, gh, PortableGit). Pasta só é trocada depois de
 *   extrair e validar; se algo falha, a versão antiga fica.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SetupItem, SetupItemId } from "../../shared/types.js";
import { comandoDoClaude, matarArvore, renameComRetry, resolverExecutavel, spawnOpcoes } from "../platform.js";
import { forcarPortatil, pastaFerramentas } from "./ambiente.js";
import type { SO } from "./ambiente.js";
import { localizarClaude, localizarGitWindows, versaoDe } from "./detectar.js";
import type { Maquina, ResultadoExec } from "./detectar.js";

// ------------------------------------------------------------- fontes

export const URL_NODE = "https://nodejs.org/dist/latest-v24.x/";
export const URL_CLAUDE_SH = "https://claude.ai/install.sh";
export const URL_CLAUDE_PS1 = "https://claude.ai/install.ps1";
export const URL_GH_RELEASE = "https://api.github.com/repos/cli/cli/releases/latest";
export const URL_GIT_RELEASE = "https://api.github.com/repos/git-for-windows/git/releases/latest";

const DOMINIOS = new Set([
  "nodejs.org",
  "claude.ai",
  "downloads.claude.ai", // claude.ai/install.* redireciona para cá
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

export function urlPermitida(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && DOMINIOS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Linha do SHASUMS256.txt do Node para este SO/arquitetura. */
export function acharNodeNoShasums(texto: string, so: SO, arch: "x64" | "arm64"): { arquivo: string; sha256: string } | null {
  const plat = so === "mac" ? "darwin" : so === "windows" ? "win" : "linux";
  const ext = so === "windows" ? "zip" : "tar.gz";
  const re = new RegExp(`^([0-9a-f]{64})\\s+(node-v24\\.\\d+\\.\\d+-${plat}-${arch}\\.${ext.replace(".", "\\.")})$`);
  for (const linha of texto.split(/\r?\n/)) {
    const m = linha.trim().match(re);
    if (m) return { sha256: m[1]!, arquivo: m[2]! };
  }
  return null;
}

interface AssetGitHub {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

function assetsDe(release: unknown): AssetGitHub[] {
  const a = (release as { assets?: unknown })?.assets;
  return Array.isArray(a) ? (a as AssetGitHub[]).filter((x) => typeof x?.name === "string" && typeof x?.browser_download_url === "string") : [];
}

/** Asset do gh e o arquivo de checksums do mesmo release. */
export function acharGh(release: unknown, so: SO, arch: "x64" | "arm64"): { asset: AssetGitHub; checksums: AssetGitHub } | null {
  const plat = so === "mac" ? "macOS" : so === "windows" ? "windows" : "linux";
  const a = arch === "x64" ? "amd64" : "arm64";
  const ext = so === "linux" ? "tar\\.gz" : "zip";
  const re = new RegExp(`^gh_[\\d.]+_${plat}_${a}\\.${ext}$`);
  const assets = assetsDe(release);
  const asset = assets.find((x) => re.test(x.name));
  const checksums = assets.find((x) => /^gh_[\d.]+_checksums\.txt$/.test(x.name));
  return asset && checksums ? { asset, checksums } : null;
}

export function shaNoChecksums(texto: string, arquivo: string): string | null {
  for (const linha of texto.split(/\r?\n/)) {
    const m = linha.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2] === arquivo) return m[1]!;
  }
  return null;
}

/** PortableGit do release do git-for-windows, com o SHA-256 do campo digest. */
export function acharPortableGit(release: unknown, arch: "x64" | "arm64"): { asset: AssetGitHub; sha256: string } | null {
  const re = arch === "x64" ? /^PortableGit-[\d.]+(?:\.\d+)?-64-bit\.7z\.exe$/ : /^PortableGit-[\d.]+(?:\.\d+)?-arm64\.7z\.exe$/;
  const asset = assetsDe(release).find((x) => re.test(x.name));
  if (!asset) return null;
  const sha = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  return sha ? { asset, sha256: sha } : null;
}

// ------------------------------------------------------------- plano

export type Metodo = "node-portatil" | "git-winget" | "git-portatil" | "git-xcode" | "claude-script" | "gh-portatil";

export interface Passo {
  metodo: Metodo;
  /** Itens que este passo resolve (winget/PortableGit resolvem git e gitbash). */
  itens: SetupItemId[];
}

export class ErroSetup extends Error {
  constructor(message: string, readonly item?: SetupItemId) {
    super(message);
  }
}

const INSTALAVEIS: ReadonlySet<SetupItemId> = new Set(["node", "git", "gitbash", "claude", "gh"]);

/**
 * O que instalar e em que ordem. Sem `pedidos`: os obrigatórios faltando ou
 * com erro. Com `pedidos`: só esses (os já ok são pulados, salvo forçados).
 * Ordem fixa: Node → Git → Claude Code (no Windows o Claude exige o Git Bash) → gh.
 */
export function planejar(itens: SetupItem[], so: SO, pedidos?: SetupItemId[], env: NodeJS.ProcessEnv = process.env): Passo[] {
  const forcar = forcarPortatil(env);
  const porId = new Map(itens.map((i) => [i.id, i]));
  const precisa = (id: SetupItemId): boolean => {
    if (pedidos && !pedidos.includes(id)) return false;
    if (forcar.has(id === "gitbash" ? "git" : id) && pedidos?.includes(id)) return true;
    const it = porId.get(id);
    if (!it) return false;
    if (it.estado === "ok") return false;
    if (it.estado === "aviso") return Boolean(pedidos); // aviso só instala se pedido
    if (!pedidos && !it.obrigatorio) return false;
    return it.acao === "instalar" || it.estado === "erro";
  };
  const passos: Passo[] = [];
  if (precisa("node")) passos.push({ metodo: "node-portatil", itens: ["node"] });
  const git = precisa("git");
  const gitbash = so === "windows" && precisa("gitbash");
  if (so === "windows" && (git || gitbash)) {
    const portatil = forcar.has("git") || (!git && gitbash);
    passos.push({ metodo: portatil ? "git-portatil" : "git-winget", itens: [...(git ? ["git" as const] : []), ...(gitbash ? ["gitbash" as const] : [])] });
  } else if (git && so === "mac") {
    passos.push({ metodo: "git-xcode", itens: ["git"] });
  } else if (git && so === "linux") {
    throw new ErroSetup("No Linux o InHouse não instala o Git. Rode: sudo apt install git", "git");
  }
  if (precisa("claude")) passos.push({ metodo: "claude-script", itens: ["claude"] });
  if (precisa("gh")) passos.push({ metodo: "gh-portatil", itens: ["gh"] });
  return passos;
}

export function itemInstalavel(id: string): id is SetupItemId {
  return INSTALAVEIS.has(id as SetupItemId);
}

export function descreverPasso(p: Passo, so: SO): string {
  switch (p.metodo) {
    case "node-portatil":
      return `Node.js 24 (portátil, de ${URL_NODE}) em ~/.inhouse/ferramentas/node`;
    case "git-winget":
      return "Git for Windows pelo winget (o Windows pode pedir \"Sim\"); se não der, o Git portátil";
    case "git-portatil":
      return "Git portátil (PortableGit, com Git Bash) em ~/.inhouse/ferramentas/git";
    case "git-xcode":
      return "Git pelas ferramentas da Apple (xcode-select --install; abre uma janela da Apple)";
    case "claude-script":
      return `Claude Code pelo instalador oficial (${so === "windows" ? URL_CLAUDE_PS1 : URL_CLAUDE_SH})`;
    case "gh-portatil":
      return "GitHub CLI (portátil) em ~/.inhouse/ferramentas/gh";
  }
}

// ------------------------------------------------------------- execução

export interface Rede {
  texto(url: string): Promise<string>;
  json(url: string): Promise<unknown>;
  /** Baixa para `destino` e devolve o SHA-256 (hex) do que foi gravado. */
  baixar(url: string, destino: string, aoProgredir?: (pct: number) => void): Promise<string>;
}

/**
 * Ambiente para chamar o Windows PowerShell 5.1. Aberto de dentro do PowerShell 7
 * (o terminal padrão de muita gente, e o do CI), ele herda o PSModulePath do 7 e não
 * acha os módulos de sempre (Get-FileHash some e o instalador do Claude quebra).
 * Sem a variável, o 5.1 monta o caminho padrão dele.
 */
export function envParaPowerShell(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const k of Object.keys(e)) if (k.toLowerCase() === "psmodulepath") delete e[k];
  return e;
}

export interface OpcoesRodar {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  aoLinha?: (linha: string) => void;
}
export type Rodar = (cmd: string, args: string[], opts: OpcoesRodar) => Promise<ResultadoExec>;

export interface ContextoInstalacao {
  m: Maquina;
  rede: Rede;
  rodar: Rodar;
  progresso(item: SetupItemId, mensagem: string, pct?: number): void;
  log(item: SetupItemId, linha: string): void;
  dormir(ms: number): Promise<void>;
  /** Tempo máximo esperando as ferramentas da Apple (padrão 30 min). */
  esperaXcodeMs?: number;
}

function novoId(): string {
  return randomBytes(4).toString("hex");
}

function ferramentas(ctx: ContextoInstalacao): string {
  const f = pastaFerramentas(ctx.m.env, ctx.m.casa);
  mkdirSync(f, { recursive: true });
  return f;
}

async function baixarConferido(ctx: ContextoInstalacao, item: SetupItemId, url: string, destino: string, sha256: string): Promise<void> {
  ctx.progresso(item, "Baixando…", 0);
  ctx.log(item, `baixando ${url}`);
  const obtido = await ctx.rede.baixar(url, destino, (pct) => ctx.progresso(item, `Baixando… ${pct}%`, pct));
  if (obtido.toLowerCase() !== sha256.toLowerCase()) {
    ctx.log(item, `checksum esperado ${sha256}, obtido ${obtido}`);
    throw new ErroSetup("O arquivo baixado veio diferente do publicado (checksum). Tente de novo.", item);
  }
  ctx.log(item, "checksum SHA-256 conferido");
}

/** A única pasta de topo de um extraído (tarball do Node/gh) ou a própria pasta. */
function raizExtraida(dir: string): string {
  const entradas = readdirSync(dir).filter((n) => !n.startsWith("."));
  if (entradas.length === 1) {
    const unica = path.join(dir, entradas[0]!);
    if (statSync(unica).isDirectory()) return unica;
  }
  return dir;
}

/**
 * Extrai em ferramentas/.tmp-<id>, troca a pasta de destino de forma atômica e
 * valida. Se a extração ou a validação falham, a versão anterior volta.
 */
export async function instalarPasta(
  ctx: ContextoInstalacao,
  item: SetupItemId,
  nome: "node" | "gh" | "git",
  extrair: (tmp: string) => Promise<void>,
  validar: (destino: string) => Promise<string | null>,
): Promise<string> {
  const f = ferramentas(ctx);
  const id = novoId();
  const tmp = path.join(f, `.tmp-${nome}-${id}`);
  const velha = path.join(f, `.old-${nome}-${id}`);
  const destino = path.join(f, nome);
  mkdirSync(tmp, { recursive: true });
  try {
    ctx.progresso(item, "Extraindo…");
    await extrair(tmp);
    const raiz = raizExtraida(tmp);
    const tinha = existsSync(destino);
    if (tinha) await renameComRetry(destino, velha);
    try {
      await renameComRetry(raiz, destino);
    } catch (err) {
      if (tinha) await renameComRetry(velha, destino);
      throw err;
    }
    ctx.progresso(item, "Conferindo…");
    const versao = await validar(destino);
    if (!versao) {
      rmSync(destino, { recursive: true, force: true });
      if (tinha) await renameComRetry(velha, destino);
      throw new ErroSetup("Instalou, mas o programa não abriu. Tente de novo.", item);
    }
    return versao;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(velha, { recursive: true, force: true });
  }
}

function tarDoSistema(m: Maquina): string {
  // No Windows, o tar do Git (GNU) pode vir antes no PATH e não abre .zip;
  // o bsdtar do próprio Windows abre.
  if (m.so === "windows") return path.win32.join(m.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe");
  return m.so === "mac" ? "/usr/bin/tar" : "tar";
}

async function extrairArquivo(ctx: ContextoInstalacao, item: SetupItemId, arquivo: string, tmp: string): Promise<void> {
  const args = arquivo.endsWith(".tar.gz") ? ["-xzf", arquivo, "-C", tmp] : ["-xf", arquivo, "-C", tmp];
  const r = await ctx.rodar(tarDoSistema(ctx.m), args, { timeoutMs: 5 * 60_000, aoLinha: (l) => ctx.log(item, l) });
  if (r.code !== 0) throw new ErroSetup("Não deu para extrair o arquivo baixado.", item);
}

async function versaoDoBinario(ctx: ContextoInstalacao, exe: string): Promise<string | null> {
  const r = await ctx.rodar(exe, ["--version"], { timeoutMs: 15_000 });
  return r.code === 0 ? (versaoDe(r.stdout) ?? r.stdout.trim()) || null : null;
}

function exigirArch(ctx: ContextoInstalacao, item: SetupItemId): "x64" | "arm64" {
  if (!ctx.m.arch) throw new ErroSetup("Este computador não é suportado (arquitetura desconhecida).", item);
  return ctx.m.arch;
}

function pastaTemp(): string {
  const d = path.join(tmpdir(), `inhouse-setup-${novoId()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

export async function instalarNodePortatil(ctx: ContextoInstalacao): Promise<string> {
  const arch = exigirArch(ctx, "node");
  ctx.progresso("node", "Procurando a versão mais nova do Node 24…");
  const linha = acharNodeNoShasums(await ctx.rede.texto(`${URL_NODE}SHASUMS256.txt`), ctx.m.so, arch);
  if (!linha) throw new ErroSetup("Não achei o Node 24 para este computador no site oficial.", "node");
  const tmp = pastaTemp();
  try {
    const arq = path.join(tmp, linha.arquivo);
    await baixarConferido(ctx, "node", `${URL_NODE}${linha.arquivo}`, arq, linha.sha256);
    return await instalarPasta(
      ctx,
      "node",
      "node",
      (dir) => extrairArquivo(ctx, "node", arq, dir),
      (dest) => versaoDoBinario(ctx, ctx.m.so === "windows" ? path.win32.join(dest, "node.exe") : path.join(dest, "bin", "node")),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function instalarGhPortatil(ctx: ContextoInstalacao): Promise<string> {
  const arch = exigirArch(ctx, "gh");
  ctx.progresso("gh", "Procurando a versão mais nova do GitHub CLI…");
  const achado = acharGh(await ctx.rede.json(URL_GH_RELEASE), ctx.m.so, arch);
  if (!achado) throw new ErroSetup("Não achei o GitHub CLI para este computador.", "gh");
  const sha = shaNoChecksums(await ctx.rede.texto(achado.checksums.browser_download_url), achado.asset.name);
  if (!sha) throw new ErroSetup("O GitHub CLI não publicou o checksum deste arquivo; não vou instalar sem conferir.", "gh");
  const tmp = pastaTemp();
  try {
    const arq = path.join(tmp, achado.asset.name);
    await baixarConferido(ctx, "gh", achado.asset.browser_download_url, arq, sha);
    return await instalarPasta(
      ctx,
      "gh",
      "gh",
      (dir) => extrairArquivo(ctx, "gh", arq, dir),
      (dest) => versaoDoBinario(ctx, ctx.m.so === "windows" ? path.win32.join(dest, "bin", "gh.exe") : path.join(dest, "bin", "gh")),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function instalarPortableGit(ctx: ContextoInstalacao, item: SetupItemId = "git"): Promise<string> {
  const arch = exigirArch(ctx, item);
  ctx.progresso(item, "Procurando o Git portátil…");
  const achado = acharPortableGit(await ctx.rede.json(URL_GIT_RELEASE), arch);
  if (!achado) {
    throw new ErroSetup("O Git portátil não está disponível com checksum agora. Instale o Git for Windows em git-scm.com.", item);
  }
  const tmp = pastaTemp();
  try {
    const arq = path.join(tmp, achado.asset.name);
    await baixarConferido(ctx, item, achado.asset.browser_download_url, arq, achado.sha256);
    return await instalarPasta(
      ctx,
      item,
      "git",
      async (dir) => {
        // Autoextraível do 7-Zip: -o<pasta> -y (sem perguntas).
        const r = await ctx.rodar(arq, [`-o${dir}`, "-y"], { timeoutMs: 10 * 60_000, aoLinha: (l) => ctx.log(item, l) });
        if (r.code !== 0) throw new ErroSetup("Não deu para extrair o Git portátil.", item);
      },
      async (dest) => {
        const v = await versaoDoBinario(ctx, path.win32.join(dest, "cmd", "git.exe"));
        return v && ctx.m.existe(path.win32.join(dest, "bin", "bash.exe")) ? v : null;
      },
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function instalarGitWinget(ctx: ContextoInstalacao): Promise<string> {
  const winget = resolverExecutavel("winget", { plataforma: "win32", env: ctx.m.env, existe: (p) => ctx.m.existe(p), cwd: "" });
  if (/\.exe$/i.test(winget)) {
    ctx.progresso("git", "Instalando o Git for Windows (se o Windows perguntar, clique em Sim)…");
    const r = await ctx.rodar(
      winget,
      ["install", "--id", "Git.Git", "-e", "--source", "winget", "--silent", "--accept-package-agreements", "--accept-source-agreements"],
      { timeoutMs: 20 * 60_000, aoLinha: (l) => ctx.log("git", l) },
    );
    const git = localizarGitWindows(ctx.m);
    if (r.code === 0 && git) {
      const v = await versaoDoBinario(ctx, git);
      if (v) return v;
    }
    ctx.log("git", `winget terminou com código ${r.code ?? "?"}; usando o Git portátil`);
  } else {
    ctx.log("git", "winget não encontrado; usando o Git portátil");
  }
  return instalarPortableGit(ctx, "git");
}

export async function instalarGitMac(ctx: ContextoInstalacao): Promise<string> {
  ctx.progresso("git", "Abrindo a janela da Apple para instalar o Git…");
  const r = await ctx.rodar("xcode-select", ["--install"], { timeoutMs: 60_000, aoLinha: (l) => ctx.log("git", l) });
  ctx.log("git", `xcode-select --install terminou com código ${r.code ?? "?"}`);
  const limite = Date.now() + (ctx.esperaXcodeMs ?? 30 * 60_000);
  for (;;) {
    const p = await ctx.rodar("xcode-select", ["-p"], { timeoutMs: 10_000 });
    if (p.code === 0) {
      const v = await ctx.rodar("git", ["--version"], { timeoutMs: 10_000 });
      if (v.code === 0) return versaoDe(v.stdout) ?? "?";
    }
    if (Date.now() > limite) throw new ErroSetup("A instalação da Apple não terminou em 30 minutos. Clique em Tentar de novo.", "git");
    ctx.progresso("git", "Na janela da Apple, clique em Instalar. Esperando terminar…");
    await ctx.dormir(5_000);
  }
}

export async function instalarClaude(ctx: ContextoInstalacao): Promise<string> {
  const win = ctx.m.so === "windows";
  const url = win ? URL_CLAUDE_PS1 : URL_CLAUDE_SH;
  ctx.progresso("claude", "Baixando o instalador oficial do Claude Code…");
  const tmp = pastaTemp();
  try {
    const script = path.join(tmp, win ? "install.ps1" : "install.sh");
    await ctx.rede.baixar(url, script);
    ctx.progresso("claude", "Instalando o Claude Code… (leva uns minutos)");
    const r = win
      ? await ctx.rodar("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
          timeoutMs: 10 * 60_000,
          env: envParaPowerShell(ctx.m.env),
          aoLinha: (l) => ctx.log("claude", l),
        })
      : await ctx.rodar("bash", [script], { timeoutMs: 10 * 60_000, aoLinha: (l) => ctx.log("claude", l) });
    if (r.code !== 0) {
      throw new ErroSetup(
        r.falhaAoIniciar === "timeout" ? "O instalador do Claude passou de 10 minutos. Tente de novo." : "O instalador do Claude Code falhou. Veja os detalhes e tente de novo.",
        "claude",
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const exe = localizarClaude(ctx.m);
  if (!exe) throw new ErroSetup("O instalador terminou, mas o Claude Code não apareceu. Tente de novo.", "claude");
  const c = comandoDoClaude(exe, ["--version"]);
  const v = await ctx.rodar(c.arquivo, c.args, { timeoutMs: 15_000 });
  if (v.code !== 0) throw new ErroSetup("O Claude Code foi instalado, mas não abriu. Tente de novo.", "claude");
  return versaoDe(v.stdout) ?? "?";
}

export async function executarPasso(passo: Passo, ctx: ContextoInstalacao): Promise<string> {
  switch (passo.metodo) {
    case "node-portatil":
      return instalarNodePortatil(ctx);
    case "git-winget":
      return instalarGitWinget(ctx);
    case "git-portatil":
      return instalarPortableGit(ctx, passo.itens[0]);
    case "git-xcode":
      return instalarGitMac(ctx);
    case "claude-script":
      return instalarClaude(ctx);
    case "gh-portatil":
      return instalarGhPortatil(ctx);
  }
}

// ------------------------------------------------------------- trava

export interface Trava {
  liberar(): void;
}

function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Trava entre processos (duas janelas do InHouse, ou o setup.* com o servidor
 * aberto): ferramentas/.lock com pid e hora. Vencida se o pid morreu ou passou
 * de 30 min. null = ocupada por outro.
 */
export function adquirirTrava(dir: string, agora = Date.now(), vivo: (pid: number) => boolean = pidVivo): Trava | null {
  mkdirSync(dir, { recursive: true });
  const arq = path.join(dir, ".lock");
  const conteudo = JSON.stringify({ pid: process.pid, em: agora });
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      writeFileSync(arq, conteudo, { flag: "wx" });
      return {
        liberar: () => {
          try {
            const atual = JSON.parse(readFileSync(arq, "utf8")) as { pid?: number };
            if (atual.pid === process.pid) rmSync(arq, { force: true });
          } catch {
            // já liberada
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let vencida = true;
      try {
        const t = JSON.parse(readFileSync(arq, "utf8")) as { pid?: number; em?: number };
        vencida = !t.pid || !vivo(t.pid) || agora - (t.em ?? 0) > 30 * 60_000;
      } catch {
        vencida = true;
      }
      if (!vencida) return null;
      rmSync(arq, { force: true });
    }
  }
  return null;
}

// ------------------------------------------------------------- reais

const filhos = new Set<ChildProcess>();

/** Mata instaladores/login em curso (shutdown do servidor). */
export function matarFilhosDoSetup(): void {
  for (const f of filhos) matarArvore(f.pid, "SIGKILL");
  filhos.clear();
}

export function registrarFilho(f: ChildProcess): void {
  filhos.add(f);
  f.on("exit", () => filhos.delete(f));
}

export const rodarReal: Rodar = (cmd, args, opts) =>
  new Promise((resolve) => {
    const alvo = process.platform === "win32" ? resolverExecutavel(cmd, { env: opts.env ?? process.env }) : cmd;
    let stdout = "";
    let stderr = "";
    let resto = "";
    let estourou = false;
    let filho: ChildProcess;
    try {
      filho = spawn(alvo, args, { ...spawnOpcoes(), cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", falhaAoIniciar: "outro" });
      return;
    }
    registrarFilho(filho);
    const linhas = (chunk: string) => {
      resto += chunk;
      const partes = resto.split(/\r?\n|\r/);
      resto = partes.pop() ?? "";
      for (const l of partes) if (l.trim()) opts.aoLinha?.(limparAnsi(l).slice(0, 300));
    };
    filho.stdout?.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
      linhas(c);
    });
    filho.stderr?.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
      linhas(c);
    });
    const t = setTimeout(() => {
      estourou = true;
      matarArvore(filho.pid, "SIGKILL");
    }, opts.timeoutMs);
    filho.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(t);
      resolve({ code: null, stdout, stderr, falhaAoIniciar: err.code === "ENOENT" ? "enoent" : "outro" });
    });
    filho.on("close", (code) => {
      clearTimeout(t);
      if (resto.trim()) opts.aoLinha?.(limparAnsi(resto).slice(0, 300));
      resolve({ code: estourou ? null : code, stdout, stderr, ...(estourou ? { falhaAoIniciar: "timeout" as const } : {}) });
    });
  });

export function limparAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, "");
}

function cabecalhos(url: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "inhouse-setup" };
  // No CI o runner compartilha IP e a API do GitHub limita anônimos a 60/h.
  if (new URL(url).hostname === "api.github.com" && env["GITHUB_TOKEN"]) h["authorization"] = `Bearer ${env["GITHUB_TOKEN"]}`;
  return h;
}

async function buscar(url: string, env: NodeJS.ProcessEnv): Promise<Response> {
  if (!urlPermitida(url)) throw new ErroSetup(`Endereço de download não permitido: ${url}`);
  const res = await fetch(url, { headers: cabecalhos(url, env), redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!urlPermitida(res.url || url)) throw new ErroSetup(`O download foi redirecionado para um endereço não permitido.`);
  if ((res.status === 403 || res.status === 429) && new URL(url).hostname === "api.github.com") {
    throw new ErroSetup("O GitHub limitou as consultas desta rede por agora. Espere uns minutos e tente de novo.");
  }
  if (!res.ok) throw new ErroSetup(`O servidor de download respondeu ${res.status}. Verifique a internet e tente de novo.`);
  return res;
}

export function redeReal(env: NodeJS.ProcessEnv = process.env): Rede {
  return {
    texto: async (url) => (await buscar(url, env)).text(),
    json: async (url) => (await buscar(url, env)).json(),
    baixar: async (url, destino, aoProgredir) => {
      const res = await buscar(url, env);
      const total = Number(res.headers.get("content-length") ?? 0);
      const hash = createHash("sha256");
      let lidos = 0;
      let ultimo = -1;
      const contar = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          lidos += chunk.length;
          if (total > 0 && aoProgredir) {
            const pct = Math.floor((lidos / total) * 100);
            if (pct !== ultimo) {
              ultimo = pct;
              aoProgredir(pct);
            }
          }
          cb(null, chunk);
        },
      });
      if (!res.body) throw new ErroSetup("O download veio vazio.");
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), contar, createWriteStream(destino));
      return hash.digest("hex");
    },
  };
}
