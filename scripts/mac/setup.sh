#!/bin/bash
# Preparação do InHouse no Mac. Chamado pelo setup.command e pelo inhouse.command
# (dois cliques): ninguém precisa digitar nada no Terminal.
#
#   1. Node 24: usa o do computador; se não houver, baixa o Node portátil oficial
#      (nodejs.org), confere o SHA-256 e guarda em ~/.inhouse/ferramentas/node.
#   2. Dependências do InHouse (npm install), só quando o package-lock mudou.
#   3. Git, Claude Code e GitHub CLI: server/setup/cli.ts instalar.
#   4. Abre o InHouse; o login do Claude e o nome no Git ficam na tela de preparo.
#
# Opções: --verificar  só confere (sai 0 se pronto, 1 se falta algo)
#         --simular    mostra o que faria, sem instalar nada
#         --basico     só Node e dependências (usado pelo inhouse.command)
#         --nao-abrir  não abre o InHouse no fim
#         --sem-pausa  não espera uma tecla no fim
# Rodar de novo é seguro: o que já está pronto é pulado.

set -u
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)" || exit 1
cd "$RAIZ" || exit 1

VERIFICAR=0; SIMULAR=0; BASICO=0; NAO_ABRIR=0; SEM_PAUSA=0
for a in "$@"; do
  case "$a" in
    --verificar) VERIFICAR=1 ;;
    --simular) SIMULAR=1 ;;
    --basico) BASICO=1 ;;
    --nao-abrir) NAO_ABRIR=1 ;;
    --sem-pausa) SEM_PAUSA=1 ;;
    *) echo "Opção desconhecida: $a"; exit 2 ;;
  esac
done

FERRAMENTAS="${INHOUSE_TOOLS_DIR:-$HOME/.inhouse/ferramentas}"
URL_NODE="${INHOUSE_URL_NODE:-https://nodejs.org/dist/latest-v24.x/}"

ok()    { echo "  [ok]    $*"; }
info()  { echo "          $*"; }
falha() { echo "  [erro]  $*"; }

pausa() {
  if [ "$SEM_PAUSA" = 0 ] && [ -t 0 ]; then
    echo ""
    read -r -n1 -p "Aperte qualquer tecla para fechar esta janela." _ || true
    echo ""
  fi
}
terminar() { pausa; exit "$1"; }

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' >/dev/null 2>&1
}
forcado() { case ",${INHOUSE_FORCAR_PORTATIL:-}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

plataforma() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) echo "" ;;
  esac
}
arquitetura() {
  case "$(uname -m)" in
    arm64|aarch64) echo arm64 ;;
    x86_64|amd64) echo x64 ;;
    *) echo "" ;;
  esac
}

# Baixa o Node 24 portátil para $FERRAMENTAS/node, conferindo o SHA-256.
instalar_node() {
  local plat arch soma linha arquivo esperado tmp topo
  plat="$(plataforma)"; arch="$(arquitetura)"
  if [ -z "$plat" ] || [ -z "$arch" ]; then falha "Este computador não é suportado pelo Node 24."; return 1; fi
  echo "  [...]   Procurando a versão mais nova do Node 24…"
  soma="$(curl -fsSL --retry 3 "${URL_NODE}SHASUMS256.txt")" || { falha "Sem internet para baixar o Node. Confira a conexão e tente de novo."; return 1; }
  linha="$(printf '%s\n' "$soma" | grep -E "  node-v24\.[0-9]+\.[0-9]+-${plat}-${arch}\.tar\.gz$" | head -1)"
  if [ -z "$linha" ]; then falha "Não achei o Node 24 para este computador no site oficial."; return 1; fi
  esperado="${linha%% *}"; arquivo="${linha##* }"
  if [ "$SIMULAR" = 1 ]; then info "Baixaria ${URL_NODE}${arquivo} (SHA-256 ${esperado:0:12}…) para $FERRAMENTAS/node"; return 0; fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/inhouse-node.XXXXXX")" || return 1
  echo "  [...]   Baixando $arquivo…"
  if ! curl -fL --retry 3 --progress-bar -o "$tmp/$arquivo" "${URL_NODE}${arquivo}"; then
    falha "O download do Node falhou. Confira a internet e tente de novo."; rm -rf "$tmp"; return 1
  fi
  if [ "$(sha256 "$tmp/$arquivo")" != "$esperado" ]; then
    falha "O arquivo do Node veio diferente do publicado (checksum). Nada foi instalado."; rm -rf "$tmp"; return 1
  fi
  mkdir -p "$tmp/x" && tar -xzf "$tmp/$arquivo" -C "$tmp/x" || { falha "Não deu para extrair o Node."; rm -rf "$tmp"; return 1; }
  topo="$(find "$tmp/x" -mindepth 1 -maxdepth 1 -type d | head -1)"
  [ -x "$topo/bin/node" ] || { falha "O pacote do Node veio incompleto."; rm -rf "$tmp"; return 1; }
  mkdir -p "$FERRAMENTAS"
  # Troca atômica: a versão antiga só sai depois que a nova está no lugar.
  rm -rf "$FERRAMENTAS/node.old"
  [ -d "$FERRAMENTAS/node" ] && mv "$FERRAMENTAS/node" "$FERRAMENTAS/node.old"
  if ! mv "$topo" "$FERRAMENTAS/node"; then
    [ -d "$FERRAMENTAS/node.old" ] && mv "$FERRAMENTAS/node.old" "$FERRAMENTAS/node"
    falha "Não deu para guardar o Node em $FERRAMENTAS."; rm -rf "$tmp"; return 1
  fi
  rm -rf "$FERRAMENTAS/node.old" "$tmp"
  ok "Node $("$FERRAMENTAS/node/bin/node" -v) instalado em $FERRAMENTAS/node"
}

