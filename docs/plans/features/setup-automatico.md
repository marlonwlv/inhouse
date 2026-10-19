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

## Revisão de engenharia (/plan-eng-review, 2026-10-19)

Alvo: este arquivo. Sessão autônoma: cada decisão abaixo foi auto-escolhida pela recomendação
(o pedido autorizou) e fica registrada aqui. Segunda opinião: Codex (read-only), 19 achados, todos tratados.

Evidência coletada:
- `claude auth login --claudeai` com stdin em pipe, sem TTY e HOME temporário: imprime a URL, lê o
  código do stdin, responde `Invalid code. Please make sure the full code was copied.` e fica parado
  (não pede de novo). `auth status --json` sem login: `{"loggedIn":false,...}` com saída 1.
- `tsconfig.build.json` inclui `server/**/*.ts`: `server/setup/` entra no build do app Mac. O app copia
  só `public/`, `templates/` e o servidor compilado, então o servidor **não pode** depender de `scripts/`.
- `menubar.m` usa o Node embutido no `.app` e monta o PATH dele; `tsx` está em `devDependencies`.

### Achados e decisões (todas aceitas)

```
[P1] (9/10) bootstrap Windows: PATH do PowerShell filho não volta ao .cmd
     → os .cmd prependem %USERPROFILE%\.inhouse\ferramentas\node antes de `where node`; o .ps1 só instala.
[P1] (9/10) Git do winget não aparece no servidor já aberto
     → localizarGit(): PATH + %ProgramFiles%\Git\cmd + %LOCALAPPDATA%\Programs\Git\cmd + ferramentas\git\cmd;
       o dir achado é prependido ao process.env.PATH e o cache do Git Bash é zerado.
[P1] (8/10) Git sem Git Bash não tinha reparo → item gitbash instala o PortableGit (traz bash.exe).
[P1] (9/10) Mac: /usr/bin/git é shim que abre o diálogo das CLT
     → se `xcode-select -p` falha, git = faltando SEM executar git; senão `git --version` com timeout 10s.
[P1] (8/10) extração portátil indefinida
     → baixa e extrai em ferramentas/.tmp-<id>, acha a única pasta de topo, troca atômica (rename; a antiga
       vai para .old-<id> e é removida). Node: .tar.gz (Mac, tar) / .zip (Windows, tar.exe do Windows 10+).
       gh: .zip/.tar.gz. PortableGit: o .7z.exe autoextraível com `-o<dir> -y`.
       Validação final executando `--version` do binário instalado.
[P1] (9/10) login: código inválido trava o processo → ao ler "Invalid code" o servidor mata o processo,
       o item fica `erro` com "Código não aceito. Gere outro e cole de novo" e o botão reabre o login.
[P1] (8/10) instalador do Claude sem contrato → timeout 10 min, stdin fechado, saída no log do item,
       código de saída checado, depois zerar caches e validar com `claude --version`.
[P1] (8/10) duas instâncias/CLI instalando juntas → lock entre processos `ferramentas/.lock` (pid + hora;
       vencido se o pid morreu ou > 30 min); 409 "Outra janela do InHouse está instalando".
[P1] (8/10) DNS rebinding: Host não é validado → `/api/setup/*` (GET e POST) exige Host 127.0.0.1,
       localhost ou [::1]. Validação global de Host fica como TODO (fora do escopo).
[P2] (8/10) demo exposto por túnel → o proxy do túnel (fora do repo) só deixa passar estáticos,
       GET /api/state, /api/setup*, /api/events e reescreve Host para 127.0.0.1; o resto dá 404.
       O demo roda com INHOUSE_FAKE_MODEL=1 e dados em pasta própria.
[P2] (8/10) ambiente montado tarde → server/setup/ambiente.ts é o PRIMEIRO import de server/index.ts
       e de server/setup/cli.ts (efeito no import: PATH + CLAUDE_CODE_GIT_BASH_PATH).
[P2] (7/10) "Claude ok" contraditório → claude_status segue "instalado"; o chip passa a mostrar
       "Faça o login" quando setup.claude_login = faltando.
[P2] (8/10) SSE perde estado ao reconectar → ao conectar o servidor manda o último setup_status,
       e a tela faz GET /api/setup ao abrir.
[P2] (8/10) shutdown não mata instaladores/login → filhos registrados e mortos com matarArvore.
[P2] (7/10) idempotência das deps → `npm install --include=dev --no-audit --no-fund`; marcador
       node_modules/.inhouse-deps com o hash do package-lock; reinstala se diferente ou ausente.
[P2] (8/10) app Mac: Node portátil prependido trocaria o runtime → a pasta do Node portátil é ANEXADA
       ao fim do PATH; ~/.local/bin, git e gh são prependidos.
[P3] (8/10) arquitetura → Mac: arm64 | x86_64→x64; Windows: PROCESSOR_ARCHITEW6432 ?? PROCESSOR_ARCHITECTURE
       (AMD64→x64, ARM64→arm64); outra = erro "computador não suportado".
[P3] (7/10) CI não prova máquina limpa → CI prova download+checksum+extração+validação em pasta temp;
       a matriz manual (Mac e Windows limpos) fica no guia e no relatório do PR.
[P3] (7/10) rollback exagerado → reverter o PR não desfaz git config global, core.longpaths, CLT nem
       ~/.local/bin/claude; documentado aqui.
```

### Arquitetura (fluxo)

```
dois cliques ─▶ inhouse.cmd / inhouse.command
                 │ PATH += ~/.inhouse/ferramentas/node
                 │ sem Node 24? ─▶ setup.ps1 / setup.sh --basico (Node portátil + npm install)
                 └▶ npm start ─▶ server/index.ts
                                   import "./setup/ambiente.js"  (PATH, Git Bash)
                                   /api/setup/* ─▶ server/setup/servico.ts (estado, lock, SSE)
                                                     ├ detectar.ts  (Ambiente injetável: so, env, existe, exec)
                                                     ├ instalar.ts  (baixar + sha256 + extrair + validar)
                                                     ├ login.ts     (claude auth login, código, 10 min)
                                                     └ demo.ts      (cenários, só INHOUSE_SETUP_DEMO=1)
                 navegador ─▶ #/preparar  ◀── SSE setup_status
```

### Testes exigidos (unitários, vitest, mocks por SO)

- detectar: Node ausente/antigo/ok; git no Mac sem CLT (não executa git) e com CLT; git no Windows no
  PATH, só em Program Files, só portátil; Git Bash ausente; claude ausente/presente; login ok/faltando/
  CLI antigo (aviso); identidade vazia/ok; gh e gh_login; arquitetura.
- instalar: URL por SO/arch; checksum confere/diverge (aborta, não troca a pasta); troca atômica
  mantém a versão antiga se a extração falha; lock ocupado/vencido; ordem git→claude no Windows.
- login: captura a URL; "Invalid code" vira erro; sucesso confirmado por auth status; timeout.
- rotas: 415 sem JSON, 403 com Origin/Host de fora, 409 instalando, 400 item/identidade inválidos,
  404 demo fora do modo; /concluir 409 sem prontoParaUsar.
- demo: todos os cenários geram SetupStatus válido nos dois SOs.
- CI: `verificar --json` e `instalar --simular` nos 3 SOs; job real (node, claude, gh e PortableGit no
  Windows) em pasta temp com INHOUSE_FORCAR_PORTATIL.

### Desempenho

Sem banco. A detecção roda até 8 subprocessos com timeout de 10s cada, em paralelo, com cache de 20s.
Broadcast de progresso limitado a 4 por segundo por item; log com no máximo 40 linhas por item.

## Revisão de design (/plan-design-review, 2026-10-19)

Sem DESIGN.md; o sistema visual é o de `public/styles.css` (neutros Linear, accent monocromático, Onest, borda-primeiro, tema escuro por `[data-theme="dark"]`). Revisão só em texto (sem mockup gerado; suposição: a validação visual real é a do Marlon pelo túnel, que vale mais que um mockup). Nota inicial 4/10 (a spec dizia "checklist com estados" e pouco mais); nota final 9/10 com as decisões abaixo.

### 1. Arquitetura da informação (4 → 9)
- Rota própria `#/preparar`, tela cheia dentro do layout atual (sem a sidebar de projetos competindo). Coluna única centrada, `max-width: 640px`.
- Ordem vertical: título "Preparando o seu computador" + uma frase ("O InHouse precisa de alguns programas. Instalamos tudo para você, sem pedir senha.") → **barra de resumo** ("3 de 6 prontos") → **lista de itens** → **rodapé de ação** (botão principal único).
- Ordem dos itens = ordem de dependência: Node.js · Git (no Windows: "Git e Git Bash" num item só, visualmente) · Claude Code · Login do Claude · Seu nome no git · GitHub (opcional, separado por um divisor "Opcional").
- Um botão principal por tela, sempre a próxima coisa a fazer: "Instalar o que falta" → (durante) desabilitado "Instalando…" → "Fazer login do Claude" → "Começar a usar o InHouse". Ações por item só aparecem no item com erro ("Tentar de novo") ou que pede entrada (login, identidade).

### 2. Estados (3 → 9)
Cada item tem ícone + rótulo + linha de detalhe; nunca só cor (a11y).
| Estado | Ícone | Detalhe (exemplo) |
|---|---|---|
| ok | ✓ em círculo, `--ink` | "Pronto · v24.11.0" |
| faltando | círculo vazio, `--faint` | "Ainda não instalado" |
| instalando | spinner pequeno | última linha útil do log, ex.: "Baixando… 42%" |
| erro | ! em círculo, `--danger` | mensagem humana + "Tentar de novo" + "Ver detalhes" (log em `<details>`, mono, 40 linhas) |
| aviso | ! em círculo, `--amber` | "Versão antiga, mas funciona" (conta como ok) |
| opcional faltando | círculo tracejado | "Opcional · pule se não usa GitHub" |
- Tela inteira: **carregando** (skeleton das 6 linhas, sem layout pulando), **tudo pronto** (resumo vira "Tudo pronto" com ✓ e o botão "Começar a usar o InHouse"), **outra janela instalando** (faixa âmbar no topo com a frase do 409, botão desabilitado), **servidor caiu** (faixa "Perdemos a conexão com o InHouse. Tentando de novo…" usando o reconnect do SSE).

### 3. Jornada e emoção (5 → 9)
- Nada assusta: nenhuma palavra "terminal", "PATH", "admin", "comando". Termos técnicos ficam só no "Ver detalhes".
- Tempo esperado no resumo durante a instalação: "Isso leva uns 3 a 5 minutos. Pode deixar a janela aberta."
- Login do Claude em cartão inline dentro do item: passo 1 "Abrir o login no navegador" (botão, abre a URL do CLI em nova aba), passo 2 campo "Cole aqui o código que apareceu" + "Confirmar". Código inválido: o item vai a erro com "Código não aceito. Gere outro e cole de novo" e o cartão volta ao passo 1. Sucesso: ✓ e "Claude conectado · sua assinatura".
- Identidade do git: cartão inline com "Seu nome" e "Seu e-mail" (o e-mail do GitHub de preferência, dito na ajuda do campo), botão "Salvar". Pré-preenche se o git já tiver algo.
- Ao concluir, `/concluir` e volta para `#/` com o toast existente "Tudo pronto. Bem-vindo ao InHouse."

### 4. Microcopy (fixada)
Título "Preparando o seu computador"; botões "Instalar o que falta", "Instalando…", "Tentar de novo", "Fazer login do Claude", "Salvar", "Pular" (só no opcional), "Começar a usar o InHouse". Erros genéricos: "Não deu para instalar o {item}. Verifique a internet e tente de novo." Chip da barra: "Faça o login" (claude_login faltando), "Falta instalar" (outro item obrigatório faltando), clicando leva a `#/preparar`.

### 5. Responsivo e plataforma
- ≤640px: itens empilham ação embaixo do detalhe; botão principal largura total. A tela roda no navegador do próprio computador, então o caso real é a janela estreita, não celular; o celular importa só para a validação pelo túnel.
- Windows e Mac mostram os mesmos itens, com o nome do item Git variando ("Git e Git Bash" no Windows). Nenhuma instrução de teclado específica de SO na tela.

### 6. Acessibilidade
- Lista como `<ol>` com `aria-live="polite"` no resumo (não na lista inteira, para não narrar cada linha de log). Spinner com `aria-label="Instalando"`. Foco vai para o cartão de login/identidade quando ele abre e para o botão principal quando um passo termina. Contraste AA nos dois temas (`--amber` e `--danger` já são AA). `prefers-reduced-motion` troca spinner por "…".

### 7. Modo demo
- Com `INHOUSE_SETUP_DEMO=1`, uma barra fina no topo (estilo do painel debug existente) com seletor de cenário: "Falta tudo (Windows)", "Falta tudo (Mac)", "Instalando", "Erro no Git", "Login do Claude", "Código inválido", "Outra janela instalando", "Tudo pronto". Os botões da tela funcionam nos cenários (instalar avança a simulação), sem instalar nada de verdade. A barra diz "Demonstração · nada é instalado".

### Fora do escopo de design
Ilustração/mascote, animação de celebração, onboarding em várias páginas (wizard). Uma tela, uma lista, um botão.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex exec (plan-review) | Independent 2nd opinion | 1 | completed | 19 findings, todos incorporados |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (mapeados e aceitos) | 19 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | nota 4 → 9, 7 passes, 0 decisões abertas |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** Codex, plan-review, completo; 19 achados (11 High, 7 Medium, 1 Low), todos com decisão acima.
- **VERDICT:** ENG + DESIGN revisados; pronto para implementar. Validação visual final pelo Marlon via túnel antes do /ship.

NO UNRESOLVED DECISIONS
