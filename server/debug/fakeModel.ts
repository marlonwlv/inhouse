/**
 * O "modelo fake": substitui runPhase (o único funil de LLM) por respostas
 * instantâneas com as linhas-marcador que a máquina de estados espera
 * (PORTE/UI/DESIGN, plano via planText, VEREDITO, PREPARADO). Também fornece os
 * resultados canned dos gates de projeto. Ligado por INHOUSE_FAKE_MODEL.
 *
 * A máquina de estados roda de VERDADE — só o LLM e o I/O pesado são fingidos.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult, TranscriptItem } from "../../shared/types.js";
import type { PhaseResult, RunPhaseOpts } from "../claude/runner.js";
import { broadcast } from "../events.js";
import { slugify } from "../services/worktrees.js";
import * as store from "../store.js";
import { fakeDelayMs } from "./flag.js";
import { DEFAULT_SCENARIO } from "./scenarios.js";
import type { DebugScenario } from "./scenarios.js";

interface Binding {
  scenario: DebugScenario;
  /** Quantas vezes a fase de verificações já rodou (gate stub + veredito de skill). */
  verifyPass: number;
}

const bindings = new Map<string, Binding>();
/** Cenário "pendente", reivindicado pelo primeiro taskId novo que chegar no fake. */
let pending: DebugScenario | undefined;

/** Marca o cenário do próximo task a ser criado (chamar ANTES de startTask). */
export function activate(scenario: DebugScenario): void {
  pending = scenario;
}

/** Liga explicitamente um task a um cenário (idempotente; não zera contadores). */
export function bindTask(taskId: string, scenario: DebugScenario): void {
  if (!bindings.has(taskId)) bindings.set(taskId, { scenario, verifyPass: 0 });
}

/** Limpa todo o estado de ligação (usado entre execuções do runner). */
export function resetBindings(): void {
  bindings.clear();
  pending = undefined;
}

function bindingFor(taskId: string): Binding {
  let b = bindings.get(taskId);
  if (!b) {
    const scenario = pending ?? DEFAULT_SCENARIO;
    pending = undefined;
    b = { scenario, verifyPass: 0 };
    bindings.set(taskId, b);
  }
  return b;
}

function now(): string {
  return new Date().toISOString();
}

