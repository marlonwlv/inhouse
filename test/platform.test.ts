import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acharGitBash,
  alvoDoShimCmd,
  comandoDeShell,
  comandoDoClaude,
  escaparArgCmd,
  matarArvore,
  mesmoCaminho,
  montarComando,
  renameComRetry,
  renameComRetrySync,
  resolverClaude,
  resolverExecutavel,
  spawnOpcoes,
  spawnPortatil,
} from "../server/platform.js";

const envWin = {
  PATH: "C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};
const existeEm = (arquivos: string[]) => (p: string) => arquivos.some((a) => a.toLowerCase() === p.toLowerCase());

describe("resolverExecutavel", () => {
  it("POSIX devolve o nome como veio", () => {
    expect(resolverExecutavel("npm", { plataforma: "darwin" })).toBe("npm");
  });

  it("Windows acha npm.cmd pelo PATH + PATHEXT", () => {
    const r = resolverExecutavel("npm", {
      plataforma: "win32",
      env: envWin,
      cwd: "C:\\proj",
      existe: existeEm(["C:\\Program Files\\nodejs\\npm.cmd"]),
    });
    expect(r).toBe("C:\\Program Files\\nodejs\\npm.cmd");
  });

  it("Windows ignora o shim sh sem extensão em node_modules/.bin", () => {
    const r = resolverExecutavel("node_modules/.bin/tsc", {
      plataforma: "win32",
      env: envWin,
      cwd: "C:\\proj",
      existe: existeEm(["C:\\proj\\node_modules\\.bin\\tsc", "C:\\proj\\node_modules\\.bin\\tsc.cmd"]),
    });
    expect(r).toBe("C:\\proj\\node_modules\\.bin\\tsc.cmd");
  });

  it("Windows respeita a extensão explícita e lê Path em qualquer caixa", () => {
    const r = resolverExecutavel("git.exe", {
      plataforma: "win32",
      env: { Path: "C:\\Git\\cmd", PATHEXT: ".EXE;.CMD" },
      cwd: "C:\\proj",
      existe: existeEm(["C:\\Git\\cmd\\git.exe"]),
    });
    expect(r).toBe("C:\\Git\\cmd\\git.exe");
  });

  it("não achou: devolve o nome (spawn dá ENOENT claro)", () => {
    expect(resolverExecutavel("bun", { plataforma: "win32", env: envWin, cwd: "C:\\p", existe: () => false })).toBe("bun");
  });
});

describe("montarComando", () => {
  it("POSIX não mexe", () => {
    expect(montarComando("npm", ["run", "dev"], { plataforma: "linux" })).toEqual({ arquivo: "npm", args: ["run", "dev"] });
  });

  it("Windows: .exe roda direto", () => {
    const m = montarComando("git", ["status"], {
      plataforma: "win32",
      env: envWin,
      cwd: "C:\\p",
      existe: existeEm(["C:\\Program Files\\Git\\cmd\\git.exe"]),
    });
    expect(m).toEqual({ arquivo: "C:\\Program Files\\Git\\cmd\\git.exe", args: ["status"] });
  });

  it("Windows: .cmd vai por cmd.exe /d /s /c com escape", () => {
    const m = montarComando("npm", ["run", "dev"], {
      plataforma: "win32",
      env: envWin,
      cwd: "C:\\p",
      existe: existeEm(["C:\\Program Files\\nodejs\\npm.cmd"]),
    });
    expect(m.arquivo).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(m.windowsVerbatimArguments).toBe(true);
    expect(m.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(m.args[3]).toBe('"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"run^^^" ^^^"dev^^^""');
  });

  it("escapa metacaracteres que o cmd interpretaria", () => {
    expect(escaparArgCmd("a&b", false)).toBe('^"a^&b^"');
    expect(escaparArgCmd('x"y', false)).toBe('^"x\\^"y^"');
  });
});

describe("comandoDeShell", () => {
  it("POSIX usa /bin/sh -c", () => {
    expect(comandoDeShell("PORT=$PORT npm run dev", { plataforma: "darwin" })).toEqual({
      arquivo: "/bin/sh",
      args: ["-c", "PORT=$PORT npm run dev"],
      shell: "sh",
    });
  });

  it("Windows prefere o Git Bash", () => {
    const r = comandoDeShell("npm run dev -- --port $PORT", { plataforma: "win32", bash: "C:\\Git\\bin\\bash.exe" });
    expect(r).toMatchObject({ arquivo: "C:\\Git\\bin\\bash.exe", args: ["-c", "npm run dev -- --port $PORT"], shell: "bash" });
  });

  it("Windows sem Git Bash cai no cmd.exe", () => {
    const r = comandoDeShell("npm run dev", { plataforma: "win32", bash: null });
    expect(r.shell).toBe("cmd");
    expect(r.args).toEqual(["/d", "/s", "/c", '"npm run dev"']);
  });

  it("acha o bash.exe a partir do git.exe do PATH", () => {
    const bash = acharGitBash(
      { PATH: "C:\\Program Files\\Git\\cmd", PATHEXT: ".EXE" },
      existeEm(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]),
    );
    expect(bash).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("CLAUDE_CODE_GIT_BASH_PATH tem prioridade", () => {
    const bash = acharGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\g\\bash.exe" }, existeEm(["D:\\g\\bash.exe"]));
    expect(bash).toBe("D:\\g\\bash.exe");
  });
});

describe("spawnOpcoes / matarArvore", () => {
  it("detached só no POSIX", () => {
    expect(spawnOpcoes("darwin")).toEqual({ detached: true, windowsHide: true });
    expect(spawnOpcoes("win32")).toEqual({ windowsHide: true });
  });

  it("mata a árvore do processo de verdade nesta plataforma", async () => {
    // Pai node que cria um filho node; matar a árvore derruba os dois.
    const script =
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
      "console.log(c.pid);setInterval(()=>{},1000)";
    const pai = spawnPortatil(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], ...spawnOpcoes() });
    const neto = await new Promise<number>((res) => pai.stdout!.once("data", (d) => res(Number(String(d).trim()))));
    const vivo = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(vivo(neto)).toBe(true);
    matarArvore(pai.pid, "SIGKILL");
    const ate = Date.now() + 5000;
    while ((vivo(neto) || vivo(pai.pid!)) && Date.now() < ate) await new Promise((r) => setTimeout(r, 50));
    expect(vivo(neto)).toBe(false);
  });

  it("não explode sem pid", () => {
    expect(() => matarArvore(undefined)).not.toThrow();
  });
});

describe("mesmoCaminho", () => {
  it("Windows ignora maiúsculas e barra final", () => {
    expect(mesmoCaminho("C:\\Users\\Ana\\Inhouse", "c:\\users\\ana\\inhouse\\", "win32")).toBe(true);
  });
  it("Linux diferencia", () => {
    expect(mesmoCaminho("/a/B", "/a/b", "linux")).toBe(false);
    expect(mesmoCaminho("/a/b/", "/a/b", "linux")).toBe(true);
  });
});

describe("resolverClaude", () => {
  const shimNpm = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");

  it("lê o alvo do shim .cmd do npm", () => {
    expect(alvoDoShimCmd(shimNpm, "C:\\Users\\Ana\\AppData\\Roaming\\npm")).toBe(
      "C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js",
    );
  });

  it("Windows: prefere claude.exe do where", () => {
    const r = resolverClaude({
      plataforma: "win32",
      env: {},
      casa: "C:\\Users\\Ana",
      procurar: () => ["C:\\Users\\Ana\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\Ana\\.local\\bin\\claude.exe"],
      existe: () => true,
      ler: () => shimNpm,
    });
    expect(r).toBe("C:\\Users\\Ana\\.local\\bin\\claude.exe");
  });

  it("Windows: só o npm → traduz o .cmd para o cli.js", () => {
    const cli = "C:\\Users\\Ana\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const r = resolverClaude({
      plataforma: "win32",
      env: { APPDATA: "C:\\Users\\Ana\\AppData\\Roaming" },
      casa: "C:\\Users\\Ana",
      procurar: () => [],
      existe: existeEm(["C:\\Users\\Ana\\AppData\\Roaming\\npm\\claude.cmd", cli]),
      ler: () => shimNpm,
    });
    expect(r).toBe(cli);
  });

  it("Windows: acha o instalador nativo em %USERPROFILE%\\.local\\bin sem PATH", () => {
    const r = resolverClaude({
      plataforma: "win32",
      env: {},
      casa: "C:\\Users\\Ana",
      procurar: () => [],
      existe: existeEm(["C:\\Users\\Ana\\.local\\bin\\claude.exe"]),
    });
    expect(r).toBe("C:\\Users\\Ana\\.local\\bin\\claude.exe");
  });

  it("macOS: which e depois os locais comuns", () => {
    expect(resolverClaude({ plataforma: "darwin", env: {}, procurar: () => ["/x/claude"] })).toBe("/x/claude");
    expect(
      resolverClaude({ plataforma: "darwin", env: {}, casa: "/Users/a", procurar: () => [], existe: existeEm(["/opt/homebrew/bin/claude"]) }),
    ).toBe("/opt/homebrew/bin/claude");
    expect(resolverClaude({ plataforma: "darwin", env: {}, procurar: () => [], existe: () => false })).toBeNull();
  });

  it("INHOUSE_CLAUDE_PATH manda", () => {
    expect(resolverClaude({ plataforma: "linux", env: { INHOUSE_CLAUDE_PATH: "/meu/claude" } })).toBe("/meu/claude");
  });

  it("comandoDoClaude roda cli.js pelo node", () => {
    expect(comandoDoClaude("C:\\x\\cli.js", ["--version"])).toEqual({ arquivo: process.execPath, args: ["C:\\x\\cli.js", "--version"] });
    expect(comandoDoClaude("/bin/claude", ["--version"])).toEqual({ arquivo: "/bin/claude", args: ["--version"] });
  });
});

describe("renameComRetry", () => {
  it("renomeia (sync e async)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inhouse-ren-"));
    writeFileSync(join(dir, "a"), "1");
    renameComRetrySync(join(dir, "a"), join(dir, "b"));
    await renameComRetry(join(dir, "b"), join(dir, "c"));
    expect(readFileSync(join(dir, "c"), "utf8")).toBe("1");
  });

  it("erro não transitório sobe na hora", async () => {
    await expect(renameComRetry("/nao/existe/x", "/nao/existe/y")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
