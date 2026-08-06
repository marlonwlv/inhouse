/**
 * Máquina de estados da esteira (ver ARCHITECTURE.md):
 * espec → plano → aprovacao(H) → execucao → verificacoes → teste(H) → publicar(H) → concluida
 *
 * Orquestra o runner do Claude (Agente A) e os serviços de git/gates/preview/publish
 * (Agente B). Toda transição atualiza o store e faz broadcast de task_updated.
 */
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Step, Task, TaskAction, TranscriptItem } from "../../shared/types.js";
import { STEP_LABELS, isHumanStep } from "../../shared/types.js";
import { createPermissionGate, finishAllForTask, resolvePermission } from "../claude/permissions.js";
import { abortPhase, runPhase } from "../claude/runner.js";
import { MAX_GATE_FIX_ROUNDS } from "../config.js";
import { broadcast } from "../events.js";
import { runGates } from "../services/gates.js";
import { startPreview, stopPreview } from "../services/preview.js";
import { publishTask } from "../services/publish.js";
import { createEspaco, removeEspaco, slugify } from "../services/worktrees.js";
import * as store from "../store.js";
import { marcarTriagemCurta, registrarFalha, registrarTarefaFinalizada } from "../eval/coleta.js";
import { verificarGatilhoAuto } from "../eval/juiz.js";
import { loadConfigCascata, skillsPlanoPara, temUi } from "./config.js";
import {
  changesPrompt,
  consolidarPlanoPrompt,
  especPrompt,
  execucaoPrompt,
  fixGatesPrompt,
  limparJulgamento,
  parsePorte,
  parsePreparado,
  parseUi,
  parseVeredito,
  planoFeedbackPrompt,
  planoPrompt,
  preparacaoPrompt,
  skillGatePrompt,
  skillPlanoPrompt,
} from "./phases.js";

/**
 * Opções do runner para fases que rodam SKILLS do usuário (ex.: gstack):
 * settings de usuário entram (é onde as skills moram) e o marcador de sessão
 * spawned faz as skills auto-decidirem pela recomendação em vez de perguntar.
 */
const SKILL_PHASE_OPTS = {
  settingSources: ["user", "project"] as ("user" | "project")[],
  extraEnv: { OPENCLAW_SESSION: "inhouse" },
};

/** Mensagens de steering enfileiradas por tarefa (entram no próximo resume da execução). */
const steerQueue = new Map<string, string[]>();

/** Tarefas cujo usuário pediu "ir direto ao plano" (pula a cadeia de reviews). */
const planoDireto = new Set<string>();

// ---------- Helpers ----------

