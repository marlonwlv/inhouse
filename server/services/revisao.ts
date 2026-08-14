/**
 * Sondagem da revisão do time: consulta o PR via `gh` enquanto a tarefa está
 * em Revisão/Publicar e traduz o que aconteceu (revisor entrou, pediu ajustes,
 * aprovou, mergeou, fechou) para a máquina noticiar no chat e mover a esteira.
 * Sem webhooks: o Inhouse é local — polling barato (1 tarefa por vez, ~60s).
 */
import type { Project, RevisaoPendencia, Task } from "../../shared/types.js";
import { run } from "./proc.js";

export interface EventoRevisao {
  /** Assinatura estável para dedupe entre sondagens (vai para revisao.vistos). */
  chave: string;
  /** Linha pt-BR para o chat. */
  texto: string;
}

export interface Sondagem {
  estado: "aguardando" | "em_revisao" | "mudancas_pedidas" | "aprovada";
  merged?: { por: string; em: string };
  fechadoSemMerge?: boolean;
  eventos: EventoRevisao[];
  pendencias: RevisaoPendencia[];
}

interface GhReview {
  author?: { login?: string };
  state?: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | ...
  submittedAt?: string;
  body?: string;
}

interface GhPrView {
  state?: string; // OPEN | MERGED | CLOSED
  mergedAt?: string | null;
  mergedBy?: { login?: string } | null;
  reviews?: GhReview[];
  closedAt?: string | null;
}

interface GhFileComment {
  path?: string;
  body?: string;
  user?: { login?: string };
  created_at?: string;
}

/** owner/repo/número a partir da URL do PR. */
function partesDoPr(prUrl: string): { owner: string; repo: string; numero: string } | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(prUrl);
  return m ? { owner: m[1]!, repo: m[2]!, numero: m[3]! } : null;
}

/**
 * Uma sondagem completa do PR da tarefa. Devolve null quando não dá para
 * sondar agora (gh fora do ar/deslogado) — a próxima tentativa resolve.
 */
export async function sondarRevisao(task: Task, project: Project): Promise<Sondagem | null> {
  if (!task.prUrl) return null;
  const partes = partesDoPr(task.prUrl);
  if (!partes) return null;

  let pr: GhPrView;
  try {
    const { stdout } = await run(
      "gh",
      ["pr", "view", task.prUrl, "--json", "state,mergedAt,mergedBy,reviews,closedAt"],
      { cwd: project.path },
    );
    pr = JSON.parse(stdout) as GhPrView;
  } catch {
    return null; // offline/deslogado: tenta de novo na próxima
  }

  const eventos: EventoRevisao[] = [];
  const reviews = pr.reviews ?? [];

  // Última palavra POR REVISOR decide o estado geral.
  const ultimaPorAutor = new Map<string, GhReview>();
  for (const r of reviews) {
    const autor = r.author?.login;
    if (!autor || !r.state) continue;
    const anterior = ultimaPorAutor.get(autor);
    if (!anterior || (r.submittedAt ?? "") >= (anterior.submittedAt ?? "")) {
      ultimaPorAutor.set(autor, r);
    }
    // Todo review vira um evento noticiável (dedupe pela chave lá na máquina).
    const chave = `review:${autor}:${r.submittedAt ?? ""}:${r.state}`;
    const texto =
      r.state === "APPROVED"
        ? `✔ ${autor} aprovou a revisão.`
        : r.state === "CHANGES_REQUESTED"
          ? `✋ ${autor} pediu ajustes${r.body ? `: "${r.body.slice(0, 200)}"` : "."}`
          : `👀 ${autor} comentou na revisão${r.body ? `: "${r.body.slice(0, 200)}"` : "."}`;
    eventos.push({ chave, texto });
  }

  const finais = [...ultimaPorAutor.values()];
  const estado: Sondagem["estado"] = finais.some((r) => r.state === "CHANGES_REQUESTED")
    ? "mudancas_pedidas"
    : finais.some((r) => r.state === "APPROVED")
      ? "aprovada"
      : finais.length > 0
        ? "em_revisao"
        : "aguardando";

  // Pendências: comentários de linha (arquivo + texto) + corpo dos "pediu
  // ajustes" — só o que chegou DEPOIS do último lote de ajustes enviado.
  const desde = task.revisao?.ajustadoEm ?? "";
  const pendencias: RevisaoPendencia[] = [];
  try {
    const { stdout } = await run(
      "gh",
      ["api", `repos/${partes.owner}/${partes.repo}/pulls/${partes.numero}/comments`, "--paginate"],
      { cwd: project.path },
    );
    for (const c of JSON.parse(stdout) as GhFileComment[]) {
      if (!c.body) continue;
      if (desde && (c.created_at ?? "") <= desde) continue;
      pendencias.push({ autor: c.user?.login ?? "revisor", arquivo: c.path, texto: c.body });
    }
  } catch {
    // sem comentários de linha acessíveis: segue só com os reviews
  }
  for (const r of finais) {
    if (r.state === "CHANGES_REQUESTED" && r.body && (!desde || (r.submittedAt ?? "") > desde)) {
      pendencias.push({ autor: r.author?.login ?? "revisor", texto: r.body });
    }
  }

  const merged =
    pr.state === "MERGED" || pr.mergedAt
      ? { por: pr.mergedBy?.login ?? "o time", em: pr.mergedAt ?? new Date().toISOString() }
      : undefined;
  const fechadoSemMerge = !merged && pr.state === "CLOSED";

  return { estado, merged, fechadoSemMerge, eventos, pendencias };
}
