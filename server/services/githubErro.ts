/**
 * Traduz falhas do git/gh ao falar com o GitHub (push, PR, sondagem) para uma
 * frase pt-BR que diz O QUE FALTA — em vez de engolir o motivo e deixar a
 * tarefa sem PR (sem "Ver no GitHub" e sem o acompanhamento da revisão).
 */
import { RunError } from "./proc.js";

export type TipoErroGitHub = "sem_gh" | "sem_login" | "sem_permissao" | "outro";

export interface ErroGitHub {
  tipo: TipoErroGitHub;
  /** Frase completa para o chat/erro da tarefa. */
  mensagem: string;
  /** Saída crua (curta) do git/gh, para o time técnico. */
  detalhe: string;
}

/** "dono/repo" a partir de uma URL do GitHub (https ou ssh); null se não for GitHub. */
export function repoDaUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function textoDoErro(err: unknown): string {
  if (err instanceof RunError) return `${err.stderr}\n${err.message}`.trim();
  if (err instanceof Error) return err.message;
  return String(err);
}

export function classificarErroGitHub(err: unknown, repo?: string | null): ErroGitHub {
  const texto = textoDoErro(err);
  const detalhe = texto.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" · ").slice(0, 400);
  const alvo = repo ? `no repositório ${repo}` : "no repositório do projeto";

  // Só o gh ausente: `spawn git ENOENT` (ou pasta de trabalho sumida) não é isso.
  if (/spawn gh(\.exe)? ENOENT|gh: command not found|'gh' não é reconhecido|'gh' is not recognized/i.test(texto)) {
    return {
      tipo: "sem_gh",
      detalhe,
      mensagem:
        "O GitHub CLI (gh) não está instalado neste computador, então o InHouse não consegue abrir nem acompanhar o Pull Request. Instale pela tela de preparo do InHouse (Preparar o computador) e faça o login do GitHub; depois tente de novo.",
    };
  }
  if (/rate limit/i.test(texto)) {
    return {
      tipo: "outro",
      detalhe,
      mensagem: "O GitHub limitou os pedidos por alguns minutos. Espere um pouco e tente de novo.",
    };
  }
  if (
    /Permission to .* denied|denied to |HTTP 403|error: 403|Write access to repository not granted|must have (push|write) access|not have permission|Resource not accessible|must be a collaborator/i.test(
      texto,
    )
  ) {
    return {
      tipo: "sem_permissao",
      detalhe,
      mensagem: `Sua conta do GitHub não tem permissão de escrita ${alvo}. Peça ao dono do repositório para te adicionar como colaborador com acesso de escrita (Write) e tente de novo.`,
    };
  }
  if (
    /gh auth login|not logged in|Permission denied \(publickey\)|Could not read from remote repository|authentication required|Authentication failed|could not read Username|terminal prompts disabled|HTTP 401|Bad credentials|invalid credentials/i.test(
      texto,
    )
  ) {
    return {
      tipo: "sem_login",
      detalhe,
      mensagem:
        "O InHouse não está conectado à sua conta do GitHub neste computador. Faça o login do GitHub (tela de preparo do InHouse ou `gh auth login` no Terminal) e tente de novo.",
    };
  }
  return {
    tipo: "outro",
    detalhe,
    mensagem: `O GitHub recusou o pedido: ${detalhe || "erro sem detalhe"}. Tente de novo em instantes; se repetir, fale com o time técnico.`,
  };
}
