# Inhouse no Windows

Guia para instalar e usar o Inhouse num computador com Windows 10 ou 11, sem
precisar saber programar. No fim tem uma lista de conferência para quem for
testar o Inhouse numa máquina Windows de verdade.

> No Mac continua tudo igual: `setup.command` e `inhouse.command` (ou o app de
> menu bar). Este guia é só para o Windows.

## O que você vai instalar (uma vez só)

| Programa | Para que serve | Obrigatório? |
|---|---|---|
| **Node.js 24** | roda o Inhouse | sim |
| **Git for Windows** | guarda as versões do app e traz o **Git Bash**, que o Claude e o preview usam | sim |
| **Claude Code** | o "cérebro" que faz as mudanças, usando a sua assinatura do Claude | sim |
| GitHub CLI (`gh`) | abre Pull Requests sozinho | não |

## Passo a passo

### 1. Instale o Node.js 24

1. Abra <https://nodejs.org> e baixe a versão **24** (ou a marcada como "LTS", se for 24 ou maior) **para Windows**.
2. Abra o arquivo baixado e clique em **Next** até terminar. Pode deixar todas as opções como vieram.

### 2. Instale o Git for Windows

1. Abra <https://git-scm.com/download/win> e baixe o instalador.
2. Abra o arquivo e clique em **Next** até terminar, sem mudar nada. É importante deixar marcado o **Git Bash** (ele já vem marcado).

### 3. Instale o Claude Code e faça o login

