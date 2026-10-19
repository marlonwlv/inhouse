/**
 * Login do Claude pela tela: roda `claude auth login --claudeai` (assinatura,
 * nunca API key), captura a URL que o CLI imprime e, quando ele pede
 * ("Paste code here"), manda o código colado na tela direto para o stdin do
 * processo. Nada é gravado pelo InHouse.
 *
 * Comportamento verificado do CLI com stdin em pipe: imprime a URL, lê o
 * código, e com código inválido responde "Invalid code…" e fica parado — por
 * isso matamos o processo e pedimos um código novo.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { claudeEnv } from "../config.js";
import { comandoDoClaude, matarArvore, spawnOpcoes } from "../platform.js";
import { limparAnsi, registrarFilho } from "./instalar.js";

export interface ProcessoLogin {
  stdout: Readable | null;
  stderr: Readable | null;
  stdin: Writable | null;
  pid?: number;
  on(ev: "exit", fn: (code: number | null) => void): unknown;
  on(ev: "error", fn: (err: Error) => void): unknown;
}

export type FaseLogin = "abrindo" | "aguardando" | "confirmando" | "ok" | "erro" | "cancelado";

export interface EstadoLogin {
  fase: FaseLogin;
  url?: string;
  pedeCodigo: boolean;
  mensagem?: string;
}

export interface DepsLogin {
  abrir?: (exe: string, args: string[]) => ProcessoLogin;
  matar?: (p: ProcessoLogin) => void;
  /** `claude auth status --json` → loggedIn. */
  confirmar: () => Promise<boolean>;
  aoMudar: (e: EstadoLogin) => void;
  timeoutMs?: number;
}

export function acharUrl(texto: string): string | undefined {
  return limparAnsi(texto).match(/https:\/\/[^\s"'<>]+/)?.[0];
}

export const pedeCodigoNo = (texto: string): boolean => /paste\s+code/i.test(limparAnsi(texto));
export const codigoInvalidoNo = (texto: string): boolean => /invalid\s+code/i.test(limparAnsi(texto));

function abrirReal(exe: string, args: string[]): ProcessoLogin {
  const c = comandoDoClaude(exe, args);
  const p = spawn(c.arquivo, c.args, { ...spawnOpcoes(), env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
  registrarFilho(p);
  return p;
}

export class LoginClaude {
  private proc: ProcessoLogin | null = null;
  private estado: EstadoLogin = { fase: "cancelado", pedeCodigo: false };
  private timer: NodeJS.Timeout | null = null;
  private saida = "";
  private enviado = false;

  constructor(private readonly deps: DepsLogin) {}

  get ativo(): boolean {
    return this.proc !== null;
  }

  get atual(): EstadoLogin {
    return this.estado;
  }

  private mudar(e: Partial<EstadoLogin>): void {
    this.estado = { ...this.estado, ...e };
    this.deps.aoMudar(this.estado);
  }

  iniciar(exe: string): void {
    if (this.proc) return;
    this.saida = "";
    this.enviado = false;
    this.estado = { fase: "abrindo", pedeCodigo: false, mensagem: "Preparando o login…" };
    this.deps.aoMudar(this.estado);
    const p = (this.deps.abrir ?? abrirReal)(exe, ["auth", "login", "--claudeai"]);
    this.proc = p;
    const ler = (chunk: Buffer | string) => {
      if (this.proc !== p) return;
      this.saida = (this.saida + chunk.toString()).slice(-8000);
      if (codigoInvalidoNo(this.saida)) {
        this.encerrar(p);
        this.mudar({ fase: "erro", pedeCodigo: false, url: undefined, mensagem: "Código não aceito. Gere outro e cole de novo." });
        return;
      }
      if (this.enviado) return;
      const url = acharUrl(this.saida);
      const pede = pedeCodigoNo(this.saida);
      if ((url && url !== this.estado.url) || pede !== this.estado.pedeCodigo) {
        this.mudar({
          fase: "aguardando",
          url: url ?? this.estado.url,
          pedeCodigo: pede,
          mensagem: pede ? "Entre na sua conta e cole aqui o código que aparecer." : "Entre na sua conta na página que abriu.",
        });
      }
    };
    p.stdout?.on("data", ler);
    p.stderr?.on("data", ler);
    p.on("error", () => {
      if (this.proc !== p) return;
      this.limpar();
      this.mudar({ fase: "erro", pedeCodigo: false, mensagem: "Não deu para abrir o login do Claude." });
    });
    p.on("exit", (code) => {
      if (this.proc !== p) return;
      this.limpar();
      void this.finalizar(code);
    });
    this.timer = setTimeout(() => {
      if (this.proc !== p) return;
      this.encerrar(p);
      this.mudar({ fase: "erro", pedeCodigo: false, url: undefined, mensagem: "O login demorou mais de 10 minutos. Comece de novo." });
    }, this.deps.timeoutMs ?? 10 * 60_000);
    this.timer.unref?.();
  }

  private async finalizar(code: number | null): Promise<void> {
    this.mudar({ fase: "confirmando", pedeCodigo: false, mensagem: "Confirmando o login…" });
    const ok = await this.deps.confirmar().catch(() => false);
    if (ok) this.mudar({ fase: "ok", url: undefined, mensagem: "Claude conectado." });
    else
      this.mudar({
        fase: "erro",
        url: undefined,
        mensagem: code === 0 ? "O login não foi confirmado. Tente de novo." : "O login não terminou. Tente de novo.",
      });
  }

  /** Código colado na tela → stdin do CLI. */
  enviarCodigo(codigo: string): boolean {
    const p = this.proc;
    if (!p?.stdin) return false;
    this.saida = "";
    this.enviado = true;
    this.mudar({ fase: "confirmando", pedeCodigo: false, mensagem: "Conferindo o código…" });
    p.stdin.write(`${codigo}\n`);
    return true;
  }

  cancelar(): void {
    if (!this.proc) return;
    this.encerrar(this.proc);
    this.mudar({ fase: "cancelado", url: undefined, pedeCodigo: false, mensagem: undefined });
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
