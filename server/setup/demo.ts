/**
 * Modo demonstração da preparação (INHOUSE_SETUP_DEMO=1): o checklist vem de
 * cenários simulados, nos dois SOs, e instalar/login são fingidos com
 * progresso de verdade pelo SSE. NADA é executado nem gravado no sistema.
 */
import type { SetupEstado, SetupItem, SetupItemId, SetupSO, SetupStatus } from "../../shared/types.js";
import { itemBase, itensDoSO, prontoParaUsar } from "./detectar.js";
import { ErroHttp, validarCodigo, validarIdentidade } from "./comum.js";
import type { MotorSetup } from "./comum.js";

export const CENARIOS = [
  { id: "falta-tudo", rotulo: "Computador novo (falta tudo)" },
  { id: "falta-node", rotulo: "Sem Node.js" },
  { id: "instalando", rotulo: "Instalando" },
  { id: "erro", rotulo: "Erro ao instalar o Git" },
  { id: "login", rotulo: "Falta o login do Claude" },
  { id: "codigo-invalido", rotulo: "Código do login não aceito" },
  { id: "identidade", rotulo: "Falta o nome no Git" },
  { id: "outra-janela", rotulo: "Outra janela instalando" },
  { id: "tudo-pronto", rotulo: "Tudo pronto" },
] as const;

export type CenarioId = (typeof CENARIOS)[number]["id"];

export function cenarioValido(c: unknown): c is CenarioId {
  return CENARIOS.some((x) => x.id === c);
}

const VERSOES: Partial<Record<SetupItemId, string>> = { node: "24.11.0", git: "2.51.0", gitbash: "", claude: "2.1.296", gh: "2.82.1" };

function ok(id: SetupItemId, ident: { nome?: string; email?: string }): SetupItem {
  if (id === "claude_login") return itemBase(id, { estado: "ok", detalhe: "Claude conectado · sua assinatura" });
  if (id === "git_identidade") return itemBase(id, { estado: "ok", detalhe: `${ident.nome ?? "Ana Souza"} · ${ident.email ?? "ana@exemplo.com"}` });
  if (id === "gh_login") return itemBase(id, { estado: "ok", detalhe: "GitHub conectado" });
  const v = VERSOES[id];
  return itemBase(id, { estado: "ok", detalhe: v ? `Pronto · v${v}` : "Pronto" });
}

function faltando(id: SetupItemId): SetupItem {
  switch (id) {
    case "claude_login":
      return itemBase(id, { estado: "faltando", acao: "login", detalhe: "Falta entrar na sua conta do Claude." });
    case "git_identidade":
      return itemBase(id, { estado: "faltando", acao: "identidade", detalhe: "Falta dizer seu nome e e-mail." });
    case "gh":
      return itemBase(id, { estado: "faltando", acao: "instalar", detalhe: "Opcional · pule se não usa o GitHub." });
    case "gh_login":
      return itemBase(id, { estado: "faltando", acao: "manual", detalhe: "Opcional. Para conectar, rode gh auth login uma vez (o guia explica)." });
    default:
      return itemBase(id, { estado: "faltando", acao: "instalar", detalhe: "Ainda não instalado." });
  }
}

const LOG_ERRO = [
  "baixando https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/PortableGit-2.51.0-64-bit.7z.exe",
  "Baixando… 63%",
  "erro: a conexão caiu (ECONNRESET)",
];

export class MotorDemo implements MotorSetup {
  private so: SetupSO = "windows";
  private cenario: CenarioId = "falta-tudo";
  private itens = new Map<SetupItemId, SetupItem>();
  private ident: { nome?: string; email?: string } = {};
  private instalando = false;
  private ocupado = false;
  private login: SetupStatus["login"];
  private concluidoEm?: string;
  private falharGit = false;
  private timers = new Set<NodeJS.Timeout>();
  private ultimoStatus: SetupStatus | null = null;

  constructor(private readonly emitir: (s: SetupStatus) => void, private readonly passoMs = 350) {
    this.aplicar("falta-tudo", "windows");
  }

