/**
 * Funções puras da UI — sem DOM, sem estado global, sem localStorage.
 *
 * Moram aqui (e não no app.js) porque são a fronteira que valida entrada NÃO
 * confiável: o que veio do localStorage do navegador, que pode estar velho,
 * corrompido ou apontando para coisa que não existe mais. É o tipo de lógica
 * que quebra em silêncio, então fica isolada e testável (test/ui-puro.test.ts).
 *
 * O app.js importa daqui; o navegador carrega os dois como módulo.
 */

/**
 * Resolve o filtro do quadro para um valor seguro de renderizar.
 *
 * O quadro só monta grupos de projetos NÃO arquivados. Um filtro gravado
 * apontando para um projeto que foi apagado — ou arquivado depois — deixaria a
 * tela em branco, sem nenhum chip marcado e sem pista do motivo. Nesses casos
 * volta para "todos".
 *
 * @param {string|null|undefined} filtro valor gravado ("todos" | "suavez" | id)
 * @param {Array<{id: string, arquivadoEm?: string|null}>} projetos
 * @returns {"todos"|"suavez"|string}
 */
export function filtroQuadroValido(filtro, projetos) {
  if (filtro === "todos" || filtro === "suavez") return filtro;
  const p = (projetos || []).find((x) => x.id === filtro);
  return p && !p.arquivadoEm ? filtro : "todos";
}

/**
 * Lê a lista de abas abertas de um JSON cru do localStorage.
 *
 * Tolera tudo o que o localStorage pode devolver na prática: chave ausente,
 * JSON quebrado (edição manual, escrita interrompida), payload que não é lista
 * e membros que não são string. Qualquer um desses vira lista vazia em vez de
 * derrubar o render.
 *
 * @param {string|null} cru conteúdo bruto de localStorage.getItem("inhouse.abas")
 * @returns {string[]} ids de tarefa, sempre uma lista de strings
 */
export function parseAbas(cru) {
  try {
    const v = JSON.parse(cru || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
