#!/usr/bin/env bash
# Play Poker Night locally in sandbox (test) mode: ./start-sandbox.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing dependencies, this takes a minute the first time..."
  npm install || exit 1
fi
exec npm run sandbox
