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
    removeEspacoCalls: [] as string[],
    abortCalls: [] as string[],
    execFilesTouched: true,
    // Quando true, a fase de CORREÇÃO de gates devolve "CONSERTO: impossivel"
    // (o agente declara que não resolve sozinho) em vez de seguir tentando.
    fixDesiste: false,
    prepPronto: true,
    espPorte: "media" as "simples" | "media" | "grande",
    espUi: false,
    espDesign: false,
    // Pausa: quando execHang liga, a fase acceptEdits "trava" até o abort (releaseExec)
    // e devolve falha por interrupção — simula uma fase real em andamento sendo abortada.
    execHang: false,
    abortReturns: false,
    releaseExec: undefined as undefined | (() => void),
    // Porteiras do workflow ativo (todas ligadas por padrão; um teste desliga uma).
    gates: { aprovacao: true, aprovacao_prototipo: true, teste: true },
    // Preview (mock): URL "viva" vista pelo previewStatus + registro de chamadas.
    previewUrlAtual: undefined as string | undefined,
    restartPreviewCalls: [] as string[],
    healthPathsAdicionados: [] as string[],
    // Porteira viva (mock da conversa): comportamento do turno de chat.
    conversaTrabalha: false,
    conversaPlanText: undefined as string | undefined,
    conversaTaskId: undefined as string | undefined,
    stepDuranteConversa: undefined as string | undefined,
    // Revisão da engenharia (mock)
    enviarRevisaoCalls: [] as string[],
    mergeRevisaoCalls: [] as string[],
    empurrarAjustesCalls: [] as string[],
  };
  return {
    state,
    activeGates: () => state.gates,
    async runPhase(opts: {
      permissionMode: string;
      prompt: string;
      resume?: string;
      canUseTool?: (
        tool: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal; toolUseID?: string },
      ) => Promise<unknown>;
    }) {
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
      // Porteira viva: turno de conversa (prompt neutro com o literal).
      if (/CONVERSA DA PORTEIRA/.test(opts.prompt)) {
        if (state.conversaPlanText) {
          return { sessionId: "sess-chat", finalText: "Plano revisado.", planText: state.conversaPlanText, success: true };
        }
        if (state.conversaTrabalha && opts.canUseTool) {
          // Simula o agente agindo: a 1ª ferramenta de trabalho passa pelo gate.
          await opts.canUseTool("Write", { file_path: "src/App.tsx" }, {
            signal: new AbortController().signal,
            toolUseID: "t1",
          });
          state.stepDuranteConversa = store.getTask(state.conversaTaskId ?? "")?.step;
          return { sessionId: "sess-chat", finalText: "Mudança aplicada.", success: true, filesTouched: true };
        }
        return { sessionId: "sess-chat", finalText: "Resposta da conversa.", success: true };
      }
      if (opts.permissionMode === "acceptEdits") {
        // Simula fase em andamento sendo pausada: trava até o abort e volta como interrompida.
        if (state.execHang) {
          await new Promise<void>((resolve) => {
            state.releaseExec = () => {
              state.releaseExec = undefined;
              resolve();
            };
          });
          return { sessionId: "sess-exec", success: false, errorMessage: "O passo foi interrompido." };
        }
        const ehPrep = /PREPARAR este projeto/i.test(opts.prompt);
        const ehFix = /verificações automáticas do projeto falharam/i.test(opts.prompt);
        const finalText = ehPrep
          ? `Resumo da preparação.\nPREPARADO: ${state.prepPronto ? "sim" : "nao"}`
          : ehFix && state.fixDesiste
            ? "Isso precisa de decisão sua.\nCONSERTO: impossivel — precisa de decisão de produto"
            : "Mudanças feitas.";
        return {
          sessionId: "sess-exec",
          finalText,
          success: true,
          filesTouched: state.execFilesTouched,
        };
      }
      // Fase espec (permissionMode "default", read-only) — emite os julgamentos.
      return {
        sessionId: "sess-espec",
        finalText: `## Objetivo\nEspec estruturada (mock)\nPORTE: ${state.espPorte}\nUI: ${state.espUi ? "sim" : "nao"}\nDESIGN: ${state.espDesign ? "sim" : "nao"}`,
        success: true,
      };
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
    async removeEspaco(_project: unknown, worktreePath: string) {
      state.removeEspacoCalls.push(worktreePath);
    },
  };
});

