# InHouse no Windows

- **Categoria:** features
- **Data:** 2026-10-19
- **Status:** Em andamento

## Contexto

O InHouse roda hoje só no Mac (Marlon e o time). Parte do time usa Windows e não consegue rodar. O plano
`release/primeira-versao-product-designer.md` adiou o Windows; agora ele entra. O InHouse não é Electron:
é um servidor Node 24/TS (tsx) + UI web vanilla em `public/`, que fala com o Claude Code da máquina via
`@anthropic-ai/claude-agent-sdk` (`pathToClaudeCodeExecutable`), usa `git worktree` para os "espaços",
estado em `~/.inhouse` e previews em portas 4500+.

**Pronto quando:** numa máquina Windows 10/11 com Node 24, Git for Windows e Claude Code instalados,
alguém não técnico roda `setup.cmd`, depois `inhouse.cmd`, cria um app de template, roda uma tarefa até
"Seu teste", vê o preview, publica, e fecha a janela sem deixar processo órfão. O CI do PR fica verde em
`windows-latest`, `macos-latest` e `ubuntu-latest`. O Mac continua igual.

## Estado atual (verificado em 2026-10-19, `origin/main` a0c3839)

| Ponto | Onde | Problema no Windows |
|---|---|---|
| Scripts `dev`/`dev:fake` | `package.json` | sintaxe `VAR=x cmd` e `$HOME` não existem no cmd/PowerShell |
| Achar o `claude` | `server/config.ts` `claudePath()` | usa `which` e só caminhos POSIX; no Windows é `claude.exe` (instalador nativo, `%USERPROFILE%\.local\bin`) ou `claude.cmd` (npm global, `%APPDATA%\npm`). O SDK só roda nativo ou `.js`: um `.cmd` dá `EINVAL` |
| `claude --version` | `server/claude/runner.ts` `claudeStatus()` | `execFile` em `.cmd` falha |
| `spawn("npm"…)`, `npx`, `corepack`, `node_modules/.bin/tsc` | `projects.ts`, `worktrees.ts`, `gates.ts`, `preview.ts` | no Windows são `.cmd`; desde o Node 18.20/20.12 (CVE-2024-27980) spawn de `.cmd` sem shell dá `EINVAL` |
| Receitas de preview (`cmd`, `setup`) | `preview.ts` `/bin/sh -c` | não existe `/bin/sh` |
| Matar preview | `preview.ts` `matar()` `process.kill(-pid)` | grupo de processo não existe; `child.kill` só mata o shell, o `node`/`vite` fica órfão segurando a porta |
| `detached: true` | `preview.ts` | no Windows abre janela de console nova para cada preview |
| Porta servida pelo preview | `preview.ts` `lsof`/`ps` | não existem (já degrada para `null` = não bloqueia) |
| Installs/gates mortos com `SIGKILL` | `projects.ts`, `worktrees.ts`, `gates.ts` | mata só o `cmd.exe`, não a árvore |
| `rename` atômico do estado | `server/store.ts`, `workflow/library.ts` | `EPERM`/`EBUSY`/`EACCES` quando antivírus/indexador segura o arquivo |
| Caminhos longos | worktrees em `~/Inhouse/.espacos/<proj>/espaco-N` | `git` falha com caminho > 260 sem `core.longpaths` |
| Fins de linha | sem `.gitattributes` | Git for Windows (`autocrlf=true`) converte `.command`/`.sh` para CRLF e quebra o bash; testes que comparam texto |
| Launchers | `inhouse.command`, `setup.command` | bash/Finder; não há equivalente Windows |
| Shutdown | `server/index.ts` | só `SIGINT`/`SIGTERM`; fechar a janela do console manda `SIGHUP` (Node emula) e também `SIGBREAK` no Ctrl+Break |

O que já funciona e **não deve mudar**: `path.join`/`resolve` em quase tudo, `homedir()` em `config.ts`,
`os.tmpdir()` nos testes, `workflow/config.ts` já reconhece caminho com letra de drive, comparações com
`path.sep`, `git`/`gh` via `execFile` (são `.exe`), `dentroDe()` com `relative()` (que no win32 já compara
sem caixa).

## Mudança proposta

1. **`server/platform.ts` (novo, puro e testável):**
   - `resolverExecutavel(cmd, {plataforma, PATH, PATHEXT, existe})`: no Windows procura `cmd` + extensões do
     `PATHEXT` no `PATH` (ou relativo ao `cwd` quando tem separador). Fora do Windows devolve `cmd`.
   - `montarComando(cmd, args, opts)` → `{ arquivo, args, windowsVerbatimArguments? }`: `.exe`/`.com` vão
     direto; `.cmd`/`.bat` viram `cmd.exe /d /s /c "<linha escapada>"` com escape de metacaracteres (`^`),
     no mesmo esquema do `cross-spawn`. POSIX: sem mudança.
   - `comandoDeShell(linha)` → como rodar uma receita: POSIX `/bin/sh -c`; Windows: **Git Bash** (o Claude
     Code no Windows já exige Git for Windows; assim a mesma receita versionada em `inhouse.config.json`
     funciona no Mac e no Windows), fallback `cmd.exe /d /s /c`.
   - `matarArvore(pid, sinal)`: POSIX `process.kill(-pid)` com fallback no pid; Windows `taskkill /pid N /T /F`.
   - `spawnOpcoes()` → `detached` só fora do Windows; `windowsHide: true` sempre.
   - `resolverClaude()` → POSIX como hoje; Windows: `INHOUSE_CLAUDE_PATH`, `where claude`, depois
     `%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\claude.cmd`. Um `.cmd` do npm é traduzido para o
     alvo real do shim (`cli.js` ou `.exe`), que o SDK sabe rodar.
