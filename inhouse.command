#!/bin/bash
# Abre o Inhouse (dê um duplo-clique neste arquivo).
# Sobe o servidor local e abre o navegador em http://127.0.0.1:4400.
# Para fechar, feche esta janela do Terminal.

cd "$(dirname "$0")" || exit 1

PORT="${INHOUSE_PORT:-4400}"

# Descobre como rodar o Node 24 (mesma lógica do setup.command).
NPM=""
node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; }

if node_ok; then
  NPM="npm"
elif command -v mise >/dev/null 2>&1; then
  NPM="mise exec node@24 -- npm"
elif [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 24 >/dev/null 2>&1 || true
  NPM="npm"
else
  echo "Não encontrei o Node 24. Rode primeiro o  setup.command  (duplo-clique)."
  read -r -n1 -p "Aperte qualquer tecla para fechar."
  exit 1
fi

# Abre o navegador assim que o servidor responder (em segundo plano).
(
  for _ in $(seq 1 60); do
    if curl -s "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      open "http://127.0.0.1:$PORT"
      break
    fi
    sleep 1
  done
) &

echo "Abrindo o Inhouse em http://127.0.0.1:$PORT …"
echo "(Feche esta janela do Terminal para encerrar.)"
echo ""
exec $NPM start
