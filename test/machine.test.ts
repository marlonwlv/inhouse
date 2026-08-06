/**
 * Testes da máquina de estados da esteira.
 * O runner do Claude e os serviços pesados (worktrees/gates/preview/publish)
 * são mockados; o store é o real, apontado para um DATA_DIR temporário.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GateResult, Project, Task } from "../shared/types.js";

const h = vi.hoisted(() => {
  const state = {
    /** Plano devolvido pelo runPhase em permissionMode "plan" (via ExitPlanMode). */
    planText: "1. Editar App.tsx\n2. Ajustar estilos" as string | undefined,
    planFails: false,
    gatesOk: true,
    espacoFails: false,
    publishFails: false,
    publishPrUrl: undefined as string | undefined,
    calls: [] as { permissionMode: string; prompt: string; resume?: string }[],
    gateRuns: 0,
    publishCalls: [] as { createPr: boolean }[],
    stopPreviewCalls: [] as string[],
    abortCalls: [] as string[],
    execFilesTouched: true,
  };
  return {
    state,
    async runPhase(opts: { permissionMode: string; prompt: string; resume?: string }) {
      state.calls.push({
        permissionMode: opts.permissionMode,
        prompt: opts.prompt,
        resume: opts.resume,
      });
      if (opts.permissionMode === "plan") {
        if (state.planFails) {
          return { finalText: "", success: false, errorMessage: "O plano quebrou (mock)." };
        }
        return {
          sessionId: "sess-plano",
          finalText: "texto final do plano",
          planText: state.planText,
          success: true,
        };
      }
      if (opts.permissionMode === "acceptEdits") {
        return { sessionId: "sess-exec", finalText: "Mudanças feitas.", success: true, filesTouched: state.execFilesTouched };
      }
      // Fase espec (permissionMode "default", read-only).
      return { sessionId: "sess-espec", finalText: "## Objetivo\nEspec estruturada (mock)", success: true };
    },
    async runGates(): Promise<GateResult[]> {
      state.gateRuns++;
      return state.gatesOk
        ? [{ name: "TypeScript", command: "npm run typecheck", ok: true, durationMs: 1 }]
        : [
            {
              name: "TypeScript",
              command: "npm run typecheck",
              ok: false,
              output: "src/App.tsx(1,1): error TS2304",
              durationMs: 1,
            },
          ];
    },
    async createEspaco(_project: unknown, espaco: number, slug: string) {
      if (state.espacoFails) throw new Error("Não deu para criar o espaço (mock).");
      const fs = await import("node:fs/promises");
      const os = await import("node:os");
      const path = await import("node:path");
      const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), `inhouse-espaco-${espaco}-`));
      return { branch: `tarefa/${slug}-${espaco}`, worktreePath };
    },
    async publishTask(_task: unknown, _project: unknown, createPr: boolean) {
      state.publishCalls.push({ createPr });
      if (state.publishFails) throw new Error("Merge deu conflito (mock).");
      return state.publishPrUrl ? { prUrl: state.publishPrUrl } : {};
    },
    async stopPreview(taskId: string) {
      state.stopPreviewCalls.push(taskId);
    },
  };
});

vi.mock("../server/claude/runner.js", () => ({
  runPhase: h.runPhase,
  abortPhase: (taskId: string) => {
    h.state.abortCalls.push(taskId);
    return false;
  },
  claudeStatus: async () => ({ ok: true }),
}));
vi.mock("../server/services/gates.js", () => ({
  runGates: h.runGates,
  detectGates: () => [],
}));
vi.mock("../server/services/worktrees.js", () => ({
  createEspaco: h.createEspaco,
  slugify: (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  removeEspaco: async () => {},
  ensureDeps: async () => {},
}));
vi.mock("../server/services/preview.js", () => ({
  stopPreview: h.stopPreview,
  startPreview: async () => "",
  stopAllPreviews: () => {},
}));
vi.mock("../server/services/publish.js", () => ({ publishTask: h.publishTask }));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));

// DATA_DIR temporário ANTES de importar store/máquina (o config lê o env no import).
const TMP = mkdtempSync(join(tmpdir(), "inhouse-machine-"));
process.env.INHOUSE_DATA_DIR = join(TMP, "data");
process.env.INHOUSE_PROJECTS_DIR = join(TMP, "projects");

const store = await import("../server/store.js");
const { applyAction, startTask } = await import("../server/workflow/machine.js");
const { MAX_GATE_FIX_ROUNDS } = await import("../server/config.js");
const coleta = await import("../server/eval/coleta.js");

