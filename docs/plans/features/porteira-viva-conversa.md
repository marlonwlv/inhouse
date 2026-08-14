# Porteira viva — conversar com a IA sem sair da etapa (a esteira segue o agente)

- **Categoria:** features
- **Data:** 2026-08-13
- **Ao aprovar:** salvar em `docs/plans/features/porteira-viva-conversa.md` + atualizar `docs/plans/README.md`.

## Contexto

Caso real (task da Leapy): no "Seu teste", o usuário escreveu **"Me dê um roteiro de testes"** — uma pergunta. O Inhouse roteou como `request_changes` → Execução → o modelo criou um arquivo de roteiro e saiu **executando** o roteiro; as verificações desmontaram o preview. Na aprovação, a pergunta "você passou por todo o office-hours?" disparou um replano de 8 minutos.

Causa confirmada no código: `changesPrompt` (`server/workflow/phases.ts`) emoldura QUALQUER mensagem como ordem ("o usuário **pediu as seguintes mudanças** … **Faça os ajustes**"), numa fase `acceptEdits` com ferramentas de escrita. O enquadramento é o prompt-injection que o usuário suspeitou.

Duas alternativas foram descartadas pelo usuário por deselegância: marcador de texto (`MUDANCA:`) e ferramenta de roteamento (`aplicar_mudanca`) — ambas mantinham um roteador visível entre "conversar" e "trabalhar", com duas fases e costura aparente.

## O desenho: transição por ação

**Um único turno. Nenhum roteador. A esteira reage ao que o agente FAZ.**

Mensagem digitada numa porteira parada (aprovação, aprovação do protótipo, Seu teste, Publicar) ou numa falha abre **uma fase única de conversa** (sessão retomada, `systemAppend` + tools de preview, prompt NEUTRO): *"O usuário escreveu durante {o seu teste}: … Responda como numa conversa, em português simples. Só altere o app se a mensagem claramente pedir uma mudança — pedidos de texto (ex.: um roteiro de teste) se respondem no chat."*

O **gate de permissões é o sensor de intenção** — todo uso de ferramenta já passa por ele:

1. **Só conversa** (Read/Grep/curl/preview_status/preview_logs): a fase termina, nada mudou → o estado anterior é RESTAURADO na íntegra (aguardando na porteira; falha preservada com o mesmo erro). Etapa nunca saiu do lugar, preview intocado.
2. **Primeira ferramenta de TRABALHO** → a esteira transiciona AO VIVO, no momento em que o trabalho começa de verdade:
   - **Porteiras de código** (Seu teste, Publicar, falhas de execução/verificações): `Write/Edit/MultiEdit/NotebookEdit` ou `preview_reiniciar` → linha no chat ("A conversa virou mão na massa — aplicando a mudança.") + `patch(step: "execucao")` (o pino desliza na UI) + o gate delega ao `createPreviewSetupGate` (curl localhost livre, dev server negado, resto HITL). Ao final: `filesTouched` → **verificação leve** (gates do projeto + saúde do preview VIVO — já construída; o preview não desmonta) → pousa de volta no teste.
   - **Porteira do plano** (aprovação; falhas de plano/detalhamento): o trabalho natural é EMITIR UM PLANO — o sinal é o `ExitPlanMode` nativo do SDK (o runner **já captura** `planText` em qualquer fase, `runner.ts`). Plano emitido → `task.plan` atualizado + sistema("Plano revisado a partir da conversa.") → CONTINUA aguardando aprovação, com o card novo. Pergunta → resposta, sem replano. Ferramentas de escrita de código ficam negadas com explicação ("o plano ainda não foi aprovado").
   - **Porteira do protótipo** (aprovação do protótipo; falha de protótipo): escrita em arquivos = atualizar os mockups → permitida via gate normal; ao final, sistema("Protótipo atualizado.") e continua na porteira (protótipo não roda verificação).
   - Exceção documentada: **falha de espec** mantém o contorno atual (mensagem re-roda a espec com a instrução) — não há sinal natural de trabalho ali e é o caso mais raro.

