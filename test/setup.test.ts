/**
 * Preparação do computador (server/setup/*): detecção por SO com uma Maquina
 * simulada, parsers dos downloads, plano de instalação, troca atômica,
 * trava, login do Claude, guardas das rotas e modo demonstração.
 * Nada aqui instala ou executa programas de verdade.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SetupItem, SetupStatus } from "../shared/types.js";
import { arquitetura, montarPath, pastaFerramentas, pastasDeFerramenta, forcarPortatil, aplicarAmbiente } from "../server/setup/ambiente.js";
import { lerArgs } from "../server/setup/cli.js";
import { mostrarAoAbrir, validarCodigo, validarIdentidade } from "../server/setup/comum.js";
import { CENARIOS, MotorDemo } from "../server/setup/demo.js";
import type { Maquina, ResultadoExec } from "../server/setup/detectar.js";
import { detectarTudo, itemBase, prontoParaUsar } from "../server/setup/detectar.js";
import {
  acharGh,
  envParaPowerShell,
  acharNodeNoShasums,
  acharPortableGit,
  adquirirTrava,
  instalarPasta,
  planejar,
  shaNoChecksums,
  urlPermitida,
} from "../server/setup/instalar.js";
import type { ContextoInstalacao } from "../server/setup/instalar.js";
import { acharUrl, LoginClaude } from "../server/setup/login.js";
import type { EstadoLogin, ProcessoLogin } from "../server/setup/login.js";
import { guardaSetup, hostLocal, origemLocal, registrarRotasSetup } from "../server/setup/rotas.js";

// ------------------------------------------------------------- máquina falsa

type Resposta = Partial<ResultadoExec> | ((args: string[]) => Partial<ResultadoExec>);

function maquina(o: {
  so: Maquina["so"];
  arquivos?: string[];
  comandos?: Record<string, Resposta>;
  versaoNode?: string;
  env?: NodeJS.ProcessEnv;
  noPath?: Record<string, string>;
}): Maquina & { chamadas: string[] } {
  const arquivos = new Set(o.arquivos ?? []);
  const chamadas: string[] = [];
  const casa = o.so === "windows" ? "C:\\Users\\ana" : "/Users/ana";
  return {
    chamadas,
    so: o.so,
    arch: "x64",
    env: { PATH: "", INHOUSE_TOOLS_DIR: "", ...(o.env ?? {}) },
    casa,
    versaoNode: o.versaoNode ?? "24.11.0",
    existe: (p) => arquivos.has(p),
    procurar: (n) => (o.noPath?.[n] ? [o.noPath[n]!] : []),
    exec: async (cmd, args) => {
      const chave = `${cmd} ${args.join(" ")}`;
      chamadas.push(chave);
      const r = Object.entries(o.comandos ?? {}).find(([k]) => chave === k || chave.startsWith(`${k} `))?.[1];
      if (!r) return { code: null, stdout: "", stderr: "", falhaAoIniciar: "enoent" };
      const v = typeof r === "function" ? r(args) : r;
      return { code: 0, stdout: "", stderr: "", ...v };
    },
  };
}

const porId = (itens: SetupItem[]) => Object.fromEntries(itens.map((i) => [i.id, i]));

// ------------------------------------------------------------- ambiente

describe("ambiente das ferramentas", () => {
  it("arquitetura por SO", () => {
    expect(arquitetura("windows", { PROCESSOR_ARCHITECTURE: "AMD64" })).toBe("x64");
    expect(arquitetura("windows", { PROCESSOR_ARCHITECTURE: "x86", PROCESSOR_ARCHITEW6432: "AMD64" })).toBe("x64");
    expect(arquitetura("windows", { PROCESSOR_ARCHITECTURE: "ARM64" })).toBe("arm64");
    expect(arquitetura("windows", { PROCESSOR_ARCHITECTURE: "x86" })).toBeNull();
    expect(arquitetura("mac", {}, "arm64")).toBe("arm64");
    expect(arquitetura("mac", {}, "x86_64")).toBe("x64");
    expect(arquitetura("linux", {}, "aarch64")).toBe("arm64");
    expect(arquitetura("linux", {}, "riscv64")).toBeNull();
  });

  it("pasta de ferramentas respeita INHOUSE_TOOLS_DIR", () => {
    expect(pastaFerramentas({}, "/Users/ana")).toBe(path.join("/Users/ana", ".inhouse", "ferramentas"));
    expect(pastaFerramentas({ INHOUSE_TOOLS_DIR: "/tmp/x" }, "/Users/ana")).toBe("/tmp/x");
    expect([...forcarPortatil({ INHOUSE_FORCAR_PORTATIL: " node, git ,gh," })]).toEqual(["node", "git", "gh"]);
  });

  it("Mac: gh no começo, Node portátil no FIM do PATH (o app traz o próprio Node)", () => {
    const f = "/Users/ana/.inhouse/ferramentas";
    const existe = (p: string) => [`${f}/gh/bin`, `${f}/node/bin`, "/Users/ana/.local/bin"].includes(p);
    const pastas = pastasDeFerramenta("mac", {}, "/Users/ana", existe);
    expect(pastas.antes).toEqual(["/Users/ana/.local/bin", `${f}/gh/bin`]);
    expect(pastas.depois).toEqual([`${f}/node/bin`]);
    expect(montarPath("/usr/bin:/Users/ana/.local/bin", pastas, "mac")).toBe(`${f}/gh/bin:/usr/bin:/Users/ana/.local/bin:${f}/node/bin`);
  });

  it("Windows: Git portátil, gh, Git do winget e Git Bash para o Claude", () => {
    const f = "C:\\Users\\ana\\.inhouse\\ferramentas";
    const env = { ProgramFiles: "C:\\Program Files", Path: "C:\\Windows;c:\\program files\\git\\cmd\\" } as NodeJS.ProcessEnv;
    const tem = new Set([`${f}\\git\\cmd`, `${f}\\node`, `${f}\\git\\bin\\bash.exe`, "C:\\Program Files\\Git\\cmd"]);
    aplicarAmbiente(env, { so: "windows", casa: "C:\\Users\\ana", existe: (p) => tem.has(p) });
    // Program Files\Git\cmd já estava (outra caixa, barra no fim): não repete.
    expect(env["Path"]).toBe(`${f}\\git\\cmd;C:\\Windows;c:\\program files\\git\\cmd\\;${f}\\node`);
    expect(env["CLAUDE_CODE_GIT_BASH_PATH"]).toBe(`${f}\\git\\bin\\bash.exe`);
    expect(env["PATH"]).toBeUndefined();
    // Idempotente.
    const antes = env["Path"];
    aplicarAmbiente(env, { so: "windows", casa: "C:\\Users\\ana", existe: (p) => tem.has(p) });
    expect(env["Path"]).toBe(antes);
  });
});

// ------------------------------------------------------------- parsers

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

describe("parsers dos downloads oficiais", () => {
  const shasums = [
    `${SHA2}  node-v24.11.0-darwin-arm64.tar.xz`,
    `${SHA}  node-v24.11.0-darwin-arm64.tar.gz`,
    `${SHA2}  node-v24.11.0-darwin-x64.tar.gz`,
    `${SHA}  node-v24.11.0-win-x64.zip`,
    `${SHA2}  node-v24.11.0-win-x64.7z`,
    `${SHA}  node-v24.11.0-linux-x64.tar.gz`,
    `${SHA}  node-v24.11.0.pkg`,
  ].join("\r\n");

  it("acha o tarball/zip certo do Node 24", () => {
    expect(acharNodeNoShasums(shasums, "mac", "arm64")).toEqual({ arquivo: "node-v24.11.0-darwin-arm64.tar.gz", sha256: SHA });
    expect(acharNodeNoShasums(shasums, "mac", "x64")?.sha256).toBe(SHA2);
    expect(acharNodeNoShasums(shasums, "windows", "x64")?.arquivo).toBe("node-v24.11.0-win-x64.zip");
    expect(acharNodeNoShasums(shasums, "windows", "arm64")).toBeNull();
    expect(acharNodeNoShasums(shasums.replace(/v24/g, "v22"), "linux", "x64")).toBeNull();
  });

  const asset = (name: string, extra: Record<string, unknown> = {}) => ({ name, browser_download_url: `https://github.com/x/${name}`, ...extra });

  it("acha o gh e o arquivo de checksums do mesmo release", () => {
    const rel = {
      assets: [asset("gh_2.82.1_macOS_arm64.zip"), asset("gh_2.82.1_macOS_amd64.zip"), asset("gh_2.82.1_windows_amd64.zip"), asset("gh_2.82.1_windows_amd64.msi"), asset("gh_2.82.1_linux_amd64.tar.gz"), asset("gh_2.82.1_checksums.txt")],
    };
    expect(acharGh(rel, "mac", "arm64")?.asset.name).toBe("gh_2.82.1_macOS_arm64.zip");
    expect(acharGh(rel, "windows", "x64")?.asset.name).toBe("gh_2.82.1_windows_amd64.zip");
    expect(acharGh(rel, "linux", "x64")?.checksums.name).toBe("gh_2.82.1_checksums.txt");
    expect(acharGh({ assets: [asset("gh_2.82.1_macOS_arm64.zip")] }, "mac", "arm64")).toBeNull();
    expect(acharGh(null, "mac", "arm64")).toBeNull();
    expect(shaNoChecksums(`${SHA2}  gh_2.82.1_macOS_amd64.zip\n${SHA} *gh_2.82.1_macOS_arm64.zip\n`, "gh_2.82.1_macOS_arm64.zip")).toBe(SHA);
    expect(shaNoChecksums(`${SHA}  outro.zip`, "gh.zip")).toBeNull();
  });

  it("acha o PortableGit só com digest SHA-256", () => {
    const rel = {
      assets: [
        asset("Git-2.51.0-64-bit.exe", { digest: `sha256:${SHA2}` }),
        asset("PortableGit-2.51.0-64-bit.7z.exe", { digest: `sha256:${SHA}` }),
        asset("PortableGit-2.51.0-arm64.7z.exe", { digest: null }),
      ],
    };
    expect(acharPortableGit(rel, "x64")).toMatchObject({ sha256: SHA, asset: { name: "PortableGit-2.51.0-64-bit.7z.exe" } });
    expect(acharPortableGit(rel, "arm64")).toBeNull();
  });

  it("só baixa de domínios oficiais por https", () => {
    expect(urlPermitida("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt")).toBe(true);
    expect(urlPermitida("https://github.com/cli/cli/releases/download/v2/gh.zip")).toBe(true);
    expect(urlPermitida("https://downloads.claude.ai/claude-code-releases/bootstrap.ps1")).toBe(true);
    expect(urlPermitida("http://nodejs.org/x")).toBe(false);
    expect(urlPermitida("https://nodejs.org.evil.com/x")).toBe(false);
    expect(urlPermitida("nada")).toBe(false);
  });
});

// ------------------------------------------------------------- plano

describe("planejar", () => {
  const it_ = (id: SetupItem["id"], estado: SetupItem["estado"], acao?: SetupItem["acao"]) => itemBase(id, { estado, acao });

  it("sem pedidos: só os obrigatórios que faltam, na ordem Node → Git → Claude", () => {
    const itens = [it_("node", "faltando", "instalar"), it_("git", "faltando", "instalar"), it_("gitbash", "faltando", "instalar"), it_("claude", "erro", "instalar"), it_("gh", "faltando", "instalar")];
    expect(planejar(itens, "windows", undefined, {})).toEqual([
      { metodo: "node-portatil", itens: ["node"] },
      { metodo: "git-winget", itens: ["git", "gitbash"] },
      { metodo: "claude-script", itens: ["claude"] },
    ]);
    expect(planejar(itens, "mac", undefined, {}).map((p) => p.metodo)).toEqual(["node-portatil", "git-xcode", "claude-script"]);
  });

  it("opcional e aviso só instalam se pedidos", () => {
    const itens = [it_("node", "aviso", "instalar"), it_("gh", "faltando", "instalar")];
    expect(planejar(itens, "mac", undefined, {})).toEqual([]);
    expect(planejar(itens, "mac", ["node", "gh"], {}).map((p) => p.metodo)).toEqual(["node-portatil", "gh-portatil"]);
  });

  it("Windows: só o Git Bash faltando usa o PortableGit; CI força portátil", () => {
    const itens = [it_("git", "ok"), it_("gitbash", "faltando", "instalar")];
    expect(planejar(itens, "windows", undefined, {})).toEqual([{ metodo: "git-portatil", itens: ["gitbash"] }]);
    const prontos = [it_("node", "ok"), it_("git", "ok"), it_("gitbash", "ok"), it_("gh", "ok")];
    const env = { INHOUSE_FORCAR_PORTATIL: "node,git,gh" };
    expect(planejar(prontos, "windows", ["node", "git", "gitbash", "gh"], env).map((p) => p.metodo)).toEqual(["node-portatil", "git-portatil", "gh-portatil"]);
  });

  it("Linux não instala Git (pede o apt)", () => {
    expect(() => planejar([it_("git", "faltando", "instalar")], "linux", undefined, {})).toThrow(/apt install git/);
  });
});

// ------------------------------------------------------------- detecção

describe("detecção por SO", () => {
  it("Mac novo: sem ferramentas da Apple não executa git (evita o diálogo)", async () => {
    const m = maquina({ so: "mac", versaoNode: "20.10.0", comandos: { "xcode-select -p": { code: 2 } } });
    const d = await detectarTudo(m);
    const i = porId(d.itens);
    expect(d.itens.map((x) => x.id)).toEqual(["node", "git", "claude", "claude_login", "git_identidade", "gh", "gh_login"]);
    expect(i.node).toMatchObject({ estado: "aviso", acao: "instalar" });
    expect(i.git).toMatchObject({ estado: "faltando", acao: "instalar" });
    expect(i.claude).toMatchObject({ estado: "faltando", acao: "instalar" });
    expect(i.git_identidade?.estado).toBe("faltando");
    expect(m.chamadas.some((c) => c.startsWith("git "))).toBe(false);
    expect(prontoParaUsar(d.itens)).toBe(false);
  });

  it("Mac pronto: tudo ok, login pela assinatura e identidade lida", async () => {
    const m = maquina({
      so: "mac",
      noPath: { claude: "/Users/ana/.local/bin/claude", gh: "/opt/homebrew/bin/gh" },
      comandos: {
        "xcode-select -p": { stdout: "/Library/Developer/CommandLineTools" },
        "git --version": { stdout: "git version 2.39.5 (Apple Git-154)" },
        "git config --global user.name": { stdout: "Ana Souza\n" },
        "git config --global user.email": { stdout: "ana@exemplo.com\n" },
        "/Users/ana/.local/bin/claude --version": { stdout: "2.1.296 (Claude Code)" },
        "/Users/ana/.local/bin/claude auth status --json": { stdout: '{"loggedIn":true,"email":"ana@exemplo.com"}' },
        "/opt/homebrew/bin/gh --version": { stdout: "gh version 2.82.1 (2025-10-01)" },
        "/opt/homebrew/bin/gh auth status": { code: 1 },
      },
    });
    const d = await detectarTudo(m);
    const i = porId(d.itens);
    expect(i.git?.detalhe).toBe("Pronto · v2.39.5");
    expect(i.claude_login).toMatchObject({ estado: "ok" });
    expect(i.claude_login?.detalhe).toContain("ana@exemplo.com");
    expect(d.identidade).toEqual({ nome: "Ana Souza", email: "ana@exemplo.com" });
    expect(i.gh?.estado).toBe("ok");
    expect(i.gh_login).toMatchObject({ estado: "faltando", acao: "login_gh" });
    expect(prontoParaUsar(d.itens)).toBe(true);
  });

  it("Windows: acha o Git portátil e o Git Bash; Claude deslogado pede login", async () => {
    const f = "C:\\Users\\ana\\.inhouse\\ferramentas";
    const git = `${f}\\git\\cmd\\git.exe`;
    const claude = "C:\\Users\\ana\\.local\\bin\\claude.exe";
    const m = maquina({
      so: "windows",
      env: { USERPROFILE: "C:\\Users\\ana", PATHEXT: ".COM;.EXE;.CMD" },
      arquivos: [git, `${f}\\git\\bin\\bash.exe`, claude],
      comandos: {
        [`${git} --version`]: { stdout: "git version 2.51.0.windows.1" },
        [`${git} config --global user.name`]: { code: 1 },
        [`${git} config --global user.email`]: { code: 1 },
        [`${claude} --version`]: { stdout: "2.1.296 (Claude Code)" },
        [`${claude} auth status --json`]: { stdout: '{"loggedIn":false}', code: 1 },
      },
    });
    const d = await detectarTudo(m);
    const i = porId(d.itens);
    expect(d.itens.map((x) => x.id)).toContain("gitbash");
    expect(i.git?.estado).toBe("ok");
    expect(i.gitbash?.estado).toBe("ok");
    expect(i.claude_login).toMatchObject({ estado: "faltando", acao: "login" });
    expect(i.git_identidade).toMatchObject({ estado: "faltando", acao: "identidade" });
    expect(i.gh?.estado).toBe("faltando");
    expect(prontoParaUsar(d.itens)).toBe(false);
  });

  it("Claude antigo sem auth status vira aviso (não trava)", async () => {
    const m = maquina({
      so: "linux",
      noPath: { claude: "/usr/local/bin/claude" },
      comandos: { "/usr/local/bin/claude --version": { stdout: "1.0.0" }, "/usr/local/bin/claude auth status --json": { code: 1, stderr: "unknown command" } },
    });
    const i = porId((await detectarTudo(m)).itens);
    expect(i.claude_login?.estado).toBe("aviso");
    expect(i.git).toMatchObject({ estado: "faltando" });
  });
});

// ------------------------------------------------------------- execução

function ctxFalso(dir: string): ContextoInstalacao & { msgs: string[] } {
  const msgs: string[] = [];
  return {
    msgs,
    m: maquina({ so: "mac", env: { INHOUSE_TOOLS_DIR: dir } }),
    rede: { texto: async () => "", json: async () => ({}), baixar: async () => SHA },
    rodar: async () => ({ code: 0, stdout: "", stderr: "" }),
    progresso: (_i, m) => msgs.push(m),
    log: () => undefined,
    dormir: async () => undefined,
  };
}

describe("instalarPasta (troca atômica)", () => {
  it("troca a versão e devolve a versão validada", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inh-ferr-"));
    mkdirSync(path.join(dir, "node"));
    writeFileSync(path.join(dir, "node", "velho.txt"), "v22");
    const v = await instalarPasta(
      ctxFalso(dir),
      "node",
      "node",
      async (tmp) => {
        mkdirSync(path.join(tmp, "node-v24.11.0-darwin-arm64", "bin"), { recursive: true });
        writeFileSync(path.join(tmp, "node-v24.11.0-darwin-arm64", "bin", "node"), "v24");
      },
      async (destino) => (existsSync(path.join(destino, "bin", "node")) ? "24.11.0" : null),
    );
    expect(v).toBe("24.11.0");
    expect(readFileSync(path.join(dir, "node", "bin", "node"), "utf8")).toBe("v24");
    expect(existsSync(path.join(dir, "node", "velho.txt"))).toBe(false);
    expect(readDirLimpo(dir)).toEqual(["node"]);
  });

  it("validação falhou: a versão anterior volta", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inh-ferr-"));
    mkdirSync(path.join(dir, "gh"));
    writeFileSync(path.join(dir, "gh", "velho.txt"), "antigo");
    await expect(
      instalarPasta(ctxFalso(dir), "gh", "gh", async (tmp) => writeFileSync(path.join(tmp, "gh"), "x"), async () => null),
    ).rejects.toThrow(/não abriu/);
    expect(readFileSync(path.join(dir, "gh", "velho.txt"), "utf8")).toBe("antigo");
    expect(readDirLimpo(dir)).toEqual(["gh"]);
  });
});

function readDirLimpo(dir: string): string[] {
  return readdirSync(dir).filter((n) => n !== ".lock").sort();
}

describe("trava entre processos", () => {
  it("segunda janela não pega; pid morto ou trava velha vencem", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inh-trava-"));
    const a = adquirirTrava(dir, 1000, () => true);
    expect(a).not.toBeNull();
    expect(adquirirTrava(dir, 2000, () => true)).toBeNull();
    expect(adquirirTrava(dir, 2000, () => false)).not.toBeNull();
    expect(adquirirTrava(dir, 2000 + 31 * 60_000, () => true)).not.toBeNull();
  });

  it("liberar remove a trava", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "inh-trava-"));
    adquirirTrava(dir, 1000, () => true)!.liberar();
    expect(existsSync(path.join(dir, ".lock"))).toBe(false);
  });
});

// ------------------------------------------------------------- login

class ProcFalso extends EventEmitter implements ProcessoLogin {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  recebido = "";
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => (this.recebido += d.toString()));
  }
}

const esperar = () => new Promise((r) => setTimeout(r, 5));

describe("LoginClaude", () => {
  function novo(confirmado = true) {
    const proc = new ProcFalso();
    const estados: EstadoLogin[] = [];
    let morto = false;
    let args: string[] = [];
    const login = new LoginClaude({
      abrir: (_exe, a) => ((args = a), proc),
      matar: () => (morto = true),
      confirmar: async () => confirmado,
      aoMudar: (e) => estados.push({ ...e }),
    });
    login.iniciar("claude");
    return { proc, estados, login, morto: () => morto, args: () => args };
  }

  it("usa a assinatura, captura a URL e manda o código pelo stdin", async () => {
    const t = novo(true);
    expect(t.args()).toEqual(["auth", "login", "--claudeai"]);
    t.proc.stdout.write("\x1b[1mOpen https://claude.ai/oauth/authorize?code=true&x=1\x1b[0m\n");
    await esperar();
    expect(t.login.atual).toMatchObject({ fase: "aguardando", url: "https://claude.ai/oauth/authorize?code=true&x=1", pedeCodigo: false });
    t.proc.stdout.write("Paste code here if prompted > ");
    await esperar();
    expect(t.login.atual.pedeCodigo).toBe(true);
    expect(t.login.enviarCodigo("abc#def")).toBe(true);
    expect(t.proc.recebido).toBe("abc#def\n");
    t.proc.emit("exit", 0);
    await esperar();
    expect(t.login.atual.fase).toBe("ok");
    expect(t.login.ativo).toBe(false);
  });

  it("código inválido: mata o processo e pede outro", async () => {
    const t = novo();
    t.proc.stdout.write("https://claude.ai/x\nPaste code here > ");
    await esperar();
    t.login.enviarCodigo("errado");
    t.proc.stdout.write("Invalid code. Please try again.");
    await esperar();
    expect(t.login.atual).toMatchObject({ fase: "erro" });
    expect(t.login.atual.mensagem).toMatch(/não aceito/);
    expect(t.morto()).toBe(true);
    expect(t.login.ativo).toBe(false);
  });

  it("saiu sem confirmar o login vira erro; cancelar encerra", async () => {
    const t = novo(false);
    t.proc.emit("exit", 1);
    await esperar();
    expect(t.login.atual.fase).toBe("erro");
    const c = novo();
    c.login.cancelar();
    expect(c.login.atual.fase).toBe("cancelado");
    expect(c.morto()).toBe(true);
  });

  it("acharUrl ignora ANSI", () => {
    expect(acharUrl("\x1b[4mhttps://claude.ai/a?b=1\x1b[24m fim")).toBe("https://claude.ai/a?b=1");
    expect(acharUrl("sem link")).toBeUndefined();
  });
});

// ------------------------------------------------------------- validações

describe("validações", () => {
  it("identidade e código", () => {
    expect(validarIdentidade("  Ana Souza ", "ana@exemplo.com ")).toEqual({ nome: "Ana Souza", email: "ana@exemplo.com" });
    expect(() => validarIdentidade("", "ana@exemplo.com")).toThrow(/nome/);
    expect(() => validarIdentidade("Ana\nX", "ana@exemplo.com")).toThrow();
    expect(() => validarIdentidade("Ana", "ana@exemplo")).toThrow(/e-mail/);
    expect(validarCodigo(" abc ")).toBe("abc");
    expect(() => validarCodigo("a\nb")).toThrow();
  });

  it("quando a tela aparece ao abrir", () => {
    expect(mostrarAoAbrir(false, "2026-01-01", true)).toBe(true);
    expect(mostrarAoAbrir(true, undefined, false)).toBe(true);
    expect(mostrarAoAbrir(true, undefined, true)).toBe(false);
    expect(mostrarAoAbrir(true, "2026-01-01", false)).toBe(false);
  });

  it("cli: argumentos", () => {
    expect(lerArgs(["verificar", "--json"])).toEqual({ comando: "verificar", json: true, simular: false });
    expect(lerArgs(["instalar", "--itens", "node,gh", "--simular"])).toEqual({ comando: "instalar", json: false, simular: true, itens: ["node", "gh"] });
    expect(lerArgs(["instalar", "--itens=claude"])).toMatchObject({ itens: ["claude"] });
    expect(lerArgs(["instalar", "--itens", "claude_login"])).toMatch(/desconhecido/);
    expect(lerArgs(["verificar", "--simular"])).toMatch(/só --json/);
    expect(lerArgs(["apagar"])).toMatch(/^Use:/);
    expect(lerArgs(["instalar", "--forcar"])).toMatch(/desconhecida/);
  });
});

// ------------------------------------------------------------- rotas

describe("rotas /api/setup", () => {
  let server: Server;
  let base = "";
  let demo = false;
  const motor = new MotorDemo(() => undefined, 1);

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const r = express.Router();
    registrarRotasSetup(r, () => motor, () => demo);
    app.use(r);
    server = await new Promise((ok) => {
      const s = app.listen(0, "127.0.0.1", () => ok(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    motor.encerrar();
    await new Promise((r) => server.close(r));
  });

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  it("hosts e origens locais", () => {
    expect(hostLocal("127.0.0.1:4545")).toBe(true);
    expect(hostLocal("localhost")).toBe(true);
    expect(hostLocal("[::1]:4545")).toBe(true);
    expect(hostLocal("evil.com")).toBe(false);
    expect(hostLocal("127.0.0.1.evil.com")).toBe(false);
    expect(hostLocal(undefined)).toBe(false);
    expect(origemLocal(undefined)).toBe(true);
    expect(origemLocal("http://localhost:4545")).toBe(true);
    expect(origemLocal("https://evil.com")).toBe(false);
    expect(origemLocal("null")).toBe(false);
    expect(typeof guardaSetup()).toBe("function");
  });

  it("GET devolve o status", async () => {
    const r = await fetch(`${base}/api/setup`);
    expect(r.status).toBe(200);
    const s = (await r.json()) as SetupStatus;
    expect(s.itens.length).toBeGreaterThan(0);
  });

  it("POST sem JSON → 415; Origin de fora → 403; Host de fora → 403", async () => {
    const r1 = await fetch(`${base}/api/setup/verificar`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(r1.status).toBe(415);
    const r2 = await post("/api/setup/verificar", {}, { origin: "https://evil.com" });
    expect(r2.status).toBe(403);
    const r3 = await post("/api/setup/verificar", {}, { origin: "http://127.0.0.1:4545" });
    expect(r3.status).toBe(200);
    const http = await import("node:http");
    const status = await new Promise<number>((ok) => {
      const req = http.request(`${base}/api/setup`, { headers: { host: "evil.com" } }, (res) => ok(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
  });

  it("itens inválidos → 400; identidade ruim → 400; demo desligado → 404", async () => {
    expect((await post("/api/setup/instalar", { itens: ["rm -rf"] })).status).toBe(400);
    expect((await post("/api/setup/identidade", { nome: "", email: "x" })).status).toBe(400);
    expect((await post("/api/setup/demo", { cenario: "erro", so: "mac" })).status).toBe(404);
  });

  it("concluir com coisa faltando → 409; demo ligado troca cenário", async () => {
    demo = true;
    expect((await post("/api/setup/demo", { cenario: "falta-tudo", so: "mac" })).status).toBe(200);
    expect((await post("/api/setup/concluir", {})).status).toBe(409);
    expect((await post("/api/setup/demo", { cenario: "nada", so: "mac" })).status).toBe(400);
    expect((await post("/api/setup/demo", { cenario: "erro", so: "linux" })).status).toBe(400);
    const r = await post("/api/setup/demo", { cenario: "tudo-pronto", so: "windows" }, { origin: "https://exemplo.trycloudflare.com" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as SetupStatus).prontoParaUsar).toBe(true);
  });
});

// ------------------------------------------------------------- demo

describe("modo demonstração", () => {
  it.each(CENARIOS.flatMap((c) => (["windows", "mac"] as const).map((so) => [c.id, so] as const)))("%s no %s é coerente", (cenario, so) => {
    const m = new MotorDemo(() => undefined, 1);
    const s = m.aplicar(cenario, so);
    m.encerrar();
    expect(s.so).toBe(so);
    expect(s.itens.some((i) => i.id === "gitbash")).toBe(so === "windows");
    expect(s.prontoParaUsar).toBe(prontoParaUsar(s.itens));
    expect(s.demo?.cenario).toBe(cenario);
    if (cenario === "tudo-pronto") expect(s.prontoParaUsar).toBe(true);
    if (cenario === "falta-tudo") expect(s.prontoParaUsar).toBe(false);
    if (cenario === "outra-janela") expect(s.ocupadoPorOutro).toBe(true);
  });
});

// ------------------------------------------------------------- UI

describe("tela #/preparar", () => {
  const raiz = path.join(import.meta.dirname, "..");
  const js = readFileSync(path.join(raiz, "public", "app.js"), "utf8");
  const css = readFileSync(path.join(raiz, "public", "styles.css"), "utf8");

  it("tem a rota, a jornada e o fallback de consulta", () => {
    expect(js).toContain("#/preparar");
    expect(js).toContain("setupJornada");
    expect(js).toContain('aria-current="step"');
    expect(js).toContain("setupAgendarConsulta");
    expect(css).toContain(".pp-jornada");
  });

  it("nunca pede API key", () => {
    expect(js).not.toMatch(/ANTHROPIC_API_KEY|sk-ant-/);
    expect(js).not.toMatch(/api[\s_-]?key/i);
  });
});

describe("scripts/deps-ok.mjs (marca das dependências nos lançadores)", () => {
  const script = path.resolve("scripts/deps-ok.mjs");
  const rodar = (raiz: string) => spawnSync(process.execPath, [script, raiz]).status;
  const raiz = mkdtempSync(path.join(tmpdir(), "inh-deps-"));
  writeFileSync(path.join(raiz, "package-lock.json"), '{"lockfileVersion":3}');
  const hash = createHash("sha256").update(readFileSync(path.join(raiz, "package-lock.json"))).digest("hex");
  const maior = process.versions.node.split(".")[0];

  it("sem marca: precisa preparar", () => {
    expect(rodar(raiz)).toBe(1);
  });
  it("marca em dia: pronto", () => {
    mkdirSync(path.join(raiz, "node_modules"), { recursive: true });
    writeFileSync(path.join(raiz, "node_modules", ".inhouse-deps"), `${hash}-${maior}`);
    expect(rodar(raiz)).toBe(0);
  });
  it("package-lock mudou (InHouse atualizado): precisa preparar", () => {
    writeFileSync(path.join(raiz, "package-lock.json"), '{"lockfileVersion":3,"novo":1}');
    expect(rodar(raiz)).toBe(1);
  });
  it("outra versão maior do Node: precisa preparar", () => {
    writeFileSync(path.join(raiz, "package-lock.json"), '{"lockfileVersion":3}');
    writeFileSync(path.join(raiz, "node_modules", ".inhouse-deps"), `${hash}-22`);
    expect(rodar(raiz)).toBe(maior === "22" ? 0 : 1);
  });
});

describe("envParaPowerShell", () => {
  it("tira o PSModulePath herdado do PowerShell 7 e mantém o resto", () => {
    const e = envParaPowerShell({ PSModulePath: "C:\\pwsh7\\Modules", Path: "C:\\x", USERPROFILE: "C:\\Users\\ana" });
    expect(e).toEqual({ Path: "C:\\x", USERPROFILE: "C:\\Users\\ana" });
    expect(envParaPowerShell({ PSMODULEPATH: "y" })).toEqual({});
  });
});
