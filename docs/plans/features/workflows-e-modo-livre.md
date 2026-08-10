# Workflows configuráveis + Modo Livre (tarefa sem esteira)

- **Categoria:** features
- **Data:** 2026-08-08
- **Status:** Concluído (Modo Livre + Workflows incr. 1–3) · porteiras ligáveis/desligáveis entregues

## Progresso

- **Modo Livre** — ✅ entregue e QA. Tarefa sem esteira: sessão direta resumível, publicar quando
  quiser, skills no prompt. Seletor Esteira|Livre na nova tarefa; editor sem stepper/porteiras.
- **Workflows incremento 1** — ✅ motor + tela. Catálogo de skills instaladas
  (`server/workflow/library.ts` + `GET /api/workflows`), biblioteca de workflows (3 presets +
  custom CRUD, ativo global/por-projeto, persistido em `~/.inhouse/workflows.json`), integração na
  máquina (`activeConfig` no lugar do `loadConfigCascata` para as skills), e a tela **Configurações →
  Workflows** (principal limpa com "workflow em uso" em linguagem simples + biblioteca com troca por
  projeto + **drawer de edição manual** com picker da lista fixa). Testes: `test/library.test.ts`.
- **Workflows incremento 2** — ✅ **Ajustar com IA**. Endpoint `POST /api/workflows/gerar`
  (`server/workflow/gerar.ts`): recebe instrução (+ proposta atual p/ refinar), roda o Claude sem
  transcript/sem ferramentas, e devolve uma PROPOSTA **sempre validada e filtrada pelo catálogo**
  (skill inventada é descartada — nunca chama skill inexistente). UI de **conversa iterativa** na tela
  de Configurações (propõe → você ajusta → refaz → "Usar este workflow" salva como custom `origem:"ia"`
  e ativa no projeto). Testes: `test/gerar.test.ts`. Smoke real: "sem reviews, mas segurança+QA antes de
  publicar" → gerou `verificacoes:[security-review, qa]`.
- **Workflows incremento 3** — ✅ **porteiras ligáveis/desligáveis**. O workflow agora carrega `gates`
  (`aprovacao`, `aprovacao_prototipo`, `teste`; só grava as DESLIGADAS — `false`). `publicar` é sempre
  humana. A máquina lê `activeGates(projectId)` e, na porteira desligada, **auto-avança** em vez de
  parar (helpers `pousarAprovacao`/`pousarPrototipoGate`/`pousarTeste` + `avancarApos*`). A IA
  (`gerar.ts`) desliga porteiras quando a pessoa pede ("não me peça aprovação"); o parse só aceita
  `false` e nunca toca `publicar`. UI: toggles no drawer avançado + resumo em "workflow em uso"
  ("sem te parar em: …") + card da proposta refletindo o que ficou automático. Testes:
  3 novos em `test/machine.test.ts` (aprovacao/teste/aprovacao_prototipo off → auto-avança).
  Smoke real: gerar "não me peça aprovação do plano" → `gates:{aprovacao:false}`.

Dois pedidos relacionados, prototipados e aprovados pelo Marlon (artifacts):
- 4 opções → barra enxuta → **tela de Workflows** (AI-first + drawer avançado) → **jornada completa** (edição por IA como conversa iterativa).

## Parte A — Modo Livre (implementando agora)

Uma tarefa pode rodar **sem a esteira**: o usuário conduz o Claude direto e escolhe as skills no
próprio prompt. É o "clean/fast" — batizado **Livre** (não colide com o preset "Rápido").

- **Modelo:** `Task.modo?: "esteira" | "livre"` (ausente = esteira). Livre nasce no passo `execucao`.
- **Máquina:** `runLivre(taskId, prompt)` — sessão única resumível em `acceptEdits` + gate de permissão
  + `settingSources:[user,project]` (pra `/skill` do usuário rodar). Sem espec/plano/verificações/porteiras.
  Ao terminar um turno sem mensagens novas → `aguardando` (espera o usuário). `steer` numa tarefa livre
  ociosa **dispara um novo turno** (em vez de só enfileirar). `publish` liberado a qualquer momento
  (quando não está rodando). Pausar/retomar/cancelar/arquivar funcionam igual.
- **API:** `POST /api/tasks` aceita `modo`.
- **UI:** seletor **Esteira | Livre** na caixa de nova tarefa; card e editor de tarefa livre **sem
  stepper e sem porteiras** — só chat (sempre aberto), preview sob demanda e um **Publicar** persistente.
  Placeholder do compositor deixa claro que dá pra pedir `/review`, `/qa`, etc.
- **Testes:** máquina (cria livre → roda sessão → steer dispara novo turno → publish conclui).

## Parte B — Workflows configuráveis (próximo passo)

Tela **Configurações → Workflows**, desenhada nos protótipos. Escopo combinado: **moldar as fases**
(não reordenar/criar etapas livres — isso rearquiteta a máquina).

- **Tela principal limpa, AI-first (leigo):** "workflow em uso" em linguagem simples + hero **Ajustar
  com IA** (conversa **iterativa**: propõe → você pede ajuste → refaz mostrando o delta → aplica) +
  biblioteca de workflows pra escolher. **Manter a edição manual** (pedido do Marlon).
- **Edição avançada (técnico), num drawer:** pipeline por fase, condições ("só com tela"),
  ligar/desligar porteiras, por porte. Skills vêm de uma **lista fixa das instaladas** — o picker e a
  geração por IA só escolhem daí (nunca inventam skill inexistente).
- **Backend:** (1) catálogo de skills instaladas (detecção real via gstack + built-ins); (2) biblioteca
  de workflows nomeados salvos (global + override por projeto), evoluindo o `inhouse.config.json`/
  `config.json` atual; (3) endpoint de **geração/refino por IA** que recebe prompt + workflow atual,
  chama o Claude restrito ao catálogo e devolve o config validado pra preview; (4) integração na
  máquina: usar o workflow ativo e **auto-avançar porteiras desligadas** (mudança sensível — cuidado).
- **Sequência sugerida:** catálogo de skills → biblioteca/persistência → geração por IA → tela +
  drawer → integração na máquina (porteiras) → testes + QA.
