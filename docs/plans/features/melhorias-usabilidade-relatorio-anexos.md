# Melhorias de usabilidade: relatório, caixa de texto, pausar, anexos e artefatos

- **Categoria:** features
- **Data:** 2026-08-07
- **Status:** Em andamento

Cinco pedidos do usuário, cada um com causa/estratégia própria.

## 1. Botão "Gerar análise" não funciona (bug)

**Causa raiz (confirmada nos logs):** `gerarRelatorio` (server/eval/juiz.ts) chama `runPhase` com
`taskId: "eval-relatorio-<ISO>"`. O ISO tem `:` e `.`; quando o juiz produz texto, o runner chama
`transcriptAppend`, que valida `^[A-Za-z0-9_-]{1,128}$` (anti path-traversal em store.ts) e **lança**
`taskId inválido para transcript`, derrubando a fase inteira → `success:false` → evento de erro.
`acumularFase` já faz `getTask()` e retorna cedo para id fake, então **não há duplicação de custo**.

**Fix:** o juiz é uma análise de fundo, sem tarefa — não deve escrever transcript. Adicionar
`semTranscript?: boolean` a `RunPhaseOpts`; quando ligado, o runner pula `transcriptAppend` e os
broadcasts de `transcript`/`chat_delta`. `juiz.ts` passa `semTranscript: true`. (Belt-and-suspenders:
sanitizar o taskId do juiz.)

## 2. Caixa de texto pequena e sem quebra de linha (Tarefas)

`#new-task-desc` (e o `#composer-input` do editor) são `<input>` de uma linha. Converter ambos para
`<textarea>` auto-crescente: **Enter envia, Shift+Enter quebra linha**. Ajustar `renderPage` para
preservar valor/foco de `textarea[id]` (hoje só `input[id]`) — o quadro re-renderiza a cada evento SSE.

## 3. Não dá para interromper um passo em execução (pausar)

Já existe `abortPhase(taskId)` (AbortController) e o padrão do teto de 1h (`pausadaPorTempo`):
abortar → aterrissar em estado retomável → `retry` continua a sessão (`claudeSessionId`).

**Fix:** espelhar esse padrão para pausa manual. Novo `Task.pausadaManual`, nova ação `pause`.
Set `pausaManual` no machine + `abortPhase`; o abort chega em `failOuPausa`, que aterrissa
`status:"falhou" + pausadaManual` (sem `registrarFalha`, igual ao timeout). `retry` retoma de onde
parou. Enquanto pausado numa execução, o compositor fica habilitado para escrever um ajuste antes de
retomar (steer enfileira). UI: botão "Pausar" quando `status==="rodando"`; cartão "Pausado".

## 4. Anexar arquivos (imagem, pdf, etc.) ao prompt

**Storage:** `DATA_DIR/anexos/<uploadId>/<arquivo>` (fora do worktree — não vaza pro PR).
**Upload:** `POST /api/anexos` (parser dedicado 30mb, antes do parser global de 1mb, igual
`/api/eval/import`), recebe `{files:[{nome,tipo,dataBase64}]}` e devolve `{anexos:[{nome,tipo,path}]}`.
`POST /api/tasks` e `POST /api/tasks/:id/message` ganham `anexos?` (só metadados/paths, JSON pequeno).
**Guarda:** todo path precisa resolver dentro de `ANEXOS_DIR` (anti leitura de arquivo arbitrário).
**Como chega ao Claude:** o Read do Claude Code lê imagem/pdf/qualquer arquivo por caminho absoluto.
`anexosBloco(task)` injeta a lista de caminhos + instrução de ler nos prompts de espec/plano/execução;
no steer, anexa os caminhos à mensagem enfileirada. UI: clipe + input file + chips (com remover) +
drag-drop na caixa de nova tarefa e no compositor.

## 5. Artefatos (docs e protótipos) sempre acessíveis

Hoje o protótipo só aparece na porteira `aprovacao_prototipo`; a espec/plano só nos cartões da fase.
**Fix:** barra "Artefatos" fixa no editor — Espec e Plano (do próprio objeto Task, abrem em modal),
Protótipo (novo `Task.temPrototipo`, abre `/api/tasks/:id/mockup/`), e "Documentos" via
`GET /api/tasks/:id/artefatos` (+ `/artefatos/doc?rel=` para ler), com guardas de path.

### 5.1 Iteração de design (2026-08-07): barra enxuta + escopo por tarefa

A 1ª versão da barra listava **todos** os `.md` de `docs/plans/` como chips — num repo real
(leapy-2) isso vira dezenas de planos antigos do time e a barra quebra em 4-5 linhas (poluição).
Depois de gerar protótipos HTML/CSS pro Marlon escolher (2 artifacts), decisão: **sabor 1 + (b)**.

- **Barra enxuta (uma linha):** só **Espec, Plano e Protótipo** (os artefatos da esteira) ficam
  visíveis como chips. `.artefatos-bar` vira `flex-wrap:nowrap`.
- **Documentos escondidos:** botão **"Documentos · N"** (rótulo + contagem) abre um dropdown
  (`.docs-pop`) com lista rolável e **filtro por nome** (só quando > 8). Fecha ao clicar fora / trocar
  de rota. Cada item abre no mesmo modal de leitura.
- **Escopo por tarefa (b):** `GET /api/tasks/:id/artefatos` deixa de varrer o `docs/plans` inteiro e
  passa a listar só os `.md` sob `docs/` que **a tarefa criou/alterou** vs a branch base — via
  `merge-base(defaultBranch, HEAD)` + `git diff --diff-filter=AM` (rastreados) ∪ `git ls-files
  --others` (novos ainda não commitados; o agente escreve sem commitar), excluindo os `mockups/`.
  `rel` passa a ser relativo à raiz do espaço; o leitor de doc resolve sob o worktree (guarda de path).
  No leapy-2 real isso derruba a contagem de ~34 (todo o repo) para tipicamente 0-3 (só o da tarefa).

## Verificação

`tsc --noEmit` + `vitest run` (novos testes: pause na máquina, guarda de path dos anexos, endpoint de
artefatos; regressão do juiz sem transcript). Reiniciar o daemon (backend sem hot-reload) e rodar `/qa`.
