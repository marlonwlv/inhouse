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

/**
 * Bloco com os arquivos que o usuário anexou. O Claude Code lê imagens e PDFs por
 * caminho absoluto com a ferramenta Read — então basta listar os caminhos e mandar ler.
 */
export function anexosBloco(task: Task): string {
  const anexos = task.anexos ?? [];
  if (anexos.length === 0) return "";
  return [
    "",
    "O usuário ANEXOU os arquivos abaixo como contexto. LEIA cada um com a ferramenta Read",
    "(ela abre imagens e PDFs, não só texto) ANTES de decidir — eles fazem parte do pedido:",
    ...anexos.map((a) => `- ${a.nome} (${a.tipo || "arquivo"}): ${a.path}`),
  ].join("\n");
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
 * termina) e cria uma segunda porta que confunde o usuário. v2: o agente tem
 * ferramentas próprias (MCP in-process) para enxergar e comandar o preview.
 */
export const PREVIEW_GERENCIADO = [
  "PREVIEW: quem sobe e gerencia o dev server é o Inhouse, numa porta única — NUNCA rode",
  "o servidor você mesmo (npm run dev, pnpm dev, next dev, vite, astro dev, etc.; será",
  "bloqueado). Você tem ferramentas próprias: preview_status (URL/porta/estado — use SEMPRE",
  "que precisar saber onde o app roda), preview_logs (registro do dev server, onde aparecem",
  "os erros de runtime), preview_reiniciar (após mudar .env/config que não recarrega sozinho)",
  "e preview_reportar_rota (marca uma tela importante para os health-checks futuros).",
  "Para conferir uma rota, use curl na URL que o preview_status devolver.",
].join("\n");

/**
 * Append do system prompt das fases "mão na massa" (as mesmas que recebem as
 * ferramentas MCP): identidade + regras invariantes + um bloco curto de ESTADO.
 * Fases de planejamento (espec/plano/protótipo) e fases sem tarefa (juiz/gerar)
 * não recebem — seguem idênticas.
 */
export function systemAppend(
  task: Task,
  preview?: { status: string; url?: string; porta?: number },
): string {
  const previewLinha = !preview
    ? "Preview: desconhecido — use preview_status."
    : preview.status === "no_ar" && preview.url
      ? `Preview: no ar em ${preview.url}${preview.porta ? ` (porta ${preview.porta})` : ""}.`
      : `Preview: ${preview.status.replace(/_/g, " ")}.`;
  // Título vai para o SYSTEM prompt: uma linha só e truncado — um título com
  // quebras de linha não pode "escrever" instruções com autoridade de sistema.
  const titulo = task.title.replace(/\s+/g, " ").slice(0, 120);
  return [
    "Você é o agente do Inhouse — um app builder local para pessoas NÃO-técnicas criarem e",
    "alterarem apps com segurança. Toda comunicação com a pessoa é em português simples.",
    CONTEXTO_NAO_TECNICO,
    PREVIEW_GERENCIADO,
    "",
    "[ESTADO]",
    `Tarefa: "${titulo}" · etapa: ${task.step} · modo: ${task.modo ?? "esteira"}`,
    previewLinha,
    "(estado no INÍCIO deste passo — para o estado atual, use preview_status)",
  ].join("\n");
}

export function especPrompt(task: Task): string {
  return [
    "Você é o assistente de desenvolvimento do Inhouse, trabalhando em um app desta organização.",
    CONTEXTO_NAO_TECNICO,
    "Sua única tarefa agora é estruturar o pedido do usuário em uma especificação curta.",
    "NÃO edite arquivos e NÃO rode comandos — no máximo, leia o código para entender o contexto.",
    "",
    `Pedido do usuário (título: "${task.title}"):`,
    task.description,
    anexosBloco(task),
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
    anexosBloco(task),
  ].join("\n");
}

