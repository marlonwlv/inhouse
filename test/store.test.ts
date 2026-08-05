/**
 * Testes do store (persistência em DATA_DIR temporário).
 * O config lê INHOUSE_DATA_DIR no momento do import, então cada teste importa
 * o módulo do zero (vi.resetModules + import dinâmico) com env já apontado.
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Project, Task, TranscriptItem } from "../shared/types.js";

type StoreModule = typeof import("../server/store.js");

let dataDir = "";

async function freshStore(prepara?: (dir: string) => void): Promise<StoreModule> {
  dataDir = mkdtempSync(join(tmpdir(), "inhouse-store-"));
  process.env.INHOUSE_DATA_DIR = dataDir;
  process.env.INHOUSE_PROJECTS_DIR = join(dataDir, "projects");
  prepara?.(dataDir);
  vi.resetModules();
  const store: StoreModule = await import("../server/store.js");
  store.load();
  return store;
}

/** Reimporta com o MESMO DATA_DIR — simula um restart do servidor. */
async function restart(): Promise<StoreModule> {
  vi.resetModules();
  const store: StoreModule = await import("../server/store.js");
  store.load();
  return store;
}

function projeto(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "demo",
    kind: "app",
    path: "/tmp/nao-usado",
    defaultBranch: "main",
    createdAt: "2026-08-05T12:00:00.000Z",
    ...over,
  };
}

let seq = 0;
function tarefa(over: Partial<Task> = {}): Task {
  return {
    id: `t${++seq}`,
    projectId: "p1",
    title: "Tarefa de teste",
    description: "descrição",
    step: "execucao",
    status: "aguardando",
    espaco: 1,
    branch: "tarefa/teste-1",
    worktreePath: "/tmp/nao-usado/espaco-1",
    gates: [],
    gateFixRounds: 0,
    createdAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:00.000Z",
    ...over,
  };
}

