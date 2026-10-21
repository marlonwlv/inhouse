# GitHub mágico: abrir repositório privado sem terminal

- **Categoria:** features
- **Data:** 2026-10-21
- **Status:** Em andamento

## Problema

No treinamento ao vivo, "Baixar e abrir" de um repositório privado (monorepo da Lipe) falhou e a tela falou em falta de internet. O hotfix (PR #16) corrigiu a mensagem e passou a usar a conta do `gh` no clone. Mas ainda era preciso abrir o Terminal e rodar `gh auth login`, e quem não é técnico trava aí.

## Objetivo

A pessoa cola o link e o InHouse faz o resto, mostrando cada passo num checklist ao vivo (no mesmo visual de Preparar o computador):

1. **GitHub CLI**: confere se está instalado e instala se faltar (instalador portátil do setup, sem senha).
2. **Login no GitHub**: se faltar, roda `gh auth login --web` e mostra o código grande, com botão Copiar e link para github.com/login/device. Detecta sozinho quando o login termina.
3. **Ligar o Git à conta**: confere que o `gh` entrega a credencial (`gh auth token`). O clone usa o helper do gh só no comando e grava esse helper na config **local** do repositório. A config global da pessoa não é alterada.
4. **Acesso**: `gh repo view dono/repo`.
5. **Baixar**: o `git clone` do hotfix, com progresso.

Se o repositório for público, um `git ls-remote` anônimo (sem credencial) responde, e os passos 1 a 4 aparecem como "não precisa".

## Quando falha, o InHouse ensina

- **Sem acesso**: mostra a conta logada e um texto pronto, com botão Copiar, para pedir acesso ao dono do repositório ou a um administrador da organização. Também oferece **Entrar com outra conta**, para o caso de conta errada.
- **Rede**: só aqui se fala em internet/VPN.
- **Login automático falhou** (ou a instalação do gh): mostra o passo a passo manual (abrir o Terminal, `gh auth login`, `gh auth setup-git`, com o caminho do gh portátil quando ele não está no PATH) e o botão **Tentar de novo**.

## Preparar o computador

O item "Login no GitHub" deixa de ser manual: o botão **Entrar no GitHub** usa o mesmo login por código (mesmo cartão).

## Desenho técnico

- `server/setup/loginGh.ts` (`LoginGitHub`): segue o padrão do `LoginClaude`. Lê o código e a URL do stderr, troca `BROWSER` por um no-op (a UI abre a página), confirma com `gh auth status` e expira em 15 min.
- `MotorSetup` ganha `iniciarLoginGh`, `cancelarLoginGh` e `observarLoginGh`. `SetupStatus.loginGh` é usado pelo cartão. `SetupItem.acao` ganha `"login_gh"`.
- `server/services/abrirGithub.ts` (`AssistenteClone`): máquina de passos com dependências injetáveis (real e demonstração). O job (`CloneJob.passos`, `CloneJob.login`, `CloneJob.erro.ajuda`) chega à UI pelo SSE `clone_status`.
- Rotas novas:
  - `POST /api/setup/github/login` e `POST /api/setup/github/cancelar`;
  - `POST /api/projects/clone/:id/retomar` (Tentar de novo / outra conta);
  - `POST /api/projects/clone/demo` (só no modo de demonstração).
- **Modo demonstração** (`INHOUSE_SETUP_DEMO=1`): cenários do download na home (público, mágico completo, sem acesso, rede, login falhou, instalação falhou) e do login do GitHub em Preparar. Nada é instalado nem baixado.

## Testes

Com mocks por SO: parser do código e URL do `gh`, `LoginGitHub` (ok, erro, timeout, cancelar), `AssistenteClone` (público, privado com tudo faltando, sem acesso, rede, login falhou) e texto pronto do pedido de acesso.

## Desenho da interface (decidido no /plan-design-review)

Superfície de app (OPERAR): reusa o vocabulário de Preparar o computador (`.pp-item`, `.pp-ico`, `.pp-card`, `.pp-det`, tokens `--ink`, `--line`, `--ground`, `--danger`). Nada de componente novo além do **cartão do código** e do **painel de ajuda**.

### Hierarquia do cartão "Abrir do GitHub" durante o download

```
┌ Abrir do GitHub ────────────────────────────────────┐
│ [ https://github.com/lipe/monorepo ] [⟳ Baixando…]  │  1º: o link e o estado do botão
│ ✓ GitHub CLI            Pronto.                       │
│ ● Entrar no GitHub      Falta entrar na sua conta.   │  2º: o passo ativo (o único com cor)
│   ┌──────────────────────────────────────────────┐   │
│   │  WDJB-MJHT   [Copiar]                        │   │  3º: o código, mono 28px, tabular
│   │  [Copiar e abrir o GitHub]  (primário)       │   │
│   │  ⟳ Esperando você autorizar no GitHub…       │   │
│   │  Cancelar                                    │   │
│   └──────────────────────────────────────────────┘   │
│ ○ Ligar o Git à sua conta                            │
│ ○ Conferir o acesso                                  │
│ ○ Baixar                                             │
└──────────────────────────────────────────────────────┘
```

Em Preparar o computador, o item "Login no GitHub" mostra o mesmo cartão do código dentro da linha (no lugar do cartão do Claude).

### Estados

| Parte | Carregando | Erro | Sucesso | Parcial |
|---|---|---|---|---|
| Passo do checklist | spinner + detalhe ("Instalando… 40%") | ícone `!` vermelho + mensagem | ✓ + detalhe curto ("Conta ana") | "não precisa" em cinza (passo pulado) |
| Cartão do código | "Pedindo um código ao GitHub…" com spinner | some; o passo Login mostra o erro e o painel manual | some; o passo mostra "Conta X" | "Confirmando o login…" depois da autorização |
| Painel sem acesso | n/a | conta em negrito, texto pronto num bloco com **Copiar**, botões **Entrar com outra conta** e **Tentar de novo** | n/a | n/a |
| Painel manual | n/a | 3 passos numerados, cada comando num bloco mono com **Copiar**, botão **Tentar de novo** | n/a | n/a |
| Rede | n/a | só a mensagem de internet/VPN + **Tentar de novo** (sem falar de login) | n/a | n/a |

### Jornada

| Passo | A pessoa faz | Sente | O que sustenta |
|---|---|---|---|
| 1 | Cola o link e clica | "vai dar certo?" | o checklist aparece na hora, com 5 passos com nomes de leigo |
| 2 | Espera a instalação | paciência | % e "uns 30 segundos" |
| 3 | Vê o código | "o que faço com isso?" | um botão faz tudo: copia e abre a página; a página pede exatamente esse código |
| 4 | Volta para o InHouse | alívio | a tela já andou sozinha (não precisa clicar em nada) |
| 5 | Falha | frustração | o painel diz o que fazer e dá o texto/comando pronto para copiar |

### Acessibilidade e tamanho de tela

- Checklist é `<ol>` com `aria-live="polite"` só no passo ativo (o leitor de tela não relê a lista a cada progresso).
- Código tem `aria-label` soletrado ("Código W D J B, M J H T"); botões Copiar trocam o rótulo para "Copiado" por 2 s e anunciam via `aria-live`.
- Foco vai para **Copiar e abrir o GitHub** quando o código aparece e para o primeiro botão do painel quando falha.
- Alvos de toque de no mínimo 36px de altura (o `btn sm` atual); abaixo de 560px os botões do painel quebram em coluna e o código cai para 22px.
- `prefers-reduced-motion`: spinners viram reticências, como no Preparar.

### Decisões tomadas sem revisor humano (bot em modo sem aprovações; recomendação aplicada)

1. O botão primário do cartão é **Copiar e abrir o GitHub** (uma ação em vez de duas); Copiar sozinho fica como secundário ao lado do código.
2. Passo pulado (repositório público) aparece em cinza com "não precisa", não some: a pessoa entende por que foi rápido.
3. O painel de ajuda fica **dentro do cartão do download**, logo abaixo do passo que falhou, em vez de modal.
4. No modo demonstração, a home ganha uma faixa igual à de Preparar com o seletor de cenário do download.
5. Download de demonstração que termina mostra o checklist completo e um aviso "Demonstração: aqui o projeto abriria", sem criar projeto.

## GSTACK REVIEW REPORT

| Run | Status | Findings |
|---|---|---|
| plan-design-review (2026-10-21, in-host, sem mockups: designer não usado nesta máquina) | issues_found → resolvidos | 5 lacunas (hierarquia, estados, foco/ARIA, botão primário do código, demo na home) aplicadas como decisões acima |

Notas por passe (antes → depois): Arquitetura de informação 4 → 9; Estados 3 → 9; Jornada 5 → 9; Risco de slop 7 → 9 (reusa o vocabulário do Preparar, sem cartões decorativos); Sistema de design 6 → 8 (sem DESIGN.md; tokens do styles.css); Responsivo/a11y 3 → 8.

VERDICT: pronto para implementar. OUTSIDE COVERAGE: não rodado (sem revisor humano para escolher).

NO UNRESOLVED DECISIONS

## /design-review (2026-10-21, demo ao vivo)

Revisado no modo demonstração, em 1200px e 375px, em todos os cenários. Três achados corrigidos, um commit cada:

- **FINDING-001** (médio, hierarquia): o "Copiar" ao lado do código era só texto; virou botão secundário.
- **FINDING-002** (médio, toque): os botões do card de código e do painel de ajuda tinham 25 a 32px; agora têm 44px no celular e em telas de toque.
- **FINDING-003** (alto, responsivo): em 375px o cartão Abrir do GitHub e a barra de demonstração estouravam a largura; agora cabem, sem rolagem lateral.

Também saíram antes as duas repetições: a mensagem de erro aparecia no passo e no painel, e o aviso de demonstração aparecia duas vezes.

Fica de fora (já existia antes deste trabalho): no cabeçalho, em 375px, o link "Início" é cortado.
