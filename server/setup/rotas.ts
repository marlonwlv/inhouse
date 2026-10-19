/**
 * Rotas da preparação do computador (`/api/setup*`).
 *
 * Instalar programas é a ação mais sensível do InHouse, então estas rotas têm
 * guarda própria além do bind em 127.0.0.1:
 *  - Host precisa ser local (barra DNS rebinding);
 *  - POST só com Content-Type JSON (formulário de outro site não passa) e Origin
 *    local quando o navegador manda Origin (barra CSRF). No modo de
 *    demonstração — que não instala nada — a Origin é livre, para o link de
 *    validação funcionar.
 */
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { SetupItemId } from "../../shared/types.js";
import { SETUP_ITENS } from "../../shared/types.js";
import { ErroHttp } from "./comum.js";
import type { MotorSetup } from "./comum.js";
import { cenarioValido, MotorDemo } from "./demo.js";
import { modoDemo, motorSetup } from "./servico.js";

const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostLocal(host: string | undefined): boolean {
  if (!host) return false;
  const semPorta = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return HOSTS_LOCAIS.has(semPorta.toLowerCase());
}

export function origemLocal(origin: string | undefined): boolean {
  if (!origin) return true; // navegador não manda Origin em GET/mesma origem antiga; o Content-Type cobre
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && hostLocal(u.host);
  } catch {
    return false;
  }
}

export function guardaSetup(demo: () => boolean = modoDemo): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!hostLocal(req.headers.host)) {
      res.status(403).json({ error: "Acesso só pelo próprio computador." });
      return;
    }
    if (req.method !== "GET") {
      if (!req.is("application/json")) {
        res.status(415).json({ error: "Envie os dados como JSON." });
        return;
      }
      if (!demo() && !origemLocal(req.headers.origin)) {
        res.status(403).json({ error: "Pedido recusado: veio de fora do InHouse." });
        return;
      }
    }
    next();
  };
}

function rota(fn: (req: Request, m: MotorSetup) => Promise<unknown>, motor: () => MotorSetup): RequestHandler {
  return (req, res) => {
    void fn(req, motor())
      .then((r) => res.json(r))
      .catch((err: unknown) => {
        const status = err instanceof ErroHttp ? err.status : 500;
        if (status >= 500) console.error(`[setup] ${req.method} ${req.path}:`, err);
        const msg = err instanceof Error && err.message ? err.message : "Algo deu errado na preparação. Tente de novo.";
        if (!res.headersSent) res.status(status).json({ error: msg });
      });
  };
}

function corpo(req: Request): Record<string, unknown> {
  const b = req.body as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

function itensDoCorpo(b: Record<string, unknown>): SetupItemId[] | undefined {
  const v = b["itens"];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > SETUP_ITENS.length || !v.every((x) => typeof x === "string" && (SETUP_ITENS as readonly string[]).includes(x))) {
    throw new ErroHttp(400, "Lista de itens inválida.");
  }
  return v as SetupItemId[];
}

export function registrarRotasSetup(router: Router, motor: () => MotorSetup = motorSetup, demo: () => boolean = modoDemo): void {
  router.use("/api/setup", guardaSetup(demo));

  router.get("/api/setup", rota(async (_req, m) => m.status(), motor));
  router.post("/api/setup/verificar", rota(async (_req, m) => m.status(true), motor));
  router.post("/api/setup/instalar", rota(async (req, m) => m.instalar(itensDoCorpo(corpo(req))), motor));
  router.post("/api/setup/claude/login", rota(async (_req, m) => m.iniciarLogin(), motor));
  router.post("/api/setup/claude/codigo", rota(async (req, m) => m.enviarCodigo(corpo(req)["codigo"] as string), motor));
  router.post("/api/setup/claude/cancelar", rota(async (_req, m) => m.cancelarLogin(), motor));
  router.post(
    "/api/setup/identidade",
    rota(async (req, m) => {
      const b = corpo(req);
      return m.salvarIdentidade(b["nome"] as string, b["email"] as string);
    }, motor),
  );
  router.post("/api/setup/concluir", rota(async (_req, m) => m.concluir(), motor));
  router.post(
    "/api/setup/demo",
    rota(async (req, m) => {
      if (!demo() || !(m instanceof MotorDemo)) throw new ErroHttp(404, "Rota não encontrada.");
      const b = corpo(req);
      const cenario = b["cenario"];
      const so = b["so"];
      if (!cenarioValido(cenario)) throw new ErroHttp(400, "Cenário desconhecido.");
      if (so !== "windows" && so !== "mac") throw new ErroHttp(400, "Sistema deve ser windows ou mac.");
      return m.aplicar(cenario, so);
    }, motor),
  );
}
