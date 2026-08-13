# Preview 10x — o agente enxerga e pilota o preview

- **Categoria:** features
- **Data:** 2026-08-13
- **Status:** Em andamento
- Absorve a "Fase 2" pendente de [Preview — Transparência + Controle](preview-transparencia-controle.md).

## Contexto

A etapa de preview é a maior fonte de atrito do Inhouse. A experiência de referência é o Claude Code no terminal: "Rode a aplicação e deixe tudo funcionando" — o agente descobre como subir, roda seed/migrations e valida. No Inhouse o preview é mecânico e o agente é cego para ele.

Diagnóstico confirmado no código (3 exploradores + leitura direta):

- **P1 — Agente cego.** O único prompt que recebe a URL do preview é `previewExercisePrompt` (`server/workflow/phases.ts:335`), uma vez. O caminho mais usado — "conserta isso" no Seu teste → `changesPrompt` (`phases.ts:240`) — não tem URL, porta, status, logs nem o erro. O agente é proibido de subir servidor mas não sabe onde está o que existe: precisa adivinhar erro, rota e porta.
- **P2 — Agente sem controle.** Nenhuma ferramenta para acionar o preview gerenciado (subir/reiniciar/ler logs). Por isso nasce a "segunda porta".
- **P3 — Crash silencioso.** `child.on("exit")` (`server/services/preview.ts:499`) só limpa `previewUrl`; sem evento dedicado, sem mensagem no chat, sem conserto. O iframe "some" sem explicação.
- **P4 — Conserto derruba tudo.** Mudança de código no teste re-roda todas as verificações e derruba/re-sobe o preview (`machine.ts:775`); o agente não verifica o próprio conserto contra o preview vivo (pendência conhecida de `docs/plans/features/preview-transparencia-controle.md`).
- **P5 — UI técnica demais.** URL editável + Recarregar + Reiniciar + Logs + Abrir no navegador; "Logs do dev server"; dot decorativa; o card do teste diz "Abra o preview ao lado" mesmo com preview morto (`public/app.js:2000`).
- **P6–P9.** Logs resetados a cada start (apagam a evidência do crash, `preview.ts:437`); mensagens de chat descartadas silenciosamente fora do step execução (`machine.ts:1433`, `if` sem `else`); nenhum system prompt (regras duplicadas/inconsistentes entre fases); conserto no teste usa o gate genérico em vez do `createPreviewSetupGate` (cada curl vira porteira HITL).

## Decisões de produto (tomadas pelo Marlon)

1. **Agente pilota o preview** — ferramentas próprias via MCP in-process do SDK + estado do preview nos prompts. Regra de ouro mantida: quem SOBE o servidor é o Inhouse (porta única); o agente comanda.
2. **UI radicalmente simples** — status claro + uma ação primária por estado; controles técnicos numa view avançada opcional.
3. **Conserto automático** — preview quebrou (crash/5xx) → erro+logs vão direto ao agente, que conserta sozinho; usuário só é chamado se ele não conseguir.
4. **QA continua curl por rota** (sem browser headless nesta fase).

Verificado no SDK instalado (`@anthropic-ai/claude-agent-sdk` v0.3.222): `createSdkMcpServer` + `tool()` (zod raw shape), `systemPrompt: {type:'preset', preset:'claude_code', append}`, `mcpServers` nas Options. zod 4.4.3 já está em node_modules (dep do SDK) — **adicionar `"zod"` como dependência explícita** no package.json.

---

## Contratos novos (shared/types.ts)

```ts
export type PreviewStatus = "parado" | "preparando" | "no_ar" | "consertando" | "problema" | "sem_tela";

// Task ganha (previewUrl PERMANECE como espelho de preview.url — compat UI/testes):
preview?: {
  status: PreviewStatus;
  url?: string;            // só quando no_ar
  porta?: number;          // porta REAL, parseada da URL do stdout (resolve divergência porta-reservada×URL)
  tentativa?: number;      // conserto automático: 1..2
  erro?: { msg: string; detalhe?: string; status?: number; rota?: string; podeConfigurar?: boolean };
  desde?: string;          // ISO
};
previewFixRounds?: number; // cap do conserto automático (zera em pousarTeste)

// ServerEvent ganha (preview_ready CONTINUA emitido — compat):
| { type: "preview_status"; taskId: string; preview: NonNullable<Task["preview"]> }

// TaskAction ganha (trava _travaAcoes obriga TASK_ACTIONS + union juntos):
| { action: "fix_preview"; rota?: string; descricao?: string }
```

