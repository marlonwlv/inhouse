/**
 * Rotas REST da UI (contrato no bloco "API REST" de shared/types.ts).
 * Erros sempre em JSON {error} com mensagem amigável em português.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import express, { Router } from "express";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { ServerEvent, TaskAction } from "../../shared/types.js";
import { FEEDBACK_NOTAS, TASK_ACTIONS } from "../../shared/types.js";
import type { FeedbackNota } from "../../shared/types.js";
import { registrarFeedback } from "../eval/coleta.js";
import { calcularResumo } from "../eval/resumo.js";
import { exportarBundle, fontesDisponiveis, importarBundle } from "../eval/transfer.js";
import { estaGerando, gerarRelatorio } from "../eval/juiz.js";
import { readJsonl, RELATORIOS_INDEX } from "../eval/coleta.js";
import { RELATORIOS_DIR } from "../config.js";
import { resolvePermission } from "../claude/permissions.js";
import { claudeStatus } from "../claude/runner.js";
import { isFakeModelActive } from "../debug/flag.js";
import { registerDebugRoutes } from "../debug/routes.js";
import { addClient, broadcast } from "../events.js";
import {
  PreviewIndisponivelError,
  configurarPreviewComAgente,
  startPreview,
  stopPreview,
  temPreviewConfigCommitada,
} from "../services/preview.js";
import { aplicarUpdate, ultimoUpdate } from "../services/update.js";
import { slugify } from "../services/worktrees.js";
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
      res.json(await startTask(projectId, title, description));
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
      await steer(id, msg);
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
        res.status(status).json({ error: msg, podeConfigurarComAgente });
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
  router.get("/api/tasks/:id/mockup", h(async (req, res) => serveMockup(req, res, "")));
  router.get("/api/tasks/:id/mockup/*", h(async (req, res) => serveMockup(req, res, (req.params as Record<string, string>)[0] ?? "")));

  router.post(
    "/api/tasks/:id/preview/stop",
    h(async (req, res) => {
      const id = req.params.id ?? "";
      if (!store.getTask(id)) throw new HttpError(404, "Tarefa não encontrada.");
      await stopPreview(id);
      res.json({ ok: true });
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
