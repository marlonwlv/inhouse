# Inhouse

App builder local da Inhouse — **conductor + lovable** numa ferramenta só, para pessoas
não-técnicas criarem e alterarem apps com segurança, usando o **Claude Code da própria
máquina** (a subscription de cada pessoa; nunca API key; nada sai do computador além
da conversa com o Claude).

## Rodando

Pré-requisitos (uma vez só):

1. **Node 24+** — aqui na máquina: `mise exec node@24 -- <comando>` (ou instale via nvm/mise)
2. **Claude Code logado** — `claude login` no terminal (plano Pro/Max)
3. `git` (e `gh` logado, se quiser criar PRs)

```bash
cd ~/code/inhouse
mise exec node@24 -- npm install   # primeira vez
mise exec node@24 -- npm start
# → abra http://127.0.0.1:4400
```

## Como funciona

- **Início**: abra um repo do GitHub (clone com barra de progresso) ou crie um app novo
  do template Inhouse.
- **Tarefas**: descreva uma tarefa em português. Ela ganha um **espaço isolado**
  (um `git worktree` — a palavra nunca aparece na UI) e percorre a esteira:

  `Espec → Plano → Sua aprovação → Execução → Verificações → Seu teste → Publicar`

  Losangos são porteiras humanas (aprovar plano, testar no preview, publicar).
  Círculos são automáticos. **Verificações** (typecheck/lint/testes detectados no
  projeto) rodam como gate determinístico — código quebrado não passa; o Claude
  recebe os erros e tenta corrigir até 2 vezes.
- **Editor**: chat da tarefa (com pedidos de permissão em português claro) + preview
  do app rodando localmente em porta própria por espaço.
- **Publicar**: merge no branch principal do projeto (+ PR no GitHub, opcional).

## Arquitetura (resumo)

Servidor Node/TS (Express + SSE, porta 4400, **somente 127.0.0.1**) + UI vanilla sem
build. O Claude entra via `@anthropic-ai/claude-agent-sdk` apontando para o binário
`claude` da máquina (`pathToClaudeCodeExecutable`), com `ANTHROPIC_API_KEY` removida
do ambiente e `settingSources: ["project"]`. Detalhes e decisões: `ARCHITECTURE.md`.

- Estado: `~/.inhouse/state.json` · transcripts em `~/.inhouse/transcripts/` (instalações antigas: `~/.inhouse`)
- Projetos: `~/Inhouse/` · espaços (worktrees): `~/Inhouse/.espacos/` (instalações antigas: `~/Inhouse`)

## Desenvolvimento

```bash
npm run dev        # tsx watch
npm run typecheck  # tsc --noEmit
npm test           # vitest (34 testes, claude mockado)
```