Endpoint novo: `POST /api/tasks/:id/preview/restart → { url }` (reinício atômico server-side; a UI para de fazer stop→start em duas chamadas).

---

## Fase 1 — O agente enxerga e comanda (P1, P2, P9)

Maior ROI: sozinha elimina o "porta diferente" e os becos sem saída.

**1a. Ferramentas MCP in-process — novo `server/claude/previewMcp.ts`**

`createPreviewMcp(taskId, opts?: { permitirReiniciar?: boolean })` → `createSdkMcpServer({ name: "inhouse", instructions: <1 parágrafo pt-BR reafirmando a regra de ouro>, tools })`. Descrições em pt-BR. 4 tools (prefixo final `mcp__inhouse__*`):

| Tool | Input | Devolve | Chama |
|---|---|---|---|
| `preview_status` | `{}` | `{ status, url?, porta?, healthPaths, aviso }` — `aviso`: "Esta é a fonte da verdade AGORA — ignore URLs/portas de mensagens anteriores." | novo `previewStatus(taskId)` (registry :24 + task.previewUrl; porta via `new URL().port`; fake-aware) |
| `preview_logs` | `{ linhas?: number }` (default 100, max 500) | `{ logs }` (tail) | `previewLogs(taskId)` (preview.ts:51) |
| `preview_reiniciar` | `{ motivo?: string }` | `{ ok, url?, porta?, aviso? }` | novo `restartPreview(taskId)` (ver Fase 2; na Fase 1 pode ser stop→start serializado) |
| `preview_reportar_rota` | `{ rota, motivo? }` | `{ ok }` | novo `adicionarHealthPath(projectId, rota)` — merge sanitizado na receita aprendida (fecha a pendência "rota quebrada nunca entra no healthPaths") |

Semântica do reinício: serializado por task (encadeia com start `emAndamento` — se já está subindo, espera e devolve a URL com aviso, sem stop); tenta a MESMA porta anterior (preserva o iframe/anti-reload). Com `permitirReiniciar: false` (fases mecânicas do `runPreviewCheck` e `configurarPreviewComAgente`), recusa com texto instrutivo: "O Inhouse está verificando o preview agora — use preview_status."

**1b. Runner (`server/claude/runner.ts`)** — `RunPhaseOpts` += `mcpServers?: Options["mcpServers"]` e `systemPromptAppend?: string` (passthrough puro; `undefined` = comportamento atual → juiz/gerar/fake intocados). `options` ganha `mcpServers` e `systemPrompt: {type:'preset', preset:'claude_code', append}` quando presentes. `toolItem` (:163): labels pt-BR dedicados — "Consultar o preview", "Ler o registro do preview" (op `?`), "Reiniciar o preview" (op `$`), "Registrar uma tela importante".

**1c. Permissões (`server/claude/permissions.ts`)** — tools `mcp__inhouse__*` são seguras por construção: auto-allow no topo de `createPermissionGate` (status/logs silencioso; reiniciar registra linha `sistema` no chat + `registrarPermissao` desfecho "auto"). Refatorar `createPreviewSetupGate(taskId, base?: CanUseTool)` (default `createPermissionGate(taskId)` — retrocompatível).

**1d. Quem recebe o MCP** (via `mcpServers: { inhouse: createPreviewMcp(taskId, …) }` no `runPhase`): `runExecucao` (inclui conserto do teste), `runGateFix`, as duas `faseAgente` do `runPreviewCheck` (reiniciar OFF), `configurarPreviewComAgente` (reiniciar OFF), `runLivre`, `rodarSkillGates`. **Não recebem**: espec/plano/detalhamento/prototipo (read-only) e juiz/gerar (`semTranscript`).

