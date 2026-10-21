/**
 * Serviço da preparação do computador: estado do checklist, instalação (com
 * trava entre processos), login do Claude, identidade do git e o aviso pela
 * SSE (`setup_status`). Escolhe o motor real ou o de demonstração
 * (INHOUSE_SETUP_DEMO=1).
 */
import type { LoginGhStatus, SetupItem, SetupItemId, SetupStatus } from "../../shared/types.js";
import { zerarCacheClaudePath } from "../config.js";
import { zerarCacheGitBash } from "../platform.js";
import { aplicarAmbiente, pastaFerramentas } from "./ambiente.js";
import { ErroHttp, gravarConcluido, lerConcluido, mostrarAoAbrir, validarCodigo, validarIdentidade } from "./comum.js";
import type { MotorSetup } from "./comum.js";
import { MotorDemo } from "./demo.js";
import { comandoGit, contaDoStatus, detectarLoginClaude, detectarTudo, itemBase, localizarClaude, localizarGh, maquinaReal, prontoParaUsar } from "./detectar.js";
import type { Deteccao, Maquina } from "./detectar.js";
import { adquirirTrava, ErroSetup, executarPasso, itemInstalavel, matarFilhosDoSetup, planejar, redeReal, rodarReal } from "./instalar.js";
import type { ContextoInstalacao, Rede, Rodar, Trava } from "./instalar.js";
import { LoginClaude } from "./login.js";
import type { EstadoLogin } from "./login.js";
import { LoginGitHub } from "./loginGh.js";

export { ErroHttp } from "./comum.js";

const CACHE_MS = 20_000;
const MAX_LOG = 40;

export interface DepsMotorReal {
  maquina?: Maquina;
  rede?: Rede;
  rodar?: Rodar;
  emitir: (s: SetupStatus) => void;
  temProjetos?: () => boolean;
  /** Chamado depois de instalar algo/logar (zera caches de quem usa as ferramentas). */
  aoMudarFerramentas?: () => void;
  dataDir?: string;
  login?: LoginClaude;
  loginGh?: LoginGitHub;
}

interface Sobrescrita {
  estado: SetupItem["estado"];
  detalhe?: string;
  progresso?: SetupItem["progresso"];
  log: string[];
}

export class MotorReal implements MotorSetup {
  private m: Maquina;
  private rede: Rede;
  private rodar: Rodar;
  private cache: { em: number; d: Deteccao } | null = null;
  private emAndamento: Promise<Deteccao> | null = null;
  private sobre = new Map<SetupItemId, Sobrescrita>();
  private instalando = false;
  private ocupadoPorOutro = false;
  private loginEstado: EstadoLogin | null = null;
  private login: LoginClaude;
  private loginGh: LoginGitHub;
  private loginGhEstado: LoginGhStatus | null = null;
  private obsGh = new Set<(e: LoginGhStatus) => void>();
  private ultimoStatus: SetupStatus | null = null;
  private timerEmitir: NodeJS.Timeout | null = null;
  private ultimaEmissao = 0;

