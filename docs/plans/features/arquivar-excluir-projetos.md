# Arquivar / Excluir projetos (seção "Meus projetos")

- **Categoria:** features
- **Data:** 2026-08-09
- **Status:** Concluído (branch `feat/arquivar-excluir-projetos`, empilhada sobre a PR #2)

## Feito

Backend: `Project.arquivadoEm` + `ExclusaoInfo` + evento `project_removed`; `store.removeProject`
(remove projeto + tarefas, devolve as removidas); `library.forgetProject`; em `projects.ts`
`gerenciado()`, `setArquivado()`, `exclusaoInfo()` (inspeciona git de verdade) e `deleteProject()`
com todos os guardrails. Rotas: `POST :id/arquivar|desarquivar`, `GET :id/exclusao-info`,
`DELETE :id` (409 se tarefa rodando). **Correção de corrida:** matar o `npm install` inicial do
projeto antes de apagar a pasta (senão ele recriava a pasta após o rm).
Frontend (UI 0.21.0): menu ⋯ no card (Arquivar/Excluir…), seção "Arquivados" recolhível, modal
`confirmarExclusao` com fricção escalonada (digitar o nome quando há perda irreversível), arquivados
somem dos seletores de projeto. Testes: +7 (5 projects, 1 store, 1 library) → 225 passando.
Smoke real do ciclo (criar app → info → arquivar → desarquivar → excluir apaga a pasta) e da corrida.

## Problema

A seção "Meus projetos" só tem "Abrir" — não dá pra tirar um projeto da frente nem apagar.
O usuário é leigo e não sabe o impacto de excluir. Precisamos de **arquivar** (suave) e
**excluir** (forte) com o usuário **bem informado** e **guardrails** contra "cagada".

## O que o Inhouse guarda por projeto (impacto real)

- **Checkout principal** em `project.path`.
- **Worktrees** ("espaços") em `~/Inhouse/.espacos/<project.name>/espaco-*`.
- **Tarefas** no `state.json` (por `projectId`) + transcripts (`~/.inhouse/transcripts`) + anexos.
- **Previews** (dev servers) por tarefa.
- **Override de workflow** por projeto (`workflows.json` → `porProjeto[projectId]`).
- **Branches** `tarefa/*` dentro do repo.

## A distinção que define a segurança (não é o rótulo App/GitHub)

- **Gerenciado por nós** = `path` dentro de `~/Inhouse` (apps criados + repos baixados). A pasta é nossa → podemos oferecer apagar do disco.
- **Aberto no lugar** = `path` fora de `~/Inhouse` (pasta que já era do usuário, via `openProject`). **NUNCA apagamos essa pasta** — só "removemos do Inhouse".
- **Tem cópia no GitHub?** `originUrl` presente → reabrível/reclonável. App sem `originUrl` → **só existe aqui** (risco máximo).

## Ações

### 1. Arquivar — suave, reversível (padrão seguro)
- `Project.arquivadoEm` (flag). Sai da grade principal → seção **"Arquivados"** recolhível.
- Para os previews das tarefas do projeto. **Nada é apagado.** Worktrees, branches e tarefas ficam.
- "Desarquivar" volta ao normal. Arquivados saem dos seletores de projeto (criar tarefa/config).

### 2. Excluir — forte, com fricção escalonada pela irreversibilidade
- `GET /api/projects/:id/exclusao-info` inspeciona o git de verdade → `{ gerenciado, temRemoto, rodando, tarefasAtivas, nTarefas, sujo, commitsFrente, branchesTarefa }`.
- **Bloqueio duro:** tarefa `rodando` → 409 ("cancele ou espere"). Não matamos o Claude no meio.
- **Aberto no lugar** → só **"Remover do Inhouse"**: tira do estado, remove worktrees `.espacos/<name>` (nossos), para previews, limpa override. **A pasta do usuário fica intacta** (copy mostra o caminho).
- **Gerenciado** → **"Excluir do computador"**: remove do estado + apaga `path` + worktrees + transcripts/anexos + override. Fricção:
  - App **sem remoto** (só existe aqui) → aviso **vermelho** + **digitar o nome** pra confirmar.
  - Com remoto mas **trabalho não enviado** (sujo / commits à frente / branches de tarefa) → aviso **âmbar** listando o que se perde + digitar o nome. Sugere "Arquivar em vez disso".
  - Com remoto e **limpo** → confirmação simples + nota "dá pra reabrir do GitHub".

## Guard no servidor (autoritativo — nunca confia no cliente)
`deleteProject(id, { apagarArquivos })`:
1. recusa se `rodando`;
2. `gerenciado = dentroDe(path, PROJECTS_DIR) && path !== PROJECTS_DIR && !dentroDe(path, ESPACOS_DIR)`;
3. para previews de todas as tarefas; remove worktrees (tolera ausência) + `rm .espacos/<name>`;
4. **só** apaga `path` se `apagarArquivos && gerenciado` (fora disso, ignora a flag);
5. remove tarefas + transcripts + anexos (best-effort); remove projeto; `forgetProject` (override).

## Arquivos
- `shared/types.ts`: `Project.arquivadoEm?`; contratos das rotas novas.
- `server/store.ts`: `removeProject`, `removeTasksForProject`.
- `server/workflow/library.ts`: `forgetProject(projectId)`.
- `server/services/projects.ts`: `setArquivado(id,on)`, `exclusaoInfo(id)`, `deleteProject(id,opts)`.
- `server/api/routes.ts`: `POST :id/arquivar|desarquivar`, `GET :id/exclusao-info`, `DELETE :id`.
- `public/app.js` + `styles.css`: menu ⋯ no card (Arquivar / Excluir…), seção Arquivados, modal de exclusão rico (`confirmarExclusao`) com digitar-nome; filtra arquivados dos seletores.
- Testes: store (remove), library (forget), projects (deleteProject: gerenciado apaga / aberto NÃO apaga / recusa rodando / limpa worktrees+estado+override).

## Verificação
typecheck + `npm test` + smoke real das rotas (arquivar, exclusao-info, delete gerenciado em projeto de teste — nunca nos projetos reais do Marlon).
