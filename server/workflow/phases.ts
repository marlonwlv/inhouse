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
    "termine com três linhas exatas: PORTE: simples|media|grande, UI: sim|nao e DESIGN: sim|nao.",
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
 * (Atrito real do eval: "Esse repo é o monorepo ou é o outro?".)
 */
export const CONTEXTO_NAO_TECNICO = [
  "IMPORTANTE: quem lê e responde é uma pessoa NÃO técnica.",
  "Nunca devolva dúvidas de estrutura/organização de código (ex.: 'é monorepo?', 'qual pasta?',",
  "'qual framework?') — descubra lendo o código do projeto e decida sozinho.",
  "Se algo for genuinamente ambíguo, escolha a opção mais provável, siga em frente e",
  "declare a sua suposição em uma linha simples — não pare para perguntar coisa técnica.",
].join("\n");

/**
 * Fonte única da verdade do preview: quem sobe o dev server é o Inhouse, numa
 * porta própria. O agente rodar o servidor trava a execução (processo que não
 * termina) e cria uma segunda porta que confunde o usuário.
 */
export const PREVIEW_GERENCIADO = [
  "IMPORTANTE: NÃO rode o servidor de desenvolvimento (npm run dev, pnpm dev, next dev,",
  "vite, astro dev, etc.) nem deixe qualquer processo servindo. Quem gerencia o preview",
  "é o Inhouse, numa porta própria — é a ÚNICA fonte da verdade. Rodar o servidor você",
  "mesmo trava a sua execução e abre uma segunda porta que confunde a pessoa. Se quiser",
  "conferir o resultado visual, é o botão de preview do Inhouse que faz isso.",
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
    "Depois da especificação, faça TRÊS julgamentos independentes e termine com TRÊS linhas exatas:",
    "PORTE: simples | media | grande",
    "UI: sim | nao",
    "DESIGN: sim | nao",
    "Rubrica do PORTE: simples = mudança pequena e óbvia (1–3 arquivos, sem decisão de produto,",
    "arquitetura ou dados novos — ex.: criar uma página em branco, trocar um texto).",
    "grande = feature nova com decisões de produto/UX/dados ou que atravessa módulos.",
    "media = todo o resto. Na dúvida entre dois, escolha o menor.",
    "Rubrica do UI: sim = ESTA tarefa cria/altera telas, componentes visuais ou jornada",
    "de usuário. nao = só backend/dados/config, mesmo que o projeto tenha frontend.",
    "Rubrica do DESIGN: sim = cria uma JORNADA NOVA de usuário ou tela nova que pede um olhar",
    "visual (protótipo) antes de implementar. nao = CRUD, ajuste, ou reuso de telas/componentes",
    "que já existem — mesmo que mexa em UI. Só marque sim quando um protótipo agrega de verdade.",
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

/** Fase de preparação do repositório: audita e deixa o projeto pronto para uso. */
export function preparacaoPrompt(): string {
  return [
    "Você é o assistente do Inhouse. Sua tarefa agora é PREPARAR este projeto para que uma",
    "pessoa não-técnica consiga rodá-lo e criar tarefas. Trabalhe na pasta principal do projeto.",
    CONTEXTO_NAO_TECNICO,
    "Faça, nesta ordem:",
    "1. AUDITE o projeto: gerenciador de pacotes (pelo lockfile), engines/.tool-versions,",
    "   docker-compose, arquivos .env de exemplo, scripts de setup no package.json/README,",
    "   serviços/banco necessários.",
    "2. INSTALE o que é do PROJETO: dependências (com o gerenciador certo pelo lockfile);",
    "   copie .env.example/.env.sample para .env/.env.local (NÃO invente segredos — deixe os",
    "   placeholders e avise a pessoa o que ela precisa preencher); rode o script de setup",
    "   documentado, se houver.",
    "3. O que for do SISTEMA e você NÃO pode instalar sozinho (Docker, um runtime específico,",
    "   um banco): NÃO tente instalar com sudo. Explique em português simples o que a pessoa",
    "   precisa instalar, com o link oficial.",
    "4. VERIFIQUE se o projeto sobe (dev server/build). NÃO deixe nada rodando travado — só",
    "   confirme que inicia e encerre.",
    "",
    "Ao final, escreva um resumo curto em português: o que ficou pronto e o que a pessoa ainda",
    "precisa fazer (se algo). Sua ÚLTIMA linha deve ser exatamente 'PREPARADO: sim' se o projeto",
    "já dá para usar, ou 'PREPARADO: nao' se ainda falta algo essencial (ex.: Docker não instalado).",
  ].join("\n");
}

/** Lê 'PREPARADO: sim|nao' do fim do resumo. Ausente → false (conservador). */
export function parsePreparado(text: string): boolean {
  const m = /PREPARADO:\s*(sim|s[ií]m?|nao|n[aã]o)\b/i.exec(text);
  return m ? /^s/i.test(m[1]!) : false;
}

/** Fase execução: plano aprovado, mão na massa. */
export function execucaoPrompt(task: Task): string {
  const plano = task.plan ? ["", "Plano aprovado:", task.plan] : [];
  return [
    "O usuário aprovou o plano. Execute-o agora, passo a passo, no código deste projeto.",
    CONTEXTO_NAO_TECNICO,
    PREVIEW_GERENCIADO,
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
    PREVIEW_GERENCIADO,
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
    PREVIEW_GERENCIADO,
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

/** Lê a linha "DESIGN: sim|nao" (feature de jornada nova que pede protótipo). */
export function parsePrecisaDesign(text: string): boolean | undefined {
  const m = /(?:^|\n)\s*DESIGN:\s*(sim|s[ií]|nao|n[aã]o)\b/i.exec(text);
  if (!m) return undefined;
  return /^s/i.test(m[1]!);
}

/** Após a fase de produto (office-hours): consolida um PLANO DE PRODUTO aprovável. */
export function consolidarProdutoPrompt(): string {
  return [
    "Com base no que foi levantado acima nesta sessão, escreva o PLANO DE PRODUTO: o que muda",
    "para o usuário e por quê, em linguagem de produto e português simples, para uma pessoa",
    "NÃO-técnica aprovar. Ainda NÃO entre nos detalhes técnicos (isso vem na próxima etapa).",
    "Passos numerados curtos, focados no comportamento/resultado, não no código.",
    "",
    "Ao final, REAVALIE e termine com TRÊS linhas exatas:",
    "PORTE: simples|media|grande",
    "UI: sim|nao",
    "DESIGN: sim|nao",
  ].join("\n");
}

/** Fase protótipo: gera mockups HTML/CSS versionados em docs/plans/mockups/<slug>/. */
export function prototipoPrompt(slug: string): string {
  const dir = `docs/plans/mockups/${slug}`;
  return [
    "Agora faça um PROTÓTIPO VISUAL da(s) tela(s) desta tarefa, para a pessoa aprovar o visual",
    "ANTES de implementar de verdade. Regra de ouro: rápido e descartável — NÃO é o código final.",
    `Crie arquivos HTML+CSS estáticos em \`${dir}/\` (comece por \`${dir}/index.html\`).`,
    "Use HTML/CSS puro (pode ser CSS inline), sem depender de build ou servidor — tem que abrir",
    "direto no navegador. Represente o layout, os textos reais e o fluxo principal. Se houver mais",
    "de uma tela, crie mais arquivos e ligue-os com links. NÃO altere o resto do projeto.",
    "Ao final, explique em uma linha o que a pessoa vai ver e qual arquivo abrir primeiro.",
  ].join("\n");
}

/** Remove as linhas de julgamento (PORTE:/UI:) do fim do plano exibido ao usuário. */
export function limparJulgamento(plano: string): string {
  return plano.replace(/\n\s*(PORTE|UI|DESIGN):[^\n]*$/gim, "").trim();
}

/** Feedback humano na aprovação do plano: re-planejar E re-julgar. */
export function planoFeedbackPrompt(msg: string): string {
  return [
    "O usuário revisou o plano e pediu mudanças:",
    "",
    msg,
    "",
    "Ajuste o plano de acordo (sem perder o que já estava bom) e reapresente-o completo.",
    "Ao final, REAVALIE e termine com três linhas exatas:",
    "PORTE: simples|media|grande",
    "UI: sim|nao",
    "DESIGN: sim|nao",
  ].join("\n");
}
