# Preview confiável: o agente prepara e VALIDA, o usuário testa no gate

- **Categoria:** features
- **Data:** 2026-08-06
- **Status:** Concluído (Fase 1) — Fase 2 pendente

## Contexto

Caso real (print do usuário): uma task num monorepo pnpm + Next. O preview mecânico rodou `pnpm dev`, o server imprimiu `:4501`, o Inhouse marcou "pronto" — mas ao **mudar de rota** o app estourou uma variável de ambiente faltando por rota (`... _URL not set`). Dois problemas de fundo:

1. **"Pronto" hoje = uma URL apareceu no stdout** (`preview.ts`), sem nenhuma checagem de que o app realmente serve. Pior: um health-check só na raiz **passaria** neste caso — o erro é específico da rota autenticada.
2. **A camada 2.5 (agente) é só leitura** (`plan` mode + `disallowedTools:["Bash"]`): descobre um `cmd` e lista `.env` pra copiar, mas **não configura o ambiente** (env, docker, migrations).

**Decisão (reframe):** o **agente** é o único responsável por subir e **exercitar** o preview, *depois* das etapas de validação — assim ele mesmo encontra e corrige os erros por rota. O usuário **só vê o preview no último gate humano ("Seu teste")**, já funcionando. Comandos de setup seguros são **auto-aprovados** (menos fricção pra leigo).

## Abordagem (Fase 1)

1. **`runPreviewCheck` no fim de Verificações (tasks com UI):** depois dos gates passarem, o agente prepara o ambiente do espaço (env, docker, migrations — `acceptEdits` + Bash seguro auto-aprovado, servidor de dev auto-negado), o Inhouse sobe o preview gerenciado (fonte única da verdade) e o agente **exercita as rotas** que importam via `curl`, encontra e corrige os erros de runtime, e só então a task avança pra "Seu teste" com `previewUrl` verificado. Se não ficar saudável, a verificação falha com a explicação do agente em pt-BR.
2. **A receita cresce:** `PreviewConfig` ganha `setup?: string[]` (comandos curtos/idempotentes rodados antes do `cmd`) e `healthPaths?: string[]` (rotas a conferir). `sanitizePreview` sanitiza os dois.
3. **Backstop determinístico:** `verificarSaude(url, cfg)` faz `fetch` (Node → 127.0.0.1) em cada `healthPaths` com retry/backoff; `>=500` ou conexão recusada = quebrado → `PreviewQuebradoError`. Protege o start mecânico direto.
4. **Setup capaz + regra de ouro:** gate de permissão (`createPreviewSetupGate`) que auto-aprova setup seguro, **auto-nega** servidor de dev (guarda concreta da regra de ouro) e delega o resto ao gate normal. Prompts do agente em `phases.ts` (`previewSetupPrompt`, `previewExercisePrompt`).
5. **Preview surge no "Seu teste":** durante espec/plano/detalhamento/execução/verificações a UI diz "o preview fica pronto no Seu teste"; o iframe só aparece nos passos `teste`/`publicar`, já verificado.

## Arquivos (Fase 1)
- `shared/types.ts` — `PreviewConfig` += `setup?`, `healthPaths?`.
- `server/workflow/config.ts` — `sanitizePreview` sanitiza os dois campos.
- `server/services/preview.ts` — `PreviewQuebradoError`, `verificarSaude`, `attemptStart(opts)` (health opcional), roda `setup` antes do `cmd`, `aprenderReceita`/`resolvePreviewConfig`, `configurarPreviewComAgente` vira setup-capaz.
- `server/claude/permissions.ts` — `createPreviewSetupGate` (auto-aprova seguro, auto-nega dev server).
- `server/workflow/phases.ts` — `previewSetupPrompt`, `previewExercisePrompt` (reusam `PREVIEW_GERENCIADO`).
- `server/workflow/machine.ts` — `runPreviewCheck` no fim de `runVerificacoes` (só se `temUi`).
- `server/api/routes.ts` — trata `PreviewQuebradoError` (502 + detail).
- `public/app.js` (+ `styles.css`) — preview só nos passos `teste`/`publicar`; antes disso, "fica pronto no Seu teste".
- Testes: `test/preview.test.ts` — fixture passa a ESCUTAR de fato; testes de 500→`PreviewQuebradoError`, 302 = saudável, `setup` antes do `cmd`, sanitize de `setup`/`healthPaths`.

## Fase 2 (depois)
`preparacaoPrompt` também emite+grava receita; back-propagar env do espaço pro checkout principal; QA visual headless anexando screenshot no gate; opt-in `preview.strategy:"agent-first"` por projeto.
