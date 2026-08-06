# Inhouse — instruções do repositório

Inhouse é um **app builder local** (server Node/TS + UI web vanilla) que orquestra o Claude Code da máquina do usuário numa esteira de tarefas com porteiras humanas, para pessoas não-técnicas criarem/alterarem apps com segurança. Detalhes técnicos: `ARCHITECTURE.md`. Como rodar: `README.md`.

## Regra: planos ficam em `docs/plans/` (versionados no repo)

**Todo plano DEVE ser salvo em `docs/plans/` neste repositório** — versionado no git, para sobreviver a sessões de contexto limpo e ficar visível ao time. Vale para: planos de plan mode, roadmaps, propostas de feature, design docs e decisões de arquitetura. **Nunca** deixe um plano só em `~/.claude/plans/` (é rascunho efêmero).

Como armazenar, de forma organizada:
- **Subpastas por categoria**: `release/`, `features/`, `design/`, `architecture/`. **Crie novas categorias** (novas pastas) quando um plano não encaixar nas existentes.
- **Nome do arquivo**: kebab-case descritivo (ex.: `primeira-versao-product-designer.md`).
- **Cabeçalho** no topo de cada plano: título, categoria, data (`YYYY-MM-DD`) e status (`Proposto` | `Em andamento` | `Concluído` | `Arquivado`).
- **Índice**: mantenha `docs/plans/README.md` atualizado — adicione/edite a linha do plano ao criar ou mudar seu status.

Fluxo com **plan mode**: ao concluir/aprovar um plano, **salve o conteúdo em `docs/plans/<categoria>/<slug>.md`** e atualize o índice. O arquivo temporário do plan mode (`~/.claude/plans/*.md`) é só rascunho de trabalho.

Ao **retomar ou revisar** um plano existente, edite o arquivo em `docs/plans/` (não crie duplicata) e ajuste o status — não comece um plano novo se já existe um para o mesmo tema.
