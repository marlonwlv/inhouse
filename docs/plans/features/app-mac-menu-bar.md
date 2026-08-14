# Inhouse instalável no Mac — app de menu bar

- **Categoria:** features
- **Data:** 2026-08-13
- **Status:** Concluído (v0.1.0)

## Contexto

Hoje o Inhouse exige terminal (`npm start`) — inviável para o usuário-alvo
(não-técnico). Objetivo: **baixar um DMG, arrastar para Aplicativos e usar**.
Decisões do Marlon: **app de menu bar** (leve; a UI continua sendo a web no
navegador do usuário) e **sem assinatura Apple por enquanto** (instruções de
primeira abertura no DMG; Developer ID fica para quando houver conta).

## Como funciona

O `Inhouse.app` (só na barra de menu, `LSUIElement`) carrega dentro de
`Resources/`:

- `srv/` — o servidor compilado com **tsc** (estrutura de pastas preservada:
  `server/`, `shared/`, `public/`, `templates/` — os caminhos relativos via
  `import.meta.url` continuam valendo) + `node_modules` de produção
  (`npm ci --omit=dev --ignore-scripts`).
- `node/` — **runtime Node completo** (dist oficial do nodejs.org), incluindo
  `npm`/`corepack`: a máquina do usuário **não precisa ter Node** — o PATH do
  servidor aponta primeiro para o bin embutido, então `npm install` dos
  projetos e os dev servers dos previews funcionam.

O launcher (`app-mac/menubar.m`, **Objective-C/AppKit compilado com clang** —
de propósito: compila com as Command Line Tools em qualquer Mac, sem depender
do toolchain Swift casar com o SDK):

1. Sonda as portas 4400–4409: se já existe um Inhouse no ar (ex.: o dev rodando
   `npm start`), **reusa** — não sobe segundo servidor, só abre o navegador.
2. Senão, sobe o servidor embutido na primeira porta livre, com PATH rico
   (node embutido → `~/.local/bin` → Homebrew → `/usr/local/bin`) — lançado
   pelo Finder o PATH é mínimo e `claude`/`git`/`npm` não seriam achados.
3. Espera ficar saudável (`GET /api/state`) e abre o navegador.
4. Menu: status (No ar/Parado) · Abrir o Inhouse · Ver o registro
   (`~/Library/Logs/Inhouse.log`) · Reiniciar o servidor · Encerrar (SIGTERM →
   shutdown limpo: previews e fases derrubados).

Mudança no servidor: `claudePath()` (`server/config.ts`) agora confere os
locais comuns (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`)
além do `which` — essencial no PATH mínimo do Finder.

## Build e distribuição

```
npm run build:mac          # arm64 (Apple Silicon) — padrão
scripts/build-mac-app.sh x64   # Macs Intel
```

`scripts/build-mac-app.sh`: tsc → deps de produção → baixa o Node
(`INHOUSE_NODE_VERSION`, cache em `dist/.cache`) → clang do launcher →
monta o `.app` (Info.plist com a versão do package.json) → **assinatura
ad-hoc** (obrigatória no Apple Silicon) → `hdiutil` gera
`dist/Inhouse-<versão>-<arch>.dmg` com o app, atalho para Aplicativos e
`LEIA-ME.txt` (instruções de primeira abertura sem assinatura: botão
direito → Abrir; fallback `xattr -dr com.apple.quarantine`).

DMG ~170MB por arquitetura (runtime Node completo é o grosso).

## Verificado

- Servidor empacotado sobe pelo Node embutido (porta/dados isolados):
  `GET /api/state` 200 e UI 200.
- Launcher aberto com um Inhouse dev na 4400: detectou, **reusou** (nenhum
  servidor extra) e abriu o navegador.
- DMGs x64 e arm64 gerados (arm64 cross-compilado do Intel; falta validar num
  Apple Silicon real).

## Pendências / próximos passos

- ~~Validar o DMG~~ — validado pelo Marlon (2026-08-13).
- ~~Publicar os DMGs~~ — publicados: https://github.com/marlonwlv/inhouse/releases/tag/v0.1.0
- Ícone próprio (`.icns`) — hoje o app usa o ícone genérico e o símbolo
  `shippingbox` na barra de menu.
- Assinatura + notarização quando houver conta Apple Developer (o build já
  isola o passo de assinatura).
- Atualização automática (checagem que o server já faz via git não se aplica
  ao app — pensar em Sparkle ou aviso de versão nova com link do DMG).
