/**
 * Entrada do servidor do Inhouse Builder.
 * Escuta APENAS em 127.0.0.1 (decisão de segurança — ver ARCHITECTURE.md).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildRouter } from "./api/routes.js";
import { HOST, PORT, ensureDirs } from "./config.js";
import { stopAllPreviews } from "./services/preview.js";
import { load } from "./store.js";

load();
ensureDirs();

const app = express();
app.use(buildRouter());

const publicDir = fileURLToPath(new URL("../public", import.meta.url));
app.use(express.static(publicDir));

// Rotas não-API caem no index.html (a UI cuida do resto). API desconhecida → 404 JSON.
app.use((req, res) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    res.sendFile(join(publicDir, "index.html"));
  } else {
    res.status(404).json({ error: "Rota não encontrada." });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Inhouse Builder rodando em http://${HOST}:${PORT}`);
});

let encerrando = false;
function shutdown(sinal: string): void {
  if (encerrando) return;
  encerrando = true;
  console.log(`\nEncerrando o Inhouse Builder (${sinal})…`);
  stopAllPreviews();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Nunca derrubar o server por uma Promise esquecida — só logar.
process.on("unhandledRejection", (reason) => {
  console.error("[server] promessa rejeitada sem tratamento:", reason);
});
