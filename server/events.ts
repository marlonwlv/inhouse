import type { Response } from "express";
import type { ServerEvent } from "../shared/types.js";

/** Bus SSE global: um stream por cliente conectado em GET /api/events. */
const clients = new Set<Response>();

export function addClient(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": conectado\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

export function broadcast(ev: ServerEvent): void {
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// Heartbeat para atravessar proxies/timeouts.
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(": ping\n\n");
    } catch {
      clients.delete(res);
    }
  }
}, 25_000).unref();
