# Inhouse — Próximas melhorias (update, setup de repo, arquivar, esteira em fases)

> **Categoria:** features · **Criado:** 2026-08-06 · **Status:** Proposto
> Quatro melhorias pedidas pelo Marlon depois do open source. A #4 é o item pesado (reforma do state-machine da esteira). #1 e #3 são ganhos rápidos; #2 é um fluxo novo de onboarding de repositório.

## Contexto

Com o Inhouse já público (`github.com/marlonwlv/inhouse`), o foco vira a experiência de quem instala e usa. Quatro frentes:

1. O app **avisar quando há versão nova** e permitir atualizar.
2. Quando alguém **não-técnico** baixa o primeiro repo (talvez sem git/Docker/libs), a **primeira experiência deveria ser preparar o projeto**.
3. **Arquivar tarefas** para não poluir a interface (e matar o worktree daquela task).
4. **Quebrar a etapa de "Plano"** em fases, com o gate humano logo após o office-hours, e etapas condicionais de Detalhamento e Protótipo — com inteligência pela natureza da task e flexibilidade pro usuário.

---

## 1. Aviso de versão nova (+ atualizar em 1 clique)

**Viável**: a instalação recomendada é um clone git (o `origin` aponta pro GitHub). Degrada em silêncio quando não há git/origin (instalação por ZIP) ou quando está offline.

- **Server** (`server/services/update.ts`, novo): na subida e a cada N horas (ex.: 3h), se o repo do Inhouse tem `origin` e é um clone:
  - `git fetch origin <branch> --quiet` → `git rev-list --count HEAD..origin/<branch>`.
  - `> 0` ⇒ há versão nova. Guarda `{ atras: N, sha, checadoEm }`.
  - Roda no diretório do PRÓPRIO Inhouse (raiz do `package.json`), nunca nos repos dos projetos.
- **Exposição**: incluir `update` no `GET /api/state` + evento SSE `update_status` (chip verde automático, mesmo padrão do `claude_status`).
- **UI** (`public/app.js` + `styles.css`): pílula discreta no rodapé/topo — **"Versão nova disponível · Atualizar"**. Clicar → `POST /api/update`:
  - Guarda: só se a árvore do Inhouse estiver limpa e no branch default. Sujo ⇒ "Você tem alterações locais no Inhouse; atualize manualmente."
  - `git pull --ff-only` → "Atualizado! Feche e abra o Inhouse de novo." (o server precisa reiniciar pra aplicar; sem auto-restart nesta v1.)
- **Fallback ZIP** (sem git): não mostra a pílula (não dá pra saber o SHA local); documentar no README que a atualização é via `git pull`.

**Arquivos**: `server/services/update.ts` (novo), `server/index.ts` (poller), `server/api/routes.ts` (`GET /api/state` + `POST /api/update`), `shared/types.ts` (evento + shape), `public/app.js`, `public/styles.css`.

---

## 2. Setup guiado do repositório (primeira experiência)

Quando um repo é aberto/clonado, quem não é técnico pode não ter o ambiente pronto (deps, `.env`, Docker, um runtime, um banco). A primeira coisa a fazer é **preparar o projeto**.

- **Gatilho**: logo após o clone/abertura, enquanto o projeto não foi preparado, o quadro mostra um card em destaque **"Preparar este projeto"** (oferecido, não forçado — mas é o primeiro convite). Persistir `preparado?: string` (ISO) no `Project` pra não repetir o convite.
- **Fluxo de preparação** (reusa chat/permissões, mas NÃO é uma task normal que vira PR — termina em "pronto", não em "publicar"):
  1. **Audita** o repo: gerenciador (lockfile), `engines`/`.tool-versions`, `docker-compose*.yml`, `.env.example`/`.env.sample`, scripts de setup no `package.json`/README, serviços/banco.
  2. **Instala o que é do projeto** (com permissão): dependências, copia `.env.example` → `.env`/`.env.local`, roda script de setup documentado.
  3. **Detecta e orienta** o que é do sistema e ele NÃO instala sozinho (Docker, um runtime específico, um banco) — passo-a-passo amigável com link, no espírito do `setup.command`. Sem `sudo` silencioso.
  4. **Verifica** (o dev server/build sobe — reusa a detecção do preview) e termina com **"✅ Pronto pra criar tarefas"** ou **"⚠️ Falta instalar o Docker e rodar de novo"**.
- **Segurança**: roda com `claudeEnv()` (sem chaves), com porteiras de permissão pra qualquer comando de sistema; ações destrutivas negadas.
- **Re-rodável**: botão "Preparar de novo".

**Decisão de modelo**: tratar como um **fluxo de projeto** (`kind`/estado próprio no `Project`, ex.: `preparado`), reusando a UI de chat/permissão, em vez de uma task da esteira. Assim não gera PR e não polui a lista de tarefas.

