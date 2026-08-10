# Preview — Transparência + Controle (Fundação)

Título: Preview — Transparência + Controle · Categoria: features · Data: 2026-08-10 · Status: **Concluído (Fundação)**

Continuação de [Preview confiável](preview-confiavel.md). Aquele doc entregou o preview automático no fim das Verificações; este ataca a **experiência quando o preview falha** — o usuário não via o erro real e não tinha como reiniciar.

## Problema

Na etapa "Seu teste", uma rota (`/backoffice`) quebrou por variável de ambiente faltando. O usuário não conseguiu entender por quê, pediu conserto, o agente disse que resolveu mas a rota seguia quebrada, e ao perguntar a porta o agente (corretamente) recusou subir o server. Investigação (3 exploradores) achou 5 causas — 2 tratadas aqui, 3 adiadas:

1. **Caixa preta.** O backend já sabia o erro real (status HTTP + rota + trecho do corpo em `PreviewQuebradoError.detalhe`) e **enviava o `detalhe`** no `/preview/start`, mas o front **ignorava** e mostrava só a frase genérica. E os **logs do dev server nunca eram guardados** (só as últimas 100 linhas durante a subida, descartadas após "ready"). — **Resolvido.**
2. Agente não verifica o conserto (preview derrubado, rota fora do health-check). — *Fase 2.*
3. Consertar uma rota derruba o preview (`runPreviewCheck` → `stopPreview`). — *Fase 2.*
4. A rota quebrada nunca entrou no health-check (só as da receita). — *Fase 2.*
5. **Sem controle.** Não havia botão de reiniciar preview (o backend tinha `/preview/stop`, o front nunca chamava). — **Resolvido.**

Princípio mantido: quem sobe o server é o Inhouse (correto). O que faltava era transparência e controle.

## O que foi feito (Fundação)

### Backend
- `server/services/preview.ts`: **buffer de logs por tarefa** (`Map<taskId, string[]>`, teto de 500 linhas) que **sobrevive ao "ready" e a um crash**. Listener persistente anexado logo após o `spawn`, separado do `olhar` (que só detecta ready). Novo export `previewLogs(taskId)`. Buffer resetado a cada `attemptStart` da tarefa e limpo em `stopAllPreviews`; preservado no `stopPreview`/auto-exit para diagnóstico. Modo fake devolve `""`.
- `server/api/routes.ts`: novo `GET /api/tasks/:id/preview/logs` → `{ logs }`. O catch do `/preview/start` agora inclui também `status` e `rota` do `PreviewQuebradoError` (antes só `detalhe`).

### Frontend (`public/app.js` + `public/styles.css`, UI v0.23.0)
- Estado de erro do preview mostra o **erro técnico real** (`HTTP {status} em {rota}` + `detalhe`) num `<pre class="preview-detalhe">`, além da frase amigável. Handlers `start-preview`/`configure-preview` passam a capturar `detalhe`/`status`/`rota`.
- Botão **"Reiniciar preview"** (handler `restart-preview`: `POST /preview/stop` → `POST /preview/start`) na barra do preview ao vivo.
- Visualizador **"Logs"** (`toggle-preview-logs`/`refresh-preview-logs`): busca `GET /preview/logs` e mostra num `<pre>` próprio, alternado por **DOM direto** — nunca reconstrói o pane, então o iframe (o app rodando) **não recarrega** ao abrir/atualizar os logs.

### Fora do escopo (Fase 2)
Manter o preview vivo no conserto; loop de conserto contra o preview ao vivo sem re-rodar as verificações; adicionar a rota reportada ao `healthPaths`; descoberta de sub-rotas antes do "Seu teste". Nada de `machine.ts` nesta fase.

## Verificação
- `npm run typecheck` limpo; `npm run test` **227/227** (novo teste: `previewLogs` captura o stdout do dev server e sobrevive ao stop).
- Server reiniciado na 4400; `GET /preview/logs` responde `{logs:""}` (200) para tarefa sem preview e 404 para inexistente.
