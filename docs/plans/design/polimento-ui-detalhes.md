# Inhouse — Polimento de UI (detalhes que incomodam)

> **Categoria:** design · **Criado:** 2026-08-06 · **Status:** Concluído (2026-08-06)
> Continuação do [Redesign visual](redesign-visual.md) (UI v0.4.2). Foco: erros finos de layout/render, não redesenho. Respeita a linguagem já decidida: monocromático, borda-primeiro, âmbar/vermelho **semânticos**, losango = porteira humana. Passou por `plan-design-review` (7 dimensões + voz de design independente); decisões D3–D8 resolvidas com o Marlon.
>
> **Resultado:** T1–T6 + F8 (tooltip do stepper) implementados em `public/styles.css` + `public/app.js`; T7 deferido (TODO P3). Validado: `tsc --noEmit` verde, **159 testes verdes** (inclui `ui-static.test.ts`), `impeccable detect` sem regressão (mesmos 2 flags intencionais), verificação visual nos 2 temas + app rodando (porta 4455). Emojis: só o 🟢 do Auto virou dot mono (resto mantido, por preferência do Marlon).

## Método
1. **Diagnóstico página-por-página.** ✅
2. **`plan-design-review`** (7 dimensões) + **voz de design independente** (subagente, Codex indisponível). ✅
3. **`impeccable detect`** — baseline determinística. ✅ (2 flags intencionais, ver abaixo)
4. **Preview HTML real** (styles.css de verdade, 2 temas, todos os estados) para validar antes de implementar.
5. **Implementar** com typecheck + testes verdes.

## Onde a UI vive
Frontend vanilla em `public/`: `index.html`, `styles.css` (891 linhas), `app.js` (1795 linhas). Telas: **Início** (`renderHome`), **Tarefas/quadro** (`renderBoard`), **Editor** (`renderEditor`+`renderChat`+preview), **Experiência** (`renderExperiencia`). Stepper = um único `flowHtml` (app.js:737) em 2 contextos (card do quadro com rótulos; faixa `.flow-strip` do editor).

---

## Correções (spec final)

### F1 — Chevron do `<select>` próprio, monocromático *(bug #1 · D5=A, corrigido por B2)*
`<select>` nativo sem `appearance:none` desenha a seta dentro dos 12px de padding → colada. Instâncias: `#project-select` (app.js:916), `#eval-fonte` (app.js:556).

**⚠️ Correção técnica:** `currentColor` **não resolve** dentro de um `background-image` SVG (documento isolado). `mask-image` no próprio `<select>` mascararia a caixa inteira (não dá pra pseudo-elemento confiável em select). **Caminho certo:** dois SVGs trocados por tema via `background-image` + override `[data-theme="dark"]`.

