/**
 * Traduz a falha do `git clone` (stderr) para uma frase pt-BR para quem não é
 * técnico. Antes, qualquer código diferente de 0 virava "confira o link e sua
 * conexão com a internet" — inclusive repositório privado sem login, o caso
 * mais comum. Agora só falamos em internet quando é rede de verdade.
 */
import type { TipoErroClone } from "../../shared/types.js";

export type { TipoErroClone };

export interface ErroCloneInfo {
  tipo: TipoErroClone;
  mensagem: string;
  /** Últimas linhas do git, para o time técnico. */
  detalhe: string;
}

export interface ContextoClone {
  /** O gh está logado (e a credencial dele foi passada ao git)? */
  ghLogado: boolean;
  /** Conta do GitHub logada no gh, se soubermos. */
  conta?: string;
  /** "dono/repo". */
  repo?: string;
  /** Nosso vigia matou o git por ficar parado. */
  parado?: boolean;
}

const RE_SEM_LOGIN =
  /could not read Username|could not read Password|terminal prompts disabled|Authentication failed|Invalid username or (password|token)|HTTP 401|returned error: 401|Bad credentials|Password authentication is not supported|gh auth login|not logged in/i;
const RE_SEM_ACESSO =
  /Repository not found|repository '.*' not found|HTTP 403|returned error: 403|error: 403|Permission to .* denied|Permission denied|not have permission|Write access to repository not granted|SAML|SSO/i;
const RE_TIMEOUT = /timed out|Timeout was reached|curl 28|Operation too slow/i;
const RE_REDE =
  /Could not resolve host|Could not resolve proxy|Failed to connect|Couldn't connect to server|Connection refused|Connection reset|Network is unreachable|No route to host|unable to access .*(SSL|TLS|schannel|certificate)|SSL certificate problem|schannel|gnutls_handshake|RPC failed|early EOF|the remote end hung up unexpectedly|unexpected disconnect|curl (6|7|35|52|55|56)\b|HTTP\/2 stream .* was not closed cleanly/i;
const RE_DISCO = /No space left on device|Disk quota exceeded|not enough space|espaço insuficiente/i;

function resumo(stderr: string): string {
  return stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Cloning into|Receiving objects|Resolving deltas|remote: (Counting|Compressing|Enumerating|Total))/.test(l))
    .slice(-3)
    .join(" · ")
    .slice(0, 400);
}

export function classificarErroClone(stderr: string, ctx: ContextoClone): ErroCloneInfo {
  const detalhe = resumo(stderr);
  const qual = ctx.repo ? `o repositório ${ctx.repo}` : "este repositório";
  const aoRepo = ctx.repo ? `ao repositório ${ctx.repo}` : "a este repositório";
  const conta = ctx.conta ? ` (${ctx.conta})` : "";

  if (RE_DISCO.test(stderr)) {
    return {
      tipo: "disco",
      detalhe,
      mensagem: "Falta espaço no disco deste computador para baixar o projeto. Libere espaço e tente de novo.",
    };
  }
  // Rede antes de login: "unable to access … Could not resolve host" não é falta de login.
  if (ctx.parado || RE_TIMEOUT.test(stderr)) {
    return {
      tipo: "timeout",
      detalhe,
      mensagem:
        "O download ficou parado por muito tempo e foi interrompido. Confira a sua internet (ou a VPN/rede da empresa) e tente de novo. Repositórios grandes podem levar vários minutos.",
    };
  }
  if (RE_REDE.test(stderr)) {
    return {
      tipo: "rede",
      detalhe,
      mensagem:
        "Não conseguimos falar com o GitHub. Confira a sua conexão com a internet (ou a VPN/rede da empresa) e tente de novo.",
    };
  }
  const pedeLogin = RE_SEM_LOGIN.test(stderr);
  const semAcesso = RE_SEM_ACESSO.test(stderr);
  if (pedeLogin || semAcesso) {
    if (!ctx.ghLogado) {
      // Sem login o GitHub responde igual para "privado" e "não existe".
      return {
        tipo: "sem_login",
        detalhe,
        mensagem: `Não conseguimos abrir ${qual}. Ele deve ser privado e o InHouse ainda não está conectado à sua conta do GitHub. Entre no GitHub pelo InHouse (Preparar o computador → Login no GitHub) e tente de novo. Se continuar, peça acesso ao repositório a quem cuida dele.`,
      };
    }
    if (pedeLogin && !semAcesso && /Authentication failed|401|Bad credentials|Invalid username/i.test(stderr)) {
      return {
        tipo: "sem_login",
        detalhe,
        mensagem:
          "O GitHub recusou o seu login (ele pode ter expirado). Entre no GitHub de novo pelo InHouse (Preparar o computador → Login no GitHub) e tente outra vez.",
      };
    }
    return {
      tipo: "sem_acesso",
      detalhe,
      mensagem: `Sua conta do GitHub${conta} não tem acesso ${aoRepo}, ou o link está errado. Confira o link e peça a quem cuida do repositório (o dono ou um administrador da organização) para dar acesso à sua conta. Depois tente de novo.`,
    };
  }
  return {
    tipo: "outro",
    detalhe,
    mensagem: `Não foi possível baixar o projeto do GitHub. Tente de novo; se repetir, fale com o time técnico.${detalhe ? ` (Detalhe: ${detalhe})` : ""}`,
  };
}

export class ErroClone extends Error {
  readonly tipo: TipoErroClone;
  readonly detalhe: string;
  constructor(info: ErroCloneInfo) {
    super(info.mensagem);
    this.tipo = info.tipo;
    this.detalhe = info.detalhe;
  }
}