vi.mock("../server/claude/runner.js", () => ({
  runPhase: h.runPhase,
  abortPhase: (taskId: string) => {
    h.state.abortCalls.push(taskId);
    h.state.releaseExec?.(); // destrava a fase "em andamento" simulada
    return h.state.abortReturns;
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
  removeEspaco: h.removeEspaco,
  ensureDeps: async () => {},
}));
vi.mock("../server/services/preview.js", () => ({
  stopPreview: h.stopPreview,
  startPreview: async () => "",
  stopAllPreviews: () => {},
  // Superfície nova usada pela máquina (preview 10x) — defaults inertes; os
  // testes que exercitam o conserto/estado sobrescrevem via h.state.
  attemptStart: async () => "",
  aprenderReceita: () => null,
  resolvePreviewConfig: () => null,
  verificarSaude: async () => ({ ok: true }),
  previewStatus: () => ({
    status: h.state.previewUrlAtual ? "no_ar" : "parado",
    url: h.state.previewUrlAtual || undefined,
    porta: undefined,
    healthPaths: [],
    aviso: "",
  }),
  previewLogs: () => "",
  restartPreview: async (taskId: string) => {
    h.state.restartPreviewCalls?.push(taskId);
    return { url: "http://localhost:4501/" };
  },
  adicionarHealthPath: (_projectId: string, rota: string) => {
    h.state.healthPathsAdicionados?.push(rota);
    return true;
  },
}));
vi.mock("../server/services/publish.js", () => ({
  publishTask: h.publishTask,
  enviarParaRevisao: async (t: { id: string }) => {
    h.state.enviarRevisaoCalls.push(t.id);
    return { prUrl: "https://github.com/acme/app/pull/42" };
  },
  mergeRevisao: async (t: { id: string }) => {
    h.state.mergeRevisaoCalls.push(t.id);
  },
  limparAposMerge: async () => {},
  empurrarAjustesRevisao: async (t: { id: string }) => {
    h.state.empurrarAjustesCalls.push(t.id);
  },
}));
vi.mock("../server/events.js", () => ({ broadcast: () => {}, addClient: () => {} }));
// A máquina resolve as skills pelo workflow ativo; aqui testamos as transições, não
// as skills — então o workflow ativo é vazio (comportamento "sem config" original).
vi.mock("../server/workflow/library.js", () => ({ activeConfig: () => ({ skills: {} }), activeGates: h.activeGates }));

// DATA_DIR temporário ANTES de importar store/máquina (o config lê o env no import).
const TMP = mkdtempSync(join(tmpdir(), "inhouse-machine-"));
process.env.INHOUSE_DATA_DIR = join(TMP, "data");
process.env.INHOUSE_PROJECTS_DIR = join(TMP, "projects");

const store = await import("../server/store.js");
const { applyAction, aplicarSondagem, startPreparacao, startTask, steer } = await import("../server/workflow/machine.js");
const { GATE_FIX_SAFETY_ROUNDS } = await import("../server/config.js");
const coleta = await import("../server/eval/coleta.js");

const project: Project = {
  id: "p1",
  name: "demo",
  kind: "app",
  path: join(TMP, "repo"),
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
};

const projectGitHub: Project = {
  id: "p2",
  name: "demo-github",
  kind: "repo",
  path: join(TMP, "repo-gh"),
  originUrl: "https://github.com/acme/app",
  defaultBranch: "main",
  createdAt: new Date().toISOString(),
};

beforeAll(() => {
  store.load();
  store.addProject(project);
  store.addProject(projectGitHub);
});

beforeEach(() => {
  h.state.calls.length = 0;
  h.state.gateRuns = 0;
  h.state.execFilesTouched = true;
  h.state.fixDesiste = false;
  h.state.prepPronto = true;
  h.state.espPorte = "media";
  h.state.espUi = false;
  h.state.espDesign = false;
  h.state.publishCalls.length = 0;
  h.state.stopPreviewCalls.length = 0;
  h.state.removeEspacoCalls.length = 0;
  h.state.abortCalls.length = 0;
  h.state.gatesOk = true;
  h.state.planFails = false;
  h.state.espacoFails = false;
  h.state.publishFails = false;
  h.state.publishPrUrl = undefined;
  h.state.planText = "1. Editar App.tsx\n2. Ajustar estilos";
  h.state.execHang = false;
  h.state.abortReturns = false;
  h.state.releaseExec = undefined;
  h.state.gates = { aprovacao: true, aprovacao_prototipo: true, teste: true };
});

async function esperaStep(taskId: string, step: Task["step"]): Promise<Task> {
  await vi.waitFor(() => {
    expect(store.getTask(taskId)?.step).toBe(step);
  }, { timeout: 3000 });
  return store.getTask(taskId)!;
}

async function esperaStatus(taskId: string, status: Task["status"]): Promise<Task> {
  await vi.waitFor(() => {
    expect(store.getTask(taskId)?.status).toBe(status);
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

describe("machine: modo livre (sem esteira)", () => {
  it("roda sessão direta (sem espec/plano), para em aguardando; steer dispara novo turno; publica", async () => {
    const t = await startTask("p1", "Ajuste rápido", "troque o texto do botão", undefined, "livre");
    expect(t.modo).toBe("livre");
    expect(t.step).toBe("execucao"); // nasce direto na execução

    const ocioso = await esperaStatus(t.id, "aguardando");
    expect(ocioso.step).toBe("execucao");
    // Não passou pela esteira: nada de fase "plan" (espec/plano), só acceptEdits.
    expect(h.state.calls.some((c) => c.permissionMode === "plan")).toBe(false);
    expect(h.state.calls.length).toBeGreaterThanOrEqual(1);

    // Uma mensagem numa tarefa livre ociosa dispara um novo turno.
    const antes = h.state.calls.length;
    await steer(t.id, "agora deixe o texto em azul");
    await vi.waitFor(() => expect(h.state.calls.length).toBeGreaterThan(antes), { timeout: 3000 });
    await esperaStatus(t.id, "aguardando");

    // Publica direto, sem porteiras.
    const done = await applyAction(t.id, { action: "publish", createPr: false });
    expect(done.status).toBe("concluida");
    expect(h.state.publishCalls.length).toBe(1);
  });

  it("publicar antes de o turno terminar é recusado", async () => {
    h.state.execHang = true; // sessão "em andamento"
    const t = await startTask("p1", "Livre travada", "faça algo demorado", undefined, "livre");
    await esperaStatus(t.id, "rodando");
    await expect(applyAction(t.id, { action: "publish" })).rejects.toThrow(/termin/i);
    h.state.releaseExec?.(); // destrava pra não vazar
  });
});

describe("machine: pausar e retomar", () => {
  it("pausar a execução aterrissa 'pausada' (retomável), preserva a sessão e não conta falha", async () => {
    h.state.execHang = true; // a execução fica "em andamento"
    h.state.abortReturns = true; // há uma fase para abortar
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "approve_plan", direto: true }); // vai direto pra execução

    await vi.waitFor(() => {
      const x = store.getTask(t.id)!;
      expect(x.step).toBe("execucao");
      expect(x.status).toBe("rodando");
    }, { timeout: 3000 });

    await applyAction(t.id, { action: "pause" });
    expect(h.state.abortCalls).toContain(t.id);

    const pausada = await vi.waitFor(() => {
      const x = store.getTask(t.id)!;
      expect(x.status).toBe("falhou");
      expect(x.pausadaManual).toBe(true);
      return x;
    }, { timeout: 3000 });
    expect(pausada.claudeSessionId).toBe("sess-exec"); // sessão salva → retoma de onde parou
    expect(pausada.uso?.falhas ?? 0).toBe(0); // pausa não é falha no eval

    // Retomar: sem a trava, conclui a execução → verificações → teste.
    h.state.execHang = false;
    await applyAction(t.id, { action: "retry" });
    const emTeste = await esperaStep(t.id, "teste");
    expect(emTeste.status).toBe("aguardando");
    expect(emTeste.pausadaManual).toBeUndefined();
  });

  it("não dá para pausar um passo que espera por você (porteira humana)", async () => {
    const t = await criaTaskEmAprovacao(); // aprovacao / aguardando
    await expect(applyAction(t.id, { action: "pause" })).rejects.toThrow(/pausar/i);
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
  it("gates falhando sem convergir batem no teto de segurança, tarefa falha e retry re-roda", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false; // erro determinístico + agente nunca desiste → estoura o teto
    await applyAction(t.id, { action: "approve_plan" });

    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 5000 });

    const falhada = store.getTask(t.id)!;
    expect(falhada.step).toBe("verificacoes");
    expect(falhada.gateFixRounds).toBe(GATE_FIX_SAFETY_ROUNDS);
    expect(falhada.gates[0]?.ok).toBe(false);
    expect(falhada.error).toMatch(/teto de segurança/i);

    // Execução inicial + uma rodada de correção por tentativa até o teto.
    const execs = h.state.calls.filter((c) => c.permissionMode === "acceptEdits");
    expect(execs).toHaveLength(1 + GATE_FIX_SAFETY_ROUNDS);
    expect(h.state.gateRuns).toBe(1 + GATE_FIX_SAFETY_ROUNDS);
    // Os prompts de correção citam o erro do gate.
    expect(execs[1]?.prompt).toContain("error TS2304");

    // Retry com os gates passando leva ao teste (re-roda só as verificações).
    h.state.gatesOk = true;
    await applyAction(t.id, { action: "retry" });
    const depois = await esperaStep(t.id, "teste");
    expect(depois.status).toBe("aguardando");
  });

  it("o agente pode declarar que não resolve sozinho e a tarefa para na hora (sem estourar o teto)", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false;
    h.state.fixDesiste = true; // a 1ª correção devolve "CONSERTO: impossivel"
    await applyAction(t.id, { action: "approve_plan" });

    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 3000 });

    const falhada = store.getTask(t.id)!;
    expect(falhada.step).toBe("verificacoes");
    expect(falhada.error).toMatch(/não resolve sozinho|decisão de produto/i);
    // Parou na 1ª correção: NÃO ficou tentando até o teto.
    expect(falhada.gateFixRounds).toBe(0);
    expect(h.state.gateRuns).toBe(1);
    const execs = h.state.calls.filter((c) => c.permissionMode === "acceptEdits");
    expect(execs).toHaveLength(2); // execução inicial + 1 correção que desistiu
  });

  it("retry após falhar re-roda a auto-correção do zero", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.gatesOk = false; // erro determinístico: gates falham sempre
    await applyAction(t.id, { action: "approve_plan" });
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 5000 });

    const execsAntes = h.state.calls.filter((c) => c.permissionMode === "acceptEdits").length;
    await applyAction(t.id, { action: "retry" });
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.status).toBe("falhou");
    }, { timeout: 5000 });

    // O retry recomeça o loop de correção (só as verificações, sem execução inicial).
    const execsDepois = h.state.calls.filter((c) => c.permissionMode === "acceptEdits").length;
    expect(execsDepois - execsAntes).toBe(GATE_FIX_SAFETY_ROUNDS);
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

