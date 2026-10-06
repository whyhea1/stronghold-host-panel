#!/bin/bash
# Stronghold Host Panel installer for macOS and Linux.
# 卫戍协议 · 主机面板 安装脚本（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/whyhea1/stronghold-host-panel/main/install.sh | bash
#   ./install.sh [--dir <folder>] [--lang zh|en] [--update] [--yes]
#
#   1. Node.js 22: uses a system Node 22+ if there is one, else puts a private copy in <panel>/runtime/node
#   2. Panel:      newest release ZIP from GitHub, keeps config.json and usage.json
#                  (skipped when this script runs from a panel folder, unless --update)
#   3. Setup:      lib/setup.mjs: frpc, 访问密钥, tunnel, frpc.ini, game
#
# Run it again at any time: it updates the panel and repairs the setup.
# The braces make bash read the whole file before it runs any of it (safe with curl | bash).
{
set -u

REPO="whyhea1/stronghold-host-panel"
PORTS="7890 7897 10809 10808 6152 6153 1087 1080"
MIRRORS="https://ghfast.top/ https://gh-proxy.com/"
DIR=""; L="${SH_LANG:-}"; YES=0; UPDATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:-}"; shift 2 ;;
    --lang) L="${2:-}"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    *) shift ;;
  esac
done

# ------------------------------------------------------------------------------ language, output
if [ -z "$L" ]; then
  case "${LC_ALL:-} ${LC_MESSAGES:-} ${LANG:-}" in *zh*) L=zh ;; esac
  if [ -z "$L" ] && [ "$(uname -s)" = Darwin ] && defaults read -g AppleLanguages 2>/dev/null | grep -q '"\{0,1\}zh'; then L=zh; fi
fi
case "$L" in zh*) L=zh ;; *) L=en ;; esac

if [ -t 1 ]; then B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'; else B= D= G= Y= R= C= N=; fi
t()    { if [ "$L" = zh ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
say()  { printf '%s\n' "$*"; }
step() { say ""; say "${B}${C}[$1]${N}${B} $(t "$2" "$3")${N}"; }
ok()   { say "  ${G}✓${N} $(t "$1" "$2")"; }
warn() { say "  ${Y}!${N} $(t "$1" "$2")"; }
die()  { say "  ${R}✗${N} $(t "$1" "$2")"; exit 1; }
info() { say "  $(t "$1" "$2")"; }

# Questions read from the terminal, also when the script itself comes through a pipe (curl | bash).
HAVE_TTY=0; { : </dev/tty; } 2>/dev/null && HAVE_TTY=1
ask() {   # ask <zh> <en> <default>  -> $REPLY
  REPLY="$3"
  [ "$YES" = 1 ] || [ "$HAVE_TTY" = 0 ] && return 0
  printf '  %s ' "$(t "$1" "$2")" >/dev/tty
  local a=""; IFS= read -r a </dev/tty || a=""
  [ -n "$a" ] && REPLY="$a"
  return 0
}
yes_no() { ask "$1 [Y/n]" "$2 [Y/n]" y; case "$REPLY" in [Nn]*) return 1 ;; *) return 0 ;; esac; }

say "${B}$(t '卫戍协议 · 主机面板 · 安装' 'Stronghold Host Panel · install')${N}"

# ------------------------------------------------------------------------------ system
case "$(uname -s)" in
  Darwin) OS=macos; NOS=darwin ;;
  Linux)  OS=linux; NOS=linux ;;
  *) die "不支持的系统：$(uname -s)。Windows 请使用 install.ps1。" "Unsupported system: $(uname -s). On Windows, use install.ps1." ;;
esac
case "$(uname -m)" in
  arm64|aarch64) NARCH=arm64 ;;
  x86_64|amd64)  NARCH=x64 ;;
  armv7l)        NARCH=armv7l ;;
  *) die "不支持的 CPU 架构：$(uname -m)" "Unsupported CPU: $(uname -m)" ;;
esac
# an arm64 Mac running this shell under Rosetta still gets the native arm64 Node
[ "$OS" = macos ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ] && NARCH=arm64
command -v curl >/dev/null 2>&1 || die "需要 curl。Debian/Ubuntu：sudo apt install curl" "curl is necessary. Debian/Ubuntu: sudo apt install curl"
if [ "$OS" = linux ] && ! command -v unzip >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  die "需要 unzip 或 python3。Debian/Ubuntu：sudo apt install unzip" "unzip or python3 is necessary. Debian/Ubuntu: sudo apt install unzip"
fi
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t stronghold)"
trap 'rm -rf "$TMP"' EXIT