```css
/* nova regra, DEPOIS da regra base de select (styles.css:258-266) */
select {
  appearance: none; -webkit-appearance: none;
  padding-right: 32px;                    /* reserva p/ o chevron */
  background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%2352525B' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M3 4.5 6 7.5 9 4.5'/></svg>");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px;
  cursor: pointer;                        /* D3: afordância após tirar a seta nativa */
}
:root[data-theme="dark"] select {
  background-image: url("data:image/svg+xml,<svg ... stroke='%23A1A1AA' ...>");  /* --muted escuro */
}
.repo-pick { padding: 7px 32px 7px 12px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
```
- Cor `--muted` (#52525B / #A1A1AA) — `--faint` é fraco demais p/ AA. Peso 1.5 casa com a borda 1–2px; 12px casa com a escala de micro-ícone sob texto 14px. **Estático** (sem hover/rotação → reduced-motion trivial). `:focus-visible` (styles.css:252) **preservado** sob `appearance:none`.
- **A3:** `title` com o nome completo em `#project-select` e `#eval-fonte` (app.js) p/ nomes longos (47-char) que o box de 280px corta.

### F2 — Headroom do losango *(bug #2 · corrigido por B1)*
Pin 15×15 girado 45° estoura ~3px; no `.human.now` o glow `box-shadow:0 0 0 4px` chega a **−8.76px** acima da caixa. `.flow-wrap{overflow-x:auto}` faz `overflow-y` clipar. `padding:8px` do rascunho **ainda cortaria ~0.8px**.

```css
.flow-wrap { overflow-x: auto; padding: 10px 4px; }   /* 10px cobre 8.76px c/ folga; 4px = folga de scroll (A6) */
```
Verificar nos 2 contextos × 2 temas × estados: `.now`, `.human.now` (âmbar), `.now.fail` (vermelho), `.human.now.fail` (losango vermelho).

### F3 — Porteira que falha mostra a cor certa *(bug NOVO achado no review · D1, crítico)*
Cascata: `.step.human.now .pin` (esp. 0-3-1) **vence** `.step.fail .pin` (0-2-1), então um `publicar`/`teste` que falha mantém o anel **âmbar** ("sua vez") em vez de **vermelho** ("falhou") — semântica de cor invertida. `flowHtml` gera `step human now fail` (app.js:753).

```css
/* DEPOIS das regras .step.human.now (styles.css:341-343) */
.step.human.now.fail .pin { border-color: var(--danger); box-shadow: 0 0 0 4px var(--danger-soft); }
.step.human.now.fail .pin::after { background: var(--danger); }
.step.human.now.fail span { color: var(--danger); }
```

### F4 — Faixa compacta = só pinos + rótulo do atual *(bug #3 · D3=B, C1)*
Barra fina do editor, 11 etapas: hoje `min-width:56px` < rótulos longos → colisão. Numa barra de status o trabalho é **orientação**, não ler cada nome (os nomes já vivem no card do quadro). Só-pinos faz os **losangos (porteiras)** virarem o ritmo visual — o que o design manda destacar — e elimina a colisão de vez.

```css
/* substitui styles.css:575-576 */
.flow-strip .flow { min-width: 0; }
.flow-strip .flow .step { min-width: 0; flex: none; }      /* nunca comprime (backstop do A) */
.flow-strip .step span, .flow-strip .step .step-dur { display: none; }  /* só pinos */
.flow-strip .flow-wrap { flex: 1; }                        /* barras preenchem a largura */
```
- app.js:1089 (prefixo): `Onde essa tarefa está: <b>${STEP_LABELS[t.step]}</b>` (o passo atual vira o rótulo). `nextGateChip` continua mostrando a próxima porteira.
- `flowHtml`: `title="${STEP_LABELS[s]}"` por pino (hover) — ajuda também o card do quadro.
- **B3:** só-pinos ainda derruba a altura da faixa (sem rótulo/dur), compensando os +20px do headroom.

### F5 — Emojis: só matar o verde (revisado após o preview)
No preview o Marlon preferiu o **antes** dos emojis (o calor é proposital, público não-técnico). A **única** mudança: o 🟢 do "Auto" — verde é 3ª cor semântica (proibida) e sinal errado p/ um modo que pula porteiras — vira um **dot monocromático**, não some.

| Emoji | Onde | Ação |
|---|---|---|
| 🟢 Auto ligado | app.js:967 | **Trocar por dot mono**: `<span class="dot"></span> Auto ligado`. Como o botão é `.primary` (fundo escuro) quando ligado, o dot precisa ser `--brand-ink` → nova regra `.btn.primary .dot { background: var(--brand-ink); }` (mesmo padrão da `.update-pill .dot`). |
| 🛠️ Preparar (930, 988) · ⏱ tempo (756, 1003) · 😃😐😖 card (533) · 😃😐😖 feedback (1043, ~1206) | app.js | **Manter** — calor proposital que o Marlon quis preservar. |

### F6 — Contraste dos labels de passo *(D8=A · D2 do review)*
`.step span { color: var(--faint) }` (#8E8E97 ≈ 2.9:1) falha AA. → `var(--muted)` (#52525B ≈ 7:1). Afeta rótulos em repouso no card do quadro (na faixa somem). styles.css:332.

### F8 — Tooltip do stepper (follow-up pedido no preview ao vivo)
O `title` nativo dos pinos era lento/inconsistente e o `overflow` do `.flow-wrap` atrapalhava. Trocado por tooltip própria: `data-step` em cada `.step`, `STEP_INFO` (o que a etapa faz + skills que dispara, espelhando `templates/app-starter/inhouse.config.json`) e um popover **preso ao `<body>`** — imune ao overflow, `pointer-events:none`, reposiciona por `getBoundingClientRect` e vira pra cima se não couber. Vale nos 2 contextos, delegado no document (sobrevive aos re-renders do SSE). Skills mostradas: Plano→`office-hours` (grande); Detalhamento→`plan-eng-review` (+`plan-design-review` c/ UI); Verificações→`review` (+`qa` c/ UI); porteiras humanas = "espera você". `styles.css` `.steptip*` + `app.js` `STEP_INFO`/`showStepTip`.

---

## Tabela de estados de interação (Pass 2)
| Componente | Loading | Empty | Error/Fail | Now/Success |
|---|---|---|---|---|
| Stepper (card) | — (só tarefa ativa renderiza) | passos futuros = anel cinza | **F3**: `.now.fail`/`.human.now.fail` vermelho, sem corte (F2) | `.now` anel de brand; `.human.now` losango âmbar |
| Faixa (editor) | idem | idem, só-pinos | pino vermelho no atual | pino brand + rótulo no prefixo |
| `select` | 1 projeto: não é escolha real (P3, ver TODO) | 0 projetos: box vazio (P3) | — | chevron mono, `title` p/ nome longo |
| Auto toggle | — | — | — | on = `.primary` preenchido + dot mono (`--brand-ink`) |

## Baseline `impeccable detect`
`npx impeccable detect public/` → 2 flags (`single-font`, `flat-type-hierarchy`), ambos em `index.html`, **intencionais** e documentados na v0.4.2 (escala funcional de tool denso; Onest fora da lista de "slop fonts"). **Manter.** Limitação: o detector lê o DOM do `index.html`; as telas são template strings no `app.js` que ele não parseia — por isso a voz de design independente (que leu o código) foi a lente forte aqui.

## O que já existe (reusar)
Tokens de cor/raio/sombra e o design system em `styles.css`; `redesign-visual.md` como DESIGN.md de fato; classes `.step/.pin/.flow*`, `.chip`, `.btn.primary`. Contrato de classes `app.js ↔ styles.css` deve ficar intacto (mudanças por CSS + ajustes cirúrgicos no template).

## NÃO está no escopo
- Refazer a escala tipográfica (`flat-type-hierarchy`) — decisão intencional.
- Trocar Onest / adicionar fonte display (`single-font`) — intencional.
- Auto-esconder `#project-select` com <2 projetos (A4) — vira TODO P3.
- Redesenho de qualquer tela; só polimento.

## Verificação (DoD)
- Chevron com respiro em `#project-select` e `#eval-fonte`, claro **e** escuro; `:focus-visible` intacto; `title` em nome longo.
- Losango inteiro (vértice + glow âmbar/brand/**vermelho**) nos 2 contextos e temas, sem corte.
- Porteira que falha = vermelha (não âmbar).
- Faixa "Onde essa tarefa está" sem colisão em qualquer largura; só-pinos + rótulo do atual no prefixo.
- Emojis conforme F5; labels em `--muted`.
- `npm run typecheck` + `npm test` verdes; contrato de classes intacto; revisão visual 4 telas × 2 temas.

## Implementation Tasks
Sintetizadas das descobertas. P1 bloqueia ship; P2 mesma branch; P3 follow-up.

- [ ] **T1 (P1, human: ~20min / CC: ~5min)** — select — chevron próprio mono + `padding-right:32px` + `cursor:pointer` + override dark; `title` nos 2 selects.
  - Surfaced by: bug #1 + Pass 5/B2/A3. Files: `public/styles.css`, `public/app.js`. Verify: preview 2 temas + focus ring.
- [ ] **T2 (P1, human: ~10min / CC: ~3min)** — stepper — `.flow-wrap { padding:10px 4px }` (headroom losango + glow).
  - Surfaced by: bug #2 + B1. Files: `public/styles.css`. Verify: preview estados now/human/fail 2 temas.
- [ ] **T3 (P1, human: ~15min / CC: ~5min)** — stepper — regra `.step.human.now.fail` (cor vermelha na porteira que falha).
  - Surfaced by: D1 (review). Files: `public/styles.css`. Verify: forçar status falhou em passo humano.
- [ ] **T4 (P1, human: ~30min / CC: ~10min)** — faixa editor — só-pinos + rótulo do atual no prefixo + `title` por pino.
  - Surfaced by: bug #3 + C1. Files: `public/styles.css`, `public/app.js`. Verify: 11 passos sem colisão em larguras variadas.
- [ ] **T5 (P2, human: ~10min / CC: ~3min)** — Auto toggle — 🟢 → `<span class="dot"></span>` + regra `.btn.primary .dot { background: var(--brand-ink) }`. Demais emojis ficam.
  - Surfaced by: D7 revisado no preview. Files: `public/app.js`, `public/styles.css`. Verify: dot branco visível no botão ligado; nada mais de emoji mexido.
- [ ] **T6 (P2, human: ~5min / CC: ~2min)** — labels — `.step span` `--faint`→`--muted`.
  - Surfaced by: D2/D8. Files: `public/styles.css`. Verify: contraste AA no card.
- [ ] **T7 (P3, follow-up)** — `#project-select` com <2 projetos (A4): esconder/desabilitar ou label estático. TODO.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | não aplicável (polimento) |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | indisponível | Codex não instalado; voz de design via subagente Claude |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | recomendado antes do ship |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | issues_open→resolved | score 7/10 → 9/10, 6 decisões (D3–D8), 1 bug crítico achado (D1) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | não aplicável |

- **CROSS-MODEL:** voz de design independente (subagente) achou o bug de cascata da cor (porteira que falha aparece âmbar), corrigiu a técnica do chevron (`currentColor` inviável em background-image) e o valor do headroom (8px→10px). Absorvidos como F1–F3.
- **VERDICT:** DESIGN CLEARED (9/10) — pronto pra implementar. Eng review recomendado antes do ship.

**UNRESOLVED DECISIONS:**
- T7 (A4): comportamento do `#project-select` com menos de 2 projetos — deferido como TODO P3.
