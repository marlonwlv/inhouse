/**
 * Prompts (em português) de cada fase da esteira.
 * A máquina de estados (machine.ts) escolhe qual usar e com quais opções do runner.
 */
import type { GateResult, Task } from "../../shared/types.js";

/** Fase espec: estruturar o pedido em spec curta, sem tocar em nada. */
export function especPrompt(task: Task): string {
  return [
    "Você é o assistente de desenvolvimento do Inhouse Builder, trabalhando em um app da Inhouse.",
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