describe("machine: arquivar", () => {
  it("arquivar uma tarefa cancelada mata o worktree e marca arquivadaEm", async () => {
    const t = await criaTaskEmAprovacao("Arquivável");
    const worktree = store.getTask(t.id)!.worktreePath;
    await applyAction(t.id, { action: "cancel" });
    expect(store.getTask(t.id)?.status).toBe("cancelada");

    await applyAction(t.id, { action: "arquivar" });
    const arq = store.getTask(t.id)!;
    expect(arq.arquivadaEm).toBeTruthy();
    expect(h.state.removeEspacoCalls).toContain(worktree); // worktree liberado
    expect(h.state.stopPreviewCalls).toContain(t.id);
  });

  it("arquivar uma tarefa em andamento é recusado", async () => {
    const t = await criaTaskEmAprovacao("Em andamento"); // aprovacao/aguardando = não terminal
    await expect(applyAction(t.id, { action: "arquivar" })).rejects.toThrow(/finalizadas/i);
    expect(store.getTask(t.id)?.arquivadaEm).toBeUndefined();
  });

  it("desarquivar limpa a marca", async () => {
    const t = await criaTaskEmAprovacao("Voltar");
    await applyAction(t.id, { action: "cancel" });
    await applyAction(t.id, { action: "arquivar" });
    await applyAction(t.id, { action: "desarquivar" });
    expect(store.getTask(t.id)?.arquivadaEm).toBeUndefined();
  });
});

