#!/bin/bash
# Abre o InHouse (dê dois cliques neste arquivo).
# Na primeira vez, prepara o Node e as dependências sozinho; o resto aparece
# na tela de preparo do InHouse. Para fechar, feche esta janela do Terminal.

cd "$(dirname "$0")" || exit 1
PORT="${INHOUSE_PORT:-4400}"
FERRAMENTAS="${INHOUSE_TOOLS_DIR:-$HOME/.inhouse/ferramentas}"

node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1; }

# Node do computador primeiro; o portátil do InHouse só quando não houver outro.
if ! node_ok && [ -x "$FERRAMENTAS/node/bin/node" ]; then export PATH="$FERRAMENTAS/node/bin:$PATH"; fi
if ! node_ok || [ ! -f node_modules/.inhouse-deps ]; then
  if ! /bin/bash scripts/mac/setup.sh --basico --nao-abrir --sem-pausa; then
    echo ""
    read -r -n1 -p "Não deu para preparar o InHouse. Aperte qualquer tecla para fechar." _
    exit 1
  fi
  node_ok || export PATH="$FERRAMENTAS/node/bin:$PATH"
fi

# Abre o navegador assim que o servidor responder (em segundo plano).
(
  for _ in $(seq 1 90); do
    if curl -s "http://127.0.0.1:$PORT/api/setup" >/dev/null 2>&1; then
      open "http://127.0.0.1:$PORT"
      break
    fi
    sleep 1
  done
) &

echo ""
echo "O InHouse está aberto no seu navegador."
echo "(Feche esta janela do Terminal para encerrar o InHouse.)"
echo ""
exec npm start
