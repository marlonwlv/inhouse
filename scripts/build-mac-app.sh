#!/usr/bin/env bash
# Build do Inhouse para macOS: app de MENU BAR com servidor + runtime Node
# embutidos, distribuído num DMG (arraste para Aplicativos).
#
# Uso:
#   scripts/build-mac-app.sh            # arch padrão: arm64 (Apple Silicon)
#   scripts/build-mac-app.sh x64        # para Macs Intel
#
# Saída: dist/Inhouse-<versão>-<arch>.dmg
#
# O runtime Node é baixado do nodejs.org (uma vez; fica em dist/.cache) e vai
# COMPLETO para dentro do .app — inclui npm/corepack, então a máquina do
# usuário não precisa ter Node instalado.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-arm64}"                               # arm64 | x64
NODE_VERSION="${INHOUSE_NODE_VERSION:-24.19.0}"  # >= engines.node do package.json
VERSAO="$(node -p "require('$ROOT/package.json').version")"

DIST="$ROOT/dist"
CACHE="$DIST/.cache"
STAGE="$DIST/mac"
APP="$STAGE/Inhouse.app"
SRV_OUT="$STAGE/srv"                             # saída do tsc (tsconfig.build.json)

echo "==> Inhouse $VERSAO · macOS $ARCH · Node $NODE_VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE" "$CACHE"

echo "==> 1/6 Compilando o servidor (tsc)…"
(cd "$ROOT" && npx tsc -p tsconfig.build.json)
# A estrutura de pastas é preservada (server/, shared/) — os caminhos relativos
# do código (../public, ../../templates) continuam valendo dentro do bundle.
cp -R "$ROOT/public" "$SRV_OUT/public"
cp -R "$ROOT/templates" "$SRV_OUT/templates"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$SRV_OUT/"

echo "==> 2/6 Dependências de produção…"
(cd "$SRV_OUT" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)

echo "==> 3/6 Runtime Node ($ARCH)…"
NODE_DIR="node-v$NODE_VERSION-darwin-$ARCH"
TARBALL="$CACHE/$NODE_DIR.tar.xz"
if [ ! -f "$TARBALL" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIR.tar.xz" -o "$TARBALL"
fi
tar -xJf "$TARBALL" -C "$STAGE"

echo "==> 4/6 Compilando o launcher (clang/ObjC)…"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
clang -O2 -fobjc-arc -framework AppKit -framework Foundation \
  -target "$([ "$ARCH" = arm64 ] && echo arm64 || echo x86_64)-apple-macos12.0" \
  -mmacosx-version-min=12.0 \
  -o "$APP/Contents/MacOS/Inhouse" "$ROOT/app-mac/menubar.m"

echo "==> 5/6 Montando o Inhouse.app…"
sed "s/__VERSAO__/$VERSAO/g" "$ROOT/app-mac/Info.plist" > "$APP/Contents/Info.plist"
mv "$SRV_OUT" "$APP/Contents/Resources/srv"
mv "$STAGE/$NODE_DIR" "$APP/Contents/Resources/node"
# Enxuga o runtime (docs/headers não são necessários para rodar).
rm -rf "$APP/Contents/Resources/node/share" \
       "$APP/Contents/Resources/node/include" \
       "$APP/Contents/Resources/node/lib/node_modules/npm/docs" 2>/dev/null || true
# Assinatura ad-hoc: obrigatória no Apple Silicon (binário sem assinatura é
# morto pelo sistema). Sem Developer ID, a 1ª abertura pede botão direito→Abrir.
codesign --force --deep -s - "$APP"

echo "==> 6/6 Gerando o DMG…"
DMG_SRC="$STAGE/dmg"
mkdir -p "$DMG_SRC"
cp -R "$APP" "$DMG_SRC/Inhouse.app"
cp "$ROOT/app-mac/LEIA-ME.txt" "$DMG_SRC/LEIA-ME.txt"
ln -s /Applications "$DMG_SRC/Aplicativos"
DMG="$DIST/Inhouse-$VERSAO-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -quiet -volname "Inhouse" -srcfolder "$DMG_SRC" -ov -format UDZO "$DMG"

echo
echo "✅ Pronto: $DMG"
du -sh "$DMG" | awk '{print "   tamanho: " $1}'