function formatDur(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 1 ? `${min} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

function patch(taskId: string, p: Partial<Task>): Task {
  // Mudança de passo fecha a entrada aberta do histórico e abre a nova —
  // é daqui que a UI tira "quanto tempo cada etapa levou".
  let notaDuracao: string | undefined;
  const antes = store.getTask(taskId);
  if (p.step && antes && p.step !== antes.step) {
    const agora = new Date().toISOString();
    const hist = [...(antes.historico ?? [])];
    const aberto = hist[hist.length - 1];
    if (aberto && !aberto.fim) {
      aberto.fim = agora;
      const ms = Date.parse(agora) - Date.parse(aberto.inicio);
      if (ms >= 60_000) {
        notaDuracao = `⏱ Etapa "${STEP_LABELS[aberto.step]}" levou ${formatDur(ms)}.`;
      }
    }
    hist.push({ step: p.step, inicio: agora });
    p = { ...p, historico: hist };
  }
  const task = store.updateTask(taskId, p);
  broadcast({ type: "task_updated", task });
  if (notaDuracao) sistema(taskId, notaDuracao);
  return task;
}

function transcript(taskId: string, item: TranscriptItem): void {
  store.transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

function sistema(taskId: string, text: string): void {
  transcript(taskId, { kind: "system", text, at: new Date().toISOString() });
}

function usuario(taskId: string, text: string): void {
  transcript(taskId, { kind: "user", text, at: new Date().toISOString() });
}

function cancelada(taskId: string): boolean {
  const t = store.getTask(taskId);
  return !t || t.status === "cancelada";
}

/** Marca a tarefa como falhou com mensagem amigável (e registra no transcript). */
function fail(taskId: string, msg: string): void {
  // Uma tarefa que falha não pode carregar um "ir direto ao plano" pendente:
  // senão um clique tardio (durante a consolidação) + Retry pularia silenciosamente
  // a cadeia de reviews — furando a porteira. O Retry recomeça do fluxo normal.
  planoDireto.delete(taskId);
  registrarFalha(taskId, msg);
  patch(taskId, { status: "falhou", error: msg });
  sistema(taskId, msg);
}

/**
 * Falha de fase OU pausa amigável pelo teto de 1h: timeout não é erro — a UI
 * mostra "passo longo" com o botão "Continuar assim mesmo" (action retry).
 */
function failOuPausa(taskId: string, r: { timedOut?: boolean; errorMessage?: string }, fallback: string): void {
  if (r.timedOut) {
    patch(taskId, {
      status: "falhou",
      pausadaPorTempo: true,
      error: "Este passo está trabalhando há mais de 1 hora. Você pode deixar continuar ou pedir mudanças.",
    });
    sistema(taskId, "O passo passou de 1 hora e foi pausado por segurança — clique em \"Continuar assim mesmo\" para seguir de onde parou.");
  } else {
    fail(taskId, r.errorMessage ?? fallback);
  }
}

/**
 * Dispara um trecho do pipeline sem bloquear o request HTTP.
 * Qualquer exceção não tratada vira status "falhou" (nunca derruba o server).
 */
function fireAndForget(taskId: string, fn: () => Promise<unknown>): void {
  void fn().catch((err) => {
    console.error(`[machine] erro no pipeline da tarefa ${taskId}:`, err);
    if (cancelada(taskId)) return;
    const msg =
      err instanceof Error ? err.message : "Algo deu errado neste passo. Tente de novo.";
    try {
      fail(taskId, msg);
    } catch {
      // tarefa sumiu do store — nada a fazer
    }
  });
}

/** Consome as mensagens de steering pendentes da tarefa. */
function drainSteer(taskId: string): string[] {
  const q = steerQueue.get(taskId) ?? [];
  steerQueue.delete(taskId);
  return q;
}

/**
 * Envolve o gate de permissões do Agente A para refletir o estado na esteira:
 * enquanto o Claude espera uma decisão humana, a tarefa fica "aguardando".
 */
function gateComStatus(taskId: string): CanUseTool {
  const gate = createPermissionGate(taskId);
  return async (toolName, input, options) => {
    if (store.getTask(taskId)?.status === "rodando") {
      patch(taskId, { status: "aguardando" });
    }
    try {
      return await gate(toolName, input, options);
    } finally {
      // Só volta a "rodando" se ninguém mudou o estado nesse meio tempo (ex.: cancel).
      if (store.getTask(taskId)?.status === "aguardando") {
        patch(taskId, { status: "rodando" });
      }
    }
  };
}

/** "quando: ui" usa o julgamento DA TAREFA; sem julgamento, cai na heurística do projeto. */
function skillSeAplica(step: { quando?: "ui" }, task: Task): boolean {
  if (step.quando !== "ui") return true;
  return task.temUi ?? temUi(task.worktreePath);
}

/** Roda uma cadeia de skills de plano (na mesma sessão), registrando o que rodou. */
async function rodarSkillsPlano(
  taskId: string,
  skills: { skill: string; args?: string; quando?: "ui" }[],
): Promise<boolean> {
  for (const step of skills) {
    // Usuário clicou "ir direto ao plano": para a cadeia de reviews aqui.
    if (planoDireto.has(taskId)) return false;
    const atual = store.getTask(taskId);
    if (!atual || cancelada(taskId)) return false;
    if (!skillSeAplica(step, atual)) {
      sistema(taskId, `Pulando /${step.skill} (esta tarefa não mexe em interface).`);
      continue;
    }
    if ((atual.skillsRodadas ?? []).includes(step.skill)) continue;
    sistema(taskId, `Rodando /${step.skill}…`);
    const rs = await runPhase({
      taskId,
      cwd: atual.worktreePath,
      prompt: skillPlanoPrompt(step, atual),
      permissionMode: "plan",
      resume: atual.claudeSessionId,
      ...SKILL_PHASE_OPTS,
    });
    if (cancelada(taskId)) return false;
    const depois = store.getTask(taskId);
    if (!depois) return false;
    store.updateTask(taskId, {
      skillsRodadas: [...(depois.skillsRodadas ?? []), step.skill],
      ...(rs.sessionId ? { claudeSessionId: rs.sessionId } : {}),
    });
    if (!rs.success) {
      // Abort intencional pelo "ir direto ao plano" não é falha.
      if (planoDireto.has(taskId)) return false;
      failOuPausa(taskId, rs, `A skill /${step.skill} falhou: ${rs.errorMessage ?? "erro desconhecido"}`);
      return false;
    }
  }
  return true;
}

// ---------- Fases ----------

/** Garante que o espaço (worktree) existe — usado no início e no retry pós-falha. */
async function ensureEspaco(taskId: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  if (task.worktreePath) return true;
  const project = store.getProject(task.projectId);
  if (!project) {
    fail(taskId, "O projeto desta tarefa não foi encontrado.");
    return false;
  }
  try {
    const { branch, worktreePath } = await createEspaco(project, task.espaco, slugify(task.title));
    patch(taskId, { branch, worktreePath });
    return true;
  } catch (err) {
    fail(
      taskId,
      err instanceof Error ? err.message : "Não foi possível criar o espaço da tarefa.",
    );
    return false;
  }
}

/** Espec é best-effort: se falhar, seguimos com a description crua como spec. */
async function runEspec(taskId: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  patch(taskId, { step: "espec", status: "rodando", error: undefined });
  sistema(taskId, "Organizando o pedido em uma especificação…");

  let spec = task.description;
  try {
    const r = await runPhase({
      taskId,
      cwd: task.worktreePath,
      prompt: especPrompt(task),
      permissionMode: "default",
      maxTurns: 8,
      // Só leitura: nada de editar, rodar comandos ou sair para a internet.
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch"],
    });
    if (r.success && r.finalText.trim().length > 0) {
      spec = r.finalText.trim();
      const porte = parsePorte(spec);
      const temUiTarefa = parseUi(spec);
      store.updateTask(taskId, {
        porte,
        ...(temUiTarefa !== undefined ? { temUi: temUiTarefa } : {}),
        ...(r.sessionId ? { claudeSessionId: r.sessionId } : {}),
      });
      const uiTxt = temUiTarefa === undefined ? "" : ` · mexe em interface: ${temUiTarefa ? "sim" : "não"}`;
      sistema(
        taskId,
        porte === "simples"
          ? `Porte da tarefa: simples${uiTxt} — planejamento direto, sem reviews pesados.`
          : `Porte da tarefa: ${porte}${uiTxt}.`,
      );
    } else {
      sistema(taskId, "Não deu para estruturar a especificação — seguindo com o pedido original.");
    }
  } catch {
    sistema(taskId, "Não deu para estruturar a especificação — seguindo com o pedido original.");
  }

  if (cancelada(taskId)) return false;
  patch(taskId, { spec });
  return true;
}

/** Fase plano (permissionMode "plan"). Com feedback = re-planejamento pós request_changes. */
async function runPlano(taskId: string, feedback?: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  patch(taskId, { step: "plano", status: "rodando", error: undefined });
  sistema(taskId, feedback ? "Refazendo o plano com o seu feedback…" : "Montando o plano de implementação…");

  const projeto = store.getProject(task.projectId);
  const cfg = loadConfigCascata(task.worktreePath, projeto?.path);

  // Cadeia inicial pela triagem da espec. Feedback humano NÃO re-roda a cadeia:
  // o ajuste vai direto pra sessão (que já tem o contexto) — mas o re-julgamento
  // pós-plano abaixo pode puxar skills que ficaram faltando (ex.: virou UI).
  const cadeia = feedback ? [] : skillsPlanoPara(cfg, task.porte ?? "media");
  const rodouSkills = cadeia.length > 0;
  if (rodouSkills) {
    const chainOk = await rodarSkillsPlano(taskId, cadeia);
    // Falha real da skill derruba; abort pelo "ir direto ao plano" segue para o plano direto.
    if (!chainOk && !planoDireto.has(taskId)) return false;
    if (!planoDireto.has(taskId)) sistema(taskId, "Consolidando o plano final com o resultado dos reviews…");
  }
  // O usuário pediu "ir direto ao plano"? Consome o pedido e gera um plano enxuto.
  const rapido = planoDireto.delete(taskId);
  if (rapido) sistema(taskId, "Ok — indo direto ao plano, sem os reviews pesados.");

  // plano = o que o usuário aprova; julgamento = plano + texto final (as linhas
  // PORTE:/UI: do re-julgamento costumam vir fora do bloco do ExitPlanMode).
  const gerarPlano = async (
    prompt: string,
    comSkillOpts: boolean,
  ): Promise<{ plano: string; julgamento: string } | null> => {
    const atual = store.getTask(taskId);
    if (!atual) return null;
    const r = await runPhase({
      taskId,
      cwd: atual.worktreePath,
      prompt,
      permissionMode: "plan",
      resume: atual.claudeSessionId,
      ...(comSkillOpts ? SKILL_PHASE_OPTS : {}),
    });
    if (cancelada(taskId)) return null;
    if (r.sessionId) store.updateTask(taskId, { claudeSessionId: r.sessionId });
    if (!r.success) {
      failOuPausa(taskId, r, "Não foi possível montar o plano. Tente de novo.");
      return null;
    }
    const plano = (r.planText ?? r.finalText).trim();
    return { plano, julgamento: `${plano}\n${r.finalText}` };
  };

  let resultado = await gerarPlano(
    feedback
      ? planoFeedbackPrompt(feedback)
      : rodouSkills && !rapido
        ? consolidarPlanoPrompt()
        : planoPrompt(task),
    rodouSkills && !rapido,
  );
  if (resultado === null) return false;

  // ---- Re-julgamento pós-plano (uma rodada): o plano completo (ou o feedback
  // do usuário) pode revelar que a triagem inicial errou — ex.: "achei que não
  // tinha UI, mas tem" → roda as skills que ficaram faltando e re-consolida.
  const antes = store.getTask(taskId);
  if (antes) {
    const novoPorte = parsePorte(resultado.julgamento);
    const novoUi = parseUi(resultado.julgamento);
    const mudou =
      novoPorte !== (antes.porte ?? "media") ||
      (novoUi !== undefined && novoUi !== antes.temUi);
    if (mudou) {
      store.updateTask(taskId, {
        porte: novoPorte,
        ...(novoUi !== undefined ? { temUi: novoUi } : {}),
      });
    }
    const alvo = store.getTask(taskId);
    if (alvo) {
      const desejada = skillsPlanoPara(cfg, alvo.porte ?? "media");
      const faltando = rapido
        ? [] // usuário pediu plano direto — não puxa reviews adicionais
        : desejada.filter(
            (st) => skillSeAplica(st, alvo) && !(alvo.skillsRodadas ?? []).includes(st.skill),
          );
      if (faltando.length > 0) {
        marcarTriagemCurta(taskId);
        sistema(
          taskId,
          `O plano revelou que a triagem inicial ficou curta (porte: ${alvo.porte}${
            alvo.temUi !== undefined ? ` · interface: ${alvo.temUi ? "sim" : "não"}` : ""
          }) — rodando ${faltando.map((f) => `/${f.skill}`).join(", ")} antes da sua aprovação.`,
        );
        if (!(await rodarSkillsPlano(taskId, faltando))) return false;
        sistema(taskId, "Re-consolidando o plano com os reviews adicionais…");
        resultado = await gerarPlano(consolidarPlanoPrompt(), true);
        if (resultado === null) return false;
      }
    }
  }

  const plan = limparJulgamento(resultado.plano);
  if (plan.length === 0) {
    fail(taskId, "O plano veio vazio. Tente de novo.");
    return false;
  }
  patch(taskId, { plan, step: "aprovacao", status: "aguardando" });
  sistema(taskId, "Plano pronto — revise e aprove para começar a execução.");
  return true;
}

/** Fase execução ("acceptEdits" + gate de permissões). Ao terminar, roda as verificações. */
async function runExecucao(
  taskId: string,
  prompt: string,
  opts?: { pularVerificacaoSemEdicao?: boolean },
): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  patch(taskId, { step: "execucao", status: "rodando", error: undefined });

  // Mensagens que o usuário mandou durante a execução entram neste resume.
  const extras = drainSteer(taskId);
  const promptFinal =
    extras.length > 0
      ? `${prompt}\n\nMensagens que o usuário enviou durante a execução (leve em conta):\n${extras
          .map((t) => `- ${t}`)
          .join("\n")}`
      : prompt;

  const r = await runPhase({
    taskId,
    cwd: task.worktreePath,
    prompt: promptFinal,
    permissionMode: "acceptEdits",
    resume: store.getTask(taskId)?.claudeSessionId,
    canUseTool: gateComStatus(taskId),
  });

  if (cancelada(taskId)) return false;
  if (r.sessionId) store.updateTask(taskId, { claudeSessionId: r.sessionId });
  if (!r.success) {
    failOuPausa(taskId, r, "A execução falhou. Tente de novo.");
    return false;
  }

  // Chegaram mensagens novas enquanto o Claude trabalhava? Mais uma rodada antes de verificar.
  if ((steerQueue.get(taskId)?.length ?? 0) > 0) {
    return runExecucao(taskId, "Continue a tarefa levando em conta as mensagens do usuário abaixo.", opts);
  }
  // "Pedir mudanças" no Seu teste que não mexeu em código (ex.: "sobe o server pra mim"):
  // não re-roda as verificações à toa — volta pro teste com a resposta do agente visível.
  if (opts?.pularVerificacaoSemEdicao && !r.filesTouched) {
    sistema(taskId, "Nenhuma mudança de código — pulando as verificações.");
    patch(taskId, { step: "teste", status: "aguardando" });
    return true;
  }
  return runVerificacoes(taskId);
}

/** Fase verificações: gates do projeto + até MAX_GATE_FIX_ROUNDS rodadas de auto-correção. */
async function runVerificacoes(taskId: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  patch(taskId, { step: "verificacoes", status: "rodando", error: undefined });
  sistema(taskId, "Rodando as verificações automáticas…");

  const results = await runGates(taskId, task.worktreePath);
  if (cancelada(taskId)) return false;
  patch(taskId, { gates: results });

  // Gates de skill (ex.: /review, /qa via gstack) só rodam se os do projeto passaram —
  // não faz sentido pagar um review de código que nem compila.
  if (results.every((g) => g.ok)) {
    const projGates = store.getProject(task.projectId);
    const skillGates =
      loadConfigCascata(task.worktreePath, projGates?.path)?.skills?.verificacoes ?? [];
    const ui = temUi(task.worktreePath);
    for (const step of skillGates) {
      if (step.quando === "ui" && !ui) continue;
      const atual = store.getTask(taskId);
      if (!atual || cancelada(taskId)) return false;
      const gateName = step.gate ?? step.skill;
      sistema(taskId, `Rodando a verificação "${gateName}" (/${step.skill})…`);

      // {previewUrl} nos args → precisa do app rodando no espaço.
      let previewUrl = atual.previewUrl ?? "";
      if ((step.args ?? "").includes("{previewUrl}") && !previewUrl) {
        const project = store.getProject(atual.projectId);
        if (project) {
          try {
            previewUrl = await startPreview(atual, project);
          } catch (err) {
            sistema(
              taskId,
              `Não deu para subir o preview para a verificação "${gateName}" — pulando: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            continue;
          }
        }
      }

      const inicio = Date.now();
      const rg = await runPhase({
        taskId,
        cwd: atual.worktreePath,
        prompt: skillGatePrompt(step, atual, previewUrl),
        permissionMode: "acceptEdits",
        resume: atual.claudeSessionId,
        canUseTool: gateComStatus(taskId),
        ...SKILL_PHASE_OPTS,
      });
      if (cancelada(taskId)) return false;
      if (rg.sessionId) store.updateTask(taskId, { claudeSessionId: rg.sessionId });

      if (!rg.success && rg.timedOut) {
        failOuPausa(taskId, rg, "");
        return false;
      }
      const veredito = rg.success ? parseVeredito(rg.finalText) : { ok: false, motivo: rg.errorMessage };
      const gate = {
        name: gateName,
        command: `/${step.skill}`,
        ok: veredito.ok,
        output: veredito.ok ? undefined : (veredito.motivo ?? rg.finalText.slice(-1500)),
        durationMs: Date.now() - inicio,
      };
      const comGate = store.getTask(taskId);
      if (!comGate) return false;
      patch(taskId, { gates: [...comGate.gates, gate] });
      broadcast({ type: "gate_result", taskId, gate });
      sistema(
        taskId,
        `Verificação "${gateName}": ${veredito.ok ? "passou" : `reprovou${veredito.motivo ? ` — ${veredito.motivo}` : ""}`}`,
      );
    }
  }

  const todos = store.getTask(taskId)?.gates ?? results;
  const falhas = todos.filter((g) => !g.ok);
  if (falhas.length === 0) {
    patch(taskId, { step: "teste", status: "aguardando" });
    sistema(taskId, "Tudo verificado — pronto pro seu teste.");
    return true;
  }

  const atual = store.getTask(taskId);
  if (!atual) return false;
  if (atual.gateFixRounds < MAX_GATE_FIX_ROUNDS) {
    patch(taskId, { gateFixRounds: atual.gateFixRounds + 1 });
    sistema(
      taskId,
      `Algumas verificações falharam — tentando corrigir automaticamente (tentativa ${
        atual.gateFixRounds + 1
      } de ${MAX_GATE_FIX_ROUNDS}).`,
    );
    return runExecucao(taskId, fixGatesPrompt(atual, falhas));
  }

  fail(
    taskId,
    "As verificações continuaram falhando mesmo depois das correções automáticas. Você pode tentar de novo ou pedir mudanças.",
  );
  return false;
}

