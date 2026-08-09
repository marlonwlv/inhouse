/**
 * Rotas REST da UI (contrato no bloco "API REST" de shared/types.ts).
 * Erros sempre em JSON {error} com mensagem amigável em português.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import express, { Router } from "express";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { ServerEvent, TaskAction, TaskAnexo } from "../../shared/types.js";
import { FEEDBACK_NOTAS, TASK_ACTIONS } from "../../shared/types.js";
import type { FeedbackNota } from "../../shared/types.js";
import { registrarFeedback } from "../eval/coleta.js";
import { calcularResumo } from "../eval/resumo.js";
import { exportarBundle, fontesDisponiveis, importarBundle } from "../eval/transfer.js";
import { estaGerando, gerarRelatorio } from "../eval/juiz.js";
import { readJsonl, RELATORIOS_INDEX } from "../eval/coleta.js";
import { ANEXOS_DIR, RELATORIOS_DIR } from "../config.js";
import { resolvePermission } from "../claude/permissions.js";
import { claudeStatus } from "../claude/runner.js";
import { isFakeModelActive } from "../debug/flag.js";
import { registerDebugRoutes } from "../debug/routes.js";
import { addClient, broadcast } from "../events.js";
import {
  PreviewIndisponivelError,
  PreviewQuebradoError,
  configurarPreviewComAgente,
  startPreview,
  stopPreview,
  temPreviewConfigCommitada,
} from "../services/preview.js";
import { aplicarUpdate, ultimoUpdate } from "../services/update.js";
import { slugify } from "../services/worktrees.js";
import { tryGit } from "../services/proc.js";
import {
  deleteWorkflow,
  getState as getWorkflows,
  setActive as setActiveWorkflow,
  skillCatalog,
  upsertWorkflow,
} from "../workflow/library.js";
import { gerarWorkflow } from "../workflow/gerar.js";
import { cloneProject, createFromTemplate, openProject } from "../services/projects.js";
import * as store from "../store.js";
import { applyAction, startPreparacao, startTask, steer } from "../workflow/machine.js";

/** Erro com status HTTP próprio (validações de input → 400/404). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Express 4 não captura erro de handler async — este wrapper vira 4xx/500 JSON. */
function h(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    void fn(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Algo deu errado no servidor. Tente de novo.";
      if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err);
      if (!res.headersSent) res.status(status).json({ error: msg });
    });
  };
}

/** Extrai um campo de texto obrigatório do body (400 se ausente/vazio). */
function texto(body: unknown, campo: string, rotulo: string): string {
  const v = (body as Record<string, unknown> | null | undefined)?.[campo];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new HttpError(400, `Informe ${rotulo}.`);
  }
  return v.trim();
}

// ---------- Anexos ----------
// Localhost, single-user: limites generosos mas com teto (evita encher o disco).
const MAX_ANEXOS = 8;
const MAX_ANEXO_BYTES = 20 * 1024 * 1024; // 20 MB por arquivo

/** Nome de arquivo seguro (sem barras, sem escapar da pasta do upload). */
function sanitizeNome(nome: string): string {
  const base = basename(String(nome || "arquivo")).replace(/[^\w.\- ]+/g, "_").trim();
  return base.slice(0, 120) || "arquivo";
}

/**
 * Valida os refs de anexo que o cliente devolve ao criar tarefa/mensagem: cada
 * `path` PRECISA existir DENTRO de ANEXOS_DIR — sem isso, um cliente poderia
 * apontar para /etc/passwd e fazer o Claude ler arquivo arbitrário.
 */
