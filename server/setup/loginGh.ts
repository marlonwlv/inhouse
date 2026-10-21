/**
 * Login do GitHub pela tela, sem terminal: roda `gh auth login --web` e lê o
 * código de uso único que o gh imprime ("First copy your one-time code:
 * ABCD-1234"). A pessoa digita o código em github.com/login/device e o gh, que
 * fica consultando o GitHub, termina sozinho quando ela autoriza — aí
 * confirmamos com `gh auth status`.
 *
 * Comportamento verificado do gh 2.x sem TTY: imprime o código e a URL no
 * stderr e já começa a esperar (não pede Enter). Trocamos o navegador dele por
 * um no-op (GH_BROWSER/BROWSER): quem abre a página é a UI, depois de mostrar o
 * código — senão abririam duas abas.
 */
import { spawn } from "node:child_process";
import type { LoginGhStatus } from "../../shared/types.js";
import { matarArvore, spawnOpcoes } from "../platform.js";
import { limparAnsi, registrarFilho } from "./instalar.js";
import type { ProcessoLogin } from "./login.js";

export const URL_DEVICE = "https://github.com/login/device";

export interface DepsLoginGh {
  abrir?: (gh: string, args: string[], env: NodeJS.ProcessEnv) => ProcessoLogin;
  matar?: (p: ProcessoLogin) => void;
  /** `gh auth status` depois que o gh saiu. */
  confirmar: () => Promise<{ logado: boolean; conta?: string }>;
  aoMudar: (e: LoginGhStatus) => void;
  env?: NodeJS.ProcessEnv;
  /** O código do GitHub vale 15 minutos. */
  timeoutMs?: number;
}

export function acharCodigoGh(texto: string): string | undefined {
  return /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(limparAnsi(texto))?.[1]?.toUpperCase();
}

export function acharUrlGh(texto: string): string | undefined {
  return /https:\/\/github\.com\/login\/device[^\s"'<>]*/.exec(limparAnsi(texto))?.[0];
}

/** Navegador "que não faz nada" e funciona nos 3 SOs: o próprio Node. */
export function navegadorNoop(execPath: string = process.execPath): string {
  return `"${execPath.replace(/\\/g, "/")}" -e 0`;
}

export function envLoginGh(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const noop = navegadorNoop();
  return { ...base, GH_BROWSER: noop, BROWSER: noop, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
}

export const ARGS_LOGIN_GH = ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https"];

function abrirReal(gh: string, args: string[], env: NodeJS.ProcessEnv): ProcessoLogin {
  const p = spawn(gh, args, { ...spawnOpcoes(), env, stdio: ["pipe", "pipe", "pipe"] });
  registrarFilho(p);
  return p;
}

export class LoginGitHub {
  private proc: ProcessoLogin | null = null;
  private estado: LoginGhStatus = { ativo: false, fase: "cancelado" };
  private timer: NodeJS.Timeout | null = null;
  private saida = "";

  constructor(private readonly deps: DepsLoginGh) {}

  get ativo(): boolean {
    return this.proc !== null;
  }

  get atual(): LoginGhStatus {
    return this.estado;
  }

  private mudar(e: Partial<LoginGhStatus>): void {
    this.estado = { ...this.estado, ...e, ativo: this.proc !== null };
    this.deps.aoMudar(this.estado);
  }

  iniciar(gh: string): void {
    if (this.proc) return;
    this.saida = "";
    const p = (this.deps.abrir ?? abrirReal)(gh, ARGS_LOGIN_GH, envLoginGh(this.deps.env));
    this.proc = p;
    this.estado = { ativo: true, fase: "abrindo", mensagem: "Pedindo um código ao GitHub…" };
    this.deps.aoMudar(this.estado);
    const ler = (chunk: Buffer | string) => {
      if (this.proc !== p) return;
      this.saida = (this.saida + chunk.toString()).slice(-8000);
      const codigo = acharCodigoGh(this.saida);
      if (codigo && codigo !== this.estado.codigo) {
        this.mudar({
          fase: "aguardando",
          codigo,
          url: acharUrlGh(this.saida) ?? URL_DEVICE,
          mensagem: "Digite o código na página do GitHub. Esta tela percebe sozinha quando você terminar.",
        });
      }
    };
    p.stdout?.on("data", ler);
    p.stderr?.on("data", ler);
    // Versões antigas do gh pedem Enter para abrir o navegador: damos o Enter.
    p.stdin?.write("\n");
    p.on("error", () => {
      if (this.proc !== p) return;
      this.limpar();
      this.mudar({ fase: "erro", codigo: undefined, url: undefined, mensagem: "Não deu para abrir o login do GitHub neste computador." });
    });
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.limpar();
      void this.finalizar(code);
    });
    this.timer = setTimeout(() => {
      if (this.proc !== p) return;
      this.encerrar(p);
      this.mudar({ fase: "erro", codigo: undefined, url: undefined, mensagem: "O código do GitHub expirou (vale 15 minutos). Comece de novo." });
    }, this.deps.timeoutMs ?? 15 * 60_000);
    this.timer.unref?.();
  }

  private async finalizar(code: number | null): Promise<void> {
    this.mudar({ fase: "confirmando", codigo: undefined, mensagem: "Confirmando o login…" });
    const r: { logado: boolean; conta?: string } = await this.deps.confirmar().catch(() => ({ logado: false }));
    if (r.logado && code === 0) {
      this.mudar({ fase: "ok", url: undefined, mensagem: r.conta ? `GitHub conectado · ${r.conta}` : "GitHub conectado." });
      return;
    }
    const txt = limparAnsi(this.saida);
    const mensagem = /expired|expirou/i.test(txt)
      ? "O código do GitHub expirou. Comece de novo."
      : /access_denied|denied|cancel/i.test(txt)
        ? "O GitHub não autorizou o login (ele foi recusado na página). Tente de novo."
        : /Could not resolve|connect|timeout|network/i.test(txt)
          ? "Não conseguimos falar com o GitHub. Confira a internet e tente de novo."
          : "O login do GitHub não terminou. Tente de novo.";
    this.mudar({ fase: "erro", url: undefined, mensagem });
  }

  cancelar(): void {
    if (!this.proc) return;
    this.encerrar(this.proc);
    this.mudar({ fase: "cancelado", codigo: undefined, url: undefined, mensagem: undefined });
  }

  private limpar(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.proc = null;
  }

  private encerrar(p: ProcessoLogin): void {
    this.limpar();
    if (this.deps.matar) this.deps.matar(p);
    else matarArvore(p.pid, "SIGKILL");
  }
}