/** Pipeline automático inicial: espec → plano → para em aprovação. */
async function pipelineFromEspec(taskId: string): Promise<void> {
  if (!(await ensureEspaco(taskId))) return;
  if (!(await runEspec(taskId))) return;
  await runPlano(taskId);
}

// ---------- API pública da máquina ----------

/** Cria a tarefa, prepara o espaço e dispara o pipeline automático (espec → plano). */
export async function startTask(
  projectId: string,
  title: string,
  description: string,
): Promise<Task> {
  const project = store.getProject(projectId);
  if (!project) throw new Error("Projeto não encontrado.");

  const now = new Date().toISOString();
  const task: Task = {
    id: store.newId(),
    projectId,
    title,
    description,
    step: "espec",
    status: "rodando",
    espaco: store.nextEspaco(projectId),
    // Preenchidos logo abaixo por ensureEspaco (se falhar, a tarefa fica "falhou" e dá retry).
    branch: "",
    worktreePath: "",
    gates: [],
    gateFixRounds: 0,
    historico: [{ step: "espec" as Step, inicio: now }],
    createdAt: now,
    updatedAt: now,
  };
  store.addTask(task);
  broadcast({ type: "task_updated", task });
  usuario(task.id, description);

  const ok = await ensureEspaco(task.id);
  if (ok) {
    fireAndForget(task.id, () => pipelineFromEspec(task.id));
  }
  const atual = store.getTask(task.id);
  if (!atual) throw new Error("Tarefa não encontrada.");
  return atual;
}

