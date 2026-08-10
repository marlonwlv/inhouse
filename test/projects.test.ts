/**
 * Testes de projetos: validação do link de clone (falha rápida, sem rede) e
 * as barreiras do openProject (pasta pessoal, "/", pastas internas do builder).
 * O config lê env no import → import dinâmico com env já apontado para um tmp.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/types.js";

vi.mock("../server/events.js", () => ({ broadcast: vi.fn(), addClient: vi.fn() }));
// Serviços pesados: mockados — aqui testamos os guardrails, não preview/worktree.
vi.mock("../server/services/preview.js", () => ({ stopPreview: vi.fn() }));
vi.mock("../server/services/worktrees.js", () => ({ removeEspaco: vi.fn() }));
vi.mock("../server/workflow/library.js", () => ({ forgetProject: vi.fn() }));

type ProjectsModule = typeof import("../server/services/projects.js");
type StoreModule = typeof import("../server/store.js");

let projects: ProjectsModule;
let store: StoreModule;
let base = "";

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "inhouse-projects-"));
  process.env.INHOUSE_DATA_DIR = join(base, "data");
  process.env.INHOUSE_PROJECTS_DIR = join(base, "projects");
  vi.resetModules();
  projects = await import("../server/services/projects.js");
  store = await import("../server/store.js");
  store.load();
});

let seq = 0;
function fakeTask(over: Partial<Task> & { projectId: string }): Task {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: "t",
    description: "d",
    step: "espec",
    status: "aguardando",
    espaco: 1,
    branch: "tarefa/x-1",
    worktreePath: "",
    gates: [],
    gateFixRounds: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

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

describe("arquivar / excluir projetos (guardrails)", () => {
  it("setArquivado liga e desliga a flag (reversível)", async () => {
    const dir = join(base, "projects", "arq-app");
    mkdirSync(dir, { recursive: true });
    const p = store.addProject({
      id: "arq1",
      name: "arq-app",
      kind: "app",
      path: dir,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    expect(p.arquivadoEm).toBeUndefined();
    const on = await projects.setArquivado("arq1", true);
    expect(on.arquivadoEm).toBeTruthy();
    const off = await projects.setArquivado("arq1", false);
    expect(off.arquivadoEm).toBeUndefined();
  });

  it("exclusaoInfo: pasta fora de ~/Inhouse é NÃO-gerenciada", async () => {
    const pasta = join(base, "fora-app"); // fora de PROJECTS_DIR
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, "index.html"), "<h1>oi</h1>");
    const p = await projects.openProject(pasta);
    const info = await projects.exclusaoInfo(p.id);
    expect(info.gerenciado).toBe(false);
    expect(info.temRemoto).toBe(false);
    expect(info.sujo).toBe(false);
    expect(info.branchesTarefa).toBe(0);
  });

  it("CRÍTICO: excluir projeto aberto no lugar NÃO apaga a pasta do usuário", async () => {
    const pasta = join(base, "projeto-do-usuario");
    mkdirSync(pasta, { recursive: true });
    writeFileSync(join(pasta, "importante.txt"), "não me apague");
    const p = await projects.openProject(pasta);

    // Mesmo pedindo apagarArquivos, a pasta é do usuário → intocada.
    await projects.deleteProject(p.id, { apagarArquivos: true });

    expect(existsSync(pasta)).toBe(true); // a pasta continua lá
    expect(existsSync(join(pasta, "importante.txt"))).toBe(true);
    expect(store.getProject(p.id)).toBeUndefined(); // mas saiu do Inhouse
  });

  it("projeto gerenciado: excluir apaga a pasta e remove do estado", async () => {
    const dir = join(base, "projects", "app-descartavel");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.js"), "console.log(1)");
    store.addProject({
      id: "ger1",
      name: "app-descartavel",
      kind: "app",
      path: dir,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    store.addTask(fakeTask({ projectId: "ger1" }));

    await projects.deleteProject("ger1", { apagarArquivos: true });

    expect(existsSync(dir)).toBe(false); // pasta apagada
    expect(store.getProject("ger1")).toBeUndefined();
    expect(store.listTasks().some((t) => t.projectId === "ger1")).toBe(false);
  });

  it("recusa excluir com tarefa RODANDO (não mata o Claude no meio)", async () => {
    const dir = join(base, "projects", "app-ocupado");
    mkdirSync(dir, { recursive: true });
    store.addProject({
      id: "run1",
      name: "app-ocupado",
      kind: "app",
      path: dir,
      defaultBranch: "main",
      createdAt: new Date().toISOString(),
    });
    store.addTask(fakeTask({ projectId: "run1", status: "rodando" }));

    await expect(projects.deleteProject("run1", { apagarArquivos: true })).rejects.toThrow(
      /em andamento/,
    );
    expect(store.getProject("run1")).toBeDefined(); // nada foi removido
    expect(existsSync(dir)).toBe(true);
  });
});
