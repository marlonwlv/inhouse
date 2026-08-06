# Inhouse — Primeira versão para o Product Designer testar

> **Categoria:** release · **Criado:** 2026-08-06 · **Status:** Concluído (2026-08-06)
> Todas as 8 frentes implementadas, testadas (129 testes) e commitadas. Pendente só o push para um repo privado da org (nome/permissão a confirmar com o Marlon).
> Handoff da primeira versão testável para um Product Designer do time (Mac, máquina própria, mexendo no seu-monorepo real).

## Contexto

Um Product Designer do time viu o Inhouse e gostou ("facilitaria muito a vida"). O Marlon quer entregar uma **primeira versão para ele testar sozinho**, mesmo sem o produto pronto. Decisões do Marlon: o designer usa **Mac**, roda **na própria máquina**, e vai mexer no **seu-monorepo real** (produção).

Isso define o risco: ele vai tocar um repo de produção sem ser o desenvolvedor, e o valor central para um designer é **ver a mudança no preview**. Levantamento factual do código confirmou 5 pontos que ele encontraria já na primeira sessão. Windows fica fora (Mac). Electron/empacotamento continua adiado — um launcher `.command` de duplo-clique basta para um designer.

O objetivo é uma **v1 segura e funcional**: tudo que ele fizer vira PR revisável (nunca toca o main, local ou remoto), a cópia real de seu-monorepo dele nunca é modificada, o preview funciona para ele ver a mudança, o onboarding não deixa ele travado, e o modo auto tem freio.

## Escopo recomendado da v1 (8 frentes, em ordem de prioridade)

### 1. Segurança do "Publicar" no repo real (severidade máxima)
Hoje: um clique faz `merge --no-ff` no main **local**, **auto-commita qualquer alteração não salva** da pasta principal (`server/services/publish.ts:56-60`), e o checkbox "Criar PR" vem marcado — tudo **sem confirmação** (`public/app.js:1253-1264`, `:57/:1071`).
- **Publish vira PR-only quando o projeto tem `originUrl`**: commita a branch da tarefa → `git push` → `gh pr create`. **Não faz merge no main local** (a operação inteira é um PR revisável). Merge-local continua só para apps de template sem origin (sandbox). Editar `publishTask` em `publish.ts`.
- **Nunca auto-commitar o working tree do main.** Remover o bloco `publish.ts:56-60`; se a pasta principal estiver suja, **recusar** com mensagem clara (não engolir trabalho de ninguém).
- **Diálogo de confirmação** antes de publicar (reusar o padrão do `<dialog>` de cancelamento em `public/app.js`): deixa explícito "isto abre um Pull Request no GitHub para o time revisar".
- **Guia: o designer CLONA o seu-monorepo pelo Inhouse** (fica em `~/Inhouse/seu-monorepo`, separado do working copy de dev dele) em vez de "abrir" a pasta existente — defesa extra contra tocar a cópia real.

### 2. Onboarding do Claude (primeiro uso não pode travar)
Hoje: aviso passivo; nada impede criar tarefa com Claude offline (ela falha no meio); o chip só fica verde recarregando (`public/app.js:572-586`; evento `claude_status` tem handler mas o server nunca emite).
- **Bloquear criação de tarefa/clone quando `state.claude.ok` é falso** e mostrar um passo-a-passo inline: "Abra o Terminal e rode `claude login`". (`public/app.js` — os botões Começar/Criar/Baixar já têm padrão `disabled`.)
- **Emitir o evento SSE `claude_status`** (o handler já existe em `app.js:367-369`): o server checa `claudeStatus()` periodicamente / após ações e faz `broadcast` — o chip fica verde sozinho após o login. (`server/claude/runner.ts:claudeStatus`, `server/events.ts`, `server/api/routes.ts`.)
- Painel de "primeiros passos" na Home enquanto desconectado.

### 3. Preview genérico — funciona em QUALQUER repo (o valor central para um designer)
Princípio: **convenção + configuração + degradação graciosa**. O preview NÃO é específico do seu-monorepo — ele é o primeiro repo a preencher o bloco de config. Hoje `server/services/preview.ts` só lê o `package.json` da **raiz** e roda `npm run dev` (quebra em monorepo, gerenciador errado, sem env, timeout curto).