const project: Project = {
  id: "p1",
  name: "demo",
  kind: "app",
  path: join(TMP, "repo"),
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
};

beforeAll(() => {
  store.load();
  store.addProject(project);
});

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.gateRuns = 0;
  h.state.execFilesTouched = true;
  h.state.publishCalls.length = 0;
  h.state.stopPreviewCalls.length = 0;
  h.state.abortCalls.length = 0;
  h.state.gatesOk = true;
  h.state.planFails = false;
  h.state.espacoFails = false;
  h.state.publishFails = false;
  h.state.publishPrUrl = undefined;
  h.state.planText = "1. Editar App.tsx\n2. Ajustar estilos";
});

async function esperaStep(taskId: string, step: Task["step"]): Promise<Task> {
  await vi.waitFor(() => {
    expect(store.getTask(taskId)?.step).toBe(step);
  }, { timeout: 3000 });
  return store.getTask(taskId)!;
}

/** Cria a tarefa e espera o pipeline automático parar na aprovação do plano. */
async function criaTaskEmAprovacao(titulo = "Nova tarefa"): Promise<Task> {
  const t = await startTask("p1", titulo, "Descrição da tarefa de teste");
  return esperaStep(t.id, "aprovacao");
}

/** Leva uma tarefa nova até o passo "teste" (plano aprovado + gates ok). */
async function ateTeste(): Promise<Task> {
  h.state.gatesOk = true;
  const t = await criaTaskEmAprovacao();
  await applyAction(t.id, { action: "approve_plan" });
  return esperaStep(t.id, "teste");
}

describe("machine: pipeline automático", () => {
  it("startTask percorre espec → plano e para em aprovação com o plano salvo", async () => {
    const criada = await startTask("p1", "Botão de exportar", "Quero exportar em CSV");
    // O espaço é criado antes do pipeline começar.
    expect(criada.worktreePath).not.toBe("");
    expect(criada.branch).toMatch(/^tarefa\//);
    expect(criada.espaco).toBeGreaterThanOrEqual(1);

    const t = await esperaStep(criada.id, "aprovacao");
    expect(t.status).toBe("aguardando");
    expect(t.spec).toContain("Espec estruturada");
    expect(t.plan).toBe(h.state.planText);
    expect(t.claudeSessionId).toBe("sess-plano");
    // Espec rodou em modo read-only e o plano em permissionMode "plan".
    expect(h.state.calls.map((c) => c.permissionMode)).toEqual(["default", "plan"]);
  });

  it("sem ExitPlanMode, o plano cai no texto final da sessão", async () => {
    h.state.planText = undefined;
    const t = await criaTaskEmAprovacao();
    expect(t.plan).toBe("texto final do plano");
  });

  it("startTask de projeto inexistente é rejeitado", async () => {
    await expect(startTask("nao-existe", "x", "y")).rejects.toThrow(/Projeto/);
  });

  it("falha ao criar o espaço deixa a tarefa 'falhou' já no startTask", async () => {
    h.state.espacoFails = true;
    const t = await startTask("p1", "Sem espaço", "desc");
    expect(t.status).toBe("falhou");
    expect(t.worktreePath).toBe("");
    expect(t.error).toContain("mock");
  });
});

describe("machine: aprovação e execução", () => {
  it("approve_plan executa com resume da sessão, roda gates e para no teste humano", async () => {
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "approve_plan" });

    const atual = await esperaStep(t.id, "teste");
    expect(atual.status).toBe("aguardando");
    expect(atual.gates).toHaveLength(1);
    expect(atual.gates[0]?.ok).toBe(true);
    expect(h.state.gateRuns).toBe(1);

    const exec = h.state.calls.find((c) => c.permissionMode === "acceptEdits");
    expect(exec?.prompt).toContain(h.state.planText); // a execução recebe o plano aprovado
    expect(exec?.resume).toBe("sess-plano"); // e retoma a mesma sessão do plano
  });

  it("request_changes na aprovação refaz o plano com o feedback", async () => {
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "request_changes", message: "quero também dark mode" });

    const depois = await esperaStep(t.id, "aprovacao");
    expect(depois.status).toBe("aguardando");
    const planos = h.state.calls.filter((c) => c.permissionMode === "plan");
    expect(planos).toHaveLength(2);
    expect(planos[1]?.prompt).toContain("quero também dark mode");
  });

  it("request_changes no teste volta para a execução e re-roda as verificações", async () => {
    const t = await ateTeste();
    const antes = h.state.calls.length;

    await applyAction(t.id, { action: "request_changes", message: "o botão ficou pequeno" });
    // Com mocks instantâneos a tarefa pode já ter passado de "execucao" aqui;
    // a prova de que a execução rodou fica nas chamadas registradas abaixo.

    const depois = await esperaStep(t.id, "teste");
    expect(depois.status).toBe("aguardando");
    const execs = h.state.calls.slice(antes).filter((c) => c.permissionMode === "acceptEdits");
    expect(execs).toHaveLength(1);
    expect(execs[0]?.prompt).toContain("o botão ficou pequeno");
    expect(h.state.gateRuns).toBe(2); // gates da ida ao teste + gates pós-mudança
  });

  it("recado no teste que NÃO mexe em código não re-roda as verificações (volta pro teste)", async () => {
    const t = await ateTeste();
    h.state.execFilesTouched = false; // ex.: "sobe o server pra mim" — o agente age, não edita
    const gatesAntes = h.state.gateRuns;

    await applyAction(t.id, { action: "request_changes", message: "sobe o server pra mim" });

    const depois = await esperaStep(t.id, "teste");
    expect(depois.status).toBe("aguardando");
    expect(h.state.gateRuns).toBe(gatesAntes); // NENHUM gate novo — não re-validou à toa
  });
});