describe("store: persistência", () => {
  it("estado faz round-trip por um restart (projects, tasks e patches)", async () => {
    const store = await freshStore();
    store.addProject(projeto({ id: "p1" }));
    store.addTask(tarefa({ id: "a", espaco: 1, step: "aprovacao", status: "aguardando" }));
    store.addTask(tarefa({ id: "b", espaco: 2, step: "concluida", status: "concluida" }));
    store.updateTask("a", { plan: "1. fazer X", claudeSessionId: "sess-9", gateFixRounds: 1 });

    const antes = JSON.parse(
      JSON.stringify({ projects: store.listProjects(), tasks: store.listTasks() }),
    ) as unknown;

    const store2 = await restart();
    expect({ projects: store2.listProjects(), tasks: store2.listTasks() }).toEqual(antes);
    expect(store2.getProject("p1")?.name).toBe("demo");
    expect(store2.getTask("a")?.plan).toBe("1. fazer X");
    expect(store2.getTask("a")?.claudeSessionId).toBe("sess-9");
  });

  it("tarefa que estava 'rodando' no restart vira 'falhou' com aviso de retry", async () => {
    const store = await freshStore();
    store.addTask(tarefa({ id: "a", step: "execucao", status: "rodando" }));
    store.addTask(tarefa({ id: "b", step: "teste", status: "aguardando" }));

    const store2 = await restart();
    const a = store2.getTask("a");
    expect(a?.status).toBe("falhou");
    expect(a?.error).toMatch(/reiniciado/);
    // Quem não estava rodando não é tocado.
    expect(store2.getTask("b")?.status).toBe("aguardando");
  });

  it("tarefa 'aguardando' num passo automático (permissão pendente) vira 'falhou' no restart", async () => {
    const store = await freshStore();
    // Esperava decisão de permissão durante a execução quando o server caiu.
    store.addTask(tarefa({ id: "a", step: "execucao", status: "aguardando" }));
    // Porteira humana de verdade: não pode ser tocada.
    store.addTask(tarefa({ id: "b", step: "aprovacao", status: "aguardando" }));

    const store2 = await restart();
    const a = store2.getTask("a");
    expect(a?.status).toBe("falhou");
    expect(a?.error).toMatch(/reiniciado/);
    expect(store2.getTask("b")?.status).toBe("aguardando");
  });

  it("state.json corrompido: guarda backup, começa limpo e volta a persistir", async () => {
    const lixo = "{isso não é json";
    const store = await freshStore((dir) => {
      writeFileSync(join(dir, "state.json"), lixo);
    });

    expect(store.listProjects()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
    // O arquivo original foi renomeado (não apagado) para diagnóstico.
    expect(existsSync(join(dataDir, "state.json"))).toBe(false);
    const backups = readdirSync(dataDir).filter((f) => f.startsWith("state.json.corrupted-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dataDir, backups[0]!), "utf8")).toBe(lixo);

    // E o store continua funcional depois da recuperação.
    store.addProject(projeto({ id: "novo" }));
    const store2 = await restart();
    expect(store2.getProject("novo")).toBeDefined();
  });

  it("state.json válido mas sem os campos esperados carrega vazio, sem backup", async () => {
    const store = await freshStore((dir) => writeFileSync(join(dir, "state.json"), "{}"));
    expect(store.listProjects()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
    expect(readdirSync(dataDir).filter((f) => f.includes("corrupted"))).toEqual([]);
  });

  it("updateTask de id inexistente lança erro", async () => {
    const store = await freshStore();
    expect(() => store.updateTask("nao-existe", { status: "falhou" })).toThrow(/não encontrada/);
  });
});

describe("store: nextEspaco", () => {
  it("usa o menor buraco livre e ignora tarefas finalizadas", async () => {
    const store = await freshStore();
    store.addTask(tarefa({ espaco: 1, status: "rodando" }));
    store.addTask(tarefa({ espaco: 3, status: "aguardando" }));
    store.addTask(tarefa({ espaco: 2, status: "concluida", step: "concluida" }));
    store.addTask(tarefa({ espaco: 4, status: "cancelada" }));

    // 2 e 4 estão livres (finalizadas); o menor buraco é 2.
    expect(store.nextEspaco("p1")).toBe(2);

    store.addTask(tarefa({ espaco: 2, status: "aguardando" }));
    expect(store.nextEspaco("p1")).toBe(4);

    // Tarefa "falhou" ainda ocupa o espaço (worktree segue no disco).
    store.addTask(tarefa({ espaco: 4, status: "falhou" }));
    expect(store.nextEspaco("p1")).toBe(5);

    // Outro projeto tem numeração própria.
    expect(store.nextEspaco("p2")).toBe(1);
  });
});

describe("store: transcript", () => {
  it("append/read preserva ordem e conteúdo; sobrevive a restart", async () => {
    const store = await freshStore();
    const items: TranscriptItem[] = [
      { kind: "user", text: "quero um botão", at: "2026-08-05T12:00:00.000Z" },
      { kind: "tool", op: "$", label: "Rodar: npm test", detail: "npm test -- --run", at: "2026-08-05T12:00:01.000Z" },
      { kind: "assistant", text: "feito!\ncom quebra de linha", at: "2026-08-05T12:00:02.000Z" },
      { kind: "system", text: "Verificação TypeScript: passou", at: "2026-08-05T12:00:03.000Z" },
    ];
    for (const item of items) store.transcriptAppend("t-abc", item);

    expect(store.transcriptRead("t-abc")).toEqual(items);
    // Tarefa sem transcript: lista vazia, sem erro.
    expect(store.transcriptRead("nao-existe")).toEqual([]);

    const store2 = await restart();
    expect(store2.transcriptRead("t-abc")).toEqual(items);
  });

  it("linha corrompida (escrita interrompida) é pulada — o resto do histórico continua legível", async () => {
    const store = await freshStore();
    const item: TranscriptItem = { kind: "user", text: "quero um botão", at: "2026-08-05T12:00:00.000Z" };
    store.transcriptAppend("t-corrompido", item);
    // Simula o servidor caindo no meio de um append (linha pela metade).
    appendFileSync(join(dataDir, "transcripts", "t-corrompido.jsonl"), '{"kind":"assistant","te');
    expect(store.transcriptRead("t-corrompido")).toEqual([item]);
  });
});