**Camada 1 — auto-detecção (zero config, cobre ~80% dos repos JS):**
- Gerenciador pelo lockfile (pnpm/yarn/bun/npm — como já faz `ensureDeps` em `worktrees.ts:136-141`); **rodar o dev com o gerenciador certo** (hoje roda `npm` fixo em `preview.ts:130`).
- Comando: `scripts.dev` → `scripts.start`.
- Framework pelas deps (Vite/Next/Astro/Remix/SvelteKit/Nuxt/CRA) → forçar porta com `PORT=4500+espaço` (já passa) **+ a flag do framework** (`--port`), não só Vite (`preview.ts:122-126`).
- URL por regex no stdout como confirmação (já faz).

**Camada 2 — bloco `preview` opcional no `inhouse.config.json`** (mesmo padrão do de skills, `server/workflow/config.ts` + `shared/types.ts`), versionado no próprio repo, configura-se uma vez:
`{ "cmd": "pnpm --filter web dev", "cwd": "apps/web", "port": 3000, "envFiles": [".env.local"], "readyRegex": "...", "timeoutMs": 180000 }`. Cobre monorepos, subpastas, servidores não-JS, env e ready-signal custom.

**Camada 2.5 — pedir ao agente (auto-cura):** se as camadas 1-2 falham, aparece o botão **"Pedir ao Claude para configurar o preview"** → vira um prompt VISÍVEL no chat da tarefa. Regra de ouro: **o agente DESCOBRE o comando, não roda o servidor** (rodar trava a sessão). O Inhouse já entrega uma **porta livre** (via `portaLivre()`), então o agente só precisa forçar aquela porta — o "desafio da porta" (testar portas ocupadas) é resolvido pelo Inhouse antes de perguntar; fallback: ler a porta real do stdout. O agente retorna `{cmd, cwd, port, envFiles, readyRegex, timeoutMs}`, o Inhouse sobe como preview gerenciado (sem card de permissão, pois quem roda é o Inhouse) e **guarda a receita** (config aprendida por projeto) → na 2ª vez é zero-config. Reusa a sessão da tarefa (`claudeSessionId`), que já conhece o projeto.

**Camada 3 — degradação graciosa:** sem dev server detectável nem via agente (lib/CLI/backend) → painel mostra "este projeto não tem preview de tela", não erro. O designer ainda tem chat + diff.

**Transversal (vale p/ todo repo):** o `.env`/`.env.local` gitignored é a causa nº1 de "subiu mas quebrou" — ao criar o espaço, **copiar os arquivos de ambiente** do checkout principal para o worktree (lista configurável). (`server/services/worktrees.ts:createEspaco`.) Timeout default maior p/ cold-starts.

**Validação:** um app Vite simples roda no zero-config; o seu-monorepo (monorepo pnpm + Next + `.env.local`) roda preenchendo o bloco `preview` — testar os dois de ponta a ponta (URL no iframe).

### 4. Distribuição + setup na máquina dele (logística)
Hoje: sem git remote, sem empacotamento, sem `engines`/`.nvmrc`; depende de Node 24 + `npm install` + git + gh + claude, tudo manual.
- **Push do Inhouse para um repo privado na sua organização** (ex.: `github.com/sua-org/inhouse`) para ele clonar. (Confirmar o nome/permissão do repo na hora.)
- **Script de setup** (`setup.command`): checa/instala Node 24 (via mise ou nvm), verifica git/gh/claude, roda `npm install`. **Launcher de duplo-clique** (`inhouse.command`): sobe `npm start` e abre `http://127.0.0.1:4400` no browser — zero terminal para o dia a dia.
- **`engines` no `package.json` + `.nvmrc`** para versão errada de Node falhar alto, não silenciosa.
- **Guia curto em pt-BR para o designer** (`GUIA-DESIGNER.md`): instalar, conectar o Claude, clonar o seu-monorepo, criar/rodar uma tarefa, o que é seguro.

