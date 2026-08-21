# Navegação multi-projeto — quadro unificado + abas de trabalho

- **Categoria:** design
- **Data:** 2026-08-14
- **Status:** Em andamento — PR [#11](https://github.com/marlonwlv/inhouse/pull/11) aberto (branch `feat/navegacao-multi-projeto`, worktree `../inhouse-navegacao`). Revisão de código feita em 2026-08-18: 13 correções aplicadas em `e736f06` (projeto arquivado deixando o quadro vazio e as contagens mentindo, lista do popover reordenando sob o cursor a cada evento SSE, nome de projeto vazio derrubando o render, rolagem perdida a cada re-render) e a lógica pura de validação do `localStorage` saiu para `public/puro.js` com testes — 285 testes passando. Falta verificação manual no navegador e o merge.

## Dores

1. **Editor:** a única navegação é o "←" de volta — trocar de tarefa custa 2–3 telas, e mais o dropdown se a tarefa for de outro projeto.
2. **Quadro:** o dropdown mostra **um projeto por vez** — o resto do estúdio fica invisível, e uma tarefa "sua vez" de outro projeto passa despercebida.

## Processo e decisão

Baixa fidelidade com 3 direções (`mockups/navegacao-multi-projeto/lofi-opcoes.html`):
**A** Trilho lateral · **B** Quadro unificado + salto rápido · **C** Abas de trabalho + colunas por projeto.

**Decisão do Marlon: combinar B (quadro) + C (editor).** Sem colunas da C e sem o seletor-no-título da B. Protótipo navegável em alta fidelidade, com o design system real: `mockups/navegacao-multi-projeto/index.html`.

## O que muda

### Quadro (direção B)
- **Morre o dropdown de projeto.** O quadro nasce em "Todos": lista única agrupada por projeto, cabeçalho de grupo **sticky** (ícone + nome + contagem + "+ tarefa").
- **Chips de filtro** no topo: `Todos · N` / um por projeto (com contagem) / **◆ Sua vez**, que atravessa projetos e mostra só o que espera o usuário (mantém os grupos visíveis — só filtra cards).
- **Composer com endereço**: "em: \<projeto\> ▾" escolhe o projeto da nova tarefa ali mesmo (pré-selecionado o último usado). O "+ tarefa" do grupo abre o composer já endereçado.

### Editor (direção C)
- **Faixa de abas global** sob a appbar, visível em Tarefas + editor (some em Início/Experiência/Configurações). "Tarefas" é a aba-casa; cada tarefa aberta vira aba com selo do projeto.
- **Estado ao vivo na aba**: ● pulsando (brand) = Claude trabalhando · **◆ âmbar = sua vez** (mesma linguagem dos losangos da esteira) · ✓ = concluída.
- **Trocar de tarefa = 1 clique na aba**, inclusive entre projetos. Abrir um card adiciona a aba; ✕ fecha só a aba (a tarefa continua).
- **Sai o "←"** do editor — a aba-casa está sempre no mesmo lugar.

## Decisões de implementação sugeridas

- Abas persistem em `localStorage` (`inhouse.abas`); sobrevivem ao reload, por máquina.
- Abrir tarefa (card, link ou URL direta) adiciona a aba se não existir; concluir/arquivar **não** fecha sozinho — a aba mostra ✓ e o usuário fecha quando quiser.
- ~6 abas com ellipsis; excedente rola horizontalmente. O **"+" da faixa** abre o popover de busca: lista de tarefas (sua vez primeiro), filtro por texto (sem acento) e por projeto, Enter abre a primeira; rodapé "Criar nova tarefa…" leva ao composer já endereçado.
- Pontos de código: `renderBoard()` (filtros + grupos, fim do `#project-select`), `renderEditor()` (sem "←"), shell novo da faixa de abas em `index.html`/`app.js`, estado de abas no client (não vai para `state.json`).

## Fora da v1 (evolução natural)

- **⌘K** — busca global de tarefas/projetos (veio da direção B; encaixa em qualquer layout).
- **Colunas por projeto** no quadro (metade não adotada da C).
- Trilho lateral (direção A) segue como candidato se o número de projetos vivos crescer muito.

## Mockups

- Baixa fidelidade (3 opções + comparação): `docs/plans/mockups/navegacao-multi-projeto/lofi-opcoes.html`
- Alta fidelidade navegável (decisão): `docs/plans/mockups/navegacao-multi-projeto/index.html`