describe("machine: preparação do repositório", () => {
  it("startPreparacao roda no checkout principal e marca o projeto como preparado", async () => {
    store.updateProject("p1", { preparado: undefined });
    const t = await startPreparacao("p1");
    expect(t.kind).toBe("preparacao");
    expect(t.worktreePath).toBe(project.path); // no checkout principal, não num espaço
    await esperaStep(t.id, "concluida");
    expect(store.getProject("p1")?.preparado).toBeTruthy();
  });

  it("sem 'PREPARADO: sim' não marca o projeto (ainda falta algo do sistema)", async () => {
    store.updateProject("p1", { preparado: undefined });
    h.state.prepPronto = false;
    const t = await startPreparacao("p1");
    await esperaStep(t.id, "concluida");
    expect(store.getProject("p1")?.preparado).toBeUndefined();
  });
});

describe("machine: esteira de plano em fases", () => {
  it("task com design percorre detalhamento → protótipo → aprovacao_prototipo → execução", async () => {
    h.state.espPorte = "grande";
    h.state.espDesign = true;
    const t = await criaTaskEmAprovacao("Feature com jornada nova");
    expect(t.porte).toBe("grande");
    expect(t.precisaDesign).toBe(true);

    await applyAction(t.id, { action: "approve_plan" });
    const proto = await esperaStep(t.id, "aprovacao_prototipo");
    expect(proto.status).toBe("aguardando");

    await applyAction(t.id, { action: "approve_prototype" });
    await esperaStep(t.id, "teste"); // execução → verificações → teste
  });

  it("approve_plan direto pula detalhamento/protótipo e vai pra execução", async () => {
    h.state.espPorte = "grande";
    h.state.espDesign = true;
    const t = await criaTaskEmAprovacao("Direto pra execução");
    await applyAction(t.id, { action: "approve_plan", direto: true });
    await esperaStep(t.id, "teste"); // sem passar por protótipo
  });

  it("set_design=nao desliga o protótipo mesmo com precisaDesign", async () => {
    h.state.espPorte = "grande";
    h.state.espDesign = true;
    const t = await criaTaskEmAprovacao("CRUD marcado como UI");
    await applyAction(t.id, { action: "set_design", valor: "nao" });
    await applyAction(t.id, { action: "approve_plan" });
    // detalhamento (sem design) → execução → teste, sem porteira de protótipo
    await esperaStep(t.id, "teste");
  });

  it("task simples aprovada vai direto pra execução (sem detalhamento)", async () => {
    h.state.espPorte = "simples";
    const t = await criaTaskEmAprovacao("Trocar um texto");
    await applyAction(t.id, { action: "approve_plan" });
    await esperaStep(t.id, "teste");
  });
});

