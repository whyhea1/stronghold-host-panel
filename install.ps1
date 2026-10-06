# Stronghold Host Panel installer for Windows (PowerShell 5.1 or later).
# 卫戍协议 · 主机面板 安装脚本（Windows）
#
#   irm https://raw.githubusercontent.com/whyhea1/stronghold-host-panel/main/install.ps1 | iex
#   or double-click Install-Stronghold-Panel.bat in the release ZIP
#
# Options are environment variables, so they also work with irm | iex:
#   $env:SH_DIR    panel folder (default %USERPROFILE%\Stronghold-Host-Panel)
#   $env:SH_LANG   zh | en
#   $env:SH_UPDATE = 1   update the panel files also when this runs from a panel folder
#   $env:SH_YES    = 1   accept every default
#
#   1. Node.js 22: uses a system Node 22+ if there is one, else puts a private copy in <panel>\runtime\node
#   2. Panel:      newest release ZIP from GitHub, keeps config.json and usage.json
#   3. Setup:      lib\setup.mjs: frpc, 访问密钥, tunnel, frpc.ini, game
#
# Run it again at any time: it updates the panel and repairs the setup.

& {
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$OutputEncoding = [Text.Encoding]::UTF8

$Repo    = 'whyhea1/stronghold-host-panel'
$Ports   = 7890, 7897, 10809, 10808, 6152, 6153, 1087, 1080
$Mirrors = 'https://ghfast.top/', 'https://gh-proxy.com/'
$Yes     = $env:SH_YES -eq '1'

# ------------------------------------------------------------------------------ language, output
$L = "$env:SH_LANG"
if (-not $L) { if ((Get-UICulture).Name -like 'zh*' -or (Get-Culture).Name -like 'zh*') { $L = 'zh' } else { $L = 'en' } }
if ($L -like 'zh*') { $L = 'zh' } else { $L = 'en' }
function T($zh, $en) { if ($L -eq 'zh') { $zh } else { $en } }
function Step($n, $zh, $en) { Write-Host ''; Write-Host "[$n] $(T $zh $en)" -ForegroundColor Cyan }
function Ok($zh, $en)   { Write-Host "  + $(T $zh $en)" -ForegroundColor Green }
function Warn($zh, $en) { Write-Host "  ! $(T $zh $en)" -ForegroundColor Yellow }
function Info($zh, $en) { Write-Host "  $(T $zh $en)" }
function Dim($s)        { Write-Host "    $s" -ForegroundColor DarkGray }
function Fail($zh, $en) { throw (T $zh $en) }
function Ask($zh, $en, $def) {
  if ($Yes) { return $def }
  $a = Read-Host "  $(T $zh $en)"
  if ($a) { $a.Trim() } else { $def }
}
function YesNo($zh, $en) { (Ask "$zh [Y/n]" "$en [Y/n]" 'y') -notmatch '^[Nn]' }

try {
Write-Host (T '卫戍协议 · 主机面板 · 安装' 'Stronghold Host Panel · install') -ForegroundColor White

# ------------------------------------------------------------------------------ system
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$NArch = switch ($arch) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
if (-not $NArch) { Fail "不支持的 CPU 架构：$arch" "Unsupported CPU: $arch" }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Fail '需要 curl.exe（Windows 10 1803 及以上自带）。' 'curl.exe is necessary (Windows 10 1803 and later include it).'
}
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("stronghold-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $Tmp | Out-Null

# Downloads never use proxy variables: GitHub goes through a local proxy port that works,
# everything else goes direct. Every route but the last must keep 100 KB/s over 15 s.
foreach ($v in 'http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY') { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
$script:PX = @()
function Probe-Proxies {
  foreach ($p in $Ports) {
    foreach ($s in 'http', 'socks5h') {
      & curl.exe -s -m 4 -o NUL -x "${s}://127.0.0.1:$p" https://api.github.com 2>$null
      if ($LASTEXITCODE -eq 0) { $script:PX += "${s}://127.0.0.1:$p"; break }
    }
  }
}
function Dl($url, $out, [switch]$GitHub, [switch]$Quiet) {
  $routes = @()
  if ($GitHub) { foreach ($p in $script:PX) { $routes += ,@('proxy', $p) } }
  $routes += ,@('direct', '')
  if ($GitHub) { foreach ($m in $Mirrors) { $routes += ,@('mirror', $m) } }
  for ($i = 0; $i -lt $routes.Count; $i++) {
    $kind = $routes[$i][0]; $val = $routes[$i][1]
    $a = @('-fL', '--connect-timeout', '10')
    if ($i -eq $routes.Count - 1) { $a += '--speed-limit', '1024', '--speed-time', '30' } else { $a += '--speed-limit', '102400', '--speed-time', '15' }
    $u = $url
    if ($kind -eq 'proxy') { $a += '-x', $val } elseif ($kind -eq 'mirror') { $u = $val + $url }
    if ($Quiet) { $a += '-sS' } else { $a += '--progress-bar'; if ($routes.Count -gt 1) { Dim "$kind $val" } }
    & curl.exe @a -o $out $u
    if ($LASTEXITCODE -eq 0) { return $true }
  }
  return $false
}
function Node-Ok($p) {
  if (-not $p -or -not (Test-Path $p)) { return $false }
  & $p -e "process.exit(+process.versions.node.split('.')[0] >= 22 ? 0 : 1)" 2>$null
  return $LASTEXITCODE -eq 0
}

# ------------------------------------------------------------------------------ 1. folder
Step '1/4' '面板文件夹' 'Panel folder'
$FromFolder = $false
$Dir = "$env:SH_DIR"
if (-not $Dir -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'server.mjs'))) { $Dir = $PSScriptRoot; $FromFolder = $true }
if (-not $Dir) {
  $def = Join-Path $env:USERPROFILE 'Stronghold-Host-Panel'
  $Dir = Ask "安装到 [$def]" "Install to [$def]" $def
}
New-Item -ItemType Directory -Force $Dir | Out-Null
$Dir = (Resolve-Path $Dir).Path
& curl.exe -s -m 2 -o NUL -H 'Host: localhost:3100' http://127.0.0.1:3100/api/state 2>$null
if ($LASTEXITCODE -eq 0) { Fail '面板正在运行。先关闭面板的窗口，再重新运行安装脚本。' 'The panel is running. Close its window, then run the installer again.' }
Ok $Dir $Dir

# ------------------------------------------------------------------------------ 2. Node.js
Step '2/4' 'Node.js 22' 'Node.js 22'
$Node = $null
$cands = @((Join-Path $Dir 'runtime\node\node.exe'))
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $cands += $cmd.Source }
if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'nodejs\node.exe') }
foreach ($c in $cands) { if (Node-Ok $c) { $Node = $c; break } }
if ($Node) {
  Ok "使用 $Node（$(& $Node -v)）" "using $Node ($(& $Node -v))"
} else {
  Info "没有找到 Node.js 22 或更高版本。下载一份私有副本到 $Dir\runtime\node（不需要管理员权限，不影响系统）。" `
       "No Node.js 22 or later found. Downloading a private copy to $Dir\runtime\node (no admin rights, the system stays unchanged)."
  $bases = 'https://nodejs.org/dist/latest-v22.x', 'https://npmmirror.com/mirrors/node/latest-v22.x'
  if ($L -eq 'zh') { [array]::Reverse($bases) }
  $got = $false
  foreach ($base in $bases) {
    if (-not (Dl "$base/SHASUMS256.txt" "$Tmp/SHASUMS256.txt" -Quiet)) { continue }
    $line = Get-Content "$Tmp/SHASUMS256.txt" | Where-Object { $_ -match " node-v22\.[0-9.]+-win-$NArch\.zip$" } | Select-Object -First 1
    if (-not $line) { continue }
    $sum, $file = $line -split '\s+', 2
    Dim "$base/$file"
    if (-not (Dl "$base/$file" "$Tmp/$file")) { continue }
    if ((Get-FileHash "$Tmp/$file" -Algorithm SHA256).Hash.ToLower() -ne $sum.ToLower()) { Warn 'SHA-256 校验失败，换下一个下载源' 'SHA-256 check failed, trying the next source'; continue }
    Expand-Archive -LiteralPath "$Tmp/$file" -DestinationPath "$Tmp/node" -Force
    $inner = Get-ChildItem "$Tmp/node" -Directory | Select-Object -First 1
    $rt = Join-Path $Dir 'runtime'
    New-Item -ItemType Directory -Force $rt | Out-Null
    if (Test-Path (Join-Path $rt 'node')) { Remove-Item (Join-Path $rt 'node') -Recurse -Force }
    Move-Item $inner.FullName (Join-Path $rt 'node')
    $got = $true; break
  }
  $Node = Join-Path $Dir 'runtime\node\node.exe'
  if (-not ($got -and (Node-Ok $Node))) { Fail 'Node.js 下载失败。手动安装见 INSTALL.md「手动安装」第 1 步。' 'The Node.js download failed. For a manual install, see step 1 of Manual install in INSTALL.md.' }
  Ok "已安装 $(& $Node -v)，SHA-256 校验通过" "installed $(& $Node -v), SHA-256 OK"
}

# ------------------------------------------------------------------------------ 3. panel files
Step '3/4' '面板文件' 'Panel files'
Dim (T '查找可用的 GitHub 代理端口…' 'looking for a local proxy port that reaches GitHub...')
Probe-Proxies
if ($script:PX.Count) { Dim "GitHub → $($script:PX -join ', ')" } else { Dim (T '未发现本机代理端口，GitHub 直连' 'no local proxy port found, GitHub direct') }
if ($FromFolder -and $env:SH_UPDATE -ne '1') {
  Ok '使用当前文件夹中的面板（要更新面板，设置 $env:SH_UPDATE=1）' 'using the panel in this folder (set $env:SH_UPDATE=1 to update it)'
} else {
  $tag = $null
  if (Dl "https://api.github.com/repos/$Repo/releases/latest" "$Tmp/rel.json" -GitHub -Quiet) {
    try { $tag = (Get-Content "$Tmp/rel.json" -Raw | ConvertFrom-Json).tag_name } catch {}
  }
  if (-not $tag) {   # the API is rate-limited per IP; the release page redirect is not
    foreach ($m in @('') + $Mirrors) {
      $a = @('-sI', '-m', '15'); if ($script:PX.Count) { $a += '-x', $script:PX[0] }
      $loc = (& curl.exe @a "${m}https://github.com/$Repo/releases/latest") | Where-Object { $_ -match '^location:' } | Select-Object -Last 1
      if ($loc -match '/tag/([^\s/]+)') { $tag = $Matches[1]; break }
    }
  }
  if (-not $tag) { Fail '无法从 GitHub 获取最新版本。打开代理软件后重试。' 'Cannot get the newest version from GitHub. Turn on your proxy app, then try again.' }
  $zip = "Stronghold-Host-Panel-$tag-windows.zip"
  Info $zip $zip
  if (-not (Dl "https://github.com/$Repo/releases/download/$tag/$zip" "$Tmp/panel.zip" -GitHub)) { Fail '面板下载失败。' 'The panel download failed.' }
  Expand-Archive -LiteralPath "$Tmp/panel.zip" -DestinationPath "$Tmp/x" -Force
  if (-not (Test-Path "$Tmp/x/Stronghold-Host-Panel/server.mjs")) { Fail 'ZIP 内容不正确' 'The ZIP has unexpected content' }
  # copy over the old files: config.json, usage.json and runtime\ are not in the ZIP, so they stay
  & $Node -e "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true, force: true })" "$Tmp/x/Stronghold-Host-Panel" $Dir
  if ($LASTEXITCODE -ne 0) { Fail "无法写入 $Dir" "Cannot write to $Dir" }
  Ok "面板 $tag → $Dir" "panel $tag → $Dir"
}
try { Get-ChildItem $Dir -Recurse -File | Unblock-File } catch {}   # drop the 'downloaded from the internet' mark

# ------------------------------------------------------------------------------ 4. setup
Step '4/4' 'SakuraFrp 与游戏' 'SakuraFrp and the game'
$sa = @((Join-Path $Dir 'lib\setup.mjs'), '--lang', $L); if ($Yes) { $sa += '--yes' }
& $Node @sa
$setup = $LASTEXITCODE

$start = Join-Path $Dir 'Start-Stronghold-Panel.bat'
Write-Host ''
Info "以后开服：双击 $start，然后点「开始联机」。" "To host: double-click $start, then click 开始联机."
Info '第一次启动时 Windows 防火墙会询问 node.exe：允许「专用网络」，局域网玩家才能直接连接。' `
     'On the first start, Windows Firewall asks about node.exe: allow Private networks, so LAN players can connect directly.'
if ($setup -eq 0 -and (YesNo '现在启动面板？' 'Start the panel now?')) { Start-Process -FilePath $start -WorkingDirectory $Dir }
} catch {
  Write-Host "  x $($_.Exception.Message)" -ForegroundColor Red
} finally {
  if ($Tmp -and (Test-Path $Tmp)) { Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
}
