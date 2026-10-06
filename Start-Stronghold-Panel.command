#!/bin/bash
# Stronghold Host Panel — double-click to open the web control panel (macOS).
# Linux: run ./Start-Stronghold-Panel.command in a terminal. Windows: use Start-Stronghold-Panel.bat.
# Keep this Terminal window open while hosting; close it (or Ctrl+C) to stop
# the panel and everything it manages.
cd "$(dirname "$0")"
for p in /opt/homebrew/opt/node@22/bin /opt/homebrew/opt/node@24/bin /usr/local/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac
done
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node.js 22 or later (macOS: brew install node@22, Linux: nvm install 22)."
  read -n 1 -s -r -p "press any key to close"
  exit 1
fi
exec node server.mjs
