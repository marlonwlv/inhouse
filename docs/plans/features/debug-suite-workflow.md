# Debug Suite da Esteira

- **Categoria:** features
- **Data:** 2026-08-06
- **Status:** Concluído

> Implementado e verificado (2026-08-06): `npm run typecheck` limpo, 159 testes verdes
> (incluindo `test/debug-fakeModel.test.ts`), `npm run debug` com 13/13 cenários stub
> verdes + o cenário de gates reais verde com `--real-gates`, e smoke HTTP do painel
> (jornada completa via auto-piloto, mockup servido, rotas ausentes fora do modo fake).

## Problema

A esteira do Inhouse tem muitos caminhos (porte `simples`/`media`/`grande`, com/sem UI,
com/sem design+protótipo, bypasses, auto-fix de gates, porteiras humanas). Testar essas
jornadas de ponta a ponta hoje exige rodar tasks reais gastando **minutos de LLM** por
execução. Precisamos de uma forma **rápida e leve** de exercitar exaustivamente todos os
estados e modos de operação — sem chamar o Claude de verdade.

## Ideia

Um **modelo fake programável** que responde instantaneamente com as linhas-marcador que a
máquina espera (`PORTE:`, `UI:`, `DESIGN:`, `VEREDITO:`, `PREPARADO:` + plano via
`ExitPlanMode`), acionado por uma env flag. Em cima dele:

1. Um **catálogo de cenários** cobrindo a matriz de jornadas.
2. Um **runner headless** que toca cada cenário de ponta a ponta e reporta a trilha de
   steps visitada vs. a esperada (matriz pass/fail).
3. Um **painel de Debug na UI** para disparar um cenário e assistir aos estados na tela.

Decisões travadas com o time (2026-08-06):
- **Ambos** os modos: runner headless + seletor na UI.
- Fake injetado via **`INHOUSE_FAKE_MODEL`**, delegando de `runPhase`.
- Verificações **configuráveis por cenário** (stub instantâneo, injeção de falha, ou reais).

## Arquitetura — os seams

Todos os pontos de contato com o mundo "caro/lento" ficam atrás de **um único early-return**
`if (isFakeModelActive()) …`. Com a flag desligada, o comportamento é byte-a-byte o de hoje
(impacto zero em produção). Os seams:

| # | Arquivo | Seam | Motivo |
|---|---------|------|--------|
| 1 | `server/claude/runner.ts` (`runPhase`, ~L138) | `return fakeRunPhase(opts)` | Funil único de TODA chamada de LLM (9 call sites). |
| 2 | `server/services/gates.ts` (`runGates`, L45) | resultados canned por cenário | Gates configuráveis (stub-pass / fail / reais) sem `npm`. |
| 3 | `server/services/worktrees.ts` (`ensureDeps`, L157) | pula `npm install` no fake | Manter as jornadas **leves** (sem instalar deps por espaço). |
| 4 | `server/services/preview.ts` (`startPreview`, L177) | URL de preview fake | Não subir `vite` de verdade nas skill-gates de UI (`qa`). |
| 5 | `server/services/publish.ts` (`publishTask`, L~30) | merge/PR canned | Projeto descartável não tem `origin`; `gh pr create` falharia. |

Nada disso muda a lógica da máquina de estados (`machine.ts`) — ela roda **de verdade**,
exercitando transições, porteiras, auto-fix, re-julgamento, histórico e SSE.

## Novos arquivos

```
server/debug/
  fakeModel.ts     # isFakeModelActive(), activate(), bindTask(), fakeRunPhase(), stubs de gate/preview/publish
  scenarios.ts     # DebugScenario[] — o catálogo da matriz
  runJourneys.ts   # runner headless (npm run debug): dirige cada cenário e imprime a matriz
  routes.ts        # rotas /api/debug/* (montadas SÓ quando a flag está ligada)
```

### `fakeModel.ts` — o cérebro

`fakeRunPhase(opts)` classifica a fase a partir de `RunPhaseOpts` (sem depender de estado
externo frágil):

