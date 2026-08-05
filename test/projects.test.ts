/**
 * Testes de projetos: validação do link de clone (falha rápida, sem rede) e
 * as barreiras do openProject (pasta pessoal, "/", pastas internas do builder).
 * O config lê env no import → import dinâmico com env já apontado para um tmp.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));

type ProjectsModule = typeof import("../server/services/projects.js");

let projects: ProjectsModule;
let base = "";

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "inhouse-projects-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
  projects = await import("../server/services/projects.js");
});

describe("cloneProject: validação do link (sem tocar na rede)", () => {
  it("recusa texto que não é URL", async () => {
    await expect(projects.cloneProject("meu repo")).rejects.toThrow(/Endereço inválido/);
  });

  it("recusa http:// (só https)", async () => {
    await expect(projects.cloneProject("http://github.com/org/repo")).rejects.toThrow(
      /Só aceitamos/,
    );
  });

  it("recusa hosts fora do github.com", async () => {
    await expect(projects.cloneProject("https://gitlab.com/org/repo")).rejects.toThrow(
      /Só aceitamos/,
    );
  });

  it("recusa link sem o repositório", async () => {
    await expect(projects.cloneProject("https://github.com/apenas-org")).rejects.toThrow(
      /precisa apontar/,
    );
  });

  it("recusa nome de repositório com caracteres perigosos (%2F etc.)", async () => {
    await expect(projects.cloneProject("https://github.com/org/..%2f..")).rejects.toThrow(
      /caracteres/,
    );
  });
});

describe("openProject: barreiras de caminho", () => {
  it("recusa a pasta pessoal do usuário (git add -A engoliria segredos)", async () => {
    await expect(projects.openProject(homedir())).rejects.toThrow(/ampla demais/);
  });

  it('recusa "/" e qualquer pasta acima da pessoal', async () => {
    await expect(projects.openProject("/")).rejects.toThrow(/ampla demais/);
    await expect(projects.openProject(dirname(homedir()))).rejects.toThrow(/ampla demais/);
  });

  it("recusa as pastas internas do builder (espaços e estado)", async () => {
    await expect(
      projects.openProject(join(base, "projects", ".espacos", "demo", "espaco-1")),
    ).rejects.toThrow(/internamente/);
    await expect(projects.openProject(join(base, "projects"))).rejects.toThrow(/internamente/);
    await expect(projects.openProject(join(base, "data"))).rejects.toThrow(/internamente/);
  });

  it("pasta inexistente: erro amigável", async () => {
    await expect(projects.openProject(join(base, "nao-existe"))).rejects.toThrow(
      /Pasta não encontrada/,
    );
  });

  it("pasta comum vira projeto (git inicializado, branch main)", async () => {
    const pasta = join(base, "meu-app");
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, "index.html"), "<h1>oi</h1>");

    const p = await projects.openProject(pasta);
    expect(p.name).toBe("meu-app");
    expect(p.path).toBe(pasta);
    expect(p.defaultBranch).toBe("main");

    // Abrir de novo a mesma pasta não duplica o projeto.
    await expect(projects.openProject(pasta)).rejects.toThrow(/já está aberta/);
  });
});