# Downloads never use proxy variables from the shell: GitHub goes through a local proxy port that works,
# everything else goes direct. Every route but the last must keep 100 KB/s over 15 s.
NOPROXY="env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY"
PX=""
probe_proxies() {
  local p s
  for p in $PORTS; do
    for s in http socks5h; do
      if $NOPROXY curl -s -m 4 -o /dev/null -x "$s://127.0.0.1:$p" https://api.github.com; then PX="$PX $s://127.0.0.1:$p"; break; fi
    done
  done
  PX="${PX# }"
}
dl() {    # dl <url> <out> [github]
  local url="$1" out="$2" gh="${3:-}" q="${4:-}" routes="" r i=0 n floor u
  if [ -n "$gh" ]; then for r in $PX; do routes="$routes proxy=$r"; done; fi
  routes="$routes direct"
  if [ -n "$gh" ]; then for r in $MIRRORS; do routes="$routes mirror=$r"; done; fi
  n=$(echo $routes | wc -w | tr -d ' ')
  for r in $routes; do
    i=$((i + 1)); floor="--speed-limit 102400 --speed-time 15"; [ "$i" -eq "$n" ] && floor="--speed-limit 1024 --speed-time 30"
    set --
    case "$r" in proxy=*) set -- -x "${r#proxy=}"; u="$url" ;; mirror=*) u="${r#mirror=}$url" ;; *) u="$url" ;; esac
    [ "$n" -gt 1 ] && say "    ${D}${r}${N}"
    if [ -t 1 ] && [ "$q" != quiet ]; then set -- "$@" --progress-bar; else set -- "$@" -sS; fi
    # shellcheck disable=SC2086
    if $NOPROXY curl -fL --connect-timeout 10 $floor "$@" -o "$out" "$u"; then return 0; fi
  done
  return 1
}
unzip_to() {   # unzip_to <zip> <dir>
  mkdir -p "$2"
  unzip -q -o "$1" -d "$2" 2>/dev/null && return 0
  python3 -m zipfile -e "$1" "$2" 2>/dev/null && return 0
  [ "$OS" = macos ] && ditto -x -k "$1" "$2" 2>/dev/null && return 0
  return 1
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# ------------------------------------------------------------------------------ 1. folder
step 1/4 "面板文件夹" "Panel folder"
SELF=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; fi
FROM_FOLDER=0
if [ -z "$DIR" ] && [ -n "$SELF" ] && [ -f "$SELF/server.mjs" ]; then DIR="$SELF"; FROM_FOLDER=1; fi
if [ -z "$DIR" ]; then
  ask "安装到 [$HOME/Stronghold-Host-Panel]：" "Install to [$HOME/Stronghold-Host-Panel]:" "$HOME/Stronghold-Host-Panel"
  DIR="$REPLY"
fi
case "$DIR" in "~"*) DIR="$HOME${DIR#\~}" ;; esac
mkdir -p "$DIR" || die "无法创建 $DIR" "Cannot create $DIR"
DIR="$(cd "$DIR" && pwd)"
if $NOPROXY curl -s -m 2 -o /dev/null -H "Host: localhost:3100" http://127.0.0.1:3100/api/state; then
  die "面板正在运行。先关闭面板的终端窗口，再重新运行安装脚本。" "The panel is running. Close its terminal window, then run the installer again."
fi
ok "$DIR" "$DIR"

# ------------------------------------------------------------------------------ 2. Node.js
step 2/4 "Node.js 22" "Node.js 22"
node_ok() { [ -x "$1" ] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' 2>/dev/null; }
NODE=""
for cand in "$DIR/runtime/node/bin/node" "$(command -v node 2>/dev/null)" \
            /opt/homebrew/opt/node@22/bin/node /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@22/bin/node \
            /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do
  if [ -n "$cand" ] && node_ok "$cand"; then NODE="$cand"; break; fi
done
if [ -n "$NODE" ]; then
  ok "使用 $NODE（$("$NODE" -v)）" "using $NODE ($("$NODE" -v))"
else
  info "没有找到 Node.js 22 或更高版本。下载一份私有副本到 $DIR/runtime/node（不需要管理员权限，不影响系统）。" \
       "No Node.js 22 or later found. Downloading a private copy to $DIR/runtime/node (no admin rights, the system stays unchanged)."
  if [ "$L" = zh ]; then BASES="https://npmmirror.com/mirrors/node/latest-v22.x https://nodejs.org/dist/latest-v22.x"
  else BASES="https://nodejs.org/dist/latest-v22.x https://npmmirror.com/mirrors/node/latest-v22.x"; fi
  got=0
  for base in $BASES; do
    dl "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt" "" quiet >/dev/null 2>&1 || continue
    line="$(grep -E " node-v22\.[0-9.]+-$NOS-$NARCH\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1)"
    [ -n "$line" ] || continue
    sum="${line%% *}"; file="${line##* }"
    info "${D}$base/$file${N}" "${D}$base/$file${N}"
    dl "$base/$file" "$TMP/$file" || continue
    [ "$(sha256 "$TMP/$file")" = "$sum" ] || { warn "SHA-256 校验失败，换下一个下载源" "SHA-256 check failed, trying the next source"; continue; }
    rm -rf "$DIR/runtime/node" && mkdir -p "$DIR/runtime/node" &&
      tar -xzf "$TMP/$file" -C "$DIR/runtime/node" --strip-components 1 && got=1 && break
  done
  [ "$got" = 1 ] && node_ok "$DIR/runtime/node/bin/node" || die "Node.js 下载失败。手动安装见 INSTALL.md「手动安装」第 1 步。" "The Node.js download failed. For a manual install, see step 1 of Manual install in INSTALL.md."
  NODE="$DIR/runtime/node/bin/node"
  ok "已安装 $("$NODE" -v)，SHA-256 校验通过" "installed $("$NODE" -v), SHA-256 OK"