### 5. Freio no modo auto (guardrail leve)
Hoje: um clique liga o modo auto sem confirmação e libera `Bash`/qualquer ferramenta (`public/app.js:1201-1205`; `server/claude/permissions.ts:104-124`). Execução já roda em `acceptEdits` (edições sem prompt).
- **Confirmação ao ligar o modo auto**: "Isto deixa o Claude executar tudo sem te perguntar. Ligue só numa tarefa em que você confia." (reusar `<dialog>`). O isolamento por worktree + env sem chaves já limitam o estrago; a confirmação fecha o "liguei sem querer".

### 6. Re-validação inteligente (não re-verificar sem mudança de código)
Problema real (o Marlon viveu): na etapa "Seu teste", **qualquer** mensagem no chat vira `request_changes` → volta pra Execução → **sempre** re-roda as Verificações inteiras (`machine.ts` case `request_changes`, ramo `step === "teste"` → `runExecucao` → `runVerificacoes`). Ex.: "sobe o server pra mim" → o agente sobe, **não muda código**, mas a esteira gasta minutos re-validando à toa — e a resposta do agente some porque a UI pula pra Verificações.
- **Rastrear se a rodada editou arquivos**: `runPhase` passa a devolver `filesTouched` (o runner já vê os `tool_use` de Write/Edit/MultiEdit/NotebookEdit — `runner.ts:216`). `PhaseResult.filesTouched`.
- **Só re-rodar Verificações se `filesTouched`**: em `runExecucao`, se a rodada não mexeu em código, **pular os gates** e voltar direto pra "Seu teste" com a resposta do agente visível (nada se perde). System note: "nenhuma mudança de código — pulando as verificações".
- **Mensagem na etapa "Seu teste" vira conversa/steering, não reinício cego**: um recado no chat roda uma rodada leve na mesma sessão (o agente pode responder, subir o preview, ou fazer um ajuste). A tarefa **permanece em "Seu teste"** salvo se código realmente mudou (aí sim Execução→Verificações→Teste, justificado). Mantém "Pedir mudanças" explícito para quando a pessoa quer claramente alterar. (`machine.ts` request_changes/steer + `runExecucao`.)

### 7. Melhorias tiradas do relatório do eval (o próprio Inhouse apontou)
O juiz do eval já rankeou os atritos reais. **Já resolvidos** em iterações anteriores: motivo de cancelamento (diálogo), medição de tempo por etapa (histórico), rota rápida por porte (simples pula reviews). **Novos, a incluir nesta v1:**
- **Visibilidade + saída rápida no Plano** (atrito "plano demorou demais", sev 4/5, único feedback negativo): durante o Plano, mostrar *qual* revisão está rodando (já há system notes) **+ um botão "É uma mudança simples — ir direto ao plano"** que aborta a cadeia de skills e entrega um plano curto. Transforma espera cega em espera controlada; cobre o caso em que a triagem de porte errou pra mais. (`server/workflow/machine.ts` runPlano + `public/app.js`.)
- **Declarar a estrutura do projeto p/ o agente não perguntar coisa técnica** (atrito "Esse repo é o monorepo ou é o outro-repo?", sev 4/5): bloco de contexto no `inhouse.config.json` (ou o `CLAUDE.md` do projeto) declarando o layout (é monorepo, app em `apps/web`, etc.) **+ instrução de prompt**: "você trabalha para alguém não-técnico; não devolva dúvidas de estrutura de código — decida e declare sua suposição." (`server/workflow/phases.ts`.)

### 8. Coletar os dados de eval da máquina do tester (export/import)
Problema: o eval é 100% local (`~/.inhouse/eval/*.jsonl` + `relatorios/*.md`, ~36 KB de texto); o Marlon precisa ver como o teste do Maria foi. Para **um** tester numa v1, sem servidor/telemetria.
- **Export** (`GET /api/eval/export` + botão na tela Experiência): baixa um único JSON com todo o `eval/` (tarefas, feedback, permissões, aprendizados, relatórios). **Transcripts como checkbox opt-in** (contêm trechos de código do repo; baixa sensibilidade no resto). Metadados: label da fonte (ex.: "Maria"), versão da UI, data.
- **Import** (`POST /api/eval/import` + botão): carrega o bundle do tester no Inhouse do Marlon, cada registro marcado com `fonte` (UUIDs não colidem; feedback latest-wins; aprendizados dedupe por chave). A tela Experiência ganha um filtro **fonte: meus / \<label\> / todos**; o juiz roda sobre os dados do tester.
- **Atalho**: o tester pode "Gerar análise" antes de exportar (juiz roda na máquina dele) → o export leva o relatório pronto e o Marlon só lê o markdown.
- Arquivos: `server/api/routes.ts` (export/import), `server/eval/coleta.ts` + `resumo.ts` (campo `fonte`, merge, filtro), `public/app.js` (botões + filtro).
- **Escala (adiado)**: multi-tester / zero-toque → auto-sync do `eval/` para um repo git privado da org (padrão gstack-artifacts); exige auth git na máquina do tester + repo compartilhado.

