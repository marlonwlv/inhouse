# Estabilidade: espaço monotônico, sobrecarga e modelo/effort na tarefa

- **Categoria:** features
- **Data:** 2026-08-09
- **Status:** Em andamento (implementado na branch `feat/inhouse-estabilidade`)

## Contexto

Uma tarefa real do `leapy-2` falhou e a investigação (3 explorações) revelou três problemas de raiz. Escolhas do usuário para as soluções: (1) espaço com **numeração monotônica**; (2) **isolar dev + limitar concorrência**; (3) **ver modelo(s) + effort na tarefa** (a transparência de workflow e o gerador por porte saíram do escopo) + **corrigir o leapy-2**.

## Parte 1 — Espaço: numeração monotônica

Causa: `cancel` liberava o NÚMERO do espaço (`nextEspaco` ignorava `cancelada`) mas mantinha a PASTA no disco ("inspeção"); ao reusar o número, `doCreateEspaco` achava a pasta ocupada e a **destruía**.

Fix: `nextEspaco` (`server/store.ts`) agora é **`max(espaço do projeto) + 1`** — nunca reusa número enquanto qualquer tarefa (mesmo cancelada) o tiver. O bloco de segurança de `doCreateEspaco` fica (defensivo p/ retry da mesma tarefa). Teste atualizado em `test/store.test.ts`.

## Parte 2 — Sobrecarga: isolar dev + limitar concorrência + restart limpo

- **2a. Isolar dev** (`package.json`): `dev` passa a usar `INHOUSE_DATA_DIR=~/.inhouse-dev`, `INHOUSE_PROJECTS_DIR=~/Inhouse-dev`, `INHOUSE_PORT=4410` — desenvolver o Inhouse não colide com a produção nem mata tarefas reais no restart.
- **2b. Restart limpo** (`server/index.ts` `shutdown`): além de `stopAllPreviews()`, agora **mata os npm installs** (`killBackgroundInstalls` em `projects.ts`) e **aborta as fases Claude em curso** (`abortPhase`), com um respiro de 400ms antes do `exit` — não deixa mais processos órfãos a cada restart.
- **2c. Limitador global** (`server/services/limiter.ts`, novo): semáforo contável `withLimit(tipo, fn)`. `claude` = `min(4, cpus-2)` (env `INHOUSE_MAX_CLAUDE`); `install` = 2 (env `INHOUSE_MAX_INSTALL`). Envolve `runPhase` (sessões Claude) e os npm installs (`ensureDeps` + template).
- **2d. Retry robusto** (`server/claude/runner.ts`): `SPAWN_MAX_ATTEMPTS` 3→5 com backoff exponencial + jitter (`spawnBackoffMs`), evitando thundering herd.

## Parte 3 — Modelo(s) + effort na tarefa (+ corrigir o leapy-2)

- **Captura** (`runner.ts` + `coleta.ts` + `shared/types.ts`): modelo da sessão (`SDKSystemMessage.model` no init) e todos os modelos da fase (`SDKResultMessage.modelUsage` — inclui sub-agents de modelo diferente); effort **real** do turno via **hook in-process** (`input.effort.level`), sem sobrescrever a config do usuário. Persistido em `Task.uso.porEtapa[step].{modelos,effort}` (`UsoFase`/`FaseMetricas` estendidos).
- **Exibição** (`public/app.js`, UI 0.24.0): chip `Modelo: … · Effort: …` no cabeçalho da tarefa (`#ed-flowstrip`); com mais de um modelo, lista ("Opus 4.8 + Haiku 4.5"). `nomeModelo()` mapeia ids canônicos para nomes amigáveis.
- **Gasto (tokens + valor estimado)**: os dados de custo/tokens por fase já eram capturados (`Task.uso.porEtapa`); `usoTotais()` soma por tarefa e um chip sutil `~$X · Nk tokens` aparece no **card** (compacto, só o valor) e no **editor** (valor + tokens). Rotulado como valor estimado (equivalente à API) — a pessoa paga a assinatura; é só a noção de quanto foi consumido. Verificado com dados reais (ex.: uma task = ~$52 · 56M tokens).
- **3c. Corrigir o leapy-2** (dado de produção, **pendente de OK do usuário**): reapontar o workflow ativo do `leapy-2` para "Padrão" (ou tirar `plan-ceo-review` do custom), para parar de rodar a skill surpresa.

## Verificação

Isolado no dev (porta 4410, `~/.inhouse-dev`/`~/Inhouse-dev`), sem tocar o server de produção na 4400. Testes novos: `test/limiter.test.ts`, captura de modelo/effort em `test/runner.test.ts`, monotônico em `test/store.test.ts`.
