/* Inhouse — UI (vanilla ES module, sem build, sem dependências).
   Estado global alimentado por GET /api/state e mantido vivo por SSE em /api/events.
   Rotas por hash: #/ (Início) · #/tarefas (quadro) · #/tarefa/<id> (editor). */

// ---------- Constantes copiadas de shared/types.ts (manter em sincronia) ----------
const STEPS = ["espec", "plano", "aprovacao", "detalhamento", "prototipo", "aprovacao_prototipo", "execucao", "verificacoes", "teste", "publicar", "concluida"];
const STEP_LABELS = {
  espec: "Espec",
  plano: "Plano",
  aprovacao: "Sua aprovação",
  detalhamento: "Detalhamento",
  prototipo: "Protótipo",
  aprovacao_prototipo: "Aprovação do protótipo",
  execucao: "Execução",
  verificacoes: "Verificações",
  teste: "Seu teste",
  publicar: "Publicar",
  concluida: "Concluída",
};
const HUMAN_STEPS = ["aprovacao", "aprovacao_prototipo", "teste", "publicar"];

// Tooltip do stepper: o que cada etapa faz + skills que dispara. As skills espelham
// o inhouse.config.json do app-starter; `q` = condição (ex.: só grande / só com UI).
const STEP_INFO = {
  espec: { desc: "O Claude lê seu pedido e decide o tamanho da tarefa e se ela tem tela/design.", skills: [] },
  plano: { desc: "Monta o plano de produto — o QUÊ, em linguagem de gente.", skills: [{ n: "office-hours", q: "tarefas grandes" }] },
  aprovacao: { desc: "Você aprova o plano ou pede mudanças antes de investir no técnico.", skills: [], human: true },
  detalhamento: { desc: "Plano técnico e de design — o COMO da mudança.", skills: [{ n: "plan-eng-review" }, { n: "plan-design-review", q: "quando tem UI" }] },
  prototipo: { desc: "Gera mockups HTML/CSS descartáveis só pra decidir o visual.", skills: [] },
  aprovacao_prototipo: { desc: "Você aprova o visual do protótipo antes da execução.", skills: [], human: true },
  execucao: { desc: "Implementa a mudança de verdade no código.", skills: [] },
  verificacoes: { desc: "Roda as verificações automáticas antes de você testar.", skills: [{ n: "review" }, { n: "qa", q: "quando tem UI" }] },
  teste: { desc: "Você abre o preview, testa e aprova o resultado.", skills: [], human: true },
  publicar: { desc: "Abre um Pull Request pro time revisar — nada vai direto pro ar.", skills: [], human: true },
  concluida: { desc: "Tudo pronto — mudança publicada no projeto.", skills: [] },
};

// Espelha shared/types.ts: steps que ESTA task percorre (fluxo adaptativo).
function rodaDesign(t) {
  return t.design === "sim" || (t.design !== "nao" && Boolean(t.precisaDesign));
}
function stepsAtivos(t) {
  const simples = (t.porte ?? "media") === "simples";
  const out = ["espec", "plano", "aprovacao"];
  if (!simples) out.push("detalhamento");
  if (!simples && rodaDesign(t)) out.push("prototipo", "aprovacao_prototipo");
  out.push("execucao", "verificacoes", "teste", "publicar", "concluida");
  return out;
}

const DOCS_URL = "https://docs.claude.com/en/docs/claude-code/overview";

// ---------- Estado ----------
const UI_VERSION = "0.22.0";
console.log(`Inhouse UI v${UI_VERSION}`);

// Diagnóstico de conexão: histórico dos últimos eventos do canal (SSE/polling)
// e window.inhouseDiag() para suporte — imprime um resumo colável.
const diag = { log: [] };
function dlog(msg) {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`;
  diag.log.push(line);
  if (diag.log.length > 60) diag.log.shift();
  console.log(`[inhouse] ${line}`);
}
window.inhouseDiag = () => ({
  version: UI_VERSION,
  online: state.online,
  modo: pollTimer ? "polling" : es && es.readyState === 1 ? "sse" : "reconectando",
  sseReadyState: es ? es.readyState : null,
  ultimaMsgSseHaMs: lastSseMessageAt ? Date.now() - lastSseMessageAt : null,
  log: diag.log,
});

setInterval(() => {
  if (state.tasks.some((t) => t.status === "rodando" || t.status === "aguardando")) render();
}, 30_000);

const state = {
  projects: [],
  tasks: [],
  permissions: [],
  claude: { ok: false },
  update: { suportado: false, disponivel: false, atras: 0 }, // aviso de versão nova
  online: true,
  loaded: false, // já recebemos /api/state ao menos uma vez
  progress: {}, // name -> { projectId?, message, pct? }
  transcripts: {}, // taskId -> { loaded, loading, items[], stream }
  busy: {}, // chaves de ações em andamento ("clone", "create", "preview:<id>", "publish:<id>")
  previewErro: {}, // taskId -> { msg, podeConfigurar } quando o preview não sobe
  anexosPendentes: {}, // alvo ("new-task" | "composer") -> TaskAnexo[] já enviados, aguardando o envio da mensagem
  artefatos: {}, // taskId -> { at, temPrototipo, docs[], loading } (barra de artefatos do editor)
  showArquivadas: false, // mostrar as tarefas arquivadas no quadro
  ui: { createPr: true },
  novaTarefaModo: "esteira", // "esteira" | "livre" — escolha na caixa de nova tarefa
  eval: null, // resumo carregado ao entrar em #/experiencia
  workflows: null, // { workflows, globalAtivo, porProjeto, catalogo } — carregado em #/configuracoes
  wfDrawer: null, // id do workflow aberto na edição avançada (drawer), ou null
  wfDraft: null, // rascunho editável { name, descricao, skills: {plano_produto:[],detalhamento:[],verificacoes:[]} }
  wfIA: { mensagens: [], proposta: null, gerando: false }, // conversa "Ajustar com IA"
  evalRelatorio: null, // conteúdo do relatório aberto
  evalFonte: "todos", // filtro de origem: "todos" | "meus" | <rótulo importado>
  evalFontes: [], // rótulos de origens importadas
  fake: false, // modo debug (INHOUSE_FAKE_MODEL) ligado no server
  debugScenarios: null, // catálogo de cenários de debug (carregado sob demanda)
  debugAutoDrive: true, // auto-piloto: aprova as porteiras sozinho
};

// ---------- Utilidades ----------
const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* Markdown leve: escapa tudo, depois só código inline, negrito e quebras de linha. */
function mdLite(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

/* Versão para blocos maiores (plano): também títulos e listas viram algo legível. */
function mdBlock(text) {
  const lines = esc(text).split("\n").map((l) => {
    if (/^#{1,6}\s/.test(l)) return `<strong class="md-h">${l.replace(/^#{1,6}\s*/, "")}</strong>`;
    if (/^\s*[-*]\s/.test(l)) return `• ${l.replace(/^\s*[-*]\s*/, "")}`;
    return l;
  });
  return lines.join("<br>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s) || s < 45) return "agora mesmo";
  const m = s / 60;
  if (m < 60) return `há ${Math.round(m)} min`;
  const h = m / 60;
  if (h < 24) return `há ${Math.round(h)} h`;
  const d = h / 24;
  if (d < 2) return "ontem";
  return `há ${Math.round(d)} dias`;
}

function titleFrom(description) {
  const words = description.trim().split(/\s+/);
  const t = words.slice(0, 8).join(" ");
  return words.length > 8 ? `${t}…` : t;
}

/* Cor estável para o ícone do projeto, derivada do nome. */
function icoColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.codePointAt(0)) % 360;
  return `hsl(${h} 45% 42%)`;
}

function getProject(id) { return state.projects.find((p) => p.id === id); }
function getTask(id) { return state.tasks.find((t) => t.id === id); }
function upsert(arr, item) {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item; else arr.push(item);
}

function selectedProjectId() {
  const saved = localStorage.getItem("inhouse.projectId");
  if (saved && getProject(saved)) return saved;
  return state.projects[0]?.id ?? null;
}

// ---------- Rede ----------
/* GET quando body é undefined; POST JSON caso contrário. Nunca lança: retorna null em erro. */
async function api(path, body) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    setOnline(false);
    return null;
  }
  setOnline(true);
  if (!res.ok) {
    let msg = "";
    try {
      const j = await res.json();
      msg = j.error || j.message || "";
    } catch { /* corpo não-JSON */ }
    toast(msg || `Algo deu errado (erro ${res.status}). Tente de novo.`);
    return null;
  }
  try { return await res.json(); } catch { return {}; }
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

function setOnline(ok) {
  if (state.online === ok) return;
  state.online = ok;
  const banner = $("#offline-banner");
  if (banner) banner.hidden = ok;
  if (ok) fetchState();
}

async function fetchState() {
  const s = await api("/api/state");
  if (!s) {
    // servidor fora do ar: o api() já mostrou o banner; só re-renderizamos
    render();
    return;
  }
  state.projects = s.projects ?? [];
  state.tasks = s.tasks ?? [];
  state.permissions = s.permissions ?? [];
  state.claude = s.claude ?? { ok: false };
  if (s.update) state.update = s.update;
  state.fake = !!s.fake;
  state.loaded = true;
  if (state.fake && state.debugScenarios === null) carregarDebugScenarios();
  render();
}

/* Modo debug: busca o catálogo de cenários uma vez e re-renderiza. */
async function carregarDebugScenarios() {
  const r = await api("/api/debug/scenarios");
  state.debugScenarios = (r && r.scenarios) || [];
  render();
}

// ---------- SSE (com fallback para polling) ----------
// Alguns browsers/proxies bufferizam respostas de streaming: a conexão abre,
// mas nenhum evento chega à página — enquanto fetches normais funcionam.
// O servidor manda um evento "state" imediatamente ao conectar; se nada chegar
// em 8s, o canal está inutilizável NESTE ambiente e caímos para polling,
// tentando voltar ao SSE de tempos em tempos.
let es;
let lastSseMessageAt = 0;
let sseFallbackTimer;
let pollTimer;
let sseRetryTimer;

// Relógio da pane: dispara o polling se nenhuma mensagem SSE chegar em 8s.
// NÃO pode ser resetado por tentativas de reconexão — o SSE falhando rápido
// reconecta a cada ~3s, e zerar o timer a cada tentativa fazia o fallback
// nunca disparar (bug real visto em campo). Só mensagem recebida desarma.
function armSseFallback() {
  if (pollTimer || sseFallbackTimer) return;
  sseFallbackTimer = setTimeout(() => {
    sseFallbackTimer = undefined;
    if (Date.now() - lastSseMessageAt >= 7500) startPolling();
  }, 8000);
}

function connectSSE() {
  // Nunca deixar duas conexões vivas: um handler antigo disparando "offline"
  // depois da nova conexão abrir prendia o banner para sempre (e duplicava eventos).
  if (es) es.close();
  // "/api/stream": o caminho antigo "/api/events" casa com padrões de adblock
  // (EasyPrivacy) e era bloqueado no browser de alguns usuários.
  const mine = (es = new EventSource("/api/stream"));
  dlog("sse: conectando /api/stream");
  armSseFallback();
  mine.onopen = () => {
    if (es !== mine) return;
    dlog("sse: conexão aberta");
    setOnline(true);
  };
  mine.onmessage = (e) => {
    if (es !== mine) return;
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (!lastSseMessageAt) dlog("sse: primeira mensagem recebida");
    lastSseMessageAt = Date.now();
    clearTimeout(sseFallbackTimer);
    sseFallbackTimer = undefined;
    stopPolling();
    // Evento recebido = servidor vivo, independente de qualquer falha anterior.
    setOnline(true);
    handleEvent(ev);
  };
  mine.onerror = () => {
    if (es !== mine) return;
    dlog(`sse: erro (readyState=${mine.readyState})`);
    // Com o polling ativo e funcionando, o SSE falhar não significa offline.
    if (!pollTimer) setOnline(false);
    armSseFallback();
    // EventSource reconecta sozinho; se fechou de vez, recriamos.
    if (mine.readyState === EventSource.CLOSED) setTimeout(connectSSE, 3000);
  };
}

function startPolling() {
  if (pollTimer) return;
  clearTimeout(sseFallbackTimer);
  sseFallbackTimer = undefined;
  console.log(
    "Inhouse: canal de eventos bloqueado neste browser — usando atualização periódica.",
  );
  dlog("fallback: polling ativado");
  pollTimer = setInterval(poll, 2500);
  poll();
  // De tempos em tempos tenta voltar ao SSE (instantâneo é melhor que polling).
  sseRetryTimer = setInterval(() => {
    if (pollTimer) connectSSE();
  }, 30000);
}

function stopPolling() {
  if (!pollTimer) return;
  dlog("fallback: polling desativado (SSE voltou)");
  clearInterval(pollTimer);
  clearInterval(sseRetryTimer);
  pollTimer = undefined;
  sseRetryTimer = undefined;
}

async function poll() {
  await fetchState();
  // Na tela de uma tarefa, o transcript também precisa acompanhar.
  const r = route();
  if (r.name === "editor") await refreshTranscript(r.id);
}

async function refreshTranscript(taskId) {
  const items = await api(`/api/tasks/${encodeURIComponent(taskId)}/transcript`);
  if (!Array.isArray(items)) return;
  const c = tcache(taskId);
  c.items = items;
  c.loaded = true;
  if (isEditorOf(taskId)) renderChat(taskId);
}

function handleEvent(ev) {
  switch (ev.type) {
    case "state":
      state.projects = ev.projects ?? [];
      state.tasks = ev.tasks ?? [];
      state.permissions = ev.permissions ?? [];
      state.loaded = true;
      render();
      break;
    case "task_updated": {
      upsert(state.tasks, ev.task);
      // Fase que terminou sem mensagem final (timeout/abort/erro no meio do
      // streaming): zera o parcial para não sobrar balão "digitando" fantasma
      // nem contaminar o streaming da próxima fase.
      if (ev.task.status !== "rodando") {
        const c = state.transcripts[ev.task.id];
        if (c) c.stream = "";
      }
      render();
      break;
    }
    case "project_updated":
      upsert(state.projects, ev.project);
      clearProgressFor(ev.project);
      render();
      break;
    case "project_removed":
      state.projects = state.projects.filter((p) => p.id !== ev.projectId);
      state.tasks = state.tasks.filter((t) => t.projectId !== ev.projectId);
      render();
      break;
    case "project_progress":
      state.progress[ev.name] = { projectId: ev.projectId, message: ev.message, pct: ev.pct };
      if (route().name === "home") render();
      break;
    case "chat_delta":
      onChatDelta(ev.taskId, ev.text);
      break;
    case "transcript":
      onTranscript(ev.taskId, ev.item);
      break;
    case "gate_result": {
      const t = getTask(ev.taskId);
      if (t) {
        t.gates = t.gates ?? [];
        const i = t.gates.findIndex((g) => g.name === ev.gate.name);
        if (i >= 0) t.gates[i] = ev.gate; else t.gates.push(ev.gate);
        render();
      }
      break;
    }
    case "permission_request":
      state.permissions = state.permissions.filter((p) => p.id !== ev.request.id);
      state.permissions.push(ev.request);
      render();
      break;
    case "permission_resolved":
      state.permissions = state.permissions.filter((p) => p.id !== ev.requestId);
      render();
      break;
    case "eval_relatorio":
      if (ev.status === "pronto") {
        state.busy["eval-relatorio"] = false;
        toast("Análise de experiência pronta.");
        if (route().name === "experiencia") carregarEval();
        else render();
      } else if (ev.status === "erro") {
        toast(`Não deu para gerar a análise: ${ev.detalhe ?? "erro"}`);
        state.busy["eval-relatorio"] = false;
        if (route().name === "experiencia") render();
      } else {
        state.busy["eval-relatorio"] = true;
        if (route().name === "experiencia") render();
      }
      break;
    case "preview_ready": {
      const t = getTask(ev.taskId);
      delete state.previewErro[ev.taskId];
      if (t) { t.previewUrl = ev.url; render(); }
      break;
    }
    case "claude_status": {
      const antes = state.claude.ok;
      state.claude = { ok: ev.ok, version: ev.version, detail: ev.detail };
      renderClaudeChip();
      // Home e Quadro travam ações quando o Claude cai; ao mudar de estado,
      // re-renderiza a tela atual para (des)habilitar os botões na hora.
      if (antes !== ev.ok && (route().name === "home" || route().name === "board")) render();
      break;
    }
    case "update_status": {
      state.update = ev.update;
      renderUpdatePill();
      break;
    }
  }
}

function clearProgressFor(project) {
  for (const k of Object.keys(state.progress)) {
    const pr = state.progress[k];
    if (pr.projectId === project.id || k === project.name) delete state.progress[k];
  }
}

// ---------- Transcript (cache por tarefa) ----------
function tcache(taskId) {
  return (state.transcripts[taskId] ??= { loaded: false, loading: false, items: [], stream: "" });
}

async function loadTranscript(taskId) {
  const c = tcache(taskId);
  if (c.loaded || c.loading) return;
  c.loading = true;
  if (isEditorOf(taskId)) renderChat(taskId);
  const items = await api(`/api/tasks/${encodeURIComponent(taskId)}/transcript`);
  c.loading = false;
  if (Array.isArray(items)) {
    // Junta com o que chegou por SSE durante o fetch, sem duplicar.
    const seen = new Set(items.map((i) => `${i.at}|${i.kind}`));
    const userTexts = new Set(items.filter((i) => i.kind === "user").map((i) => i.text));
    c.items = items.concat(
      c.items.filter((i) => !seen.has(`${i.at}|${i.kind}`) && !(i._local && userTexts.has(i.text))),
    );
    c.loaded = true;
  }
  if (isEditorOf(taskId)) renderChat(taskId);
}

