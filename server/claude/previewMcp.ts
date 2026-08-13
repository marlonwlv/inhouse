/**
 * Ferramentas de preview para o AGENTE (MCP in-process do Agent SDK): o agente
 * enxerga e comanda o preview gerenciado — sem nunca subir servidor por conta
 * própria (a regra de ouro continua: quem sobe é o Inhouse, numa porta única).
 * Nomes finais das tools: mcp__inhouse__preview_* (auto-aprovadas no gate).
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { broadcast } from "../events.js";
import {
  adicionarHealthPath,
  previewLogs,
  previewStatus,
  restartPreview,
} from "../services/preview.js";
import { lastLines } from "../services/proc.js";
import * as store from "../store.js";

/** Resposta padrão MCP: um bloco de texto com JSON (o agente parseia). */
function json(obj: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function sistema(taskId: string, text: string): void {
  const item = { kind: "system" as const, text, at: new Date().toISOString() };
  store.transcriptAppend(taskId, item);
  broadcast({ type: "transcript", taskId, item });
}

/**
 * Servidor MCP de uma tarefa (closure sobre o taskId — cada runPhase cria o seu).
 * `permitirReiniciar: false` nas fases em que o ciclo MECÂNICO da esteira está no
 * comando do preview (runPreviewCheck, configurarPreviewComAgente) — reiniciar ali
 * conflitaria com o stop/start da própria esteira.
 */
export function createPreviewMcp(
  taskId: string,
  opts: { permitirReiniciar?: boolean } = {},
): McpSdkServerConfigWithInstance {
  const permitirReiniciar = opts.permitirReiniciar !== false;

  return createSdkMcpServer({
    name: "inhouse",
    version: "1.0.0",
    instructions:
      "Ferramentas do preview gerenciado pelo Inhouse. Quem sobe o dev server é SEMPRE o Inhouse, " +
      "numa porta única — nunca rode `npm run dev`/`vite`/`next dev` você mesmo (será bloqueado). " +
      "Use preview_status para saber a URL/porta atual antes de qualquer curl.",
    tools: [
      tool(
        "preview_status",
        "Consulta o estado ATUAL do preview gerenciado desta tarefa: URL, porta, status e rotas do " +
          "health-check. Use SEMPRE que precisar da URL/porta — nunca confie em URLs de mensagens antigas.",
        {},
        async () => json(previewStatus(taskId)),
      ),
      tool(
        "preview_logs",
        "Lê as últimas linhas do registro (stdout+stderr) do dev server do preview — é onde aparecem " +
          "erros de runtime, variável de ambiente faltando e stack traces.",
        { linhas: z.number().int().min(1).max(500).optional().describe("Quantas linhas do fim (default 100)") },
        async ({ linhas }) => {
          const tail = lastLines(previewLogs(taskId), linhas ?? 100);
          return json({ logs: tail || "(sem registro ainda — o preview talvez não tenha subido)" });
        },
      ),
      tool(
        "preview_reiniciar",
        "Reinicia o preview gerenciado pelo Inhouse (derruba e sobe de novo, na mesma porta). Use após " +
          "mudar .env/config que o dev server não recarrega sozinho. NÃO suba servidor você mesmo.",
        { motivo: z.string().optional().describe("Por que reiniciar (aparece no chat da pessoa)") },
        async ({ motivo }) => {
          if (!permitirReiniciar) {
            return json({
              ok: false,
              aviso:
                "O Inhouse está no comando do preview neste passo — não reinicie agora. " +
                "Use preview_status para acompanhar; o Inhouse sobe/reinicia sozinho quando preciso.",
            });
          }
          try {
            const r = await restartPreview(taskId);
            // A mensagem no chat só DEPOIS do desfecho — nunca anunciar um
            // reinício que pode ter falhado.
            sistema(taskId, `O Claude reiniciou o preview${motivo ? ` — ${motivo}` : ""}.`);
            const porta = (() => {
              try {
                return Number(new URL(r.url).port) || undefined;
              } catch {
                return undefined;
              }
            })();
            return json({ ok: true, url: r.url, porta, aviso: r.aviso });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            sistema(taskId, `O Claude tentou reiniciar o preview, mas não deu: ${msg}`);
            return json({ ok: false, aviso: msg });
          }
        },
      ),
      tool(
        "preview_reportar_rota",
        "Registra uma rota/tela importante (ex.: a que quebrou) nos health-checks futuros do preview " +
          "deste projeto — ela passa a ser conferida sempre antes de a pessoa testar.",
        {
          rota: z.string().describe('Caminho começando com "/" (ex.: "/admin/relatorios")'),
          motivo: z.string().optional().describe("Por que esta rota importa"),
        },
        async ({ rota }) => {
          const projectId = store.getTask(taskId)?.projectId;
          const ok = projectId ? adicionarHealthPath(projectId, rota) : false;
          return json(
            ok
              ? { ok: true, rota }
              : { ok: false, aviso: 'Rota inválida — use um caminho começando com "/" e sem espaços.' },
          );
        },
      ),
    ],
  });
}
