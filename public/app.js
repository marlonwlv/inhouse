/* Inhouse — UI (vanilla ES module, sem build, sem dependências).
   Estado global alimentado por GET /api/state e mantido vivo por SSE em /api/events.
   Rotas por hash: #/ (Início) · #/tarefas (quadro) · #/tarefa/<id> (editor). */

// ---------- Constantes copiadas de shared/types.ts (manter em sincronia) ----------
const STEPS = ["espec", "plano", "aprovacao", "execucao", "verificacoes", "teste", "publicar", "concluida"];
const STEP_LABELS = {
  espec: "Espec",
  plano: "Plano",
  aprovacao: "Sua aprovação",
  execucao: "Execução",
  verificacoes: "Verificações",
  teste: "Seu teste",
  publicar: "Publicar",
  concluida: "Concluída",
};
const HUMAN_STEPS = ["aprovacao", "teste", "publicar"];

const DOCS_URL = "https://docs.claude.com/en/docs/claude-code/overview";

// ---------- Estado ----------
const UI_VERSION = "0.4.1";
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
  online: true,
  loaded: false, // já recebemos /api/state ao menos uma vez
  progress: {}, // name -> { projectId?, message, pct? }
  transcripts: {}, // taskId -> { loaded, loading, items[], stream }
  busy: {}, // chaves de ações em andamento ("clone", "create", "preview:<id>", "publish:<id>")
  ui: { createPr: true },
  eval: null, // resumo carregado ao entrar em #/experiencia
  evalRelatorio: null, // conteúdo do relatório aberto
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
  state.loaded = true;
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
      if (t) { t.previewUrl = ev.url; render(); }
      break;
    }
    case "claude_status":
      state.claude = { ok: ev.ok, version: ev.version, detail: ev.detail };
      renderClaudeChip();
      if (route().name === "home") render();
      break;
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
  return { name: "home" };
}

function isEditorOf(taskId) {
  const root = $("#app")?.firstElementChild;
  return !!root && root.dataset.view === "editor" && root.dataset.task === taskId;
}

async function carregarEval() {
  state.eval = await api("/api/eval/resumo");
  const idx = await api("/api/eval/relatorios");
  state.evalRelatorios = idx?.relatorios ?? [];
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

  renderPage(`<div class="exp-wrap">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 style="margin:0;flex:1">Experiência</h2>
      <button class="btn primary" data-act="gerar-relatorio" ${busy ? "disabled" : ""}>${busy ? '<span class="spinner"></span> Gerando análise…' : "Gerar análise agora"}</button>
    </div>
    <p class="hello-sub">O Inhouse mede sozinho os atritos de quem usa e ranqueia o que melhorar.</p>
    ${grid}
    ${aprendizados}
    ${relatorios}
    ${md}
  </div>`);
}

// ---------- Render raiz ----------
function render() {
  renderClaudeChip();
  const r = route();
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const active = a.dataset.nav === r.name || (r.name === "editor" && a.dataset.nav === "board");
    a.classList.toggle("active", active);
  });
  if (r.name === "home") renderHome();
  else if (r.name === "board") renderBoard();
  else if (r.name === "experiencia") renderExperiencia();
  else renderEditor(r.id);
}

