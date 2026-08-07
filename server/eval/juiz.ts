/**
 * Relatório de experiência (Claude-juiz). Contexto 100% pré-computado em código
 * — o juiz não explora nada: recebe agregados + trechos crus selecionados e
 * devolve markdown com rubrica fechada + um bloco JSON de aprendizados.
 * Gatilho automático a cada EVAL_AUTO_A_CADA tarefas finalizadas sem análise.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EVAL_AUTO_A_CADA, RELATORIOS_DIR } from "../config.js";
import { claudeStatus, runPhase } from "../claude/runner.js";
import { broadcast } from "../events.js";
import {
  APRENDIZADOS_FILE,
  RELATORIOS_INDEX,
  TAREFAS_FILE,
  readJsonl,
  registrarRelatorio,
} from "./coleta.js";
import type { RegistroAprendizado, RegistroRelatorio, RegistroTarefa } from "./registro.js";
import { aprendizadosOrdenados, calcularResumo, feedbackPorTarefa } from "./resumo.js";

const MAX_TAREFAS_CONTEXTO = 40;
const MAX_TRECHOS = 12;

let gerando = false;
let cooldownAte = 0;

function min(ms: number | null): string {
  if (ms === null) return "sem dados";
  return `${Math.round(ms / 60_000)} min`;
}

/** Prioriza para inspeção detalhada: canceladas > feedback ruim > mais falhas > mais pedidos. */
function priorizar(tarefas: RegistroTarefa[]): RegistroTarefa[] {
  const fb = feedbackPorTarefa();
  const peso = (t: RegistroTarefa): number =>
    (t.desfecho === "cancelada" ? 100 : 0) +
    (fb.get(t.taskId)?.nota === "ruim" ? 50 : 0) +
    (t.uso?.falhas ?? 0) * 10 +
    t.pedidosMudanca.length;
  return [...tarefas].sort((a, b) => peso(b) - peso(a)).slice(0, MAX_TRECHOS);
}

function secaoResumoExecutivoAnterior(): string {
  const idx = readJsonl<RegistroRelatorio>(RELATORIOS_INDEX());
  const ultimo = idx.at(-1);
  if (!ultimo) return "(não há análise anterior)";
  const caminho = join(RELATORIOS_DIR, ultimo.arquivo);
  if (!existsSync(caminho)) return "(não há análise anterior)";
  const md = readFileSync(caminho, "utf8");
  const m = /## Resumo executivo\s*([\s\S]*?)(?:\n## |$)/.exec(md);
  return m ? m[1]!.trim() : "(análise anterior sem resumo executivo)";
}

