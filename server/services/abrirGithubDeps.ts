/**
 * Dependências do assistente "Abrir do GitHub": as reais (gh, git, o motor da
 * preparação) e as de demonstração (INHOUSE_SETUP_DEMO=1), mais o singleton
 * que as rotas usam.
 */
import type { CloneJob, LoginGhStatus, SetupStatus } from "../../shared/types.js";
import { matarFilho, spawnPortatil } from "../platform.js";
import { localizarGh, maquinaReal } from "../setup/detectar.js";
import { modoDemo, motorSetup } from "../setup/servico.js";
import { AssistenteClone } from "./abrirGithub.js";
import type { DepsAssistente, ResultadoLogin } from "./abrirGithub.js";
import { estadoGh, ghEntregaCredencial, ghVerRepo } from "./githubCred.js";
import type { EstadoGh } from "./githubCred.js";
import { executarClone, reservarNome, validarClone } from "./projects.js";

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Espera o login por código (o mesmo de Preparar o computador) terminar. */
export function esperarLoginGh(
  motor: Pick<ReturnType<typeof motorSetup>, "iniciarLoginGh" | "observarLoginGh">,
  aoMudar: (l: LoginGhStatus) => void,
): Promise<ResultadoLogin> {
  return new Promise((resolve) => {
    let feito = false;
    const acabar = (r: ResultadoLogin) => {
      if (feito) return;
      feito = true;
      parar();
      resolve(r);
    };
    const ouvir = (l: LoginGhStatus) => {
      if (l.fase === "ok") return acabar({ ok: true });
      if (l.fase === "erro") return acabar({ ok: false, mensagem: l.mensagem ?? "O login do GitHub não terminou." });
      if (l.fase === "cancelado") return acabar({ ok: false, mensagem: "O login do GitHub foi cancelado." });
      aoMudar(l);
    };
    const parar = motor.observarLoginGh(ouvir);
    motor
      .iniciarLoginGh()
      .then((s: SetupStatus) => {
        // Login já aberto (pela Preparação): mostra o código que já existe.
        if (s.loginGh) ouvir(s.loginGh);
      })
      .catch((err: unknown) => acabar({ ok: false, mensagem: err instanceof Error ? err.message : "Não deu para abrir o login do GitHub." }));
  });
}

function anonimoReal(url: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    // credential.helper vazio: sem keychain/Credential Manager, de propósito anônimo.
    const child = spawnPortatil("git", ["-c", "credential.helper=", "ls-remote", url, "HEAD"], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let parado = false;
    const t = setTimeout(() => {
      parado = true;
      matarFilho(child, "SIGKILL");
    }, 30_000);
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + String(d)).slice(-8000);
    });
    child.on("error", () => {
      clearTimeout(t);
      resolve({ ok: false, stderr: "could not run git" });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0 && !parado, stderr: parado ? `${stderr}\nOperation timed out` : stderr });
    });
  });
}

function comandoGhReal(gh: string | null): string {
  if (!gh) return "gh";
  const m = maquinaReal();
  const doPath = m.procurar("gh")[0];
  if (doPath && doPath.trim() === gh) return "gh";
  if (m.so === "windows") return `& "${gh}"`;
  return /\s/.test(gh) ? `"${gh}"` : gh;
}

async function instalarGhReal(aoProgresso: (mensagem: string, pct?: number) => void): Promise<void> {
  const motor = motorSetup();
  const itemGh = (s: SetupStatus) => s.itens.find((i) => i.id === "gh");
  for (let i = 0; ; i++) {
    try {
      await motor.instalar(["gh"]);
      break;
    } catch (err) {
      // Outra instalação em andamento: espera ela e tenta de novo.
      if (i > 300) throw err;
      const s = await motor.status();
      if (itemGh(s)?.estado === "ok") return;
      if (!s.instalando && !s.ocupadoPorOutro && !(err instanceof Error && /instalando|login/i.test(err.message))) throw err;
      await dormir(1000);
    }
  }
  for (;;) {
    await dormir(800);
    const s = motor.ultimo() ?? (await motor.status());
    const it = itemGh(s);
    if (it?.estado === "instalando" || s.instalando) {
      if (it?.progresso?.mensagem) aoProgresso(it.progresso.mensagem, it.progresso.pct);
      continue;
    }
    const final = await motor.status(true);
    const g = itemGh(final);
    if (g?.estado === "ok") return;
    throw new Error(g?.detalhe || "Não deu para instalar o GitHub CLI.");
  }
}

export function depsReais(): DepsAssistente {
  const m = maquinaReal();
  return {
    so: m.so,
    validar: validarClone,
    reservar: reservarNome,
    estadoGh: () => estadoGh(),
    instalarGh: instalarGhReal,
    login: (aoMudar) => esperarLoginGh(motorSetup(), aoMudar),
    credencialOk: (gh) => ghEntregaCredencial(gh).catch(() => false),
    verRepo: (gh, repo) => ghVerRepo(gh, repo).catch((err: unknown) => ({ ok: false, stderr: String(err) })),
    anonimo: anonimoReal,
    clonar: (alvo, aoProgresso) => executarClone(alvo, aoProgresso),
    comandoGh: (gh) => comandoGhReal(gh ?? localizarGh(m)),
  };
}

