#!/bin/bash
# Build the release ZIPs: one per system, with only the files that system needs.
# Usage: .github/build-release.sh v1.2.3   (run from the repo root; output goes to dist/)
set -euo pipefail
V="${1:?usage: build-release.sh <tag>}"
# macOS bash 3.2 can read a non-ASCII byte as part of a variable name: "$VAR中" must be "${VAR}中"
if grep -nP '\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]' install.sh Start-Stronghold-Panel.command; then
  echo "use \${VAR} before non-ASCII text in the lines above" >&2; exit 1
fi
rm -rf dist && mkdir -p dist
for os in macos windows linux; do
  D="dist/$os/Stronghold-Host-Panel"
  mkdir -p "$D"
  cp -r server.mjs lib web README.md INSTALL.md config.example.json "$D/"
  case "$os" in
    macos)   cp Start-Stronghold-Panel.command "$D/"
             cp install.sh "$D/Install-Stronghold-Panel.command" ;;
    linux)   cp Start-Stronghold-Panel.command "$D/Start-Stronghold-Panel.sh"
             cp install.sh "$D/" ;;
    windows) cp Start-Stronghold-Panel.bat Install-Stronghold-Panel.bat install.ps1 "$D/"
             python3 - "$D/config.example.json" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding="utf-8"))
d["frpcBin"] = "~/SakuraFrp/frpc.exe"
open(p, "w", encoding="utf-8").write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
PY
             ;;
  esac
  find "$D" -type d -exec chmod 755 {} +
  find "$D" -type f -exec chmod 644 {} +
  chmod 755 "$D"/Start-Stronghold-Panel.command "$D"/Start-Stronghold-Panel.sh "$D"/Install-Stronghold-Panel.command "$D"/install.sh 2>/dev/null || true
  (cd "dist/$os" && TZ=UTC zip -qrX "../Stronghold-Host-Panel-$V-$os.zip" Stronghold-Host-Panel)
  rm -rf "dist/$os"
done
ls -l dist
