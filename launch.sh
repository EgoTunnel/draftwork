#!/bin/sh
# Starts Draftwork and opens it in the default browser (macOS / Linux).
#   sh launch.sh [--mock-tsa] [--demo] [--port 8080] [--page instructor|student]
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Draftwork needs Node.js 20 or newer: https://nodejs.org"
  exit 1
fi
exec node launch.js "$@"
