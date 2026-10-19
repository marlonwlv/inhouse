#!/bin/bash
# Prepara o computador para o InHouse (dê dois cliques neste arquivo).
# Instala o que falta (Node 24, Git, Claude Code e, se der, o GitHub CLI),
# confere tudo e abre o InHouse. Rodar de novo é seguro.
# O trabalho de verdade fica em scripts/mac/setup.sh.
exec /bin/bash "$(cd "$(dirname "$0")" && pwd)/scripts/mac/setup.sh" "$@"