**Arquivos**: `server/services/setup.ts` (novo, orquestra a fase de auditoria/preparação), `server/workflow/phases.ts` (prompt de preparação), `server/api/routes.ts` (`POST /api/projects/:id/prepare`), `shared/types.ts` (`Project.preparado`, evento), `public/app.js` (card + fluxo), `server/services/projects.ts` (marcar não-preparado ao clonar).

---

## 3. Arquivar tarefas (+ matar o worktree)

- **Modelo**: `Task.arquivadaEm?: string` (ISO). Arquivar some do quadro por padrão.
- **Ação** `arquivar` (em `applyAction`): permitida em tarefas **terminais** (concluída/cancelada/falhou). Numa tarefa em andamento, primeiro cancela (a UI encadeia: "Cancelar e arquivar").
  - `removeEspaco(project, worktreePath, { keepBranch: true })` (mata o worktree, preserva a branch/PR) + `stopPreview(taskId)`.
- **UI**: quadro esconde arquivadas; uma seção/toggle **"Arquivadas (N)"** pra revisar; `desarquivar` só reexibe (o worktree não é recriado — a task terminal é leitura).
- **Eval**: tarefas arquivadas continuam nos registros (são desfechos já contados); nada muda no eval.

**Arquivos**: `shared/types.ts` (`Task.arquivadaEm`, ação `arquivar`/`desarquivar` no `TASK_ACTIONS` + union), `server/workflow/machine.ts` (`applyAction`), `public/app.js` (filtro + botão), `test/machine.test.ts`.

---

## 4. Esteira de plano em fases (o item pesado)

### Problema
Hoje a etapa "Plano" roda **office-hours + eng + design numa tacada só** (para `grande`), e só então o humano aprova. Office-hours é **insumo** dos outros dois — o gate humano tem que vir logo depois dele, antes de investir no técnico/design.

### Fluxo novo

```
Espec
 → Plano                 (office-hours: o QUÊ, em linguagem de produto)
 → [Sua aprovação]        ← porteira: aprova o QUÊ
 → Detalhamento          (plano técnico + design, quando faz sentido: o COMO)
 → Protótipo             (opcional: mockups HTML/CSS em docs/plans/mockups/<task>/)
 → [Aprovação do protótipo] (só se houve protótipo)
 → Execução → Verificações → Seu teste → Publicar → Concluída
```

### Contrato de steps (`shared/types.ts`)
`STEPS` passa a: `espec, plano, aprovacao, detalhamento, prototipo, aprovacao_prototipo, execucao, verificacoes, teste, publicar, concluida`.
`HUMAN_STEPS`: `aprovacao, aprovacao_prototipo, teste, publicar`.
`STEP_LABELS`: + `detalhamento: "Detalhamento"`, `prototipo: "Protótipo"`, `aprovacao_prototipo: "Aprovação do protótipo"`.

**Steps condicionais**: nem toda task passa por todos. Cada task tem uma lista de **steps ativos** calculada da sua natureza; `flowHtml` renderiza só os ativos (hoje ele itera o `STEPS` global — muda pra iterar os steps ativos da task).

### Inteligência (pela natureza da task)
Julgado na espec (e re-julgado após o plano de produto):
- **porte** `simples | media | grande` (já existe).
- **temUi** (já existe).
- **precisaDesign** (NOVO): a task é uma **feature de UI com jornada nova de usuário**, que pede olhar humano de julgamento? `true` ⇒ vale design + protótipo. CRUD/telas parecidas/componentes prontos ⇒ `false` (só o técnico).

Steps ativos por natureza:
- **simples**: `espec → plano (rápido) → aprovacao → execucao → …` (sem detalhamento, sem protótipo).
- **media/grande, sem design**: `… → aprovacao → detalhamento → execucao → …`.
- **media/grande, com design**: `… → aprovacao → detalhamento → prototipo → aprovacao_prototipo → execucao → …`.

Para `plano`: office-hours roda em media/grande; em simples é um plano enxuto direto (o atual "plano rápido" vira o caminho padrão do simples).

### Flexibilidade (controle manual do usuário)
- Campo `Task.design?: "auto" | "sim" | "nao"` (default `auto`). Efetivo "roda design+protótipo" = `design === "sim" || (design !== "nao" && precisaDesign)`. Cobre o caso do Marlon: um CRUD que a heurística marcou como UI, o usuário desliga (`nao`); uma tela sensível que a heurística não pegou, liga (`sim`).
- Em **cada porteira**: `Aprovar` / `Pedir mudanças` / **`Pular a próxima etapa`**. Ex.: na aprovação do produto, "Aprovar e ir direto pra execução" pula Detalhamento+Protótipo. Generaliza o `plano_rapido` atual.
- Toggle de design (`auto/sim/não`) visível no card da task e na porteira de aprovação do produto.