function onTranscript(taskId, item) {
  const c = tcache(taskId);
  if (item.kind === "user") {
    // Eco local: substitui a mensagem que o usuário acabou de mandar, sem duplicar.
    const i = c.items.findIndex((x) => x._local && x.kind === "user" && x.text === item.text);
    if (i >= 0) {
      c.items[i] = item;
      if (isEditorOf(taskId)) renderChat(taskId);
      return;
    }
  }
  c.items.push(item);
  if (item.kind === "assistant") c.stream = ""; // o texto final substitui o streaming
  if (isEditorOf(taskId)) appendChatDom(taskId, item);
}

function onChatDelta(taskId, text) {
  const c = tcache(taskId);
  c.stream += text;
  if (!isEditorOf(taskId)) return;
  const scroller = $("#chat-scroll");
  if (!scroller) return;
  const stick = nearBottom(scroller);
  let bubble = $("#stream-bubble");
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = "stream-bubble";
    bubble.className = "msg-ai";
    scroller.insertBefore(bubble, $("#chat-cards", scroller));
  }
  bubble.innerHTML = `${mdLite(c.stream)}<span class="caret-blink"></span>`;
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function pushLocalUser(taskId, text) {
  const c = tcache(taskId);
  c.items.push({ kind: "user", text, at: new Date().toISOString(), _local: true });
  if (isEditorOf(taskId)) renderChat(taskId);
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

// ---------- Rotas ----------
function route() {
  const h = location.hash || "#/";
  const m = h.match(/^#\/tarefa\/(.+)$/);
  if (m) return { name: "editor", id: decodeURIComponent(m[1]) };
  if (h.startsWith("#/tarefas")) return { name: "board" };
  if (h.startsWith("#/experiencia")) return { name: "experiencia" };
  if (h.startsWith("#/configuracoes")) return { name: "configuracoes" };
  return { name: "home" };
}

function isEditorOf(taskId) {
  const root = $("#app")?.firstElementChild;
  return !!root && root.dataset.view === "editor" && root.dataset.task === taskId;
}

async function carregarEval() {
  const f = state.evalFonte && state.evalFonte !== "todos" ? `?fonte=${encodeURIComponent(state.evalFonte)}` : "";
  state.eval = await api(`/api/eval/resumo${f}`);
  const idx = await api("/api/eval/relatorios");
  state.evalRelatorios = idx?.relatorios ?? [];
  const fontes = await api("/api/eval/fontes");
  state.evalFontes = fontes?.fontes ?? [];
  render();
}

function dur(ms) {
  if (ms === null || ms === undefined) return "—";
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}

function renderExperiencia() {
  const e = state.eval;
  const busy = !!state.busy["eval-relatorio"] || !!(e && e.gerando);
  if (!e) { carregarEval(); }
  else if (busy) { clearTimeout(state._evalPoll); state._evalPoll = setTimeout(carregarEval, 5000); }
  const stat = (n, l, norte) => `<div class="exp-stat ${norte ? "norte" : ""}"><div class="n">${esc(String(n))}</div><div class="l">${esc(l)}</div></div>`;
  const semDados = !e || e.taxaSemResgate.finalizadas === 0;

  const grid = !e ? "<p>Carregando…</p>" : semDados
    ? `<p class="exp-empty">Finalize algumas tarefas para o Inhouse ter o que analisar.</p>`
    : `<div class="exp-grid">
        ${stat(`${e.taxaSemResgate.publicadasSemResgate}/${e.taxaSemResgate.finalizadas}`, "Publicadas sem precisar de socorro", true)}
        ${stat(dur(e.tempoHumanoMedianoMs), "Tempo mediano esperando você", true)}
        ${stat(dur(e.tempoMaquinaMedianoMs), "Tempo mediano de trabalho")}
        ${stat(e.concluidas, "Concluídas")}
        ${stat(e.canceladas, "Canceladas")}
        ${stat(e.paradasEmFalhou, "Paradas em falha")}
        ${stat(`${e.permissoes.total}`, `Permissões (${dur(e.permissoes.esperaMedianaMs)} p/ responder · ${e.permissoes.autoPct}% no auto)`)}
        ${stat(e.gateMaisReprova ?? "—", "Verificação que mais reprova")}
        ${stat(`US$ ${e.custoTotalUsd}`, "Custo total (assinatura)")}
        ${stat(`😃 ${e.feedback.otimo} · 😐 ${e.feedback.ok} · 😖 ${e.feedback.ruim}`, "Como as pessoas avaliaram")}
      </div>`;

  const aprendizados = (e?.aprendizados ?? []).length
    ? `<h3>O que o Inhouse aprendeu</h3><div class="exp-aprendizados">${e.aprendizados.map((a) =>
        `<div class="exp-apr">${esc(a.insight)} <span class="ocorr">· visto ${a.ocorrencias}× · severidade ${a.severidade}/5</span></div>`).join("")}</div>`
    : "";

  const relatorios = (state.evalRelatorios ?? []).length
    ? `<h3>Análises geradas</h3><div class="exp-relatorios">${state.evalRelatorios.map((r) =>
        `<div class="exp-rel-item" data-act="abrir-relatorio" data-arq="${esc(r.arquivo)}">
          <span>${esc(new Date(r.ts).toLocaleString("pt-BR"))}</span>
          <span class="gap" style="flex:1"></span>
          <span class="l">${r.tarefasAnalisadas} tarefas${r.custoUsd ? ` · US$ ${r.custoUsd.toFixed(2)}` : ""}</span>
        </div>`).join("")}</div>`
    : "";

  const md = state.evalRelatorio
    ? `<div class="exp-relatorio-md">${mdBlock(state.evalRelatorio)}</div>`
    : "";

  const temFontes = (state.evalFontes ?? []).length > 0;
  const fonteSelect = temFontes
    ? `<select id="eval-fonte" class="repo-pick" aria-label="Filtrar por origem dos dados" title="${esc(state.evalFonte === "todos" ? "Todas as origens" : state.evalFonte === "meus" ? "Só os meus" : (state.evalFonte || ""))}">
        ${["todos", "meus", ...state.evalFontes].map((f) =>
          `<option value="${esc(f)}" ${state.evalFonte === f ? "selected" : ""}>${f === "todos" ? "Todas as origens" : f === "meus" ? "Só os meus" : esc(f)}</option>`).join("")}
      </select>`
    : "";

  renderPage(`<div class="exp-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Experiência</h2>
      ${fonteSelect}
      <button class="btn sm ghost" data-act="eval-export" title="Baixar os dados desta máquina para enviar a quem analisa">Exportar dados</button>
      <button class="btn sm ghost" data-act="eval-import" title="Carregar os dados exportados de outra máquina">Importar dados</button>
      <button class="btn primary" data-act="gerar-relatorio" ${busy ? "disabled" : ""}>${busy ? '<span class="spinner"></span> Gerando análise…' : "Gerar análise agora"}</button>
    </div>
    <p class="hello-sub">O Inhouse mede sozinho os atritos de quem usa e ranqueia o que melhorar.${temFontes ? " Use o filtro para separar por quem testou." : ""}</p>
    ${grid}
    ${aprendizados}
    ${relatorios}
    ${md}
  </div>`);
}

// ---------- CONFIGURAÇÕES · Workflows ----------
async function carregarWorkflows() {
  const w = await api("/api/workflows");
  if (w) state.workflows = w;
  render();
}
function wfById(id) { return (state.workflows?.workflows || []).find((x) => x.id === id); }
function coletarSkills(bloco) {
  if (!bloco) return [];
  const arrs = Array.isArray(bloco) ? [bloco] : Object.values(bloco);
  return arrs.flat().filter(Boolean).map((s) => s.skill);
}
function reviewsDoWorkflow(w) {
  const cat = state.workflows?.catalogo || [];
  const rot = (skill) => cat.find((c) => c.skill === skill)?.rotulo || `/${skill}`;
  const s = w?.skills || {};
  const todas = [...coletarSkills(s.plano_produto), ...coletarSkills(s.plano), ...coletarSkills(s.detalhamento), ...coletarSkills(s.verificacoes)];
  return [...new Set(todas)].map(rot);
}
/* Achata a config (formato por-porte dos presets vira lista simples pra editar). */
function flattenSkills(w) {
  const flat = (bloco) => {
    if (!bloco) return [];
    const arrs = Array.isArray(bloco) ? [bloco] : Object.values(bloco);
    const out = [];
    for (const s of arrs.flat().filter(Boolean)) if (!out.some((x) => x.skill === s.skill)) out.push({ skill: s.skill, ...(s.quando ? { quando: s.quando } : {}), ...(s.gate ? { gate: s.gate } : {}) });
    return out;
  };
  return { plano_produto: flat(w.skills?.plano_produto), detalhamento: flat(w.skills?.detalhamento), verificacoes: flat(w.skills?.verificacoes) };
}

/* Porteiras humanas desligadas num workflow → rótulos amigáveis (publicar nunca entra). */
const GATE_ROTULOS = { aprovacao: "aprovação do plano", aprovacao_prototipo: "aprovação do protótipo", teste: "seu teste" };
function gatesDesligadas(g) {
  if (!g) return [];
  return Object.keys(GATE_ROTULOS).filter((k) => g[k] === false).map((k) => GATE_ROTULOS[k]);
}

function wuPlainHtml(w) {
  const g = w?.gates || {};
  const passos = [
    { t: "Entende o pedido" },
    { t: "Monta o plano" },
    { t: "Você aprova", gate: "aprovacao" },
    { t: "Implementa" },
    { t: "Confere" },
    { t: "Você testa", gate: "teste" },
    { t: "Publica", gate: "publicar" },
  ];
  const flow = passos.map((p, i) => {
    const off = p.gate && p.gate !== "publicar" && g[p.gate] === false;
    const cls = off ? "wu-st auto" : p.gate ? "wu-st gate" : "wu-st";
    const label = off ? `${p.t} (auto)` : p.t;
    return `${i ? `<span class="wu-arw">›</span>` : ""}<span class="${cls}">${esc(label)}</span>`;
  }).join("");
  const revs = reviewsDoWorkflow(w);
  const off = gatesDesligadas(g);
  return `<div class="wu-card">
    <div class="wu-flow">${flow}</div>
    <div class="wu-reviews">${revs.length
      ? `<span class="wu-rlbl">Reviews que rodam:</span> ${revs.map((r) => `<span class="wf-rchip">${esc(r)}</span>`).join("")}`
      : `<span class="wu-none">Sem reviews — vai direto ao ponto.</span>`}</div>
    ${off.length ? `<p class="wu-gates-off">Sem te parar em: ${off.map((x) => `<b>${esc(x)}</b>`).join(", ")} — o Claude segue sozinho. <span class="wu-pub">Publicar é sempre você.</span></p>` : ""}
    <p class="wu-foot">Adapta ao tamanho da tarefa: pedidos pequenos e óbvios pulam o plano e os reviews.</p>
  </div>`;
}

function wfItemHtml(x, ativoId, globalId) {
  const on = x.id === ativoId;
  const revs = reviewsDoWorkflow(x);
  const tag = x.builtin ? `<span class="wf-tag">preset</span>` : x.origem === "ia" ? `<span class="wf-tag ia">IA</span>` : `<span class="wf-tag">seu</span>`;
  return `<div class="wf-item ${on ? "active" : ""}">
    <div class="wf-item-h"><b>${esc(x.name)}</b>${on ? `<span class="wf-badge">em uso</span>` : ""}${x.id === globalId ? `<span class="wf-tag">padrão global</span>` : ""}${tag}</div>
    <p class="wf-item-d">${esc(x.descricao || "")}</p>
    <div class="wf-reviews">${revs.length ? revs.map((r) => `<span class="wf-rchip">${esc(r)}</span>`).join("") : `<span class="wf-rchip none">sem reviews</span>`}</div>
    <div class="wf-item-acts">
      ${on ? `<span class="wf-inuse">✓ em uso aqui</span>` : `<button class="btn xs primary" data-act="wf-ativar" data-wf="${esc(x.id)}">Usar aqui</button>`}
      <span class="gap" style="flex:1"></span>
      ${x.builtin
        ? `<button class="btn xs ghost" data-act="wf-duplicar" data-wf="${esc(x.id)}">Duplicar</button>`
        : `<button class="btn xs ghost" data-act="wf-editar" data-wf="${esc(x.id)}">Editar</button><button class="btn xs ghost" data-act="wf-excluir" data-wf="${esc(x.id)}">Excluir</button>`}
    </div>
  </div>`;
}

function wfDrawerHtml() {
  const d = state.wfDraft;
  if (!d) return "";
  const cat = state.workflows?.catalogo || [];
  const bloco = (fase, titulo, desc) => {
    const items = d.skills[fase] || [];
    const chips = items.map((s, i) => `<span class="sk"><code>/${esc(s.skill)}</code><button class="x" data-act="wf-skill-rm" data-fase="${fase}" data-i="${i}" title="Remover">×</button></span>`).join("");
    const opts = cat.filter((c) => c.fase === fase).map((c) => {
      const added = items.some((s) => s.skill === c.skill);
      return `<button type="button" class="sk-opt ${added ? "added" : ""}" data-act="wf-skill-add" data-fase="${fase}" data-skill="${esc(c.skill)}" ${added ? "disabled" : ""}>${added ? "✓ " : ""}<span class="nm">${esc(c.rotulo)}</span><code>/${esc(c.skill)}</code>${c.instalada ? "" : `<span class="ninst">não instalada</span>`}</button>`;
    }).join("");
    return `<div class="wf-phase"><div class="wf-ph-h"><b>${titulo}</b><span>${desc}</span></div>
      <div class="chips">${chips || `<span class="wf-empty">nenhuma</span>`}</div>
      <details class="wf-add"><summary>+ adicionar skill</summary><div class="sk-list">${opts}</div></details></div>`;
  };
  const gateRow = (key, titulo, desc) => {
    const on = d.gates?.[key] !== false;
    return `<label class="wf-gate ${on ? "" : "off"}">
      <input type="checkbox" data-gate="${key}" ${on ? "checked" : ""}>
      <span class="wf-gate-box" aria-hidden="true"></span>
      <span class="wf-gate-txt"><b>${esc(titulo)}</b><small>${esc(desc)}</small></span>
    </label>`;
  };
  return `<div class="scrim open" data-act="wf-drawer-close"></div>
    <aside class="drawer wf-drawer">
      <div class="dr-h"><div class="t">Edição avançada <small>· ${esc(d.name || "")}</small></div><button class="dc" data-act="wf-drawer-close" aria-label="Fechar">✕</button></div>
      <div class="dr-b">
        <label class="wf-field"><span>Nome</span><input id="wf-name" value="${esc(d.name)}" maxlength="60"></label>
        <label class="wf-field"><span>Descrição (opcional)</span><input id="wf-desc" value="${esc(d.descricao || "")}" maxlength="200"></label>
        <p class="dr-note">As skills vêm da <b>lista instalada</b> — você (e o Claude) só escolhem daqui, nunca uma que não existe.</p>
        ${bloco("plano_produto", "Plano", "reviews de produto (ex.: office-hours)")}
        ${bloco("detalhamento", "Detalhamento", "reviews técnicos e de design")}
        ${bloco("verificacoes", "Verificações", "checks antes do seu teste")}
        <div class="wf-phase wf-gates-block"><div class="wf-ph-h"><b>Porteiras</b><span>onde a esteira para e espera você</span></div>
          ${gateRow("aprovacao", "Aprovar o plano", "revisa o plano antes de implementar")}
          ${gateRow("aprovacao_prototipo", "Aprovar o protótipo", "confere a tela antes de construir de verdade")}
          ${gateRow("teste", "Seu teste", "testa o resultado antes de publicar")}
          <p class="wf-gate-note">Desmarque para o Claude seguir sozinho. <b>Publicar</b> é sempre você — nada vai pro projeto sem seu clique.</p>
        </div>
      </div>
      <div class="dr-f"><button class="btn ghost sm" data-act="wf-drawer-close">Cancelar</button><span class="gap" style="flex:1"></span><button class="btn primary sm" data-act="wf-save">Salvar</button></div>
    </aside>`;
}

function propostaCardHtml(p, isLast) {
  const revs = reviewsDoWorkflow(p);
  const off = gatesDesligadas(p.gates);
  return `<div class="wf-prop">
    <div class="wf-prop-h"><b>${esc(p.name)}</b><span class="wf-tag ia">IA</span></div>
    ${p.descricao ? `<p class="wf-prop-d">${esc(p.descricao)}</p>` : ""}
    <div class="wf-prop-revs">${revs.length ? `<span class="wu-rlbl">Reviews:</span> ${revs.map((r) => `<span class="wf-rchip">${esc(r)}</span>`).join("")}` : `<span class="wf-rchip none">sem reviews — vai direto</span>`}</div>
    ${off.length ? `<p class="wf-prop-gates">Sem te parar em: ${off.map((x) => `<b>${esc(x)}</b>`).join(", ")} — segue sozinho (publicar continua com você).</p>` : ""}
    ${isLast ? `<div class="wf-prop-acts"><button class="btn primary sm" data-act="wf-ia-usar">Usar este workflow</button><button class="btn ghost sm" data-act="wf-ia-descartar">Descartar</button></div>` : ""}
  </div>`;
}

function wfIAHtml() {
  const ia = state.wfIA;
  const iniciou = ia.mensagens.length > 0;
  const SUGS = [
    "Sem reviews para tarefas pequenas — vai direto.",
    "Sempre um review de segurança antes de publicar.",
    "Só review de código e QA nas verificações.",
    "Adicione review de design no detalhamento.",
  ];
  const chat = iniciou
    ? `<div class="wf-ia-chat">${ia.mensagens.map((m, i) => m.de === "user"
        ? `<div class="msg-user">${mdLite(m.texto)}</div>`
        : `<div class="wf-ia-ai"><div class="who"><span class="sp">✦</span> Claude</div>${propostaCardHtml(m.proposta, i === ia.mensagens.length - 1 && !ia.gerando)}</div>`).join("")}
      ${ia.gerando ? `<div class="wf-ia-typing"><span class="spinner"></span> montando o workflow…</div>` : ""}</div>`
    : `<p class="wf-ia-sub">Descreva como você quer que o Claude trabalhe nas tarefas. Ele monta o workflow e você revisa antes de aplicar — pode pedir quantos ajustes quiser.</p>`;
  return `<div class="wf-ia">
    <div class="wf-ia-h"><span class="wf-ia-spark">✦</span><b>Ajustar com IA</b></div>
    ${chat}
    ${!iniciou ? `<div class="wf-ia-sugs">${SUGS.map((s) => `<button type="button" class="sug" data-act="wf-ia-sug" data-txt="${esc(s)}">${esc(s)}</button>`).join("")}</div>` : ""}
    <form class="wf-ia-form" data-form="wf-ia">
      <textarea id="wf-ia-input" class="grow-area" rows="1" data-enter-submit placeholder="${iniciou ? "Peça um ajuste… ex.: “tire o QA e adicione segurança”" : "Ex.: sem reviews para ajustes pequenos, mas sempre testes e segurança antes de publicar."}" ${ia.gerando ? "disabled" : ""}></textarea>
      <button class="btn primary sm" type="submit" ${ia.gerando ? "disabled" : ""}>${ia.gerando ? "…" : iniciou ? "Enviar" : "✦ Gerar"}</button>
    </form>
    <p class="wf-ia-foot">O Claude só usa as skills instaladas — nunca inventa uma que não existe. Nada é aplicado até você clicar em “Usar”.</p>
  </div>`;
}

function renderConfiguracoes() {
  if (!state.workflows) { carregarWorkflows(); renderPage(`<div class="view view-page cfg-wrap"><p><span class="spinner"></span> Carregando workflows…</p></div>`); return; }
  const w = state.workflows;
  const pid = selectedProjectId();
  const ativoId = (pid && w.porProjeto[pid]) || w.globalAtivo;
  const ativo = wfById(ativoId) || w.workflows[0];
  const globalNome = wfById(w.globalAtivo)?.name || "Padrão";
  const semProjeto = state.projects.length === 0;

  const lib = w.workflows.map((x) => wfItemHtml(x, ativoId, w.globalAtivo)).join("");

  renderPage(`<div class="view view-page cfg-wrap">
    <h2>Workflows</h2>
    <p class="hello-sub">É o jeito que o Claude trabalha nas suas tarefas. Escolha qual vale para cada projeto — ou personalize um. ${semProjeto ? "" : ""}</p>

    <div class="cfg-context">
      <span class="cfg-lbl">Projeto</span>
      <select id="cfg-project" class="repo-pick" ${semProjeto ? "disabled" : ""} aria-label="Projeto">
        ${semProjeto ? `<option>— nenhum projeto —</option>` : opcoesProjeto(pid)}
      </select>
      <span class="gap" style="flex:1"></span>
      <span class="cfg-active">Em uso: <b>${esc(ativo?.name || "—")}</b></span>
    </div>

    ${ativo ? wuPlainHtml(ativo) : ""}

    <div class="sect"><h3>Seus workflows</h3><span>${semProjeto ? "" : "clique em “Usar aqui” para aplicar a este projeto"}</span></div>
    <div class="wf-lib">${lib}</div>

    <div class="cfg-global">Padrão global (projetos sem escolha própria): <b>${esc(globalNome)}</b>${ativoId !== w.globalAtivo ? ` · <button class="btn xs ghost" data-act="wf-global" data-wf="${esc(ativoId)}">Tornar “${esc(ativo?.name || "")}” o padrão global</button>` : ""}</div>

    <div class="sect"><h3>Criar ou ajustar com IA</h3><span>descreva em português; o Claude monta</span></div>
    ${wfIAHtml()}
  </div>
  ${state.wfDrawer ? wfDrawerHtml() : ""}`);
}

// ---------- Render raiz ----------
function render() {
  renderClaudeChip();
  renderUpdatePill();
  const r = route();
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === r.name || (r.name === "editor" && a.dataset.nav === "board");
    a.classList.toggle("active", active);
  });
  if (r.name === "home") renderHome();
  else if (r.name === "board") renderBoard();
  else if (r.name === "experiencia") renderExperiencia();
  else if (r.name === "configuracoes") renderConfiguracoes();
  else renderEditor(r.id);
}