fi

# ------------------------------------------------------------------------------ 3. panel files
step 3/4 "面板文件" "Panel files"
info "${D}查找可用的 GitHub 代理端口…${N}" "${D}looking for a local proxy port that reaches GitHub...${N}"
probe_proxies
if [ -n "$PX" ]; then info "${D}GitHub → $PX${N}" "${D}GitHub → $PX${N}"; else info "${D}未发现本机代理端口，GitHub 直连${N}" "${D}no local proxy port found, GitHub direct${N}"; fi
if [ "$FROM_FOLDER" = 1 ] && [ "$UPDATE" = 0 ]; then
  ok "使用当前文件夹中的面板（要更新面板，加 --update）" "using the panel in this folder (add --update to update it)"
else
  TAG=""
  if dl "https://api.github.com/repos/$REPO/releases/latest" "$TMP/rel.json" gh quiet >/dev/null 2>&1; then
    TAG="$("$NODE" -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tag_name||"")}catch{}' "$TMP/rel.json")"
  fi
  if [ -z "$TAG" ]; then   # the API is rate-limited per IP; the release page redirect is not
    for m in "" $MIRRORS; do
      loc="$($NOPROXY curl -sI -m 15 ${PX:+-x ${PX%% *}} "${m}https://github.com/$REPO/releases/latest" | tr -d '\r' | grep -i '^location:' | tail -1)"
      TAG="${loc##*/tag/}"; [ "$TAG" != "$loc" ] && [ -n "$TAG" ] && break; TAG=""
    done
  fi
  [ -n "$TAG" ] || die "无法从 GitHub 获取最新版本。打开代理软件后重试。" "Cannot get the newest version from GitHub. Turn on your proxy app, then try again."
  ZIP="Stronghold-Host-Panel-$TAG-$OS.zip"
  info "$ZIP" "$ZIP"
  dl "https://github.com/$REPO/releases/download/$TAG/$ZIP" "$TMP/panel.zip" gh || die "面板下载失败。" "The panel download failed."
  unzip_to "$TMP/panel.zip" "$TMP/x" || die "无法解压 $ZIP" "Cannot unzip $ZIP"
  [ -f "$TMP/x/Stronghold-Host-Panel/server.mjs" ] || die "ZIP 内容不正确" "The ZIP has unexpected content"
  # copy over the old files: config.json, usage.json and runtime/ are not in the ZIP, so they stay
  cp -R "$TMP/x/Stronghold-Host-Panel/." "$DIR/" || die "无法写入 $DIR" "Cannot write to $DIR"
  ok "面板 $TAG → $DIR" "panel $TAG → $DIR"
fi
for f in "$DIR"/Start-Stronghold-Panel.command "$DIR"/Start-Stronghold-Panel.sh "$DIR"/install.sh "$DIR"/Install-Stronghold-Panel.command; do
  [ -f "$f" ] && chmod +x "$f"
done
[ "$OS" = macos ] && xattr -dr com.apple.quarantine "$DIR" 2>/dev/null

# ------------------------------------------------------------------------------ 4. setup
step 4/4 "SakuraFrp 与游戏" "SakuraFrp and the game"
set -- --lang "$L"; [ "$YES" = 1 ] && set -- "$@" --yes
if [ "$HAVE_TTY" = 1 ]; then "$NODE" "$DIR/lib/setup.mjs" "$@" </dev/tty; else "$NODE" "$DIR/lib/setup.mjs" "$@" </dev/null; fi
SETUP=$?

START="$DIR/Start-Stronghold-Panel.command"; [ -f "$DIR/Start-Stronghold-Panel.sh" ] && START="$DIR/Start-Stronghold-Panel.sh"
say ""
info "以后开服：运行 ${B}$START${N}，然后点「开始联机」。" "To host: run ${B}$START${N}, then click 开始联机."
[ "$SETUP" = 0 ] || exit "$SETUP"
if yes_no "现在启动面板？" "Start the panel now?"; then
  if [ "$OS" = macos ]; then open "$START"; else exec "$START"; fi
fi
exit 0
}