### Protótipo = mockups versionados
- A fase **prototipo** gera **arquivos HTML+CSS** em `docs/plans/mockups/<slug-da-task>/` **dentro do espaço da task** (worktree) → viajam junto com o plano e entram no PR ("conjunto plano + mockups").
- Regra de ouro: mockup é **rápido e descartável** (não é a implementação de produção); serve pra decisão visual. Ao aprovar, a **Execução implementa de verdade**.
- **Ver o protótipo**: rota estática read-only servindo `docs/plans/mockups/<slug>/` do worktree (`GET /api/tasks/:id/mockup/*`), aberta no iframe do preview ou em nova aba ("Ver protótipo"). Reusa a infra visual do preview.

### Config (`inhouse.config.json` + `server/workflow/config.ts`)
`skills.plano` (cadeia única) passa a duas chaves:
- `skills.plano_produto` → `[office-hours]` (media/grande).
- `skills.detalhamento` → `[plan-eng-review, plan-design-review (quando design)]`.
- Protótipo: prompt de fase dedicado (cria os mockups); pode ou não ter skill de design.
- **Compat**: se só existir o `skills.plano` legado, mapear (office-hours → plano_produto; eng/design → detalhamento). Atualizar o template `app-starter`.

### Máquina de estados (`server/workflow/machine.ts`)
- `runPlano` foca no **plano de produto** (office-hours ou enxuto no simples) → gate `aprovacao`.
- `approve_plan` → decide próximo step pelos steps ativos: `detalhamento` (se ativo) ou `execucao`.
- Nova fase `runDetalhamento` (eng + design-quando) → se protótipo ativo, `runPrototipo` → gate `aprovacao_prototipo`; senão `execucao`.
- Nova fase `runPrototipo` (gera mockups) → gate `aprovacao_prototipo`.
- `approve_prototype` (nova ação) → `execucao`.
- Ações novas em `TASK_ACTIONS`/`TaskAction`: `approve_prototype`, `set_design` (`auto|sim|nao`), `pular_etapa` (ou reuso do `plano_rapido` generalizado).
- `request_changes` em cada porteira volta pra fase correspondente (produto/detalhamento/protótipo), reusando a sessão (`claudeSessionId`).

### UI (`public/app.js` + `styles.css`)
- `flowHtml`: iterar os **steps ativos da task** (não o `STEPS` global); losangos pras porteiras novas.
- Cartões de porteira: aprovação do produto (com toggle de design + "ir direto pra execução"), aprovação do protótipo (com "Ver protótipo").
- `STEP_LABELS`/pílulas de status pros steps novos.

### Arquivos (#4)
`shared/types.ts`, `server/workflow/{machine,phases,config}.ts`, `server/api/routes.ts` (rota do mockup + ações), `public/app.js` + `public/styles.css`, `templates/app-starter/inhouse.config.json`, testes (`machine`, `workflow-config`, novo de steps-ativos).

---

## Faseamento sugerido (ordem de implementação)
1. **#3 Arquivar** — pequeno, isolado, ganho imediato de UI.
2. **#1 Update-check** — isolado, alto valor pra quem já instalou.
3. **#2 Setup guiado** — fluxo novo, médio; encaixa com a detecção de ambiente que o preview já faz.
4. **#4 Esteira em fases** — o pesado; muda o contrato de steps e o state-machine. Fazer por último, com bateria de testes nova.

Cada frente entra como um conjunto de commits com typecheck + testes verdes, seguindo o padrão das 8 frentes da v1.

## Verificação
- **#1**: com uma versão atrás, a pílula aparece; "Atualizar" faz `git pull --ff-only` e pede restart; árvore suja recusa; offline/sem-git não mostra nada.
- **#2**: abrir um repo sem `.env`/deps → card "Preparar"; o fluxo instala deps + copia `.env`, orienta o Docker se faltar, e conclui "pronto".
- **#3**: arquivar uma task terminal → some do quadro, worktree removido, aparece em "Arquivadas"; desarquivar reexibe.
- **#4**: task simples = plano rápido + 1 aprovação → execução; feature de UI com jornada nova = produto→aprovação→detalhamento→protótipo(mockups em docs/plans/mockups/)→aprovação→execução; CRUD marcado UI com `design:"nao"` pula design/protótipo; "ir direto pra execução" na aprovação do produto funciona. Typecheck + testes verdes.

## Fora do escopo (por ora)
- Auto-restart do server após o update (v1 pede pra reabrir).
- Instalar ferramentas de sistema (Docker/runtime) automaticamente — só orientar.
- Protótipos interativos além de HTML/CSS (JS de mock fica a critério do agente, sem virar produção).
