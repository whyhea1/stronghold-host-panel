# Install and setup

This guide sets up the panel on a new Mac, from nothing to a working player link. Do it once. After that, hosting is: double-click the start file, then click 开始联机.

## What you need

| Item | Where it goes | Notes |
|---|---|---|
| macOS | | Apple silicon or Intel |
| Node.js 22 | Homebrew | The game needs Node 22 |
| Git | Xcode command line tools | Only to clone the repo and get updates |
| SakuraFrp account | [natfrp.com](https://www.natfrp.com/) | The free plan is enough for a few players |
| SakuraFrp `frpc` (CLI) | `~/SakuraFrp/frpc` | You do not need the SakuraFrp launcher app |
| Mihomo Party | | Only if you are in mainland China. The panel uses it to reach GitHub. |

## 1. Install Node.js 22

```bash
brew install node@22
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
node -v
```

The last command must print `v22.x`. On an Intel Mac, Homebrew uses `/usr/local/opt/node@22/bin`. The start file finds both paths.

## 2. Get the panel

In VS Code:

1. Push Cmd+Shift+P, type `Git: Clone`, then select "Clone from GitHub".
2. Select `whyhea1/stronghold-host-panel`.
3. Select the Desktop as the location, then open the folder.

In Terminal, the same thing:

```bash
cd ~/Desktop
git clone https://github.com/whyhea1/stronghold-host-panel.git
```

If macOS asks to install the command line developer tools, accept. This installs Git.

## 3. Install the SakuraFrp CLI

1. Download the macOS `frpc` from the [SakuraFrp download page](https://www.natfrp.com/tunnel/download). Use `arm64` for Apple silicon and `amd64` for Intel. Stock frp cannot connect to SakuraFrp.
2. Move it into place and remove the macOS quarantine flag:

   ```bash
   mkdir -p ~/SakuraFrp
   mv ~/Downloads/frpc_*_darwin_*/frpc ~/SakuraFrp/
   chmod +x ~/SakuraFrp/frpc
   xattr -d com.apple.quarantine ~/SakuraFrp/frpc 2>/dev/null
   ~/SakuraFrp/frpc -V
   ```

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

The `grep` command must print an `auto_https` line. If it prints nothing, the website did not save the 自动 HTTPS setting. Save it again, then run the `-w` command again.

Each time you change the tunnel on the website, run the `-w` command again. Then restart the tunnel in the panel.

## 5. Set up Mihomo Party (mainland China only)

`frpc` must connect to the SakuraFrp node directly. If TUN sends `frpc` through a foreign proxy node, the tunnel fails or lags. Add this override in Mihomo Party (覆写):

```js
function main(config) {
  config.rules = [
    "PROCESS-NAME,frpc,DIRECT",
    "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
    ...(config.rules || []),
  ];
  return config;
}
```

Keep Mihomo Party on while you host. The panel finds its local port (7890, 7897, 10809, or 1080) and uses it for GitHub downloads. If GitHub is still slow, the panel tries the mirrors in `ghMirrors`.

If `git clone` or VS Code cannot reach GitHub, send only GitHub traffic through Mihomo:

```bash
git config --global http.https://github.com.proxy http://127.0.0.1:7890
```

## 6. First start

1. Double-click `Start-Stronghold-Panel.command`. The first time, macOS can block it. Then right-click the file and select Open.
2. The panel opens at <http://localhost:3100>.
3. The panel creates `config.json` with the default values. See [config.json](#configjson).

Keep the Terminal window open while you host. If you close it, the panel stops the game and the tunnel.

## 7. Set the player link

Open 设置 in the panel. Set 公网地址 to the address of your tunnel, for example `https://node.example.com:12345`. The domain and the remote port are on the SakuraFrp tunnel list. Use `https://`, not `http://`.

Also set 监控节点 to the name of your node, for example `示例节点`. The panel uses this name to show the node status.

The panel reads the SakuraFrp 访问密钥 from the `user =` line in `frpc.ini`. You do not have to enter it again.

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
| `publicUrl` | `https://node.example.com:12345` | yes | The link that players get. It goes on the copy button and the QR code. |
| `nodeName` | `示例节点` | yes | SakuraFrp node to show status for |
| `frpcBin` | `~/SakuraFrp/frpc` | yes | Path to the `frpc` program |
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
| `ghProxy` | `auto` | no | `auto` finds Mihomo. `none` turns proxies off. You can also give a URL, for example `http://127.0.0.1:7890`. |
| `proxyPorts` | `[7890, 7897, 10809, 1080]` | no | Local ports that `auto` tries |
| `ghMirrors` | `["https://ghfast.top/", "https://gh-proxy.com/"]` | no | Download mirrors, used if GitHub fails |

A minimal `config.json` only needs the keys that are different from the defaults. The panel adds the other keys when you save the settings.

```json
{
  "publicUrl": "https://你的节点域名:远程端口",
  "nodeName": "你的节点名"
}
```

## Files the panel makes

| Path | Content |
|---|---|
| `config.json` | Your settings |
| `usage.json` | Today's data count, so a restart does not reset it |
| `~/StrongholdProtocol/current/` | The installed game |
| `~/StrongholdProtocol/previous/` | The version before the last update, for rollback |
| `~/StrongholdProtocol/updates/` | Downloads in progress |

## Update the panel

1. Stop the panel. Close the Terminal window or push Ctrl+C.
2. In VS Code, click Sync in the status bar. In Terminal, run `git pull` in the panel folder.
3. Start the panel again.

Git does not touch `config.json` or `usage.json` during an update.

## Troubleshooting

| Problem | Fix |
|---|---|
| Players get `501 Not Implemented` | They used `http://`. Send the `https://` link. If 自动 HTTPS is off, do step 4 again. |
| `https://` gives `ERR_SSL_PROTOCOL_ERROR` | The running `frpc` does not use 自动 HTTPS. Run `grep auto_https ~/SakuraFrp/frpc.ini`. If it prints nothing, run the `-w` command from step 4 again. Then restart the tunnel in the panel. |
| Tunnel shows 隧道已在线 | An old `frpc` is still connected. Click 断开, then 连接. If that does not help, close the SakuraFrp launcher app and click 连接 again. |
| Red banner: port 3000 in use | Another program holds port 3000. Click 重启并接管. |
| The panel says the game is not installed | Do step 8 |
| GitHub check fails | Turn Mihomo Party on. If your mixed port is not in `proxyPorts`, set `ghProxy` to `http://127.0.0.1:<port>`. |
| macOS blocks `frpc` or the start file | Run `xattr -d com.apple.quarantine <file>`, or right-click the file and select Open |
| The game does not start | Run `node -v`. It must print `v22.x`. Then read the Game logs tab in the panel. |