describe("machine: porteiras do workflow (ligar/desligar)", () => {
  it("aprovacao desligada: após o plano, segue sozinho sem parar na aprovação", async () => {
    h.state.gates.aprovacao = false;
    const t = await startTask("p1", "Sem me pedir aprovação", "Descrição da tarefa de teste");
    // Sem nenhum applyAction, chega no teste humano (a aprovação do plano foi automática).
    const emTeste = await esperaStep(t.id, "teste");
    expect(emTeste.status).toBe("aguardando");
  });

  it("teste desligado: após as verificações, vai direto para publicar (sempre humano)", async () => {
    h.state.gates.teste = false;
    const t = await criaTaskEmAprovacao("Sem me pedir teste");
    await applyAction(t.id, { action: "approve_plan" });
    // execução → verificações → (teste automático) → publicar
    const pub = await esperaStep(t.id, "publicar");
    expect(pub.status).toBe("aguardando");
  });

  it("aprovacao_prototipo desligada: task com design pula a porteira do protótipo", async () => {
    h.state.espPorte = "grande";
    h.state.espDesign = true;
    h.state.gates.aprovacao_prototipo = false;
    const t = await criaTaskEmAprovacao("Design sem aprovar protótipo");
    await applyAction(t.id, { action: "approve_plan" });
    // detalhamento → protótipo → (aprovação automática) → execução → teste
    await esperaStep(t.id, "teste");
  });
});

describe("machine: preview 10x (conserto automático e steer honesto)", () => {
  it("fix_preview dispara o conserto, registra a rota e devolve a tarefa ao teste", async () => {
    const t = await ateTeste();
    h.state.calls.length = 0;
    h.state.restartPreviewCalls.length = 0;
    h.state.healthPathsAdicionados.length = 0;

    await applyAction(t.id, { action: "fix_preview", rota: "/admin", descricao: "a tela de admin quebrou" });
    await esperaStep(t.id, "teste");
    await esperaStatus(t.id, "aguardando");

    // A fase de conserto rodou com o prompt certo, o preview foi reerguido e a
    // rota reportada entrou nos health-checks futuros do projeto.
    expect(h.state.calls.some((c) => /Diagnostique e conserte/.test(c.prompt))).toBe(true);
    expect(h.state.restartPreviewCalls).toContain(t.id);
    expect(h.state.healthPathsAdicionados).toContain("/admin");
    // Conserto bem-sucedido zera o contador (um crash futuro ganha tentativas novas).
    expect(store.getTask(t.id)?.previewFixRounds ?? 0).toBe(0);
  });

  it("crash do preview com a tarefa parada no teste dispara o conserto automático", async () => {
    const t = await ateTeste();
    h.state.calls.length = 0;
    const { previewEvents } = await import("../server/services/previewState.js");
    previewEvents.emit("crash", { taskId: t.id, logsTail: "Error: boom" });
    await vi.waitFor(() => {
      expect(h.state.calls.some((c) => /Diagnostique e conserte/.test(c.prompt))).toBe(true);
    }, { timeout: 3000 });
    await esperaStep(t.id, "teste");
    await esperaStatus(t.id, "aguardando");
  });

  it("cap de tentativas: com previewFixRounds esgotado, o crash NÃO dispara conserto", async () => {
    const t = await ateTeste();
    store.updateTask(t.id, { previewFixRounds: 2 });
    h.state.calls.length = 0;
    const { previewEvents } = await import("../server/services/previewState.js");
    previewEvents.emit("crash", { taskId: t.id, logsTail: "Error: boom" });
    await new Promise((r) => setTimeout(r, 300));
    expect(h.state.calls.some((c) => /Diagnostique e conserte/.test(c.prompt))).toBe(false);
    // A tarefa continua utilizável, parada no teste.
    expect(store.getTask(t.id)?.step).toBe("teste");
    expect(store.getTask(t.id)?.status).toBe("aguardando");
  });

  it("crash com fase RODANDO não dispara nada (o estado entra no próximo prompt)", async () => {
    const t = await ateTeste();
    store.updateTask(t.id, { status: "rodando" });
    h.state.calls.length = 0;
    const { previewEvents } = await import("../server/services/previewState.js");
    previewEvents.emit("crash", { taskId: t.id, logsTail: "" });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.state.calls.length).toBe(0);
    store.updateTask(t.id, { status: "aguardando" });
  });

  it("steer com o Claude TRABALHANDO enfileira e entrega no próximo passo", async () => {
    // Porteiras agora abrem conversa; a fila vale para fases em movimento.
    // Simula: mensagem chega ENQUANTO a execução roda (execHang) e é drenada
    // na rodada seguinte da execução.
    h.state.execHang = true;
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "approve_plan", direto: true });
    await esperaStatus(t.id, "rodando");
    await steer(t.id, "prefiro o botão em azul"); // rodando → entra na fila
    h.state.execHang = false;
    h.state.releaseExec?.(); // fase atual termina (interrompida)
    await esperaStatus(t.id, "falhou"); // interrompida vira falha
    // Retomada consome a fila na próxima execução.
    await applyAction(t.id, { action: "retry" });
    await esperaStep(t.id, "teste");
    const call = h.state.calls.find((c) => /Mensagens que o usuário enviou/.test(c.prompt));
    expect(call?.prompt).toContain("prefiro o botão em azul");
  });

  it("request_changes no teste passa o contexto do preview quando ele está no ar", async () => {
    h.state.previewUrlAtual = "http://localhost:4501/";
    const t = await ateTeste();
    h.state.calls.length = 0;
    await applyAction(t.id, { action: "request_changes", message: "o título sumiu" });
    await esperaStep(t.id, "teste");
    const call = h.state.calls.find((c) => /pediu as seguintes mudanças/.test(c.prompt));
    expect(call?.prompt).toContain("http://localhost:4501/");
    h.state.previewUrlAtual = undefined;
  });
});

