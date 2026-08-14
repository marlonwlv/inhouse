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
- [Próximas melhorias](features/proximas-melhorias.md) — aviso de versão nova, setup guiado do repo, arquivar tarefas e esteira de plano em fases (Plano→aprovação→Detalhamento→Protótipo). **Status: Concluído** (2026-08-06).
- [Preview confiável](features/preview-confiavel.md) — o agente prepara e exercita o preview no fim das Verificações; o usuário só vê preview funcionando no "Seu teste" (health-check por rota + receita com setup/healthPaths). **Status: Concluído (Fase 1)** (2026-08-06).
- [Preview — Transparência + Controle](features/preview-transparencia-controle.md) — quando o preview falha, a UI mostra o erro técnico real (status HTTP + rota + trecho do corpo) e os logs do dev server; botão "Reiniciar preview". Fase 2 absorvida por [Preview 10x](features/preview-10x-agente-pilota.md). **Status: Concluído (Fundação)** (2026-08-10).
- [Inhouse instalável no Mac — app de menu bar](features/app-mac-menu-bar.md) — DMG com launcher ObjC + servidor tsc + runtime Node embutido (npm incluso); reusa um Inhouse já aberto; `npm run build:mac`; DMGs publicados no Release v0.1.0. **Status: Concluído** (2026-08-13).
- [Porteira viva — conversar sem sair da etapa](features/porteira-viva-conversa.md) — mensagem numa porteira/falha abre conversa neutra; a esteira transiciona AO VIVO quando o agente usa a primeira ferramenta de trabalho (o gate de permissões como sensor de intenção); na aprovação, o plano revisa via ExitPlanMode sem replano. **Status: Em andamento** (2026-08-13).
- [Preview 10x — o agente enxerga e pilota o preview](features/preview-10x-agente-pilota.md) — ferramentas MCP in-process (status/logs/reiniciar/reportar rota) + estado do preview nos prompts; crash visível com conserto automático (cap 2); verificação leve mantém o preview vivo no conserto; UI simples com view avançada. **Status: Em andamento** (2026-08-13).
- [Debug Suite da Esteira](features/debug-suite-workflow.md) — modelo fake atrás de `INHOUSE_FAKE_MODEL` + catálogo de cenários + runner headless (`npm run debug`) + painel na UI (`npm run dev:fake`), para testar as jornadas de ponta a ponta sem gastar LLM. **Status: Concluído** (2026-08-06).
- [Melhorias de usabilidade: relatório, caixa de texto, pausar, anexos e artefatos](features/melhorias-usabilidade-relatorio-anexos.md) — fix do "Gerar análise"; caixa de tarefa multilinha (Shift+Enter); botão Pausar; anexar arquivos (imagem/pdf) ao prompt; barra de artefatos (espec/plano/protótipo/docs) sempre acessível. **Status: Em andamento** (2026-08-07).
- [Workflows configuráveis + Modo Livre](features/workflows-e-modo-livre.md) — tarefa sem esteira (Modo Livre: o usuário conduz o Claude e escolhe as skills no prompt) + tela Configurações→Workflows (AI-first com conversa iterativa + drawer de edição manual, skills de lista fixa, porteiras ligáveis/desligáveis). **Status: Concluído (Modo Livre + Workflows incr. 1–3)** (2026-08-09).
- [Arquivar / Excluir projetos](features/arquivar-excluir-projetos.md) — seção "Meus projetos" ganha arquivar (suave, reversível) e excluir (com guardrails escalonados: nunca apaga a pasta de um projeto "aberto no lugar"; digitar o nome quando a perda é irreversível). **Status: Concluído** (2026-08-09).
- [Indicador de pensamento no chat](features/indicador-pensamento-chat.md) — "Pensando…" com brilho no fim do transcript enquanto o Claude trabalha em silêncio; o verbo segue os eventos reais ("Fazendo a mudança…", "Rodando as verificações…") e ganha cronômetro após 45s na mesma atividade; protótipo com 5 opções em `mockups/indicador-pensamento/`. **Status: Concluído** (2026-08-14).
- [Estabilidade: espaço, sobrecarga e modelo/effort](features/estabilidade-espaco-sobrecarga-modelo.md) — numeração de espaço monotônica (fim da worktree destruída no reuso); isolar dev + limitador global de concorrência + restart sem órfãos (fim do EAGAIN/ETXTBSY sob carga); e chip de modelo(s)+effort na tarefa. **Status: Em andamento** (2026-08-09).

### design
- [Redesign visual](design/redesign-visual.md) — moderno light & clean → accent monocromático → audit impeccable (UI v0.4.2). **Status: Concluído** (2026-08-06).
- [Polimento de UI (detalhes)](design/polimento-ui-detalhes.md) — chevron colado, losango cortado, etapas encavaladas + porteira-que-falha (bug de cor) + emojis; diagnóstico → design review (7 dim + voz independente) → implementação. **Status: Concluído** (2026-08-06).
