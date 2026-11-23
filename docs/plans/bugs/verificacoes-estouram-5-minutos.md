# Verificações falham só por estourar o limite de 5 minutos

- **Categoria:** bugs
- **Data:** 2026-11-23
- **Status:** Concluído

## Sintoma
Em tarefas longas num monorepo (leapy, espaço 61), a etapa "Verificações" falhava em "Testes ✗" sem nenhum
teste quebrado: o pacote web sozinho (461 arquivos, 4.821 testes) leva ~3,5 min e a suíte inteira passa de 5 min.
O Claude da tarefa tentava "consertar", rodava os pacotes um a um (todos passando) e terminava em
"CONSERTO: impossivel — a verificação só estoura o limite de 5 min, que não posso alterar". A etapa levou 43 min
e ~US$ 300 de tokens sem chance de dar certo.

## Causa raiz
- `server/services/gates.ts`: `const GATE_TIMEOUT_MS = 5 * 60 * 1000;` fixo, sem configuração. Cada gate roda um
  comando só (`npm run test` na raiz), então o limite vale para a suíte inteira do monorepo.
- O estouro era reportado como uma falha comum ("Testes ✗"), e a esteira (`runVerificacoes` em
  `server/workflow/machine.ts`) mandava o Claude corrigir código que não estava quebrado.
- Achado junto: no Mac/Linux o corte matava só o `npm` (SIGKILL sem grupo); `sh` → vitest/turbo seguiam vivos
  segurando o stdout, e o `close` só vinha quando a suíte terminava sozinha — o limite nem cortava de verdade.

## Spec (curta)
1. Limite padrão de cada verificação: **30 min**.
2. Configurável por projeto: `inhouse.config.json` → `{ "verificacoes": { "timeoutMinutos": 45 } }` (1–240),
   na cascata de sempre (espaço → pasta principal → global `~/.inhouse/config.json`).
3. Estouro vira `GateResult.timedOut = true`, mensagem "Tempo esgotado … NÃO quer dizer que algo falhou", chip
   "Testes ⏱" na UI.
4. Se as únicas falhas forem de tempo: **sem auto-correção** do Claude; a tarefa para com mensagem clara
   ("não terminou dentro do limite de N minutos… foi só o tempo") e "Tentar de novo" re-roda só as verificações.
   Com falhas mistas, o prompt de conserto marca a de tempo como "NÃO FALHOU — não tente consertar".
5. Gate roda em grupo de processos próprio (`spawnOpcoes`) e o corte derruba a árvore toda.

Fora de escopo: rodar por pacote com limite por pacote (exigiria detectar o gerenciador do monorepo —
workspaces/turbo/nx/pnpm; 30 min + configurável já resolve o caso real).

## Revisão de engenharia
- Retrocompatível: `GateResult.timedOut` é opcional; config sem o bloco = 30 min.
- `detached` só no POSIX (Windows segue no `taskkill /T`), igual ao preview.
- Testes: `test/gates.test.ts` (corte real com processo pendurado, sem órfãos; config e sanitização),
  `test/machine.test.ts` (só tempo → nenhuma rodada de conserto, mensagem clara, retry segue para o teste).