  constructor(private readonly deps: DepsMotorReal) {
    this.m = deps.maquina ?? maquinaReal();
    this.rede = deps.rede ?? redeReal(this.m.env);
    this.rodar = deps.rodar ?? rodarReal;
    this.login =
      deps.login ??
      new LoginClaude({
        confirmar: async () => {
          const exe = localizarClaude(this.m);
          return (await detectarLoginClaude(this.m, exe)).estado === "ok";
        },
        aoMudar: (e) => this.aoMudarLogin(e),
      });
    this.loginGh =
      deps.loginGh ??
      new LoginGitHub({
        env: this.m.env,
        confirmar: async () => {
          const gh = localizarGh(this.m);
          if (!gh) return { logado: false };
          const r = await this.m.exec(gh, ["auth", "status", "--hostname", "github.com"], {
            timeoutMs: 10_000,
            env: { ...this.m.env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1" },
          });
          const conta = r.code === 0 ? contaDoStatus(`${r.stdout}\n${r.stderr}`) : undefined;
          return { logado: r.code === 0, ...(conta ? { conta } : {}) };
        },
        aoMudar: (e) => this.aoMudarLoginGh(e),
      });
  }

  private async detectar(forcar: boolean): Promise<Deteccao> {
    if (!forcar && this.cache && Date.now() - this.cache.em < CACHE_MS) return this.cache.d;
    if (this.emAndamento) return this.emAndamento;
    this.emAndamento = detectarTudo(this.m)
      .then((d) => {
        this.cache = { em: Date.now(), d };
        // Item que a detecção diz estar ok não carrega erro antigo.
        for (const it of d.itens) if (it.estado === "ok" && this.sobre.get(it.id)?.estado === "erro") this.sobre.delete(it.id);
        return d;
      })
      .finally(() => {
        this.emAndamento = null;
      });
    return this.emAndamento;
  }

  private montar(d: Deteccao): SetupStatus {
    const itens = d.itens.map((it) => {
      const s = this.sobre.get(it.id);
      if (it.id === "claude_login" && this.loginEstado?.fase === "erro" && !s) {
        return { ...it, estado: "erro" as const, acao: "login" as const, detalhe: this.loginEstado.mensagem };
      }
      if (it.id === "gh_login" && this.loginGhEstado?.fase === "erro" && !s) {
        return { ...it, estado: "erro" as const, acao: "login_gh" as const, detalhe: this.loginGhEstado.mensagem };
      }
      if (!s) return it;
      return { ...it, estado: s.estado, detalhe: s.detalhe ?? it.detalhe, progresso: s.progresso, log: s.log.slice(-MAX_LOG), acao: it.acao ?? (s.estado === "erro" ? "instalar" : undefined) };
    });
    const pronto = prontoParaUsar(itens);
    const concluidoEm = lerConcluido(this.deps.dataDir);
    const l = this.loginEstado;
    const loginVisivel = l && (l.fase === "abrindo" || l.fase === "aguardando" || l.fase === "confirmando" || l.fase === "erro");
    const g = this.loginGhEstado;
    const ghVisivel = g && g.fase !== "ok" && g.fase !== "cancelado";
    return {
      so: this.m.so,
      itens,
      prontoParaUsar: pronto,
      instalando: this.instalando,
      ...(this.ocupadoPorOutro ? { ocupadoPorOutro: true } : {}),
      ...(loginVisivel ? { login: { ativo: this.login.ativo, url: l.url, pedeCodigo: l.pedeCodigo, mensagem: l.mensagem } } : {}),
      ...(ghVisivel ? { loginGh: { ...g, ativo: this.loginGh.ativo } } : {}),
      identidade: d.identidade,
      ...(concluidoEm ? { concluidoEm } : {}),
      mostrarAoAbrir: mostrarAoAbrir(pronto, concluidoEm, this.deps.temProjetos?.() ?? false),
      verificadoEm: new Date(this.cache?.em ?? Date.now()).toISOString(),
    };
  }

  /** Avisa a UI, no máximo 4 vezes por segundo (progresso de download é frequente). */
  private emitir(): void {
    if (this.timerEmitir) return;
    const espera = Math.max(0, 250 - (Date.now() - this.ultimaEmissao));
    this.timerEmitir = setTimeout(() => {
      this.timerEmitir = null;
      this.ultimaEmissao = Date.now();
      if (!this.cache) return;
      this.ultimoStatus = this.montar(this.cache.d);
      this.deps.emitir(this.ultimoStatus);
    }, espera);
    this.timerEmitir.unref?.();
  }

  private async emitirAgora(forcar: boolean): Promise<SetupStatus> {
    const d = await this.detectar(forcar);
    this.ultimoStatus = this.montar(d);
    this.deps.emitir(this.ultimoStatus);
    return this.ultimoStatus;
  }

  async status(forcar = false): Promise<SetupStatus> {
    const d = await this.detectar(forcar);
    this.ultimoStatus = this.montar(d);
    return this.ultimoStatus;
  }

  ultimo(): SetupStatus | null {
    return this.ultimoStatus;
  }

  private ferramentasMudaram(): void {
    aplicarAmbiente();
    zerarCacheClaudePath();
    zerarCacheGitBash();
    this.cache = null;
    this.deps.aoMudarFerramentas?.();
  }

  async instalar(pedidos?: SetupItemId[]): Promise<SetupStatus> {
    if (pedidos?.some((id) => !itemInstalavel(id))) throw new ErroHttp(400, "Um dos itens pedidos não existe ou não se instala.");
    if (this.instalando) throw new ErroHttp(409, "Já estou instalando. Espere terminar.");
    if (this.login.ativo) throw new ErroHttp(409, "Termine o login do Claude antes de instalar.");
    if (this.loginGh.ativo) throw new ErroHttp(409, "Termine o login do GitHub antes de instalar.");
    const d = await this.detectar(true);
    const atual = this.montar(d);
    let passos;
    try {
      passos = planejar(atual.itens, this.m.so, pedidos, this.m.env);
    } catch (err) {
      if (err instanceof ErroSetup) throw new ErroHttp(400, err.message);
      throw err;
    }
    if (passos.length === 0) return atual;
    const trava = adquirirTrava(pastaFerramentas(this.m.env, this.m.casa));
    if (!trava) {
      this.ocupadoPorOutro = true;
      this.emitir();
      throw new ErroHttp(409, "Outra janela do InHouse está instalando. Espere ela terminar.");
    }
    this.ocupadoPorOutro = false;
    this.instalando = true;
    for (const p of passos) for (const id of p.itens) this.sobre.set(id, { estado: "instalando", progresso: { mensagem: "Na fila…" }, log: [] });
    void this.rodarPassos(passos, trava);
    return this.montar(d);
  }

  private async rodarPassos(passos: ReturnType<typeof planejar>, trava: Trava): Promise<void> {
    try {
      for (const passo of passos) {
        const ctx: ContextoInstalacao = {
          m: this.m,
          rede: this.rede,
          rodar: this.rodar,
          progresso: (_item, mensagem, pct) => {
            for (const id of passo.itens) {
              const s = this.sobre.get(id);
              if (s) s.progresso = { mensagem, ...(pct !== undefined ? { pct } : {}) };
            }
            this.emitir();
          },
          log: (_item, linha) => {
            for (const id of passo.itens) {
              const s = this.sobre.get(id);
              if (s) {
                s.log.push(linha);
                if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
              }
            }
            this.emitir();
          },
          dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
        };
        try {
          await executarPasso(passo, ctx);
          for (const id of passo.itens) this.sobre.delete(id);
          this.ferramentasMudaram();
          await this.emitirAgora(true);
        } catch (err) {
          const msg = err instanceof ErroSetup ? err.message : `Não deu para instalar. ${err instanceof Error ? err.message : ""}`.trim();
          for (const id of passo.itens) {
            const s = this.sobre.get(id) ?? { estado: "erro", log: [] };
            this.sobre.set(id, { estado: "erro", detalhe: msg, log: s.log });
          }
          // O resto depende da ordem (Claude no Windows precisa do Git): para aqui.
          for (const p of passos) for (const id of p.itens) if (this.sobre.get(id)?.estado === "instalando") this.sobre.delete(id);
          break;
        }
      }
    } finally {
      trava.liberar();
      this.instalando = false;
      this.ferramentasMudaram();
      await this.emitirAgora(true).catch(() => undefined);
    }
  }

  private aoMudarLogin(e: EstadoLogin): void {
    this.loginEstado = e;
    if (e.fase === "ok") {
      this.loginEstado = null;
      this.ferramentasMudaram();
      void this.emitirAgora(true).catch(() => undefined);
      return;
    }
    if (e.fase === "cancelado") this.loginEstado = null;
    this.emitir();
  }

  async iniciarLogin(): Promise<SetupStatus> {
    if (this.instalando) throw new ErroHttp(409, "Espere a instalação terminar para fazer o login.");
    const exe = localizarClaude(this.m);
    if (!exe) throw new ErroHttp(409, "Instale o Claude Code primeiro.");
    if (!this.login.ativo) this.login.iniciar(exe);
    return this.status();
  }

  async enviarCodigo(codigo: string): Promise<SetupStatus> {
    const c = validarCodigo(codigo);
    if (!this.login.enviarCodigo(c)) throw new ErroHttp(409, "O login não está aberto. Clique em Fazer login do Claude.");
    return this.status();
  }

  async cancelarLogin(): Promise<SetupStatus> {
    this.login.cancelar();
    this.loginEstado = null;
    return this.status();
  }

  private aoMudarLoginGh(e: LoginGhStatus): void {
    this.loginGhEstado = e;
    for (const fn of this.obsGh) {
      try {
        fn(e);
      } catch {
        /* quem ouve não derruba o login */
      }
    }
    if (e.fase === "ok") {
      this.loginGhEstado = null;
      this.ferramentasMudaram();
      void this.emitirAgora(true).catch(() => undefined);
      return;
    }
    if (e.fase === "cancelado") this.loginGhEstado = null;
    this.emitir();
  }

  async iniciarLoginGh(): Promise<SetupStatus> {
    if (this.instalando) throw new ErroHttp(409, "Espere a instalação terminar para entrar no GitHub.");
    const gh = localizarGh(this.m);
    if (!gh) throw new ErroHttp(409, "Instale o GitHub CLI primeiro.");
    if (!this.loginGh.ativo) this.loginGh.iniciar(gh);
    return this.status();
  }

  async cancelarLoginGh(): Promise<SetupStatus> {
    this.loginGh.cancelar();
    this.loginGhEstado = null;
    return this.status();
  }

  observarLoginGh(fn: (e: LoginGhStatus) => void): () => void {
    this.obsGh.add(fn);
    return () => this.obsGh.delete(fn);
  }

  async salvarIdentidade(nome: string, email: string): Promise<SetupStatus> {
    const v = validarIdentidade(nome, email);
    const d = await this.detectar(false);
    if (d.itens.find((i) => i.id === "git")?.estado !== "ok") throw new ErroHttp(409, "Instale o Git primeiro.");
    const git = comandoGit(this.m);
    for (const [chave, valor] of [["user.name", v.nome], ["user.email", v.email]] as const) {
      const r = await this.m.exec(git, ["config", "--global", chave, valor], { timeoutMs: 10_000 });
      if (r.code !== 0) throw new ErroHttp(500, "Não deu para salvar no Git. Tente de novo.");
    }
    return this.emitirAgora(true);
  }

  async concluir(): Promise<SetupStatus> {
    const s = await this.status(true);
    if (!s.prontoParaUsar) throw new ErroHttp(409, "Ainda falta preparar alguma coisa.");
    gravarConcluido(new Date().toISOString(), this.deps.dataDir);
    return this.emitirAgora(false);
  }

  encerrar(): void {
    this.login.cancelar();
    this.loginGh.cancelar();
    matarFilhosDoSetup();
    if (this.timerEmitir) clearTimeout(this.timerEmitir);
  }
}

// ------------------------------------------------------------- singleton

export function modoDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["INHOUSE_SETUP_DEMO"] === "1";
}

let motor: MotorSetup | null = null;
let opcoes: Omit<DepsMotorReal, "emitir"> & { emitir?: (s: SetupStatus) => void } = {};

/** Liga o serviço ao resto do servidor (SSE, projetos, caches). */
export function configurarSetup(o: typeof opcoes): void {
  opcoes = { ...opcoes, ...o };
}

export function motorSetup(): MotorSetup {
  if (motor) return motor;
  const emitir = (s: SetupStatus) => opcoes.emitir?.(s);
  motor = modoDemo() ? new MotorDemo(emitir) : new MotorReal({ ...opcoes, emitir });
  return motor;
}

export function encerrarSetup(): void {
  motor?.encerrar();
}

/** Só para testes. */
export function _trocarMotor(m: MotorSetup | null): void {
  motor = m;
}

export { itemBase };
