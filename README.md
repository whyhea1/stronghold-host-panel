# Stronghold Host Panel

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

## Features

- Game: start, stop, restart, health check, update from GitHub releases. The panel keeps the old version in `previous/` after an update.
- Tunnel: `frpc` as a CLI process, with cleanup of leftover processes. The panel removes proxy variables from the environment of `frpc`, so the tunnel always connects directly.
- Announcements: a banner on every game page, with preset messages.
- Room members: the hub reads `room.state` frames from the game's WebSocket traffic. It sends nothing to the game and changes no game files.
- Daily data budget: 2 GiB per day by default, with days that start at 00:00 UTC+8. At 80%, 95%, and 100% the panel shows a desktop notification and a panel banner. It can also show players a separate 流量提醒 bar. The panel never stops the game because of the budget.
- SakuraFrp account: traffic, data plans, node status, and a daily 签到 reminder through API v4.
- UI: light, dark, and auto themes. The layout changes from 3 columns to 2 to 1 for the window width. The panel loads the game's fonts from the game install when they are available.

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