export function montarContextoJuiz(): string {
  const resumo = calcularResumo();
  const tarefas = readJsonl<RegistroTarefa>(TAREFAS_FILE()).slice(-MAX_TAREFAS_CONTEXTO);
  const fb = feedbackPorTarefa();

  const linhas: string[] = [];
  linhas.push("# Dados de experiência do Inhouse\n");
  linhas.push("## Métricas norte");
  linhas.push(
    `- Tarefas publicadas SEM resgate: ${resumo.taxaSemResgate.publicadasSemResgate} de ${resumo.taxaSemResgate.finalizadas} finalizadas`,
  );
  linhas.push(`- Tempo mediano esperando o humano: ${min(resumo.tempoHumanoMedianoMs)}`);
  linhas.push(`- Tempo mediano de máquina: ${min(resumo.tempoMaquinaMedianoMs)}\n`);
  linhas.push("## Agregados");
  linhas.push(`- Concluídas: ${resumo.concluidas} | Canceladas: ${resumo.canceladas} | Paradas em falha: ${resumo.paradasEmFalhou}`);
  linhas.push(
    `- Permissões: ${resumo.permissoes.total} (espera mediana ${min(resumo.permissoes.esperaMedianaMs)}, ${resumo.permissoes.timeouts} timeouts, ${resumo.permissoes.autoPct}% no modo auto)`,
  );
  linhas.push(`- Verificação que mais reprova: ${resumo.gateMaisReprova ?? "nenhuma"}`);
  linhas.push(`- Custo total (subscription): US$ ${resumo.custoTotalUsd}`);
  linhas.push(`- Feedback: 😃 ${resumo.feedback.otimo} · 😐 ${resumo.feedback.ok} · 😖 ${resumo.feedback.ruim}`);
  linhas.push(`- Tarefas sem dados de tempo (antigas): ${resumo.semDadosDeTempo}\n`);

  linhas.push("## Casos para inspecionar (trechos crus)");
  for (const t of priorizar(tarefas)) {
    linhas.push(`\n### ${t.titulo} — ${t.desfecho}${t.origem ? " (histórico)" : ""}`);
    if (t.motivoCancelamento) linhas.push(`- Motivo do cancelamento: "${t.motivoCancelamento}"`);
    if (t.porte) linhas.push(`- Porte: ${t.porte}${t.temUi !== undefined ? ` · UI: ${t.temUi ? "sim" : "não"}` : ""}`);
    if (t.pausadaPorTempo) linhas.push("- Passou de 1h em alguma etapa.");
    if ((t.uso?.triagemCurta)) linhas.push("- Triagem inicial ficou curta (re-julgamento pós-plano).");
    for (const pm of t.pedidosMudanca) linhas.push(`- Pediu mudança (${pm.etapa}): "${pm.texto}"`);
    for (const e of t.uso?.ultimosErros ?? []) linhas.push(`- Erro visto: "${e}"`);
    const f = fb.get(t.taskId);
    if (f?.texto) linhas.push(`- Feedback ${f.nota}: "${f.texto}"`);
  }

  linhas.push("\n## Resumo executivo da análise anterior");
  linhas.push(secaoResumoExecutivoAnterior());
  return linhas.join("\n");
}

function promptJuiz(contexto: string): string {
  return [
    "Você é o avaliador de experiência do Inhouse, um app builder usado por pessoas NÃO técnicas",
    "que criam e alteram software conversando com o Claude numa esteira",
    "(espec → plano → aprovação → execução → verificações → teste → publicar).",
    "",
    "Analise APENAS os dados abaixo. NÃO invente números; se um dado faltar, diga 'sem dados' (não zero).",
    "Escreva em português simples, sem jargão técnico — o leitor é o dono do produto, não um engenheiro.",
    "",
    "Produza markdown com EXATAMENTE estes títulos, nesta ordem:",
    "## Resumo executivo",
    "(no máximo 5 linhas: o estado da experiência e o atrito nº 1)",
    "## Atritos ranqueados",
    "(cada atrito: evidência numérica + UMA citação literal do usuário entre aspas + em que etapa da esteira ele dói)",
    "## Comparação com a análise anterior",
    "(melhorou ou piorou desde o resumo anterior; se não houver anterior, diga isso)",
    "## Recomendações",
    "(cada uma acionável e endereçada: mudança na config inhouse.config.json, no prompt de uma fase,",
    "na interface, ou num limite como o timeout de permissão — diga o ganho esperado)",
    "",
    "Ao final, adicione um bloco de código ```json com a lista de aprendizados duráveis, no formato:",
    '{"aprendizados": [{"chave": "kebab-case-curto", "insight": "frase", "severidade": 1-5, "evidencia": "número ou citação"}]}',
    "A chave identifica o atrito de forma estável (o mesmo problema em análises futuras deve reusar a mesma chave).",
    "",
    "----- DADOS -----",
    contexto,
  ].join("\n");
}

/** Extrai e mescla o bloco de aprendizados (dedupe por chave; reincidência → ocorrencias++). */
function mesclarAprendizados(finalText: string): void {
  const m = /```json\s*([\s\S]*?)```/.exec(finalText);
  if (!m) return;
  let parsed: { aprendizados?: { chave?: string; insight?: string; severidade?: number; evidencia?: string }[] };
  try {
    parsed = JSON.parse(m[1]!.trim());
  } catch {
    return;
  }
  const existentes = new Map(aprendizadosOrdenados().map((a) => [a.chave, a]));
  const ts = new Date().toISOString();
  for (const a of parsed.aprendizados ?? []) {
    if (!a.chave || !a.insight) continue;
    const chave = String(a.chave).slice(0, 60);
    const anterior = existentes.get(chave);
    const registro: RegistroAprendizado = {
      v: 1,
      ts,
      chave,
      insight: String(a.insight).slice(0, 300),
      severidade: Math.min(5, Math.max(1, Number(a.severidade) || 3)),
      ...(a.evidencia ? { evidencia: String(a.evidencia).slice(0, 200) } : {}),
      ocorrencias: (anterior?.ocorrencias ?? 0) + 1,
    };
    // append-only com dedupe na leitura (aprendizadosOrdenados faz latest-wins)
    try {
      writeFileSync(APRENDIZADOS_FILE(), JSON.stringify(registro) + "\n", { flag: "a" });
    } catch {
      // coleta nunca derruba nada
    }
  }
}

