/**
 * Catálogo de cenários de debug: a matriz de jornadas da esteira.
 * Cada cenário programa o modelo fake (porte/UI/design/veredito) e declara a
 * trilha de steps esperada — o runner headless (runJourneys.ts) compara o que
 * a máquina de estados REAL percorreu contra o esperado.
 */
import type { Porte, Step, TaskStatus } from "../../shared/types.js";

export interface DebugScenario {
  id: string;
  label: string;
  descricao: string;
  /** Julgamentos que o fake emite na espec/plano. */
  porte: Porte;
  ui: boolean;
  design: boolean;
  /** Texto do plano fake (default: um plano genérico). */
  plan?: string;
  /** Cenário de PREPARAÇÃO (startPreparacao) em vez de tarefa normal. */
  preparacao?: boolean;
  /** Resultado do PREPARADO: sim|nao (só para preparacao). */
  prepPronto?: boolean;
  /** Comportamento dos gates de PROJETO (typecheck/lint/test). */
  gates: "stub-pass" | "stub-fail-once" | "stub-fail-always" | "real";
  /** Veredito das skill-gates (/review, /qa). Default: aprovado. */
  skillGateVeredito?: "aprovado" | "reprovado" | "reprovado-once";
  /** A execução "tocou" arquivos? (default true; false = não re-verifica). */
  execFilesTouched?: boolean;
  /** Bypass humano aplicado pelo auto-piloto na porteira do plano. */
  bypass?: "approve_plan_direto";
  /** Override de design aplicado antes de aprovar o plano. */
  setDesign?: "auto" | "sim" | "nao";
  /** Steps DISTINTOS esperados, na ordem de primeira aparição. */
  expectSteps: Step[];
  /** Status terminal esperado. */
  expectFinal: TaskStatus;
  /** Cenário do grupo "real": roda `tsc` de verdade; só com --real-gates. */
  requerRealGates?: boolean;
}

// Trilhas comuns (steps distintos, na ordem de primeira aparição).
const SIMPLES: Step[] = ["espec", "plano", "aprovacao", "execucao", "verificacoes", "teste", "publicar", "concluida"];
const DETALHE: Step[] = ["espec", "plano", "aprovacao", "detalhamento", "execucao", "verificacoes", "teste", "publicar", "concluida"];
const DESIGN: Step[] = ["espec", "plano", "aprovacao", "detalhamento", "prototipo", "aprovacao_prototipo", "execucao", "verificacoes", "teste", "publicar", "concluida"];
const FALHA_VERIF: Step[] = ["espec", "plano", "aprovacao", "detalhamento", "execucao", "verificacoes"];
const PREP: Step[] = ["execucao", "concluida"];