function validarAnexos(bruto: unknown): TaskAnexo[] | undefined {
  if (bruto === undefined || bruto === null) return undefined;
  if (!Array.isArray(bruto)) throw new HttpError(400, "Anexos inválidos.");
  if (bruto.length === 0) return undefined;
  if (bruto.length > MAX_ANEXOS) throw new HttpError(400, `Anexe no máximo ${MAX_ANEXOS} arquivos.`);
  const base = resolve(ANEXOS_DIR);
  return (bruto as Record<string, unknown>[]).map((a) => {
    const abs = resolve(typeof a?.["path"] === "string" ? (a["path"] as string) : "");
    if (!abs.startsWith(base + sep) || !existsSync(abs)) {
      throw new HttpError(400, "Um dos anexos não foi encontrado — reenvie o arquivo.");
    }
    return {
      nome: typeof a?.["nome"] === "string" ? sanitizeNome(a["nome"] as string) : "arquivo",
      tipo: typeof a?.["tipo"] === "string" ? (a["tipo"] as string).slice(0, 100) : "",
      path: abs,
    };
  });
}

// Status do Claude é caro de checar (spawn) — cache de 60s.
let claudeCache: { at: number; value: Awaited<ReturnType<typeof claudeStatus>> } | undefined;
async function cachedClaudeStatus(): Promise<Awaited<ReturnType<typeof claudeStatus>>> {
  if (claudeCache && Date.now() - claudeCache.at < 60_000) return claudeCache.value;
  const value = await claudeStatus();
  claudeCache = { at: Date.now(), value };
  return value;
}

const ACTIONS: ReadonlySet<string> = new Set(TASK_ACTIONS);