/** Nome de arquivo do relatório a partir de um timestamp (sem chars proibidos). */
function nomeArquivo(ts: string): string {
  return `${ts.replace(/[:.]/g, "-")}-relatorio.md`;
}

export interface ResultadoRelatorio {
  ok: boolean;
  arquivo?: string;
  erro?: string;
}

export async function gerarRelatorio(origem: "manual" | "auto"): Promise<ResultadoRelatorio> {
  if (gerando) return { ok: false, erro: "Uma análise já está sendo gerada." };
  gerando = true;
  broadcast({ type: "eval_relatorio", status: "gerando" });
  try {
    const contexto = montarContextoJuiz();
    const ts = new Date().toISOString();
    const r = await runPhase({
      // Análise de fundo, sem tarefa real: não escreve transcript (o id sintético
      // nem passaria pela validação do sink). Id saneado por garantia.
      taskId: `eval-relatorio-${ts.replace(/[:.]/g, "-")}`,
      semTranscript: true,
      cwd: RELATORIOS_DIR,
      prompt: promptJuiz(contexto),
      permissionMode: "default",
      maxTurns: 2,
      disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch", "TodoWrite"],
    });
    if (!r.success || !r.finalText.includes("## Resumo executivo")) {
      const erro = r.errorMessage ?? "A análise não veio no formato esperado.";
      broadcast({ type: "eval_relatorio", status: "erro", detalhe: erro });
      if (origem === "auto") cooldownAte = Date.now() + 30 * 60_000;
      return { ok: false, erro };
    }
    const arquivo = nomeArquivo(ts);
    writeFileSync(join(RELATORIOS_DIR, arquivo), r.finalText);
    mesclarAprendizados(r.finalText);
    const tarefasAnalisadas = readJsonl<RegistroTarefa>(TAREFAS_FILE()).length;
    registrarRelatorio({
      arquivo,
      tarefasAnalisadas,
      ...(r.metricas ? { custoUsd: r.metricas.custoUsd } : {}),
    });
    broadcast({ type: "eval_relatorio", status: "pronto", arquivo });
    return { ok: true, arquivo };
  } catch (err) {
    const erro = err instanceof Error ? err.message : "Erro ao gerar a análise.";
    broadcast({ type: "eval_relatorio", status: "erro", detalhe: erro });
    if (origem === "auto") cooldownAte = Date.now() + 30 * 60_000;
    return { ok: false, erro };
  } finally {
    gerando = false;
  }
}

export function estaGerando(): boolean {
  return gerando;
}

/**
 * Gatilho automático (chamado após cada terminal): sem contador persistido —
 * conta tarefas finalizadas mais novas que o último relatório. Restart-proof.
 */
export function verificarGatilhoAuto(): void {
  void (async () => {
    try {
      if (gerando || Date.now() < cooldownAte) return;
      const tarefas = readJsonl<RegistroTarefa>(TAREFAS_FILE());
      const idx = readJsonl<RegistroRelatorio>(RELATORIOS_INDEX());
      const desdeUltimo = idx.at(-1)?.ts ?? "";
      const novas = tarefas.filter((t) => t.ts > desdeUltimo).length;
      if (novas < EVAL_AUTO_A_CADA) return;
      if (!(await claudeStatus()).ok) {
        console.log("[eval] gatilho automático adiado: Claude offline.");
        return;
      }
      await gerarRelatorio("auto");
    } catch (err) {
      console.warn("[eval] verificarGatilhoAuto:", err instanceof Error ? err.message : err);
    }
  })();
}