**1e. System prompt + contexto** — nova `systemAppend(task)` em phases.ts: identidade Inhouse + `CONTEXTO_NAO_TECNICO` + `PREVIEW_GERENCIADO` v2 (menciona as tools: "para saber URL/porta use preview_status; para reiniciar após mudar .env use preview_reiniciar; NUNCA rode npm run dev — será bloqueado") + bloco curto `[ESTADO]` (título da tarefa, etapa, preview no ar/parado com URL e porta, derivado de registry+previewUrl na Fase 1). Passada nas mesmas fases do MCP. Os blocos duplicados saem dos prompts dessas fases (espec/plano/prototipo mantêm inline como hoje). Marcadores do fakeModel ("PREPARAR este projeto", "verificações automáticas", VEREDITO/CONSERTO/PREPARADO) preservados.

**1f. Gate certo + contexto no conserto do teste** — em `machine.ts:1184/:1193`, o `runExecucao` do request_changes passa `canUseTool: createPreviewSetupGate(taskId, gateComStatus(taskId))` (curl localhost deixa de virar porteira) e `changesPrompt(msg, ctx?)` ganha linha de preview ("O preview segue no ar em {url} — confira sua mudança com curl antes de devolver") + últimas ~40 linhas de log **apenas quando status = problema**.

**Pronto quando:** no Seu teste, "confere por que a página X está estranha" → agente consulta `preview_status`, usa a porta certa, lê logs, conserta, reinicia via tool se preciso — sem porteira para curl localhost e sem tentar `npm run dev`. `npm run typecheck` + `npm test` verdes.

---

## Fase 2 — Estado de primeira classe, crash visível, conserto automático (P3, P4, P6, P7)

**2a. `setPreviewInfo(taskId, patch)` em preview.ts** — helper central: atualiza `task.preview` (+ espelho `previewUrl`), persiste no store, `broadcast preview_status` + `task_updated`. Todas as transições passam por ele: `attemptStart` início → `preparando`; URL + saúde ok → `no_ar` (porta real da URL; se divergir da reservada, a URL vence e a divergência vai para o log buffer); crash → `problema` (ou `consertando` se o auto-conserto vai agir); `stopPreview` → `parado`; `PreviewIndisponivelError`/`temUi` falso → `sem_tela`.

**2b. Logs sobrevivem (P6)** — `attemptStart` deixa de zerar o buffer: anexa separador `— reinício do preview (hh:mm) —` quando já existe. `POST /preview/restart` (routes.ts, junto de :489) faz o ciclo atômico e preserva logs.

**2c. Crash vira evento + conserto automático** — em preview.ts, `previewEvents` (EventEmitter exportado; evita import circular) emite `crash {taskId, logsTail}` no exit inesperado + linha `sistema()` no chat. machine.ts se inscreve e chama **`runConsertoPreview(taskId, causa {origem: "crash"|"saude"|"usuario", detalhe, rota?})`**:

- **Guardas (todas):** task em `teste`/`publicar`/modo livre com `status "aguardando"` (fase rodando → o crash só entra no `[ESTADO]` do próximo prompt); `previewFixRounds < 2` (persistido, zera em `pousarTeste`); debounce 60s. Reprovado nas guardas → `status: problema` + mensagem: "O preview caiu e não vou tentar de novo sozinho — veja o Registro na visão avançada ou peça o conserto."
- **Fluxo:** `sistema("O preview apresentou um problema — vou tentar consertar sozinho… (tentativa {n} de 2)")` → `status: consertando` → fase do agente com novo `consertoPreviewPrompt(causa, logsTail ~80 linhas)` (contrato `CONSERTO: feito|impossivel`, reusa `parseConserto`; gate `createPreviewSetupGate` + MCP com reiniciar ON + `acceptEdits` + resume + `maxTurns: 30`) → se o processo morreu, `restartPreview` → `verificarSaude` em `healthPaths ∪ causa.rota` → sucesso: `sistema("Pronto — o preview voltou ao ar.")`, volta `aguardando`; falha/impossivel: `status: problema` + fallback humano (sem `fail()` — a task segue testável).
- **Rota do usuário** (`fix_preview {rota}`) entra na receita via `adicionarHealthPath`.