## Explicitamente adiado (não bloqueia a v1)
- Windows (Mac confirmado).
- Electron / instalador `.dmg` / auto-update (launcher `.command` basta).
- Botão de reset na UI / limpeza do rebrand legado (máquina nova nasce limpa).
- "Modo leigo" escondendo git/terminal (designer tem traquejo suficiente).
- Visualizador de logs na UI.

## Arquivos principais a tocar
- `server/services/publish.ts` — PR-only p/ origin, sem auto-commit do main, recusa se sujo.
- `server/services/preview.ts` + `server/services/worktrees.ts` + `server/workflow/config.ts` + `shared/types.ts` — bloco `preview` configurável, pnpm, env file, timeout, receita do agente.
- `public/app.js` (+ `public/styles.css`) — gate de Claude offline, diálogos de confirmação (publicar, auto), painel de primeiros passos, botão "pedir preview ao agente", botão "ir direto ao plano".
- `server/api/routes.ts` + `server/events.ts` + `server/claude/runner.ts` — emitir `claude_status` por SSE; `filesTouched` no `PhaseResult`.
- `server/workflow/machine.ts` + `server/workflow/phases.ts` — re-validação inteligente, saída rápida do plano, contexto do projeto p/ não perguntar coisa técnica.
- `package.json` (`engines`) + `.nvmrc` + `setup.command` + `inhouse.command` + `GUIA-DESIGNER.md` (novos) — distribuição/setup.
- `templates/app-starter/inhouse.config.json` e/ou um `inhouse.config.json` para o seu-monorepo — bloco `preview`.

## Verificação (teste de ponta a ponta, simulando o designer)
1. Numa pasta limpa (ou apagando `~/.inhouse`/`~/Inhouse`), `setup.command` → `inhouse.command` abre a UI vazia.
2. Com Claude deslogado: a UI **bloqueia** criar tarefa e mostra o passo do `claude login`; após logar, o chip fica **verde sozinho** (SSE), sem recarregar.
3. Clonar o seu-monorepo pelo Inhouse; criar uma tarefa pequena de UI (ex.: trocar um texto numa tela).
4. Aprovar plano → execução → verificações → **abrir preview**: o Next do `apps/web` sobe no espaço isolado (com `.env.local` resolvido) e a mudança aparece no iframe.
5. **Publicar**: confirmação aparece; resultado = **PR aberto no GitHub** contra o main; o main (local e remoto) e a cópia real de seu-monorepo do designer **não** são tocados.
6. Ligar modo auto → confirmação aparece.
7. **Re-validação inteligente**: na etapa "Seu teste", mandar "sobe o server pra mim" → o agente age, **não** re-roda as Verificações, a tarefa **continua em "Seu teste"** e a resposta fica visível. Mandar um pedido que muda código → aí sim re-valida.
8. **Preview via agente**: num repo sem dev script óbvio, clicar preview → falha → botão "Pedir ao Claude" → o agente descobre o comando → sobe numa porta livre → iframe funciona; 2ª vez no mesmo repo = zero-config.
9. **Plano rápido**: numa tarefa que a triagem marcou como média/grande, o botão "ir direto ao plano" corta a espera.
10. `npm run typecheck` limpo e `npm test` (suíte atual, hoje 108) verde; nenhum teste existente quebrado; novos testes p/ `filesTouched`/skip-verificações e para o parse da receita de preview do agente.