export function buildRouter(): Router {
  const router = Router();

  // Import de eval pode ser grande (inclui transcripts). Parser dedicado com
  // limite maior, registrado ANTES do parser global de 1mb — que, por rodar
  // primeiro, recusaria o upload com 413.
  router.post(
    "/api/eval/import",
    express.json({ limit: "50mb" }),
    h(async (req, res) => {
      const body = req.body as Record<string, unknown> | null | undefined;
      const bundle = body?.["bundle"];
      const fonte = typeof body?.["fonte"] === "string" ? (body["fonte"] as string) : "";
      if (!fonte.trim()) throw new HttpError(400, "Diga de quem são estes dados (um nome para a origem).");
      // "todos"/"meus" são rótulos reservados do filtro; "import" é o fallback interno.
      if (["todos", "meus", "import"].includes(fonte.trim().toLowerCase())) {
        throw new HttpError(400, `"${fonte.trim()}" é um nome reservado. Use outro nome para a origem.`);
      }
      try {
        const r = importarBundle(bundle, fonte);
        res.json(r);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "Arquivo de dados inválido.");
      }
    }),
  );

  // Upload de anexos (imagens/PDF): parser dedicado grande, ANTES do global de 1mb
  // (mesmo padrão do import de eval). Escreve em ANEXOS_DIR/<uploadId>/ e devolve os refs.
  router.post(
    "/api/anexos",
    express.json({ limit: "40mb" }),
    h(async (req, res) => {
      const body = req.body as { files?: unknown } | null | undefined;
      const files = Array.isArray(body?.files) ? (body!.files as Record<string, unknown>[]) : [];
      if (files.length === 0) throw new HttpError(400, "Nenhum arquivo enviado.");
      if (files.length > MAX_ANEXOS) throw new HttpError(400, `Anexe no máximo ${MAX_ANEXOS} arquivos por vez.`);
      const dir = resolve(ANEXOS_DIR, store.newId());
      mkdirSync(dir, { recursive: true });
      const anexos: TaskAnexo[] = [];
      for (const f of files) {
        const nome = sanitizeNome(String(f["nome"] ?? "arquivo"));
        const tipo = typeof f["tipo"] === "string" ? (f["tipo"] as string).slice(0, 100) : "";
        const raw = typeof f["dataBase64"] === "string" ? (f["dataBase64"] as string) : "";
        // Aceita data URL ("data:...;base64,XXXX") ou base64 puro.
        const b64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
        const buf = Buffer.from(b64, "base64");
        if (buf.length === 0) throw new HttpError(400, `O arquivo "${nome}" veio vazio.`);
        if (buf.length > MAX_ANEXO_BYTES) throw new HttpError(400, `"${nome}" passa de 20 MB — anexe um menor.`);
        const alvo = resolve(dir, nome);
        if (alvo !== dir && !alvo.startsWith(dir + sep)) throw new HttpError(400, "Nome de arquivo inválido.");
        writeFileSync(alvo, buf);
        anexos.push({ nome, tipo, path: alvo });
      }
      res.json({ anexos });
    }),
  );

  router.use(express.json({ limit: "1mb" }));

  // Painel de Debug: só existe quando o modo fake está ligado (INHOUSE_FAKE_MODEL).
  if (isFakeModelActive()) registerDebugRoutes(router);

  // ---------- Estado e eventos ----------

  router.get(
    "/api/state",
    h(async (_req, res) => {
      res.json({
        projects: store.listProjects(),
        tasks: store.listTasks(),
        permissions: store.listPermissions(),
        claude: await cachedClaudeStatus(),
        update: ultimoUpdate(),
        fake: isFakeModelActive(),
      });
    }),
  );

  // Atualizar o próprio Inhouse (git pull --ff-only); pede reiniciar depois.
  router.post(
    "/api/update",
    h(async (_req, res) => {
      res.json(await aplicarUpdate());
    }),
  );

  // "/api/stream" é o caminho principal; "/api/events" fica como alias — listas
  // de adblock (EasyPrivacy etc.) casam padrões tipo "/events" e matavam o SSE.
  const sse = (_req: Request, res: Response): void => {
    addClient(res);
    // Foto inicial do estado para o cliente recém-conectado.
    const ev: ServerEvent = {
      type: "state",
      projects: store.listProjects(),
      tasks: store.listTasks(),
      permissions: store.listPermissions(),
    };
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  router.get("/api/stream", sse);
  router.get("/api/events", sse);

  // ---------- Projetos ----------

  router.post(
    "/api/projects/clone",
    h(async (req, res) => {
      const url = texto(req.body, "url", "o endereço do repositório no GitHub");
      res.json(await cloneProject(url));
    }),
  );

  router.post(
    "/api/projects/from-template",
    h(async (req, res) => {
      const name = texto(req.body, "name", "o nome do novo app");
      const template = texto(req.body, "template", "o modelo do app");
      res.json(await createFromTemplate(name, template));
    }),
  );

  router.post(
    "/api/projects/open",
    h(async (req, res) => {
      const path = texto(req.body, "path", "o caminho da pasta do projeto");
      res.json(await openProject(path));
    }),
  );

  // Setup guiado do repositório (cria uma tarefa especial de preparação).
  router.post(
    "/api/projects/:id/prepare",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      if (!store.getProject(id)) throw new HttpError(404, "Projeto não encontrado.");
      res.json(await startPreparacao(id));
    }),
  );

  // ---------- Tarefas ----------

  router.post(
    "/api/tasks",
    h(async (req, res) => {
      const projectId = texto(req.body, "projectId", "o projeto da tarefa");
      const description = texto(req.body, "description", "o que você quer que seja feito");
      if (!store.getProject(projectId)) throw new HttpError(404, "Projeto não encontrado.");
      const tituloBody = (req.body as Record<string, unknown>)["title"];
      // Sem título? Usa o começo do pedido.
      const title =
        typeof tituloBody === "string" && tituloBody.trim().length > 0
          ? tituloBody.trim()
          : `${description.split("\n")[0] ?? description}`.slice(0, 60);
      const anexos = validarAnexos((req.body as Record<string, unknown>)["anexos"]);
      const modo = (req.body as Record<string, unknown>)["modo"] === "livre" ? "livre" : "esteira";
      res.json(await startTask(projectId, title, description, anexos, modo));
    }),
  );

  router.get(
    "/api/tasks/:id/transcript",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      if (!store.getTask(id)) throw new HttpError(404, "Tarefa não encontrada.");
      res.json(store.transcriptRead(id));
    }),
  );

  router.post(
    "/api/tasks/:id/action",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const body = req.body as Record<string, unknown> | null | undefined;
      const nome = body?.["action"];
      if (typeof nome !== "string" || !ACTIONS.has(nome)) {
        throw new HttpError(400, "Ação inválida.");
      }
      if (nome === "request_changes") texto(body, "message", "o que você quer mudar");
      if (!store.getTask(id)) throw new HttpError(404, "Tarefa não encontrada.");
      res.json(await applyAction(id, body as unknown as TaskAction));
    }),
  );

  router.post(
    "/api/tasks/:id/message",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const msg = texto(req.body, "text", "a mensagem");
      if (!store.getTask(id)) throw new HttpError(404, "Tarefa não encontrada.");
      const anexos = validarAnexos((req.body as Record<string, unknown>)["anexos"]);
      await steer(id, msg, anexos);
      res.status(202).json({ ok: true });
    }),
  );

  router.post(
    "/api/tasks/:id/feedback",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const task = store.getTask(id);
      if (!task) throw new HttpError(404, "Tarefa não encontrada.");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const nota = String(body.nota ?? "");
      if (!(FEEDBACK_NOTAS as readonly string[]).includes(nota)) {
        throw new HttpError(400, "Escolha uma das opções de avaliação.");
      }
      const textoLivre =
        typeof body.texto === "string" && body.texto.trim() ? body.texto.trim().slice(0, 2000) : undefined;
      registrarFeedback(id, nota as FeedbackNota, textoLivre);
      // O juiz vê o feedback em contexto no chat da tarefa.
      const emoji = nota === "otimo" ? "😃" : nota === "ok" ? "😐" : "😖";
      const item = {
        kind: "system" as const,
        text: `Feedback registrado: ${emoji}${textoLivre ? ` — “${textoLivre}”` : ""}`,
        at: new Date().toISOString(),
      };
      store.transcriptAppend(id, item);
      broadcast({ type: "transcript", taskId: id, item });
      res.json({ ok: true });
    }),
  );

  // ---------- Eval de experiência ----------

  router.get(
    "/api/eval/resumo",
    h(async (req, res) => {
      const fonte = typeof req.query.fonte === "string" ? req.query.fonte : undefined;
      res.json({ ...calcularResumo(fonte), gerando: estaGerando() });
    }),
  );

  // Fontes importadas disponíveis (para o filtro da tela Experiência).
  router.get(
    "/api/eval/fontes",
    h(async (_req, res) => {
      res.json({ fontes: fontesDisponiveis() });
    }),
  );

  // Exporta os dados locais desta máquina como um bundle para download.
  router.get(
    "/api/eval/export",
    h(async (req, res) => {
      const incluirTranscripts = req.query.transcripts === "1";
      const label = typeof req.query.label === "string" ? req.query.label.slice(0, 40) : undefined;
      const bundle = exportarBundle(incluirTranscripts, label);
      const nome = `inhouse-eval-${label ? label.replace(/[^\w-]/g, "") + "-" : ""}${bundle.geradoEm.slice(0, 10)}.json`;
      res.setHeader("Content-Disposition", `attachment; filename="${nome}"`);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(JSON.stringify(bundle));
    }),
  );

  router.get(
    "/api/eval/relatorios",
    h(async (_req, res) => {
      const relatorios = readJsonl(RELATORIOS_INDEX()).reverse();
      res.json({ relatorios });
    }),
  );

  router.get(
    "/api/eval/relatorios/:arquivo",
    h(async (req, res) => {
      const nome = req.params.arquivo ?? "";
      // Anti path traversal: só nomes simples de .md, resolvidos DENTRO de RELATORIOS_DIR.
      if (!/^[\w][\w.-]*\.md$/.test(nome)) throw new HttpError(400, "Nome de arquivo inválido.");
      const caminho = resolve(RELATORIOS_DIR, nome);
      if (!caminho.startsWith(resolve(RELATORIOS_DIR) + sep) || !existsSync(caminho)) {
        throw new HttpError(404, "Relatório não encontrado.");
      }
      res.json({ conteudo: readFileSync(caminho, "utf8") });
    }),
  );

  router.post(
    "/api/eval/relatorios",
    h(async (_req, res) => {
      if (estaGerando()) throw new HttpError(409, "Uma análise já está sendo gerada. Aguarde.");
      void gerarRelatorio("manual");
      res.status(202).json({ ok: true });
    }),
  );

  // ---------- Permissões ----------

  router.post(
    "/api/permissions/:id/decision",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const body = req.body as Record<string, unknown> | null | undefined;
      const allow = body?.["allow"];
      if (typeof allow !== "boolean") {
        throw new HttpError(400, "Informe se a ação foi permitida (allow: true ou false).");
      }
      const remember = body?.["remember"] === true;
      if (!resolvePermission(id, allow, remember)) {
        throw new HttpError(404, "Este pedido de permissão não existe mais (ou já foi respondido).");
      }
      res.json({ ok: true });
    }),
  );

  // ---------- Preview ----------

  router.post(
    "/api/tasks/:id/preview/start",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const task = store.getTask(id);
      if (!task) throw new HttpError(404, "Tarefa não encontrada.");
      const project = store.getProject(task.projectId);
      if (!project) throw new HttpError(404, "O projeto desta tarefa não foi encontrado.");
      try {
        const url = await startPreview(task, project);
        res.json({ url });
      } catch (err) {
        // Degradação graciosa: sem tela para pré-visualizar (ou a subida falhou).
        // Só oferecemos o agente quando NÃO há config commitada (que venceria a receita).
        const msg = err instanceof Error ? err.message : "Não foi possível abrir o preview.";
        const status = err instanceof PreviewIndisponivelError ? 422 : 502;
        const podeConfigurarComAgente = !temPreviewConfigCommitada(project, task.worktreePath);
        // PreviewQuebradoError: subiu mas está quebrado — manda o detalhe técnico junto.
        const detalhe = err instanceof PreviewQuebradoError ? err.detalhe : undefined;
        res.status(status).json({ error: msg, podeConfigurarComAgente, ...(detalhe ? { detalhe } : {}) });
      }
    }),
  );

  // Camada 2.5: o Claude descobre a receita de preview e o Inhouse a usa.
  router.post(
    "/api/tasks/:id/preview/configure",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      const task = store.getTask(id);
      if (!task) throw new HttpError(404, "Tarefa não encontrada.");
      const project = store.getProject(task.projectId);
      if (!project) throw new HttpError(404, "O projeto desta tarefa não foi encontrado.");
      try {
        const url = await configurarPreviewComAgente(task, project);
        res.json({ url });
      } catch (err) {
        // O agente concluir "não há preview" é um desfecho ESPERADO, não erro de
        // servidor (evita 500 no log) — e a UI para de oferecer a configuração.
        if (err instanceof PreviewIndisponivelError) {
          res.status(422).json({ error: err.message, podeConfigurarComAgente: false });
        } else {
          throw err;
        }
      }
    }),
  );

  // Serve os mockups do protótipo (docs/plans/mockups/<slug>/) do espaço da tarefa.
  const serveMockup = (req: Request, res: Response, sub: string): void => {
    const task = store.getTask(req.params.id ?? "");
    if (!task) throw new HttpError(404, "Tarefa não encontrada.");
    const base = resolve(task.worktreePath, "docs", "plans", "mockups", slugify(task.title));
    const alvo = resolve(base, sub || "index.html");
    if (alvo !== base && !alvo.startsWith(base + sep)) throw new HttpError(400, "Caminho inválido.");
    if (!existsSync(alvo)) throw new HttpError(404, "Protótipo não encontrado.");
    // Revalida pelo realpath: um symlink dentro da pasta não pode apontar pra fora.
    const real = realpathSync(alvo);
    const baseReal = realpathSync(base);
    if (real !== baseReal && !real.startsWith(baseReal + sep)) throw new HttpError(400, "Caminho inválido.");
    res.sendFile(real);
  };
  // Sem a barra final, os assets relativos do mockup (styles.css, app.js, *.html)
  // resolvem para /api/tasks/:id/<asset> e dão 404. A barra faz tudo cair em
  // /mockup/*. O Express (non-strict) casa /mockup e /mockup/ nesta rota, então
  // ramificamos: sem barra → redireciona; com barra → serve o index (sem loop).
  router.get("/api/tasks/:id/mockup", h(async (req, res) => {
    if (req.path.endsWith("/mockup/")) serveMockup(req, res, "");
    else res.redirect(302, `/api/tasks/${encodeURIComponent(req.params.id ?? "")}/mockup/`);
  }));
  router.get("/api/tasks/:id/mockup/*", h(async (req, res) => serveMockup(req, res, (req.params as Record<string, string>)[0] ?? "")));

  // ---------- Artefatos (docs + protótipo) — acessíveis a qualquer momento ----------
  /**
   * Documentos que ESTA tarefa gerou: arquivos .md sob docs/ que estão NOVOS ou
   * ALTERADOS em relação à branch base do projeto — não o docs/plans inteiro do
   * repo (num projeto real isso são dezenas de planos antigos do time). Inclui os
   * ainda não versionados, porque o agente escreve sem commitar. Os mockups do
   * protótipo ficam de fora (viram o botão "Protótipo"). Caminhos relativos à raiz
   * do espaço. Degrada para lista vazia se o git falhar (nunca derruba a rota).
   */
  async function docsDaTarefa(
    worktreePath: string,
    defaultBranch: string,
  ): Promise<{ nome: string; rel: string }[]> {
    let base = "";
    for (const ref of [defaultBranch, `origin/${defaultBranch}`]) {
      const mb = await tryGit(worktreePath, "merge-base", ref, "HEAD");
      if (mb) {
        base = mb;
        break;
      }
    }
    const rels = new Set<string>();
    if (base) {
      const diff = await tryGit(worktreePath, "diff", "--name-only", "--diff-filter=AM", base, "--", "docs");
      if (diff) for (const l of diff.split("\n")) if (l.trim()) rels.add(l.trim());
    }
    const novos = await tryGit(worktreePath, "ls-files", "--others", "--exclude-standard", "--", "docs");
    if (novos) for (const l of novos.split("\n")) if (l.trim()) rels.add(l.trim());

    return [...rels]
      .filter((rel) => /\.md$/i.test(rel) && !rel.includes("/mockups/"))
      .sort((a, b) => a.localeCompare(b))
      .map((rel) => ({ nome: rel.split("/").pop() ?? rel, rel }));
  }

  router.get(
    "/api/tasks/:id/artefatos",
    h(async (req, res) => {
      const task = store.getTask(req.params.id ?? "");
      if (!task) throw new HttpError(404, "Tarefa não encontrada.");
      const project = store.getProject(task.projectId);
      const mockupIndex = resolve(
        task.worktreePath || "",
        "docs",
        "plans",
        "mockups",
        slugify(task.title),
        "index.html",
      );
      const docs =
        task.worktreePath && project ? await docsDaTarefa(task.worktreePath, project.defaultBranch) : [];
      res.json({ temPrototipo: existsSync(mockupIndex), docs });
    }),
  );

  router.get(
    "/api/tasks/:id/artefatos/doc",
    h(async (req, res) => {
      const task = store.getTask(req.params.id ?? "");
      if (!task) throw new HttpError(404, "Tarefa não encontrada.");
      if (!task.worktreePath) throw new HttpError(404, "Documento não encontrado.");
      const rel = typeof req.query.rel === "string" ? req.query.rel : "";
      // Só .md, sem "..", resolvido DENTRO do espaço da tarefa.
      if (!/\.md$/i.test(rel) || rel.includes("..")) throw new HttpError(400, "Documento inválido.");
      const root = resolve(task.worktreePath);
      const alvo = resolve(root, rel);
      if (!alvo.startsWith(root + sep)) throw new HttpError(400, "Caminho inválido.");
      if (!existsSync(alvo)) throw new HttpError(404, "Documento não encontrado.");
      // Revalida pelo realpath (symlink não pode escapar do espaço).
      const real = realpathSync(alvo);
      const rootReal = realpathSync(root);
      if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new HttpError(400, "Caminho inválido.");
      res.json({ conteudo: readFileSync(real, "utf8") });
    }),
  );

  router.post(
    "/api/tasks/:id/preview/stop",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      if (!store.getTask(id)) throw new HttpError(404, "Tarefa não encontrada.");
      await stopPreview(id);
      res.json({ ok: true });
    }),
  );

  // ---------- Workflows (biblioteca configurável) ----------
  router.get(
    "/api/workflows",
    h(async (_req, res) => {
      res.json({ ...getWorkflows(), catalogo: skillCatalog() });
    }),
  );

  router.post(
    "/api/workflows",
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        const w = upsertWorkflow({
          id: typeof body.id === "string" ? body.id : undefined,
          name: String(body.name ?? ""),
          descricao: typeof body.descricao === "string" ? body.descricao : undefined,
          origem: body.origem === "ia" ? "ia" : "manual",
          skills: body.skills,
        });
        res.json(w);
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "Não foi possível salvar o workflow.");
      }
    }),
  );

  router.delete(
    "/api/workflows/:id",
    h(async (req, res) => {
      try {
        deleteWorkflow(req.params.id ?? "");
        res.json({ ok: true });
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "Não foi possível remover o workflow.");
      }
    }),
  );

  router.post(
    "/api/workflows/:id/ativar",
    h(async (req, res) => {
      const projectId = typeof (req.body as Record<string, unknown>)?.projectId === "string"
        ? ((req.body as Record<string, unknown>).projectId as string)
        : undefined;
      if (projectId && !store.getProject(projectId)) throw new HttpError(404, "Projeto não encontrado.");
      try {
        res.json(setActiveWorkflow(req.params.id ?? "", projectId));
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : "Não foi possível ativar o workflow.");
      }
    }),
  );

  // Geração/refino por IA: devolve uma PROPOSTA (não salva) restrita ao catálogo.
  router.post(
    "/api/workflows/gerar",
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const instrucao = typeof body.instrucao === "string" ? body.instrucao : "";
      if (!instrucao.trim()) throw new HttpError(400, "Diga o que você quer no workflow.");
      const atual =
        body.atual && typeof body.atual === "object" ? (body.atual as { name: string; skills: unknown }) : undefined;
      const r = await gerarWorkflow(instrucao, atual as never);
      if (r.erro) throw new HttpError(422, r.erro);
      res.json({ proposta: r.proposta });
    }),
  );

  // Erros lançados por middlewares (ex.: JSON malformado ou grande demais no
  // body) não passam pelo wrapper h() — sem isto, o Express devolveria uma
  // página HTML em inglês, quebrando o contrato "erro sempre em JSON pt-BR".
  const erroDeMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
    const bruto = (err as { status?: unknown }).status;
    const status = typeof bruto === "number" && bruto >= 400 && bruto < 600 ? bruto : 500;
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err);
    const msg =
      status === 413
        ? "Os dados enviados são grandes demais."
        : status < 500
          ? "Não conseguimos entender os dados enviados. Recarregue a página e tente de novo."
          : "Algo deu errado no servidor. Tente de novo.";
    if (!res.headersSent) res.status(status).json({ error: msg });
  };
  router.use(erroDeMiddleware);

  return router;
}
