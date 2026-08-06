/**
 * Entrada do servidor do Inhouse Builder.
 * Escuta APENAS em 127.0.0.1 (decisão de segurança — ver ARCHITECTURE.md).
 */
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildRouter } from "./api/routes.js";
import { HOST, PORT, ensureDirs } from "./config.js";
import { stopAllPreviews } from "./services/preview.js";
import { backfillSeVazio } from "./eval/coleta.js";
import { load } from "./store.js";

load();
// Primeira subida com eval: tarefas históricas viram dados (backfill idempotente).
backfillSeVazio();
ensureDirs();

const app = express();
app.use(buildRouter());

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
// Ferramenta local: frescor importa mais que cache — browsers com cache teimoso
// já nos entregaram UI velha com bug corrigido no disco.
app.use(
  express.static(publicDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  }),
);

// Rotas não-API caem no index.html (a UI cuida do resto). API desconhecida → 404 JSON.
app.use((req, res) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    res.sendFile(join(publicDir, "index.html"));
  } else {
    res.status(404).json({ error: "Rota não encontrada." });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Inhouse rodando em http://localhost:${PORT}`);
});

// "localhost" resolve para ::1 (IPv6) em alguns browsers do macOS — sem escutar
// nos dois loopbacks, a página abre num e a API falha no outro. Ambos são
// estritamente locais (nada exposto à rede).
const server6 = createServer(app);
server6.on("error", () => {
  // Máquina sem IPv6 habilitado: seguimos só com IPv4.
});
server6.listen(PORT, "::1");

let encerrando = false;
function shutdown(sinal: string): void {
  if (encerrando) return;
  encerrando = true;
  console.log(`\nEncerrando o Inhouse (${sinal})…`);
  stopAllPreviews();
  server.close();
  server6.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Nunca derrubar o server por uma Promise esquecida — só logar.
process.on("unhandledRejection", (reason) => {
  console.error("[server] promessa rejeitada sem tratamento:", reason);
});