describe("machine: verificações e retry", () => {
  it("gates falhando estouram MAX_GATE_FIX_ROUNDS, tarefa falha e retry re-roda", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false;
    await applyAction(t.id, { action: "approve_plan" });

    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 3000 });

    const falhada = store.getTask(t.id)!;
    expect(falhada.step).toBe("verificacoes");
    expect(falhada.gateFixRounds).toBe(MAX_GATE_FIX_ROUNDS);
    expect(falhada.gates[0]?.ok).toBe(false);
    expect(falhada.error).toMatch(/verificações/i);

    // Execução inicial + uma rodada de correção por tentativa.
    const execs = h.state.calls.filter((c) => c.permissionMode === "acceptEdits");
    expect(execs).toHaveLength(1 + MAX_GATE_FIX_ROUNDS);
    expect(h.state.gateRuns).toBe(1 + MAX_GATE_FIX_ROUNDS);
    // Os prompts de correção citam o erro do gate.
    expect(execs[1]?.prompt).toContain("error TS2304");

    // Retry com os gates passando leva ao teste (re-roda só as verificações).
    h.state.gatesOk = true;
    await applyAction(t.id, { action: "retry" });
    const depois = await esperaStep(t.id, "teste");
    expect(depois.status).toBe("aguardando");
  });

  it("retry após esgotar as rodadas zera gateFixRounds e tenta a auto-correção de novo", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false; // erro determinístico: gates falham sempre
    await applyAction(t.id, { action: "approve_plan" });
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 3000 });

    const execsAntes = h.state.calls.filter((c) => c.permissionMode === "acceptEdits").length;
    await applyAction(t.id, { action: "retry" });
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 3000 });

    // Sem o reset, falharia na hora com zero tentativas de correção.
    const execsDepois = h.state.calls.filter((c) => c.permissionMode === "acceptEdits").length;
    expect(execsDepois - execsAntes).toBe(MAX_GATE_FIX_ROUNDS);
  });

  it("request_changes com a tarefa falhada nas verificações volta para a execução", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false;
    await applyAction(t.id, { action: "approve_plan" });
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 3000 });

    h.state.gatesOk = true;
    const antes = h.state.calls.length;
    await applyAction(t.id, { action: "request_changes", message: "tente outra abordagem" });
    const depois = await esperaStep(t.id, "teste");
    expect(depois.status).toBe("aguardando");
    const execs = h.state.calls.slice(antes).filter((c) => c.permissionMode === "acceptEdits");
    expect(execs[0]?.prompt).toContain("tente outra abordagem");
  });

  it("plano que falha marca a tarefa como 'falhou'; retry refaz só o plano", async () => {
    h.state.planFails = true;
    const criada = await startTask("p1", "Plano ruim", "desc");

    await vi.waitFor(() => {
      expect(store.getTask(criada.id)?.status).toBe("falhou");
    }, { timeout: 3000 });
    expect(store.getTask(criada.id)?.step).toBe("plano");
    expect(store.getTask(criada.id)?.error).toBe("O plano quebrou (mock).");

    h.state.planFails = false;
    const antes = h.state.calls.length;
    await applyAction(criada.id, { action: "retry" });
    const t = await esperaStep(criada.id, "aprovacao");
    expect(t.plan).toBe(h.state.planText);
    // Retry do plano não repete a espec.
    expect(h.state.calls.slice(antes).map((c) => c.permissionMode)).toEqual(["plan"]);
  });
});

