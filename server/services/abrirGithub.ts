/**
 * "Abrir do GitHub" mágico: a pessoa cola o link e o InHouse faz, em ordem, o
 * que um dev faria no terminal — e mostra cada passo num checklist ao vivo:
 *
 *   1. GitHub CLI instalado (instala o portátil se faltar, sem senha);
 *   2. login no GitHub (por código, gh auth login --web);
 *   3. Git ligado à conta (o gh entrega a credencial; o clone usa só no
 *      comando e grava na config LOCAL do repo — a global não é tocada);
 *   4. acesso ao repositório (gh repo view);
 *   5. baixar (git clone).
 *
 * Repositório público pula 1–4 (um `git ls-remote` anônimo responde). Quando
 * algo falha, o job carrega a "ajuda": texto pronto para pedir acesso, trocar
 * de conta ou o passo a passo manual.
 *
 * As dependências são injetadas: as reais falam com o gh/git; as de
 * demonstração (INHOUSE_SETUP_DEMO=1) fingem todos os estados sem tocar em nada.
 */
import type { AjudaClone, CloneJob, LoginGhStatus, PassoClone, PassoCloneId, Project, TipoErroClone } from "../../shared/types.js";
import { broadcast } from "../events.js";
import { newId } from "../store.js";
import { classificarErroClone, ErroClone } from "./cloneErro.js";
import type { EstadoGh } from "./githubCred.js";
import type { AlvoClone } from "./projects.js";

export const TITULOS: Record<PassoCloneId, string> = {
  gh: "GitHub CLI instalado",
  login: "Entrar na sua conta do GitHub",
  git: "Ligar o Git à sua conta",
  acesso: "Conferir o acesso ao repositório",
  baixar: "Baixar o projeto",
};
const ORDEM: PassoCloneId[] = ["gh", "login", "git", "acesso", "baixar"];

export type ResultadoLogin = { ok: true; conta?: string } | { ok: false; mensagem: string };

export interface DepsAssistente {
  so: "windows" | "mac" | "linux";
  validar(url: string): AlvoClone;
  reservar(name: string, sim: boolean): void;
  estadoGh(): Promise<EstadoGh>;
  /** Instala o gh portátil (lança Error com a mensagem pt-BR se falhar). */
  instalarGh(aoProgresso: (mensagem: string, pct?: number) => void): Promise<void>;
  /** Abre o login por código e espera a pessoa terminar. */
  login(aoMudar: (l: LoginGhStatus) => void): Promise<ResultadoLogin>;
  credencialOk(gh: string): Promise<boolean>;
  verRepo(gh: string, repo: string): Promise<{ ok: boolean; stderr: string }>;
  /** `git ls-remote` sem credencial: ok = repositório público. */
  anonimo(url: string): Promise<{ ok: boolean; stderr: string }>;
  /** git clone; lança ErroClone. Na demonstração não cria projeto. */
  clonar(alvo: AlvoClone, aoProgresso: (mensagem: string, pct?: number) => void): Promise<Project | undefined>;
  /** Como a pessoa chama o gh no Terminal ("gh" ou o caminho do portátil). */
  comandoGh(gh: string | null): string;
  demo?: boolean;
}

// ------------------------------------------------------------- textos de ajuda

export function textoPedidoAcesso(repo: string, conta: string | undefined): string {
  const quem = conta ? conta : "(a sua conta do GitHub)";
  return [
    "Oi! Preciso de acesso ao repositório " + repo + " no GitHub para trabalhar nele pelo InHouse.",
    "Minha conta no GitHub é: " + quem,
    "Você pode me adicionar? No GitHub: abra o repositório → Settings → Collaborators (ou, se for de uma organização, People/Teams) → Add people → " + quem + ".",
    "Obrigado!",
  ].join("\n");
}

function abrirTerminal(so: DepsAssistente["so"]): string {
  if (so === "windows") return "Abra o PowerShell: clique no menu Iniciar, digite PowerShell e aperte Enter.";
  if (so === "mac") return "Abra o Terminal: aperte Cmd + Espaço, digite Terminal e aperte Enter.";
  return "Abra o Terminal.";
}

