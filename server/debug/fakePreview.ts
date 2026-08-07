/**
 * Preview fake do modo debug: em vez de subir o dev server real (vite), sobe um
 * pequeno servidor HTTP em memória que serve um app de DEMONSTRAÇÃO com VÁRIAS
 * rotas — para testar de verdade o iframe do preview e a barra de URL navegável.
 */
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Task } from "../../shared/types.js";
import { broadcast } from "../events.js";
import * as store from "../store.js";

/** Um servidor de preview por tarefa (fechado no stop / shutdown). */
const servers = new Map<string, Server>();

interface Rota {
  titulo: string;
  corpo: string;
}

/** Rotas fixas do app de demonstração (qualquer outra rota também responde). */
const ROTAS: Record<string, Rota> = {
  "/": { titulo: "Início", corpo: "<p>Home do app de preview (debug). Navegue pelo menu ou pela barra de endereço.</p>" },
  "/produtos": {
    titulo: "Produtos",
    corpo: "<ul><li><a href='/produtos/1'>Produto 1</a></li><li><a href='/produtos/2'>Produto 2</a></li></ul>",
  },
  "/produtos/1": { titulo: "Produto 1", corpo: "<p>Detalhe do <b>produto 1</b> — uma rota aninhada (debug).</p>" },
  "/produtos/2": { titulo: "Produto 2", corpo: "<p>Detalhe do <b>produto 2</b> — outra rota aninhada (debug).</p>" },
  "/sobre": { titulo: "Sobre", corpo: "<p>Página <b>Sobre</b> (debug).</p>" },
  "/contato": { titulo: "Contato", corpo: "<p>Página <b>Contato</b> (debug).</p>" },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

function pagina(path: string): string {
  const rota = ROTAS[path];
  const titulo = rota?.titulo ?? "Rota livre";
  const corpo =
    rota?.corpo ??
    `<p>Não há uma página fixa para <code>${escapeHtml(path)}</code>, mas a rota respondeu — ótimo para testar a barra de URL (debug).</p>`;
  const nav = Object.entries(ROTAS)
    .map(([r, v]) => `<a href="${r}"${r === path ? ' aria-current="page"' : ""}>${escapeHtml(v.titulo)}</a>`)
    .join(" · ");
  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(titulo)} — preview (debug)</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#0f0f12;color:#e7e7ea}
  header{background:#18181b;padding:14px 20px;border-bottom:1px solid #2a2a2e;position:sticky;top:0}
  nav a{color:#8ab4f8;text-decoration:none;margin-right:2px;padding:4px 6px;border-radius:6px}
  nav a[aria-current]{background:#26314a;color:#cfe0ff}
  main{padding:30px 24px;max-width:760px}
  .path{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa0aa;margin-bottom:10px}
  h1{font-size:24px;margin:.2em 0}
  a{color:#8ab4f8}
  .foot{margin-top:32px;color:#9aa0aa;font-size:13px;border-top:1px solid #2a2a2e;padding-top:14px}
</style></head>
<body><header><nav>${nav}</nav></header>
<main>
  <div class="path">rota atual: ${escapeHtml(path)}</div>
  <h1>${escapeHtml(titulo)}</h1>
  ${corpo}
  <p class="foot">Preview <b>fake</b> do modo debug — sem <code>vite</code>. Use o menu acima ou a barra de endereço do Inhouse para navegar entre as rotas.</p>
</main></body></html>`;
}

function urlDe(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

function portaDe(server: Server): number {
  const addr = server.address() as AddressInfo | null;
  return addr && typeof addr === "object" ? addr.port : 0;
}

/** Sobe (ou reusa) o servidor de preview fake da tarefa e devolve a URL. */
export function startFakePreview(task: Task): Promise<string> {
  const existente = servers.get(task.id);
  if (existente && existente.listening) return Promise.resolve(urlDe(portaDe(existente)));

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const bruto = (req.url ?? "/").split("?")[0] || "/";
      // URL malformada (ex.: "/%zz" digitada na barra) faria decodeURIComponent
      // lançar DENTRO do listener → uncaughtException derruba o server inteiro.
      // Cai no caminho bruto em vez de morrer.
      let path: string;
      try {
        path = decodeURIComponent(bruto);
      } catch {
        path = bruto;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pagina(path));
    });
    // Porta 0 = o SO escolhe uma livre (sem colisão entre espaços).
    server.listen(0, "127.0.0.1", () => {
      servers.set(task.id, server);
      const url = urlDe(portaDe(server));
      const atualizado = store.updateTask(task.id, { previewUrl: url });
      broadcast({ type: "preview_ready", taskId: task.id, url });
      broadcast({ type: "task_updated", task: atualizado });
      resolve(url);
    });
  });
}

/** Derruba o preview fake de uma tarefa (e limpa a URL do estado). */
export function stopFakePreview(taskId: string): void {
  const s = servers.get(taskId);
  if (s) {
    s.close();
    servers.delete(taskId);
  }
  if (store.getTask(taskId)?.previewUrl) {
    const atualizado = store.updateTask(taskId, { previewUrl: undefined });
    broadcast({ type: "task_updated", task: atualizado });
  }
}

/** Derruba todos os previews fake (shutdown do servidor). */
export function stopAllFakePreviews(): void {
  for (const s of servers.values()) s.close();
  servers.clear();
}