1. Aperte a tecla **Windows**, digite **PowerShell** e aperte Enter.
2. Na janela azul que abrir, cole a linha abaixo e aperte Enter:

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```

3. Quando terminar, **feche essa janela e abra outra** (do mesmo jeito do item 1).
4. Digite `claude` e aperte Enter. Ele abre o navegador para você entrar com a sua conta do Claude. Faça o login e volte.
5. Pode fechar a janela.

> Se a sua empresa usa o Claude Code instalado pelo npm (`npm install -g @anthropic-ai/claude-code`), também funciona: o Inhouse acha os dois jeitos.

### 4. Baixe o Inhouse

Pegue a pasta do Inhouse com quem cuida do projeto (ou baixe do GitHub em **Code → Download ZIP** e extraia).
Coloque a pasta num lugar fácil, por exemplo `Documentos\inhouse`.

> Evite colocar dentro de uma pasta sincronizada com OneDrive: a sincronização
> segura os arquivos e deixa tudo mais lento.

### 5. Prepare a máquina

Dentro da pasta do Inhouse, dê **dois cliques em `setup.cmd`**.

Ele confere o Node, o Git, o Git Bash e o Claude, e instala o que o Inhouse precisa. Se faltar algo, ele explica em português o que fazer. No fim aparece **"Tudo pronto!"**.

> Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**. Isso aparece porque o arquivo veio da internet.

### 6. Abra o Inhouse

Dê **dois cliques em `inhouse.cmd`**. Uma janela preta abre e, em alguns segundos, o navegador abre o Inhouse em <http://127.0.0.1:4400>.

- **Deixe a janela preta aberta** enquanto usa o Inhouse.
- Para fechar o Inhouse, feche a janela preta.
- Na primeira vez, o Windows pode perguntar se o **Node.js** pode usar a rede. Escolha **Permitir** (só redes privadas basta). O Inhouse só escuta no seu próprio computador.

Seus apps ficam em `C:\Users\<você>\Inhouse` e o estado do Inhouse em `C:\Users\<você>\.inhouse`.

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| "Não encontrei o Node 24" | Instale o Node 24 (passo 1) e rode o `setup.cmd` de novo. |
| "Claude Code não encontrado" no Inhouse | Faça o passo 3 de novo. Depois feche e reabra o `inhouse.cmd`. |
| O preview diz que não achou o Git Bash | Reinstale o Git for Windows (passo 2) sem desmarcar o Git Bash. |
| "Filename too long" | Rode o `setup.cmd` de novo: ele liga o suporte a caminhos longos no git. |
| A porta 4400 está ocupada | Já tem um Inhouse aberto: procure a outra janela preta. |

## Para quem é técnico

- `npm run dev`, `npm run dev:fake`, `npm start`, `npm test` e `npm run smoke` funcionam igual em PowerShell, cmd e Git Bash.
- Onde o Inhouse procura o Claude: `INHOUSE_CLAUDE_PATH`, depois `where claude` (prefere `claude.exe`), depois `%USERPROFILE%\.local\bin\claude.exe` e `%APPDATA%\npm\claude.cmd`. O `claude.cmd` do npm é traduzido para o `cli.js` dele, que o SDK roda com o Node.
- `npm`, `npx`, `pnpm` (via corepack) e `.bin\*.cmd` rodam por `cmd.exe /d /s /c` com escape, sem `shell: true`.
- Receitas de preview (`cmd` e `setup` no `inhouse.config.json`) rodam no **Git Bash**, então a mesma receita vale no Mac e no Windows. O Git Bash é achado por `CLAUDE_CODE_GIT_BASH_PATH` ou ao lado do `git.exe`. Sem ele, a receita cai no `cmd.exe` e o log do preview avisa.
- Encerrar o preview derruba a árvore de processos inteira com `taskkill /T /F`.
- O git roda com `core.longpaths=true` e o `state.json` é gravado com nova tentativa quando o antivírus segura o arquivo (EPERM/EBUSY).
- O CI (`.github/workflows/ci.yml`) roda typecheck, vitest e o smoke em `windows-latest`, `macos-latest` e `ubuntu-latest`.
- Ainda não existe app empacotado (instalador) para Windows. Por enquanto o uso é com os `.cmd`.

## Checklist de teste manual (máquina Windows de verdade)

Use uma conta de Windows "normal" (sem ser desenvolvedor), de preferência com o nome de usuário **com espaço ou acento** (ex.: `João Silva`), que é o caso mais difícil. Marque cada item:

**Instalação**
- [ ] `setup.cmd` com dois cliques: mostra Node, git, Git Bash e Claude com `[ok]` e termina em "Tudo pronto!".
- [ ] Sem o Node instalado, o `setup.cmd` explica o que fazer, não fecha sozinho e não mostra erro em inglês.
- [ ] Os acentos aparecem certos na janela (sem `Ã©` no lugar de `é`).

**Abrir**
- [ ] `inhouse.cmd` abre o navegador sozinho em <http://127.0.0.1:4400>.
- [ ] O rodapé mostra "Claude conectado · sua assinatura · v…".
- [ ] Com o Claude desligado/deslogado, o painel "Conecte o Claude" fala em **PowerShell** (não em Terminal/⌘).

**Criar um app**
- [ ] "Criar app" pelo modelo: aparece "Instalando dependências…" e depois "Pronto".
- [ ] A pasta do app aparece em `C:\Users\<você>\Inhouse\<nome-do-app>`.

**Tarefa completa**
- [ ] Criar uma tarefa simples ("mude o título da página para Olá"): a esteira passa por plano, execução e verificações.
- [ ] As verificações (TypeScript) rodam e passam (isso prova `npm run typecheck` pelo `npm.cmd`).
- [ ] O preview abre dentro do Inhouse e mostra a mudança.
- [ ] "Reiniciar preview" funciona. Depois de "Parar", **nenhum** `node.exe` do preview fica sobrando no Gerenciador de Tarefas.
- [ ] Publicar/integrar a tarefa funciona (o commit aparece no histórico do projeto).

**Projeto existente**
- [ ] "Abrir pasta" com um projeto que já existe no computador funciona.
- [ ] Abrir `C:\Users\<você>` é recusado ("pasta ampla demais").
- [ ] Um projeto com `node_modules` fundo (ex.: Next.js) não dá "Filename too long" ao criar a tarefa.

**Fechar**
- [ ] Fechar a janela preta encerra o Inhouse **e** os previews: depois disso, <http://127.0.0.1:4400> não abre e as portas 4500+ ficam livres.
- [ ] Abrir de novo com `inhouse.cmd`: os projetos e as tarefas continuam lá.

Se algo falhar, mande para o time técnico: um print da tela, o texto da janela preta e o arquivo `C:\Users\<você>\.inhouse\state.json`.

## Roteiro rápido de teste automático

```powershell
npm ci
npm run typecheck
npm test
npm run smoke   # sobe o servidor de verdade com o modelo fingido e exercita projeto, tarefa, worktree e preview
```
