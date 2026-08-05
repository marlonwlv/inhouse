/**
 * Testes da ponte de permissões (canUseTool ↔ UI).
 * Store e SSE mockados: aqui interessa o ciclo pedido → decisão/timeout/aborto.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let n = 0;
  const added: { id: string; taskId: string; toolName: string; friendly: string }[] = [];
  const events: { type: string; requestId?: string; allowed?: boolean }[] = [];
  const removed: string[] = [];
  return {
    added,
    events,
    removed,
    addPermission: (p: { id: string; taskId: string; toolName: string; friendly: string }) => {
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
}));
vi.mock("../server/events.js", () => ({ broadcast: mocks.broadcast, addClient: () => {} }));

import { createPermissionGate, resolvePermission } from "../server/claude/permissions.js";
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
