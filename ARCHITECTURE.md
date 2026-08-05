# Inhouse — Arquitetura

**O que é**: app builder local da Inhouse (conductor + lovable). Servidor Node/TS local + UI web
(vanilla JS, sem build step). Fala com o Claude através do **Claude Code genuíno da máquina**
(`~/.local/bin/claude`, login/subscription de cada usuário) via **Agent SDK** com
`pathToClaudeCodeExecutable` — nunca API key.

## Decisões travadas (não renegociar sem motivo forte)

1. **Sem API key.** `env` passado ao SDK SEMPRE remove `ANTHROPIC_API_KEY` e `ANTHROPIC_AUTH_TOKEN`
   (padrão vibe-kanban). Auth vem do login do CLI (Keychain/~/.claude).
2. **Agent SDK, não spawn manual.** O CLI local é 2.1.222 e NÃO tem `--permission-prompt-tool`;
   o SDK cuida do protocolo de controle. `canUseTool` → fluxo de aprovação da UI.
   A API exata do SDK deve ser lida de `node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`
   (fonte de verdade, não memória).
3. **`settingSources: ["project"]`** — carrega CLAUDE.md/settings do projeto (regras Inhouse),
   mas NÃO as configs pessoais do usuário (hooks gstack etc. não podem vazar pra cá).
4. **Worktrees = "espaços"**: `git worktree add` em `~/Inhouse/.espacos/<proj>/espaco-N`,
   branch `tarefa/<slug>`. A palavra "worktree/branch" nunca aparece na UI.
5. **Sem DB**: estado em `~/.inhouse/state.json` (escrita atômica: tmp+rename).
   Transcript por tarefa em `~/.inhouse/transcripts/<taskId>.jsonl`.
6. **SSE, não WebSocket.** Um stream global `/api/events` (heartbeat 25s).
7. **UI sem framework**: `public/index.html + styles.css + app.js` (ES modules).
   O visual segue o mockup aprovado (paleta verde, esteira com losangos âmbar).
8. Servidor escuta **só em 127.0.0.1** (porta 4400). Previews em portas 4500+.

## Esteira (máquina de estados por tarefa)

espec → plano → aprovacao(H) → execucao → verificacoes → teste(H) → publicar(H) → concluida

- **espec** (auto, barato): 1 chamada, maxTurns baixo, tools read-only; estrutura o pedido em
  spec curta (markdown). Falhou? segue com description crua (espec é best-effort).
- **plano** (auto): permissionMode "plan"; captura o plano (input do ExitPlanMode se houver;
  senão o texto final). Salva `task.plan`, sessão fica em `task.claudeSessionId`.
- **aprovacao** (humano): approve_plan → execucao. request_changes{msg} → roda plano de novo
  com o feedback (resume da sessão).
- **execucao** (auto): resume da sessão com permissionMode "acceptEdits", cwd = worktree.
  Edits são auto-aceitos; Bash/instalações/etc caem no `canUseTool` → PermissionRequest na UI
  (task fica status "aguardando" até decisão; timeout 30min → nega).
  Mensagens de steering (POST /message) entram na fila e são enviadas na mesma sessão.
- **verificacoes** (auto): roda gates detectados no worktree, nesta ordem de detecção:
  scripts do package.json (`typecheck`, `lint`, `test`) e, se não houver typecheck mas houver
  tsconfig.json, `npx tsc --noEmit`. Gate que não existe é pulado (não é falha).
  Falhou → até 2 rodadas de auto-correção (resume com os erros) → re-roda gates.
  Ainda falhou → status "falhou" com botão retry.
- **teste** (humano): usuário abre preview e aprova (approve_test) ou request_changes{msg}
  (volta pra execucao com a mensagem).
- **publicar** (humano): merge da branch no main (git merge --no-ff no checkout principal).
  Se projeto tem originUrl e `gh` autenticado e createPr=true: push + `gh pr create`.
  Depois: remove worktree, task → concluida.
- **cancel** em qualquer ponto: encerra sessão claude, mantém worktree pra inspeção.

## Módulos e donos (para os agentes de construção)

- `server/claude/runner.ts` — wrapper do Agent SDK: `runPhase(opts)` que abre/resume sessão,
  emite chat_delta/transcript, devolve {sessionId, finalText, planText?}. Dono: Agente A.
- `server/claude/permissions.ts` — ponte canUseTool ↔ PermissionRequest/decisão. Dono: A.
- `server/services/projects.ts` (clone/template/open + git helpers), `worktrees.ts`,
  `templates.ts`, `gates.ts`, `preview.ts`, `publish.ts`. Dono: Agente B.
- `server/workflow/machine.ts` + `phases.ts` — orquestra a esteira usando A+B. Dono: Agente C.
- `server/api/routes.ts` + `server/index.ts` + `server/store.ts` + `server/events.ts`
  + `server/config.ts`. Dono: Agente C.
- `public/` — UI. Dono: Agente D.
- `templates/app-starter/` — template embutido (Vite+React+TS + CLAUDE.md Inhouse). Dono: B.
- `test/` — mock do claude + testes de máquina de estados/gates/store. Dono: Agente E.

## Referências locais (padrões já validados — LER antes de implementar)

- SDK instalado: `node_modules/@anthropic-ai/claude-agent-sdk/` (tipos .d.ts = contrato real)
- Aprovação humana no loop (conceito): scratchpad `avaliacao/cui/src/services/permission-tracker.ts`
- stream events → UI: `avaliacao/claude-agent-ui/src/server/agent-session.ts` e `sse.ts`
- Subscription/env: `avaliacao/vibe-kanban/crates/executors/src/executors/claude.rs` (env_remove)
- Preview por porta: `avaliacao/vibe-kanban/crates/preview-proxy/` (conceito; v1 aqui é iframe direto)
- Scratchpad: /private/tmp/claude-501/-Users-pablovinicius-code/dfb6097b-31d2-438b-9016-ea883c5f7337/scratchpad