export function passosManuais(so: DepsAssistente["so"], gh: string, instalar = false): NonNullable<AjudaClone["manual"]> {
  return [
    ...(instalar ? [{ texto: "Baixe e instale o GitHub CLI pelo site oficial (botão Download): https://cli.github.com" }] : []),
    { texto: abrirTerminal(so) },
    {
      texto: "Cole este comando e aperte Enter. Ele mostra um código: abra a página que ele indicar, digite o código e autorize.",
      comando: `${gh} auth login --hostname github.com --git-protocol https --web`,
    },
    { texto: "Depois, ligue o Git à sua conta com este comando:", comando: `${gh} auth setup-git` },
    { texto: "Volte aqui e clique em Tentar de novo." },
  ];
}

// ------------------------------------------------------------- assistente

class Falha extends Error {
  constructor(
    readonly passo: PassoCloneId,
    readonly tipo: TipoErroClone,
    mensagem: string,
    readonly detalhe?: string,
    readonly ajuda?: AjudaClone,
  ) {
    super(mensagem);
  }
}

const JOB_TTL_MS = 30 * 60_000;

export class AssistenteClone {
  private jobs = new Map<string, CloneJob>();
  private rodando = new Set<string>();

  constructor(
    private readonly deps: () => DepsAssistente,
    private readonly emitir: (job: CloneJob) => void = (job) => broadcast({ type: "clone_status", job }),
  ) {}

  job(id: string): CloneJob | undefined {
    return this.jobs.get(id);
  }

  /** Valida o link na hora (erro → 400) e roda os passos em segundo plano. */
  iniciar(url: string): CloneJob {
    const d = this.deps();
    const alvo = d.validar(url);
    const job: CloneJob = {
      id: newId(),
      name: alvo.name,
      repo: alvo.repo,
      url: alvo.limpo,
      estado: "baixando",
      passos: ORDEM.map((id) => ({ id, titulo: TITULOS[id], estado: "pendente" })),
      ...(d.demo ? { demo: true } : {}),
    };
    this.jobs.set(job.id, job);
    this.disparar(job, alvo, d, false);
    return this.copia(job);
  }

  /** Tentar de novo (ou Entrar com outra conta) num job que falhou. */
  retomar(id: string, trocarConta = false): CloneJob {
    const job = this.jobs.get(id);
    if (!job || !job.url) throw new Error("Esse download não existe mais. Cole o link de novo.");
    if (this.rodando.has(id)) return this.copia(job);
    if (job.estado === "ok") return this.copia(job);
    const d = this.deps();
    const alvo = d.validar(job.url);
    job.estado = "baixando";
    delete job.erro;
    delete job.login;
    job.passos = ORDEM.map((p) => ({ id: p, titulo: TITULOS[p], estado: "pendente" }));
    this.disparar(job, alvo, d, trocarConta);
    return this.copia(job);
  }

  private copia(job: CloneJob): CloneJob {
    return JSON.parse(JSON.stringify(job)) as CloneJob;
  }

  private publicar(job: CloneJob): void {
    this.emitir(this.copia(job));
  }

  private passo(job: CloneJob, id: PassoCloneId, mudanca: Partial<PassoClone>): void {
    const p = job.passos?.find((x) => x.id === id);
    if (!p) return;
    Object.assign(p, mudanca);
    if (mudanca.estado && mudanca.estado !== "andando") delete p.pct;
    if (!("detalhe" in mudanca)) delete p.detalhe;
    this.publicar(job);
  }

