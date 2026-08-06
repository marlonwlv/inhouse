# Inhouse — Redesign visual (moderno, light & clean → monocromático)

> **Categoria:** design · **Criado:** 2026-08-06 · **Status:** Concluído
> Registro retroativo. Redesign guiado por benchmark de IDEs/dev tools, depois accent monocromático, depois audit do impeccable. Estado final: UI v0.4.2.

## Contexto

O Marlon queria o Inhouse **moderno, light e clean**, referenciado nas melhores IDEs/dev tools do mercado. Evoluiu em três iterações (design system → accent preto → audit).

## Benchmark (referências)
- **Linear** — Inter, neutros, peso 510 característico, borda 1px sutil.
- **Vercel/Geist** — filosofia **borda-primeiro**: a maioria dos elementos definida por borda 1px, sombra reservada para overlays; neutros realmente neutros.

## Iteração 1 — Design system (v0.4.0)
- Neutros zinc-like (não mais com viés verde), superfícies branco/quase-branco.
- **Fontes bundladas localmente (offline)**: Inter Variable (UI) + JetBrains Mono (código).
- **Borda-primeiro**: sombras quase invisíveis (`--shadow-sm`), fortes só em toast/diálogo.
- **Tema claro por padrão + toggle para escuro**: `data-theme` no `<html>`, persistido em `localStorage`, script anti-flash no `<head>`.
- Refino de tipografia (pesos 550/600/700, tracking negativo), raios, focus-ring suave, transições sutis, hover states, favicon "In".
- Todo o contrato de classes `app.js ↔ styles.css` preservado (redesign via tokens + ajustes cirúrgicos).

## Iteração 2 — Accent monocromático (v0.4.1)
O verde não era a cor real da Inhouse e não precisava ser verde. Trocado por **monocromático**: `--brand` = preto `#18181B` no claro / branco `#F4F4F5` no escuro. Resultado: **âmbar e vermelho viram as únicas cores** da interface (semânticas: "sua vez" / "problema"), então as porteiras humanas saltam naturalmente. Estilo Vercel/Linear. Favicon preto.

## Iteração 3 — Audit do impeccable (v0.4.2)
Instalado o **impeccable** (github.com/pbakaus/impeccable, `npx impeccable detect public/`, 59 regras determinísticas). **11 → 1 anti-padrões.** Fixes:
- **Fonte Inter → Onest**: o `OVERUSED_FONTS` do impeccable inclui Inter, Geist, Mona Sans, Roboto…; Onest/Hanken/Schibsted **não** estão na lista. Onest é limpa e neutra (ótima p/ UI) e passa no audit.
- **Contraste âmbar AA**: `#B0680E` → `#8A4E06` (6:1 no amber-soft, 6.6:1 no branco).
- **Removidas TODAS as bordas-laterais 3px** dos cartões (`.task/.approval/.publish-card/.exp-apr`) — o impeccable aponta isso como o "tell nº 1 de UI feita por IA". Status agora vive nos chips.
- **Dots pulsantes → estáticos** (o anel + label já sinalizam; mais honesto/calmo).
- **Sem transição de `width`** (evita layout thrash).
- Escala de tipo consolidada (5 → 3 tamanhos no cluster pequeno).
- **1 flag mantido de propósito** (`flat-type-hierarchy`): é heurística de landing page (quer saltos de 1.25× entre tamanhos); 12/13/15px é escala funcional legítima de tool denso — forçar deixaria botões/labels grandes demais. Decisão documentada.

## Decisões de processo
- A skill "impecable" pedida era o **impeccable** (ferramenta do GitHub), não uma skill do gstack.
- `plan-design-review` do gstack é **interativa** — não usada (o Marlon estava dormindo, travaria esperando respostas). O **design-review** foi feito manualmente via screenshots das 4 telas × 2 temas (equivalente ao olho de designer).

## Resultado
- 4 telas (Início, Tarefas, Editor, Experiência) × tema claro e escuro, sem erros de console; toggle e navegação OK; acentos pt-BR renderizando no Onest.
- 108 testes verdes; contrato de classes intacto.

Arquivos: `public/index.html`, `public/styles.css`, `public/app.js`, `public/fonts/{onest,jetbrains-mono}.woff2`.