describe("machine: esforço e troca de modo", () => {
  it("set_esforco grava o nível na tarefa (e rejeita nível inválido)", async () => {
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "set_esforco", nivel: "xhigh" });
    expect(store.getTask(t.id)?.esforco).toBe("xhigh");
    await expect(
      applyAction(t.id, { action: "set_esforco", nivel: "turbo" as never }),
    ).rejects.toThrow(/inválido/);
  });

  it("set_modo bloqueia com o Claude trabalhando", async () => {
    h.state.execHang = true;
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "approve_plan" });
    await esperaStatus(t.id, "rodando");
    await expect(applyAction(t.id, { action: "set_modo", modo: "livre" })).rejects.toThrow(/Espere/);
    h.state.abortReturns = true;
    await applyAction(t.id, { action: "cancel" });
    h.state.execHang = false;
    h.state.abortReturns = false;
  });

  it("esteira → livre em qualquer etapa parada: porteira vira conversa livre", async () => {
    const t = await criaTaskEmAprovacao(); // parada na aprovação do plano
    await applyAction(t.id, { action: "set_modo", modo: "livre" });
    const depois = store.getTask(t.id)!;
    expect(depois.modo).toBe("livre");
    expect(depois.step).toBe("execucao");
    expect(depois.status).toBe("aguardando");
  });

  it("livre → etapas: nada roda até o próximo pedido; o pedido vira espec → plano → aprovação", async () => {
    const t = await startTask("p1", "Tarefa livre", "Descrição inicial", undefined, "livre");
    await esperaStatus(t.id, "aguardando"); // o turno inicial do livre terminou
    await applyAction(t.id, { action: "set_modo", modo: "esteira" });
    const parada = store.getTask(t.id)!;
    expect(parada.aguardandoPedido).toBe(true);
    expect(parada.status).toBe("aguardando");

    h.state.calls.length = 0;
    await steer(t.id, "Agora quero uma tela de relatórios");
    const emAprovacao = await esperaStep(t.id, "aprovacao");
    expect(emAprovacao.aguardandoPedido).toBeUndefined();
    expect(emAprovacao.description).toBe("Agora quero uma tela de relatórios");
    expect(emAprovacao.plan).toBeTruthy();
    // Rodou espec (default) e plano (plan) — a esteira de verdade.
    expect(h.state.calls.map((c) => c.permissionMode)).toEqual(["default", "plan"]);
  });
});