  private disparar(job: CloneJob, alvo: AlvoClone, d: DepsAssistente, trocarConta: boolean): void {
    // Reserva o nome antes do primeiro await (segundo clique cai no 400).
    d.reservar(alvo.name, true);
    this.rodando.add(job.id);
    void this.rodar(job, alvo, d, trocarConta)
      .then((project) => {
        job.estado = "ok";
        if (project) job.project = project;
      })
      .catch((err: unknown) => {
        const f =
          err instanceof Falha
            ? err
            : new Falha("baixar", "outro", err instanceof Error && err.message ? err.message : "Não foi possível baixar o projeto.");
        this.passo(job, f.passo, { estado: "erro", detalhe: f.message });
        job.estado = "erro";
        delete job.login;
        job.erro = { tipo: f.tipo, mensagem: f.message, ...(f.detalhe ? { detalhe: f.detalhe } : {}), ...(f.ajuda ? { ajuda: f.ajuda } : {}) };
        console.error(`[clone] ${alvo.repo}: ${f.passo} falhou (${f.tipo})${f.detalhe ? `: ${f.detalhe}` : ""}`);
      })
      .finally(() => {
        d.reservar(alvo.name, false);
        this.rodando.delete(job.id);
        this.publicar(job);
        const id = job.id;
        setTimeout(() => {
          if (!this.rodando.has(id)) this.jobs.delete(id);
        }, JOB_TTL_MS).unref?.();
      });
  }

  private async rodar(job: CloneJob, alvo: AlvoClone, d: DepsAssistente, trocarConta: boolean): Promise<Project | undefined> {
    const repo = alvo.repo;
    const dono = repo.split("/")[0]!;
    let st = await d.estadoGh().catch((): EstadoGh => ({ gh: null, logado: false }));

    // Público? Sem login, um ls-remote anônimo decide se precisamos do GitHub CLI.
    if (!st.logado && !trocarConta) {
      this.passo(job, "acesso", { estado: "andando", detalhe: "Conferindo se o repositório é público…" });
      const a = await d.anonimo(alvo.limpo);
      if (a.ok) {
        for (const id of ["gh", "login", "git"] as const) this.passo(job, id, { estado: "pulado", detalhe: "Não precisa: o repositório é público." });
        this.passo(job, "acesso", { estado: "ok", detalhe: "Repositório público." });
        return this.baixar(job, alvo, d, st);
      }
      const info = classificarErroClone(a.stderr, { ghLogado: false, repo });
      if (info.tipo === "rede" || info.tipo === "timeout") throw new Falha("acesso", info.tipo, info.mensagem, info.detalhe);
      this.passo(job, "acesso", { estado: "pendente", detalhe: "Privado: precisa da sua conta do GitHub." });
    }

    // 1. GitHub CLI
    if (!st.gh) {
      this.passo(job, "gh", { estado: "andando", detalhe: "Instalando o GitHub CLI (uns 30 segundos)…" });
      try {
        await d.instalarGh((mensagem, pct) => this.passo(job, "gh", { estado: "andando", detalhe: mensagem, ...(pct !== undefined ? { pct } : {}) }));
      } catch (err) {
        const msg = err instanceof Error && err.message ? err.message : "Não deu para instalar o GitHub CLI.";
        throw new Falha("gh", "gh_falhou", `${msg} Você pode instalar e entrar na conta pelo Terminal, com o passo a passo abaixo.`, undefined, {
          repo,
          dono,
          manual: passosManuais(d.so, "gh", true),
        });
      }
      st = await d.estadoGh();
      if (!st.gh) {
        throw new Falha("gh", "gh_falhou", "O GitHub CLI foi instalado, mas o InHouse não o encontrou. Siga o passo a passo abaixo.", undefined, {
          repo,
          dono,
          manual: passosManuais(d.so, "gh", true),
        });
      }
    }
    const gh = st.gh;
    this.passo(job, "gh", { estado: "ok", detalhe: "Pronto." });

    // 2. Login
    if (!st.logado || trocarConta) {
      this.passo(job, "login", {
        estado: "aguardando",
        detalhe: trocarConta ? "Entre com a outra conta na página do GitHub." : "Falta entrar na sua conta. Siga o código abaixo.",
      });
      const r = await d.login((l) => {
        job.login = l;
        if (l.fase === "confirmando") this.passo(job, "login", { estado: "andando", detalhe: "Confirmando o login…" });
        else this.publicar(job);
      });
      delete job.login;
      if (!r.ok) {
        throw new Falha("login", "login_falhou", `${r.mensagem} Se preferir, entre pelo Terminal com o passo a passo abaixo.`, undefined, {
          repo,
          dono,
          manual: passosManuais(d.so, d.comandoGh(gh)),
        });
      }
      st = await d.estadoGh();
      if (!st.logado) {
        throw new Falha("login", "login_falhou", "O login não foi confirmado. Tente de novo ou use o passo a passo abaixo.", undefined, {
          repo,
          dono,
          manual: passosManuais(d.so, d.comandoGh(gh)),
        });
      }
    }
    this.passo(job, "login", { estado: "ok", detalhe: st.conta ? `Conta ${st.conta}` : "Conectado." });

    // 3. Git ligado à conta
    this.passo(job, "git", { estado: "andando", detalhe: "Conferindo…" });
    if (!(await d.credencialOk(gh))) {
      throw new Falha("git", "login_falhou", "O GitHub CLI não entregou a sua credencial ao Git. Entre de novo ou use o passo a passo abaixo.", undefined, {
        repo,
        dono,
        ...(st.conta ? { conta: st.conta } : {}),
        manual: passosManuais(d.so, d.comandoGh(gh)),
      });
    }
    this.passo(job, "git", { estado: "ok", detalhe: "O Git usa a sua conta neste projeto." });

    // 4. Acesso
    this.passo(job, "acesso", { estado: "andando", detalhe: `Conferindo se ${st.conta ?? "a sua conta"} enxerga ${repo}…` });
    const v = await d.verRepo(gh, repo);
    if (!v.ok) throw this.falhaAcesso(v.stderr, repo, dono, st.conta);
    this.passo(job, "acesso", { estado: "ok", detalhe: "Você tem acesso." });

    return this.baixar(job, alvo, d, st);
  }

