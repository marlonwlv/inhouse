# Regras deste app

Este app foi criado pelo Inhouse e é mantido por pessoas não-técnicas.
Siga estas regras em todas as tarefas:

1. **Responda sempre em português** (Brasil), de forma simples e sem jargão técnico.
2. **Explique as mudanças** que você fez como se fosse para alguém que não programa:
   o que mudou na prática, não os detalhes de código.
3. **Não instale dependências novas sem necessidade real.** Antes de adicionar uma
   biblioteca, verifique se dá para resolver com o que já existe no projeto.
4. **Não rode comandos destrutivos** (apagar arquivos em massa, resetar histórico,
   forçar push, mexer fora da pasta do projeto).
5. **Mantenha o design system**: use as cores e espaçamentos definidos como variáveis
   CSS em `src/styles.css` (verde `--verde`, espaçamentos `--espaco-*`).
   Não invente cores novas sem pedido explícito.
6. **Todo texto visível na interface deve estar em pt-BR** — botões, títulos,
   mensagens de erro, placeholders, tudo.
7. **Não rode verificações você mesmo** (`npm run typecheck`, lint, build, testes):
   o Inhouse roda tudo automaticamente ao final da tarefa e te devolve os erros
   se houver. Rodar por conta própria só gasta tempo e pede permissão à toa.