| `permissionMode` | Prompt | Fase | Retorno do fake |
|---|---|---|---|
| `default` | (espec) | **espec** | spec markdown + `PORTE/UI/DESIGN` do cenário |
| `plan` | começa com `/` | **review de plano** (skill) | `success` benigno |
| `plan` | não-`/` | **plano / detalhamento** (consolidação) | `planText` = plano do cenário; `finalText` = linhas de julgamento |
| `acceptEdits` | contém "PREPARAR este projeto" | **preparação** | `finalText` termina em `PREPARADO: sim\|nao` |
| `acceptEdits` | contém "protótipo" | **protótipo** | escreve `docs/plans/mockups/<slug>/index.html`, `filesTouched:true` |
| `acceptEdits` | começa com `/` (VEREDITO) | **skill-gate** (verificações) | `finalText` termina em `VEREDITO: APROVADO\|REPROVADO — …` |
| `acceptEdits` | resto | **execução / fix-gates** | escreve arquivo trivial (se gate real), `filesTouched` do cenário |

Ligação cenário→task: `activate(scenario)` marca um cenário "pendente"; o primeiro `taskId`
desconhecido que chega no fake o reivindica e fica ligado a ele (mapa por `taskId`). Tanto o
runner quanto a rota chamam `activate` **antes** de `startTask` (um task por vez — contrato
satisfeito pelos dois usos). Sem cenário ligado → fallback default (para não quebrar chamadas
avulsas de juiz/preview).

Efeitos colaterais para fidelidade (o fake reproduz um subconjunto do runner real): grava 1
item `assistant` + `tool` no transcript e faz `broadcast` (para a UI mostrar progresso).
Delay opcional `INHOUSE_FAKE_DELAY_MS` (default `0`; a UI usa ~400ms para dar pra "assistir").
Retorna `sessionId` estável (`resume` funciona) e `metricas` zeradas. **Não** toca no eval.

### `scenarios.ts` — a matriz

`DebugScenario`: `id`, `label`, `descricao`, `porte`, `ui`, `design`, `plan?`, `prepPronto?`,
`gates` (`stub-pass` | `stub-fail-once` | `stub-fail-always` | `real`), `skillGateVeredito?`,
`bypass?` (`approve_plan_direto`), `setDesign?`, `expectSteps: Step[]`, `expectFinal:
TaskStatus`.

Catálogo inicial (grupo **stub**, rápido, sem `npm`):

1. `simples` · UI não — pula detalhamento/protótipo.
2. `simples` · UI sim.
3. `media` · UI não · design não — detalhamento → execução.
4. `media` · UI sim · design não.
5. `media` · UI sim · design sim — protótipo → aprovação do protótipo.
6. `grande` · UI sim · design sim — jornada cheia (office-hours + eng/design-review + review/qa).
7. `grande` · bypass `approve_plan_direto` — pula detalhamento/protótipo.
8. `media` · gates `stub-fail-once` — 1 rodada de auto-fix e passa.
9. `media` · gates `stub-fail-always` — estoura `MAX_GATE_FIX_ROUNDS`, termina `falhou`.
10. `grande` · UI sim · `skillGateVeredito: reprovado` — a skill-gate `/review` reprova → auto-fix.
11. `media` · `setDesign: nao` sobre task de design — desliga o protótipo.
12. **preparação** (`startPreparacao`) · `prepPronto: sim` e `nao`.

Grupo **real** (opt-in `--real-gates`, roda `tsc` de verdade):

13. `media` · gates `real` — o fake escreve um arquivo válido; `tsc --noEmit` roda no espaço.

> `plano_rapido` depende de janela de tempo (task em `plano/rodando`) — inviável de forma
> determinística no runner headless; fica **exercitável no modo UI** (clique humano durante o
> plano). Registrado aqui para não passar como "coberto".

### `runJourneys.ts` — runner headless (`npm run debug`)

1. Define `process.env` (`INHOUSE_FAKE_MODEL=1`, `INHOUSE_DATA_DIR`/`INHOUSE_PROJECTS_DIR`
   isolados num tmpdir, `INHOUSE_EVAL_A_CADA` altíssimo p/ não disparar o juiz) **antes** de
   importar `store`/`machine` (o `config` lê env no import).
2. Cria **um** projeto descartável do template (`cp` + `git init` + commit; sem `npm install`).
3. Para cada cenário: `activate(scenario)` → `startTask`/`startPreparacao` → **auto-piloto**
   que observa `task_updated` e, a cada porteira humana, aplica a ação (`approve_plan` [com
   `direto` no bypass], `approve_prototype`, `approve_test`, `publish`) até o estado terminal.