/**
 * Setup guiado do repositório: uma tarefa especial (kind "preparacao") que roda
 * UMA fase no checkout PRINCIPAL do projeto (não num espaço) — sem esteira e sem
 * PR. Instala o do projeto, orienta o de sistema, e marca o projeto como pronto.
 */
export async function startPreparacao(projectId: string): Promise<Task> {
  const project = store.getProject(projectId);
  if (!project) throw new Error("Projeto não encontrado.");
  // Uma preparação em andamento já basta.
  const emAndamento = store
    .listTasks()
    .find((t) => t.projectId === projectId && t.kind === "preparacao" && t.status === "rodando");
  if (emAndamento) return emAndamento;

  const now = new Date().toISOString();
  const task: Task = {
    id: store.newId(),
    projectId,
    kind: "preparacao",
    title: "Preparar o projeto",
    description: "Preparar o ambiente do projeto para uso",
    step: "execucao",
    status: "rodando",
    espaco: 0,
    branch: project.defaultBranch,
    worktreePath: project.path, // roda no checkout principal
    gates: [],
    gateFixRounds: 0,
    historico: [{ step: "execucao" as Step, inicio: now }],
    createdAt: now,
    updatedAt: now,
  };
  store.addTask(task);
  broadcast({ type: "task_updated", task });
  sistema(task.id, "Preparando o projeto — auditando o que falta e instalando o que dá.");
  fireAndForget(task.id, () => runPreparacao(task.id));
  return task;
}