**2d. `fix_preview` em `applyAction`** — mesmo fluxo, origem "usuario" (botão da UI); válido em teste/livre.

**2e. Verificação leve (P4)** — `runExecucao` ganha opção `verificacaoLeve` (usada no request_changes do teste): com `filesTouched`, em vez de `runVerificacoes` completo → (a) `runGates` do projeto (baratos); (b) passando, `verificarSaude` no preview **vivo** (sem stop/start); (c) ok → `pousarTeste`. Saúde reprovada → 1 `restartPreview` + re-check → ainda ruim → `runConsertoPreview(origem "saude")`. Gates reprovando → `runVerificacoes` completo (aí se justifica). `pularVerificacaoSemEdicao` intocado.

**2f. Steer honesto (P7, correção lite)** — no ramo da esteira que hoje descarta (`machine.ts:1433`): **sempre enfileirar** + `sistema("Recebi — levo em conta no próximo passo em que o Claude trabalhar. Para mudar plano/protótipo agora, use 'Pedir mudanças'.")`. Fase de conserto e `faseAgente` do preview passam a drenar a fila (padrão `drainSteer` existente).

**2g. Reconciliação no boot** — em `server/index.ts` após `load()`: todo `task.preview`/`previewUrl` persistido é órfão (registry nasce vazio) → limpar para `parado` + emitir `preview_status`. (Sem matar processo por pid — risco de pid reuse; `portaLivre` já desvia de órfãos.)

**2h. README no boot do agente** — `previewSetupPrompt` e `preparacaoPrompt` ganham a instrução: "Antes de decidir, LEIA o README.md e docs de setup (docs/, .env.example, scripts do package.json) — é onde costuma estar como subir, migrar e popular o banco."

**Pronto quando:** matar o dev server na mão durante o Seu teste → chat narra a queda, agente conserta, preview volta sozinho; 3º crash em sequência → para e explica; logs do crash visíveis após reinício; "muda o texto do botão" no teste volta em ~1 min sem derrubar o iframe. Testes verdes.

---

## Fase 3 — UI radicalmente simples com view avançada (P5)

**3a. Máquina de estados no painel** — reescrever `updatePreview` (app.js:2103) sobre `t.preview?.status` (fallback: derivar dos sinais legados se ausente). Copy/ação primária por estado:

| Status | Dot | Rótulo | Ação primária |
|---|---|---|---|
| antes do teste | cinza | "Antes do teste" | — ("O preview abre na etapa Seu teste") |
| preparando | âmbar pulsando | "Preparando…" | — ("O Claude está deixando o app pronto. Acompanhe no chat.") |
| no_ar | verde | "No ar" | **Abrir no navegador** |
| consertando | âmbar pulsando | "Consertando…" | — (overlay sobre o iframe: "O app teve um problema — o Claude já está consertando (tentativa {n} de 2). Você não precisa fazer nada.") |
| problema | vermelha | "Com problema" | **Pedir para o Claude consertar** (`fix_preview`); se `podeConfigurar`: "Pedir para o Claude preparar o preview" |
| parado | cinza | "Desligado" | **Ligar preview** |
| sem_tela | cinza | "Sem tela" | — ("Este projeto não tem tela para mostrar — teste pedindo verificações no chat.") |

- View simples (default): dot + rótulo + ação primária + botão ghost "Detalhes". Rodapé: "O Inhouse cuida deste preview para você."
- View avançada (toggle persistido em `localStorage["inhouse.previewAvancado"]` — preferência da pessoa, não da task): URL navegável + chip `porta {n}` + "Recarregar página" (tooltip "atualiza só a tela, como F5") + "Reiniciar app" (tooltip "desliga e liga o app — use se ele travou"; chama `POST /preview/restart`) + "Registro" (ex-Logs; cabeçalho "Registro do app (técnico) — é isto que o Claude lê quando conserta") + "Abrir no navegador" + "Simplificar".
- Preservar shell estável e anti-reload: `dataset.key` vira `status|url|avancado|logsOpen` (tentativa do conserto atualiza o overlay por DOM direto, fora da key); reload único do iframe na transição consertando→no_ar.