/* Troca o conteúdo preservando valor e foco dos inputs (SSE re-renderiza com frequência). */
function renderPage(html) {
  const appEl = $("#app");
  const focused = document.activeElement;
  const focusId = focused && appEl.contains(focused) ? focused.id : null;
  const selStart = focusId && typeof focused.selectionStart === "number" ? focused.selectionStart : null;
  const values = {};
  appEl.querySelectorAll("input[id], textarea[id]").forEach((i) => {
    values[i.id] = i.type === "checkbox" ? i.checked : i.value;
  });
  appEl.innerHTML = html;
  appEl.querySelectorAll("input[id], textarea[id]").forEach((i) => {
    if (i.id in values) {
      if (i.type === "checkbox") i.checked = values[i.id];
      else i.value = values[i.id];
    }
  });
  // Textareas auto-crescentes recalculam a altura após restaurar o valor.
  appEl.querySelectorAll("textarea.grow-area").forEach(autoGrow);
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (selStart !== null) { try { el.setSelectionRange(selStart, selStart); } catch { /* tipos sem seleção */ } }
    }
  }
}

function renderClaudeChip() {
  const el = $("#claude-chip");
  if (!el) return;
  if (!state.loaded) {
    el.className = "chip";
    el.textContent = "verificando…";
    el.title = "";
  } else if (state.claude.ok) {
    el.className = "chip ok";
    el.innerHTML = `<span class="dot"></span> Claude conectado`;
    el.title = "Usando o Claude Code deste computador, com a sua assinatura";
  } else {
    el.className = "chip bad";
    el.textContent = "Claude desconectado";
    el.title = "Claude Code não encontrado neste computador";
  }
}

// Pílula "versão nova" no cabeçalho — só aparece quando há update disponível.
function renderUpdatePill() {
  const el = $("#update-pill");
  if (!el) return;
  const u = state.update;
  if (u && u.disponivel && !state.busy.update) {
    el.hidden = false;
    el.innerHTML = `<span class="dot"></span> Versão nova · Atualizar`;
  } else if (state.busy.update) {
    el.hidden = false;
    el.innerHTML = `<span class="spinner"></span> Atualizando…`;
  } else {
    el.hidden = true;
  }
}


/* Duração por etapa a partir do histórico (soma repetições, ex.: execução↔verificações). */
function stepDurMs(t, step) {
  let ms = 0;
  for (const h of t.historico ?? []) {
    if (h.step !== step) continue;
    ms += (h.fim ? Date.parse(h.fim) : Date.now()) - Date.parse(h.inicio);
  }
  return ms;
}
function fmtDur(ms) {
  if (ms < 1000) return "";
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.round(ms / 1000)} s`;
}
/* Início do passo atual (última entrada aberta do histórico). */
function stepAtualDesde(t) {
  const h = (t.historico ?? [])[ (t.historico ?? []).length - 1 ];
  return h && !h.fim ? h.inicio : null;
}

/* Diálogo de confirmação reutilizável (<dialog> nativo). Resolve true/false. */
function confirmar({ titulo, corpo, textoConfirmar = "Confirmar", perigo = false }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "cancel-dialog";
    dlg.innerHTML = `<form method="dialog">
      <h3>${esc(titulo)}</h3>
      <p>${esc(corpo)}</p>
      <div class="dlg-acts">
        <button value="nao" class="btn sm ghost">Voltar</button>
        <button value="sim" class="btn sm ${perigo ? "danger" : "primary"}">${esc(textoConfirmar)}</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener("close", () => {
      const ok = dlg.returnValue === "sim";
      dlg.remove();
      resolve(ok);
    });
    dlg.showModal();
  });
}

/** Orquestra a exclusão: busca o impacto real, mostra o modal certo, executa. */
async function excluirProjetoFluxo(projectId) {
  const info = await api(`/api/projects/${encodeURIComponent(projectId)}/exclusao-info`);
  if (!info) return; // erro já avisado pelo api()
  if (info.rodando > 0) {
    await confirmar({
      titulo: "Tem tarefa em andamento",
      corpo: "Espere a tarefa terminar ou cancele antes de excluir este projeto.",
      textoConfirmar: "Entendi",
    });
    return;
  }
  const escolha = await confirmarExclusao(info);
  if (escolha === "arquivar") {
    const r = await api(`/api/projects/${encodeURIComponent(projectId)}/arquivar`, {});
    if (r) toast(`“${info.name}” arquivado em vez de excluído.`);
    return;
  }
  if (escolha !== "sim") return;
  // apagarArquivos só é aceito (e só faz sentido) para pasta gerenciada por nós.
  let res;
  try {
    res = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apagarArquivos: info.gerenciado }),
    });
  } catch {
    setOnline(false);
    return;
  }
  setOnline(true);
  if (res.ok) {
    toast(info.gerenciado
      ? `“${info.name}” excluído.`
      : `“${info.name}” removido do Inhouse. Seus arquivos ficaram no lugar.`);
    // A lista se atualiza sozinha pelo evento project_removed.
  } else {
    const j = await res.json().catch(() => ({}));
    toast(j.error || "Não foi possível excluir o projeto.");
  }
}

/** Modal de exclusão com fricção escalonada pela irreversibilidade. Resolve "sim"|"nao"|"arquivar". */
function confirmarExclusao(info) {
  const nome = info.name;
  const unpushed = info.sujo || info.commitsFrente > 0 || info.branchesTarefa > 0;
  const tarefasNota = info.nTarefas > 0
    ? `<li>Remove ${info.nTarefas === 1 ? "1 tarefa e seu histórico" : `${info.nTarefas} tarefas e seus históricos`} do Inhouse.</li>`
    : "";

  let titulo, tone, corpo, textoConfirmar, exigeNome, sugereArquivar;
  if (!info.gerenciado) {
    // Projeto "aberto no lugar": a pasta é do usuário — nunca apagamos.
    titulo = `Remover “${esc(nome)}” do Inhouse?`;
    tone = "neutro";
    corpo = `<p>O Inhouse esquece este projeto — ele sai da lista e os espaços de tarefas e prévias são limpos.</p>
      <p class="excl-safe"><b>Seus arquivos não são apagados.</b> A pasta continua em <code>${esc(info.path)}</code>. Dá para abrir de novo depois.</p>
      <ul class="excl-list">${tarefasNota}</ul>`;
    textoConfirmar = "Remover do Inhouse";
    exigeNome = false;
    sugereArquivar = false;
  } else if (!info.temRemoto) {
    // App que só existe aqui: perda total e irreversível.
    titulo = `Excluir “${esc(nome)}” do computador?`;
    tone = "perigo";
    corpo = `<p class="excl-alerta">Este app <b>só existe neste computador</b> — não tem cópia no GitHub.</p>
      <p>Excluir <b>apaga a pasta e todo o conteúdo para sempre</b>. Não dá para desfazer.</p>
      <ul class="excl-list">${tarefasNota}</ul>`;
    textoConfirmar = "Excluir para sempre";
    exigeNome = true;
    sugereArquivar = true;
  } else if (unpushed) {
    // Tem GitHub, mas há trabalho local não enviado.
    const itens = [];
    if (info.sujo) itens.push("mudanças não salvas (ainda não commitadas)");
    if (info.commitsFrente > 0) itens.push(`${info.commitsFrente === 1 ? "1 commit local" : `${info.commitsFrente} commits locais`} à frente do GitHub`);
    if (info.branchesTarefa > 0) itens.push(`${info.branchesTarefa === 1 ? "1 tarefa com trabalho" : `${info.branchesTarefa} tarefas com trabalho`} em branches não publicadas`);
    titulo = `Excluir “${esc(nome)}” do computador?`;
    tone = "perigo";
    corpo = `<p>Este projeto tem cópia no GitHub, mas há <b>trabalho que ainda não foi enviado</b> e será perdido:</p>
      <ul class="excl-list perde">${itens.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      <p class="excl-safe">O que já está no GitHub continua lá.</p>
      <ul class="excl-list">${tarefasNota}</ul>`;
    textoConfirmar = "Excluir mesmo assim";
    exigeNome = true;
    sugereArquivar = true;
  } else {
    // Tem GitHub e está tudo enviado: reabrível.
    titulo = `Excluir “${esc(nome)}” do computador?`;
    tone = "neutro";
    corpo = `<p>Isso apaga a pasta local do projeto. Como está tudo enviado ao GitHub, você pode <b>baixar de novo</b> quando quiser.</p>
      <ul class="excl-list">${tarefasNota}</ul>`;
    textoConfirmar = "Excluir do computador";
    exigeNome = false;
    sugereArquivar = false;
  }

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = `cancel-dialog excl-dialog ${tone}`;
    dlg.innerHTML = `<form method="dialog">
      <h3>${titulo}</h3>
      <div class="excl-corpo">${corpo}</div>
      ${exigeNome ? `<label class="excl-nome">Para confirmar, digite <b>${esc(nome)}</b>:
        <input id="excl-nome-inp" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="${esc(nome)}"></label>` : ""}
      <div class="dlg-acts">
        ${sugereArquivar ? `<button value="arquivar" class="btn sm ghost">Arquivar em vez disso</button>` : ""}
        <span class="gap" style="flex:1"></span>
        <button value="nao" class="btn sm ghost">Voltar</button>
        <button value="sim" class="btn sm danger" ${exigeNome ? "disabled" : ""}>${esc(textoConfirmar)}</button>
      </div>
    </form>`;
    document.body.appendChild(dlg);
    if (exigeNome) {
      const inp = dlg.querySelector("#excl-nome-inp");
      const ok = dlg.querySelector('button[value="sim"]');
      const casa = () => inp.value.trim() === nome;
      inp.addEventListener("input", () => { ok.disabled = !casa(); });
      // Enter no campo confirma só quando o nome bate (senão os botões-submit
      // padrão fechariam o diálogo com o valor errado).
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (casa()) { dlg.returnValue = "sim"; dlg.close(); }
        }
      });
      setTimeout(() => inp.focus(), 30);
    }
    dlg.addEventListener("close", () => {
      const v = dlg.returnValue;
      dlg.remove();
      resolve(v === "sim" ? "sim" : v === "arquivar" ? "arquivar" : "nao");
    });
    dlg.showModal();
  });
}

function confirmarModoAuto() {
  return confirmar({
    titulo: "Ligar o modo automático?",
    corpo: "Isto deixa o Claude executar tudo nesta tarefa sem te perguntar (inclusive rodar comandos). Ligue só numa tarefa em que você confia.",
    textoConfirmar: "Ligar modo auto",
  });
}

