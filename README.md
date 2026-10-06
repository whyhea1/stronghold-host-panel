<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
  <img src="docs/images/hero-light.png" alt="主机面板和手机上的中转站" width="100%">
</picture>

# 卫戍协议 · 主机面板<br><sub>Stronghold Host Panel</sub>

在自己电脑上开 [卫戍协议 Stronghold Protocol](https://github.com/sganggs/Stronghold-Protocol) 服务器，用 SakuraFrp 让外地朋友连进来。<br>
不敲命令，不开 Sakura 启动器，一个网页全搞定。

[![Release](https://img.shields.io/github/v/release/whyhea1/stronghold-host-panel?style=flat-square&label=release)](https://github.com/whyhea1/stronghold-host-panel/releases/latest)
[![Platforms](https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-supported-2ea44f?style=flat-square)](#懒人三步)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A5%2022-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![No dependencies](https://img.shields.io/badge/npm%20install-not%20needed-555?style=flat-square)](#english)

**[下载 Download](https://github.com/whyhea1/stronghold-host-panel/releases/latest)** · **[安装指南 Install guide](INSTALL.md)** · [简体中文](#简体中文) · [English](#english)

</div>

---

# 简体中文

> 一句话：**双击启动 → 点「开始联机」→ 把链接发给朋友**。剩下的面板帮你盯着。

## 懒人三步

1. 去 **[Releases](https://github.com/whyhea1/stronghold-host-panel/releases/latest)** 下载你系统的 zip，解压到桌面。
2. 第一次用：照着 **[安装指南](INSTALL.md#简体中文)** 装好 Node.js 和 frpc，建好隧道。只做一次，大概 15 分钟。
3. 以后每次开服：双击启动文件，点「开始联机」，把链接或二维码发给朋友。完事。

| 系统 | 双击这个 |
|---|---|
| macOS | `Start-Stronghold-Panel.command` |
| Windows | `Start-Stronghold-Panel.bat` |
| Linux | 终端里运行 `./Start-Stronghold-Panel.sh` |

面板开在 <http://localhost:3100>，只有你这台电脑能打开，别人连不上。

## 面板能干啥

<table>
<tr>
<td width="50%" valign="top">

**一键开服 / 关服**

「开始联机」= 启动游戏 + 打通隧道，「全部停止」一键全关。顶栏随时看游戏、隧道、在线人数和今天用了多少流量。

</td>
<td width="50%" valign="top">

**游戏自动更新**

自动检查 GitHub 新版本，一键下载安装。国内网络会自动走你的代理或镜像。旧版本留一份，出问题能退回去。

</td>
</tr>
<tr>
<td colspan="2"><img src="docs/images/topbar.png" alt="顶栏"><br><img src="docs/images/banner-update.png" alt="游戏有新版本"></td>
</tr>
<tr>
<td valign="top">

**玩家入口**

玩家链接自动从 `frpc.ini` 读出来，不用自己填。一键复制，或者让朋友直接扫码。

<img src="docs/images/card-access.png" alt="玩家入口">

</td>
<td valign="top">

**战况**

谁在线、开了几个房间、每个房间里有谁、谁是房主、谁在观战，实时刷新。

<img src="docs/images/card-live.png" alt="战况">

</td>
</tr>
<tr>
<td valign="top">

**全员公告**

打一句话点发布，所有玩家的游戏页面顶上都能看到。要重启、要更新，提前喊一声。

<img src="docs/images/card-broadcast.png" alt="全员公告">

</td>
<td valign="top">

**每日流量**

默认每天 2 GiB。到 80% / 95% / 100% 会提醒你，也可以自动提醒玩家。**只提醒，不会断线。**

<img src="docs/images/card-budget.png" alt="隧道流量">

</td>
</tr>
<tr>
<td valign="top">

**SakuraFrp 账户**

剩余流量、节点在不在线、负载多少，今天没签到还会提醒你。

<img src="docs/images/card-account.png" alt="SakuraFrp 账户">

</td>
<td valign="top">

**隧道**

frpc 在后台以命令行运行，不用开 Sakura 启动器。会自动清掉残留的 frpc，开着 Clash / Mihomo 也照样直连。

<img src="docs/images/card-tunnel.png" alt="穿透隧道">

</td>
</tr>
</table>

## 玩家那边看到啥

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/phones-dark.png">
  <img src="docs/images/phones-light.png" alt="中转站、干员调配备份、离线页" width="100%">
</picture>

| 页面 | 干啥用 |
|---|---|
| **中转站** `/` | 服务器在不在线、有哪些房间、房间里有谁、今天流量用了多少。一键进游戏或加入房间。 |
| **干员调配备份** `/backup` | 干员配置存在玩家自己的浏览器里。换设备、换浏览器、房主换地址之前，先备份一下。 |
| **离线页** | 服务器没开或者在重启时显示这个。服务器回来后自动跳回游戏，不用刷新。 |

玩家打开的就是你发的链接（`https://` 开头），不用装任何东西。

## 常见问题

| 情况 | 怎么办 |
|---|---|
| 朋友打开显示 `501` | 链接要用 `https://`，不是 `http://`。 |
| `https://` 打不开、报 SSL 错误 | 隧道的「自动 HTTPS」没生效。看 [安装指南第 4 步](INSTALL.md#4-建隧道)。 |
| 开着 Clash / Mihomo，隧道连不上或很卡 | 给 frpc 加直连规则。看 [安装指南第 5 步](INSTALL.md#5-开着代理的看这里)。 |
| 检查更新失败 | 打开你的代理软件。面板会自动找常见代理端口。 |
| 我的密钥安全吗 | 面板只在本机 `127.0.0.1` 上监听，访问密钥不会显示在页面上，也不会传到 GitHub。 |

更多问题看 [安装指南的排错表](INSTALL.md#出问题了)。

<details>
<summary><b>完整面板截图</b></summary>

<img src="docs/images/panel-full-dark.png" alt="完整面板">

</details>

---

# English

A local web panel to host [Stronghold Protocol](https://github.com/sganggs/Stronghold-Protocol) on macOS, Windows, or Linux for remote players through a SakuraFrp tunnel. The panel replaces the terminal workflow. It starts the game and the `frpc` CLI, shows their logs, and puts a player hub in front of the game.

No npm dependencies. Runs on macOS, Windows 10/11, and Linux. Needs Node.js 22 or later (the game needs 22, the panel alone runs on 18 or later).

> ### [Download for macOS, Windows, or Linux →](https://github.com/whyhea1/stronghold-host-panel/releases/latest)
> ### [Install and setup guide →](INSTALL.md)
>
> New computer or first install? Start here. The guide covers macOS, Windows, and Linux: Node.js, the SakuraFrp tunnel, proxy apps (Clash, Mihomo, Surge, v2rayN, sing-box), `config.json`, and troubleshooting.

## Start

For a new computer, do the [install and setup guide](INSTALL.md) first.

When the setup is done:

1. Start the panel. The panel opens at <http://localhost:3100>.
   - macOS: double-click `Start-Stronghold-Panel.command`.
   - Windows: double-click `Start-Stronghold-Panel.bat`.
   - Linux: run `./Start-Stronghold-Panel.sh` in a terminal (`.command` in a Git clone).
2. Click 开始联机. This starts the game and the tunnel.

Keep the terminal window open while you host. If you close it, the panel stops the game and the tunnel.

## Ports

| Port | Bind | Purpose |
|---|---|---|
| 3000 | all interfaces | Hub. `frpc` and LAN players connect here. |
| 3001 | 127.0.0.1 | The game. Only the hub talks to it. |
| 3100 | 127.0.0.1 | The host panel. Not reachable from other devices. |

## Hub routes (port 3000)

| Path | Page |
|---|---|
| `/` | 中转站: players online, rooms, room members, daily data use. Live updates, no refresh. |
| `/play` | The game. `/?room=CODE` and `/play?room=CODE` join a room. |
| `/backup` | Back up or restore a player's 干员调配 (the game keeps it in browser storage). |
| `/status.json` | 中转站 data as JSON. `/__panel/events` sends the same data as a live stream. |

When the game is down, `/play` shows an offline page. The page returns players to the game when it comes back.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/phones-dark.png">
  <img src="docs/images/phones-light.png" alt="Hub, loadout backup, and offline page" width="100%">
</picture>

## Features

- Game: start, stop, restart, health check, update from GitHub releases. The panel keeps the old version in `previous/` after an update.
- Tunnel: `frpc` as a CLI process, with cleanup of leftover processes. The panel removes proxy variables from the environment of `frpc`, so the tunnel always connects directly.
- Announcements: a banner on every game page, with preset messages.
- Room members: the hub reads `room.state` frames from the game's WebSocket traffic. It sends nothing to the game and changes no game files.
- Daily data budget: 2 GiB per day by default, with days that start at 00:00 UTC+8. At 80%, 95%, and 100% the panel shows a desktop notification and a panel banner. It can also show players a separate 流量提醒 bar. The panel never stops the game because of the budget.
- SakuraFrp account: traffic, data plans, node status, and a daily 签到 reminder through API v4.
- UI: light, dark, and auto themes. The layout changes from 3 columns to 2 to 1 for the window width. The panel loads the game's fonts from the game install when they are available.

<details>
<summary><b>Full panel screenshot</b></summary>

<img src="docs/images/panel-full-dark.png" alt="Full host panel">

</details>

## Configuration

The panel creates `config.json` on first start with the defaults from `lib/core.mjs`. `config.example.json` shows the keys. [INSTALL.md](INSTALL.md#configjson) explains each key. Git ignores `config.json` because it can contain the SakuraFrp access key. Git also ignores `usage.json`, which stores today's data count.

You can change these keys in the panel settings: `publicUrl`, `frpcBin`, `frpcConfig`, `sakuraToken`, `nodeName`, `speedLimitMbps`, `dailyLimitGB`, `dailyAutoBroadcast`. Change the other keys in the file, then restart the panel.

## Releases

To make a release, create a release on GitHub with a new tag (for example `v1.1.0`), then publish it. The workflow in `.github/workflows/release.yml` then builds one ZIP each for macOS, Windows, and Linux, and adds the ZIPs to the release. Each ZIP contains only the panel, the docs, the example config, and the start file for that system.

## Security

- The panel listens on 127.0.0.1 only. It accepts only the `Host` values `localhost:3100` and `127.0.0.1:3100`.
- Every action needs the header `X-Stronghold-Panel: 1`. Other websites cannot send this header, so they cannot control the panel.
- The panel never shows the access key. The API only reports whether a key exists.

## Layout

```
server.mjs            entry point
lib/core.mjs          config, shared state, log bus
lib/util.mjs          process and network helpers
lib/platform.mjs      macOS / Windows / Linux differences (open, notify, keep awake, kill, unzip)
lib/hub.mjs           port 3000: hub pages, game proxy, bandwidth count
lib/roomwatch.mjs     room members from game traffic
lib/usage.mjs         daily data budget
lib/game.mjs          game process, health check, lobby log parser
lib/tunnel.mjs        frpc process
lib/updater.mjs       game updates from GitHub
lib/sakura.mjs        SakuraFrp API
lib/api.mjs           host panel on 127.0.0.1:3100
web/                  panel UI
web/hub/              hub pages and the in-game banner script
```
