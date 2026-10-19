/**
 * Ambiente das ferramentas instaladas pelo InHouse. É o PRIMEIRO import de
 * server/index.ts e server/setup/cli.ts: no import, põe no PATH do processo as
 * pastas de ~/.inhouse/ferramentas e ~/.local/bin (onde o instalador oficial
 * do Claude Code instala) e, no Windows, aponta CLAUDE_CODE_GIT_BASH_PATH para
 * o Git Bash portátil. Assim um servidor que acabou de instalar algo enxerga a
 * ferramenta sem reiniciar.
 *
 * Folha de propósito: só importa node:* (nada do projeto), para ser seguro
 * como primeiro import.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type SO = "mac" | "windows" | "linux";

export function soAtual(plataforma: NodeJS.Platform = process.platform): SO {
  return plataforma === "win32" ? "windows" : plataforma === "darwin" ? "mac" : "linux";
}

/** Arquitetura no vocabulário do Node (x64/arm64); null = não suportada. */
export function arquitetura(so: SO, env: NodeJS.ProcessEnv, unameM?: string): "x64" | "arm64" | null {
  if (so === "windows") {
    const a = (env["PROCESSOR_ARCHITEW6432"] ?? env["PROCESSOR_ARCHITECTURE"] ?? "").toUpperCase();
    if (a === "AMD64" || a === "X64") return "x64";
    if (a === "ARM64") return "arm64";
    return null;
  }
  const m = (unameM ?? "").toLowerCase();
  if (m === "x86_64" || m === "amd64" || m === "x64") return "x64";
  if (m === "arm64" || m === "aarch64") return "arm64";
  return null;
}

export function pastaFerramentas(env: NodeJS.ProcessEnv = process.env, casa: string = homedir()): string {
  return env["INHOUSE_TOOLS_DIR"] || path.join(casa, ".inhouse", "ferramentas");
}

/** Nome real da variável PATH no objeto (no Windows costuma ser "Path"). */
export function chavePath(env: NodeJS.ProcessEnv): string {
  if ("PATH" in env) return "PATH";
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

/** Ferramentas forçadas como portáteis (CI): INHOUSE_FORCAR_PORTATIL=node,git,gh. */
export function forcarPortatil(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env["INHOUSE_FORCAR_PORTATIL"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}

export interface PastasDeFerramenta {
  /** Vão para o começo do PATH. */
  antes: string[];
  /** Vão para o fim (o Node portátil: o app de Mac traz o próprio Node e ele deve continuar valendo). */
  depois: string[];
  gitBash?: string;
}

/** Quais pastas entram no PATH para este SO (só as que existem). */
export function pastasDeFerramenta(
  so: SO,
  env: NodeJS.ProcessEnv,
  casa: string,
  existe: (p: string) => boolean = existsSync,
): PastasDeFerramenta {
  const p = so === "windows" ? path.win32 : path.posix;
  const f = pastaFerramentas(env, casa);
  const antes: string[] = [];
  const depois: string[] = [];
  antes.push(p.join(casa, ".local", "bin"));
  if (so === "windows") {
    antes.push(p.join(f, "git", "cmd"));
    antes.push(p.join(f, "gh", "bin"));
    depois.push(p.join(f, "node"));
    // Git for Windows instalado pelo winget enquanto o InHouse estava aberto:
    // o PATH deste processo é o de antes da instalação.
    for (const base of [env["ProgramFiles"], env["ProgramW6432"], env["LOCALAPPDATA"] && p.join(env["LOCALAPPDATA"], "Programs")]) {
      if (base) antes.push(p.join(base, "Git", "cmd"));
    }
  } else {
    antes.push(p.join(f, "gh", "bin"));
    depois.push(p.join(f, "node", "bin"));
  }
  const gitBash = so === "windows" ? p.join(f, "git", "bin", "bash.exe") : undefined;
  return {
    antes: antes.filter((d) => existe(d)),
    depois: depois.filter((d) => existe(d)),
    gitBash: gitBash && existe(gitBash) ? gitBash : undefined,
  };
}

/** PATH novo: pastas `antes` no começo e `depois` no fim, sem repetir as que já estão. */
export function montarPath(atual: string, pastas: PastasDeFerramenta, so: SO): string {
  const sep = so === "windows" ? ";" : ":";
  const norm = (d: string) => (so === "windows" ? d.toLowerCase().replace(/[\\/]+$/, "") : d.replace(/\/+$/, ""));
  const partes = atual.split(sep).filter(Boolean);
  const tem = new Set(partes.map(norm));
  const antes = pastas.antes.filter((d) => !tem.has(norm(d)));
  const depois = pastas.depois.filter((d) => !tem.has(norm(d)));
  return [...antes, ...partes, ...depois].join(sep);
}

/**
 * Aplica as ferramentas no ambiente (padrão: o do processo). Idempotente:
 * rodar de novo depois de uma instalação só acrescenta o que passou a existir.
 */
export function aplicarAmbiente(
  env: NodeJS.ProcessEnv = process.env,
  opts: { so?: SO; casa?: string; existe?: (p: string) => boolean } = {},
): void {
  const so = opts.so ?? soAtual();
  const casa = opts.casa ?? homedir();
  const pastas = pastasDeFerramenta(so, env, casa, opts.existe);
  const k = chavePath(env);
  env[k] = montarPath(env[k] ?? "", pastas, so);
  if (pastas.gitBash && !env["CLAUDE_CODE_GIT_BASH_PATH"]) env["CLAUDE_CODE_GIT_BASH_PATH"] = pastas.gitBash;
}

aplicarAmbiente();
