# Indicador de pensamento no chat ("Pensando…" com o verbo do momento)

- **Categoria:** features
- **Data:** 2026-08-14
- **Status:** Concluído

## Problema

Enquanto o Claude trabalha, o chat fica parado por longos períodos (pensando antes
de escrever, ou entre uma ferramenta e outra). Para quem não é técnico, silêncio
parece travamento — não havia nenhum sinal de vida dentro da conversa.

## Decisão (protótipo aprovado)

Protótipo com 5 opções em `docs/plans/mockups/indicador-pensamento/`. Aprovada a
**opção 2 (texto "Pensando…" com brilho varrendo, estilo apps de IA) com um toque
da opção 5 (cronômetro discreto)**:

- O indicador aparece **onde a resposta vai nascer** (fim do transcript, antes dos
  cards), com shimmer monocromático fiel ao design system.
- O texto **segue os eventos reais** (nunca mente): sem evento → "Pensando…";
  Editar/Criar → "Fazendo a mudança…"; Rodar → "Rodando um comando…"; Ler/Buscar →
  "Lendo o projeto…"; ferramentas de preview → "Conferindo o preview…"; internet →
  "Pesquisando na internet…"; subtarefa → "Trabalhando numa subtarefa…"; sistema
  "Rodando a verificação…" → "Rodando as verificações…".
- **45s na mesma atividade** → ganha cronômetro (" · 1:20") — responde ao "travou?"
  só quando a dúvida existe, sem poluir esperas curtas.
- **Some** quando: o texto começa a chegar (streaming), um pedido de permissão
  aguarda a pessoa (o card é o foco), ou a fase termina.

## Implementação

- `public/app.js` (UI 0.26.0): `verboDoMomento(items)` + `syncPensando(taskId)`
  (idempotente — cria/atualiza/remove `#pensando` antes de `#chat-cards`).
  Chamado no fim de `renderChat`, em `appendChatDom` (item novo entra ANTES do
  indicador) e por um ticker de 1s (cronômetro anda sem eventos novos).
  `onChatDelta` remove o indicador quando o streaming começa.
- `public/styles.css`: token `--pensando-glow` (claro/escuro), classe `.pensando`
  (gradiente com `background-clip: text` + animação `pensando-varre`),
  `prefers-reduced-motion` cai para texto estático.

## O que ficou de fora (consciente)

- Anel girando no botão de parar (opção 3): dá para somar depois, é ortogonal.
- O indicador não aparece para quem olha a tarefa sem ser o editor (chat fechado).