4. Registra a **trilha de steps** (via `historico`) e compara com `expectSteps`/`expectFinal`.
5. Imprime uma **matriz** (cenário × resultado × trilha × tempo) e sai com código ≠0 se algo
   divergiu. Cenários `real` só rodam com `--real-gates` (senão são listados como PULADOS —
   sem omissão silenciosa).

### Painel de Debug na UI

- `server/debug/routes.ts`: `GET /api/debug/scenarios` (catálogo) e `POST /api/debug/run`
  (`{projectId, scenarioId}` → `activate` + `startTask`). Montadas em `routes.ts` **apenas
  quando `isFakeModelActive()`** — servidor normal nunca expõe.
- `public/app.js`: um card "🐛 Debug" (visível só quando `/api/state` sinaliza modo fake) com
  seletor de projeto + cenário, botão "Rodar cenário" e um toggle "auto-piloto" (aprova as
  porteiras no cliente). O usuário assiste à jornada no quadro normal, estado por estado.

## npm scripts

```jsonc
"debug":    "tsx server/debug/runJourneys.ts",                 // matriz headless
"dev:fake": "INHOUSE_FAKE_MODEL=1 INHOUSE_DATA_DIR=\"$HOME/.inhouse-debug\" INHOUSE_PROJECTS_DIR=\"$HOME/Inhouse-debug\" tsx watch server/index.ts"
```

Modo fake sempre usa `DATA_DIR`/`PROJECTS_DIR` isolados — nunca polui os dados reais do eval.

## Testes

- `test/debug-fakeModel.test.ts` — unit da classificação de fase e das saídas do `fakeRunPhase`
  (puro, rápido).
- Smoke opcional: 2–3 cenários via runner em CI (`npm run debug`).

## Fora do escopo (v1)

- Fake binary via `INHOUSE_CLAUDE_PATH` (protocolo stream-json) — o seam de `runPhase` cobre
  o objetivo com muito menos custo.
- Cobertura determinística de `plano_rapido` no headless (só na UI).
- Streaming token-a-token fiel (o fake emite o texto consolidado, não deltas).

## Adendo (2026-08-06): preview e protótipo multi-página

Para exercitar de verdade a navegação:

- **Protótipo multi-página**: o fake grava 3 telas ligadas por links relativos
  (`index.html` → `detalhes.html` → `config.html`) em `docs/plans/mockups/<slug>/`.
  Os links do "Ver protótipo" na UI passaram a apontar para `/mockup/` (barra final)
  para os links relativos resolverem contra `/mockup/*` — corrige também o protótipo
  real multi-página do Claude. Visível na porteira `aprovacao_prototipo` (rode um
  cenário de design com o auto-piloto DESLIGADO).
- **Preview multi-rota**: novo `server/debug/fakePreview.ts` sobe um servidor HTTP em
  memória (porta 0) servindo um app de demonstração com várias rotas (`/`, `/produtos`,
  `/produtos/:id`, `/sobre`, `/contato` + catch-all para qualquer rota digitada). O seam
  de `startPreview`/`stopPreview`/`stopAllPreviews` usa ele no modo fake. Assim o iframe
  do preview e a barra de URL navegável funcionam sem subir `vite`. Acionável pelo botão
  "Iniciar preview" no editor (e auto-iniciado na skill-gate `/qa` das jornadas de UI).

## Adendo (2026-08-07): merge com a "preview confiável"

A feature `preview-confiavel` adicionou `runPreviewCheck` no fim das Verificações
(pras tasks de UI), que chama `attemptStart` **direto** (não o `startPreview`). Por
isso o seam do preview fake foi estendido também para `attemptStart` — senão as
jornadas de UI tentariam subir o `vite` real e falhariam. Um 6º seam, mesmo padrão.

Nota: `runPreviewCheck` decide "tem UI?" por `temUi(worktreePath)` (heurística do
**projeto**, lê o package.json), não pelo flag `ui` do cenário. Como o
`templates/app-starter` declara React, o caminho do preview fake é exercitado em
TODOS os cenários da matriz (inclusive os `ui:false`) — bom para cobertura, mas é
por isso que "ui: nao" no cenário não pula o preview-check.

## Impacto / risco

- Flag desligada = comportamento idêntico ao atual (early-returns não são atingidos).
- 6 seams pequenos e isolados; a máquina de estados roda de verdade.
- Rotas de debug nunca montadas fora do modo fake.
