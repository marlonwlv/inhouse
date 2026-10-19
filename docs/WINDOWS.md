# Inhouse no Windows

Guia para instalar e usar o Inhouse num computador com Windows 10 ou 11, sem
precisar saber programar. No fim tem uma lista de conferência para quem for
testar o Inhouse numa máquina Windows de verdade.

> No Mac o jeito é o mesmo, com `setup.command` e `inhouse.command`: veja
> [`docs/MAC.md`](MAC.md).

## Em resumo: dois cliques

1. **Baixe o InHouse** (com quem cuida do projeto, ou no GitHub em **Code → Download ZIP**) e
   extraia a pasta num lugar fácil, por exemplo `Documentos\inhouse`.
2. Dê **dois cliques em `inhouse.cmd`**.

Pronto. Na primeira vez, o InHouse se prepara sozinho: baixa o Node 24 e as
dependências, e abre no navegador a tela **Preparar o computador**. Ali você vê
um checklist e clica em **Instalar o que falta**. Ele instala o Git (com o Git Bash),
o Claude Code e, se você quiser, o GitHub CLI. Depois:

- **Entrar no Claude:** o botão abre a página do Claude. Você entra com a sua conta e cola
  o código que aparecer. O InHouse usa a sua assinatura, nunca uma chave de API.
- **Seu nome no Git:** nome e e-mail que aparecem nas versões salvas. Não precisa de
  conta no GitHub, e nada é enviado para esse e-mail.

Quando tudo fica verde, clique em **Começar a usar**. Das próximas vezes o
`inhouse.cmd` abre direto nos seus apps.

> Evite colocar a pasta dentro do OneDrive: a sincronização segura os arquivos e
> deixa tudo mais lento.

> Se o Windows mostrar "O Windows protegeu o computador", clique em **Mais informações →
> Executar assim mesmo**. Isso aparece porque o arquivo veio da internet.

### Sem senha de administrador

O Node, o Git portátil e o GitHub CLI ficam em `C:\Users\<você>\.inhouse\ferramentas`.
O Claude Code vai para `C:\Users\<você>\.local\bin` pelo instalador oficial. Se o
computador tiver o **winget**, o Git for Windows é instalado por ele (o Windows pode
perguntar "Sim"); se não der, o InHouse usa o Git portátil. Todo download vem do site
oficial e é conferido pelo SHA-256 antes de instalar.

### `setup.cmd`: preparar tudo de uma vez

O `setup.cmd` faz a preparação inteira numa janela, sem abrir a tela: Node, dependências,
Git, Claude Code e gh. No fim ele abre o InHouse. Pode rodar quantas vezes quiser: o que já
está pronto é pulado. O login no Claude e o nome no Git continuam na tela do InHouse.

### Abrir o InHouse

Dê **dois cliques em `inhouse.cmd`**. Uma janela preta abre e, em alguns segundos, o navegador abre o InHouse.

- **Deixe a janela preta aberta** enquanto usa o InHouse.
- Para fechar o InHouse, feche a janela preta.
- Na primeira vez, o Windows pode perguntar se o **Node.js** pode usar a rede. Escolha **Permitir** (só redes privadas basta). O InHouse só escuta no seu próprio computador.

Seus apps ficam em `C:\Users\<você>\Inhouse` e o estado do Inhouse em `C:\Users\<você>\.inhouse`.

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| "Sem internet para baixar o Node" | Confira a conexão e dê dois cliques no `inhouse.cmd` de novo. |
| Algo ficou vermelho na tela Preparar o computador | Clique em **Tentar de novo**. O botão **Ver detalhes** mostra o que aconteceu. |
| O preview diz que não achou o Git Bash | Abra a tela Preparar o computador (menu do InHouse) e instale o Git de novo. |
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
- Preparação por linha de comando: `npx tsx server/setup/cli.ts verificar [--json]` e `instalar [--itens node,git,gitbash,claude,gh] [--simular]`. `INHOUSE_TOOLS_DIR` muda a pasta das ferramentas e `INHOUSE_FORCAR_PORTATIL=node,git,gh` força as versões portáteis (o CI usa os dois numa pasta temporária).
- `setup.ps1` aceita `-Verificar`, `-Simular`, `-Basico`, `-NaoAbrir` e `-SemPausa`.
- Ainda não existe app empacotado (instalador) para Windows. Por enquanto o uso é com os `.cmd`.

## Checklist de teste manual (máquina Windows de verdade)

Use uma conta de Windows "normal" (sem ser desenvolvedor), de preferência com o nome de usuário **com espaço ou acento** (ex.: `João Silva`), que é o caso mais difícil. Marque cada item:

**Instalação (computador sem Node, sem Git e sem Claude)**
- [ ] `inhouse.cmd` com dois cliques: baixa o Node portátil, instala as dependências e abre a tela "Preparar o computador".
- [ ] "Instalar o que falta" instala Git, Git Bash e Claude Code sem pedir senha de administrador.
- [ ] "Entrar no Claude": a página abre, o código colado é aceito e o item fica verde.
- [ ] "Seu nome no Git": salvar nome e e-mail deixa o item verde; "Começar a usar" leva aos apps.
- [ ] `setup.cmd` rodado de novo pula tudo com `[ok]`.
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
