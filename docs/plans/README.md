# Planos do Inhouse

Todos os planos (roadmaps, propostas de feature, design docs, decisões) vivem **aqui, versionados no git** — não em `~/.claude/plans` (que é rascunho efêmero e não sobrevive a outras sessões ou máquinas). A regra completa está no `CLAUDE.md` da raiz.

## Organização

Planos ficam em subpastas por **categoria**. Crie novas categorias quando fizer sentido.

- `release/` — planos para entregar/versionar/handoff de uma versão.
- `features/` — planos de uma funcionalidade específica.
- `design/` — design / redesign / design system.
- `architecture/` — decisões estruturais.

Nome do arquivo: **kebab-case descritivo** (ex.: `primeira-versao-product-designer.md`).
Cada plano abre com um cabeçalho: **título · categoria · data (YYYY-MM-DD) · status** (`Proposto` | `Em andamento` | `Concluído` | `Arquivado`).

## Índice

### release
- [Primeira versão para o Product Designer testar](release/primeira-versao-product-designer.md) — handoff da v1 testável (Mac, seu-monorepo real). **Status: Proposto** (2026-08-06).