function abrirDialogoCancelar(taskId) {
  const motivos = ["Não era o que eu pedi", "Demorou demais", "Travou / deu erro", "Mudei de ideia", "Só estava testando"];
  const dlg = document.createElement("dialog");
  dlg.className = "cancel-dialog";
  dlg.innerHTML = `<form method="dialog">
    <h3>Cancelar esta tarefa?</h3>
    <p>O Claude para de trabalhar nela; o que já foi feito fica guardado no espaço da tarefa.</p>
    <p class="dlg-label">O que aconteceu? (opcional — ajuda a melhorar o Inhouse)</p>
    <div class="dlg-chips">${motivos.map((m) => `<button type="button" class="chip-btn" data-motivo="${esc(m)}">${esc(m)}</button>`).join("")}</div>
    <input class="dlg-input" placeholder="Ou escreva com suas palavras…" maxlength="500">
    <div class="dlg-acts"><button value="voltar" class="btn sm ghost">Voltar</button><button value="cancelar" class="btn sm danger">Cancelar tarefa</button></div>
  </form>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector(".dlg-input");
  dlg.querySelectorAll(".chip-btn").forEach((c) =>
    c.addEventListener("click", () => {
      input.value = c.dataset.motivo;
      dlg.querySelectorAll(".chip-btn").forEach((x) => x.classList.remove("sel"));
      c.classList.add("sel");
    }),
  );
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "cancelar") {
      const motivo = input.value.trim() || undefined;
      taskAction(taskId, { action: "cancel", motivo });
    }
    dlg.remove();
  });
  dlg.showModal();
}

// ---------- Caixa de texto (auto-crescente) ----------
/* Cresce com o conteúdo até um teto e então rola — usado na nova tarefa e no compositor. */
function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
}

// ---------- Anexos (imagem/PDF no prompt) ----------
function iconeAnexo(a) {
  const t = (a.tipo || "") + " " + (a.nome || "");
  if (/image\//.test(a.tipo) || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(a.nome)) return "🖼️";
  if (/pdf/i.test(t)) return "📕";
  return "📎";
}
function anexoChipsHtml(target) {
  const arr = state.anexosPendentes[target] || [];
  const enviando = !!state.busy[`anexo:${target}`];
  const chips = arr.map((a, i) =>
    `<span class="anexo-chip" title="${esc(a.nome)}">${iconeAnexo(a)} <span class="an-nome">${esc(a.nome)}</span>` +
    `<button type="button" class="an-x" data-act="anexo-remove" data-target="${esc(target)}" data-idx="${i}" aria-label="Remover anexo" title="Remover">×</button></span>`).join("");
  const spin = enviando ? `<span class="anexo-chip loading"><span class="spinner"></span> enviando…</span>` : "";
  return chips + spin;
}
function renderAnexos(target) {
  const el = document.getElementById(target === "new-task" ? "anexos-new-task" : "anexos-composer");
  if (el) el.innerHTML = anexoChipsHtml(target);
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}
function escolherAnexos(target) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.accept = "image/*,application/pdf,.pdf,.txt,.md,.csv";
  inp.onchange = () => { uploadAnexos(target, inp.files); };
  inp.click();
}
async function uploadAnexos(target, fileList) {
  const files = [...(fileList || [])];
  if (files.length === 0) return;
  const atuais = state.anexosPendentes[target] || [];
  if (atuais.length + files.length > 8) { toast("Você pode anexar no máximo 8 arquivos."); return; }
  state.busy[`anexo:${target}`] = true;
  renderAnexos(target);
  try {
    const payload = {
      files: await Promise.all(files.map(async (f) => ({ nome: f.name, tipo: f.type, dataBase64: await fileToBase64(f) }))),
    };
    const r = await api("/api/anexos", payload);
    if (r && Array.isArray(r.anexos)) {
      state.anexosPendentes[target] = [...(state.anexosPendentes[target] || []), ...r.anexos];
    }
  } catch {
    toast("Não deu para anexar os arquivos. Tente de novo.");
  } finally {
    state.busy[`anexo:${target}`] = false;
    renderAnexos(target);
  }
}
function limparAnexos(target) {
  state.anexosPendentes[target] = [];
  renderAnexos(target);
}

// ---------- Artefatos (docs + protótipo) do editor ----------
async function loadArtefatos(taskId) {
  const t = getTask(taskId);
  if (!t) return;
  const cur = state.artefatos[taskId];
  if (cur && (cur.loading || cur.at === t.updatedAt)) return; // já em dia
  state.artefatos[taskId] = { ...(cur || { docs: [] }), loading: true, at: t.updatedAt };
  const r = await api(`/api/tasks/${encodeURIComponent(taskId)}/artefatos`);
  state.artefatos[taskId] = { at: t.updatedAt, temPrototipo: !!(r && r.temPrototipo), docs: (r && r.docs) || [], loading: false };
  const root = $("#app")?.firstElementChild;
  if (root && isEditorOf(taskId)) renderArtefatos(root, getTask(taskId));
}
const DOCS_FOLDER_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.2 1.5h4.8A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const DOC_FILE_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 1.5h5L12.5 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.8 1.7V5H12.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

/* Só os documentos QUE A TAREFA GEROU (o excesso do repo não entra); tudo atrás de
   um botão "Documentos · N" com lista rolável e filtro (quando são muitos). */
function docsControlHtml(taskId, docs) {
  const id = esc(taskId);
  const comFiltro = docs.length > 8;
  const rows = docs.map((d) => {
    const parts = String(d.rel).split("/");
    const nome = parts.pop();
    const path = parts.length ? `${parts.join("/")}/` : "";
    return `<button class="doc-row" data-act="ver-doc" data-task="${id}" data-rel="${esc(d.rel)}" data-name="${esc(String(d.rel).toLowerCase())}" title="${esc(d.rel)}">${DOC_FILE_SVG}<span class="fn">${path ? `<span class="dpath">${esc(path)}</span>` : ""}${esc(nome)}</span></button>`;
  }).join("");
  return `<span class="abar-div"></span><span class="af-anchor">
    <button class="docs-btn" data-act="toggle-docs" data-task="${id}" aria-haspopup="true">${DOCS_FOLDER_SVG} Documentos <span class="cnt">${docs.length}</span> <span class="caret">▾</span></button>
    <div class="docs-pop" id="docs-pop-${id}">
      <div class="docs-head"><div class="dh-t">Documentos<span>${docs.length}</span></div>${comFiltro ? `<input class="docs-filter" type="text" placeholder="Filtrar por nome…" aria-label="Filtrar documentos">` : ""}</div>
      <div class="docs-list">${rows}</div>
    </div>
  </span>`;
}

function renderArtefatos(root, t) {
  const el = $("#ed-artefatos", root);
  if (!el || !t) return;
  const art = state.artefatos[t.id] || {};
  const docs = art.docs || [];
  const temProto = !!(art.temPrototipo || t.temPrototipo);
  // Assinatura do conteúdo: só reconstrói quando muda de fato (preserva dropdown/filtro aberto).
  const key = [t.id, !!t.spec, !!t.plan, temProto, docs.map((d) => d.rel).join("|")].join("::");
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const chips = [];
  if (t.spec) chips.push(`<button class="art-chip" data-act="ver-espec" data-task="${esc(t.id)}">📋 Espec</button>`);
  if (t.plan) chips.push(`<button class="art-chip" data-act="ver-plano" data-task="${esc(t.id)}">🗺️ Plano</button>`);
  if (temProto) chips.push(`<a class="art-chip" href="/api/tasks/${esc(t.id)}/mockup/" target="_blank" rel="noreferrer">🎨 Protótipo</a>`);
  const docsCtl = docs.length ? docsControlHtml(t.id, docs) : "";
  el.innerHTML = (chips.length || docs.length) ? `<span class="art-label">Artefatos</span>${chips.join("")}${docsCtl}` : "";
}

/* Filtro ao vivo da lista de documentos (mostra "nenhum" quando nada casa). */
function filtrarDocs(input) {
  const list = input.closest(".docs-pop")?.querySelector(".docs-list");
  if (!list) return;
  const q = input.value.trim().toLowerCase();
  let vis = 0;
  list.querySelectorAll(".doc-row").forEach((r) => {
    const casa = r.dataset.name.includes(q);
    r.style.display = casa ? "" : "none";
    if (casa) vis++;
  });
  let vazio = list.querySelector(".docs-empty");
  if (vis === 0) {
    if (!vazio) { vazio = document.createElement("div"); vazio.className = "docs-empty"; vazio.textContent = "Nenhum documento com esse nome."; list.appendChild(vazio); }
    vazio.style.display = "";
  } else if (vazio) vazio.style.display = "none";
}
/* Modal simples para ler um artefato em markdown (<dialog> nativo). */
function abrirDocModal(titulo, markdown) {
  const dlg = document.createElement("dialog");
  dlg.className = "doc-dialog";
  dlg.innerHTML = `<div class="doc-dialog-head"><b>${esc(titulo)}</b>
    <button class="icon-btn" data-act="fechar-doc" aria-label="Fechar" title="Fechar">✕</button></div>
    <div class="doc-dialog-body">${mdBlock(String(markdown || ""))}</div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // clicar no backdrop fecha
  dlg.showModal();
}

// ---------- Peças compartilhadas ----------
function flowHtml(t) {
  const ativos = stepsAtivos(t);
  // Se o step atual não está no fluxo previsto (ex.: design mudou no meio), usa a
  // ordem global pra não renderizar a barra toda cinza.
  const seq = ativos.includes(t.step) ? ativos : STEPS;
  const idx = seq.indexOf(t.step);
  const parts = [];
  seq.forEach((s, i) => {
    if (i > 0) parts.push(`<div class="bar ${i <= idx ? "done" : ""}"></div>`);
    const done = i < idx || (i === idx && t.step === "concluida");
    const now = i === idx && t.step !== "concluida";
    const cls = [
      "step",
      HUMAN_STEPS.includes(s) ? "human" : "",
      done ? "done" : "",
      now ? "now" : "",
      now && t.status === "falhou" ? "fail" : "",
    ].filter(Boolean).join(" ");
    const dur = fmtDur(stepDurMs(t, s));
    const durHtml = dur ? `<span class="step-dur">${now ? "⏱ " : ""}${dur}</span>` : "";
    parts.push(`<div class="${cls}" data-step="${s}"><i class="pin"></i><span>${esc(STEP_LABELS[s])}</span>${durHtml}</div>`);
  });
  return `<div class="flow-wrap"><div class="flow">${parts.join("")}</div></div>`;
}

function statusChip(t) {
  if (t.status === "rodando") return `<span class="chip ok"><span class="spinner"></span> Claude trabalhando</span>`;
  if (t.status === "aguardando") {
    return `<span class="chip wait">${t.step === "teste" ? "Pronto pro seu teste" : "Aguardando você"}</span>`;
  }
  if (t.status === "falhou" && t.pausadaManual) return `<span class="chip wait">Pausada</span>`;
  if (t.status === "falhou" && t.pausadaPorTempo) return `<span class="chip wait">Passo longo</span>`;
  if (t.status === "falhou") return `<span class="chip bad">Falhou</span>`;
  if (t.status === "concluida") return `<span class="chip ok">Concluída ✓</span>`;
  return `<span class="chip">Cancelada</span>`;
}

function gateChips(t) {
  if (!t.gates || t.gates.length === 0) return `<span class="chip">Sem verificações automáticas</span>`;
  return t.gates
    .map((g) => `<span class="chip ${g.ok ? "ok" : "bad"}">${esc(g.name)} ${g.ok ? "✓" : "✗"}</span>`)
    .join("");
}

function planSummary(t) {
  const p = String(t.plan || "").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim();
  if (!p) return "Plano pronto para a sua revisão.";
  return `Plano pronto: ${p.length > 150 ? `${p.slice(0, 150)}…` : p}`;
}

// ---------- INÍCIO ----------
function renderHome() {
  const projects = state.projects;
  const busyClone = !!state.busy.clone;
  const busyCreate = !!state.busy.create;
  const claudeOff = state.loaded && !state.claude.ok;

  const ativos = projects.filter((p) => !p.arquivadoEm);
  const arquivados = projects.filter((p) => p.arquivadoEm);
  const projectsHtml = ativos.length
    ? `<div class="repo-grid">${ativos.map(projectCardHtml).join("")}</div>`
    : projects.length
      ? `<div class="empty-card" style="margin-bottom:16px">Todos os seus projetos estão arquivados. Abra “Arquivados” abaixo para restaurar, ou crie um novo.</div>`
      : `<div class="empty-card" style="margin-bottom:32px">${state.loaded
          ? "Nenhum projeto por aqui ainda. Abra um do GitHub ou crie um app novo logo abaixo."
          : `<span class="spinner"></span> Carregando os seus projetos…`}</div>`;
  const arquivadosHtml = arquivados.length
    ? `<details class="arquivados-sect">
        <summary>Arquivados <span class="cnt">${arquivados.length}</span></summary>
        <div class="repo-grid" style="margin-top:14px">${arquivados.map(projectCardHtml).join("")}</div>
      </details>`
    : "";

  const progressEntries = Object.entries(state.progress);
  const progressHtml = progressEntries.map(([name, pr]) => `
    <div>
      <div class="prog-lbl">${esc(name)} — ${esc(pr.message)}</div>
      <div class="progress ${typeof pr.pct === "number" ? "" : "indet"}"><i style="width:${typeof pr.pct === "number" ? Math.max(2, Math.min(100, pr.pct)) : 40}%"></i></div>
    </div>`).join("");

  renderPage(`
  <div class="view view-page view-home">
    <div class="home-main">
      <h2 class="hello">Bom te ver.</h2>
      <p class="hello-sub">Abra um projeto do seu GitHub ou crie um app novo — tudo em português, sem terminal.</p>

      ${claudeOff ? primeirosPassosHtml() : ""}

      <div class="sect"><h3>Meus projetos</h3><span>${ativos.length ? "cada tarefa roda num espaço isolado, sem conflito" : ""}</span></div>
      ${projectsHtml}
      ${arquivadosHtml}

      ${state.fake ? debugPanelHtml() : ""}

      <div class="sect"><h3>Adicionar projeto</h3><span>do GitHub ou um app novo do zero</span></div>
      <div class="add-grid">
        <form class="repo-card" data-form="clone">
          <div class="rh"><span class="gh-ico">gh</span><b>Abrir do GitHub</b></div>
          <p>Cole o endereço do repositório. O download acontece sozinho, com barra de progresso.</p>
          <div class="field-row">
            <input id="clone-url" type="url" placeholder="https://github.com/seu-usuario/…" autocomplete="off" ${busyClone || claudeOff ? "disabled" : ""} required>
            <button class="btn sm primary" type="submit" ${busyClone || claudeOff ? "disabled" : ""}>${busyClone ? `<span class="spinner"></span> Baixando…` : "Baixar e abrir"}</button>
          </div>
          ${progressHtml}
        </form>

        <form class="repo-card" data-form="create-app">
          <div class="rh"><span class="app-ico" style="background:var(--brand)">+</span><b>Criar app novo</b></div>
          <p>Começa do template <b>App inicial</b>: design system, login e navegação já prontos.</p>
          <div class="field-row">
            <input id="new-app-name" type="text" placeholder="Nome do app… ex.: Quiz de Onboarding" autocomplete="off" ${busyCreate || claudeOff ? "disabled" : ""} required>
            <button class="btn sm primary" type="submit" ${busyCreate || claudeOff ? "disabled" : ""}>${busyCreate ? `<span class="spinner"></span> Criando…` : "Criar"}</button>
          </div>
        </form>
      </div>

      <div class="home-foot">${claudeFootHtml()}</div>
    </div>
  </div>`);
}

// Painel de Debug (só no modo fake): dispara um cenário da matriz e abre a
// tarefa para você assistir a jornada estado por estado, sem gastar Claude.
function debugPanelHtml() {
  const scs = state.debugScenarios;
  const semProjeto = state.projects.length === 0;
  const projectOptions = state.projects
    .map((p) => `<option value="${esc(p.id)}"${p.id === selectedProjectId() ? " selected" : ""}>${esc(p.name)}</option>`)
    .join("");
  const selId = state.debugSel || (scs && scs[0] && scs[0].id) || "";
  const scOptions = (scs || [])
    .map((s) => `<option value="${esc(s.id)}"${s.id === selId ? " selected" : ""}>${esc(s.label)}</option>`)
    .join("");
  const sel = (scs || []).find((s) => s.id === selId);

  return `
  <div class="sect"><h3>🐛 Debug da esteira</h3><span>modo fake ligado — testa as jornadas sem gastar Claude</span></div>
  <div class="repo-card debug-card">
    ${scs === null
      ? `<p><span class="spinner"></span> Carregando cenários…</p>`
      : `<div class="field-row">
      <select id="debug-project" ${semProjeto ? "disabled" : ""}>${projectOptions || `<option>— crie um app abaixo —</option>`}</select>
      <select id="debug-scenario">${scOptions}</select>
    </div>
    <p class="debug-resumo">${sel ? debugScenarioResumo(sel) : ""}</p>
    <div class="field-row debug-run-row">
      <label class="debug-auto"><input type="checkbox" id="debug-autodrive" ${state.debugAutoDrive ? "checked" : ""}> Auto-piloto (aprova as porteiras sozinho)</label>
      <button class="btn sm primary" data-act="debug-run" ${semProjeto ? "disabled" : ""}>Rodar cenário</button>
    </div>
    ${semProjeto ? `<p class="debug-hint">Crie um app novo abaixo para ter onde rodar os cenários.</p>` : ""}`}
  </div>`;
}

function debugScenarioResumo(s) {
  const tags = [
    `porte: <b>${esc(s.porte)}</b>`,
    `UI: ${s.ui ? "sim" : "não"}`,
    `design: ${s.design ? "sim" : "não"}`,
    `gates: ${esc(s.gates)}`,
  ];
  if (s.bypass) tags.push(`bypass: ${esc(s.bypass)}`);
  if (s.setDesign) tags.push(`set_design: ${esc(s.setDesign)}`);
  if (s.preparacao) tags.push("preparação");
  if (s.requerRealGates) tags.push("⚠ precisa --real-gates");
  return `${tags.join(" · ")}<br><span class="debug-steps">${esc((s.expectSteps || []).join(" → "))} · fim: ${esc(s.expectFinal)}</span>`;
}

/** Opções de <select> de projeto: esconde arquivados, mas mantém o já selecionado. */
function opcoesProjeto(pid) {
  return state.projects
    .filter((p) => !p.arquivadoEm || p.id === pid)
    .map((p) => `<option value="${esc(p.id)}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}${p.arquivadoEm ? " (arquivado)" : ""}</option>`)
    .join("");
}

