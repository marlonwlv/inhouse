/**
 * Rotas REST da UI (contrato no bloco "API REST" de shared/types.ts).
 * Erros sempre em JSON {error} com mensagem amigável em português.
 */
import express, { Router } from "express";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import type { ServerEvent, TaskAction } from "../../shared/types.js";
import { resolvePermission } from "../claude/permissions.js";
import { claudeStatus } from "../claude/runner.js";
import { addClient } from "../events.js";
import { startPreview, stopPreview } from "../services/preview.js";
import { cloneProject, createFromTemplate, openProject } from "../services/projects.js";
import * as store from "../store.js";
import { applyAction, startTask, steer } from "../workflow/machine.js";

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

const ACTIONS: ReadonlySet<string> = new Set([
  "approve_plan",
  "request_changes",
  "approve_test",
  "publish",
  "retry",
  "cancel",
]);

export function buildRouter(): Router {
  const router = Router();
  router.use(express.json({ limit: "1mb" }));

  // ---------- Estado e eventos ----------

  router.get(
    "/api/state",
    h(async (_req, res) => {
      res.json({
        projects: store.listProjects(),
        tasks: store.listTasks(),
        permissions: store.listPermissions(),
        claude: await cachedClaudeStatus(),
      });
    }),
  );

  router.get("/api/events", (_req, res) => {
    addClient(res);
    // Foto inicial do estado para o cliente recém-conectado.
    const ev: ServerEvent = {
      type: "state",
      projects: store.listProjects(),
      tasks: store.listTasks(),
      permissions: store.listPermissions(),
    };
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  });

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
      const url = await startPreview(task, project);
      res.json({ url });
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
