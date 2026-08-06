# Diagnóstico: checks de CI "sumidos" no PR criado pelo InHouse (06/08/2026)

**Status:** Resolvido no diagnóstico — causa externa (pane do GitHub). Nada a corrigir no InHouse pra este incidente.
**Doc temporário** — pode apagar depois de lido.

---

## TL;DR

O PR aberto pelo InHouse (`sua-org/seu-repo` **#123**) apareceu sem os checks
`ci / lint-and-typecheck`, `ci / unit`, `ci / integration` e
`guardiao-de-regressoes`. **A causa NÃO é o InHouse.** É uma **pane do GitHub
Actions** em andamento no momento (incidente `qcvjkzcs7j74`, "Incident with
Actions — Critical", início **06/08 15:22 UTC**). Durante a pane, workflows
disparados por `pull_request` (que rodam em GitHub-hosted runners) não são
agendados/iniciados. O PR do InHouse só teve o azar de cair dentro da janela.

**Ação:** aguardar o GitHub normalizar (githubstatus.com) e re-disparar os PRs
afetados com um push novo ou `gh pr close/reopen`. Sem `--bypass` de review
enquanto não houver CI real.

---

## Evidência (por que é a pane, e não o InHouse)

- Nenhum run de `ci` ou `guardiao` disparou em **nenhuma branch** do repo desde
  **13:40 UTC** (última janela com atividade antes da pane às 15:22).
- **Não é específico do InHouse:** os PRs **#171 e #175** (autora `ingridpitta`,
  branches normais, feitas à mão), atualizados **depois** das 15:22, estão
  igualmente sem `ci`/`guardiao` — só Vercel e CodeQL (esse último saindo
  `CANCELLED`/`PENDING`, coerente com "queued jobs timing out").
- Um **push manual normal** (`synchronize`, feito por admin via git puro) na
  branch do #123 **também não** disparou o `ci`. Ou seja: o gatilho está quebrado
  no lado do GitHub, independe de como o PR nasceu.
- Os checks que aparecem sobrevivem porque não dependem dos runners comuns:
  Vercel é integração externa; CodeQL/Copilot são "default setup" (`event=dynamic`).
- GitHub Status no momento: **Actions = Major Outage**; update das 18:46 UTC:
  *"Recovery is taking longer than we expected."*

### Hipóteses descartadas na investigação
- **Token/bot suprimindo workflows** (o clássico `GITHUB_TOKEN`): descartado — o
  PR foi aberto por um usuário real (login pessoal via `gh`), token OAuth com escopo
  `workflow`.
- **Permissão/policy do repo:** descartado — Actions `enabled`, `allowed_actions: all`,
  autor é **admin** (sem gate de first-time contributor).
- **Arquivo de workflow ausente/diferente:** descartado — `ci.yml` e
  `guardiao-regressoes.yml` **existem** na branch e são **byte-a-byte idênticos**
  ao `main`; `ci.yml` roda normalmente em todo outro PR (antes da pane).
- **Conflito de merge impedindo o merge-ref:** descartado — `refs/pull/174/merge`
  foi computado limpo; `git merge-tree` não acusa conflito; PR `MERGEABLE`.
- **Workflow desabilitado:** descartado — todos `state=active`.

### Observação à parte (não é a causa)
`esteira / tiers` não rodaria de qualquer forma: o `esteira.yml` ainda **não está
no `main`**, só vive na branch do PR #173. Um PR comum baseado em `main` hoje só
ganha essa checagem depois que o #173 for mergeado.

---

## O que já foi feito

- `gh pr close 174 && gh pr reopen 174` (evento `reopened`) — sem efeito (pane).
- Commit vazio `66c2e9aa` empurrado na branch pra forçar `synchronize` — sem
  efeito imediato (runners fora), mas deixa o PR "armado" pra quando o Actions
  voltar. **É um commit descartável**; o repo usa *squash-and-merge*, então não
  polui histórico. Pode ser removido/ignorado.

---

## Endurecimento OPCIONAL do InHouse (NÃO era a causa deste incidente)

A investigação revelou, de passagem, uma fragilidade real que vale considerar —
mas **sem relação com a pane**:

1. **Branch nascida de `main` local desatualizado.** A branch do #123 tinha
   merge-base **35 commits atrás** do `origin/main` (faltava até o
   `claude-dev-agent.yml`). Isso não quebra o CI, mas produz PRs cronicamente
   defasados e sujeitos a conflito/surpresa no merge.
   - **Onde olhar:** a criação do espaço/worktree (`server/services/worktrees.ts`,
     `createEspaco`) — garantir `git fetch origin` e basear o espaço em
     `origin/<defaultBranch>` atualizado, não no checkout local.
   - `server/services/publish.ts` já foi reescrito para "Caminho A" (PR-only, sem
     tocar o `main`); o ponto acima é sobre **de onde a branch parte**, upstream
     do publish.

2. **(Menor) Verificar checks pós-PR.** Opcional: após `gh pr create`, conferir
   se os checks foram agendados e avisar se não. Teria, aqui, apenas *revelado* a
   pane — não corrigido. Baixa prioridade.

> Recomendação: tratar o item 1 como melhoria de robustez num PR próprio, sem
> vincular a este incidente. O incidente em si **se resolve sozinho** quando o
> GitHub Actions normalizar.