describe("machine: porteira viva (conversa sem sair da etapa)", () => {
  it("pergunta no Seu teste: responde e RESTAURA o estado — etapa parada, preview intocado", async () => {
    const t = await ateTeste();
    const stops = h.state.stopPreviewCalls.length;
    h.state.calls.length = 0;

    await steer(t.id, "me dá um roteiro de testes");
    await esperaStatus(t.id, "aguardando");

    const depois = store.getTask(t.id)!;
    expect(depois.step).toBe("teste"); // nunca saiu do lugar
    const conversa = h.state.calls.find((c) => /CONVERSA DA PORTEIRA/.test(c.prompt));
    expect(conversa?.prompt).toContain("me dá um roteiro de testes");
    // Nenhuma execução/verificação disparou e o preview não foi tocado.
    expect(h.state.calls.some((c) => /pediu as seguintes mudanças/.test(c.prompt))).toBe(false);
    expect(h.state.stopPreviewCalls.length).toBe(stops);
  });

  it("trabalho no Seu teste: NÃO sai da etapa, pergunta, e as verificações ficam pendentes", async () => {
    const t = await ateTeste();
    store.updateTask(t.id, { autoAprovar: true }); // aprova o Write simulado sem porteira humana
    h.state.conversaTrabalha = true;
    h.state.conversaTaskId = t.id;
    const gatesAntes = h.state.gateRuns;

    await steer(t.id, "muda o título da home para Boas-vindas");
    await esperaStatus(t.id, "aguardando");

    // A pessoa está NO MEIO do teste: a etapa não se move nem durante o Write.
    expect(h.state.stepDuranteConversa).toBe("teste");
    const depois = store.getTask(t.id)!;
    expect(depois.step).toBe("teste");
    expect(depois.verificacoesPendentes).toBe(true);
    // NENHUMA verificação rodou sozinha — a pessoa testa primeiro.
    expect(h.state.gateRuns).toBe(gatesAntes);
    h.state.conversaTrabalha = false;
    h.state.conversaTaskId = undefined;
  });

  it("Aprovar com pendências: roda as verificações (preview no ar) e segue para publicar", async () => {
    const t = await ateTeste();
    store.updateTask(t.id, { autoAprovar: true });
    h.state.conversaTrabalha = true;
    h.state.conversaTaskId = t.id;
    await steer(t.id, "ajusta o rodapé");
    await esperaStatus(t.id, "aguardando");
    h.state.conversaTrabalha = false;
    h.state.conversaTaskId = undefined;
    const gatesAntes = h.state.gateRuns;

    await applyAction(t.id, { action: "approve_test" });
    const pub = await esperaStep(t.id, "publicar");
    expect(pub.status).toBe("aguardando");
    expect(h.state.gateRuns).toBeGreaterThan(gatesAntes); // a porteira de segurança rodou
    expect(store.getTask(t.id)?.verificacoesPendentes).toBeUndefined();
  });

  it("Rodar verificações agora: verifica com o preview no ar e volta pro teste", async () => {
    const t = await ateTeste();
    store.updateTask(t.id, { autoAprovar: true });
    h.state.conversaTrabalha = true;
    h.state.conversaTaskId = t.id;
    await steer(t.id, "ajusta o cabeçalho");
    await esperaStatus(t.id, "aguardando");
    h.state.conversaTrabalha = false;
    h.state.conversaTaskId = undefined;
    const stops = h.state.stopPreviewCalls.length;

    await applyAction(t.id, { action: "rodar_verificacoes" });
    await esperaStep(t.id, "teste");
    await esperaStatus(t.id, "aguardando");
    expect(store.getTask(t.id)?.verificacoesPendentes).toBeUndefined();
    expect(h.state.stopPreviewCalls.length).toBe(stops); // preview nunca caiu
  });

  it("pergunta na aprovação: plano intacto, sem replano", async () => {
    const t = await criaTaskEmAprovacao();
    const planoAntes = store.getTask(t.id)?.plan;
    h.state.calls.length = 0;

    await steer(t.id, "você considerou acessibilidade?");
    await esperaStatus(t.id, "aguardando");

    const depois = store.getTask(t.id)!;
    expect(depois.step).toBe("aprovacao");
    expect(depois.plan).toBe(planoAntes);
    // Não houve fase de plano (permissionMode "plan") — só a conversa.
    expect(h.state.calls.every((c) => c.permissionMode !== "plan")).toBe(true);
  });

  it("ajuste na aprovação: ExitPlanMode revisa o plano e CONTINUA aguardando aprovação", async () => {
    const t = await criaTaskEmAprovacao();
    h.state.conversaPlanText = "1. Novo passo A\n2. Novo passo B";

    await steer(t.id, "inclui exportação em PDF no plano");
    await vi.waitFor(() => {
      expect(store.getTask(t.id)?.plan).toBe("1. Novo passo A\n2. Novo passo B");
    }, { timeout: 3000 });
    const depois = store.getTask(t.id)!;
    expect(depois.step).toBe("aprovacao");
    expect(depois.status).toBe("aguardando");
    h.state.conversaPlanText = undefined;
  });

  it("pergunta numa falha de execução: explica e a falha volta com o MESMO erro", async () => {
    h.state.gatesOk = false;
    h.state.fixDesiste = true;
    const t = await criaTaskEmAprovacao();
    await applyAction(t.id, { action: "approve_plan", direto: true });
    const falhou = await esperaStatus(t.id, "falhou");
    const erroAntes = falhou.error;
    h.state.gatesOk = true; // não interfere: a conversa não roda gates
    h.state.calls.length = 0;

    await steer(t.id, "por que falhou?");
    await esperaStatus(t.id, "falhou");

    const depois = store.getTask(t.id)!;
    expect(depois.error).toBe(erroAntes); // card de falha preservado
    expect(h.state.calls.some((c) => /CONVERSA DA PORTEIRA/.test(c.prompt))).toBe(true);
    h.state.fixDesiste = false;
  });
});

