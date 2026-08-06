/**
 * Prompts (em português) de cada fase da esteira.
 * A máquina de estados (machine.ts) escolhe qual usar e com quais opções do runner.
 */
import type { GateResult, Porte, SkillStepConfig, Task } from "../../shared/types.js";

// ---------- Skills configuradas (inhouse.config.json) ----------

/** Substitui os placeholders suportados nos args de uma skill. */
function fillVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(descricao|spec|plano|previewUrl)\}/g, (_, k: string) => vars[k] ?? "");
}

/** Prompt que invoca uma skill (`/skill args`) numa fase de PLANEJAMENTO. */
export function skillPlanoPrompt(step: SkillStepConfig, task: Task): string {
  const vars = {
    descricao: task.description,
    spec: task.spec ?? task.description,
    plano: task.plan ?? "",
    previewUrl: "",
  };
  const args = step.args ? ` ${fillVars(step.args, vars)}` : "";
  return `/${step.skill}${args}`;
}

/** Após a cadeia de skills de plano: consolidar tudo num plano final aprovável. */
export function consolidarPlanoPrompt(): string {
  return [
    "Com base em tudo que foi levantado e revisado acima nesta sessão, escreva o PLANO",
    "FINAL de implementação: passos numerados, arquivos afetados em cada passo, e uma",
    "seção curta 'O que os reviews mudaram no plano'. Não implemente nada ainda.",
    "Escreva para uma pessoa não-técnica aprovar: português simples, sem jargão.",
    "",
    "Depois do plano, REAVALIE os julgamentos com base em tudo que você aprendeu e",
    "termine com duas linhas exatas: PORTE: simples|media|grande e UI: sim|nao.",
  ].join("\n");
}

const VEREDITO_INSTRUCAO = [
  "",
  "IMPORTANTE: ao terminar, a sua ÚLTIMA linha deve ser exatamente:",
  "VEREDITO: APROVADO",
  "ou",
  "VEREDITO: REPROVADO — <motivo curto>",
].join("\n");

/** Prompt que invoca uma skill como GATE de verificação (com veredito parseável). */
export function skillGatePrompt(step: SkillStepConfig, task: Task, previewUrl: string): string {
  const vars = {
    descricao: task.description,
    spec: task.spec ?? task.description,
    plano: task.plan ?? "",
    previewUrl,
  };
  const args = step.args ? ` ${fillVars(step.args, vars)}` : "";
  return `/${step.skill}${args}${VEREDITO_INSTRUCAO}`;
}

/** Interpreta o veredito no texto final da skill-gate. Sem veredito = aprova com nota. */
export function parseVeredito(finalText: string): { ok: boolean; motivo?: string } {
  const m = /VEREDITO:\s*(APROVADO|REPROVADO)\s*(?:—|-)?\s*(.*)/i.exec(finalText);
  if (!m) return { ok: true, motivo: "sem veredito explícito" };
  return { ok: m[1]!.toUpperCase() === "APROVADO", motivo: m[2]?.trim() || undefined };
}

/** Fase espec: estruturar o pedido em spec curta, sem tocar em nada. */
/**
 * Instrução transversal: quem usa o Inhouse não é técnico. O agente NUNCA deve
 * devolver dúvidas de estrutura de código para o usuário — deve descobrir sozinho.
 * (Atrito real do eval: "Esse repo é o monorepo ou é o outro-repo?".)
 */
export const CONTEXTO_NAO_TECNICO = [
  "IMPORTANTE: quem lê e responde é uma pessoa NÃO técnica.",
  "Nunca devolva dúvidas de estrutura/organização de código (ex.: 'é monorepo?', 'qual pasta?',",
  "'qual framework?') — descubra lendo o código do projeto e decida sozinho.",
  "Se algo for genuinamente ambíguo, escolha a opção mais provável, siga em frente e",
  "declare a sua suposição em uma linha simples — não pare para perguntar coisa técnica.",
].join("\n");

