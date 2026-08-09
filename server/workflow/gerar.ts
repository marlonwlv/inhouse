/**
 * Geração/refino de workflow por IA. Recebe uma instrução em linguagem natural
 * (+ opcionalmente o workflow atual, para refinar em ciclos) e devolve uma
 * PROPOSTA de config de skills — SEMPRE validada contra o catálogo instalado, de
 * modo que a IA nunca produz uma skill inexistente. Não salva nada: a UI mostra a
 * proposta para a pessoa revisar/ajustar/aplicar. Roda como fase sem transcript,
 * sem ferramentas (raciocínio puro), no padrão do juiz do eval.
 */
import type { SkillCatalogItem, WorkflowDef } from "../../shared/types.js";
import { runPhase } from "../claude/runner.js";
import { DATA_DIR } from "../config.js";
import { sanitizeSkillsBlock } from "./config.js";
import { skillCatalog } from "./library.js";

export interface PropostaWorkflow {
  name: string;
  descricao?: string;
  skills: WorkflowDef["skills"];
}

const FASES = ["plano_produto", "detalhamento", "verificacoes"] as const;

function promptGerar(instrucao: string, atual: PropostaWorkflow | undefined, cat: SkillCatalogItem[]): string {
  const disponiveis = cat
    .filter((c) => c.instalada)
    .map((c) => `- ${c.skill} (fase ${c.fase}): ${c.rotulo}`)
    .join("\n");
  const linhas = [
    "Você configura WORKFLOWS da esteira do Inhouse para uma pessoa NÃO técnica.",
    "Um workflow só escolhe quais REVIEWS/CHECKS (skills) rodam em 3 fases. As etapas e as",
    "porteiras humanas (aprovação do plano, seu teste, publicar) são FIXAS — você NÃO mexe nelas,",
    "só nas skills. Fases:",
    "- plano_produto: reviews de produto (antes de montar o plano)",
    "- detalhamento: reviews técnicos e de design",
    "- verificacoes: checks automáticos antes do teste da pessoa",
    "",
    "Skills DISPONÍVEIS (use SOMENTE estas, pelo nome exato):",
    disponiveis || "(nenhuma skill instalada)",
    "",
    atual ? `Workflow atual (ajuste-o conforme o pedido):\n${JSON.stringify({ name: atual.name, skills: atual.skills })}` : "",
    `Pedido da pessoa: "${instrucao}"`,
    "",
    "Devolva SOMENTE um bloco ```json (nada de texto fora dele), neste formato:",
    '{"name":"nome curto","descricao":"uma linha em português simples","skills":{"plano_produto":[{"skill":"..."}],"detalhamento":[{"skill":"..."}],"verificacoes":[{"skill":"..."}]}}',
    "Regras: use só skills da lista acima; qualquer fase pode ficar vazia []; escolha um nome e uma",
    "descrição que reflitam o pedido; não invente skills nem etapas.",
  ];
  return linhas.filter(Boolean).join("\n");
}

/** Extrai o JSON da resposta (bloco ```json ou primeiro objeto) e valida. */
function parseProposta(texto: string, cat: SkillCatalogItem[]): PropostaWorkflow | null {
  const bloco = /```json\s*([\s\S]*?)```/i.exec(texto)?.[1] ?? /(\{[\s\S]*\})/.exec(texto)?.[1];
  if (!bloco) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(bloco.trim());
  } catch {
    return null;
  }
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim().slice(0, 60) : "Workflow";
  const descricao = typeof obj.descricao === "string" ? obj.descricao.trim().slice(0, 200) : undefined;
  // Sanitiza + FILTRA para o catálogo: skill fora da lista instalada é descartada.
  const validos = new Set(cat.filter((c) => c.instalada).map((c) => c.skill));
  const skills = sanitizeSkillsBlock(obj.skills);
  for (const fase of FASES) {
    const bloco2 = skills[fase];
    if (Array.isArray(bloco2)) {
      const filtrado = bloco2.filter((s) => validos.has(s.skill)).map((s) => ({ skill: s.skill }));
      if (filtrado.length) skills[fase] = filtrado;
      else delete skills[fase];
    } else if (bloco2) {
      // formato por-porte: achata e filtra (a IA raramente usa, mas por segurança)
      delete skills[fase];
    }
  }
  return { name, ...(descricao ? { descricao } : {}), skills };
}

export interface GerarResultado {
  proposta?: PropostaWorkflow;
  erro?: string;
}

export async function gerarWorkflow(instrucao: string, atual?: PropostaWorkflow): Promise<GerarResultado> {
  const texto = instrucao.trim();
  if (!texto) return { erro: "Diga o que você quer no workflow." };
  const cat = skillCatalog();
  const ts = new Date().toISOString();
  const r = await runPhase({
    taskId: `wf-gerar-${ts.replace(/[:.]/g, "-")}`,
    semTranscript: true,
    cwd: DATA_DIR,
    prompt: promptGerar(texto, atual, cat),
    permissionMode: "default",
    maxTurns: 2,
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch", "TodoWrite"],
  });
  if (!r.success) return { erro: r.errorMessage ?? "A IA não conseguiu montar o workflow agora. Tente de novo." };
  const proposta = parseProposta(r.finalText, cat);
  if (!proposta) return { erro: "A IA não devolveu um workflow no formato esperado. Tente reformular o pedido." };
  return { proposta };
}