  private agendar(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private pararTudo(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  aplicar(cenario: CenarioId, so: SetupSO = this.so): SetupStatus {
    this.pararTudo();
    this.so = so;
    this.cenario = cenario;
    this.instalando = false;
    this.ocupado = false;
    this.login = undefined;
    this.concluidoEm = undefined;
    this.falharGit = false;
    this.ident = {};
    const ids = itensDoSO(so);
    const set = (falta: SetupItemId[]) => {
      this.itens.clear();
      for (const id of ids) this.itens.set(id, falta.includes(id) ? faltando(id) : ok(id, this.ident));
      // Igual à detecção real: login e identidade só têm ação depois de Claude/Git.
      if (falta.includes("claude")) this.itens.set("claude_login", itemBase("claude_login", { estado: "faltando", detalhe: "Instale o Claude Code primeiro." }));
      if (falta.includes("git")) this.itens.set("git_identidade", itemBase("git_identidade", { estado: "faltando", detalhe: "Instale o Git primeiro." }));
      if (falta.includes("gh")) this.itens.set("gh_login", itemBase("gh_login", { estado: "faltando", detalhe: "Instale o GitHub CLI primeiro." }));
    };
    const instaladores: SetupItemId[] = ["git", "gitbash", "claude"];
    switch (cenario) {
      case "falta-tudo":
        set([...instaladores, "claude_login", "git_identidade", "gh", "gh_login"]);
        break;
      case "falta-node":
        set(["node", ...instaladores, "claude_login", "git_identidade", "gh", "gh_login"]);
        break;
      case "instalando":
        set(["claude", "claude_login", "git_identidade", "gh", "gh_login"]);
        this.instalarSimulado(["claude"]);
        break;
      case "erro":
        set([...instaladores, "claude_login", "git_identidade", "gh", "gh_login"]);
        this.itens.set("git", itemBase("git", {
          estado: "erro",
          acao: "instalar",
          detalhe: "Não deu para instalar o Git. Verifique a internet e tente de novo.",
          log: LOG_ERRO,
        }));
        break;
      case "login":
        set(["claude_login", "gh", "gh_login"]);
        this.ident = { nome: "Ana Souza", email: "ana@exemplo.com" };
        this.itens.set("git_identidade", ok("git_identidade", this.ident));
        break;
      case "codigo-invalido":
        set(["claude_login", "gh", "gh_login"]);
        this.itens.set("claude_login", itemBase("claude_login", { estado: "erro", acao: "login", detalhe: "Código não aceito. Gere outro e cole de novo." }));
        this.login = { ativo: false, pedeCodigo: false, mensagem: "Código não aceito. Gere outro e cole de novo." };
        break;
      case "identidade":
        set(["git_identidade", "gh", "gh_login"]);
        break;
      case "outra-janela":
        set([...instaladores, "claude_login", "git_identidade", "gh", "gh_login"]);
        this.ocupado = true;
        break;
      case "tudo-pronto":
        set([]);
        break;
    }
    return this.publicar();
  }

  private montar(): SetupStatus {
    const itens = itensDoSO(this.so).map((id) => this.itens.get(id)!).filter(Boolean);
    const pronto = prontoParaUsar(itens);
    return {
      so: this.so,
      itens,
      prontoParaUsar: pronto,
      instalando: this.instalando,
      ...(this.ocupado ? { ocupadoPorOutro: true } : {}),
      ...(this.login ? { login: this.login } : {}),
      identidade: this.ident,
      ...(this.concluidoEm ? { concluidoEm: this.concluidoEm } : {}),
      mostrarAoAbrir: true,
      demo: { cenario: this.cenario, cenarios: CENARIOS.map((c) => ({ id: c.id, rotulo: c.rotulo })) },
      verificadoEm: new Date().toISOString(),
    };
  }

  private publicar(): SetupStatus {
    this.ultimoStatus = this.montar();
    this.emitir(this.ultimoStatus);
    return this.ultimoStatus;
  }

  private mudarItem(id: SetupItemId, estado: SetupEstado, resto: Partial<SetupItem> = {}): void {
    const atual = this.itens.get(id);
    if (!atual) return;
    this.itens.set(id, itemBase(id, { ...(estado === "ok" ? {} : { acao: atual.acao }), estado, ...resto }));
  }

  private instalarSimulado(ids: SetupItemId[]): void {
    this.instalando = true;
    const fila = [...ids];
    const proximo = () => {
      const id = fila.shift();
      if (!id) {
        this.instalando = false;
        if (this.itens.get("claude")?.estado === "ok" && this.itens.get("claude_login")?.estado === "faltando" && !this.itens.get("claude_login")?.acao) {
          this.itens.set("claude_login", faltando("claude_login"));
        }
        if (this.itens.get("git")?.estado === "ok" && this.itens.get("git_identidade")?.estado === "faltando" && !this.itens.get("git_identidade")?.acao) {
          this.itens.set("git_identidade", faltando("git_identidade"));
        }
        if (this.itens.get("gh")?.estado === "ok" && this.itens.get("gh_login")?.estado === "faltando" && !this.itens.get("gh_login")?.acao) {
          this.itens.set("gh_login", faltando("gh_login"));
        }
        this.publicar();
        return;
      }
      let pct = 0;
      const log: string[] = [`baixando o instalador de ${id} (demonstração: nada é instalado)`];
      const tique = () => {
        pct += 20;
        if (id === "git" && this.falharGit && pct >= 60) {
          this.falharGit = false;
          this.mudarItem("git", "erro", { detalhe: "Não deu para instalar o Git. Verifique a internet e tente de novo.", log: [...log, ...LOG_ERRO.slice(1)] });
          if (this.so === "windows" && ids.includes("gitbash")) this.mudarItem("gitbash", "faltando", { detalhe: "Ainda não instalado." });
          this.instalando = false;
          fila.length = 0;
          this.publicar();
          return;
        }
        if (pct >= 100) {
          this.itens.set(id, ok(id, this.ident));
          this.publicar();
          this.agendar(this.passoMs, proximo);
          return;
        }
        log.push(`Baixando… ${pct}%`);
        this.mudarItem(id, "instalando", { progresso: { mensagem: pct < 60 ? `Baixando… ${pct}%` : "Instalando…", pct }, log: [...log] });
        this.publicar();
        this.agendar(this.passoMs * 2, tique);
      };
      this.mudarItem(id, "instalando", { progresso: { mensagem: "Começando…", pct: 0 }, log });
      this.publicar();
      this.agendar(this.passoMs, tique);
    };
    proximo();
  }

  async status(): Promise<SetupStatus> {
    return this.montar();
  }

  async instalar(itens?: SetupItemId[]): Promise<SetupStatus> {
    if (this.ocupado) throw new ErroHttp(409, "Outra janela do InHouse está instalando. Espere ela terminar.");
    if (this.instalando) throw new ErroHttp(409, "Já estou instalando. Espere terminar.");
    if (this.login?.ativo) throw new ErroHttp(409, "Termine o login do Claude antes de instalar.");
    const alvo = itensDoSO(this.so).filter((id) => {
      const it = this.itens.get(id)!;
      if (itens) return itens.includes(id) && it.estado !== "ok" && it.acao === "instalar";
      return it.obrigatorio && (it.estado === "faltando" || it.estado === "erro") && it.acao === "instalar";
    });
    this.instalarSimulado(alvo);
    return this.montar();
  }

  async iniciarLogin(): Promise<SetupStatus> {
    if (this.itens.get("claude")?.estado !== "ok") throw new ErroHttp(409, "Instale o Claude Code primeiro.");
    if (this.instalando) throw new ErroHttp(409, "Espere a instalação terminar para fazer o login.");
    this.mudarItem("claude_login", "faltando", { acao: "login", detalhe: "Falta entrar na sua conta do Claude." });
    this.login = { ativo: true, pedeCodigo: false, mensagem: "Preparando o login…" };
    this.publicar();
    this.agendar(this.passoMs * 2, () => {
      this.login = {
        ativo: true,
        url: "https://claude.ai/oauth/authorize?demo=1",
        pedeCodigo: true,
        mensagem: "Entre na sua conta e cole aqui o código que aparecer.",
      };
      this.publicar();
    });
    return this.montar();
  }

  async enviarCodigo(codigo: string): Promise<SetupStatus> {
    const c = validarCodigo(codigo);
    if (!this.login?.ativo) throw new ErroHttp(409, "O login não está aberto. Clique em Fazer login do Claude.");
    this.login = { ativo: true, pedeCodigo: false, mensagem: "Conferindo o código…" };
    this.publicar();
    this.agendar(this.passoMs * 3, () => {
      if (/errad|invalid|0000/i.test(c)) {
        this.login = { ativo: false, pedeCodigo: false, mensagem: "Código não aceito. Gere outro e cole de novo." };
        this.mudarItem("claude_login", "erro", { acao: "login", detalhe: "Código não aceito. Gere outro e cole de novo." });
      } else {
        this.login = undefined;
        this.itens.set("claude_login", ok("claude_login", this.ident));
      }
      this.publicar();
    });
    return this.montar();
  }

  async cancelarLogin(): Promise<SetupStatus> {
    this.login = undefined;
    return this.publicar();
  }

  async salvarIdentidade(nome: string, email: string): Promise<SetupStatus> {
    const v = validarIdentidade(nome, email);
    if (this.itens.get("git")?.estado !== "ok") throw new ErroHttp(409, "Instale o Git primeiro.");
    this.ident = v;
    this.itens.set("git_identidade", ok("git_identidade", v));
    return this.publicar();
  }

  async concluir(): Promise<SetupStatus> {
    const s = this.montar();
    if (!s.prontoParaUsar) throw new ErroHttp(409, "Ainda falta preparar alguma coisa.");
    this.concluidoEm = new Date().toISOString();
    return this.publicar();
  }

  ultimo(): SetupStatus | null {
    return this.ultimoStatus;
  }

  encerrar(): void {
    this.pararTudo();
  }
}
