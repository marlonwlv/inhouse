import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regressão do bug do banner eterno: elementos que o app.js esconde via
 * atributo `hidden` MAS que têm regra própria de `display` no CSS precisam
 * de um companion `[hidden] { display: none }` — o atributo perde para
 * qualquer regra de display do autor. Este teste falha se alguém adicionar
 * display a um elemento toggled sem o companion.
 */
describe("CSS vs atributo hidden", () => {
  const root = join(import.meta.dirname, "..");
  const css = readFileSync(join(root, "public", "styles.css"), "utf8");
  const js = readFileSync(join(root, "public", "app.js"), "utf8");

  // ids que o app.js esconde/mostra via .hidden
  const toggledIds = [...js.matchAll(/\$\("#([a-z-]+)"\)/g)]
    .map((m) => m[1]!)
    .filter((id) => new RegExp(`\\$\\("#${id}"\\)[\\s\\S]{0,120}\\.hidden\\s*=`).test(js));

  it("encontrou os elementos toggled conhecidos", () => {
    expect(toggledIds).toContain("offline-banner");
    expect(toggledIds).toContain("toast");
  });

  it.each([...new Set(toggledIds)])("#%s: display próprio exige companion [hidden]", (id) => {
    // Existe uma regra do próprio id que define display?
    const ruleRe = new RegExp(`#${id}(?![\\w-])[^{]*\\{[^}]*display\\s*:`, "m");
    const hasDisplay = ruleRe.test(css.replace(new RegExp(`#${id}\\[hidden\\][^}]*\\}`, "g"), ""));
    if (hasDisplay) {
      expect(css).toMatch(new RegExp(`#${id}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`));
    }
  });
});