2. **Trocar todos os spawns** de `npm`/`npx`/`corepack`/`bun`/`tsc` por um helper `spawnPortatil` que usa
   `montarComando`, e todos os kills por `matarArvore`.
3. **`store.ts` e `library.ts`:** `renameComRetry` (até ~1s, backoff, só em `EPERM`/`EBUSY`/`EACCES`).
4. **`git()`:** `-c core.longpaths=true` no Windows.
5. **`package.json`:** `dev`/`dev:fake` passam por `scripts/dev.mjs` (Node puro, monta env com
   `os.homedir()`), sem dependência nova.
6. **`.gitattributes`:** `* text=auto eol=lf`; `*.cmd`/`*.bat`/`*.ps1` com `eol=crlf`; binários marcados.
7. **Launchers Windows:** `setup.cmd` (duplo-clique) → `scripts/windows/setup.ps1` (checa Node 24, Git,
   gh, Claude Code; habilita `core.longpaths`; `npm install`); `inhouse.cmd` (duplo-clique) sobe o servidor
   e abre o navegador com `start` quando a porta responder.
8. **Shutdown:** também `SIGHUP` e `SIGBREAK`.
9. **CI:** `.github/workflows/ci.yml` com matriz `ubuntu/macos/windows`: `npm ci`, `typecheck`, `vitest` e
   `scripts/smoke.mjs` (sobe o servidor com `INHOUSE_FAKE_MODEL=1` em pastas temporárias, `GET /` e
   `/api/state`, cria app de template, cria tarefa e espera o espaço (git worktree) existir, liga/desliga um
   preview REAL de um dev server mínimo e confere que a porta liberou, encerra o servidor).
10. **`docs/WINDOWS.md`:** instalação passo a passo para não técnicos + roteiro de teste manual.

## Critérios de aceite

1. `npm run typecheck` e `npx vitest run` passam nos 3 SOs do CI.
2. `node scripts/smoke.mjs` passa nos 3 SOs: servidor responde 200 em `/` e `/api/state`; projeto de template
   é criado com repositório git; tarefa cria pasta de espaço em `.espacos`; preview real responde 200 e,
   depois de parado, a porta fica livre em até 5s.
3. Testes unitários de `platform.ts` cobrem, simulando `win32` e `darwin`: resolução com `PATHEXT`,
   montagem de `.cmd` com espaço/aspas/`&` no argumento, shim do npm → `cli.js`/`.exe`, ordem de busca do
   claude, comando de kill de árvore.
4. Nenhum `spawn`/`execFile` do servidor chama `npm`/`npx`/`corepack`/`tsc` sem passar pelo helper
   (`grep` limpo).
5. No Mac/Linux o comportamento é idêntico ao atual (testes existentes sem mudança de expectativa).

## Testes

| Camada | O quê | Qtde |
|---|---|---|
| Unit | `platform.ts` (resolver, montar, shell, kill, claude, shim) | +15 |
| Unit | `renameComRetry` com `EPERM` simulado | +2 |
| Integração | suíte existente nos 3 SOs (preview real, gates reais, worktrees reais) | 0 novos |
| Smoke | `scripts/smoke.mjs` no CI | +1 |
| Manual | roteiro em `docs/WINDOWS.md` numa máquina Windows real | 1 |

## Fora de escopo

- Instalador `.exe`/MSI, app de bandeja equivalente ao `app-mac/` (menubar), auto-update no Windows.
- WSL (o alvo é Windows nativo).
- Verificar no Windows que a porta do preview pertence à árvore do dev server (`lsof`/`ps`); fica `null`
  (não bloqueia), como já é quando `lsof` falta.

## Rollback

Reverter o PR. As mudanças em POSIX são caminhos de código equivalentes; o risco no Mac é coberto pelo CI
`macos-latest`.

## Suposições (modo autônomo)

- Não abri issue no GitHub: esta spec versionada + o PR são o rastro.
- Receitas de preview no Windows rodam no Git Bash (já exigido pelo Claude Code no Windows).
- `setup.cmd`/`inhouse.cmd` não instalam nada sozinhos além do `npm install`; apontam o que falta com link.

## Revisão de engenharia (/plan-eng-review, 2026-10-19, modo autônomo)