function projectCardHtml(p) {
  const n = state.tasks.filter(
    (t) => t.projectId === p.id && t.status !== "concluida" && t.status !== "cancelada",
  ).length;
  const tarefas = n === 0 ? "Sem tarefas ativas" : n === 1 ? "1 tarefa ativa" : `${n} tarefas ativas`;
  const arq = !!p.arquivadoEm;
  // O card inteiro é clicável: abre o projeto (ou restaura, se arquivado). O menu ⋯
  // e seus itens não disparam isso (são <button>, tratados antes no handler de clique).
  const abrir = arq
    ? `data-restore-project="${esc(p.id)}" title="Clique para restaurar “${esc(p.name)}”"`
    : `data-open-project="${esc(p.id)}" title="Abrir “${esc(p.name)}”"`;
  return `<div class="repo-card clickable ${arq ? "arquivado" : ""}" ${abrir} role="button" tabindex="0">
    <div class="rh">
      <span class="app-ico" style="background:${icoColor(p.name)}">${esc((p.name[0] || "?").toUpperCase())}</span>
      <b>${esc(p.name)}</b>
      <span class="chip">${p.kind === "repo" ? "GitHub" : "App"}</span>
      <div class="proj-menu-wrap">
        <button class="proj-kebab" data-act="proj-menu" data-project="${esc(p.id)}" aria-label="Mais ações deste projeto" aria-haspopup="menu">⋯</button>
        <div class="proj-menu-pop" id="proj-menu-${esc(p.id)}" role="menu">
          ${arq
            ? `<button role="menuitem" data-act="desarquivar-projeto" data-project="${esc(p.id)}">Desarquivar</button>`
            : `<button role="menuitem" data-act="arquivar-projeto" data-project="${esc(p.id)}">Arquivar</button>`}
          <button role="menuitem" class="perigo" data-act="excluir-projeto" data-project="${esc(p.id)}">Excluir…</button>
        </div>
      </div>
    </div>
    <p>${arq ? `Arquivado ${timeAgo(p.arquivadoEm)} · clique para restaurar` : `${tarefas} · criado ${timeAgo(p.createdAt)}`}</p>
  </div>`;
}

// Painel de primeiros passos quando o Claude não está conectado: sem ele,
// nenhuma tarefa roda, então bloqueamos criar/clonar e explicamos o passo-a-passo.
// O chip fica verde sozinho assim que o login terminar (evento SSE claude_status).
function primeirosPassosHtml() {
  const detalhe = state.claude.detail ? esc(state.claude.detail) : "";
  return `<div class="onboarding" role="status" aria-live="polite">
    <div class="ob-head"><span class="warn-dot"></span><b>Conecte o Claude para começar</b></div>
    <p>O Inhouse trabalha com o Claude Code deste computador, usando a sua assinatura. Enquanto ele não estiver conectado, abrir projetos e criar apps fica desabilitado.${detalhe ? ` <span class="ob-detail">(${detalhe})</span>` : ""}</p>
    <ol class="ob-steps">
      <li>Abra o app <b>Terminal</b> (aperte <kbd>⌘</kbd>+<kbd>Espaço</kbd>, digite <b>Terminal</b> e Enter).</li>
      <li>Digite <code>claude</code> e tecle Enter; se ele pedir, faça o login que abre no navegador.</li>
      <li>Pronto — volte aqui. Assim que conectar, tudo se habilita sozinho, sem recarregar.</li>
    </ol>
    <div class="ob-foot"><a href="${DOCS_URL}" target="_blank" rel="noreferrer">Ainda não instalou o Claude? Veja como</a></div>
  </div>`;
}

function claudeFootHtml() {
  if (!state.loaded) return `<span class="spinner"></span> Verificando o Claude neste computador…`;
  if (state.claude.ok) {
    return `<span class="dot"></span> Claude conectado · sua assinatura${state.claude.version ? ` · v${esc(state.claude.version)}` : ""}`;
  }
  return `<span class="warn-dot"></span> Claude Code não encontrado — instale e rode <code>claude login</code>.
    <a href="${DOCS_URL}" target="_blank" rel="noreferrer">Como instalar</a>`;
}

// ---------- TAREFAS (quadro) ----------
function renderBoard() {
  if (state.projects.length === 0) {
    renderPage(`<div class="view view-page"><div class="center-box">
      ${state.loaded
        ? `<p>Nenhum projeto ainda.</p><a class="btn primary" href="#/">Adicionar um projeto</a>`
        : `<span class="spinner lg"></span><p>Carregando…</p>`}
    </div></div>`);
    return;
  }
  const pid = selectedProjectId();
  const todas = state.tasks
    .filter((t) => t.projectId === pid)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const tasks = todas.filter((t) => !t.arquivadaEm);
  const arquivadas = todas.filter((t) => t.arquivadaEm);
  const ativas = tasks.filter((t) => t.status === "rodando" || t.status === "aguardando").length;
  const proj = state.projects.find((p) => p.id === pid);
  const temPreparacao = todas.some((t) => t.kind === "preparacao");
  const mostrarPreparar = !!proj && proj.kind === "repo" && !proj.preparado && !temPreparacao;
  const statusLine = ativas === 0
    ? "nenhuma tarefa em andamento"
    : ativas === 1
      ? "1 tarefa em andamento · num espaço isolado"
      : `${ativas} tarefas em paralelo · cada uma no seu espaço isolado`;
  const claudeOff = state.loaded && !state.claude.ok;

  renderPage(`
  <div class="view view-board">
    <div class="topbar">
      <select id="project-select" class="repo-pick" aria-label="Escolher projeto" title="${esc(proj?.name || "")}">
        ${opcoesProjeto(pid)}
      </select>
      <div class="status">${statusLine}</div>
      <button class="btn sm primary" data-act="focus-new-task">+ Nova tarefa</button>
    </div>
    <div class="board">
      <form class="new-task compose-form" data-form="new-task">
        <textarea id="new-task-desc" class="grow-area" rows="1" data-enter-submit placeholder="${(state.novaTarefaModo === "livre") ? "Diga o que fazer — você conduz o Claude direto (pode pedir /review, /qa…). Shift+Enter quebra linha" : "Descreva uma tarefa… ex.: “corrigir o filtro de turmas por data no backoffice” — Shift+Enter quebra linha"}" aria-label="Descrição da nova tarefa" ${claudeOff ? "disabled" : ""}></textarea>
        <div class="compose-anexos" id="anexos-new-task">${anexoChipsHtml("new-task")}</div>
        <div class="compose-bar">
          <button type="button" class="attach-btn" data-act="attach" data-target="new-task" title="Anexar arquivos (imagem, PDF)" ${claudeOff ? "disabled" : ""}>📎 Anexar</button>
          <span class="modo-seg" role="group" aria-label="Modo da tarefa">
            <button type="button" class="${state.novaTarefaModo !== "livre" ? "on" : ""}" data-act="set-modo" data-modo="esteira" title="Passa pela esteira: plano, suas aprovações e verificações">Esteira</button>
            <button type="button" class="${state.novaTarefaModo === "livre" ? "on" : ""}" data-act="set-modo" data-modo="livre" title="Sem esteira: você conduz o Claude direto e escolhe as skills no chat">Livre</button>
          </span>
          <span class="gap"></span>
          <button class="btn sm primary" type="submit" ${claudeOff ? "disabled" : ""}>Começar</button>
        </div>
        ${state.novaTarefaModo === "livre" ? `<p class="modo-hint">⚡ <b>Modo livre:</b> vai direto, sem plano nem porteiras — você conduz e pede <code>/review</code>, <code>/qa</code> etc. quando quiser. Publique quando estiver pronto.</p>` : ""}
      </form>
      ${claudeOff ? primeirosPassosHtml() : ""}
      ${mostrarPreparar && !claudeOff ? `
        <div class="prepare-card">
          <div class="head">🛠️ Preparar este projeto</div>
          <p>Antes de criar tarefas, deixe o Claude conferir e instalar o que o projeto precisa (dependências, variáveis de ambiente, scripts de setup) e te avisar se falta algo do sistema — como o Docker.</p>
          <button class="btn primary" data-act="preparar-projeto" data-project="${esc(pid)}">Preparar este projeto</button>
        </div>` : ""}
      ${tasks.length
        ? tasks.map(taskCardHtml).join("")
        : `<div class="empty-card">Nenhuma tarefa neste projeto ainda. Descreva a primeira ali em cima — o Claude cuida do resto.</div>`}
      ${arquivadas.length ? `
        <div class="arquivadas-sep">
          <button class="btn sm ghost" data-act="toggle-arquivadas">${state.showArquivadas ? "Ocultar" : "Ver"} arquivadas (${arquivadas.length})</button>
        </div>
        ${state.showArquivadas ? arquivadas.map(taskCardHtml).join("") : ""}` : ""}
    </div>
  </div>`);
}