**Por que é melhor que as versões anteriores:**
- Zero latência extra (uma fase, não duas) e zero costura: para pedido real, o mesmo turno responde e executa.
- Nada mecânico aparece na conversa; o transcript conta a história sozinho (resposta → ferramentas → pino se move).
- Errar a classificação deixou de ser destrutivo: se o modelo criar um arquivo desnecessário, o pior caso é verificação LEVE com preview vivo — não o desmonte de hoje.
- O step da UI passa a refletir a realidade: muda quando o trabalho começa, não antes.

O botão **"Pedir mudanças"** dos cards permanece como caminho explícito e direto (`changesPrompt`, sem o turno de conversa) — para quem já sabe o que quer.

## Mudanças por arquivo

**`server/workflow/phases.ts`**
- `porteiraChatPrompt(local, msg)` — prompt neutro do turno (contém o literal "CONVERSA DA PORTEIRA" para o fake model). Variante do plano instrui: "para propor o plano revisado, use ExitPlanMode; não edite código antes da aprovação". Locais: seu teste / aprovação do plano / aprovação do protótipo / publicação / uma falha.

**`server/workflow/machine.ts`**
- `runPorteiraChat(taskId, msg)`: guarda (porteira aguardando OU falha elegível) → salva `{step, status, error}` → `patch({status: "rodando"})` **mantendo o step** (padrão do `runConsertoPreview`) → `runPhase` (resume, `acceptEdits` nas porteiras de código / `default`+disallowed write nas de plano, `previewPhaseOpts`, maxTurns ~30) → roteia pelo desfecho:
  - `gateComTransicao(taskId, tipo)`: wrapper de gate que, na PRIMEIRA ferramenta de trabalho, emite a linha de sistema + `patch(step: "execucao")` (só nas porteiras de código) e daí em diante delega ao `createPreviewSetupGate(taskId, gateComStatus(taskId))`.
  - Pós-fase: código+`filesTouched` → `runVerificacaoLeve` (existente) → `pousarTeste`; plano+`r.planText` → atualiza `task.plan`, volta `aprovacao/aguardando`; protótipo+`filesTouched` → sistema + volta à porteira; nada → restaura estado salvo.
- `steer()`: porteiras aguardando e falhas elegíveis (esteira) → `fireAndForget(runPorteiraChat)` (substitui o enfileira+avisa nesses estados). Execução rodando segue enfileirando; modo livre inalterado; falha de espec segue no contorno atual.
- `encaminharMudanca` (extração do roteamento do `request_changes`) permanece útil só para o botão explícito do card — sem mudanças de comportamento ali.

**`public/app.js`**
- Composer: remover a bifurcação — nas porteiras e falhas, TUDO vai para `POST /message`; o servidor decide. Cards mantêm os botões explícitos.
- Placeholders: teste → "Converse, tire dúvidas ou peça mudanças — eu respondo ou aplico"; aprovação → "Pergunte sobre o plano ou peça ajustes — eu revido o plano aqui mesmo"; falha → "Pergunte o porquê ou descreva um contorno".
- Nada mais: com o step preservado, o chip "Claude trabalhando · Seu teste" + streaming já mostram a conversa; a transição ao vivo já chega pela SSE (`task_updated` com step novo + linha de sistema).

**`server/debug/fakeModel.ts`**
- Branch antes da classificação por permissionMode: prompt contém "CONVERSA DA PORTEIRA" → resposta canned de conversa (sem filesTouched) — journeys intactos.

**Testes**
- `machine.test.ts`:
  - Pergunta no teste (via `steer`): prompt contém "CONVERSA DA PORTEIRA", step permanece `teste` durante e depois, volta a `aguardando`, `stopPreviewCalls` não cresce.
  - Trabalho no teste: o mock do `runPhase` invoca o `canUseTool` recebido com uma tool `Write` (simulando o agente agindo) e devolve `filesTouched: true` → step flipou para `execucao` DURANTE a fase, verificação leve rodou (gates do projeto), pousa de volta no teste.
  - Aprovação: pergunta → `task.plan` intacto, continua `aprovacao/aguardando`; fase devolve `planText` → plano atualizado, continua na porteira (sem `runPlano`).
  - Falha de execução: pergunta → erro/estado restaurados; trabalho → verificação e pouso normais.
  - Ajustar o teste existente "steer fora da execução enfileira e entrega" (no teste aguardando agora abre conversa; mover o cenário para execução rodando).