export function especPrompt(task: Task): string {
  return [
    "Você é o assistente de desenvolvimento do Inhouse, trabalhando em um app desta organização.",
    CONTEXTO_NAO_TECNICO,
    "Sua única tarefa agora é estruturar o pedido do usuário em uma especificação curta.",
    "NÃO edite arquivos e NÃO rode comandos — no máximo, leia o código para entender o contexto.",
    "",
    `Pedido do usuário (título: "${task.title}"):`,
    task.description,
    "",
    "Responda SOMENTE com a especificação em markdown, com exatamente estas seções:",
    "## Objetivo",
    "## O que muda",
    "## Fora do escopo",
    "## Critérios de aceite",
    "",
    "Seja curto e direto: quem vai ler é uma pessoa não-técnica.",
    "",
    "Depois da especificação, faça DOIS julgamentos independentes e termine com DUAS linhas exatas:",
    "PORTE: simples | media | grande",
    "UI: sim | nao",
    "Rubrica do PORTE: simples = mudança pequena e óbvia (1–3 arquivos, sem decisão de produto,",
    "arquitetura ou dados novos — ex.: criar uma página em branco, trocar um texto).",
    "grande = feature nova com decisões de produto/UX/dados ou que atravessa módulos.",
    "media = todo o resto. Na dúvida entre dois, escolha o menor.",
    "Rubrica do UI: sim = ESTA tarefa cria/altera telas, componentes visuais ou jornada",
    "de usuário. nao = só backend/dados/config, mesmo que o projeto tenha frontend.",
  ].join("\n");
}

/** Fase plano: explorar o código e montar plano enxuto (roda em permissionMode "plan"). */
export function planoPrompt(task: Task): string {
  const spec = task.spec ?? task.description;
  return [
    "Com base na especificação abaixo, explore o código do projeto e monte um plano de",
    "implementação enxuto: passos numerados, citando em cada passo os arquivos afetados.",
    "Não implemente nada ainda — apenas planeje.",
    "",
    "Especificação:",
    spec,
  ].join("\n");
}

/** Fase execução: plano aprovado, mão na massa. */
export function execucaoPrompt(task: Task): string {
  const plano = task.plan ? ["", "Plano aprovado:", task.plan] : [];
  return [
    "O usuário aprovou o plano. Execute-o agora, passo a passo, no código deste projeto.",
    CONTEXTO_NAO_TECNICO,
    "Siga o plano; se algo imprevisto exigir um desvio pequeno, faça e explique.",
    "Ao final, explique em português simples, para uma pessoa não-técnica, o que foi feito.",
    ...plano,
  ].join("\n");
}

/** Correção de gates: só consertar o que as verificações apontaram. */
export function fixGatesPrompt(_task: Task, gates: GateResult[]): string {
  const blocos = gates
    .filter((g) => !g.ok)
    .map((g) => `### ${g.name} (comando: ${g.command})\n${g.output ?? "(sem saída registrada)"}`)
    .join("\n\n");
  return [
    "As verificações automáticas do projeto falharam. Corrija os problemas apontados abaixo.",
    "NÃO mude mais nada além do necessário para as verificações passarem.",
    "",
    blocos,
  ].join("\n");
}

/** Feedback humano pedindo mudanças (usado tanto na aprovação do plano quanto no teste). */
export function changesPrompt(msg: string): string {
  return [
    "O usuário revisou e pediu as seguintes mudanças:",
    "",
    msg,
    "",
    "Faça os ajustes de acordo com o pedido, sem desfazer o restante do trabalho.",
    "Ao final, explique em português simples o que mudou.",
  ].join("\n");
}

/** Lê a linha "PORTE: …" da espec. Sem linha válida → "media" (meio-termo seguro). */
export function parsePorte(text: string): Porte {
  const m = /PORTE:\s*(simples|media|média|grande)/i.exec(text);
  if (!m) return "media";
  const v = m[1]!.toLowerCase();
  return v === "média" ? "media" : (v as Porte);
}

/** Lê a linha "UI: sim|nao". Ausente → undefined (cai na heurística do projeto). */
export function parseUi(text: string): boolean | undefined {
  const m = /(?:^|\n)\s*UI:\s*(sim|s[ií]|nao|n[aã]o)\b/i.exec(text);
  if (!m) return undefined;
  return /^s/i.test(m[1]!);
}

/** Remove as linhas de julgamento (PORTE:/UI:) do fim do plano exibido ao usuário. */
export function limparJulgamento(plano: string): string {
  return plano.replace(/\n\s*(PORTE|UI):[^\n]*$/gim, "").trim();
}

/** Feedback humano na aprovação do plano: re-planejar E re-julgar. */
export function planoFeedbackPrompt(msg: string): string {
  return [
    "O usuário revisou o plano e pediu mudanças:",
    "",
    msg,
    "",
    "Ajuste o plano de acordo (sem perder o que já estava bom) e reapresente-o completo.",
    "Ao final, REAVALIE e termine com duas linhas exatas:",
    "PORTE: simples|media|grande",
    "UI: sim|nao",
  ].join("\n");
}