function taskCardHtml(t) {
  if (t.arquivadaEm) {
    return `<div class="task archived">
      <div class="task-head">
        <b>${esc(t.title)}</b>
        <span class="chip">arquivada</span>
        <div class="meta">${t.prUrl ? `<a class="link" href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">Ver no GitHub</a> · ` : ""}<button class="btn sm ghost" data-act="desarquivar" data-task="${esc(t.id)}">Desarquivar</button></div>
      </div>
    </div>`;
  }
  if (t.kind === "preparacao") return preparacaoCardHtml(t);
  const perm = state.permissions.find((p) => p.taskId === t.id);
  const cls = t.status === "falhou" ? "failed"
    : t.status === "rodando" ? "running"
    : perm || t.status === "aguardando" ? "waiting"
    : "done-task";
  return `<div class="task ${cls}" data-open-task="${esc(t.id)}" title="Abrir a tarefa (chat, plano e preview)">
    <div class="task-head">
      <b>${esc(t.title)}</b>
      ${t.modo === "livre" ? `<span class="chip modo-chip">⚡ livre</span>` : ""}
      ${statusChip(t)}
      <div class="meta"><span class="chip">espaço ${t.espaco}</span>
      <button class="btn sm ${t.autoAprovar ? "primary" : "ghost"}" data-act="auto-toggle" data-task="${esc(t.id)}" title="Com o modo auto ligado, ações sensíveis não pedem permissão">${t.autoAprovar ? `<span class="dot"></span> Auto ligado` : "Auto: desligado"}</button> ${timeAgo(t.updatedAt)}</div>
    </div>
    ${t.status === "concluida" || t.status === "cancelada" || t.modo === "livre" ? "" : flowHtml(t)}
    ${taskFootHtml(t, perm)}
  </div>`;
}

function preparacaoCardHtml(t) {
  const id = esc(t.id);
  const cls = t.status === "falhou" ? "failed" : t.status === "rodando" ? "running" : "done-task";
  const foot = t.status === "rodando"
    ? `<span><span class="spinner"></span> Preparando o projeto…</span><span class="gap"></span><a class="link" href="#/tarefa/${id}">Acompanhar →</a>`
    : t.status === "falhou"
      ? `<span class="fail-msg">${esc(t.error || "A preparação falhou.")}</span><span class="gap"></span>
         <button class="btn sm" data-act="go-task" data-task="${id}">Ver detalhes</button>
         <button class="btn sm ghost" data-act="arquivar" data-task="${id}">Arquivar</button>
         <button class="btn sm primary" data-act="retry" data-task="${id}">Tentar de novo</button>`
      : `<span>✓ Preparação concluída</span><span class="gap"></span>
         <a class="link" href="#/tarefa/${id}">Ver o resumo</a>
         <button class="btn sm ghost" data-act="arquivar" data-task="${id}">Arquivar</button>`;
  return `<div class="task ${cls}" data-open-task="${id}" title="Preparação do projeto">
    <div class="task-head"><b>🛠️ Preparação do projeto</b> ${statusChip(t)}
      <div class="meta">${timeAgo(t.updatedAt)}</div></div>
    <div class="task-foot">${foot}</div>
  </div>`;
}

function taskFootHtml(t, perm) {
  const rows = [];
  const id = esc(t.id);
  if (perm) {
    rows.push(`<div class="perm-strip"><span class="pulse"></span> Aguardando sua permissão: ${esc(perm.friendly)}
      <span class="gap"></span>
      <button class="btn sm primary" data-act="go-task" data-task="${id}">Responder</button></div>`);
  }
  if (t.status === "falhou" && t.pausadaManual) {
    rows.push(`<div class="task-foot"><span class="wait-msg">⏸ Pausada por você.</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Abrir</button>
      <button class="btn sm primary" data-act="retry" data-task="${id}">Retomar</button></div>`);
  } else if (t.status === "falhou" && t.pausadaPorTempo) {
    rows.push(`<div class="task-foot"><span class="wait-msg">⏱ Este passo está trabalhando há mais de 1 hora — nada quebrou.</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Ver o que ele está fazendo</button>
      <button class="btn sm primary" data-act="retry" data-task="${id}">Continuar assim mesmo</button></div>`);
  } else if (t.status === "falhou") {
    rows.push(`<div class="task-foot"><span class="fail-msg">${esc(t.error || "Algo deu errado neste passo.")}</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Ver detalhes</button>
      <button class="btn sm ghost" data-act="arquivar" data-task="${id}" title="Some do quadro e libera o espaço">Arquivar</button>
      <button class="btn sm primary" data-act="retry" data-task="${id}">Tentar de novo</button></div>`);
  } else if (t.status === "rodando") {
    rows.push(`<div class="task-foot"><span><span class="spinner"></span> Claude trabalhando no passo “${esc(STEP_LABELS[t.step] ?? t.step)}”${stepAtualDesde(t) ? ` · ${timeAgo(stepAtualDesde(t))}` : ""}…</span>
      <span class="gap"></span>
      ${t.step === "plano" ? `<button class="btn sm ghost" data-act="plano-rapido" data-task="${id}" title="Pular os reviews e ir direto ao plano">É simples — ir direto ao plano</button>` : ""}
      ${t.step !== "publicar" ? `<button class="btn sm ghost" data-act="pause" data-task="${id}" title="Pausar este passo — dá para retomar depois">Pausar</button>` : ""}
      <a class="link" href="#/tarefa/${id}">Acompanhar no editor →</a></div>`);
  } else if (t.modo === "livre" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span>Modo livre — sua vez de instruir ou publicar.</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Abrir chat</button>
      <button class="btn sm primary" data-act="publish" data-task="${id}">Publicar</button></div>`);
  } else if (t.step === "aprovacao" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span class="plan-sum">${esc(planSummary(t))}</span>
      <span class="gap"></span>
      <a class="link" href="#/tarefa/${id}">Ver detalhes</a>
      <button class="btn sm ghost" data-act="request-changes" data-task="${id}">Pedir mudanças</button>
      <button class="btn sm primary" data-act="approve-plan" data-task="${id}">Aprovar plano</button></div>`);
  } else if (t.step === "aprovacao_prototipo" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span class="plan-sum">Protótipo pronto — aprove o visual</span>
      <span class="gap"></span>
      <a class="btn sm" href="/api/tasks/${id}/mockup/" target="_blank" rel="noreferrer">Ver protótipo</a>
      <button class="btn sm ghost" data-act="request-changes" data-task="${id}">Pedir mudanças</button>
      <button class="btn sm primary" data-act="approve-prototype" data-task="${id}">Aprovar</button></div>`);
  } else if (t.step === "teste" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span class="minigates">${gateChips(t)}</span>
      <span class="gap"></span>
      <button class="btn sm ghost" data-act="go-task" data-task="${id}">Abrir chat</button>
      <button class="btn sm" data-act="board-preview" data-task="${id}">Abrir preview</button>
      <button class="btn sm primary" data-act="go-task" data-task="${id}">Aprovar e publicar…</button></div>`);
  } else if (t.step === "publicar" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span>Aprovada no seu teste — falta só publicar.</span>
      <span class="gap"></span>
      <button class="btn sm primary" data-act="go-task" data-task="${id}">Abrir para publicar</button></div>`);
  } else if (t.status === "concluida") {
    rows.push(`<div class="task-foot"><span>Todos os passos concluídos · mudança publicada no projeto</span>
      <span class="gap"></span>
      ${localStorage.getItem(`inhouse.feedback.${id}`) ? "" : `<span class="fb-inline"><button class="fb-emoji" data-act="feedback" data-task="${id}" data-nota="otimo">😃</button><button class="fb-emoji" data-act="feedback" data-task="${id}" data-nota="ok">😐</button><button class="fb-emoji" data-act="feedback" data-task="${id}" data-nota="ruim">😖</button></span>`}
      ${t.prUrl ? `<a class="link" href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">Ver no GitHub</a>` : ""}
      <button class="btn sm ghost" data-act="arquivar" data-task="${id}" title="Some do quadro e libera o espaço">Arquivar</button></div>`);
  } else if (t.status === "cancelada") {
    rows.push(`<div class="task-foot"><span>Tarefa cancelada.</span>
      <span class="gap"></span>
      <button class="btn sm ghost" data-act="arquivar" data-task="${id}" title="Some do quadro e libera o espaço">Arquivar</button></div>`);
  } else if (!perm) {
    rows.push(`<div class="task-foot"><a class="link" href="#/tarefa/${id}">Abrir no editor →</a></div>`);
  }
  return rows.join("");
}

// ---------- EDITOR ----------
function renderEditor(id) {
  const appEl = $("#app");
  const t = getTask(id);
  if (!t) {
    appEl.innerHTML = state.loaded
      ? `<div class="view view-page"><div class="center-box"><p>Tarefa não encontrada.</p><a class="btn" href="#/tarefas">Voltar para as tarefas</a></div></div>`
      : `<div class="view view-page"><div class="center-box"><span class="spinner lg"></span><p>Carregando…</p></div></div>`;
    return;
  }
  const p = getProject(t.projectId);

  let root = appEl.firstElementChild;
  if (!root || root.dataset.view !== "editor" || root.dataset.task !== id) {
    appEl.innerHTML = editorShellHtml(t, p);
    root = appEl.firstElementChild;
    state.anexosPendentes["composer"] = []; // não vaza anexos pendentes entre tarefas
    loadTranscript(id);
  }

  // Regiões atualizadas a cada evento (o shell — e o iframe — ficam no lugar).
  $("#ed-title", root).textContent = `${p ? p.name : "?"} · ${t.title}`;
  $("#ed-espaco", root).textContent = `espaço ${t.espaco}`;
  $("#ed-status", root).innerHTML = editorStatusHtml(t);
  const ativa = t.status !== "concluida" && t.status !== "cancelada";
  $("#ed-topactions", root).innerHTML = [
    (t.step === "publicar" && t.status === "aguardando") || (t.modo === "livre" && t.status === "aguardando")
      ? `<button class="btn sm primary" data-act="publish" data-task="${esc(t.id)}" ${state.busy[`publish:${t.id}`] ? "disabled" : ""}>Publicar</button>`
      : "",
    t.status === "rodando" && t.step !== "publicar"
      ? `<button class="btn sm ghost" data-act="pause" data-task="${esc(t.id)}" title="Pausar este passo — dá para retomar depois">Pausar</button>`
      : "",
    ativa
      ? `<button class="btn sm ghost" data-act="cancel" data-task="${esc(t.id)}">Cancelar tarefa</button>`
      : "",
  ].join("");
  $("#ed-flowstrip", root).innerHTML = t.modo === "livre"
    ? `<span>⚡ <b>Modo livre</b> — você conduz o Claude direto: sem plano nem porteiras. Peça <code>/review</code>, <code>/qa</code> etc. no chat e publique quando quiser.</span>`
    : `<span>Onde essa tarefa está: <b>${esc(STEP_LABELS[t.step] ?? t.step)}</b></span>${flowHtml(t)}${nextGateChip(t)}`;
  renderArtefatos(root, t);
  loadArtefatos(id);
  renderChat(id);
  updatePreview(root, t);
  updateComposer(root, t);
}

function editorShellHtml(t, p) {
  const name = p?.name || "?";
  return `<div class="view view-editor" data-view="editor" data-task="${esc(t.id)}">
    <div class="topbar">
      <a class="btn sm ghost back" href="#/tarefas" title="Voltar para as tarefas" aria-label="Voltar">←</a>
      <div class="app-name">
        <span class="app-ico" style="background:${icoColor(name)}">${esc(name[0].toUpperCase())}</span>
        <span id="ed-title"></span>
        <span class="chip" id="ed-espaco"></span>
      </div>
      <div class="status" id="ed-status"></div>
      <span id="ed-topactions"></span>
    </div>
    <div class="flow-strip" id="ed-flowstrip"></div>
    <div class="artefatos-bar" id="ed-artefatos"></div>
    <div class="editor-body">
      <div class="chat">
        <div class="chat-scroll" id="chat-scroll"></div>
        <form class="composer" data-form="composer">
          <div class="compose-anexos" id="anexos-composer"></div>
          <div class="composer-box">
            <button type="button" class="attach-btn icon" id="composer-attach" data-act="attach" data-target="composer" title="Anexar arquivos (imagem, PDF)" aria-label="Anexar arquivos">📎</button>
            <textarea id="composer-input" class="grow-area" rows="1" autocomplete="off" data-enter-submit placeholder="" aria-label="Mensagem para o Claude"></textarea>
            <button class="send" id="composer-send" type="submit" title="Enviar">↑</button>
          </div>
        </form>
      </div>
      <div class="preview" id="preview-pane"></div>
    </div>
  </div>`;
}

function editorStatusHtml(t) {
  const permPend = state.permissions.some((p) => p.taskId === t.id);
  if (permPend) return `<span style="color:var(--amber);font-weight:600">Aguardando sua permissão — veja o chat</span>`;
  if (t.modo === "livre") {
    if (t.status === "rodando") return `<b class="live-dot">●</b> Claude trabalhando…`;
    if (t.status === "falhou" && t.pausadaManual) return `<span class="wait-msg">Pausada — retome quando quiser</span>`;
    if (t.status === "falhou") return `<span class="fail-msg">Deu um erro — veja o chat</span>`;
    if (t.status === "concluida") return `Publicada ✓`;
    if (t.status === "cancelada") return `Cancelada`;
    return `Sua vez — instrua ou publique`;
  }
  if (t.status === "rodando") return `<b class="live-dot">●</b> Claude trabalhando · ${esc(STEP_LABELS[t.step] ?? t.step)}`;
  if (t.status === "falhou" && t.pausadaManual) return `<span class="wait-msg">Pausada — retome quando quiser</span>`;
  if (t.status === "falhou") return `<span class="fail-msg">Este passo falhou — veja o chat</span>`;
  if (t.status === "concluida") return `Tarefa concluída ✓`;
  if (t.status === "cancelada") return `Tarefa cancelada`;
  return `Aguardando você · ${esc(STEP_LABELS[t.step] ?? t.step)}`;
}

function nextGateChip(t) {
  if (t.step === "concluida") return `<span class="chip ok">Concluída ✓</span>`;
  if (HUMAN_STEPS.includes(t.step)) {
    return `<span class="chip wait">sua vez: ${esc(STEP_LABELS[t.step].toLowerCase())}</span>`;
  }
  const seq = stepsAtivos(t); // próxima porteira DESTE fluxo (não a global)
  const idx = seq.indexOf(t.step);
  const next = seq.slice(idx + 1).find((s) => HUMAN_STEPS.includes(s));
  return next ? `<span class="chip">próxima porteira: ${esc(STEP_LABELS[next].toLowerCase())}</span>` : "";
}

function renderChat(id) {
  const scroller = $("#chat-scroll");
  if (!scroller || !isEditorOf(id)) return;
  const t = getTask(id);
  const c = tcache(id);
  const stick = nearBottom(scroller);
  const prevTop = scroller.scrollTop;

  const parts = [];
  if (!c.loaded && c.loading) parts.push(`<div class="sys-row"><span class="spinner"></span> Carregando a conversa…</div>`);
  else if (c.loaded && c.items.length === 0 && !c.stream) {
    parts.push(`<div class="empty-chat">A conversa desta tarefa aparece aqui — o Claude conta o que está fazendo em cada passo.</div>`);
  }
  for (const item of c.items) parts.push(transcriptItemHtml(item));
  if (c.stream) parts.push(`<div class="msg-ai" id="stream-bubble">${mdLite(c.stream)}<span class="caret-blink"></span></div>`);
  parts.push(`<div id="chat-cards">${t ? chatCardsHtml(t) : ""}</div>`);

  scroller.innerHTML = parts.join("");
  scroller.scrollTop = stick ? scroller.scrollHeight : prevTop;
}

function transcriptItemHtml(item) {
  if (item.kind === "user") return `<div class="msg-user">${mdLite(item.text)}</div>`;
  if (item.kind === "assistant") return `<div class="msg-ai">${mdLite(item.text)}</div>`;
  if (item.kind === "system") return `<div class="sys-row">${esc(item.text)}</div>`;
  if (item.kind === "tool") {
    const opCls = item.op === "$" ? "op-cmd" : "";
    return `<div class="tool-row"><span class="op ${opCls}">${esc(item.op)}</span> ${esc(item.label)}${item.detail ? ` <code>${esc(item.detail)}</code>` : ""}</div>`;
  }
  return "";
}

function chatCardsHtml(t) {
  const parts = state.permissions.filter((p) => p.taskId === t.id).map(permCardHtml);
  if (t.status === "falhou") parts.push(failCardHtml(t));
  if (t.status === "aguardando") {
    if (t.step === "aprovacao") parts.push(planCardHtml(t));
    if (t.step === "aprovacao_prototipo") parts.push(prototipoCardHtml(t));
    if (t.step === "teste") parts.push(testCardHtml(t));
    if (t.step === "publicar") parts.push(publishCardHtml(t));
  }
  if (t.status === "concluida") {
    if (t.kind === "preparacao") {
      parts.push(`<div class="publish-card"><div class="head">✓ Preparação concluída</div>
        <p>Veja o resumo acima. Se ainda faltar algo do sistema, resolva e rode a preparação de novo.</p></div>`);
    } else {
      parts.push(`<div class="publish-card"><div class="head">✓ Tarefa concluída</div>
        <p>A mudança foi publicada no projeto.${t.prUrl ? ` <a href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">Ver o PR no GitHub</a>` : ""}</p>
        ${feedbackWidgetHtml(t)}</div>`);
    }
  }
  return parts.join("");
}

function feedbackWidgetHtml(t) {
  const enviado = localStorage.getItem(`inhouse.feedback.${t.id}`);
  if (enviado) {
    return `<div class="feedback-widget done">Obrigado! Isso ajuda o Inhouse a melhorar.</div>`;
  }
  return `<div class="feedback-widget" data-fb-task="${esc(t.id)}">
    <span class="fb-q">Como foi essa tarefa?</span>
    <button class="fb-emoji" data-act="feedback" data-task="${esc(t.id)}" data-nota="otimo" title="Ótima">😃</button>
    <button class="fb-emoji" data-act="feedback" data-task="${esc(t.id)}" data-nota="ok" title="Ok">😐</button>
    <button class="fb-emoji" data-act="feedback" data-task="${esc(t.id)}" data-nota="ruim" title="Ruim">😖</button>
  </div>`;
}

function permCardHtml(p) {
  return `<div class="approval">
    <div class="head"><span class="pulse"></span> Pedido de permissão</div>
    <p>${esc(p.friendly)}</p>
    <details class="perm-details"><summary>Ver detalhes técnicos</summary><pre>${esc(JSON.stringify(p.input, null, 2))}</pre></details>
    <div class="acts">
      <button class="btn sm primary" data-act="perm-allow" data-perm="${esc(p.id)}">Permitir</button>
      <button class="btn sm ghost" data-act="perm-deny" data-perm="${esc(p.id)}">Agora não</button>
      <button class="btn sm ghost" data-act="auto-on" data-task="${esc(p.taskId)}" title="Permite este e todos os próximos pedidos desta tarefa">Permitir tudo (modo auto)</button>
    </div>
    <label class="remember"><input type="checkbox" id="perm-remember-${esc(p.id)}"> Sempre permitir ações como esta nesta tarefa</label>
  </div>`;
}

function designControlHtml(t) {
  const d = t.design || "auto";
  const btn = (v, label) => `<button class="btn xs ${d === v ? "primary" : "ghost"}" data-act="set-design" data-task="${esc(t.id)}" data-valor="${v}">${label}</button>`;
  const hint = rodaDesign(t)
    ? "vai gerar um protótipo (mockup) pra você aprovar o visual"
    : "sem protótipo — o plano segue direto para o código";
  return `<div class="design-ctl">
    <span class="design-lbl">Design + protótipo:</span> ${btn("auto", "Automático")} ${btn("sim", "Sim")} ${btn("nao", "Não")}
    <span class="design-hint">${hint}</span>
  </div>`;
}

function planCardHtml(t) {
  const simples = (t.porte || "media") === "simples";
  return `<div class="approval">
    <div class="head"><span class="pulse"></span> Plano de produto — sua aprovação</div>
    <div class="plan-body">${mdBlock(t.plan || "O Claude não escreveu um plano detalhado desta vez. Você pode aprovar para seguir, ou pedir mudanças explicando o que espera.")}</div>
    ${simples ? "" : designControlHtml(t)}
    <div class="acts">
      <button class="btn sm primary" data-act="approve-plan" data-task="${esc(t.id)}">Aprovar plano</button>
      ${simples ? "" : `<button class="btn sm" data-act="approve-plan-direto" data-task="${esc(t.id)}" title="Pular detalhamento e protótipo, ir direto pra execução">Aprovar e ir direto</button>`}
      <button class="btn sm ghost" data-act="request-changes" data-task="${esc(t.id)}">Pedir mudanças</button>
    </div>
  </div>`;
}

function prototipoCardHtml(t) {
  return `<div class="approval">
    <div class="head"><span class="pulse"></span> Protótipo pronto — sua aprovação</div>
    <p>Veja o mockup e aprove o visual — ou peça mudanças. Ao aprovar, o Claude implementa de verdade.</p>
    <div class="acts">
      <a class="btn sm" href="/api/tasks/${esc(t.id)}/mockup/" target="_blank" rel="noreferrer">Ver protótipo</a>
      <button class="btn sm primary" data-act="approve-prototype" data-task="${esc(t.id)}">Aprovar protótipo</button>
      <button class="btn sm ghost" data-act="request-changes" data-task="${esc(t.id)}">Pedir mudanças</button>
    </div>
  </div>`;
}

function testCardHtml(t) {
  return `<div class="approval">
    <div class="head"><span class="pulse"></span> Sua vez de testar</div>
    <p>Abra o preview ao lado, confira se ficou como você queria e aprove — ou peça mudanças.</p>
    <div class="gates-row">${gateChips(t)}</div>
    <div class="acts">
      <button class="btn sm primary" data-act="approve-test" data-task="${esc(t.id)}">Aprovar</button>
      <button class="btn sm ghost" data-act="request-changes" data-task="${esc(t.id)}">Pedir mudanças</button>
    </div>
  </div>`;
}

function publishCardHtml(t) {
  const p = getProject(t.projectId);
  const busy = !!state.busy[`publish:${t.id}`];
  return `<div class="publish-card">
    <div class="head">✓ Pronto para publicar</div>
    <p>Verificações e o seu teste aprovados. ${
      p?.originUrl
        ? "Publicar abre um <strong>Pull Request no GitHub</strong> para o time revisar — o projeto não é alterado direto."
        : `Publicar junta as mudanças do espaço ${t.espaco} no app.`
    }</p>
    <div class="acts">
      <button class="btn sm primary" data-act="publish" data-task="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span> Publicando…` : p?.originUrl ? "Abrir Pull Request" : "Publicar no app"}</button>
    </div>
  </div>`;
}

function failCardHtml(t) {
  if (t.pausadaManual) {
    return `<div class="approval">
      <div class="head"><span class="pulse"></span> ⏸ Pausada</div>
      <p>Você pausou este passo. O Claude parou de trabalhar; o que já foi feito está guardado no espaço da tarefa.
      Clique em <b>Retomar</b> para ele continuar de onde parou — se quiser, escreva um ajuste na caixa abaixo antes.</p>
      <div class="acts">
        <button class="btn sm primary" data-act="retry" data-task="${esc(t.id)}">Retomar</button>
        <button class="btn sm ghost" data-act="cancel" data-task="${esc(t.id)}">Cancelar tarefa</button>
      </div>
    </div>`;
  }
  if (t.pausadaPorTempo) {
    return `<div class="approval">
      <div class="head"><span class="pulse"></span> ⏱ Passo longo</div>
      <p>Este passo está trabalhando há mais de 1 hora — nada quebrou. Ele foi pausado por segurança
      e pode continuar exatamente de onde parou. Se preferir mudar a direção, escreva na caixa abaixo.</p>
      <div class="acts">
        <button class="btn sm primary" data-act="retry" data-task="${esc(t.id)}">Continuar assim mesmo</button>
        <button class="btn sm ghost" data-act="cancel" data-task="${esc(t.id)}">Cancelar tarefa</button>
      </div>
    </div>`;
  }
  const hasBadGate = (t.gates ?? []).some((g) => !g.ok);
  return `<div class="approval fail">
    <div class="head"><span class="pulse"></span> Este passo falhou</div>
    <p>${esc(t.error || "Algo deu errado. Tentar de novo costuma resolver.")}</p>
    ${hasBadGate ? `<div class="gates-row">${gateChips(t)}</div>` : ""}
    <div class="acts">
      <button class="btn sm primary" data-act="retry" data-task="${esc(t.id)}">Tentar de novo</button>
      <button class="btn sm ghost" data-act="cancel" data-task="${esc(t.id)}">Cancelar tarefa</button>
    </div>
  </div>`;
}

function appendChatDom(taskId, item) {
  const scroller = $("#chat-scroll");
  if (!scroller) return;
  const stick = nearBottom(scroller);
  if (item.kind === "assistant") $("#stream-bubble")?.remove();
  const tpl = document.createElement("template");
  tpl.innerHTML = transcriptItemHtml(item).trim();
  const node = tpl.content.firstElementChild;
  if (node) scroller.insertBefore(node, $("#chat-cards", scroller));
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function updatePreview(root, t) {
  const pane = $("#preview-pane", root);
  if (!pane) return;
  const url = t.previewUrl || "";
  const busy = !!state.busy[`preview:${t.id}`];
  const config = !!state.busy[`preview-config:${t.id}`];
  const erro = state.previewErro[t.id];
  // O preview só aparece quando a task chega no "Seu teste" (ou Publicar): o
  // agente já subiu e conferiu o app. Antes disso, não mostramos preview cru.
  // Modo livre pode subir/ver o preview a qualquer momento (o usuário conduz).
  const naEtapaDeTeste = t.step === "teste" || t.step === "publicar" || t.modo === "livre";
  const mostra = url && naEtapaDeTeste;
  const key = `${url}|${naEtapaDeTeste}|${busy}|${config}|${erro ? erro.msg + erro.podeConfigurar : ""}`;
  if (pane.dataset.key === key) return; // não recarregar o iframe à toa
  pane.dataset.key = key;
  if (mostra) {
    pane.innerHTML = `
      <div class="preview-bar">
        <div class="url"><span class="dot"></span><input class="url-input" id="preview-url" data-task="${esc(t.id)}" value="${esc(url)}" spellcheck="false" autocomplete="off" aria-label="Endereço do preview (digite e Enter para navegar)"></div>
        <button class="btn sm ghost" data-act="reload-preview">Recarregar</button>
        <a class="btn sm" id="preview-open" href="${esc(url)}" target="_blank" rel="noreferrer">Abrir no navegador</a>
      </div>
      <iframe id="preview-frame" src="${esc(url)}" title="Preview do app"></iframe>
      <div class="preview-foot"><span class="dot"></span> Preview gerenciado pelo Inhouse · espaço ${t.espaco} · digite um endereço e Enter para navegar</div>`;
  } else if (config) {
    // Agente preparando o preview — o progresso aparece no chat da tarefa.
    pane.innerHTML = `
      <div class="preview-bar"><div class="url muted">preparando…</div></div>
      <div class="preview-empty">
        <p><span class="spinner"></span> O Claude está preparando o preview deste projeto. Acompanhe no chat ao lado.</p>
      </div>`;
  } else if (!naEtapaDeTeste) {
    // Antes do "Seu teste": o agente ainda vai subir e conferir o app.
    pane.innerHTML = `
      <div class="preview-bar"><div class="url muted">preview em breve</div></div>
      <div class="preview-empty">
        <p>O preview fica pronto na etapa <b>Seu teste</b>.</p>
        <p class="preview-hint">O Claude sobe o app e confere as telas antes de você abrir — assim você testa algo que já funciona.</p>
      </div>`;
  } else if (erro) {
    // No teste, uma tentativa manual não subiu: sem susto, com uma saída.
    pane.innerHTML = `
      <div class="preview-bar"><div class="url muted">sem preview</div></div>
      <div class="preview-empty">
        <p>${esc(erro.msg)}</p>
        ${erro.podeConfigurar
          ? `<p class="preview-hint">Posso pedir ao Claude para preparar e abrir o preview deste projeto.</p>
             <button class="btn primary" data-act="configure-preview" data-task="${esc(t.id)}" ${busy ? "disabled" : ""}>Pedir ao Claude para configurar o preview</button>
             <button class="btn ghost sm" data-act="start-preview" data-task="${esc(t.id)}">Tentar de novo</button>`
          : `<button class="btn primary" data-act="start-preview" data-task="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span> Iniciando…` : "Tentar de novo"}</button>`}
      </div>`;
  } else {
    // No teste, mas sem preview no ar (ex.: server reiniciou): fallback manual.
    pane.innerHTML = `
      <div class="preview-bar"><div class="url muted">preview parado</div></div>
      <div class="preview-empty">
        <p>O preview roda o app deste espaço isolado, sem afetar as outras tarefas.</p>
        <button class="btn primary" data-act="start-preview" data-task="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span> Iniciando…` : "Iniciar preview"}</button>
      </div>`;
  }
}

function updateComposer(root, t) {
  const input = $("#composer-input", root);
  const btn = $("#composer-send", root);
  if (!input) return;
  let enabled = false;
  let ph;
  const permPend = state.permissions.some((p) => p.taskId === t.id);
  if (t.modo === "livre") {
    if (t.status === "concluida") ph = "Publicada — nada mais a fazer aqui.";
    else if (t.status === "cancelada") ph = "Tarefa cancelada.";
    else {
      enabled = true; // você conduz: sempre dá pra mandar instrução
      ph = permPend
        ? "Responda o pedido de permissão acima — ou mande uma instrução"
        : t.status === "rodando"
          ? "Mande outra instrução — entra assim que ele terminar…"
          : t.status === "falhou" && t.pausadaManual
            ? "Escreva um ajuste e envie (ou clique em Retomar acima)…"
            : "Diga o que fazer… (pode pedir /review, /qa — ou Publicar acima)";
    }
  } else if (t.status === "aguardando" && t.step === "aprovacao") {
    enabled = true;
    ph = "Escreva o que mudar no plano — enviar pede mudanças ao Claude";
  } else if (t.status === "aguardando" && t.step === "teste") {
    enabled = true;
    ph = "Escreva o que ajustar — enviar devolve a tarefa pro Claude";
  } else if (t.step === "execucao" && (t.status === "rodando" || t.status === "aguardando")) {
    // Só na execução o servidor enfileira mensagens de steering.
    enabled = true;
    ph = permPend ? "Responda o pedido de permissão acima — ou mande uma orientação" : "Responda ou ajuste a direção…";
  } else if (t.status === "rodando") {
    ph = t.step === "espec" || t.step === "plano"
      ? "Aguarde o plano ficar pronto — aí você pode pedir mudanças."
      : "Aguarde as verificações terminarem.";
  } else if (t.status === "concluida") ph = "Tarefa concluída — nada mais a fazer aqui.";
  else if (t.status === "falhou" && t.pausadaManual) {
    // Pausada: só a execução aceita ajuste antes de retomar; nos demais passos, só retomar.
    enabled = t.step === "execucao";
    ph = enabled
      ? "Escreva um ajuste (opcional) e clique em Retomar acima…"
      : "Pausado — clique em “Retomar” acima para continuar.";
  } else if (t.status === "falhou") ph = "O passo falhou — use “Tentar de novo” acima.";
  else if (t.step === "publicar") ph = "Tudo pronto — é só clicar em Publicar.";
  else ph = "A tarefa está parada.";
  input.disabled = !enabled;
  input.placeholder = ph;
  if (btn) btn.disabled = !enabled;
  const attach = $("#composer-attach", root);
  if (attach) attach.disabled = !enabled;
  renderAnexos("composer");
  autoGrow(input);
}

// ---------- Ações ----------
async function taskAction(id, action) {
  const t = await api(`/api/tasks/${encodeURIComponent(id)}/action`, action);
  if (t && t.id) {
    upsert(state.tasks, t);
    render();
  }
}

function decidePermission(id, allow) {
  const remember = !!document.getElementById(`perm-remember-${id}`)?.checked;
  // Otimista: some da UI já; o servidor confirma via permission_resolved.
  state.permissions = state.permissions.filter((p) => p.id !== id);
  render();
  api(`/api/permissions/${encodeURIComponent(id)}/decision`, { allow, remember });
}

const actions = {
  "proj-menu": (btn) => {
    const pop = document.getElementById(`proj-menu-${btn.dataset.project}`);
    if (!pop) return;
    const abrir = !pop.classList.contains("open");
    document.querySelectorAll(".proj-menu-pop.open").forEach((p) => p.classList.remove("open"));
    if (abrir) pop.classList.add("open");
  },
  "arquivar-projeto": async (btn) => {
    document.querySelectorAll(".proj-menu-pop.open").forEach((p) => p.classList.remove("open"));
    const p = state.projects.find((x) => x.id === btn.dataset.project);
    const r = await api(`/api/projects/${encodeURIComponent(btn.dataset.project)}/arquivar`, {});
    if (r) toast(`“${p?.name || "Projeto"}” arquivado. Você pode restaurar quando quiser.`);
  },
  "desarquivar-projeto": async (btn) => {
    document.querySelectorAll(".proj-menu-pop.open").forEach((p) => p.classList.remove("open"));
    const p = state.projects.find((x) => x.id === btn.dataset.project);
    const r = await api(`/api/projects/${encodeURIComponent(btn.dataset.project)}/desarquivar`, {});
    if (r) toast(`“${p?.name || "Projeto"}” restaurado.`);
  },
  "excluir-projeto": async (btn) => {
    document.querySelectorAll(".proj-menu-pop.open").forEach((p) => p.classList.remove("open"));
    await excluirProjetoFluxo(btn.dataset.project);
  },
  "go-task": (btn) => { location.hash = `#/tarefa/${btn.dataset.task}`; },
  "focus-new-task": () => {
    const i = $("#new-task-desc");
    if (i) { i.focus(); i.scrollIntoView({ block: "nearest" }); }
  },
  "approve-plan": (btn) => taskAction(btn.dataset.task, { action: "approve_plan" }),
  "approve-plan-direto": (btn) => taskAction(btn.dataset.task, { action: "approve_plan", direto: true }),
  "approve-prototype": (btn) => taskAction(btn.dataset.task, { action: "approve_prototype" }),
  "set-design": (btn) => taskAction(btn.dataset.task, { action: "set_design", valor: btn.dataset.valor }),
  "approve-test": (btn) => taskAction(btn.dataset.task, { action: "approve_test" }),
  "retry": (btn) => taskAction(btn.dataset.task, { action: "retry" }),
  "pause": (btn) => taskAction(btn.dataset.task, { action: "pause" }),
  "set-modo": (btn) => { state.novaTarefaModo = btn.dataset.modo === "livre" ? "livre" : "esteira"; render(); },
  "wf-ativar": async (btn) => {
    const pid = selectedProjectId();
    const r = await api(`/api/workflows/${encodeURIComponent(btn.dataset.wf)}/ativar`, pid ? { projectId: pid } : {});
    if (r) { state.workflows = { ...r, catalogo: state.workflows?.catalogo || [] }; render(); }
  },
  "wf-global": async (btn) => {
    const r = await api(`/api/workflows/${encodeURIComponent(btn.dataset.wf)}/ativar`, {});
    if (r) { state.workflows = { ...r, catalogo: state.workflows?.catalogo || [] }; render(); }
  },
  "wf-duplicar": async (btn) => {
    const base = wfById(btn.dataset.wf); if (!base) return;
    const r = await api("/api/workflows", { name: `${base.name} (cópia)`, descricao: base.descricao || "", skills: flattenSkills(base), gates: base.gates || {} });
    if (r && r.id) { await carregarWorkflows(); state.wfDrawer = r.id; state.wfDraft = { name: r.name, descricao: r.descricao || "", skills: flattenSkills(r), gates: { ...(r.gates || {}) } }; render(); }
  },
  "wf-editar": (btn) => {
    const wkf = wfById(btn.dataset.wf); if (!wkf) return;
    state.wfDrawer = wkf.id; state.wfDraft = { name: wkf.name, descricao: wkf.descricao || "", skills: flattenSkills(wkf), gates: { ...(wkf.gates || {}) } }; render();
  },
  "wf-excluir": async (btn) => {
    const wkf = wfById(btn.dataset.wf); if (!wkf) return;
    if (!(await confirmar({ titulo: `Excluir “${wkf.name}”?`, corpo: "Projetos que usavam este workflow voltam ao Padrão.", textoConfirmar: "Excluir", perigo: true }))) return;
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(wkf.id)}`, { method: "DELETE" });
      setOnline(true);
      if (res.ok) await carregarWorkflows();
      else { const j = await res.json().catch(() => ({})); toast(j.error || "Não deu para excluir."); }
    } catch { setOnline(false); }
  },
  "wf-skill-add": (btn) => {
    const { fase, skill } = btn.dataset;
    if (!state.wfDraft) return;
    const arr = (state.wfDraft.skills[fase] ??= []);
    if (!arr.some((s) => s.skill === skill)) arr.push({ skill });
    render();
  },
  "wf-skill-rm": (btn) => {
    if (!state.wfDraft) return;
    (state.wfDraft.skills[btn.dataset.fase] || []).splice(Number(btn.dataset.i), 1);
    render();
  },
  "wf-save": async () => {
    const d = state.wfDraft; if (!d || !state.wfDrawer) return;
    const name = document.getElementById("wf-name")?.value?.trim() || d.name;
    const descricao = document.getElementById("wf-desc")?.value?.trim() || "";
    const r = await api("/api/workflows", { id: state.wfDrawer, name, descricao, skills: d.skills, gates: d.gates || {} });
    if (r) { state.wfDrawer = null; state.wfDraft = null; await carregarWorkflows(); toast("Workflow salvo."); }
  },
  "wf-drawer-close": () => { state.wfDrawer = null; state.wfDraft = null; render(); },
  "wf-ia-sug": (btn) => {
    const ta = document.getElementById("wf-ia-input");
    if (ta) { ta.value = ta.value.trim() ? `${ta.value.trim()} ${btn.dataset.txt}` : btn.dataset.txt; ta.focus(); autoGrow(ta); }
  },
  "wf-ia-usar": async () => {
    const p = state.wfIA.proposta; if (!p) return;
    const r = await api("/api/workflows", { name: p.name, descricao: p.descricao || "", skills: p.skills, gates: p.gates || {}, origem: "ia" });
    if (r && r.id) {
      const pid = selectedProjectId();
      if (pid) await api(`/api/workflows/${encodeURIComponent(r.id)}/ativar`, { projectId: pid });
      state.wfIA = { mensagens: [], proposta: null, gerando: false };
      await carregarWorkflows();
      toast(`Workflow “${r.name}” criado e em uso.`);
    }
  },
  "wf-ia-descartar": () => { state.wfIA = { mensagens: [], proposta: null, gerando: false }; render(); },
  "attach": (btn) => { if (!btn.disabled) escolherAnexos(btn.dataset.target); },
  "anexo-remove": (btn) => {
    const target = btn.dataset.target;
    const arr = state.anexosPendentes[target] || [];
    arr.splice(Number(btn.dataset.idx), 1);
    state.anexosPendentes[target] = arr;
    renderAnexos(target);
  },
  "ver-espec": (btn) => { const t = getTask(btn.dataset.task); if (t?.spec) abrirDocModal("Especificação", t.spec); },
  "ver-plano": (btn) => { const t = getTask(btn.dataset.task); if (t?.plan) abrirDocModal("Plano", t.plan); },
  "toggle-docs": (btn) => {
    const pop = document.getElementById(`docs-pop-${btn.dataset.task}`);
    if (!pop) return;
    const abrir = !pop.classList.contains("open");
    document.querySelectorAll(".docs-pop.open").forEach((p) => p.classList.remove("open"));
    pop.classList.toggle("open", abrir);
    if (abrir) { const f = pop.querySelector(".docs-filter"); if (f) setTimeout(() => f.focus(), 30); }
  },
  "ver-doc": async (btn) => {
    document.getElementById(`docs-pop-${btn.dataset.task}`)?.classList.remove("open");
    const r = await api(`/api/tasks/${encodeURIComponent(btn.dataset.task)}/artefatos/doc?rel=${encodeURIComponent(btn.dataset.rel)}`);
    if (r && r.conteudo != null) abrirDocModal(btn.dataset.rel, r.conteudo);
  },
  "fechar-doc": (btn) => { btn.closest("dialog")?.close(); },
  "auto-toggle": async (btn) => {
    const t = getTask(btn.dataset.task);
    const ligando = !t?.autoAprovar;
    if (ligando && !(await confirmarModoAuto())) return;
    taskAction(btn.dataset.task, { action: "auto_mode", on: ligando });
  },
  "auto-on": async (btn) => {
    if (!(await confirmarModoAuto())) return;
    taskAction(btn.dataset.task, { action: "auto_mode", on: true });
  },
  "plano-rapido": (btn) => taskAction(btn.dataset.task, { action: "plano_rapido" }),
  "arquivar": (btn) => taskAction(btn.dataset.task, { action: "arquivar" }),
  "desarquivar": (btn) => taskAction(btn.dataset.task, { action: "desarquivar" }),
  "toggle-arquivadas": () => { state.showArquivadas = !state.showArquivadas; render(); },
  "preparar-projeto": async (btn) => {
    const pid = btn.dataset.project;
    const t = await api(`/api/projects/${encodeURIComponent(pid)}/prepare`, {});
    if (t?.id) location.hash = `#/tarefa/${t.id}`; // acompanha no editor
  },
  "aplicar-update": async () => {
    if (state.busy.update) return;
    const ok = await confirmar({
      titulo: "Atualizar o Inhouse?",
      corpo: "Vou baixar a versão nova (git pull). Depois é só fechar e abrir o Inhouse de novo pra aplicar. Suas tarefas e dados não são afetados.",
      textoConfirmar: "Atualizar",
    });
    if (!ok) return;
    state.busy.update = true;
    renderUpdatePill();
    const r = await api("/api/update", {});
    state.busy.update = false;
    if (r?.ok) {
      state.update = { ...state.update, disponivel: false };
      renderUpdatePill();
      await confirmar({ titulo: "Atualizado!", corpo: r.mensagem, textoConfirmar: "Entendi" });
    } else {
      renderUpdatePill();
      if (r) toast(r.mensagem);
    }
  },
  "theme-toggle": () => {
    const atual = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const proximo = atual === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = proximo;
    try { localStorage.setItem("inhouse.theme", proximo); } catch (e) { /* modo privado */ }
  },
  "gerar-relatorio": async () => {
    state.busy["eval-relatorio"] = true;
    render();
    const r = await api("/api/eval/relatorios", {});
    if (!r) state.busy["eval-relatorio"] = false;
    render();
  },
  "abrir-relatorio": async (btn) => {
    const r = await api(`/api/eval/relatorios/${encodeURIComponent(btn.dataset.arq)}`);
    if (r?.conteudo) { state.evalRelatorio = r.conteudo; render(); }
  },
  "eval-export": () => {
    // Baixa o arquivo de dados desta máquina (só métricas; sem conversas).
    const a = document.createElement("a");
    a.href = "/api/eval/export";
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Baixando os dados desta máquina…");
  },
  "eval-import": () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "application/json,.json";
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      let bundle;
      try {
        bundle = JSON.parse(await file.text());
      } catch {
        toast("Arquivo inválido — não parece um export do Inhouse.");
        return;
      }
      const sugestao = (bundle && bundle.origem && bundle.origem.label) || "";
      const fonte = window.prompt("De quem são estes dados? (um nome para a origem, ex.: Maria)", sugestao);
      if (!fonte || !fonte.trim()) return;
      const r = await api("/api/eval/import", { bundle, fonte: fonte.trim() });
      if (r) {
        toast(`Importados ${r.importados} registro(s)${r.pulados ? ` · ${r.pulados} já existiam` : ""}.`);
        state.evalFonte = fonte.trim();
        state.eval = null;
        carregarEval();
      }
    };
    inp.click();
  },
  "cancel": (btn) => abrirDialogoCancelar(btn.dataset.task),
  "feedback": async (btn) => {
    const id = btn.dataset.task;
    const nota = btn.dataset.nota;
    await api(`/api/tasks/${encodeURIComponent(id)}/feedback`, { nota });
    localStorage.setItem(`inhouse.feedback.${id}`, nota);
    // Após a nota, oferece o campo de texto no editor (opcional).
    const widget = document.querySelector(`[data-fb-task="${id}"]`);
    if (widget) {
      widget.innerHTML = `<span class="fb-q">Obrigado! Quer contar o que aconteceu? (opcional)</span>
        <input class="fb-texto" id="fb-texto-${id}" placeholder="Ex.: demorou demais no plano" maxlength="2000">
        <button class="btn sm" data-act="feedback-texto" data-task="${id}" data-nota="${nota}">Enviar</button>`;
      widget.querySelector("input")?.focus();
    } else {
      render();
    }
  },
  "feedback-texto": async (btn) => {
    const id = btn.dataset.task;
    const texto = document.querySelector(`#fb-texto-${id}`)?.value?.trim();
    await api(`/api/tasks/${encodeURIComponent(id)}/feedback`, { nota: btn.dataset.nota, texto: texto || undefined });
    render();
  },
  "request-changes": (btn) => {
    const msg = window.prompt("O que você quer mudar?");
    if (msg && msg.trim()) {
      pushLocalUser(btn.dataset.task, msg.trim());
      taskAction(btn.dataset.task, { action: "request_changes", message: msg.trim() });
    }
  },
  "publish": async (btn) => {
    const id = btn.dataset.task;
    const t = getTask(id);
    if (!t || state.busy[`publish:${id}`]) return;
    const p = getProject(t.projectId);
    const temOrigin = !!p?.originUrl;
    const ok = await confirmar({
      titulo: temOrigin ? "Publicar como Pull Request?" : "Publicar no app?",
      corpo: temOrigin
        ? "Isto envia sua mudança como um Pull Request no GitHub para o time revisar. O projeto (main) não é alterado direto."
        : "Isto junta as mudanças deste espaço no app.",
      textoConfirmar: temOrigin ? "Abrir Pull Request" : "Publicar",
    });
    if (!ok) return;
    state.busy[`publish:${id}`] = true;
    render();
    await taskAction(id, { action: "publish", createPr: temOrigin });
    delete state.busy[`publish:${id}`];
    render();
  },
  "board-preview": (btn) => {
    const t = getTask(btn.dataset.task);
    if (!t) return;
    // Preview já de pé abre noutra aba; senão vamos pro editor, onde dá pra iniciar.
    if (t.previewUrl) window.open(t.previewUrl, "_blank", "noopener");
    else location.hash = `#/tarefa/${t.id}`;
  },
  "start-preview": async (btn) => {
    const id = btn.dataset.task;
    if (state.busy[`preview:${id}`]) return;
    state.busy[`preview:${id}`] = true;
    delete state.previewErro[id];
    render();
    // Fetch direto (não o api()): precisamos do corpo mesmo em erro para saber
    // se dá para oferecer a configuração pelo agente (degradação graciosa).
    let body = null;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/preview/start`, { method: "POST" });
      setOnline(true);
      body = await res.json().catch(() => null);
      if (res.ok && body?.url) {
        const t = getTask(id);
        if (t) t.previewUrl = body.url;
      } else {
        state.previewErro[id] = {
          msg: body?.error || "Não foi possível abrir o preview.",
          podeConfigurar: !!body?.podeConfigurarComAgente,
        };
      }
    } catch {
      setOnline(false);
    }
    delete state.busy[`preview:${id}`];
    render();
  },
  "configure-preview": async (btn) => {
    const id = btn.dataset.task;
    if (state.busy[`preview:${id}`] || state.busy[`preview-config:${id}`]) return;
    state.busy[`preview-config:${id}`] = true;
    delete state.previewErro[id];
    render();
    // Fetch direto (não o api()): pode demorar (o agente lê o projeto) e precisamos
    // do corpo mesmo em erro — se o agente concluir "não há preview", paramos de oferecer.
    let body = null;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/preview/configure`, { method: "POST" });
      setOnline(true);
      body = await res.json().catch(() => null);
      if (res.ok && body?.url) {
        const t = getTask(id);
        if (t) t.previewUrl = body.url;
      } else {
        state.previewErro[id] = {
          msg: body?.error || "O preview ainda não subiu.",
          podeConfigurar: !!body?.podeConfigurarComAgente,
        };
      }
    } catch {
      setOnline(false);
      state.previewErro[id] = { msg: "Não deu para configurar o preview agora.", podeConfigurar: true };
    }
    delete state.busy[`preview-config:${id}`];
    render();
  },
  "reload-preview": () => {
    const f = $("#preview-frame");
    if (f) f.src = f.src;
  },
  "perm-allow": (btn) => decidePermission(btn.dataset.perm, true),
  "perm-deny": (btn) => decidePermission(btn.dataset.perm, false),
  "debug-run": async () => {
    const projectId = document.querySelector("#debug-project")?.value || selectedProjectId();
    const scenarioId = document.querySelector("#debug-scenario")?.value || state.debugSel;
    const autoDrive = document.querySelector("#debug-autodrive")?.checked !== false;
    if (!projectId) { toast("Crie ou selecione um app primeiro."); return; }
    if (!scenarioId) return;
    const r = await api("/api/debug/run", { projectId, scenarioId, autoDrive });
    if (r && r.task && r.task.id) {
      upsert(state.tasks, r.task);
      localStorage.setItem("inhouse.projectId", projectId);
      location.hash = `#/tarefa/${r.task.id}`;
    }
  },
};

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) {
    actions[btn.dataset.act]?.(btn, e);
    return;
  }
  // Card inteiro clicável — desde que o clique não tenha sido em botão/link/campo
  // (esses já trataram acima ou têm comportamento próprio) e não seja seleção de texto.
  if (e.target.closest("button, a, input, select, textarea, label")) return;
  if (String(window.getSelection() ?? "").length > 0) return;
  const taskCard = e.target.closest("[data-open-task]");
  if (taskCard) { location.hash = `#/tarefa/${taskCard.dataset.openTask}`; return; }
  const projOpen = e.target.closest("[data-open-project]");
  if (projOpen) {
    localStorage.setItem("inhouse.projectId", projOpen.dataset.openProject);
    location.hash = "#/tarefas";
    return;
  }
  const projRestore = e.target.closest("[data-restore-project]");
  if (projRestore) {
    const id = projRestore.dataset.restoreProject;
    const p = state.projects.find((x) => x.id === id);
    api(`/api/projects/${encodeURIComponent(id)}/desarquivar`, {}).then((r) => {
      if (r) toast(`“${p?.name || "Projeto"}” restaurado.`);
    });
  }
});
// Card clicável acessível pelo teclado (Enter/Espaço quando ele está focado).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = document.activeElement;
  if (el && (el.hasAttribute?.("data-open-project") || el.hasAttribute?.("data-restore-project"))) {
    e.preventDefault();
    el.click();
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "project-select" || el.id === "cfg-project") {
    localStorage.setItem("inhouse.projectId", el.value);
    render();
  } else if (el.id === "create-pr") {
    state.ui.createPr = el.checked;
  } else if (el.id === "eval-fonte") {
    state.evalFonte = el.value;
    state.eval = null; // força recarregar o resumo com o novo filtro
    carregarEval();
  } else if (el.id === "debug-scenario") {
    state.debugSel = el.value; // re-renderiza para atualizar o resumo do cenário
    render();
  } else if (el.id === "debug-autodrive") {
    state.debugAutoDrive = el.checked;
  } else if (el.id === "debug-project") {
    localStorage.setItem("inhouse.projectId", el.value);
  } else if (el.dataset && el.dataset.gate && state.wfDraft) {
    const key = el.dataset.gate;
    state.wfDraft.gates = { ...(state.wfDraft.gates || {}) };
    if (el.checked) delete state.wfDraft.gates[key];
    else state.wfDraft.gates[key] = false;
    const row = el.closest(".wf-gate");
    if (row) row.classList.toggle("off", !el.checked);
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-form]");
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;

  if (kind === "new-task") {
    const input = $("#new-task-desc");
    const description = input.value.trim();
    if (!description) return;
    const projectId = selectedProjectId();
    if (!projectId) { toast("Escolha um projeto primeiro."); return; }
    const anexos = state.anexosPendentes["new-task"] || [];
    const modo = state.novaTarefaModo === "livre" ? "livre" : "esteira";
    const t = await api("/api/tasks", { projectId, title: titleFrom(description), description, modo, ...(anexos.length ? { anexos } : {}) });
    if (t && t.id) {
      const el = $("#new-task-desc");
      if (el) { el.value = ""; autoGrow(el); }
      limparAnexos("new-task");
      upsert(state.tasks, t);
      if (t.modo === "livre") location.hash = `#/tarefa/${t.id}`; // livre é conversa: abre o editor
      else render();
    }
  } else if (kind === "clone") {
    const input = $("#clone-url");
    const url = input.value.trim();
    if (!url || state.busy.clone) return;
    state.busy.clone = true;
    render();
    const p = await api("/api/projects/clone", { url });
    delete state.busy.clone;
    if (p && p.id) {
      upsert(state.projects, p);
      clearProgressFor(p);
      const el = $("#clone-url");
      if (el) el.value = "";
      toast(`Projeto “${p.name}” pronto para usar.`);
    } else {
      // Clone falhou: remove as barras de progresso órfãs (ainda sem projectId).
      for (const k of Object.keys(state.progress)) {
        if (!state.progress[k].projectId) delete state.progress[k];
      }
    }
    render();
  } else if (kind === "create-app") {
    const input = $("#new-app-name");
    const name = input.value.trim();
    if (!name || state.busy.create) return;
    state.busy.create = true;
    render();
    const p = await api("/api/projects/from-template", { name, template: "app-starter" });
    delete state.busy.create;
    if (p && p.id) {
      upsert(state.projects, p);
      localStorage.setItem("inhouse.projectId", p.id);
      toast(`App “${p.name}” criado. Descreva a primeira tarefa!`);
      location.hash = "#/tarefas";
    }
    render();
  } else if (kind === "composer") {
    const r = route();
    if (r.name !== "editor") return;
    const t = getTask(r.id);
    const input = $("#composer-input");
    const text = input.value.trim();
    const anexos = state.anexosPendentes["composer"] || [];
    if (!t || !text) {
      if (anexos.length && !text) toast("Escreva uma mensagem para enviar junto com os anexos.");
      return;
    }
    input.value = "";
    autoGrow(input);
    if (t.status === "aguardando" && (t.step === "aprovacao" || t.step === "teste")) {
      pushLocalUser(t.id, text);
      taskAction(t.id, { action: "request_changes", message: text, ...(anexos.length ? { anexos } : {}) });
    } else {
      pushLocalUser(t.id, text);
      api(`/api/tasks/${encodeURIComponent(t.id)}/message`, { text, ...(anexos.length ? { anexos } : {}) });
    }
    limparAnexos("composer");
  } else if (kind === "wf-ia") {
    const input = $("#wf-ia-input");
    const text = input?.value?.trim();
    if (!text || state.wfIA.gerando) return;
    input.value = "";
    autoGrow(input);
    state.wfIA.mensagens.push({ de: "user", texto: text });
    state.wfIA.gerando = true;
    render();
    const r = await api("/api/workflows/gerar", {
      instrucao: text,
      ...(state.wfIA.proposta ? { atual: { name: state.wfIA.proposta.name, skills: state.wfIA.proposta.skills } } : {}),
    });
    state.wfIA.gerando = false;
    if (r && r.proposta) { state.wfIA.proposta = r.proposta; state.wfIA.mensagens.push({ de: "ai", proposta: r.proposta }); }
    render();
  }
});