export const SCENARIOS: DebugScenario[] = [
  {
    id: "simples-sem-ui",
    label: "Simples · sem UI",
    descricao: "Trocar um texto fixo no rodapé.",
    porte: "simples", ui: false, design: false,
    gates: "stub-pass",
    expectSteps: SIMPLES, expectFinal: "concluida",
  },
  {
    id: "simples-com-ui",
    label: "Simples · com UI",
    descricao: "Ajustar a cor de um botão existente.",
    porte: "simples", ui: true, design: false,
    gates: "stub-pass",
    expectSteps: SIMPLES, expectFinal: "concluida",
  },
  {
    id: "media-sem-ui",
    label: "Média · sem UI · sem design",
    descricao: "Adicionar um endpoint de exportação em CSV.",
    porte: "media", ui: false, design: false,
    gates: "stub-pass",
    expectSteps: DETALHE, expectFinal: "concluida",
  },
  {
    id: "media-com-ui",
    label: "Média · com UI · sem design",
    descricao: "Adicionar um filtro na lista existente.",
    porte: "media", ui: true, design: false,
    gates: "stub-pass",
    expectSteps: DETALHE, expectFinal: "concluida",
  },
  {
    id: "media-com-design",
    label: "Média · design (protótipo multi-página + preview multi-rota)",
    descricao: "Nova tela de perfil do usuário.",
    porte: "media", ui: true, design: true,
    gates: "stub-pass",
    expectSteps: DESIGN, expectFinal: "concluida",
  },
  {
    id: "grande-jornada-cheia",
    label: "Grande · jornada cheia (reviews + protótipo multi-página + preview multi-rota)",
    descricao: "Nova área de relatórios com gráficos e exportação.",
    porte: "grande", ui: true, design: true,
    gates: "stub-pass",
    expectSteps: DESIGN, expectFinal: "concluida",
  },
  {
    id: "grande-bypass-direto",
    label: "Grande · bypass 'aprovar e ir direto'",
    descricao: "Feature grande, mas o usuário pula detalhamento/protótipo.",
    porte: "grande", ui: true, design: true,
    gates: "stub-pass",
    bypass: "approve_plan_direto",
    expectSteps: SIMPLES, expectFinal: "concluida",
  },
  {
    id: "gate-falha-1x",
    label: "Média · gate falha 1x e a auto-correção conserta",
    descricao: "Mudança que quebra o typecheck na primeira e conserta na segunda.",
    porte: "media", ui: false, design: false,
    gates: "stub-fail-once",
    expectSteps: DETALHE, expectFinal: "concluida",
  },
  {
    id: "gate-falha-sempre",
    label: "Média · gate falha sempre (esgota auto-correção → falhou)",
    descricao: "Erro determinístico que nem a auto-correção resolve.",
    porte: "media", ui: false, design: false,
    gates: "stub-fail-always",
    expectSteps: FALHA_VERIF, expectFinal: "falhou",
  },
  {
    id: "skillgate-reprova-1x",
    label: "Média · skill-gate (/review) reprova 1x e depois aprova",
    descricao: "Review pede ajuste; a auto-correção resolve.",
    porte: "media", ui: true, design: false,
    gates: "stub-pass",
    skillGateVeredito: "reprovado-once",
    expectSteps: DETALHE, expectFinal: "concluida",
  },
  {
    id: "set-design-nao",
    label: "Média · design ligado pela IA, mas usuário desliga (set_design=nao)",
    descricao: "Tarefa que a IA marcaria como design, mas o usuário pula o protótipo.",
    porte: "media", ui: true, design: true,
    gates: "stub-pass",
    setDesign: "nao",
    expectSteps: DETALHE, expectFinal: "concluida",
  },
  {
    id: "preparacao-ok",
    label: "Preparação do projeto · pronta",
    descricao: "Setup guiado do repositório (PREPARADO: sim).",
    porte: "simples", ui: false, design: false,
    preparacao: true, prepPronto: true,
    gates: "stub-pass",
    expectSteps: PREP, expectFinal: "concluida",
  },
  {
    id: "preparacao-incompleta",
    label: "Preparação do projeto · falta algo (PREPARADO: nao)",
    descricao: "Setup guiado que ainda depende de algo do sistema.",
    porte: "simples", ui: false, design: false,
    preparacao: true, prepPronto: false,
    gates: "stub-pass",
    expectSteps: PREP, expectFinal: "concluida",
  },
  {
    id: "gates-reais",
    label: "Média · verificações REAIS (tsc de verdade)",
    descricao: "Roda o typecheck real no espaço (precisa de --real-gates).",
    porte: "media", ui: false, design: false,
    gates: "real",
    requerRealGates: true,
    expectSteps: DETALHE, expectFinal: "concluida",
  },
];

/** Fallback para chamadas avulsas ao fake (não deveria ocorrer numa jornada). */
export const DEFAULT_SCENARIO: DebugScenario = {
  id: "_default",
  label: "(default)",
  descricao: "cenário padrão do fake",
  porte: "media", ui: false, design: false,
  gates: "stub-pass",
  expectSteps: DETALHE, expectFinal: "concluida",
};

export function findScenario(id: string): DebugScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