/* Troca o conteúdo preservando valor e foco dos inputs (SSE re-renderiza com frequência). */
function renderPage(html) {
  const appEl = $("#app");
  const focused = document.activeElement;
  const focusId = focused && appEl.contains(focused) ? focused.id : null;
  const selStart = focusId && typeof focused.selectionStart === "number" ? focused.selectionStart : null;
  const values = {};
  appEl.querySelectorAll("input[id]").forEach((i) => {
    values[i.id] = i.type === "checkbox" ? i.checked : i.value;
  });
  appEl.innerHTML = html;
  appEl.querySelectorAll("input[id]").forEach((i) => {
    if (i.id in values) {
      if (i.type === "checkbox") i.checked = values[i.id];
      else i.value = values[i.id];
    }
  });
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

// ---------- Peças compartilhadas ----------
function flowHtml(t) {
  const idx = STEPS.indexOf(t.step);
  const parts = [];
  STEPS.forEach((s, i) => {
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
    parts.push(`<div class="${cls}"><i class="pin"></i><span>${esc(STEP_LABELS[s])}</span>${durHtml}</div>`);
  });
  return `<div class="flow-wrap"><div class="flow">${parts.join("")}</div></div>`;
}

function statusChip(t) {
  if (t.status === "rodando") return `<span class="chip ok"><span class="spinner"></span> Claude trabalhando</span>`;
  if (t.status === "aguardando") {
    return `<span class="chip wait">${t.step === "teste" ? "Pronto pro seu teste" : "Aguardando você"}</span>`;
  }
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

  const projectsHtml = projects.length
    ? `<div class="repo-grid">${projects.map(projectCardHtml).join("")}</div>`
    : `<div class="empty-card" style="margin-bottom:32px">${state.loaded
        ? "Nenhum projeto por aqui ainda. Abra um do GitHub ou crie um app novo logo abaixo."
        : `<span class="spinner"></span> Carregando os seus projetos…`}</div>`;

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
      <p class="hello-sub">Abra um projeto da Inhouse ou crie um app novo — tudo em português, sem terminal.</p>

      <div class="sect"><h3>Meus projetos</h3><span>${projects.length ? "cada tarefa roda num espaço isolado, sem conflito" : ""}</span></div>
      ${projectsHtml}

      <div class="sect"><h3>Adicionar projeto</h3><span>do GitHub da Inhouse ou um app novo do zero</span></div>
      <div class="add-grid">
        <form class="repo-card" data-form="clone">
          <div class="rh"><span class="gh-ico">gh</span><b>Abrir do GitHub</b></div>
          <p>Cole o endereço do repositório. O download acontece sozinho, com barra de progresso.</p>
          <div class="field-row">
            <input id="clone-url" type="url" placeholder="https://github.com/inhouse/…" autocomplete="off" ${busyClone ? "disabled" : ""} required>
            <button class="btn sm primary" type="submit" ${busyClone ? "disabled" : ""}>${busyClone ? `<span class="spinner"></span> Baixando…` : "Baixar e abrir"}</button>
          </div>
          ${progressHtml}
        </form>

        <form class="repo-card" data-form="create-app">
          <div class="rh"><span class="app-ico" style="background:var(--brand)">+</span><b>Criar app novo</b></div>
          <p>Começa do template <b>App Inhouse</b>: design system, login e navegação já prontos.</p>
          <div class="field-row">
            <input id="new-app-name" type="text" placeholder="Nome do app… ex.: Quiz de Onboarding" autocomplete="off" ${busyCreate ? "disabled" : ""} required>
            <button class="btn sm primary" type="submit" ${busyCreate ? "disabled" : ""}>${busyCreate ? `<span class="spinner"></span> Criando…` : "Criar"}</button>
          </div>
        </form>
      </div>

      <div class="home-foot">${claudeFootHtml()}</div>
    </div>
  </div>`);
}

function projectCardHtml(p) {
  const n = state.tasks.filter(
    (t) => t.projectId === p.id && t.status !== "concluida" && t.status !== "cancelada",
  ).length;
  const tarefas = n === 0 ? "Sem tarefas ativas" : n === 1 ? "1 tarefa ativa" : `${n} tarefas ativas`;
  return `<div class="repo-card">
    <div class="rh">
      <span class="app-ico" style="background:${icoColor(p.name)}">${esc((p.name[0] || "?").toUpperCase())}</span>
      <b>${esc(p.name)}</b>
      <span class="chip">${p.kind === "repo" ? "GitHub" : "App"}</span>
    </div>
    <p>${tarefas} · criado ${timeAgo(p.createdAt)}</p>
    <button class="btn sm primary" data-act="open-project" data-project="${esc(p.id)}">Abrir</button>
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
  const tasks = state.tasks
    .filter((t) => t.projectId === pid)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const ativas = tasks.filter((t) => t.status === "rodando" || t.status === "aguardando").length;
  const statusLine = ativas === 0
    ? "nenhuma tarefa em andamento"
    : ativas === 1
      ? "1 tarefa em andamento · num espaço isolado"
      : `${ativas} tarefas em paralelo · cada uma no seu espaço isolado`;

  renderPage(`
  <div class="view view-board">
    <div class="topbar">
      <select id="project-select" class="repo-pick" aria-label="Escolher projeto">
        ${state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === pid ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
      </select>
      <div class="status">${statusLine}</div>
      <button class="btn sm primary" data-act="focus-new-task">+ Nova tarefa</button>
    </div>
    <div class="board">
      <form class="new-task" data-form="new-task">
        <input id="new-task-desc" placeholder="Descreva uma tarefa… ex.: “corrigir o filtro de turmas por data no backoffice”" autocomplete="off" aria-label="Descrição da nova tarefa">
        <button class="btn sm primary" type="submit">Começar</button>
      </form>
      ${tasks.length
        ? tasks.map(taskCardHtml).join("")
        : `<div class="empty-card">Nenhuma tarefa neste projeto ainda. Descreva a primeira ali em cima — o Claude cuida do resto.</div>`}
    </div>
  </div>`);
}

function taskCardHtml(t) {
  const perm = state.permissions.find((p) => p.taskId === t.id);
  const cls = t.status === "falhou" ? "failed"
    : t.status === "rodando" ? "running"
    : perm || t.status === "aguardando" ? "waiting"
    : "done-task";
  return `<div class="task ${cls}" data-open-task="${esc(t.id)}" title="Abrir a tarefa (chat, plano e preview)">
    <div class="task-head">
      <b>${esc(t.title)}</b>
      ${statusChip(t)}
      <div class="meta"><span class="chip">espaço ${t.espaco}</span>
      <button class="btn sm ${t.autoAprovar ? "primary" : "ghost"}" data-act="auto-toggle" data-task="${esc(t.id)}" title="Com o modo auto ligado, ações sensíveis não pedem permissão">${t.autoAprovar ? "🟢 Auto ligado" : "Auto: desligado"}</button> ${timeAgo(t.updatedAt)}</div>
    </div>
    ${t.status === "concluida" || t.status === "cancelada" ? "" : flowHtml(t)}
    ${taskFootHtml(t, perm)}
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
  if (t.status === "falhou" && t.pausadaPorTempo) {
    rows.push(`<div class="task-foot"><span class="wait-msg">⏱ Este passo está trabalhando há mais de 1 hora — nada quebrou.</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Ver o que ele está fazendo</button>
      <button class="btn sm primary" data-act="retry" data-task="${id}">Continuar assim mesmo</button></div>`);
  } else if (t.status === "falhou") {
    rows.push(`<div class="task-foot"><span class="fail-msg">${esc(t.error || "Algo deu errado neste passo.")}</span>
      <span class="gap"></span>
      <button class="btn sm" data-act="go-task" data-task="${id}">Ver detalhes</button>
      <button class="btn sm primary" data-act="retry" data-task="${id}">Tentar de novo</button></div>`);
  } else if (t.status === "rodando") {
    rows.push(`<div class="task-foot"><span><span class="spinner"></span> Claude trabalhando no passo “${esc(STEP_LABELS[t.step] ?? t.step)}”${stepAtualDesde(t) ? ` · ${timeAgo(stepAtualDesde(t))}` : ""}…</span>
      <span class="gap"></span>
      <a class="link" href="#/tarefa/${id}">Acompanhar no editor →</a></div>`);
  } else if (t.step === "aprovacao" && t.status === "aguardando") {
    rows.push(`<div class="task-foot"><span class="plan-sum">${esc(planSummary(t))}</span>
      <span class="gap"></span>
      <a class="link" href="#/tarefa/${id}">Ver detalhes</a>
      <button class="btn sm ghost" data-act="request-changes" data-task="${id}">Pedir mudanças</button>
      <button class="btn sm primary" data-act="approve-plan" data-task="${id}">Aprovar plano</button></div>`);
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
      ${t.prUrl ? `<a class="link" href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">Ver no GitHub</a>` : ""}</div>`);
  } else if (t.status === "cancelada") {
    rows.push(`<div class="task-foot"><span>Tarefa cancelada.</span></div>`);
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
    loadTranscript(id);
  }

  // Regiões atualizadas a cada evento (o shell — e o iframe — ficam no lugar).
  $("#ed-title", root).textContent = `${p ? p.name : "?"} · ${t.title}`;
  $("#ed-espaco", root).textContent = `espaço ${t.espaco}`;
  $("#ed-status", root).innerHTML = editorStatusHtml(t);
  const ativa = t.status !== "concluida" && t.status !== "cancelada";
  $("#ed-topactions", root).innerHTML = [
    t.step === "publicar" && t.status === "aguardando"
      ? `<button class="btn sm primary" data-act="publish" data-task="${esc(t.id)}" ${state.busy[`publish:${t.id}`] ? "disabled" : ""}>Publicar</button>`
      : "",
    ativa
      ? `<button class="btn sm ghost" data-act="cancel" data-task="${esc(t.id)}">Cancelar tarefa</button>`
      : "",
  ].join("");
  $("#ed-flowstrip", root).innerHTML =
    `<span>Onde essa tarefa está:</span>${flowHtml(t)}${nextGateChip(t)}`;
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
    <div class="editor-body">
      <div class="chat">
        <div class="chat-scroll" id="chat-scroll"></div>
        <form class="composer" data-form="composer">
          <div class="composer-box">
            <input id="composer-input" autocomplete="off" placeholder="" aria-label="Mensagem para o Claude">
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
  if (t.status === "rodando") return `<b class="live-dot">●</b> Claude trabalhando · ${esc(STEP_LABELS[t.step] ?? t.step)}`;
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
  const idx = STEPS.indexOf(t.step);
  const next = STEPS.slice(idx + 1).find((s) => HUMAN_STEPS.includes(s));
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
    if (t.step === "teste") parts.push(testCardHtml(t));
    if (t.step === "publicar") parts.push(publishCardHtml(t));
  }
  if (t.status === "concluida") {
    parts.push(`<div class="publish-card"><div class="head">✓ Tarefa concluída</div>
      <p>A mudança foi publicada no projeto.${t.prUrl ? ` <a href="${esc(t.prUrl)}" target="_blank" rel="noreferrer">Ver o PR no GitHub</a>` : ""}</p>
      ${feedbackWidgetHtml(t)}</div>`);
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

function planCardHtml(t) {
  return `<div class="approval">
    <div class="head"><span class="pulse"></span> Plano pronto — sua aprovação</div>
    <div class="plan-body">${mdBlock(t.plan || "O Claude não escreveu um plano detalhado desta vez. Você pode aprovar para seguir, ou pedir mudanças explicando o que espera.")}</div>
    <div class="acts">
      <button class="btn sm primary" data-act="approve-plan" data-task="${esc(t.id)}">Aprovar plano</button>
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
    <p>Verificações e o seu teste aprovados. Publicar junta as mudanças do espaço ${t.espaco} no projeto principal.</p>
    ${p?.originUrl ? `<label class="remember"><input type="checkbox" id="create-pr" ${state.ui.createPr ? "checked" : ""}> Criar PR no GitHub para revisão</label>` : ""}
    <div class="acts">
      <button class="btn sm primary" data-act="publish" data-task="${esc(t.id)}" ${busy ? "disabled" : ""}>${busy ? `<span class="spinner"></span> Publicando…` : "Publicar no projeto"}</button>
    </div>
  </div>`;
}

function failCardHtml(t) {
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
  const key = `${url}|${busy}`;
  if (pane.dataset.key === key) return; // não recarregar o iframe à toa
  pane.dataset.key = key;
  if (url) {
    pane.innerHTML = `
      <div class="preview-bar">
        <div class="url"><span class="dot"></span><span class="url-text">${esc(url)}</span></div>
        <button class="btn sm ghost" data-act="reload-preview">Recarregar</button>
        <a class="btn sm" href="${esc(url)}" target="_blank" rel="noreferrer">Abrir no navegador</a>
      </div>
      <iframe id="preview-frame" src="${esc(url)}" title="Preview do app"></iframe>
      <div class="preview-foot"><span class="dot"></span> Preview local do espaço ${t.espaco} · as outras tarefas não são afetadas</div>`;
  } else {
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
  if (t.status === "aguardando" && t.step === "aprovacao") {
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
  else if (t.status === "falhou") ph = "O passo falhou — use “Tentar de novo” acima.";
  else if (t.step === "publicar") ph = "Tudo pronto — é só clicar em Publicar.";
  else ph = "A tarefa está parada.";
  input.disabled = !enabled;
  input.placeholder = ph;
  if (btn) btn.disabled = !enabled;
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
  "open-project": (btn) => {
    localStorage.setItem("inhouse.projectId", btn.dataset.project);
    location.hash = "#/tarefas";
  },
  "go-task": (btn) => { location.hash = `#/tarefa/${btn.dataset.task}`; },
  "focus-new-task": () => {
    const i = $("#new-task-desc");
    if (i) { i.focus(); i.scrollIntoView({ block: "nearest" }); }
  },
  "approve-plan": (btn) => taskAction(btn.dataset.task, { action: "approve_plan" }),
  "approve-test": (btn) => taskAction(btn.dataset.task, { action: "approve_test" }),
  "retry": (btn) => taskAction(btn.dataset.task, { action: "retry" }),
  "auto-toggle": (btn) => {
    const t = getTask(btn.dataset.task);
    taskAction(btn.dataset.task, { action: "auto_mode", on: !t?.autoAprovar });
  },
  "auto-on": (btn) => taskAction(btn.dataset.task, { action: "auto_mode", on: true }),
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
    const createPr = !!(p?.originUrl && state.ui.createPr);
    state.busy[`publish:${id}`] = true;
    render();
    await taskAction(id, { action: "publish", createPr });
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
    render();
    const r = await api(`/api/tasks/${encodeURIComponent(id)}/preview/start`, {});
    delete state.busy[`preview:${id}`];
    if (r?.url) {
      const t = getTask(id);
      if (t) t.previewUrl = r.url;
    }
    render();
  },
  "reload-preview": () => {
    const f = $("#preview-frame");
    if (f) f.src = f.src;
  },
  "perm-allow": (btn) => decidePermission(btn.dataset.perm, true),
  "perm-deny": (btn) => decidePermission(btn.dataset.perm, false),
};

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) {
    actions[btn.dataset.act]?.(btn, e);
    return;
  }
  // Card inteiro clicável abre o editor — desde que o clique não tenha sido em
  // botão/link/campo (esses já trataram acima ou têm comportamento próprio) e
  // que não seja seleção de texto.
  const card = e.target.closest("[data-open-task]");
  if (!card) return;
  if (e.target.closest("button, a, input, select, textarea, label")) return;
  if (String(window.getSelection() ?? "").length > 0) return;
  location.hash = `#/tarefa/${card.dataset.openTask}`;
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "project-select") {
    localStorage.setItem("inhouse.projectId", el.value);
    render();
  } else if (el.id === "create-pr") {
    state.ui.createPr = el.checked;
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
    const t = await api("/api/tasks", { projectId, title: titleFrom(description), description });
    if (t && t.id) {
      const el = $("#new-task-desc");
      if (el) el.value = "";
      upsert(state.tasks, t);
      render();
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
    if (!t || !text) return;
    input.value = "";
    if (t.status === "aguardando" && (t.step === "aprovacao" || t.step === "teste")) {
      pushLocalUser(t.id, text);
      taskAction(t.id, { action: "request_changes", message: text });
    } else {
      pushLocalUser(t.id, text);
      api(`/api/tasks/${encodeURIComponent(t.id)}/message`, { text });
    }
  }
});

// ---------- Inicialização ----------
window.addEventListener("hashchange", render);
connectSSE();
fetchState();
render();