// Navegação na barra do preview: Enter carrega o endereço digitado no iframe,
// resolvido contra a URL gerenciada (aceita "/rota", "sub/pagina" ou URL completa).
function navegarPreview(input) {
  const t = getTask(input.dataset.task);
  if (!t || !t.previewUrl) return;
  let target;
  try { target = new URL(input.value.trim(), t.previewUrl).href; } catch { return; }
  const f = $("#preview-frame");
  if (f) f.src = target;
  const open = $("#preview-open");
  if (open) open.href = target;
  input.value = target;
}
document.addEventListener("keydown", (e) => {
  if (e.target && e.target.id === "preview-url" && e.key === "Enter") {
    e.preventDefault();
    navegarPreview(e.target);
  }
});

// Caixas de prompt: Enter envia; Shift+Enter quebra linha (padrão do Mac que o usuário espera).
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if (el && el.tagName === "TEXTAREA" && el.dataset.enterSubmit !== undefined
      && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const form = el.closest("form");
    if (form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
  }
});
// Auto-crescer o textarea; filtrar a lista de documentos ao digitar.
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el || !el.classList) return;
  if (el.classList.contains("grow-area")) autoGrow(el);
  else if (el.classList.contains("docs-filter")) filtrarDocs(el);
});
// Fecha o dropdown de Documentos ao clicar fora dele (o próprio gatilho é ignorado).
document.addEventListener("click", (e) => {
  if (e.target.closest?.('[data-act="toggle-docs"]') || e.target.closest?.(".docs-pop")) return;
  document.querySelectorAll(".docs-pop.open").forEach((p) => p.classList.remove("open"));
});
document.addEventListener("click", (e) => {
  if (e.target.closest?.('[data-act="proj-menu"]') || e.target.closest?.(".proj-menu-pop")) return;
  document.querySelectorAll(".proj-menu-pop.open").forEach((p) => p.classList.remove("open"));
});
// Arrastar-e-soltar arquivos direto na caixa de nova tarefa ou no compositor.
document.addEventListener("dragover", (e) => {
  if (e.target.closest && e.target.closest(".compose-form, .composer")) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const box = e.target.closest && e.target.closest(".compose-form, .composer");
  if (!box) return;
  e.preventDefault();
  const target = box.classList.contains("composer") ? "composer" : "new-task";
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) uploadAnexos(target, files);
});

