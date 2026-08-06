# Inhouse — guia rápido

Bem-vindo(a)! O **Inhouse** deixa você criar e alterar apps da Inhouse conversando em
português, sem terminal e sem mexer no código na mão. Tudo o que você fizer vira um
**Pull Request** (uma proposta de mudança) para o time revisar — nada vai direto para o
ar, e a sua cópia de trabalho do projeto **nunca é tocada**.

Este guia tem 5 minutos. Você usa **Mac**.

---

## 1. Instalar (uma vez só)

1. Baixe/clone esta pasta (`inhouse`) para o seu computador.
2. Dê um **duplo-clique** em **`setup.command`**.
   - Vai abrir uma janela preta (o Terminal) e preparar tudo sozinho.
   - Se aparecer um aviso do Mac dizendo que o arquivo "não pode ser aberto", vá em
     **Ajustes do Sistema → Privacidade e Segurança** e clique em **Abrir mesmo assim**.
3. Espere aparecer **"Tudo pronto!"** e feche a janela.

> Se o setup avisar que falta o **Node** ou o **Claude**, siga a mensagem — ela diz
> exatamente o que instalar. Depois é só rodar o `setup.command` de novo.

## 2. Conectar o Claude (uma vez só)

O Inhouse usa a **sua assinatura do Claude** — nada de chaves ou cartão.

1. Abra o app **Terminal** (aperte `⌘ + Espaço`, digite **Terminal** e Enter).
2. Digite **`claude`** e tecle Enter. Se ele pedir, faça o **login** que abre no navegador.
3. Pronto. Pode fechar o Terminal.

Na tela inicial do Inhouse, o indicador **"Claude conectado"** fica verde sozinho
assim que você loga. Enquanto estiver desconectado, os botões ficam desativados de
propósito (e o próprio Inhouse mostra esse passo-a-passo).

## 3. Abrir o Inhouse

Dê um **duplo-clique** em **`inhouse.command`**. Ele sobe o app e abre o navegador em
`http://127.0.0.1:4400`. Para **fechar**, é só fechar aquela janela do Terminal.

---

## 4. Usar

### Abrir um projeto
Na tela inicial, em **Abrir do GitHub**, cole o endereço do repositório (ex.: o
**seu-monorepo**) e clique **Baixar e abrir**. O Inhouse baixa uma cópia **só dele** —
separada da sua cópia de trabalho de sempre.

### Criar uma tarefa
Entre no projeto e descreva o que você quer, em português. Exemplos:
- *"trocar o texto do botão de login para 'Entrar na Inhouse'"*
- *"deixar o card de turmas com cantos mais arredondados"*

A tarefa roda num **espaço isolado** e passa por estas etapas:

**Espec → Plano → Sua aprovação → Execução → Verificações → Seu teste → Publicar**

- Nos losangos (**Sua aprovação**, **Seu teste**, **Publicar**) a tarefa **espera você**.
- Se o plano estiver demorando e for algo simples, use **"É uma mudança simples — ir
  direto ao plano"** para pular as revisões.

### Ver a mudança (preview)
Na tela da tarefa, clique **Iniciar preview** para ver o app rodando com a sua mudança.
- Se o projeto não subir sozinho, aparece **"Pedir ao Claude para configurar o
  preview"** — clique e ele descobre como abrir. Na segunda vez já abre direto.
- Alguns projetos não têm tela para pré-visualizar (são "de bastidor") — aí você usa o
  chat e as mudanças de arquivo mesmo.

### Publicar
Quando gostar do resultado, clique **Publicar**. No seu-monorepo (e em qualquer repo do
GitHub) isso **abre um Pull Request** para o time revisar — **nunca** manda direto para
o `main`, e **não** mexe na sua cópia de trabalho.

### Modo auto (opcional)
O botão **Auto** deixa o Claude seguir sem te perguntar cada passo. Ligue **só** numa
tarefa em que você confia — o Inhouse pede uma confirmação antes.

---

## O que é seguro

- ✅ Cada tarefa fica num **espaço isolado** — uma não atrapalha a outra.
- ✅ **Publicar = Pull Request.** O time revisa antes de qualquer coisa ir para o ar.
- ✅ A sua **cópia de trabalho** do projeto nunca é modificada pelo Inhouse.
- ✅ O Claude roda com a **sua assinatura**; nada sai do seu computador além da conversa
  com o Claude.

## Se algo travar

- **"Claude desconectado"** → abra o Terminal, rode `claude`, faça login.
- **O preview não sobe** → use **"Pedir ao Claude para configurar o preview"**.
- **Qualquer outra coisa** → chame o time no canal de sempre. Você não quebra nada:
  no pior caso, é só fechar e abrir o `inhouse.command` de novo.

---

## Para o time técnico: preview do seu-monorepo

O seu-monorepo é um monorepo **pnpm + Next**, e o `apps/web` precisa do `.env.local`
(que é gitignored). Para o preview subir de primeira, comite na raiz do seu-monorepo um
`inhouse.config.json` com o bloco `preview`:

```json
{
  "preview": {
    "cmd": "pnpm --filter @app/web dev",
    "cwd": ".",
    "port": 3000,
    "envFiles": ["apps/web/.env.local"]
  }
}
```

Sem esse bloco, o Inhouse ainda tenta auto-detectar e, se falhar, o botão
**"Pedir ao Claude para configurar o preview"** descobre a receita e a guarda para as
próximas vezes.
