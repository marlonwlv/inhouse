import { describe, expect, it } from "vitest";

// @ts-expect-error — módulo do navegador (JS puro, sem tipos), importado direto.
import { filtroQuadroValido, parseAbas } from "../public/puro.js";

/**
 * Fronteira de entrada NÃO confiável: os dois valores que a UI lê do
 * localStorage. Podem estar velhos (apontando para projeto/tarefa que não
 * existe mais), corrompidos ou editados à mão — e quebram em silêncio, sem
 * erro visível. Por isso valem teste próprio.
 */

describe("filtroQuadroValido — filtro do quadro vindo do localStorage", () => {
  const vivo = { id: "p1", arquivadoEm: null };
  const arquivado = { id: "p2", arquivadoEm: "2026-08-16T00:00:00Z" };

  it("mantém as sentinelas 'todos' e 'suavez'", () => {
    expect(filtroQuadroValido("todos", [])).toBe("todos");
    expect(filtroQuadroValido("suavez", [])).toBe("suavez");
  });

  it("mantém um projeto que existe e está ativo", () => {
    expect(filtroQuadroValido("p1", [vivo, arquivado])).toBe("p1");
  });

  // Regressão: o quadro só monta grupos de projetos não-arquivados. Deixar o
  // filtro num projeto arquivado deixava a tela em branco, sem chip marcado.
  it("volta para 'todos' quando o projeto foi ARQUIVADO", () => {
    expect(filtroQuadroValido("p2", [vivo, arquivado])).toBe("todos");
  });

  it("volta para 'todos' quando o projeto não existe mais", () => {
    expect(filtroQuadroValido("p-apagado", [vivo])).toBe("todos");
  });

  it.each([["string vazia", ""], ["null", null], ["undefined", undefined], ["objeto serializado", "{}"]])(
    "lixo no localStorage vira 'todos' (%s)",
    (_nome, valor) => {
      expect(filtroQuadroValido(valor as never, [vivo])).toBe("todos");
    },
  );

  it("não quebra quando ainda não há projetos carregados", () => {
    expect(filtroQuadroValido("p1", [])).toBe("todos");
  });
});

describe("parseAbas — abas abertas vindas do localStorage", () => {
  it("lê uma lista válida", () => {
    expect(parseAbas('["t1","t2"]')).toEqual(["t1", "t2"]);
  });

  it("chave ausente vira lista vazia", () => {
    expect(parseAbas(null)).toEqual([]);
  });

  it("JSON quebrado vira lista vazia", () => {
    expect(parseAbas("{nao é json")).toEqual([]);
  });

  it("payload que não é lista vira lista vazia", () => {
    expect(parseAbas('{"a":1}')).toEqual([]);
    expect(parseAbas("42")).toEqual([]);
  });

  it("descarta membros que não são string", () => {
    expect(parseAbas('["t1",2,null,{},"t2"]')).toEqual(["t1", "t2"]);
  });
});
