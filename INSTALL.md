# Install and setup

This guide sets up the panel on a new computer, from nothing to a working player link. The commands are for macOS. Where Windows or Linux is different, a line below the macOS command shows the difference. Do it once. After that, hosting is: double-click the start file, then click 开始联机.

## What you need

| Item | Where it goes | Notes |
|---|---|---|
| macOS, Windows 10/11, or Linux | | Apple silicon or Intel, x64 or ARM |
| Node.js 22 or later | Homebrew / winget / nvm | The game needs Node 22 or later |
| Git | Xcode tools / Git for Windows / package manager | Only to clone the repo and get updates |
| SakuraFrp account | [natfrp.com](https://www.natfrp.com/) | The free plan is enough for a few players |
| SakuraFrp `frpc` (CLI) | `~/SakuraFrp/frpc` (Windows: `frpc.exe`) | You do not need the SakuraFrp launcher app |
| A proxy app (optional) | | Only if you need one to reach GitHub. Step 5 shows the rules. |

## 1. Install Node.js 22

```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
```

The last command must print `v22.x` or later. On an Intel Mac, Homebrew uses `/usr/local/opt/node@22/bin`. The start file finds both paths.

- Windows (PowerShell): `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`. Then open a new window and run `node -v`.
- Linux: install [nvm](https://github.com/nvm-sh/nvm#installing-and-updating), then run `nvm install 22`. Distro packages are often older than 22. Also install `git`, `curl`, and `unzip` (Debian/Ubuntu: `sudo apt install git curl unzip`).

## 2. Get the panel

In VS Code:

1. Push Cmd+Shift+P (Windows and Linux: Ctrl+Shift+P), type `Git: Clone`, then select "Clone from GitHub".
2. Select `whyhea1/stronghold-host-panel`.
3. Select the Desktop as the location, then open the folder.

In a terminal, the same thing (the same commands work in PowerShell):

```bash
cd ~/Desktop
git clone https://github.com/whyhea1/stronghold-host-panel.git
```

If macOS asks to install the command line developer tools, accept. This installs Git.

## 3. Install the SakuraFrp CLI

1. Download `frpc` for your system from the [SakuraFrp download page](https://www.natfrp.com/tunnel/download): `darwin` for macOS, `windows` for Windows, `linux` for Linux. Use `arm64` for Apple silicon and ARM, and `amd64` for Intel and AMD. Stock frp cannot connect to SakuraFrp.
2. Move it into place and remove the macOS quarantine flag:

   ```bash
   mkdir -p ~/SakuraFrp
   mv ~/Downloads/frpc_*_darwin_*/frpc ~/SakuraFrp/
   chmod +x ~/SakuraFrp/frpc
   xattr -d com.apple.quarantine ~/SakuraFrp/frpc 2>/dev/null
   ~/SakuraFrp/frpc -V
   ```

   - Linux: the same commands, without the `xattr` line.
   - Windows: make the folder `C:\Users\<you>\SakuraFrp`, put the file there, and rename it to `frpc.exe`. Then run `~\SakuraFrp\frpc.exe -V` in PowerShell.

3. Make sure that the version text contains `sakura`. Use the newest build. Versions older than `0.51.0-sakura-7` handle 自动 HTTPS incorrectly.

## 4. Create the tunnel

On the SakuraFrp website, create a tunnel with these values:

| Field | Value |
|---|---|
| Type | TCP |
| 本地 IP | `127.0.0.1` |
| 本地端口 | `3000` (the `port` key in `config.json`) |
| 自动 HTTPS | 启用 |
| 访问密码 | empty |

Domestic nodes block plain HTTP through a TCP tunnel. Players then get `501 Not Implemented`. With 自动 HTTPS on, `frpc` accepts HTTPS from players and sends plain HTTP to the panel. Thus the player link must start with `https://` ([SakuraFrp auto-HTTPS docs](https://doc.natfrp.com/frpc/auto-https.html)).

Then write the tunnel config to disk. On the tunnel list, open 操作 → 配置文件 and copy the launch argument (`-f 访问密钥:隧道ID`):

```bash
cd ~/SakuraFrp
./frpc -f 你的访问密钥:隧道ID -w
grep auto_https frpc.ini
```

Windows (PowerShell): `cd ~\SakuraFrp`, then `.\frpc.exe -f 你的访问密钥:隧道ID -w`, then `Select-String auto_https frpc.ini`.

The `grep` (or `Select-String`) command must print an `auto_https` line. If it prints nothing, the website did not save the 自动 HTTPS setting. Save it again, then run the `-w` command again.

Each time you change the tunnel on the website, run the `-w` command again. Then restart the tunnel in the panel.

## 5. If you use a proxy app

Do this step if a proxy app runs on the computer while you host. Examples are Clash Verge Rev, Mihomo Party (Clash Party), ClashX, Surge, v2rayN, V2rayU, and sing-box. If you do not use a proxy, go to step 6.

A proxy app touches the panel in three places:

| Traffic | Must go | Why |
|---|---|---|
| `frpc` to the SakuraFrp node | Direct | A proxied tunnel to a domestic node fails or lags |
| Players to the hub (127.0.0.1, LAN) | Direct | Local traffic. Most apps already send it direct. |
| The panel, `git`, and VS Code to GitHub | Through the proxy | Game downloads, game updates, and panel updates |

### 5.1 Send frpc direct

This is necessary in TUN mode, 增强模式, or any mode that catches all traffic. In system-proxy mode only, `frpc` does not use the proxy. But add the rule anyway, so that a later mode change does not break the tunnel.

Put these rules at the top of your rule list. Rules higher in the list win. On Windows, the process name is `frpc.exe`. Write `PROCESS-NAME,frpc.exe,DIRECT` (sing-box: `"frpc.exe"`) instead of `frpc`.

Clash, Mihomo, and Clash Verge Rev (YAML, or the override / 覆写 / merge feature of your app):

```yaml
rules:
  - PROCESS-NAME,frpc,DIRECT
  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
```

Mihomo Party (Clash Party) script override:

```js
function main(config) {
  config.rules = [
    "PROCESS-NAME,frpc,DIRECT",
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
    ...(config.rules || []),
  ];
  return config;
}
```

Surge (`[Rule]` section):

```ini
PROCESS-NAME,frpc,DIRECT
IP-CIDR,127.0.0.0/8,DIRECT,no-resolve
IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
```

sing-box (`route.rules`, before other rules):

```json
{ "process_name": ["frpc"], "outbound": "direct" },
{ "ip_cidr": ["127.0.0.0/8", "192.168.0.0/16"], "outbound": "direct" }
```

In sing-box, use the tag of your own direct outbound if it is not `direct`.

If your app has no process rules, add a direct rule for the node domain of your tunnel (the `server_addr` value in `frpc.ini`, for example `DOMAIN-SUFFIX,<server_addr>,DIRECT`). Or turn off TUN and use system-proxy mode while you host.

The panel also removes `http_proxy`, `https_proxy`, and `all_proxy` from the environment of `frpc`. frp reads these variables, so a proxy that you export in `~/.zshrc` cannot catch the tunnel.

To make sure that the rule works, start the tunnel. Then open the connection list of your proxy app. The `frpc` connection must show DIRECT.

### 5.2 Let the panel reach GitHub

The panel first tries GitHub directly. If that fails, it tries local proxy ports in this order, as HTTP and then as SOCKS5:

| Port | Usual app |
|---|---|
| 7890 | Clash, Mihomo, Mihomo Party, ClashX |
| 7897 | Clash Verge Rev |
| 10809, 10808 | v2rayN (HTTP, SOCKS) |
| 6152, 6153 | Surge (HTTP, SOCKS) |
| 1087, 1080 | V2rayU (HTTP, SOCKS) |

If your app uses a different port, set `ghProxy` in `config.json`, then restart the panel:

```json
{ "ghProxy": "http://127.0.0.1:你的端口" }
```

For a SOCKS-only port, use `socks5h://127.0.0.1:你的端口`. The proxy app must be on while the panel downloads. If all proxies fail, the panel tries the mirrors in `ghMirrors`.

### 5.3 Let git and VS Code reach GitHub

In TUN mode, `git` and VS Code usually work without changes. If they cannot connect, send only GitHub traffic through your proxy port:

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:你的端口
```

For VS Code, push Cmd+Shift+P (Windows and Linux: Ctrl+Shift+P) and select "Preferences: Open User Settings (JSON)". Add these lines, then restart VS Code:

```json
"http.proxy": "http://127.0.0.1:你的端口",
"http.proxySupport": "override"
```

To remove the git setting later, run `git config --global --unset http.https://github.com.proxy`.

## 6. First start

1. Double-click `Start-Stronghold-Panel.command`. The first time, macOS can block it. Then right-click the file and select Open.
2. The panel opens at <http://localhost:3100>.
3. The panel creates `config.json` with the default values. See [config.json](#configjson).

- Windows: double-click `Start-Stronghold-Panel.bat`. If SmartScreen blocks it, select More info, then Run anyway. If Windows Firewall asks about Node.js, allow private networks. LAN players need this. Tunnel players do not.
- Linux: run `./Start-Stronghold-Panel.command` in a terminal, in the panel folder.

Keep the terminal window open while you host. If you close it, the panel stops the game and the tunnel.

## 7. Check the player link

The panel reads the player link from `frpc.ini`. It uses `server_addr` and `remote_port`, and `https://` when `auto_https` is on. The link shows in the 玩家入口 card. Make sure that it starts with `https://`.

The panel also finds your node by `server_addr`, and reads the SakuraFrp 访问密钥 from the `user =` line. Thus you usually do not have to enter anything in 设置.

To use a different link, for example a custom domain, enter it in 设置 → 公网地址. To show the status of a different node, enter its name in 设置 → 监控节点. Leave a field empty to go back to the value from `frpc.ini`.

## 8. Install the game

Click 检查更新 in the game card. The panel shows 游戏有新版本. Click 下载并安装. The panel downloads the release ZIP from [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) and installs it to `~/StrongholdProtocol/current`.

## 9. Test before game night

1. Click 开始联机. Wait until the game shows 运行中 and the tunnel shows 已连接.
2. On your phone, turn off Wi-Fi so that the phone uses mobile data.
3. Open the player link. The 中转站 page must load.
4. Click 进入游戏 and create a room.

The first visit can show a certificate warning. In Chrome, select Advanced, then proceed. In Safari, select Show Details, then visit the website.

## config.json

The panel reads `config.json` one time, when it starts. If you edit the file, restart the panel. The keys marked "Panel" are also in 设置. Changes there do not need a restart.

Git ignores `config.json` because it can contain your 访问密钥. `config.example.json` in the repo shows the format.

| Key | Default | Panel | Meaning |
|---|---|---|---|
| `publicUrl` | empty | yes | The link that players get, on the copy button and the QR code. Empty means "build it from `frpc.ini`". |
| `nodeName` | empty | yes | SakuraFrp node to show status for. Empty means "find it by `server_addr` in `frpc.ini`". |
| `frpcBin` | `~/SakuraFrp/frpc` (Windows: `~/SakuraFrp/frpc.exe`) | yes | Path to the `frpc` program |
| `frpcConfig` | `~/SakuraFrp/frpc.ini` | yes | Path to the tunnel config from step 4 |
| `sakuraToken` | empty | yes | SakuraFrp 访问密钥. Empty means "read `user =` from `frpc.ini`". |
| `speedLimitMbps` | `10` | yes | Tunnel speed limit, for the bandwidth gauge |
| `dailyLimitGB` | `2` | yes | Daily data budget in GiB. Days start at 00:00 UTC+8. Warning only. |
| `dailyAutoBroadcast` | `true` | yes | Show players a 流量提醒 bar at 80%, 95%, and 100% |
| `port` | `3000` | no | Public port of the hub. Must be the same as 本地端口 of the tunnel. |
| `gameInternalPort` | `3001` | no | Port of the game on 127.0.0.1, behind the hub |
| `panelPort` | `3100` | no | Port of the host panel on 127.0.0.1 |
| `gameRoot` | `~/StrongholdProtocol` | no | Folder for `current/`, `previous/`, and `updates/` |
| `repo` | `sganggs/Stronghold-Protocol` | no | GitHub repo for game releases |
| `ghProxy` | `auto` | no | `auto` tries the ports in `proxyPorts`. `none` turns proxies off. You can also give a URL, for example `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`. |
| `proxyPorts` | `[7890, 7897, 10809, 10808, 6152, 6153, 1087, 1080]` | no | Local proxy ports that `auto` tries, as HTTP and SOCKS5. See step 5.2. |
| `ghMirrors` | `["https://ghfast.top/", "https://gh-proxy.com/"]` | no | Download mirrors, used if GitHub fails |

A `config.json` only needs the keys that are different from the defaults. With a standard setup, `{}` is enough. The panel adds the other keys when you save the settings. For example, to use a custom domain:

```json
{
  "publicUrl": "https://play.example.com:12345"
}
```

## Files the panel makes

On Windows, `~` is your user folder, for example `C:\Users\<you>`.

| Path | Content |
|---|---|
| `config.json` | Your settings |
| `usage.json` | Today's data count, so a restart does not reset it |
| `~/StrongholdProtocol/current/` | The installed game |
| `~/StrongholdProtocol/previous/` | The version before the last update, for rollback |
| `~/StrongholdProtocol/updates/` | Downloads in progress |

## Update the panel

1. Stop the panel. Close the terminal window or push Ctrl+C.
2. In VS Code, click Sync in the status bar. In a terminal, run `git pull` in the panel folder.
3. Start the panel again.

Git does not touch `config.json` or `usage.json` during an update.

## Troubleshooting

| Problem | Fix |
|---|---|
| Players get `501 Not Implemented` | They used `http://`. Send the `https://` link. If 自动 HTTPS is off, do step 4 again. |
| `https://` gives `ERR_SSL_PROTOCOL_ERROR` | The running `frpc` does not use 自动 HTTPS. Run `grep auto_https ~/SakuraFrp/frpc.ini` (Windows: `Select-String auto_https ~\SakuraFrp\frpc.ini`). If it prints nothing, run the `-w` command from step 4 again. Then restart the tunnel in the panel. |
| The tunnel fails or lags, and a proxy app is on | `frpc` goes through the proxy. Add the rules from step 5.1, then make sure that the connection shows DIRECT. |
| Tunnel shows 隧道已在线 | An old `frpc` is still connected. Click 断开, then 连接. If that does not help, close the SakuraFrp launcher app and click 连接 again. |
| Red banner: port 3000 in use | Another program holds port 3000. Click 重启并接管. |
| The panel says the game is not installed | Do step 8 |
| GitHub check fails | Turn your proxy app on. If its port is not in `proxyPorts`, set `ghProxy`. See step 5.2. |
| macOS blocks `frpc` or the start file | Run `xattr -d com.apple.quarantine <file>`, or right-click the file and select Open |
| Windows blocks `frpc.exe` or the `.bat` file | SmartScreen: select More info, then Run anyway. If antivirus removes `frpc.exe`, add an exclusion for the `SakuraFrp` folder. |
| Linux: "could not extract the ZIP" | Install `unzip` (`sudo apt install unzip`), then click 下载并安装 again |
| Linux: no desktop notifications | Install `notify-send` (Debian/Ubuntu: `sudo apt install libnotify-bin`). The panel banner works without it. |
| The game does not start | Run `node -v`. It must print `v22.x` or later. Then read the Game logs tab in the panel. |