// ------------------------------------------------------------- demonstração

export const CENARIOS_CLONE = [
  { id: "magico", rotulo: "Privado, falta tudo (instala, login por código, baixa)" },
  { id: "publico", rotulo: "Repositório público (pula o login)" },
  { id: "sem-acesso", rotulo: "Sem acesso / conta errada" },
  { id: "rede", rotulo: "Sem internet" },
  { id: "login-falhou", rotulo: "Login automático falhou (passo a passo manual)" },
  { id: "gh-falhou", rotulo: "Não deu para instalar o GitHub CLI" },
] as const;
export type CenarioClone = (typeof CENARIOS_CLONE)[number]["id"];

export function cenarioCloneValido(c: unknown): c is CenarioClone {
  return CENARIOS_CLONE.some((x) => x.id === c);
}

let cenarioDemo: CenarioClone = "magico";
export function cenarioCloneAtual(): CenarioClone {
  return cenarioDemo;
}
export function trocarCenarioClone(c: CenarioClone): void {
  cenarioDemo = c;
  tentativasDemo = 0;
}
let tentativasDemo = 0;

const STDERR_DNS = "fatal: unable to access 'https://github.com/x/y/': Could not resolve host: github.com\n";

/** Nada é instalado nem baixado: só tempo e estados, para validar a tela. */
export function depsDemo(passoMs = 350): DepsAssistente {
  const c = cenarioDemo;
  // Primeira tentativa mostra a falha; "Tentar de novo" segue até o fim.
  const tentativa = tentativasDemo++;
  const falha = tentativa === 0;
  let gh: EstadoGh = c === "magico" || c === "gh-falhou" ? { gh: null, logado: false } : c === "sem-acesso" ? { gh: "gh", logado: true, conta: "ana-souza" } : { gh: "gh", logado: false };
  const progresso = async (fn: (m: string, pct?: number) => void, msg: string) => {
    for (let pct = 0; pct <= 100; pct += 20) {
      fn(pct < 60 ? `${msg} ${pct}%` : pct < 100 ? "Quase lá…" : "Pronto.", pct);
      await dormir(passoMs * 2);
    }
  };
  return {
    so: "windows",
    demo: true,
    validar: validarClone,
    reservar: reservarNome,
    estadoGh: async () => gh,
    instalarGh: async (fn) => {
      await progresso(fn, "Baixando o GitHub CLI…");
      if (c === "gh-falhou" && falha) throw new Error("Não deu para baixar o GitHub CLI (a conexão caiu).");
      gh = { ...gh, gh: "gh" };
    },
    login: async (aoMudar) => {
      aoMudar({ ativo: true, fase: "abrindo", mensagem: "Pedindo um código ao GitHub…" });
      await dormir(passoMs * 3);
      aoMudar({
        ativo: true,
        fase: "aguardando",
        codigo: "WDJB-MJHT",
        url: "https://github.com/login/device",
        mensagem: "Digite o código na página do GitHub. Esta tela percebe sozinha quando você terminar.",
      });
      await dormir(passoMs * 25);
      aoMudar({ ativo: true, fase: "confirmando", mensagem: "Confirmando o login…" });
      await dormir(passoMs * 3);
      if (c === "login-falhou" && falha) return { ok: false, mensagem: "O login do GitHub não terminou." };
      gh = { gh: "gh", logado: true, conta: c === "sem-acesso" ? "ana-trabalho" : "ana-souza" };
      return { ok: true, conta: gh.conta };
    },
    credencialOk: async () => {
      await dormir(passoMs * 2);
      return true;
    },
    verRepo: async () => {
      await dormir(passoMs * 3);
      if (c === "sem-acesso" && gh.conta === "ana-souza") return { ok: false, stderr: "GraphQL: Could not resolve to a Repository with the name 'x/y'. (repository)" };
      return { ok: true, stderr: "" };
    },
    anonimo: async () => {
      await dormir(passoMs * 3);
      if (c === "publico") return { ok: true, stderr: "" };
      if (c === "rede" && falha) return { ok: false, stderr: STDERR_DNS };
      if (c === "rede") return { ok: true, stderr: "" };
      return { ok: false, stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" };
    },
    clonar: async (_alvo, fn) => {
      await progresso(fn, "Baixando os arquivos do projeto…");
      return undefined;
    },
    comandoGh: () => `& "C:\\Users\\ana\\.inhouse\\ferramentas\\gh\\bin\\gh.exe"`,
  };
}

// ------------------------------------------------------------- singleton

let assistente: AssistenteClone | null = null;
export function assistenteClone(): AssistenteClone {
  assistente ??= new AssistenteClone(() => (modoDemo() ? depsDemo() : depsReais()));
  return assistente;
}

export function iniciarClone(url: string): CloneJob {
  return assistenteClone().iniciar(url);
}
export function cloneJob(id: string): CloneJob | undefined {
  return assistenteClone().job(id);
}
export function retomarClone(id: string, trocarConta: boolean): CloneJob {
  return assistenteClone().retomar(id, trocarConta);
}