  private falhaAcesso(stderr: string, repo: string, dono: string, conta: string | undefined): Falha {
    const info = classificarErroClone(stderr, { ghLogado: true, repo, ...(conta ? { conta } : {}) });
    if (info.tipo === "rede" || info.tipo === "timeout") return new Falha("acesso", info.tipo, info.mensagem, info.detalhe);
    const base = { repo, dono, ...(conta ? { conta } : {}), podeTrocarConta: true };
    if (/SAML|SSO/i.test(stderr)) {
      return new Falha(
        "acesso",
        "sem_acesso",
        `A organização ${dono} exige liberar o acesso por login único (SSO). Clique em Entrar com outra conta e, na página do GitHub, use Authorize ao lado de ${dono}. Se não aparecer, peça acesso com o texto abaixo.`,
        info.detalhe,
        { ...base, pedidoAcesso: textoPedidoAcesso(repo, conta) },
      );
    }
    return new Falha(
      "acesso",
      "sem_acesso",
      `A conta ${conta ?? "do GitHub"} não tem acesso a ${repo} (ou o link está errado). Peça acesso a quem cuida do repositório (o dono ou um administrador da organização ${dono}) com o texto abaixo. Se você tem outra conta com acesso, entre com ela.`,
      info.detalhe,
      { ...base, pedidoAcesso: textoPedidoAcesso(repo, conta) },
    );
  }

  private async baixar(job: CloneJob, alvo: AlvoClone, d: DepsAssistente, st: EstadoGh): Promise<Project | undefined> {
    this.passo(job, "baixar", { estado: "andando", detalhe: "Começando o download…" });
    try {
      const p = await d.clonar(alvo, (mensagem, pct) => this.passo(job, "baixar", { estado: "andando", detalhe: mensagem, ...(pct !== undefined ? { pct } : {}) }));
      this.passo(job, "baixar", { estado: "ok", detalhe: d.demo ? "Demonstração: aqui o projeto abriria." : "Projeto baixado." });
      return p;
    } catch (err) {
      if (err instanceof ErroClone) {
        const dono = alvo.repo.split("/")[0]!;
        const ajuda: AjudaClone | undefined =
          err.tipo === "sem_acesso"
            ? { repo: alvo.repo, dono, ...(st.conta ? { conta: st.conta } : {}), podeTrocarConta: true, pedidoAcesso: textoPedidoAcesso(alvo.repo, st.conta) }
            : err.tipo === "sem_login"
              ? { repo: alvo.repo, dono, manual: passosManuais(d.so, d.comandoGh(st.gh)) }
              : undefined;
        throw new Falha("baixar", err.tipo, err.message, err.detalhe, ajuda);
      }
      throw err;
    }
  }
}