- `applyAction request_changes` (botão) segue coberto pelos testes atuais.

## O que NÃO muda

Steering durante execução (fila) · modo livre · fluxos de mudança em si (verificação leve, replano explícito, contorno de espec) · porteira de publicar sempre humana · botão "Pedir mudanças".

## Verificação

1. `npm run typecheck` + `npm test` verdes; `npm run debug` (journeys) intacto.
2. Real, no "Seu teste": **"me dá um roteiro de testes"** → resposta em texto, etapa continua "Seu teste", preview com a MESMA URL e sem reinício no Registro. **"muda o título da home para X"** → resposta curta, pino desliza para Execução no momento da primeira edição, verificação leve, volta ao teste com o preview vivo.
3. Na aprovação: "por que essa abordagem?" → resposta sem replano; "inclui exportação em PDF no plano" → card do plano atualizado, ainda aguardando aprovação.
4. Numa falha de execução: "por que falhou?" → explicação com o card de falha preservado; "contorna usando Y" → mão na massa + verificação + pouso.

## Refinamento (feedback do uso real, 2026-08-13)

O primeiro desenho ainda saía do "Seu teste" ao FINAL do trabalho (verificação
leve → step verificacoes → a UI desmontava o iframe; gate reprovando escalava
para a verificação completa, que derrubava o preview). Correções:

1. **Nunca sai do "Seu teste"**: o trabalho da conversa acontece com a etapa
   parada (nem o pino desliza mais); ao terminar, o Inhouse PERGUNTA — "quer
   testar primeiro ou já rodo as verificações?" — e marca
   `verificacoesPendentes` na tarefa. Elas rodam quando a pessoa pedir
   (botão "Rodar verificações agora" no card) ou, no mais tardar, no Aprovar
   (a porteira de segurança continua: verdes → publicar).
2. **Preview imortal pós-teste**: a UI mantém o iframe montado sempre que o app
   está no ar numa tarefa que já chegou ao teste (`historico` tem `teste`),
   mesmo durante execução/verificações; e a escalação de verificação completa
   ganhou `manterPreview` — com o preview vivo e saudável, confere a saúde no
   processo VIVO em vez de derrubar/re-subir.

## Etapa Revisão + celebração do merge (2026-08-14)

Protótipo aprovado em `docs/plans/mockups/revisao-e-publicar/`. Implementado:

- **Etapa "Revisão"** entre Seu teste e Publicar, só em projetos com GitHub
  (`temRevisao` na task; pino redondo — a vez é do time). "Enviar para
  revisão" abre o PR **preservando o espaço e o preview** (o loop de ajustes
  precisa da branch; a pessoa pode seguir testando).
- **Acompanhamento**: sondagem do PR via `gh` a cada 60s (`services/revisao.ts`
  + `iniciarSondagemRevisoes` no index.ts; testes dirigem `aplicarSondagem`
  direto). Revisor entrou/comentou/pediu ajustes/aprovou → linhas no chat
  (dedupe por assinatura) + card com estado e pendências + chip "com a
  engenharia"/"com você".
- **"Pedir para o Claude ajustar"**: o agente aplica os apontamentos na branch;
  gates baratos → commit+push+comentário no PR ("pronto para olhar de novo").
  A conversa da porteira também vale na Revisão — trabalho vira push no PR.
- **Aprovada** → etapa Publicar ("Publicar 🚀" = merge via gh). **Merge por
  qualquer um** (você ou o time, detectado pela sondagem) → 🚀 card
  "Publicado!" com quem/quando + **confete** (uma vez por navegador).
- **PR fechado sem merge** → volta ao Seu teste com explicação.
