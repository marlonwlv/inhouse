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
- [Primeira versão para o Product Designer testar](release/primeira-versao-product-designer.md) — handoff da v1 testável (Mac, seu-monorepo real). **Status: Concluído** (2026-08-06).

### features
- [Eval de Experiência](features/eval-de-experiencia.md) — captura/lembra/ranqueia atritos sozinho (métricas + Claude-juiz + aprendizados). **Status: Concluído** (2026-08-06).

### design
- [Redesign visual](design/redesign-visual.md) — moderno light & clean → accent monocromático → audit impeccable (UI v0.4.2). **Status: Concluído** (2026-08-06).
