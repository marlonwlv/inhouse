/**
 * Testes do runner (wrapper do Agent SDK), com o SDK mockado:
 * - abortPhase(taskId) interrompe a fase em andamento (cancel da esteira);
 * - o timeout de 20 min da fase NÃO corre enquanto uma permissão espera o humano;
 * - sem permissão pendente, o timeout de 20 min continua valendo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const h = vi.hoisted(() => {
  class MockAbortError extends Error {}
  const state: { impl: ((props: unknown) => AsyncGenerator<unknown, void>) | undefined } = {
    impl: undefined,
  };
  return { MockAbortError, state };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  AbortError: h.MockAbortError,
  query: (props: unknown) => h.state.impl!(props),
}));
vi.mock("../server/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../server/config.js")>();
  return { ...orig, claudePath: () => "/fake/claude", claudeEnv: () => ({}) };
});
vi.mock("../server/store.js", () => ({ transcriptAppend: () => {} }));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));

import { abortPhase, runPhase } from "../server/claude/runner.js";

interface QueryProps {
  prompt: string;
  options: Options;
}

function setQuery(impl: (props: QueryProps) => AsyncGenerator<SDKMessage, void>): void {
  h.state.impl = impl as unknown as (props: unknown) => AsyncGenerator<unknown, void>;
}

const initMsg = { type: "system", subtype: "init", session_id: "sess-1" } as unknown as SDKMessage;
function resultMsg(result: string): SDKMessage {
  return { type: "result", subtype: "success", result, is_error: false } as unknown as SDKMessage;
}

/** Promise que rejeita com AbortError (do mock) quando o signal da fase aborta. */
function rejectOnAbort(options: Options): Promise<never> {
  const signal = options.abortController!.signal;
  return new Promise((_, reject) => {
    const boom = (): void => reject(new h.MockAbortError("The operation was aborted"));
    if (signal.aborted) {
      boom();
      return;
    }
    signal.addEventListener("abort", boom, { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
  h.state.impl = undefined;
});

describe("runPhase", () => {
  it("abortPhase interrompe a sessão em andamento (usado pelo cancel)", async () => {
    setQuery(async function* (props) {
      yield initMsg;
      await rejectOnAbort(props.options);
    });

    const promessa = runPhase({
      taskId: "t-abort",
      cwd: "/tmp",
      prompt: "faça algo",
      permissionMode: "acceptEdits",
    });
    expect(abortPhase("t-abort")).toBe(true);

    const r = await promessa;
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("interrompido");
    // Fase encerrada: não há mais o que abortar (registro limpo no finally).
    expect(abortPhase("t-abort")).toBe(false);
  });

  it("o timeout da fase não corre enquanto uma permissão espera decisão humana", async () => {
    vi.useFakeTimers();
    let decide!: (r: PermissionResult) => void;
    let chegouNoPedido!: () => void;
    const pedidoFeito = new Promise<void>((r) => {
      chegouNoPedido = r;
    });
    const canUseTool: CanUseTool = () => {
      chegouNoPedido();
      return new Promise<PermissionResult>((resolve) => {
        decide = resolve;
      });
    };

    setQuery(async function* (props) {
      yield initMsg;
      // O SDK abortaria a espera se o abortController da fase disparasse.
      const res = await Promise.race([
        props.options.canUseTool!("Bash", { command: "npm install" }, {
          signal: new AbortController().signal,
          toolUseID: "tu-1",
          requestId: "rq-1",
        }),
        rejectOnAbort(props.options),
      ]);
      yield resultMsg(res?.behavior === "allow" ? "feito" : "negado");
    });

    const promessa = runPhase({
      taskId: "t-perm",
      cwd: "/tmp",
      prompt: "faça algo",
      permissionMode: "acceptEdits",
      canUseTool,
    });

    // Deixa a fase chegar ao pedido de permissão (só microtasks, sem timers)…
    await pedidoFeito;
    // …e o humano demora 25 min "de relógio" — mais que os 20 min da fase.
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
    decide({ behavior: "allow", updatedInput: { command: "npm install" } });

    const r = await promessa;
    expect(r.success).toBe(true);
    expect(r.finalText).toBe("feito");
  });

  it("sem permissão pendente, a fase estoura o timeout de 20 minutos", async () => {
    vi.useFakeTimers();
    setQuery(async function* (props) {
      yield initMsg;
      await rejectOnAbort(props.options); // fase "pendurada" para sempre
    });

    const promessa = runPhase({
      taskId: "t-timeout",
      cwd: "/tmp",
      prompt: "faça algo",
      permissionMode: "acceptEdits",
    });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    const r = await promessa;
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain("20 minutos");
  });
});