/** Fase de preparação do repositório: audita e deixa o projeto pronto para uso. */
export function preparacaoPrompt(): string {
  return [
    "Você é o assistente do Inhouse. Sua tarefa agora é PREPARAR este projeto para que uma",
    "pessoa não-técnica consiga rodá-lo e criar tarefas. Trabalhe na pasta principal do projeto.",
    "Faça, nesta ordem:",
    "1. AUDITE o projeto — comece lendo o README.md e a documentação de setup: gerenciador de",
    "   pacotes (pelo lockfile), engines/.tool-versions, docker-compose, arquivos .env de exemplo,",
    "   scripts de setup no package.json/README, serviços/banco necessários.",
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

/** Fase execução: plano aprovado, mão na massa. (Identidade/regras vêm do systemAppend.) */
export function execucaoPrompt(task: Task): string {
  const plano = task.plan ? ["", "Plano aprovado:", task.plan] : [];
  return [
    "O usuário aprovou o plano. Execute-o agora, passo a passo, no código deste projeto.",
    "Siga o plano; se algo imprevisto exigir um desvio pequeno, faça e explique.",
    "Ao final, explique em português simples, para uma pessoa não-técnica, o que foi feito.",
    anexosBloco(task),
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
    "",
    "Quando terminar, a sua ÚLTIMA linha deve ser exatamente uma destas:",
    "CONSERTO: feito",
    "  → você corrigiu o que dava e acredita que as verificações agora passam. É o padrão:",
    "    na dúvida, tente consertar e devolva 'feito' — as verificações rodam de novo e confirmam.",
    "CONSERTO: impossivel — <motivo curto>",
    "  → só quando insistir NÃO vai adiantar sem a pessoa: o problema pede uma DECISÃO humana/de",
    "    produto, ou não dá para resolver apenas no código (ex.: um review pedindo mudança de",
    "    comportamento que o usuário precisa aprovar; um teste que exige um dado que você não tem).",
    "    Nesse caso, explique acima, em português simples, o que a pessoa precisa decidir.",
  ].join("\n");
}

/**
 * Lê o veredito da fase de correção de gates. Sem marcador = seguiu tentando
 * (não desistiu) — as verificações rodam de novo e confirmam.
 */
export function parseConserto(finalText: string): { desistiu: boolean; motivo?: string } {
  const m = /CONSERTO:\s*(feito|imposs[ií]vel|desisto|nao|n[aã]o)\s*(?:—|-)?\s*(.*)/i.exec(finalText);
  if (!m) return { desistiu: false };
  const desistiu = !/^feito/i.test(m[1]!);
  return { desistiu, motivo: desistiu ? m[2]?.trim() || undefined : undefined };
}

/**
 * Feedback humano pedindo mudanças (aprovação do plano e Seu teste). `ctx` traz
 * o estado do preview quando há um no ar — o agente confere a própria mudança
 * contra o app vivo em vez de adivinhar porta/erro (e vê os logs se quebrou).
 */
export function changesPrompt(
  msg: string,
  ctx?: { url?: string; status?: string; logsTail?: string },
): string {
  const preview: string[] = [];
  if (ctx?.url && ctx.status === "no_ar") {
    preview.push(
      `O preview segue NO AR em ${ctx.url} — confira a sua mudança com curl (ou preview_status) antes de devolver.`,
    );
  } else if (ctx?.status === "problema") {
    preview.push(
      "O preview está COM PROBLEMA. Diagnostique pelos logs abaixo (e preview_logs), corrija e use preview_reiniciar se mudar .env/config.",
    );
    if (ctx.logsTail) preview.push("", "Últimas linhas do registro do dev server:", "```", ctx.logsTail, "```");
  }
  return [
    "O usuário revisou e pediu as seguintes mudanças:",
    "",
    msg,
    "",
    "Faça os ajustes de acordo com o pedido, sem desfazer o restante do trabalho.",
    ...preview,
    "Ao final, explique em português simples o que mudou.",
  ].join("\n");
}

/**
 * Conserto automático do preview (crash/5xx/reporte do usuário): erro + logs
 * inline, diagnóstico e correção com verificação do PRÓPRIO conserto contra o
 * preview vivo. Termina com o mesmo contrato do fixGates (CONSERTO: …).
 */
export function consertoPreviewPrompt(
  causa: { origem: "crash" | "saude" | "usuario"; detalhe: string; rota?: string },
  logsTail: string,
): string {
  const origem =
    causa.origem === "crash"
      ? "O dev server do preview CAIU sozinho."
      : causa.origem === "saude"
        ? "Uma tela do preview está respondendo com erro de servidor."
        : "A pessoa reportou um problema no preview.";
  return [
    `${origem} Diagnostique e conserte agora.`,
    causa.rota ? `Tela/rota afetada: ${causa.rota}` : "",
    causa.detalhe ? `Detalhe: ${causa.detalhe}` : "",
    "",
    "Últimas linhas do registro do dev server:",
    "```",
    logsTail || "(sem registro capturado)",
    "```",
    "",
    "Como agir:",
    "1. Descubra a CAUSA pelo registro acima (use preview_logs para mais linhas se precisar).",
    "2. Corrija o que for de código/.env/config. NÃO mude nada além do necessário.",
    "3. Se mudou .env/config que o dev server não recarrega sozinho, use preview_reiniciar.",
    "4. VERIFIQUE o próprio conserto: confira com curl (na URL do preview_status) que a tela",
    "   afetada responde sem erro de servidor. Não devolva sem verificar.",
    "",
    "Quando terminar, a sua ÚLTIMA linha deve ser exatamente uma destas:",
    "CONSERTO: feito",
    "CONSERTO: impossivel — <motivo curto em português simples>",
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

/**
 * Fase de preview — PREPARO (antes do teste do usuário): o agente deixa o AMBIENTE
 * do espaço pronto (env, docker, migrations) e descreve a receita — mas NÃO sobe o
 * servidor (quem sobe é o Inhouse). Roda em acceptEdits com o gate de setup seguro.
 */
export function previewSetupPrompt(): string {
  return [
    "Antes de a pessoa testar, prepare o AMBIENTE deste projeto para o preview subir de verdade.",
    "Antes de decidir, LEIA o README.md e os docs de setup do projeto (docs/, CONTRIBUTING,",
    ".env.example, scripts do package.json): é onde costuma estar como subir, migrar e popular o banco.",
    "Faça só o necessário para o app conseguir rodar e servir as telas:",
    "- Preencha as variáveis de ambiente que faltam NESTE espaço: use .env.example/.env.sample e a",
    "  documentação. Para segredos que você não tem, use um valor de desenvolvimento plausível e diga",
    "  no resumo. Crie/edite .env / .env.local conforme o projeto espera.",
    "- Suba dependências de runtime CURTAS e idempotentes que o app precisa (ex.: `docker compose up -d`,",
    "  migrations/seed do banco). Não reinstale o que já está instalado.",
    "- NÃO rode o servidor de desenvolvimento — quem sobe é o Inhouse.",
    "",
    "Ao final, descreva como o Inhouse deve subir o preview e termine com um bloco JSON (nada depois dele):",
    "```json",
    '{ "cmd": "comando do dev server (ex.: pnpm --filter web dev) — omita p/ auto-detecção", "cwd": "subpasta ou .", "setup": ["comandos curtos idempotentes rodados ANTES do server, ex.: docker compose up -d"], "envFiles": ["arquivos .env não versionados a copiar pro espaço"], "healthPaths": ["/","/rota-que-esta-tarefa-toca"], "readyRegex": "opcional", "timeoutMs": 120000 }',
    "```",
    'Regras: todos os campos são opcionais; em "healthPaths" liste as ROTAS que esta tarefa toca e as',
    'telas de entrada (começando com "/"); em "setup" só comandos que TERMINAM (nunca o servidor de dev).',
  ].join("\n");
}

/**
 * Fase de preview — EXERCÍCIO: o preview já está no ar (subido pelo Inhouse). O
 * agente navega as rotas via curl, encontra erros de runtime (500 por rota, env
 * faltando) e CORRIGE — é aqui que o erro que só aparece ao trocar de rota é pego.
 */
export function previewExercisePrompt(url: string, rotas: string[]): string {
  const alvos =
    rotas.length > 0
      ? `- Rotas prioritárias: ${rotas.join(", ")}`
      : "- A página inicial e as telas que ESTA tarefa mexeu.";
  return [
    `O preview já está NO AR em ${url} — quem o subiu foi o Inhouse. NÃO suba outro servidor.`,
    "Sua tarefa: EXERCITAR as telas como um usuário e garantir que funcionam ANTES de a pessoa testar.",
    `Use curl no próprio preview (${url}) para abrir as rotas que importam:`,
    alvos,
    "- Siga também as rotas de entrada/login e as telas tocadas pela sua mudança.",
    "Para cada rota, confira o status HTTP e o corpo. Se der erro de runtime (500, exceção, variável de",
    "ambiente faltando, conexão de banco recusada), DESCUBRA a causa e CORRIJA (complete o .env, suba o",
    "serviço que falta, ajuste a config) — e refaça o curl até a rota responder sem erro de servidor.",
    "Se você mudar variáveis de ambiente, o servidor de dev costuma recarregar sozinho: espere alguns",
    "segundos e refaça o curl. Não pare enquanto uma rota que importa ainda devolver erro 500.",
    "Ao final, explique em português simples o que conferiu e o que corrigiu. Se algo AINDA estiver",
    "quebrado e você não conseguiu resolver, diga claramente o quê e por quê.",
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
