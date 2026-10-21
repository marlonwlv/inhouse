/**
 * Clone de repositório do GitHub: classificação do erro do git (mensagens reais
 * de Windows, Mac e Linux), credencial do gh passada só no comando, vigia de
 * download parado e o job em segundo plano. Nada toca a rede: o spawn do git é
 * falso e o estado do gh é injetado.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ErroClone } from "../server/services/cloneErro.js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { classificarErroClone } from "../server/services/cloneErro.js";
import { argsCredencialGh, configLocalGh, contaDoStatus, helperGh } from "../server/services/githubCred.js";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
vi.mock("../server/services/preview.js", () => ({ stopPreview: vi.fn() }));
vi.mock("../server/services/worktrees.js", () => ({ removeEspaco: vi.fn() }));
vi.mock("../server/workflow/library.js", () => ({ forgetProject: vi.fn() }));

interface Roteiro {
  stderr: string[];
  /** null = fica pendurado até ser morto. */
  code: number | null;
}
const chamadas: string[][] = [];
let roteiro: Roteiro = { stderr: [], code: 0 };

vi.mock("../server/platform.js", async (orig) => {
  const real = await orig<typeof import("../server/platform.js")>();
  return {
    ...real,
    spawnPortatil: vi.fn((_cmd: string, args: string[]) => {
      chamadas.push(args);
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void; pid?: number };
      child.stderr = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit("close", null));
      const r = roteiro;
      setImmediate(() => {
        for (const l of r.stderr) child.stderr.emit("data", Buffer.from(l));
        if (r.code !== null) child.emit("close", r.code);
      });
      return child;
    }),
  };
});

type ProjectsModule = typeof import("../server/services/projects.js");
let projects: ProjectsModule;