**3b. Coerência chat↔preview** — `testCardHtml` (app.js:2000) condicionado ao status (ex.: consertando → "O Claude já está consertando — assim que voltar, você testa" com Aprovar desabilitado); novo `previewProblemaCardHtml` no chat quando `problema` (botão único "Pedir para o Claude consertar"); handler SSE `preview_status` (junto de :426). Mensagens de sistema do servidor cobrem subiu/caiu/consertou (já persistem no transcript).

**3c. Toasts** — regra: toast = fora do campo de visão; card/painel = decida aqui. `problema` com usuário em outra tela → toast "O preview de '{título}' quebrou — o Claude não conseguiu consertar sozinho." Falha de rede nos fetches de preview → toast (hoje é silencioso).

**3d. Rótulos** — "Logs do dev server" → "Registro do app (técnico)"; "Pedir ao Claude para configurar o preview" → "Pedir para o Claude preparar o preview"; placeholders de erro/urls muted substituídos pelos rótulos de status.

**Pronto quando:** pessoa não-técnica entende o estado sem explicação; zero jargão fora da view avançada; iframe não recarrega ao abrir Registro/Detalhes.

---

## O que NÃO fazer agora

- **Proxy reverso do preview** (detectar 5xx de navegação no iframe) — infra inteira para um sinal que crash-handler + curl do agente cobrem.
- **Streaming de logs por SSE** — agente puxa via tool, UI via polling existente.
- **Matar processos órfãos por pid no boot** — risco de pid reuse; `portaLivre` já desvia.
- **Correção estrutural completa do steer** (fila por fase) — a versão "enfileirar + avisar" resolve a mentira silenciosa; o resto é outro plano.
- **Tool de escrever receita além de `adicionarHealthPath`** — `aprenderReceita` já cobre; não ampliar superfície.
- **Browser headless no QA** — decisão 4 explícita.

## Riscos → mitigação

| Risco | Mitigação |
|---|---|
| Agente reinicia preview durante o ciclo mecânico do `runPreviewCheck` | `permitirReiniciar: false` nessas fases + serialização por task; recusa textual instrutiva |
| Loop de conserto queimando tokens | cap 2 persistido + debounce 60s + só em `aguardando` + `maxTurns: 30` + `CONSERTO: impossivel` encerra cedo |
| Tool em fase read-only | MCP só injetado nas fases listadas; espec já tem `disallowedTools`; juiz/gerar sem MCP |
| Sessão resumida "sabe" URL antiga | tripla defesa: limpeza no boot + `aviso` do `preview_status` + `[ESTADO]` re-injetado a cada fase |
| Quebrar fake mode / 227+ testes | fake curto-circuita antes das Options (runner.ts:175) e antes do spawn (preview.ts:344/378); toda mudança de assinatura é opcional/aditiva; `previewUrl` mantido como espelho; mock de preview em `machine.test.ts:150` ganha os exports novos |
| Import circular preview↔machine | `previewEvents` (EventEmitter) em preview.ts; machine se inscreve |
| Restart troca a porta e mata o iframe | `restartPreview` força a mesma porta quando livre |
| zod sumir num npm install futuro | adicionar `"zod": "^4.0.0"` como dep explícita |

## Testes novos essenciais (~12)

1. `previewMcp.test.ts` (novo): contratos de status/logs (porta derivada certa, tail); reiniciar recusa com `permitirReiniciar: false`; no fake é no-op seguro.
2. `permissions.test.ts`: `mcp__inhouse__*` auto-aprovado; `ehServidorDev` segue negando; `createPreviewSetupGate(taskId, base)` delega ao base.
3. `runner.test.ts`: `mcpServers`/`systemPromptAppend` chegam às Options; `toolItem` rotula `mcp__inhouse__*` em pt-BR.
4. `preview.test.ts`: crash emite `preview_status problema` e preserva buffer (separador no restart); restart com start em andamento reusa a promise; porta da URL ≠ reservada → `preview.porta` = URL; reconciliação no boot limpa órfãos.
5. `machine.test.ts`: request_changes no teste → prompt com contexto de preview + gate de preview (curl não vira porteira); caminho leve (gates rodam, `stopPreview` NÃO, volta ao teste); crash em teste/aguardando dispara 1 conserto e cap 2 + debounce → fallback; `fix_preview {rota}` entra nos healthPaths; steer fora da execução enfileira + avisa.
6. `ui-static.test.ts`: novos textos/`data-act` no padrão do arquivo.