// ---------- Tooltip do stepper (nome + o que faz + skills que dispara) ----------
// Presa ao <body> pra não ser clipada pelo overflow do .flow-wrap; posicionada por
// getBoundingClientRect. Delegada no document, então sobrevive aos re-renders do SSE.
let _stepTipEl = null;
function stepTipEl() {
  if (!_stepTipEl) {
    _stepTipEl = document.createElement("div");
    _stepTipEl.className = "steptip";
    _stepTipEl.hidden = true;
    document.body.appendChild(_stepTipEl);
  }
  return _stepTipEl;
}
function showStepTip(stepEl) {
  const key = stepEl.dataset.step;
  const info = STEP_INFO[key];
  if (!info) return;
  const tip = stepTipEl();
  const skills = info.skills.length
    ? `<div class="steptip-skills"><span class="steptip-k">dispara</span> ${info.skills
        .map((s) => `<code>/${esc(s.n)}</code>${s.q ? `<span class="steptip-when">${esc(s.q)}</span>` : ""}`)
        .join("")}</div>`
    : info.human
      ? `<div class="steptip-skills"><span class="steptip-k">porteira humana — espera você</span></div>`
      : "";
  tip.innerHTML = `<div class="steptip-name">${esc(STEP_LABELS[key] ?? key)}</div>
    <div class="steptip-desc">${esc(info.desc)}</div>${skills}`;
  tip.hidden = false;
  const r = stepEl.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  const gap = 8;
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = r.bottom + gap;
  if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - gap; // vira pra cima se não couber
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
function hideStepTip() { if (_stepTipEl) _stepTipEl.hidden = true; }
document.addEventListener("pointerover", (e) => {
  const step = e.target.closest?.(".step[data-step]");
  if (step) showStepTip(step);
});
document.addEventListener("pointerout", (e) => {
  const step = e.target.closest?.(".step[data-step]");
  if (step && !step.contains(e.relatedTarget)) hideStepTip();
});
document.addEventListener("pointerdown", hideStepTip);
document.addEventListener("scroll", hideStepTip, true);
window.addEventListener("hashchange", hideStepTip);

// ---------- Inicialização ----------
// Modais de artefato vivem em <body> (fora do #app): fecha os que ficaram abertos
// ao trocar de rota, senão o re-render deixa um modal órfão sobre a nova tela.
window.addEventListener("hashchange", () => {
  document.querySelectorAll("dialog.doc-dialog[open]").forEach((d) => d.close());
  document.querySelectorAll(".docs-pop.open").forEach((p) => p.classList.remove("open"));
});
window.addEventListener("hashchange", render);
connectSSE();
fetchState();
render();