Escopo: 1 módulo novo (`server/platform.ts`) + 1 helper (`spawnPortatil` em `proc.ts`) e ~14 arquivos
tocados (8+ arquivos → gate de complexidade). Decisão automática pela recomendação: **manter o escopo**
(cada item é um bloqueio real no Windows; cortar qualquer um deixa o app quebrado lá) e o arranjo original
(um módulo de plataforma puro + chamadas finas nos serviços). MODE: FULL_REVIEW.

### Achados e disposição

1. [P1] (9/10) `server/services/gates.ts:37` usa `node_modules/.bin/tsc`; no Windows a pasta tem `tsc`
   (shim sh), `tsc.cmd` e `tsc.ps1`. O resolvedor **só** pode aceitar candidatos com extensão do
   `PATHEXT` quando o nome vem sem extensão, senão pega o shim sh e falha. → Aceito: regra no
   `resolverExecutavel` + teste.
2. [P1] (9/10) `test/gates.test.ts:57` cria `node_modules/.bin/tsc` como script sh; a expectativa de
   `detectGates` é o comando lógico, então segue válida; quem resolve `.cmd` é o spawn. → Aceito: manter
   `detectGates` devolvendo comandos lógicos (sem mudar testes), resolver só no spawn.
3. [P1] (8/10) `server/services/preview.ts:229` `process.kill(-pid)`: no Windows lança e o fallback
   `child.kill` mata só o shell. → Aceito: `matarArvore` com `taskkill /T /F`; o smoke confere a porta livre.
4. [P2] (7/10) Receita de preview versionada (`inhouse.config.json`) escrita no Mac usa sintaxe sh
   (`$PORT`, `&&`). Rodar no `cmd.exe` quebraria em silêncio. → Aceito: Git Bash no Windows, `cmd.exe` só
   de fallback, com aviso no log do preview.
5. [P2] (7/10) `server/services/projects.ts:276` compara `alvo === PROJECTS_DIR` com caixa; no Windows
   `c:\users\x\inhouse` passaria. → Aceito: usar `dentroDe` (que usa `relative`, sem caixa no win32) também
   nessa comparação.
6. [P2] (6/10) `pidsNaPorta`/`ehDescendente` (`lsof`/`ps`) não existem no Windows: já devolvem `[]`/`null`
   e não bloqueiam. → Adiado (fora de escopo, registrado).
7. [P3] (6/10) Resolver `PATH` a cada spawn faz `existsSync` em N pastas × M extensões. Escala: dezenas de
   spawns por tarefa, ~30 pastas × 4 extensões = ~120 stats por spawn, desprezível. → Aceito sem cache.

### Arquitetura (fluxo de um spawn)

```
serviço (gates/preview/projects/worktrees)
   │ spawnPortatil("npm", ["run","dev"], opts)
   ▼
platform.montarComando ──POSIX──▶ spawn("npm", args)                       (igual a hoje)
   │win32
   ├─ resolverExecutavel: PATH × PATHEXT ─▶ C:\...\npm.cmd
   └─ .cmd/.bat ─▶ spawn("cmd.exe", ["/d","/s","/c", "\"C:\...\npm.cmd\" ^\"run^\" ^\"dev^\""],
                         { windowsVerbatimArguments: true, windowsHide: true })
parar: platform.matarArvore(pid) ──POSIX──▶ kill(-pid) │ win32 ──▶ taskkill /pid N /T /F
```

### Modos de falha

| Caminho novo | Falha realista | Tratado? |
|---|---|---|
| `resolverExecutavel` | npm fora do PATH (instalado por nvm-windows sem PATH) | sim: cai no nome cru → `ENOENT` → mensagem amigável já existente |
| `.cmd` via `cmd.exe` | argumento com `&`/`"` vira injeção | sim: escape `^` de metacaracteres (teste) |
| `taskkill` | processo já morreu | sim: erro ignorado |
| Git Bash ausente | receita com `$PORT` | parcial: fallback `cmd.exe` + aviso no log |
| `renameComRetry` | antivírus segura o arquivo > 1s | sim: lança o erro original depois das tentativas |

Lacunas críticas: 0.

### Testes exigidos

Unit `platform.ts` (Windows simulado + POSIX), unit `renameComRetry`, suíte existente rodando de verdade
no `windows-latest` (preview real com `npm run dev`, gates reais, worktrees reais) e o smoke. Ajustar só
testes que dependem de sh (`#!/bin/sh` executável) para pular/adaptar no win32.

### Outside voice

Pulado: execução autônoma sem pessoa para arbitrar divergências; o CI em 3 SOs é a segunda opinião
objetiva.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | — | Independent 2nd opinion | 0 | skipped | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN (mapeados no plano) | 7 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | sem UI nova |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** skipped (execução autônoma).
- **VERDICT:** ENG revisado; achados 1–5 e 7 viram trabalho do plano, 6 adiado. Pronto para implementar.

NO UNRESOLVED DECISIONS