echo ""
echo "============================================"
echo "   InHouse — preparando o seu computador"
echo "============================================"
echo ""

# --- 1. Node 24 ---------------------------------------------------------------
if forcado node || ! node_ok; then
  if [ -x "$FERRAMENTAS/node/bin/node" ]; then export PATH="$FERRAMENTAS/node/bin:$PATH"; fi
fi
if forcado node && [ ! -x "$FERRAMENTAS/node/bin/node" ] || ! node_ok; then
  if [ "$VERIFICAR" = 1 ]; then falha "Falta o Node 24."; terminar 1; fi
  instalar_node || terminar 1
  [ "$SIMULAR" = 1 ] && [ ! -x "$FERRAMENTAS/node/bin/node" ] && ! node_ok && { info "(simulação: o resto precisa do Node)"; terminar 0; }
  export PATH="$FERRAMENTAS/node/bin:$PATH"
fi
node_ok || { falha "O Node 24 não ficou disponível."; terminar 1; }
ok "Node $(node -v)"

# --- 2. Dependências do InHouse ---------------------------------------------
MARCA="node_modules/.inhouse-deps"
HASH="$(sha256 package-lock.json)-$(node -p 'process.versions.node.split(".")[0]')"
if [ -f "$MARCA" ] && [ "$(cat "$MARCA")" = "$HASH" ]; then
  ok "Dependências do InHouse"
elif [ "$VERIFICAR" = 1 ]; then
  falha "Faltam as dependências do InHouse."; terminar 1
elif [ "$SIMULAR" = 1 ]; then
  info "Rodaria: npm install (dependências do InHouse)"
else
  echo "  [...]   Instalando as dependências do InHouse (uns 2 minutos)…"
  if npm install --include=dev --no-audit --no-fund --loglevel=error; then
    printf '%s' "$HASH" > "$MARCA"
    ok "Dependências do InHouse"
  else
    falha "A instalação das dependências falhou. Confira a internet e tente de novo."; terminar 1
  fi
fi

TSX="$RAIZ/node_modules/.bin/tsx"

# --- 3. Git, Claude Code e GitHub CLI ---------------------------------------
if [ "$VERIFICAR" = 1 ]; then
  node "$TSX" server/setup/cli.ts verificar
  terminar $?
fi
if [ "$BASICO" = 0 ]; then
  if [ ! -x "$TSX" ]; then
    info "(simulação: o instalador precisa das dependências)"
  elif [ "$SIMULAR" = 1 ]; then
    node "$TSX" server/setup/cli.ts instalar --simular
  else
    echo ""
    node "$TSX" server/setup/cli.ts instalar ||
      info "Algo ficou faltando. O InHouse vai abrir e mostrar o que falta, com um botão para tentar de novo."
  fi
fi

# --- 4. Abre o InHouse -----------------------------------------------------
if [ "$NAO_ABRIR" = 0 ] && [ "$SIMULAR" = 0 ]; then
  echo ""
  ok "Abrindo o InHouse…"
  exec "$RAIZ/inhouse.command"
fi
terminar 0