function emit(taskId: string, item: TranscriptItem): void {
  store.transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

async function delay(): Promise<void> {
  const ms = fakeDelayMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

const PLANO_PADRAO = ["1. Fazer a mudança principal.", "2. Ajustar o que for necessário.", "3. Explicar o resultado."].join("\n");

function especText(s: DebugScenario): string {
  return [
    "## Objetivo",
    `Cenário de debug: ${s.label}.`,
    "## O que muda",
    "- (simulado pelo modo debug)",
    "## Fora do escopo",
    "- (simulado)",
    "## Critérios de aceite",
    "- A esteira percorre os estados esperados.",
    "",
    ...julgamentoLines(s),
  ].join("\n");
}

function julgamentoLines(s: DebugScenario): string[] {
  return [`PORTE: ${s.porte}`, `UI: ${s.ui ? "sim" : "nao"}`, `DESIGN: ${s.design ? "sim" : "nao"}`];
}

/** A skill-gate (/review, /qa) reprova nesta passada? */
function vereditoReprova(s: DebugScenario, verifyPass: number): boolean {
  if (s.skillGateVeredito === "reprovado") return true;
  if (s.skillGateVeredito === "reprovado-once") return verifyPass <= 1;
  return false;
}

/** Páginas do protótipo fake — VÁRIAS telas ligadas entre si (links relativos). */
const MOCKUP_PAGINAS = [
  { arq: "index.html", titulo: "Início", corpo: "Tela principal do protótipo (debug). Navegue pelas telas no menu acima." },
  { arq: "detalhes.html", titulo: "Detalhes", corpo: "Segunda tela — detalhe de um item (debug)." },
  { arq: "config.html", titulo: "Configurações", corpo: "Terceira tela — configurações (debug)." },
];

function mockupHtml(titulo: string, corpo: string): string {
  const nav = MOCKUP_PAGINAS.map((p) => `<a href="${p.arq}">${p.titulo}</a>`).join(" · ");
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo} — mockup (debug)</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#18181b}header{padding:14px 20px;border-bottom:1px solid #e5e5e5;background:#fafafa}nav a{margin-right:8px;color:#2563eb;text-decoration:none}main{padding:28px 22px;max-width:720px}h1{font-size:22px}.foot{margin-top:28px;color:#71717a;font-size:13px}</style></head>
<body><header><nav>${nav}</nav></header><main><h1>${titulo}</h1><p>${corpo}</p>
<p class="foot">Mockup <b>multi-página</b> do modo debug — clique nos links do menu para navegar entre as telas.</p></main></body></html>`;
}

/** Protótipo: grava mockups reais (multi-página) onde a rota /mockup os serve. */
async function escreveMockup(taskId: string, cwd: string): Promise<void> {
  const task = store.getTask(taskId);
  const slug = slugify(task?.title ?? "tarefa");
  const dir = join(cwd, "docs", "plans", "mockups", slug);
  await mkdir(dir, { recursive: true });
  for (const p of MOCKUP_PAGINAS) {
    await writeFile(join(dir, p.arq), mockupHtml(p.titulo, p.corpo));
  }
}

/** Execução com gates REAIS: grava um arquivo TS válido para o tsc ter o que checar. */
async function escreveArquivoValido(cwd: string): Promise<void> {
  const conteudo = `export const DEBUG_TOUCH = ${JSON.stringify(now())};\n`;
  try {
    await writeFile(join(cwd, "src", "debug-touch.ts"), conteudo);
  } catch {
    await writeFile(join(cwd, "debug-touch.ts"), conteudo);
  }
}

/**
 * Classifica a fase a partir das opções do runner e devolve um PhaseResult canned.
 * Regras de classificação (mesmos sinais que a máquina usa):
 *  - permissionMode "default"                         → espec (triagem read-only)
 *  - "plan" + prompt começa com "/"                   → review de plano (skill)
 *  - "plan" + resto                                   → plano/detalhamento (consolidação)
 *  - "acceptEdits" + "PREPARAR este projeto"          → preparação do repo
 *  - "acceptEdits" + "protótipo"                      → protótipo (grava mockup)
 *  - "acceptEdits" + prompt começa com "/"            → skill-gate (veredito)
 *  - "acceptEdits" + resto                            → execução / correção de gates
 */
export async function fakeRunPhase(opts: RunPhaseOpts): Promise<PhaseResult> {
  const b = bindingFor(opts.taskId);
  const s = b.scenario;
  await delay();
  const sessionId = "fake-sess";
  const mode = opts.permissionMode;
  const prompt = opts.prompt;
  const comecaComBarra = prompt.trimStart().startsWith("/");

  // Porteira viva: turno de conversa (qualquer permissionMode) — responde no
  // chat sem tocar em nada; a esteira restaura o estado (transição por ação
  // nunca dispara no fake).
  if (/CONVERSA DA PORTEIRA/.test(prompt)) {
    emit(opts.taskId, { kind: "assistant", text: "Resposta da conversa (debug).", at: now() });
    return { sessionId, success: true, finalText: "Resposta da conversa (debug)." };
  }

  if (mode === "default") {
    emit(opts.taskId, { kind: "assistant", text: "Especificação estruturada (debug).", at: now() });
    return { sessionId, success: true, finalText: especText(s) };
  }

  if (mode === "plan") {
    if (comecaComBarra) {
      emit(opts.taskId, { kind: "assistant", text: "Review de plano concluído (debug).", at: now() });
      return { sessionId, success: true, finalText: "Review de plano (debug)." };
    }
    emit(opts.taskId, { kind: "assistant", text: "Plano pronto para aprovação (debug).", at: now() });
    return {
      sessionId,
      success: true,
      planText: s.plan ?? PLANO_PADRAO,
      finalText: julgamentoLines(s).join("\n"),
    };
  }

  // acceptEdits
  if (/PREPARAR este projeto/i.test(prompt)) {
    emit(opts.taskId, { kind: "assistant", text: "Preparação do projeto concluída (debug).", at: now() });
    return {
      sessionId,
      success: true,
      finalText: `Resumo da preparação (debug).\nPREPARADO: ${s.prepPronto ? "sim" : "nao"}`,
      filesTouched: true,
    };
  }

  // Skill-gate ANTES do protótipo: gates começam com "/" e o protótipo nunca —
  // assim um args de skill que por acaso contenha "protótipo" não é mal-classificado.
  if (comecaComBarra) {
    const reprova = vereditoReprova(s, b.verifyPass);
    emit(opts.taskId, { kind: "assistant", text: `Skill-gate ${reprova ? "reprovou" : "passou"} (debug).`, at: now() });
    return {
      sessionId,
      success: true,
      finalText: reprova
        ? "Verificação de skill (debug).\nVEREDITO: REPROVADO — ajuste simulado necessário (debug)"
        : "Verificação de skill (debug).\nVEREDITO: APROVADO",
    };
  }

  if (/prot[óo]tipo/i.test(prompt)) {
    await escreveMockup(opts.taskId, opts.cwd);
    emit(opts.taskId, { kind: "tool", op: "+", label: "Criar mockup do protótipo (debug)", at: now() });
    return { sessionId, success: true, finalText: "Protótipo pronto — abra o index.html (debug).", filesTouched: true };
  }

  // Execução (ou rodada de correção de gates).
  const touched = s.execFilesTouched ?? true;
  if (s.gates === "real" && touched) await escreveArquivoValido(opts.cwd);
  emit(opts.taskId, { kind: "tool", op: "✎", label: "Aplicar mudanças (debug)", at: now() });
  emit(opts.taskId, { kind: "assistant", text: "Mudanças aplicadas (debug).", at: now() });
  return { sessionId, success: true, finalText: "Mudanças feitas (debug).", filesTouched: touched };
}

/**
 * Resultados canned dos gates de PROJETO (typecheck/lint/test) por cenário.
 * Retorna null quando o cenário pede gates REAIS (aí o runGates roda de verdade).
 */
export function fakeGateResults(taskId: string): GateResult[] | null {
  const b = bindings.get(taskId);
  if (!b) return null;
  const s = b.scenario;
  // Conta a passada ANTES de decidir sobre gates reais, para o contador ficar
  // consistente mesmo em cenários "real" (a skill-gate reprovado-once lê ele).
  b.verifyPass++;
  if (s.gates === "real") return null;
  const falha = s.gates === "stub-fail-always" || (s.gates === "stub-fail-once" && b.verifyPass === 1);
  return [
    falha
      ? { name: "TypeScript", command: "npm run typecheck", ok: false, output: "erro simulado do modo debug: TS0000", durationMs: 1 }
      : { name: "TypeScript", command: "npm run typecheck", ok: true, durationMs: 1 },
  ];
}