beforeAll(async () => {
  const base = mkdtempSync(join(tmpdir(), "inhouse-clone-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
  projects = await import("../server/services/projects.js");
  const store = await import("../server/store.js");
  store.load();
});

beforeEach(() => {
  chamadas.length = 0;
  projects._configurarCloneParaTestes({ estadoGh: async () => ({ gh: null, logado: false }), paradoMs: 5 * 60_000 });
});

// Saídas reais do git em cada SO (mesmo motivo, textos diferentes).
const STDERR = {
  privadoSemLogin: "Cloning into 'lipe'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n",
  privadoSemLoginWin:
    "Cloning into 'C:\\Users\\ana\\Inhouse\\projetos\\lipe'...\r\nfatal: could not read Username for 'https://github.com': No such file or directory\r\n",
  naoEncontrado: "Cloning into 'lipe'...\nremote: Repository not found.\nfatal: repository 'https://github.com/lipe/lipe/' not found\n",
  sso: "remote: The 'lipe' organization has enabled or enforced SAML SSO.\nfatal: unable to access 'https://github.com/lipe/lipe/': The requested URL returned error: 403\n",
  authFalhou: "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/lipe/lipe/'\n",
  dnsLinux: "fatal: unable to access 'https://github.com/lipe/lipe/': Could not resolve host: github.com\n",
  dnsMac: "fatal: unable to access 'https://github.com/lipe/lipe/': Could not resolve host: github.com\n",
  schannelWin:
    "fatal: unable to access 'https://github.com/lipe/lipe/': schannel: failed to receive handshake, SSL/TLS connection failed\n",
  proxyWin: "fatal: unable to access 'https://github.com/lipe/lipe/': Failed to connect to github.com port 443 after 21045 ms: Couldn't connect to server\n",
  timeoutMac: "fatal: unable to access 'https://github.com/lipe/lipe/': Failed to connect to github.com port 443 after 75004 ms: Operation timed out\n",
  rpc: "error: RPC failed; curl 56 GnuTLS recv error (-54): Error in the pull function.\nfatal: early EOF\nfatal: fetch-pack: invalid index-pack output\n",
  disco: "fatal: write error: No space left on device\nfatal: fetch-pack: invalid index-pack output\n",
};

describe("classificarErroClone", () => {
  const semGh = { ghLogado: false, repo: "lipe/lipe" };
  const comGh = { ghLogado: true, conta: "ana-lipe", repo: "lipe/lipe" };

  it("repo privado sem login (Linux/Mac e Windows): pede login, não fala em internet", () => {
    for (const s of [STDERR.privadoSemLogin, STDERR.privadoSemLoginWin]) {
      const e = classificarErroClone(s, semGh);
      expect(e.tipo).toBe("sem_login");
      expect(e.mensagem).toMatch(/Entre no GitHub pelo InHouse/);
      expect(e.mensagem).toMatch(/peça acesso/);
      expect(e.mensagem).not.toMatch(/internet/);
    }
  });

  it("logado mas sem acesso (404 ou SSO): diz a conta e manda pedir acesso", () => {
    for (const s of [STDERR.naoEncontrado, STDERR.sso]) {
      const e = classificarErroClone(s, comGh);
      expect(e.tipo).toBe("sem_acesso");
      expect(e.mensagem).toMatch(/ana-lipe/);
      expect(e.mensagem).toMatch(/lipe\/lipe/);
      expect(e.mensagem).toMatch(/dar acesso/);
      expect(e.mensagem).not.toMatch(/internet/);
    }
  });

  it("sem login, 'not found' também vira pedido de login (o GitHub não diferencia)", () => {
    expect(classificarErroClone(STDERR.naoEncontrado, semGh).tipo).toBe("sem_login");
  });

  it("login recusado com gh logado: pede para entrar de novo", () => {
    const e = classificarErroClone(STDERR.authFalhou, comGh);
    expect(e.tipo).toBe("sem_login");
    expect(e.mensagem).toMatch(/expirado/);
  });

  it("rede de verdade (DNS, schannel, proxy, RPC): fala em internet", () => {
    for (const s of [STDERR.dnsLinux, STDERR.dnsMac, STDERR.schannelWin, STDERR.proxyWin, STDERR.rpc]) {
      const e = classificarErroClone(s, comGh);
      expect(e.tipo).toBe("rede");
      expect(e.mensagem).toMatch(/internet/);
    }
  });

  it("timeout e download parado", () => {
    expect(classificarErroClone(STDERR.timeoutMac, comGh).tipo).toBe("timeout");
    expect(classificarErroClone("", { ...comGh, parado: true }).tipo).toBe("timeout");
  });

  it("disco cheio e erro desconhecido", () => {
    expect(classificarErroClone(STDERR.disco, comGh).tipo).toBe("disco");
    const e = classificarErroClone("fatal: algo estranho\n", comGh);
    expect(e.tipo).toBe("outro");
    expect(e.mensagem).toMatch(/algo estranho/);
  });

  it("detalhe ignora as linhas de progresso", () => {
    const e = classificarErroClone(`Receiving objects:  10% (1/10)\r${STDERR.dnsLinux}`, comGh);
    expect(e.detalhe).toMatch(/Could not resolve host/);
    expect(e.detalhe).not.toMatch(/Receiving/);
  });
});

describe("credencial do gh", () => {
  it("helper com caminho do Windows (espaço e barra invertida)", () => {
    expect(helperGh("C:\\Program Files\\GitHub CLI\\gh.exe")).toBe('!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential');
  });
  it("helper no Mac (Homebrew) e Linux", () => {
    expect(helperGh("/opt/homebrew/bin/gh")).toBe('!"/opt/homebrew/bin/gh" auth git-credential');
    expect(helperGh("/home/ana/.inhouse/ferramentas/gh/bin/gh")).toBe('!"/home/ana/.inhouse/ferramentas/gh/bin/gh" auth git-credential');
  });
  it("zera os helpers antigos antes de pôr o do gh (só no comando)", () => {
    expect(argsCredencialGh("/usr/bin/gh")).toEqual(["-c", "credential.helper=", "-c", 'credential.helper=!"/usr/bin/gh" auth git-credential']);
  });
  it("config local fica restrita ao github.com", () => {
    const pares = configLocalGh("/usr/bin/gh");
    expect(pares.map(([k]) => k)).toEqual(["credential.https://github.com.helper", "credential.https://github.com.helper"]);
    expect(pares[0]![1]).toBe("");
  });
  it("lê a conta do gh auth status (formato novo e antigo)", () => {
    expect(contaDoStatus("github.com\n  ✓ Logged in to github.com account ana-lipe (keyring)\n")).toBe("ana-lipe");
    expect(contaDoStatus("github.com\n  ✓ Logged in to github.com as ana-lipe (oauth_token)\n")).toBe("ana-lipe");
    expect(contaDoStatus("You are not logged into any GitHub hosts.")).toBeUndefined();
  });
});

describe("cloneProject com git falso", () => {
  it("gh logado: passa a credencial do gh no clone", async () => {
    projects._configurarCloneParaTestes({ estadoGh: async () => ({ gh: "/usr/bin/gh", logado: true, conta: "ana" }) });
    roteiro = { stderr: [STDERR.naoEncontrado], code: 128 };
    const err = await projects.cloneProject("https://github.com/lipe/repo-a").catch((e: unknown) => e);
    expect((err as ErroClone).tipo).toBe("sem_acesso");
    expect((err as ErroClone).message).toMatch(/\(ana\)/);
    const args = chamadas[0]!;
    expect(args).toContain('credential.helper=!"/usr/bin/gh" auth git-credential');
    expect(args.indexOf("credential.helper=")).toBeLessThan(args.indexOf("clone"));
  });

  it("gh não logado: clona sem credencial e pede login quando é privado", async () => {
    // Em pedaços, como o git manda de verdade: o "\n" entre eles não pode sumir.
    roteiro = { stderr: ["Cloning into 'repo-b'...\n", "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"], code: 128 };
    const err = await projects.cloneProject("https://github.com/lipe/repo-b").catch((e: unknown) => e);
    expect((err as ErroClone).tipo).toBe("sem_login");
    expect((err as ErroClone).detalhe).toBe("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    expect(chamadas[0]!.some((a) => a.startsWith("credential.helper"))).toBe(false);
  });

  it("vigia mata o git parado e diz que foi timeout", async () => {
    projects._configurarCloneParaTestes({ paradoMs: 30 });
    roteiro = { stderr: ["Cloning into 'repo-c'...\n"], code: null };
    const err = await projects.cloneProject("https://github.com/lipe/repo-c").catch((e: unknown) => e);
    expect((err as ErroClone).tipo).toBe("timeout");
  });
});
