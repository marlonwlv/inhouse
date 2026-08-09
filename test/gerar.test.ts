/**
 * Geração de workflow por IA (runPhase mockado): parse do JSON, FILTRO pelo
 * catálogo (skill inexistente é descartada), e erros amigáveis.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ runPhase: vi.fn() }));
vi.mock("../server/claude/runner.js", () => ({ runPhase: h.runPhase }));

process.env.INHOUSE_DATA_DIR = mkdtempSync(join(tmpdir(), "inhouse-gerar-"));
process.env.INHOUSE_PROJECTS_DIR = join(process.env.INHOUSE_DATA_DIR, "projects");

const { gerarWorkflow } = await import("../server/workflow/gerar.js");

describe("gerar workflow por IA", () => {
  it("parseia o bloco json e descarta skills fora do catálogo instalado", async () => {
    h.runPhase.mockResolvedValue({
      success: true,
      finalText:
        '```json\n{"name":"Seguro","descricao":"com segurança","skills":{"verificacoes":[{"skill":"security-review"},{"skill":"nao-existe-123"}]}}\n```',
    });
    const r = await gerarWorkflow("sempre um review de segurança");
    expect(r.erro).toBeUndefined();
    expect(r.proposta?.name).toBe("Seguro");
    // security-review é built-in (sempre instalada); a inventada some.
    expect(r.proposta?.skills?.verificacoes?.map((s) => s.skill)).toEqual(["security-review"]);
  });

  it("aceita JSON sem cercas de código também", async () => {
    h.runPhase.mockResolvedValue({ success: true, finalText: '{"name":"X","skills":{}}' });
    const r = await gerarWorkflow("simples");
    expect(r.proposta?.name).toBe("X");
  });

  it("falha do modelo vira erro amigável", async () => {
    h.runPhase.mockResolvedValue({ success: false, errorMessage: "sobrecarregado" });
    const r = await gerarWorkflow("x");
    expect(r.proposta).toBeUndefined();
    expect(r.erro).toBeTruthy();
  });

  it("resposta sem JSON vira erro de formato", async () => {
    h.runPhase.mockResolvedValue({ success: true, finalText: "não consegui montar isso" });
    const r = await gerarWorkflow("x");
    expect(r.erro).toMatch(/formato|reformular/i);
  });

  it("instrução vazia é recusada sem chamar o modelo", async () => {
    h.runPhase.mockClear();
    const r = await gerarWorkflow("   ");
    expect(r.erro).toBeTruthy();
    expect(h.runPhase).not.toHaveBeenCalled();
  });
});
