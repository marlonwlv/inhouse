import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { especPrompt, parsePorte, parseVeredito } from "../server/workflow/phases.js";
import { loadConfig, loadConfigCascata, skillsPlanoPara, temUi } from "../server/workflow/config.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "inhouse-config-"));
}

describe("loadConfig (inhouse.config.json)", () => {
  it("sem arquivo → null", () => {
    expect(loadConfig(dir())).toBeNull();
  });

  it("json inválido → null (tolerante)", () => {
    const d = dir();
    writeFileSync(join(d, "inhouse.config.json"), "{quebrado");
    expect(loadConfig(d)).toBeNull();
  });

  it("carrega e sanitiza skills válidas", () => {
    const d = dir();
    writeFileSync(
      join(d, "inhouse.config.json"),
      JSON.stringify({
        skills: {
          plano: [
            { skill: "office-hours", args: "{spec}" },
            { skill: "plan-design-review", quando: "ui" },
            { skill: "../malicioso; rm -rf" }, // nome inválido: descartado
            { gate: "sem-skill" }, // sem skill: descartado
          ],
          verificacoes: [{ skill: "qa", gate: "QA", args: "{previewUrl}" }],
        },
      }),
    );
    const cfg = loadConfig(d);
    const grande = skillsPlanoPara(cfg, "grande");
    expect(grande.map((s) => s.skill)).toEqual(["office-hours", "plan-design-review"]);
    expect(grande[1]?.quando).toBe("ui");
    // forma lista: "simples" pula as skills por padrão
    expect(skillsPlanoPara(cfg, "simples")).toEqual([]);
    expect(cfg?.skills?.verificacoes?.[0]).toMatchObject({ skill: "qa", gate: "QA" });
  });

  it("o template app-starter embarca uma config válida com o mapeamento gstack", () => {
    const cfg = loadConfig(join(import.meta.dirname, "..", "templates", "app-starter"));
    expect(skillsPlanoPara(cfg, "grande").map((s) => s.skill)).toEqual([
      "office-hours",
      "plan-eng-review",
      "plan-design-review",
    ]);
    expect(skillsPlanoPara(cfg, "simples")).toEqual([]);
    expect(skillsPlanoPara(cfg, "media").map((s) => s.skill)).toEqual(["plan-eng-review"]);
    expect(cfg?.skills?.verificacoes?.map((s) => s.skill)).toEqual(["review", "qa"]);
  });
});

describe("loadConfigCascata", () => {
  it("espaço sem config cai para a pasta principal do projeto (mesmo sem commit)", () => {
    const worktree = dir();
    const projeto = dir();
    writeFileSync(
      join(projeto, "inhouse.config.json"),
      JSON.stringify({ skills: { plano: [{ skill: "office-hours" }] } }),
    );
    const cfg = loadConfigCascata(worktree, projeto);
    expect(skillsPlanoPara(cfg, "media")[0]?.skill).toBe("office-hours");
  });

  it("o espaço tem precedência sobre a pasta do projeto", () => {
    const worktree = dir();
    const projeto = dir();
    writeFileSync(
      join(worktree, "inhouse.config.json"),
      JSON.stringify({ skills: { plano: [{ skill: "do-espaco" }] } }),
    );
    writeFileSync(
      join(projeto, "inhouse.config.json"),
      JSON.stringify({ skills: { plano: [{ skill: "do-projeto" }] } }),
    );
    expect(skillsPlanoPara(loadConfigCascata(worktree, projeto), "media")[0]?.skill).toBe("do-espaco");
  });
});

describe("skillsPlanoPara (objeto por porte)", () => {
  it("resolve cadeias distintas por porte, com lista vazia explícita", () => {
    const d = dir();
    writeFileSync(
      join(d, "inhouse.config.json"),
      JSON.stringify({
        skills: {
          plano: {
            simples: [],
            media: [{ skill: "plan-eng-review" }],
            grande: [{ skill: "office-hours" }, { skill: "plan-eng-review" }],
          },
        },
      }),
    );
    const cfg = loadConfig(d);
    expect(skillsPlanoPara(cfg, "simples")).toEqual([]);
    expect(skillsPlanoPara(cfg, "media").map((s) => s.skill)).toEqual(["plan-eng-review"]);
    expect(skillsPlanoPara(cfg, "grande").map((s) => s.skill)).toEqual([
      "office-hours",
      "plan-eng-review",
    ]);
  });
});

describe("temUi", () => {
  it("react nas deps → true; sem package.json → false", () => {
    const d = dir();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { react: "^19" } }));
    expect(temUi(d)).toBe(true);
    expect(temUi(dir())).toBe(false);
  });

  it("backend puro → false", () => {
    const d = dir();
    writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { express: "^4" } }));
    expect(temUi(d)).toBe(false);
  });
});

describe("parseVeredito", () => {
  it("aprovado", () => {
    expect(parseVeredito("blá blá\nVEREDITO: APROVADO")).toEqual({ ok: true, motivo: undefined });
  });
  it("reprovado com motivo", () => {
    expect(parseVeredito("…\nVEREDITO: REPROVADO — botão sem ação na tela X")).toMatchObject({
      ok: false,
      motivo: "botão sem ação na tela X",
    });
  });
  it("sem veredito → aprova com nota (não trava a esteira)", () => {
    expect(parseVeredito("terminei tudo")).toMatchObject({ ok: true, motivo: "sem veredito explícito" });
  });
});

describe("parsePorte (triagem na espec)", () => {
  it("lê o porte da última linha", () => {
    expect(parsePorte("## Objetivo\n…\nPORTE: simples")).toBe("simples");
    expect(parsePorte("…\nPORTE: grande")).toBe("grande");
    expect(parsePorte("…\nPORTE: média")).toBe("media");
  });
  it("sem linha válida → media (meio-termo seguro)", () => {
    expect(parsePorte("especificação sem porte")).toBe("media");
  });
  it("o prompt da espec pede a classificação", () => {
    const prompt = especPrompt({ title: "x", description: "y" } as never);
    expect(prompt).toContain("PORTE: simples | media | grande");
  });
});
