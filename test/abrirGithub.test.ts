/**
 * GitHub mágico: login por código (parser da saída real do gh, fim sozinho,
 * erro, expiração, cancelar) e o assistente do download (público, privado com
 * tudo faltando, sem acesso, troca de conta, rede, login/instalação que
 * falham → passo a passo manual). Nada toca rede nem o gh de verdade.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CloneJob, LoginGhStatus } from "../shared/types.js";
import { AssistenteClone, passosManuais, textoPedidoAcesso } from "../server/services/abrirGithub.js";
import type { DepsAssistente } from "../server/services/abrirGithub.js";
import { esperarLoginGh } from "../server/services/abrirGithubDeps.js";
import { ErroClone } from "../server/services/cloneErro.js";
import { acharCodigoGh, acharUrlGh, ARGS_LOGIN_GH, envLoginGh, LoginGitHub, navegadorNoop } from "../server/setup/loginGh.js";
import type { ProcessoLogin } from "../server/setup/login.js";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));

// Saída real do gh 2.x sem TTY (Linux, Mac e Windows mudam só o fim de linha).
const SAIDA_GH = {
  linux:
    "\n! Failed to copy one-time code to clipboard\n  No clipboard utilities available.\n! First copy your one-time code: E9DA-1041\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
  mac: "! First copy your one-time code: 7B2C-A9F0\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
  windows: "! First copy your one-time code: WDJB-MJHT\r\nPress Enter to open https://github.com/login/device in your browser... \r\n",
};

describe("saída do gh auth login --web", () => {
  it("acha o código e a URL nos 3 SOs", () => {
    expect(acharCodigoGh(SAIDA_GH.linux)).toBe("E9DA-1041");
    expect(acharCodigoGh(SAIDA_GH.mac)).toBe("7B2C-A9F0");
    expect(acharCodigoGh(SAIDA_GH.windows)).toBe("WDJB-MJHT");
    for (const s of Object.values(SAIDA_GH)) expect(acharUrlGh(s)).toBe("https://github.com/login/device");
    expect(acharCodigoGh("nada aqui")).toBeUndefined();
  });

  it("navegador no-op funciona com caminho do Windows com espaço", () => {
    expect(navegadorNoop("C:\\Program Files\\nodejs\\node.exe")).toBe('"C:/Program Files/nodejs/node.exe" -e 0');
    const env = envLoginGh({ PATH: "/bin" });
    expect(env["GH_BROWSER"]).toBe(env["BROWSER"]);
    expect(env["PATH"]).toBe("/bin");
  });

  it("pede HTTPS e login web no github.com", () => {
    expect(ARGS_LOGIN_GH).toEqual(["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"]);
  });
});

function procFalso() {
  const p = new EventEmitter() as EventEmitter & ProcessoLogin & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (s: string) => boolean } };
  p.stdout = new EventEmitter() as never;
  p.stderr = new EventEmitter() as never;
  p.stdin = { write: () => true } as never;
  return p;
}

describe("LoginGitHub", () => {
  function montar(confirmar: () => Promise<{ logado: boolean; conta?: string }>, timeoutMs?: number) {
    const p = procFalso();
    const estados: LoginGhStatus[] = [];
    const matar = vi.fn();
    const l = new LoginGitHub({ abrir: () => p, matar, confirmar, aoMudar: (e) => estados.push({ ...e }), ...(timeoutMs ? { timeoutMs } : {}) });
    return { p, estados, matar, l };
  }

  it("mostra o código e termina sozinho quando o gh sai com 0", async () => {
    const { p, estados, l } = montar(async () => ({ logado: true, conta: "ana" }));
    l.iniciar("/usr/bin/gh");
    expect(estados[0]?.fase).toBe("abrindo");
    p.stderr.emit("data", Buffer.from(SAIDA_GH.linux));
    expect(l.atual).toMatchObject({ fase: "aguardando", codigo: "E9DA-1041", url: "https://github.com/login/device", ativo: true });
    p.emit("exit", 0);
    await vi.waitFor(() => expect(l.atual.fase).toBe("ok"));
    expect(l.atual.mensagem).toMatch(/ana/);
    expect(l.ativo).toBe(false);
  });

  it("gh saiu com erro: explica (código expirado)", async () => {
    const { p, l } = montar(async () => ({ logado: false }));
    l.iniciar("gh");
    p.stderr.emit("data", Buffer.from("error: the device code has expired\n"));
    p.emit("exit", 1);
    await vi.waitFor(() => expect(l.atual.fase).toBe("erro"));
    expect(l.atual.mensagem).toMatch(/expirou/);
  });

  it("timeout mata o gh e pede para começar de novo", async () => {
    const { l, matar } = montar(async () => ({ logado: false }), 20);
    l.iniciar("gh");
    await vi.waitFor(() => expect(l.atual.fase).toBe("erro"));
    expect(matar).toHaveBeenCalled();
    expect(l.atual.mensagem).toMatch(/15 minutos/);
  });

  it("cancelar mata o processo", () => {
    const { l, matar } = montar(async () => ({ logado: false }));
    l.iniciar("gh");
    l.cancelar();
    expect(matar).toHaveBeenCalled();
    expect(l.atual.fase).toBe("cancelado");
  });
});

describe("esperarLoginGh", () => {
  it("repassa o código e resolve no ok", async () => {
    let ouvir: ((e: LoginGhStatus) => void) | undefined;
    const motor = {
      observarLoginGh: (fn: (e: LoginGhStatus) => void) => {
        ouvir = fn;
        return () => undefined;
      },
      iniciarLoginGh: vi.fn(async () => ({}) as never),
    };
    const vistos: LoginGhStatus[] = [];
    const pr = esperarLoginGh(motor, (l) => vistos.push(l));
    ouvir!({ ativo: true, fase: "aguardando", codigo: "AAAA-BBBB" });
    ouvir!({ ativo: false, fase: "ok" });
    await expect(pr).resolves.toEqual({ ok: true });
    expect(vistos[0]?.codigo).toBe("AAAA-BBBB");
  });
});

// ------------------------------------------------------------- assistente

function deps(o: Partial<DepsAssistente> = {}): DepsAssistente & { chamadas: string[] } {
  const chamadas: string[] = [];
  const reg = <T>(n: string, v: T) => {
    chamadas.push(n);
    return v;
  };
  return {
    chamadas,
    so: "windows",
    validar: (url) => ({ limpo: url, name: url.split("/").pop()!, target: "/tmp/x", repo: url.replace("https://github.com/", "") }),
    reservar: () => undefined,
    estadoGh: async () => reg("estadoGh", { gh: "/gh", logado: true, conta: "ana" }),
    instalarGh: async () => void reg("instalarGh", 0),
    login: async (aoMudar) => {
      reg("login", 0);
      aoMudar({ ativo: true, fase: "aguardando", codigo: "AAAA-BBBB", url: "https://github.com/login/device" });
      return { ok: true };
    },
    credencialOk: async () => reg("credencialOk", true),
    verRepo: async () => reg("verRepo", { ok: true, stderr: "" }),
    anonimo: async () => reg("anonimo", { ok: false, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }),
    clonar: async () => reg("clonar", { id: "p1", name: "repo", kind: "repo", path: "/tmp/x", createdAt: "" } as never),
    comandoGh: (gh) => (gh ? `& "${gh}"` : "gh"),
    ...o,
  };
}

async function rodar(d: DepsAssistente, url = "https://github.com/lipe/monorepo", trocar?: { id?: string; trocarConta: boolean }) {
  const eventos: CloneJob[] = [];
  const a = new AssistenteClone(() => d, (j) => eventos.push(j));
  const job = a.iniciar(url);
  await vi.waitFor(() => expect(a.job(job.id)?.estado).not.toBe("baixando"));
  if (trocar) {
    a.retomar(job.id, trocar.trocarConta);
    await vi.waitFor(() => expect(a.job(job.id)?.estado).not.toBe("baixando"));
  }
  return { job: a.job(job.id)!, eventos, a };
}

const estados = (j: CloneJob) => Object.fromEntries((j.passos ?? []).map((p) => [p.id, p.estado]));

describe("AssistenteClone", () => {
  it("já logado: pula o teste anônimo e segue os 5 passos", async () => {
    const d = deps();
    const { job } = await rodar(d);
    expect(job.estado).toBe("ok");
    expect(estados(job)).toEqual({ gh: "ok", login: "ok", git: "ok", acesso: "ok", baixar: "ok" });
    expect(d.chamadas).not.toContain("anonimo");
    expect(d.chamadas).not.toContain("login");
  });

  it("repositório público sem gh: não pede instalação nem login", async () => {
    const d = deps({ estadoGh: async () => ({ gh: null, logado: false }), anonimo: async () => ({ ok: true, stderr: "" }) });
    const { job } = await rodar(d);
    expect(job.estado).toBe("ok");
    expect(estados(job)).toMatchObject({ gh: "pulado", login: "pulado", git: "pulado", acesso: "ok", baixar: "ok" });
    expect(d.chamadas).not.toContain("instalarGh");
  });

  it("privado com tudo faltando: instala o gh, faz o login (mostra o código) e baixa", async () => {
    let st = { gh: null as string | null, logado: false, conta: undefined as string | undefined };
    const d = deps({
      estadoGh: async () => ({ ...st }),
      instalarGh: async () => {
        st = { ...st, gh: "/gh" };
      },
      login: async (aoMudar) => {
        aoMudar({ ativo: true, fase: "aguardando", codigo: "AAAA-BBBB", url: "https://github.com/login/device" });
        st = { gh: "/gh", logado: true, conta: "ana" };
        return { ok: true };
      },
    });
    const { job, eventos } = await rodar(d);
    expect(job.estado).toBe("ok");
    expect(estados(job)).toEqual({ gh: "ok", login: "ok", git: "ok", acesso: "ok", baixar: "ok" });
    expect(job.passos?.find((p) => p.id === "login")?.detalhe).toMatch(/ana/);
    // O código apareceu no checklist enquanto esperava a pessoa.
    expect(eventos.some((e) => e.login?.codigo === "AAAA-BBBB" && e.passos?.find((p) => p.id === "login")?.estado === "aguardando")).toBe(true);
    expect(job.login).toBeUndefined();
  });

  it("sem acesso: mostra a conta e o texto pronto, oferece outra conta", async () => {
    const d = deps({ verRepo: async () => ({ ok: false, stderr: "GraphQL: Could not resolve to a Repository with the name 'lipe/monorepo'. (repository)" }) });
    const { job } = await rodar(d);
    expect(job.estado).toBe("erro");
    expect(job.erro?.tipo).toBe("sem_acesso");
    expect(job.erro?.mensagem).toMatch(/ana/);
    expect(job.erro?.ajuda).toMatchObject({ conta: "ana", repo: "lipe/monorepo", dono: "lipe", podeTrocarConta: true });
    expect(job.erro?.ajuda?.pedidoAcesso).toMatch(/lipe\/monorepo/);
    expect(job.erro?.ajuda?.pedidoAcesso).toMatch(/ana/);
    expect(estados(job).acesso).toBe("erro");
    expect(estados(job).baixar).toBe("pendente");
  });

  it("Entrar com outra conta: refaz o login mesmo logado", async () => {
    let conta = "ana";
    const d = deps({
      estadoGh: async () => ({ gh: "/gh", logado: true, conta }),
      login: async () => {
        conta = "ana-trabalho";
        return { ok: true };
      },
      verRepo: async () => ({ ok: conta === "ana-trabalho", stderr: "Could not resolve to a Repository" }),
    });
    const { job } = await rodar(d, undefined, { trocarConta: true });
    expect(job.estado).toBe("ok");
    expect(job.passos?.find((p) => p.id === "login")?.detalhe).toMatch(/ana-trabalho/);
  });

  it("SSO da organização: explica o Authorize", async () => {
    const d = deps({ verRepo: async () => ({ ok: false, stderr: "Resource protected by organization SAML enforcement." }) });
    const { job } = await rodar(d);
    expect(job.erro?.tipo).toBe("sem_acesso");
    expect(job.erro?.mensagem).toMatch(/SSO/);
  });

  it("sem internet: diz que é rede, não pede login", async () => {
    const d = deps({
      estadoGh: async () => ({ gh: null, logado: false }),
      anonimo: async () => ({ ok: false, stderr: "fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com" }),
    });
    const { job } = await rodar(d);
    expect(job.erro?.tipo).toBe("rede");
    expect(job.erro?.mensagem).toMatch(/internet/);
    expect(d.chamadas).not.toContain("instalarGh");
  });

  it("login automático falhou: passo a passo manual com o caminho do gh", async () => {
    const d = deps({
      estadoGh: async () => ({ gh: "C:\\Users\\ana\\.inhouse\\ferramentas\\gh\\bin\\gh.exe", logado: false }),
      login: async () => ({ ok: false, mensagem: "O login do GitHub não terminou." }),
    });
    const { job } = await rodar(d);
    expect(job.erro?.tipo).toBe("login_falhou");
    const manual = job.erro?.ajuda?.manual ?? [];
    expect(manual.map((m) => m.comando).filter(Boolean)).toEqual([
      '& "C:\\Users\\ana\\.inhouse\\ferramentas\\gh\\bin\\gh.exe" auth login --hostname github.com --git-protocol https --web',
      '& "C:\\Users\\ana\\.inhouse\\ferramentas\\gh\\bin\\gh.exe" auth setup-git',
    ]);
    expect(manual[0]?.texto).toMatch(/PowerShell/);
  });

  it("não deu para instalar o gh: manual com o site oficial", async () => {
    const d = deps({
      estadoGh: async () => ({ gh: null, logado: false }),
      instalarGh: async () => {
        throw new Error("Não deu para baixar o GitHub CLI.");
      },
    });
    const { job } = await rodar(d);
    expect(job.erro?.tipo).toBe("gh_falhou");
    expect(job.erro?.ajuda?.manual?.[0]?.texto).toMatch(/cli\.github\.com/);
  });

  it("erro no git clone vira o erro classificado no passo Baixar", async () => {
    const d = deps({
      clonar: async () => {
        throw new ErroClone({ tipo: "disco", mensagem: "Falta espaço no disco", detalhe: "No space left" });
      },
    });
    const { job } = await rodar(d);
    expect(job.erro?.tipo).toBe("disco");
    expect(estados(job).baixar).toBe("erro");
  });

  it("Tentar de novo depois de rede refaz do começo e termina", async () => {
    let n = 0;
    const d = deps({
      estadoGh: async () => ({ gh: null, logado: false }),
      anonimo: async () => (n++ === 0 ? { ok: false, stderr: "Could not resolve host: github.com" } : { ok: true, stderr: "" }),
    });
    const { job } = await rodar(d, undefined, { trocarConta: false });
    expect(job.estado).toBe("ok");
    expect(job.erro).toBeUndefined();
  });

  it("libera o nome no fim (segundo download pode começar)", async () => {
    const reservas: string[] = [];
    const d = deps({ reservar: (n, sim) => void reservas.push(`${sim ? "+" : "-"}${n}`) });
    await rodar(d);
    expect(reservas).toEqual(["+monorepo", "-monorepo"]);
  });
});

describe("textos de ajuda", () => {
  it("pedido de acesso tem repo, conta e onde clicar", () => {
    const t = textoPedidoAcesso("lipe/monorepo", "ana");
    expect(t).toMatch(/lipe\/monorepo/);
    expect(t).toMatch(/Minha conta no GitHub é: ana/);
    expect(t).toMatch(/Collaborators/);
  });
  it("passo a passo muda o jeito de abrir o terminal por SO", () => {
    expect(passosManuais("mac", "gh")[0]?.texto).toMatch(/Cmd \+ Espaço/);
    expect(passosManuais("windows", "gh")[0]?.texto).toMatch(/PowerShell/);
    expect(passosManuais("linux", "gh", true)[0]?.texto).toMatch(/cli\.github\.com/);
  });
});
