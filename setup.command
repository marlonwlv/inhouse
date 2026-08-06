#!/bin/bash
# Preparação da máquina para o Inhouse (dê um duplo-clique neste arquivo).
# Verifica Node 24+, git, gh e o Claude Code, e instala as dependências.
# Não falha "feio": quando algo falta, explica o que fazer em português.

cd "$(dirname "$0")" || exit 1

echo ""
echo "============================================"
echo "   Inhouse — preparando a sua máquina"
echo "============================================"
echo ""

# --- Descobre como rodar o Node 24 (PATH direto, mise ou nvm) ---
NPM=""
node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }

if node_ok; then
  NPM="npm"
  echo "✓ Node $(node -v) encontrado."
elif command -v mise >/dev/null 2>&1; then
  echo "• Node 24 será usado via mise (instalando se necessário)…"
  mise install node@24 >/dev/null 2>&1 || true
  NPM="mise exec node@24 -- npm"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  echo "• Node 24 será usado via nvm (instalando se necessário)…"
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm install 24 >/dev/null 2>&1 || true
  nvm use 24 >/dev/null 2>&1 || true
  NPM="npm"
else
  echo "✗ Não encontrei o Node 24 nesta máquina."
  echo "  Instale de um destes jeitos e rode este arquivo de novo:"
  echo "    • https://nodejs.org  (baixe a versão 'LTS' ou 24)"
  echo "    • ou o mise:  https://mise.jdx.dev"
  echo ""
  read -r -n1 -p "Aperte qualquer tecla para fechar."
  exit 1
fi

# --- Ferramentas necessárias / opcionais ---
if command -v claude >/dev/null 2>&1; then
  echo "✓ Claude Code encontrado."
else
  echo "⚠ Claude Code NÃO encontrado — ele é essencial."
  echo "  Instale com:  npm install -g @anthropic-ai/claude-code"
  echo "  e depois rode 'claude' no Terminal para fazer o login."
fi

command -v git >/dev/null 2>&1 && echo "✓ git encontrado." || echo "⚠ git NÃO encontrado — instale o Xcode Command Line Tools:  xcode-select --install"
command -v gh  >/dev/null 2>&1 && echo "✓ gh (GitHub) encontrado." || echo "• gh (GitHub CLI) opcional — só é preciso para abrir Pull Requests automaticamente."

# --- Dependências do Inhouse ---
echo ""
echo "• Instalando as dependências do Inhouse (pode levar alguns minutos)…"
if $NPM install; then
  echo ""
  echo "✓ Tudo pronto!"
  echo "  Agora dê um duplo-clique em  inhouse.command  para abrir o Inhouse."
else
  echo ""
  echo "✗ A instalação das dependências falhou. Verifique a internet e tente de novo."
fi

echo ""
read -r -n1 -p "Aperte qualquer tecla para fechar."
echo ""