## Verificação end-to-end

1. `npm run typecheck` e `npm test` verdes após cada fase.
2. `npm run dev:fake` + `npm run debug` (journeys) — esteira completa intacta.
3. Real (app de teste em `~/Inhouse`): criar task com UI até o Seu teste → (a) pedir "confere a tela X" e observar `preview_status`/curl na porta certa no transcript; (b) `kill` no processo do dev server → narração no chat + conserto automático + preview de volta; (c) 3 kills seguidos → fallback humano com card no chat; (d) alternar Detalhes/Simplificar sem reload do iframe; (e) "Reiniciar app" preserva o Registro (separador visível).
4. Modo livre: "roda a aplicação e deixa tudo funcionando" → agente usa as tools, nada de segunda porta.

## Revisão pós-implementação (2026-08-13)

Revisão adversarial (4 dimensões + verificadores céticos) encontrou e as correções foram aplicadas:

1. **(alta)** Auto-allow de `mcp__inhouse__*` confiava no prefixo e o runner não usava `strictMcpConfig` — um `.mcp.json` commitado no projeto podia registrar um servidor "inhouse" e furar a porteira. → `strictMcpConfig: true` no runner (só os MCP injetados pelo Inhouse carregam; nota: settings de MCP de projeto/usuário deixam de carregar nas fases) + auto-allow por **lista exata** de nomes.
2. **(alta)** A transição `consertando` apagava a URL de um preview vivo (fix_preview com server no ar deixava o agente cego). → preserva `url`/`porta` na transição.
3. **(média)** `previewFixRounds` nunca rearmava — 2 falhas antigas desligavam o conserto automático para sempre. → ciclo de verificação saudável (runPreviewCheck / verificação leve) zera o contador.
4. **(média)** App que serve `/` e morre segundos depois virava loop de conserto de 30 turnos a cada 60s. → janela de custo: máx. 3 disparos automáticos por 15 min, mesmo com "sucesso".
5. **(média)** `restartPreview` não esperava a porta liberar (kill assíncrono) → porta quase sempre mudava. → espera ativa de até 5s pela porta anterior.
6. **(média)** Rota reportada era ignorada em projeto com config commitada. → `healthPaths` efetivo = união (config ∪ receita).
7. **(baixas)** Conserto drenava o steering (mensagem podia se perder) → não drena mais; `preview_reiniciar` anunciava sucesso antes de tentar → mensagem só após o desfecho; título da task entrava sem sanitização no system prompt → uma linha, truncado.

## Arquivos críticos

- `server/services/preview.ts` — setPreviewInfo, restartPreview, previewStatus, adicionarHealthPath, previewEvents, logs com separador, reconciliação
- `server/claude/previewMcp.ts` (novo) — 4 tools MCP
- `server/claude/runner.ts` — mcpServers/systemPromptAppend + labels pt-BR
- `server/claude/permissions.ts` — auto-allow `mcp__inhouse__*`, `createPreviewSetupGate(taskId, base?)`
- `server/workflow/phases.ts` — systemAppend, PREVIEW_GERENCIADO v2, changesPrompt(msg, ctx?), consertoPreviewPrompt, README no setup/preparação
- `server/workflow/machine.ts` — runConsertoPreview, verificacaoLeve, fix_preview, steer honesto, wiring do MCP/append
- `shared/types.ts` — Task.preview, preview_status, fix_preview
- `server/api/routes.ts` — POST /preview/restart
- `server/index.ts` — reconciliação no boot
- `public/app.js` + `public/styles.css` — máquina de estados do painel, view simples/avançada, coerência chat, toasts
- `package.json` — dep explícita `zod`