async function runPreparacao(taskId: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  patch(taskId, { step: "execucao", status: "rodando", error: undefined });

  const r = await runPhase({
    taskId,
    cwd: task.worktreePath,
    prompt: preparacaoPrompt(),
    permissionMode: "acceptEdits",
    resume: store.getTask(taskId)?.claudeSessionId,
    canUseTool: gateComStatus(taskId),
  });

  if (cancelada(taskId)) return false;
  if (r.sessionId) store.updateTask(taskId, { claudeSessionId: r.sessionId });
  if (!r.success) {
    failOuPausa(taskId, r, "A preparação falhou. Tente de novo.");
    return false;
  }

  patch(taskId, { step: "concluida", status: "concluida" });
  if (parsePreparado(r.finalText)) {
    const p = store.updateProject(task.projectId, { preparado: new Date().toISOString() });
    broadcast({ type: "project_updated", project: p });
    sistema(taskId, "Projeto preparado — já dá para criar tarefas.");
  } else {
    sistema(taskId, "Preparação concluída, mas ainda falta algo (veja o resumo acima). Rode de novo depois de resolver.");
  }
  return true;
}

/** Aplica uma ação humana, validando a transição pelo passo/status atual. */
export async function applyAction(taskId: string, action: TaskAction): Promise<Task> {
  const task = store.getTask(taskId);
  if (!task) throw new Error("Tarefa não encontrada.");

  switch (action.action) {
    case "approve_plan": {
      if (!(task.step === "aprovacao" && task.status === "aguardando")) {
        throw new Error("Esta tarefa não está aguardando a aprovação do plano.");
      }
      patch(taskId, { step: "execucao", status: "rodando", gateFixRounds: 0, error: undefined });
      sistema(taskId, "Plano aprovado — começando a execução.");
      fireAndForget(taskId, () => runExecucao(taskId, execucaoPrompt(task)));
      break;
    }

    case "request_changes": {
      const msg = action.message?.trim();
      if (!msg) throw new Error("Escreva o que você quer mudar.");
      if (task.step === "aprovacao" && task.status === "aguardando") {
        usuario(taskId, msg);
        patch(taskId, { step: "plano", status: "rodando", error: undefined });
        fireAndForget(taskId, () => runPlano(taskId, msg));
      } else if (task.step === "teste" && task.status === "aguardando") {
        usuario(taskId, msg);
        patch(taskId, { step: "execucao", status: "rodando", gateFixRounds: 0, error: undefined });
        // Recado no Seu teste = conversa/steering: se o agente não mexer em código,
        // volta pro teste sem re-rodar as verificações (não perde a resposta, não gasta minutos).
        fireAndForget(taskId, () => runExecucao(taskId, changesPrompt(msg), { pularVerificacaoSemEdicao: true }));
      } else if (
        (task.step === "execucao" || task.step === "verificacoes") &&
        task.status === "falhou"
      ) {
        // A mensagem de falha das verificações sugere "pedir mudanças" — aceita
        // aqui, voltando para a execução com a orientação do usuário.
        usuario(taskId, msg);
        patch(taskId, { step: "execucao", status: "rodando", gateFixRounds: 0, error: undefined });
        fireAndForget(taskId, () => runExecucao(taskId, changesPrompt(msg)));
      } else {
        throw new Error("Esta tarefa não está num ponto em que dá para pedir mudanças.");
      }
      break;
    }

    case "approve_test": {
      if (!(task.step === "teste" && task.status === "aguardando")) {
        throw new Error("Esta tarefa não está aguardando o seu teste.");
      }
      patch(taskId, { step: "publicar", status: "aguardando" });
      sistema(taskId, "Teste aprovado — clique em Publicar para levar as mudanças ao projeto.");
      break;
    }

    case "publish": {
      if (!(task.step === "publicar" && task.status === "aguardando")) {
        throw new Error("Esta tarefa ainda não está pronta para publicar.");
      }
      const project = store.getProject(task.projectId);
      if (!project) throw new Error("O projeto desta tarefa não foi encontrado.");
      patch(taskId, { status: "rodando", error: undefined });
      try {
        const { prUrl } = await publishTask(task, project, action.createPr ?? false);
        patch(taskId, {
          step: "concluida",
          status: "concluida",
          previewUrl: undefined,
          ...(prUrl ? { prUrl } : {}),
        });
        sistema(
          taskId,
          prUrl ? `Publicado no projeto! Pull request: ${prUrl}` : "Publicado no projeto com sucesso.",
        );
        registrarTarefaFinalizada(taskId, "concluida");
        verificarGatilhoAuto();
      } catch (err) {
        fail(taskId, err instanceof Error ? err.message : "Não foi possível publicar. Tente de novo.");
      }
      break;
    }

    case "retry": {
      if (task.status !== "falhou") {
        throw new Error("Só dá para tentar de novo quando a tarefa falhou.");
      }
      if (isHumanStep(task.step)) {
        // Falha num passo humano (ex.: publish falhou ou o server reiniciou):
        // volta a aguardar a ação da pessoa.
        patch(taskId, { status: "aguardando", error: undefined, pausadaPorTempo: undefined });
        sistema(taskId, "Pronto — a tarefa voltou a aguardar a sua ação.");
      } else if (task.step === "espec" || task.step === "plano") {
        patch(taskId, { status: "rodando", error: undefined, pausadaPorTempo: undefined });
        fireAndForget(taskId, () =>
          task.step === "espec" ? pipelineFromEspec(taskId) : runPlano(taskId),
        );
      } else if (task.step === "execucao") {
        // Zera as rodadas de correção: sem isso, um gate com erro determinístico
        // falharia de novo na hora, sem nenhuma tentativa de auto-correção.
        patch(taskId, { status: "rodando", gateFixRounds: 0, error: undefined, pausadaPorTempo: undefined });
        fireAndForget(taskId, () =>
          task.kind === "preparacao" ? runPreparacao(taskId) : runExecucao(taskId, execucaoPrompt(task)),
        );
      } else if (task.step === "verificacoes") {
        patch(taskId, { status: "rodando", gateFixRounds: 0, error: undefined, pausadaPorTempo: undefined });
        fireAndForget(taskId, () => runVerificacoes(taskId));
      } else {
        throw new Error("Este passo não pode ser re-executado.");
      }
      break;
    }

    case "auto_mode": {
      if (task.status === "concluida" || task.status === "cancelada") {
        throw new Error("Esta tarefa já foi finalizada.");
      }
      patch(taskId, { autoAprovar: action.on });
      sistema(
        taskId,
        action.on
          ? "Modo auto LIGADO — as próximas ações serão permitidas sem perguntar (tudo fica registrado aqui)."
          : "Modo auto desligado — ações sensíveis voltam a pedir sua permissão.",
      );
      if (action.on) {
        // Pedidos já na fila também são liberados.
        for (const pr of store.listPermissions().filter((pr) => pr.taskId === taskId)) {
          resolvePermission(pr.id, true);
        }
      }
      break;
    }

    case "plano_rapido": {
      if (!(task.step === "plano" && task.status === "rodando")) {
        throw new Error("Só dá para ir direto ao plano enquanto ele está sendo montado.");
      }
      planoDireto.add(taskId);
      abortPhase(taskId); // interrompe a review em andamento agora
      sistema(taskId, "Pedido recebido — pulando os reviews e indo direto ao plano.");
      break;
    }

    case "arquivar": {
      const terminal =
        task.status === "concluida" || task.status === "cancelada" || task.status === "falhou";
      if (!terminal) {
        throw new Error("Só dá para arquivar tarefas finalizadas. Cancele a tarefa antes, se precisar.");
      }
      if (!task.arquivadaEm) {
        patch(taskId, { arquivadaEm: new Date().toISOString() });
        await stopPreview(taskId);
        const project = store.getProject(task.projectId);
        if (project) {
          // Libera o espaço em disco; a branch (e o PR, se houver) ficam.
          // O worktree pode já não existir (ex.: tarefa publicada) — removeEspaco tolera.
          try {
            await removeEspaco(project, task.worktreePath, { keepBranch: true });
          } catch {
            // melhor esforço
          }
        }
        sistema(taskId, "Tarefa arquivada. O espaço foi liberado; a branch e o histórico ficam.");
      }
      break;
    }

    case "desarquivar": {
      if (!task.arquivadaEm) throw new Error("Esta tarefa não está arquivada.");
      patch(taskId, { arquivadaEm: undefined });
      sistema(taskId, "Tarefa desarquivada.");
      break;
    }

    case "cancel": {
      if (task.status === "concluida" || task.status === "cancelada") {
        throw new Error("Esta tarefa já foi finalizada.");
      }
      const motivo = action.motivo?.trim() || undefined;
      if (motivo) usuario(taskId, `Motivo do cancelamento: ${motivo}`);
      steerQueue.delete(taskId);
      // Marca cancelada ANTES de abortar: quem estiver no meio de runPhase vê
      // o status novo e não sobrescreve com "falhou".
      patch(taskId, { status: "cancelada" });
      // Encerra a sessão do Claude em andamento (mata o processo filho) e
      // resolve os pedidos de permissão pendentes (não ficam órfãos na UI).
      abortPhase(taskId);
      finishAllForTask(taskId);
      await stopPreview(taskId);
      // O espaço fica no disco para inspeção (decisão da arquitetura).
      sistema(taskId, "Tarefa cancelada. O que já foi feito fica guardado no espaço da tarefa.");
      registrarTarefaFinalizada(taskId, "cancelada", motivo);
      verificarGatilhoAuto();
      break;
    }
  }

  const atual = store.getTask(taskId);
  if (!atual) throw new Error("Tarefa não encontrada.");
  return atual;
}

/**
 * Steering: mensagem do usuário durante a execução. Sempre vai para o transcript;
 * se a execução está em andamento, entra na fila e é enviada no próximo resume.
 */
export async function steer(taskId: string, text: string): Promise<void> {
  const task = store.getTask(taskId);
  if (!task) throw new Error("Tarefa não encontrada.");
  const msg = text.trim();
  if (!msg) throw new Error("Escreva uma mensagem.");
  usuario(taskId, msg);
  if (task.step === "execucao" && (task.status === "rodando" || task.status === "aguardando")) {
    const q = steerQueue.get(taskId) ?? [];
    q.push(msg);
    steerQueue.set(taskId, q);
  }
}
