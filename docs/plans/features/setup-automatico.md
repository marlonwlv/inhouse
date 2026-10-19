# Setup automático do InHouse (Mac e Windows)

- **Categoria:** features
- **Data:** 2026-10-19
- **Status:** Em andamento
- **Pedido por:** Marlon
- **Issue:** https://github.com/marlonwlv/inhouse/issues/13

## Contexto

Hoje, para usar o InHouse, a pessoa precisa instalar à mão o Node 24, o Git (Git for Windows com Git Bash
no Windows), o Claude Code, fazer `claude` + login num terminal e, opcionalmente, o `gh`. Só então roda
`setup.cmd`/`setup.command` e `inhouse.cmd`/`inhouse.command` (ver `docs/WINDOWS.md`, PR #12). Para quem
não é técnico, "abra o PowerShell e cole `irm … | iex`" é onde a pessoa desiste.

**Pronto quando:** a pessoa baixa a pasta do InHouse, dá dois cliques em `inhouse.cmd` (Windows) ou
`inhouse.command` (Mac) e, sem abrir terminal nem digitar comando, termina com o InHouse aberto no
navegador, Git e Claude Code instalados, o Claude logado na assinatura dela e o nome/e-mail do git
configurados. Tudo em português.

## Estado atual (verificado em 2026-10-19, `origin/main` 49167a3)

| Peça | Onde | Faz hoje | Falta |
|---|---|---|---|
| Bootstrap Windows | `setup.cmd` → `scripts/windows/setup.ps1` | detecta Node/git/Git Bash/claude/gh, liga `core.longpaths`, `npm install` | não instala nada; sem Node ele só explica e sai |
| Bootstrap Mac | `setup.command` | detecta Node (PATH/mise/nvm), claude, git, gh; `npm install` | não instala nada; sugere `npm i -g` (caminho velho) |
| Launchers | `inhouse.cmd`, `inhouse.command` | sobem `npm start` e abrem o navegador | sem Node ou sem `node_modules` mandam rodar o setup |
| Status do Claude | `server/claude/runner.ts:487` `claudeStatus()` | `claude --version` | não sabe se está **logado** |
| Achar o Claude | `server/platform.ts` `resolverClaude()` + `server/config.ts` `claudePath()` | PATH + locais comuns | cache eterno: depois de instalar, o server não enxerga até reiniciar |
| UI | `public/app.js:1528` `primeirosPassosHtml()` | painel "Conecte o Claude" mandando abrir o Terminal | sem checklist, sem botão de instalar, sem login guiado |
| App de menu bar (Mac) | `app-mac/menubar.m` | embute Node + server | PATH mínimo do Finder (já tratado em `resolverClaude`) |
| CI | `.github/workflows/ci.yml` | typecheck, vitest, smoke em windows/macos/ubuntu | não exercita os bootstraps |

## Decisões (tomadas sem perguntar; o pedido autorizou escolher o caminho razoável)

1. **Duas camadas.** O ovo e a galinha: sem Node o servidor não sobe.
   - **Bootstrap nativo** (PowerShell no Windows, bash no Mac) só garante **Node 24 + dependências** e
     então entrega para a camada Node. Assim a lógica de instalar Git/Claude/gh existe **uma vez**, em
     TypeScript testável, e não em três linguagens.
   - **Camada Node** (`server/setup/`): detecção + instaladores + login, usada pela UI (com SSE) e por
     uma CLI (`server/setup/cli.ts`) que o `setup.*` chama no console.
2. **Node portátil, sem admin**, nos dois SOs: se não houver Node ≥ 24 no sistema, baixa o tarball/zip
   oficial de `https://nodejs.org/dist/latest-v24.x/` (versão e SHA-256 lidos do `SHASUMS256.txt` do
   mesmo diretório, conferidos antes de extrair) para `~/.inhouse/ferramentas/node`. Fica fora da pasta do
   InHouse de propósito: baixar uma versão nova do InHouse não baixa o Node de novo, e o app de menu bar
   (que não pode gravar dentro do `.app`) usa o mesmo lugar. Override: `INHOUSE_TOOLS_DIR`.
   *Por que não o .pkg/.msi:* ambos exigem senha de administrador; não exigem nada a mais que o portátil.
3. **Git.**
   - Windows: `winget install --id Git.Git -e --source winget --silent --accept-package-agreements
     --accept-source-agreements` (instala o Git for Windows de verdade, com Git Bash; o Windows pode pedir
     "Sim" no UAC). Sem winget, ou se falhar/for recusado: **PortableGit** oficial (release do
     `git-for-windows/git`, conferido pelo `digest` SHA-256 do asset) extraído em
     `~/.inhouse/ferramentas/git`, sem admin.
   - Mac: `xcode-select --install` (a janela da Apple) e espera até `xcode-select -p` responder
     (consulta a cada 5 s, até 30 min). Homebrew não é exigido nem usado.
   - Linux: não instala; mostra o comando (`sudo apt install git`). Linux é só para desenvolvimento.
4. **Claude Code:** instalador oficial. Mac/Linux: baixa `https://claude.ai/install.sh` para um arquivo
   temporário e roda com `bash`. Windows: baixa `https://claude.ai/install.ps1` e roda com
   `powershell -NoProfile -ExecutionPolicy Bypass -File`. Instala em `~/.local/bin`. No Windows o Git vem
   antes (o Claude Code exige o Git Bash).
5. **gh (opcional):** zip/tar oficial do release `cli/cli` (conferido pelo `checksums.txt` do release) em
   `~/.inhouse/ferramentas/gh`. Só por clique em "Instalar" na seção Opcional. Login do gh:
   o InHouse não automatiza (é interativo); mostra o estado e a instrução.
6. **Login do Claude:** `claude auth login --claudeai` rodado pelo server (nunca `--console`, nunca API
   key). O server captura a URL que o CLI imprime e a UI mostra "Abrir a página de login"; se o CLI
   pedir o código (`Paste code here`), a UI mostra um campo "Cole o código" que vai direto para o stdin
   do processo, sem gravar em lugar nenhum. Confirmação por `claude auth status --json` (`loggedIn`).
   CLI antigo sem `auth status`: estado "não deu para confirmar", sem bloquear.
7. **Identidade do git:** `git config --global user.name/user.email`. Obrigatória (o InHouse faz commits
   nos espaços). Formulário na própria tela; grava só no clique.
8. **PATH:** ao subir, o server põe na frente do `PATH` as pastas de `~/.inhouse/ferramentas`
   (`node/bin` ou `node`, `git/cmd`, `gh/bin`) e `~/.local/bin`; no Windows define
   `CLAUDE_CODE_GIT_BASH_PATH` se o Git Bash portátil existir e a variável não estiver definida. Depois de
   cada instalação, refaz isso e zera os caches de `claudePath()`, `acharGitBash()` e do status do Claude.
9. **Entrada única de dois cliques.** `inhouse.*`: sem Node/dependências, roda o bootstrap básico
   (Node + `npm ci`) com mensagens em português e segue para o servidor; a UI cuida de Git/Claude/login.
   `setup.*`: bootstrap completo no console (Node + dependências + Git + Claude Code) e no fim abre o
   InHouse. Os dois são idempotentes.
10. **Quando a tela aparece:** rota `#/preparar`. A UI abre nela quando falta item obrigatório, ou na
    primeira abertura de quem ainda não tem projeto e não concluiu a preparação
    (`~/.inhouse/setup.json`). Quem já usa o InHouse com tudo ok não é interrompido. O chip
    "Claude desconectado" e Configurações levam para lá.
11. **Segurança.** Instalação só por ação explícita (clique na UI ou dois cliques no `setup.*`). Nada é
    instalado sozinho pelo server. Rotas de mutação de `/api/setup/*` exigem `Content-Type:
    application/json` (força preflight CORS, que o server não responde) e, se houver `Origin`, que seja
    `http://127.0.0.1:<porta>`, `http://localhost:<porta>` ou `http://[::1]:<porta>` (barra site
    malicioso e DNS rebinding). Downloads só por HTTPS de domínios fixos (nodejs.org, claude.ai,
    github.com/objects.githubusercontent.com) e com checksum quando o publicador oferece. Nenhuma API key
    é pedida, lida ou gravada; `claudeEnv()` continua removendo `ANTHROPIC_API_KEY`.
12. **Modo demonstração** (`INHOUSE_SETUP_DEMO=1`): o checklist vem de um ambiente simulado com
    cenários (Mac novo, Windows novo, sem Node, instalando, erro, login, identidade, tudo ok) e SO
    escolhível; instalar/login são fingidos com progresso de verdade pelo SSE. Nada é executado.
    Uma barra de demonstração na própria tela troca cenário e SO. A trava de `Origin` é relaxada só nesse
    modo (para a validação por túnel).

## Contrato

### Tipos (`shared/types.ts`)

```ts
export type SetupItemId = "node" | "git" | "gitbash" | "claude" | "claude_login" | "git_identidade" | "gh" | "gh_login";
export type SetupEstado = "ok" | "faltando" | "instalando" | "erro" | "verificando" | "aviso";
export interface SetupItem {
  id: SetupItemId;
  titulo: string;          // "Git", "Claude Code", "Login no Claude"…
  descricao: string;       // para que serve, em 1 linha
  obrigatorio: boolean;
  estado: SetupEstado;
  detalhe?: string;        // versão encontrada, onde, ou o erro em português
  acao?: "instalar" | "login" | "identidade" | "manual";
  progresso?: { mensagem: string; pct?: number };
  log?: string[];          // últimas linhas da instalação (máx. 40)
}
export interface SetupStatus {
  so: "mac" | "windows" | "linux";
  itens: SetupItem[];
  prontoParaUsar: boolean;        // todos os obrigatórios ok
  instalando: boolean;
  login?: { url?: string; pedeCodigo: boolean; mensagem?: string };
  identidade?: { nome?: string; email?: string };
  concluidoEm?: string;           // ~/.inhouse/setup.json
  mostrarAoAbrir: boolean;
  demo?: { cenario: string; cenarios: { id: string; rotulo: string }[] };
  verificadoEm: string;
}
// ServerEvent += { type: "setup_status"; setup: SetupStatus }
```

### API

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /api/setup` | | `SetupStatus` (cache 20 s) |
| `POST /api/setup/verificar` | `{}` | `SetupStatus` (força checagem) |
| `POST /api/setup/instalar` | `{ itens?: SetupItemId[] }` (sem itens = obrigatórios faltando) | 202 `SetupStatus`; 409 se já instalando; progresso por `setup_status` |
| `POST /api/setup/claude/login` | `{}` | 202; URL e pedido de código por `setup_status` |
| `POST /api/setup/claude/codigo` | `{ codigo }` | 202 |
| `POST /api/setup/claude/cancelar` | `{}` | 200 |
| `POST /api/setup/identidade` | `{ nome, email }` | `SetupStatus`; 400 se e-mail inválido ou nome vazio |
| `POST /api/setup/concluir` | `{}` | `SetupStatus` |
| `POST /api/setup/demo` | `{ cenario?, so? }` | `SetupStatus`; 404 fora do modo demo |

### CLI (`server/setup/cli.ts`, rodada por `setup.*`)

- `verificar [--json]`: imprime o checklist; sai 0 se obrigatórios ok, 1 se não.
- `instalar [--itens git,claude] [--simular]`: instala os obrigatórios que faltam (Git, Claude) e
  mostra o progresso; `--simular` só imprime o plano. Login e identidade ficam para a UI.

### Bootstraps

- `scripts/windows/setup.ps1 [-Verificar] [-Simular] [-SemPausa] [-Basico] [-NaoAbrir]`
- `scripts/mac/setup.sh [--verificar] [--simular] [--sem-pausa] [--basico] [--nao-abrir]`
  (`setup.command` e o `inhouse.command` chamam este; o `.command` fica fino como o `.cmd`)
- Sem terminal interativo (CI) não pausa.

## Critérios de aceite

1. Windows sem Node: dois cliques em `inhouse.cmd` baixam o Node 24 portátil (SHA-256 conferido),
   rodam `npm ci` e abrem `http://127.0.0.1:4400/#/preparar`, sem pedir admin.
2. Mac sem Node: idem com `inhouse.command`.
3. Rodar `setup.*` duas vezes seguidas não baixa nada na segunda (idempotente) e termina em "Tudo pronto".
4. A tela `#/preparar` lista Node, Git, (Git Bash no Windows), Claude Code, Login no Claude, Nome no git
   e, em "Opcional", GitHub CLI e login do gh, cada um com estado ok/faltando/instalando/erro.
5. "Instalar o que falta" instala Git e Claude Code na ordem certa, com progresso ao vivo via SSE, sem
   recarregar a página; um erro mostra a mensagem em português, as últimas linhas do log e "Tentar de
   novo".
6. "Entrar no Claude" abre a página de login, aceita colar o código quando o CLI pede, e o item fica ok
   sozinho quando `claude auth status` disser `loggedIn: true`.
7. O formulário de identidade grava `user.name`/`user.email` globais e o item fica ok.
8. Com tudo ok, "Começar a usar" grava `setup.json` e leva ao Início; a tela não volta a abrir sozinha
   enquanto tudo estiver ok.
9. `POST /api/setup/instalar` com `Origin: https://evil.example` ou sem `Content-Type: application/json`
   responde 403/415 e não instala nada (fora do modo demo).
10. Nenhum arquivo do InHouse lê, pede ou grava `ANTHROPIC_API_KEY`.
11. Modo demo mostra todos os cenários nos dois SOs sem executar nenhum comando.
12. CI verde em windows/macos/ubuntu com: vitest (novos testes de detecção/instalação com mocks por
    SO), bootstraps em `-Verificar`/`--simular`, e um job que instala de verdade Node portátil, Claude
    Code e gh portátil (e PortableGit no Windows) num diretório temporário do runner.
13. Fluxo atual do Mac preservado: `setup.command`/`inhouse.command` com Node no sistema funcionam como
    antes; o app de menu bar não muda.

## Testes

| Camada | O quê | Qtde |
|---|---|---|
| Unit | detecção por SO com ambiente simulado (mac/win/linux; com e sem cada ferramenta; claude antigo sem `auth`) | ~14 |
| Unit | plano de instalação por SO (winget × portátil, xcode-select, URLs, ordem git→claude) | ~8 |
| Unit | parse do SHASUMS256 / checksums do gh / digest do GitHub; extração do URL e do "Paste code" do login | ~6 |
| Unit | PATH com ferramentas, trava de Origin/Content-Type | ~5 |
| Integração | rotas `/api/setup/*` em modo demo (cenários, instalar fingido emite `setup_status`) | ~4 |
| UI estática | `#/preparar` existe, sem dependência externa | +1 |
| CI | bootstraps `-Verificar`/`--simular` nos 3 SOs; instalação real no Windows e macOS | 2 jobs |

## Fora de escopo

- Instalador empacotado (.msi/.exe) do InHouse para Windows e assinatura de código.
- Mudar o app de menu bar (`app-mac/`) além de ele herdar a tela nova.
- Automatizar o `gh auth login` (interativo).
- Instalar Git no Linux.
- Atualização automática do Claude Code/Node já instalados.

## Rollback

Reverter o PR. As ferramentas portáteis ficam em `~/.inhouse/ferramentas` (apagar a pasta desfaz);
o Git do winget e o Claude Code são instalações normais do sistema e continuam funcionando sem o InHouse.

## Esclarecimentos (do quality gate da spec, 8/10)

- "Sem abrir terminal" = a pessoa não precisa abrir um terminal nem digitar comando. A janela de console
  que o próprio `.cmd`/`.command` abre é aceitável (já é assim hoje).
- Dois cliques em `inhouse.*` contam como a ação explícita para baixar o Node e as dependências: a
  janela diz o que vai baixar antes. Git e Claude só com dois cliques no `setup.*` ou clique na UI.
- O `setup.*` termina em "Programas prontos" e abre o InHouse; login e identidade são concluídos na tela.
- CLI do Claude sem `auth status`: item "Login no Claude" fica `aviso` e conta como ok para
  `prontoParaUsar` (não dá para confirmar, então não trava).
- Arquiteturas: Mac `arm64`/`x64` (`uname -m`), Windows `x64`/`arm64` (`PROCESSOR_ARCHITECTURE`).
  Mac: tarball `.tar.gz`, extraído com `tar`; `curl` não aplica quarentena. Windows: `.zip` com `tar.exe`.
- Códigos de saída do bootstrap: 0 ok, 1 faltou obrigatório ou falhou, 2 argumento inválido.
  `-Verificar` sem Node: relata "Node faltando" e sai 1 sem baixar. `-Simular`: imprime o plano, nunca baixa.
- `/concluir` só aceita com `prontoParaUsar` (senão 409). Item desconhecido em `/instalar` dá 400. Login
  e instalação não rodam juntos (409). Login expira em 10 min (processo encerrado, estado volta a faltando).
- Versões: Node `latest-v24.x`; Claude o que o instalador oficial servir; gh e PortableGit o `latest`
  do release. Sem checksum disponível (asset sem `digest`), PortableGit não é usado e o erro pede o
  winget/instalador oficial; o gh exige o `checksums.txt`.
- CI: `INHOUSE_TOOLS_DIR` aponta para o temp do runner e `INHOUSE_FORCAR_PORTATIL=node,git,gh` força os
  portáteis mesmo com ferramenta no sistema. Linux roda só `--verificar`/`--simular`.
- API key: o InHouse não pede nem grava. A única leitura é o `delete` já existente em `claudeEnv()`.

## Suposições registradas

- `claude auth login`/`auth status --json` existem no Claude Code atual (verificado: 2.1.296 nesta
  máquina; `status` sai 1 e `loggedIn:false` sem login; `login` sem navegador imprime a URL e
  "Paste code here if prompted").
- Windows 10 1803+ (traz `tar.exe` e `curl.exe`); PowerShell 5.1.
- A tela de setup não substitui o `claude_status` existente (chip do topo), só o complementa.