describe("machine: revisão da engenharia (PR + acompanhamento + festa)", () => {
  /** Leva uma task do projeto COM GitHub até a etapa Revisão. */
  async function ateRevisao(): Promise<Task> {
    const t = await startTask("p2", "Feature revisada", "Descrição da tarefa");
    await esperaStep(t.id, "aprovacao");
    await applyAction(t.id, { action: "approve_plan", direto: true });
    await esperaStep(t.id, "teste");
    await applyAction(t.id, { action: "approve_test" });
    return esperaStep(t.id, "revisao");
  }

  it("projeto com GitHub: aprovar o teste leva à Revisão (pino desde o início)", async () => {
    const criada = await startTask("p2", "Com revisão", "Descrição");
    expect(criada.temRevisao).toBe(true); // o pino aparece desde o começo
    await esperaStep(criada.id, "aprovacao");
    await applyAction(criada.id, { action: "approve_plan", direto: true });
    await esperaStep(criada.id, "teste");
    await applyAction(criada.id, { action: "approve_test" });
    const rev = await esperaStep(criada.id, "revisao");
    expect(rev.status).toBe("aguardando");
    expect(rev.revisao).toBeUndefined(); // ainda não enviou
  });

  it("enviar_revisao abre o PR (preservando o espaço) e começa o acompanhamento", async () => {
    const t = await ateRevisao();
    await applyAction(t.id, { action: "enviar_revisao" });
    const depois = store.getTask(t.id)!;
    expect(h.state.enviarRevisaoCalls).toContain(t.id);
    expect(depois.prUrl).toBe("https://github.com/acme/app/pull/42");
    expect(depois.revisao?.estado).toBe("aguardando");
    expect(depois.step).toBe("revisao");
    // O espaço NÃO foi removido (o loop de ajustes precisa dele até o merge).
    expect(h.state.removeEspacoCalls.length).toBe(0);
  });

  it("sondagem: ajustes pedidos → 'Pedir para o Claude ajustar' empurra pro PR", async () => {
    const t = await ateRevisao();
    await applyAction(t.id, { action: "enviar_revisao" });
    aplicarSondagem(t.id, {
      estado: "mudancas_pedidas",
      eventos: [{ chave: "review:joao:1:CHANGES_REQUESTED", texto: '✋ joao pediu ajustes: "usa o nome do cadastro"' }],
      pendencias: [{ autor: "joao", arquivo: "src/email.ts", texto: "usa o nome do cadastro" }],
    });
    expect(store.getTask(t.id)?.revisao?.estado).toBe("mudancas_pedidas");

    h.state.calls.length = 0;
    await applyAction(t.id, { action: "ajustar_revisao" });
    await esperaStatus(t.id, "aguardando");
    const depois = store.getTask(t.id)!;
    // O agente rodou com os apontamentos, os gates passaram e o push aconteceu.
    expect(h.state.calls.some((c) => /revisou o seu trabalho/.test(c.prompt))).toBe(true);
    expect(h.state.empurrarAjustesCalls).toContain(t.id);
    expect(depois.step).toBe("revisao");
    expect(depois.revisao?.pendencias).toEqual([]);
    expect(depois.revisao?.estado).toBe("aguardando");
  });

  it("aprovada → Publicar (merge) → 🚀 concluída com quem publicou", async () => {
    const t = await ateRevisao();
    await applyAction(t.id, { action: "enviar_revisao" });
    aplicarSondagem(t.id, {
      estado: "aprovada",
      eventos: [{ chave: "review:joao:2:APPROVED", texto: "✔ joao aprovou a revisão." }],
      pendencias: [],
    });
    const aprovada = store.getTask(t.id)!;
    expect(aprovada.step).toBe("publicar");
    expect(aprovada.status).toBe("aguardando");

    await applyAction(t.id, { action: "publish" });
    const fim = await esperaStatus(t.id, "concluida");
    expect(h.state.mergeRevisaoCalls).toContain(t.id);
    expect(fim.revisao?.mergePor).toBe("você");
    expect(fim.revisao?.mergeEm).toBeTruthy();
  });

  it("o TIME mergeou direto no GitHub: a sondagem conclui com a mesma festa", async () => {
    const t = await ateRevisao();
    await applyAction(t.id, { action: "enviar_revisao" });
    aplicarSondagem(t.id, {
      estado: "aprovada",
      merged: { por: "joao", em: "2026-08-14T12:00:00.000Z" },
      eventos: [],
      pendencias: [],
    });
    const fim = await esperaStatus(t.id, "concluida");
    expect(fim.revisao?.mergePor).toBe("joao");
    expect(fim.revisao?.mergeEm).toBe("2026-08-14T12:00:00.000Z");
    expect(h.state.mergeRevisaoCalls).not.toContain(t.id); // ninguém re-mergeou
  });

  it("PR fechado sem merge: volta pro Seu teste com explicação (sem beco)", async () => {
    const t = await ateRevisao();
    await applyAction(t.id, { action: "enviar_revisao" });
    aplicarSondagem(t.id, { estado: "aguardando", fechadoSemMerge: true, eventos: [], pendencias: [] });
    const depois = store.getTask(t.id)!;
    expect(depois.step).toBe("teste");
    expect(depois.status).toBe("aguardando");
    expect(depois.revisao).toBeUndefined();
  });
});