describe("machine: teste, publicação e cancelamento", () => {
  it("fluxo completo: approve_test → publish → concluída (com PR)", async () => {
    h.state.publishPrUrl = "https://github.com/example/app/pull/7";
    const t = await ateTeste();

    await applyAction(t.id, { action: "approve_test" });
    expect(store.getTask(t.id)?.step).toBe("publicar");
    expect(store.getTask(t.id)?.status).toBe("aguardando");

    const done = await applyAction(t.id, { action: "publish", createPr: true });
    expect(done.step).toBe("concluida");
    // Eval: terminal gera exatamente 1 registro "concluida" com prCriado.
    const linhas = coleta
      .readJsonl<{ taskId: string; desfecho: string; prCriado?: boolean }>(coleta.TAREFAS_FILE())
      .filter((l) => l.taskId === t.id);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ desfecho: "concluida", prCriado: true });
    expect(done.status).toBe("concluida");
    expect(done.prUrl).toBe("https://github.com/example/app/pull/7");
    expect(done.previewUrl).toBeUndefined();
    expect(h.state.publishCalls).toEqual([{ createPr: true }]);
  });

  it("falha na publicação vira 'falhou'; retry volta a aguardar e publicar de novo funciona", async () => {
    const t = await ateTeste();
    await applyAction(t.id, { action: "approve_test" });

    h.state.publishFails = true;
    const falhada = await applyAction(t.id, { action: "publish" });
    expect(falhada.status).toBe("falhou");
    expect(falhada.step).toBe("publicar");
    expect(falhada.error).toContain("conflito");

    // Retry num passo humano só volta a aguardar a ação da pessoa.
    const aguardando = await applyAction(t.id, { action: "retry" });
    expect(aguardando.status).toBe("aguardando");
    expect(aguardando.step).toBe("publicar");

    h.state.publishFails = false;
    const done = await applyAction(t.id, { action: "publish" });
    expect(done.status).toBe("concluida");
  });

  it("cancel para o preview, aborta a sessão do claude, mantém o espaço e não pode ser repetido", async () => {
    const t = await criaTaskEmAprovacao();
    const done = await applyAction(t.id, { action: "cancel", motivo: "Só estava testando" });
    expect(done.status).toBe("cancelada");
    // Motivo vira item do usuário no chat e entra no registro do eval.
    expect(
      store.transcriptRead(t.id).some((i) => i.kind === "user" && i.text.includes("Só estava testando")),
    ).toBe(true);
    const linhaCancel = coleta
      .readJsonl<{ taskId: string; desfecho: string; motivoCancelamento?: string }>(coleta.TAREFAS_FILE())
      .find((l) => l.taskId === t.id);
    expect(linhaCancel).toMatchObject({ desfecho: "cancelada", motivoCancelamento: "Só estava testando" });
    expect(h.state.stopPreviewCalls).toContain(t.id);
    // A sessão do Claude em andamento é abortada (não vira zumbi de 20 min).
    expect(h.state.abortCalls).toContain(t.id);
    await expect(applyAction(t.id, { action: "cancel" })).rejects.toThrow(/finalizada/);
  });
});

describe("machine: ações inválidas", () => {
  it("ações fora do estado atual são rejeitadas com mensagem clara", async () => {
    const t = await criaTaskEmAprovacao(); // está em aprovacao/aguardando
    await expect(applyAction(t.id, { action: "approve_test" })).rejects.toThrow(/teste/);
    await expect(applyAction(t.id, { action: "publish" })).rejects.toThrow(/publicar/);
    await expect(applyAction(t.id, { action: "retry" })).rejects.toThrow(/falhou/);
    await expect(
      applyAction(t.id, { action: "request_changes", message: "   " }),
    ).rejects.toThrow(/mudar/);

    const emTeste = await ateTeste();
    await expect(applyAction(emTeste.id, { action: "approve_plan" })).rejects.toThrow(/aprovação/);

    await expect(applyAction("nao-existe", { action: "approve_plan" })).rejects.toThrow(
      /não encontrada/,
    );
  });
});
