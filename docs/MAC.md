# InHouse no Mac

Guia para instalar e usar o InHouse num Mac (Apple Silicon ou Intel), sem
precisar saber programar e sem abrir o Terminal.

> Prefere um app de verdade, com ícone na barra de menus? Veja o DMG do
> [app de menu bar](plans/features/app-mac-menu-bar.md). Este guia é para a
> pasta baixada, com `inhouse.command`.

## Em resumo: dois cliques

1. **Baixe o InHouse** (com quem cuida do projeto, ou no GitHub em **Code → Download ZIP**)
   e coloque a pasta num lugar fácil, por exemplo `Documentos/inhouse`.
2. Dê **dois cliques em `inhouse.command`**.

Na primeira vez, o InHouse se prepara sozinho: baixa o Node 24 e as dependências, e
abre no navegador a tela **Preparar o computador**. Ali você vê um checklist e clica
em **Instalar o que falta**:

- **Git:** vem das ferramentas da Apple. O Mac abre uma janela da Apple pedindo para
  instalar. Clique em **Instalar** e espere. O InHouse percebe sozinho quando acaba.
- **Claude Code:** instalado pelo instalador oficial em `~/.local/bin`.
- **GitHub CLI** (opcional): só se você for publicar no GitHub.

Depois:

- **Entrar no Claude:** o botão abre a página do Claude. Você entra com a sua conta e cola
  o código que aparecer. O InHouse usa a sua assinatura, nunca uma chave de API.
- **Seu nome no Git:** o nome e o e-mail que aparecem nas versões salvas. Não precisa de
  conta no GitHub, e nada é enviado para esse e-mail.

Quando tudo fica verde, clique em **Começar a usar**. Das próximas vezes o
`inhouse.command` abre direto nos seus apps.

### "Não é possível abrir porque é de um desenvolvedor não identificado"

O macOS mostra isso na primeira vez para arquivos baixados da internet. Para liberar:

1. **Clique com o botão direito** (ou Control + clique) em `inhouse.command`.
2. Escolha **Abrir**.
3. Na janela que aparece, clique em **Abrir** de novo.

Isso só é preciso uma vez. Em versões novas do macOS, se não aparecer o botão
**Abrir**, vá em **Ajustes do Sistema → Privacidade e Segurança** e clique em
**Abrir Mesmo Assim**.

### Sem senha de administrador

O Node e o GitHub CLI ficam em `~/.inhouse/ferramentas` e o Claude Code em
`~/.local/bin`. Todo download vem do site oficial e é conferido pelo SHA-256 antes de
instalar. A única janela que pode aparecer é a da Apple para as ferramentas do Git.

### `setup.command`: preparar tudo de uma vez

O `setup.command` faz a preparação inteira numa janela do Terminal, sem abrir a tela:
Node, dependências, Git, Claude Code e gh. No fim ele abre o InHouse. Pode rodar quantas
vezes quiser, porque o que já está pronto é pulado. O login no Claude e o nome no Git
continuam na tela do InHouse.

### Abrir o InHouse

Dê **dois cliques em `inhouse.command`**. Uma janela do Terminal abre e, em alguns
segundos, o navegador abre o InHouse.

- **Deixe a janela do Terminal aberta** enquanto usa o InHouse.
- Para fechar o InHouse, feche essa janela.

Seus apps ficam em `~/Inhouse` e o estado do InHouse em `~/.inhouse`.

## Problemas comuns

| O que aparece | O que fazer |
|---|---|
| "Sem internet para baixar o Node" | Confira a conexão e dê dois cliques no `inhouse.command` de novo. |
| A janela da Apple não apareceu | Na tela Preparar o computador, clique em **Instalar o que falta** de novo. |
| Algo ficou vermelho na tela | Clique em **Tentar de novo**. **Ver detalhes** mostra o que aconteceu. |
| A porta 4400 está ocupada | Já tem um InHouse aberto: procure a outra janela do Terminal. |

## Para quem é técnico

- `scripts/mac/setup.sh` aceita `--verificar`, `--simular`, `--basico`, `--nao-abrir` e
  `--sem-pausa`. O `inhouse.command` chama `--basico` quando falta o Node ou as dependências
  (a marca é `node_modules/.inhouse-deps`, com o hash do `package-lock.json` e a versão do Node).
- O Node do sistema vale se for 24 ou maior. O portátil só entra quando ele falta.
- Preparação por linha de comando: `npx tsx server/setup/cli.ts verificar [--json]` e
  `instalar [--itens node,git,claude,gh] [--simular]`.
- `INHOUSE_TOOLS_DIR` muda a pasta das ferramentas e `INHOUSE_FORCAR_PORTATIL=node,gh` força
  as versões portáteis. O CI instala de verdade numa pasta temporária no `macos-latest`.

## Checklist de teste manual (Mac de verdade)

- [ ] Mac sem Node: `inhouse.command` baixa o Node portátil, instala as dependências e abre a tela.
- [ ] Mac sem as ferramentas da Apple: "Instalar o que falta" abre a janela da Apple e o Git fica verde no fim.
- [ ] "Entrar no Claude": a página abre, o código colado é aceito e o item fica verde.
- [ ] "Seu nome no Git" e "Começar a usar" levam aos apps; abrir de novo vai direto.
- [ ] Clique direito → Abrir libera o `inhouse.command` baixado da internet.
- [ ] O app de menu bar continua abrindo normalmente.
