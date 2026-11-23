# Publicar trava com "alterações não salvas na pasta principal"

- **Categoria:** bugs
- **Data:** 2026-11-23
- **Status:** Concluído

## Sintoma
Ao publicar uma tarefa (app sem GitHub), aparecia "ESTE PASSO FALHOU — Há alterações não salvas na pasta
principal do projeto. Guarde ou descarte essas alterações antes de publicar." Tentar de novo e até criar outro
chat caíam no mesmo erro; a pessoa (não técnica) não tinha como sair.

## Causa raiz (confirmada)
A preparação do projeto (`startPreparacao`, `worktreePath: project.path`) roda de propósito na pasta principal:
`npm install` cria `package-lock.json` (o template não traz lockfile) e a preparação copia `.env.example` para
`.env`/`.env.local`. Nada disso era commitado nem ignorado, então `git status --porcelain` na pasta principal
ficava sujo para sempre e o Caminho B do publish (`server/services/publish.ts`) recusava toda publicação.
Reproduzido com o template `app-starter`: depois da preparação, `?? .env.local` e `?? package-lock.json`.

Achado junto: sem `user.name`/`user.email` no git (comum no Mac de quem não é dev), o `merge --no-ff` do
Caminho B também falhava. Agora usa a identidade padrão do builder, como o `gitCommit`.

Caminho A (com origin) e `revisao.ts` não têm a armadilha: o publish por PR empurra do espaço e não olha a pasta
principal; a sondagem só lê via `gh`.

## Correção
- `server/services/pastaPrincipal.ts`: bloco do Inhouse em `.git/info/exclude` (`.env`, `.env.*` exceto
  exemplos, `node_modules/`, venvs, logs) — local, nunca commitado; `guardarPendencias` guarda o resto num commit
  identificável (ou stash nomeado se o HEAD estiver solto). Nada é descartado.
- Fim da preparação (app sem origin): commit "Preparação do InHouse". Com origin: só o exclude (o main local não
  ganha commits que o GitHub não tem).
- Publish (Caminho B): antes do merge, guarda as pendências com o commit "Alterações pendentes da pasta principal
  (guardadas pelo Inhouse)" e avisa no chat quais arquivos. Projetos já travados destravam ao clicar Publicar de novo.
- Mensagens de erro restantes em português simples ("Nada foi apagado. Fale com o time técnico.").

## Testes
`test/pastaPrincipal.test.ts` (git de verdade): preparação com .env + lockfile → publicação passa e nenhum
commit carrega .env; pasta suja à mão → nada se perde e a segunda publicação passa (sem loop); HEAD solto → stash.
`test/machine.test.ts`: a preparação termina guardando as pendências. `test/publish.test.ts` atualizado.
