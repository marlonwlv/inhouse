# Inhouse — Eval de Experiência

> **Categoria:** features · **Criado:** 2026-08-06 · **Status:** Concluído
> Registro retroativo (o plano original ficou só no rascunho do plan mode). A plataforma captura, lembra e ranqueia sozinha os atritos de quem usa.

## Contexto

O Marlon sentiu atritos de experiência usando o Inhouse mas **não lembrava quais foram**. Objetivo: fazer a **plataforma capturar, lembrar e ranquear os atritos sozinha**, alimentando melhoria contínua — em vez de depender da memória de quem testou.

Escopo decidido: **captura automática + feedback 1-clique + relatório de Claude-juiz**, rodando **sob demanda + automaticamente a cada 10 tarefas finalizadas**. Golden tasks de regressão ficaram para v2 (porta aberta).

## Decisões

- **Padrão de 3 camadas** (prática de mercado, ex.: Hamel/Shreya error analysis): (1) métricas determinísticas sempre; (2) Claude-juiz com **rubrica fechada + evidência citada** e saída estruturada — nunca "avalie a UX" solto; (3) humano só lê os de severidade alta. Com o volume atual (poucas tarefas) julga-se 100%, sem amostrador.
- **Memória = `aprendizados.jsonl` com dedupe por chave**: o mesmo atrito reincidindo sobe `ocorrencias` e vira backlog. É isso que faz "o sistema lembrar por você".
- **Métricas norte**: principal = **taxa de tarefas publicadas sem resgate** (sem cancelar/falhar/estourar rodadas de correção); secundária = **tempo humano por tarefa publicada**.
- **Acúmulo por fase persistido na Task** (`Task.uso`), não mapa em memória — o server reinicia como caso normal e não pode perder o custo/tempo acumulado.
- **Gatilho automático sem estado**: conta tarefas finalizadas mais novas que o último relatório ≥ 10 → restart-proof.
- **Privacidade**: 100% local (`~/.inhouse/eval`), mesmo perímetro dos transcripts; guarda textos do usuário e erros truncados, nunca diffs/código.

## O que foi construído

- `server/eval/` — `registro.ts` (tipos JSONL), `derivar.ts` (função pura task+transcript→registro), `coleta.ts` (funil único de escrita, nunca derruba a esteira), `resumo.ts` (agregados), `juiz.ts` (relatório + aprendizados).
- **3 capturas novas nos funis**: desfecho + latência de permissão em `finish()` (`permissions.ts`); métricas do SDK antes descartadas (custo/tokens/turnos/negações) no `runner.ts`; motivo de cancelamento + terminais no `machine.ts`.
- **Feedback 1-clique** (😃😐😖 + texto) no card de concluída e no board; **diálogo de cancelar com motivo** (substituiu `window.confirm`).
- **Juiz** com rubrica fechada → relatório markdown (`## Resumo executivo / Atritos ranqueados / Comparação / Recomendações`) + bloco JSON de aprendizados mesclado com dedupe.
- **Backfill no boot**: tarefas históricas viram dados na 1ª subida.
- **Tela `#/experiencia`**: métricas norte, top aprendizados, relatórios navegáveis, botão "Gerar análise agora".

Arquivos: `server/eval/*`, `shared/types.ts`, `server/claude/{runner,permissions}.ts`, `server/workflow/machine.ts`, `server/api/routes.ts`, `public/app.js`, `public/styles.css`, `templates/app-starter/inhouse.config.json`, `test/eval-*.test.ts`.

## Resultado

- Backfill das 6 tarefas reais deu a linha de base: **2/6 publicadas sem resgate, 4 canceladas, 1 feedback negativo**.
- O juiz gerou um relatório real que rankeou os atritos — o nº 1 (sev 5/5) foi **"servidor fora do ar na hora de testar"**, que virou insumo direto do plano de handoff (`../release/primeira-versao-product-designer.md`).
- Suíte de testes: 108 verdes ao fim.

## Porta aberta (v2)
Golden tasks de regressão: cada tarefa concluída com 😃 já tem entrada (description/spec), saída (plano/gates) e veredito humano registrados — v2 = botão "promover a golden" + runner que re-executa espec+plano num worktree descartável e compara pelo mesmo juiz.
