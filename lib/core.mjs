// core.mjs — config, shared state, log bus. Every other module imports this;
// this module imports nothing from the project, so there are no cycles.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { IS_WIN } from "./platform.mjs";

export const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = path.join(PANEL_DIR, "web");
const CONFIG_PATH = path.join(PANEL_DIR, "config.json");

const DEFAULTS = {
  repo: "sganggs/Stronghold-Protocol",
  gameRoot: "~/StrongholdProtocol",
  port: 3000,                 // public port: hub listens here, frpc tunnels here
  gameInternalPort: 3001,     // game binds 127.0.0.1:<this> behind the hub
  panelPort: 3100,
  publicUrl: "",              // empty = build it from frpc.ini (server_addr + remote_port, https when auto_https is on)
  frpcBin: IS_WIN ? "~/SakuraFrp/frpc.exe" : "~/SakuraFrp/frpc",
  frpcConfig: "~/SakuraFrp/frpc.ini",
  ghProxy: "auto",            // "auto" | "none" | "http://127.0.0.1:7890" | "socks5h://127.0.0.1:1080"
  proxyPorts: [7890, 7897, 10809, 10808, 6152, 6153, 1087, 1080],   // default ports of common proxy apps (HTTP, SOCKS5, or mixed)
  ghMirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  sakuraToken: "",            // SakuraFrp 访问密钥; falls back to `user =` in frpc.ini
  nodeName: "",               // empty = find the node by server_addr in frpc.ini
  speedLimitMbps: 10,
  dailyLimitGB: 2,            // daily tunnel data budget (GiB, UTC+8 days) — warn only, never stops anything
  dailyAutoBroadcast: true,   // also show players an automatic 流量提醒 at 80 / 95 / 100 %
  gamePackage: "full",        // "full" (all art, recommended) | "lite" (~22 MB, art downloaded on install)
  updateMode: "patch",        // "patch": install the 更新包 (only the changed files; several in a row when versions were skipped) | "full": always the whole package
  autoCheckMin: 60,           // minutes between automatic update checks; 0 = off
  playerCache: true,          // players' browsers keep the game files (IndexedDB), so a reconnect costs no tunnel data
  lang: "zh",                 // "zh" | "en": desktop notifications and the panel's default language
};

// keys the UI is allowed to change (everything else is file-only)
export const EDITABLE_KEYS = ["publicUrl", "frpcBin", "frpcConfig", "sakuraToken", "nodeName", "speedLimitMbps", "dailyLimitGB", "dailyAutoBroadcast",
  "gamePackage", "playerCache", "lang", "updateMode", "autoCheckMin"];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export const config = { ...DEFAULTS, ...(readJson(CONFIG_PATH) || {}) };
export function saveConfig(patch = {}) {
  for (const k of EDITABLE_KEYS) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === "speedLimitMbps") v = Math.max(1, Number(v) || DEFAULTS.speedLimitMbps);
    else if (k === "dailyLimitGB") v = Math.min(1000, Math.max(0.01, Number(v) || DEFAULTS.dailyLimitGB));
    else if (k === "dailyAutoBroadcast" || k === "playerCache") v = v === true || v === "true" || v === 1;
    else if (k === "gamePackage") v = v === "lite" ? "lite" : "full";
    else if (k === "lang") v = v === "en" ? "en" : "zh";
    else if (k === "updateMode") v = v === "full" ? "full" : "patch";
    else if (k === "autoCheckMin") { const n = Number(v); v = !Number.isFinite(n) || n <= 0 ? 0 : Math.min(10080, Math.max(5, Math.round(n))); }
    else v = String(v ?? "").trim();
    if (k === "sakuraToken" && v === "") continue;   // blank = keep the saved key
    config[k] = v;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
if (!fs.existsSync(CONFIG_PATH)) saveConfig();

export const expand = (p) => String(p || "").replace(/^~(?=$|[\\/])/, os.homedir());

/** The parts of the SakuraFrp tunnel config the panel uses (INI from `frpc -w`, TOML also accepted). */
export function frpcIni() {
  let txt = "";
  try { txt = fs.readFileSync(expand(config.frpcConfig), "utf8"); } catch { return {}; }
  const get = (keys) => {
    const m = txt.match(new RegExp(`^\\s*(?:${keys})\\s*=\\s*"?([^"\\s#;]+)"?`, "m"));
    return m ? m[1] : "";
  };
  return {
    user: get("user"),
    host: get("server_addr|serverAddr"),
    remotePort: get("remote_port|remotePort"),
    autoHttps: get("auto_https|autoHttps"),
  };
}

/** Player link: config.publicUrl if set, otherwise derived from frpc.ini. */
export function effectivePublicUrl() {
  if (config.publicUrl) return { url: String(config.publicUrl).replace(/\/+$/, ""), auto: false };
  const i = frpcIni();
  if (!i.host || !i.remotePort) return { url: "", auto: true };
  const https = !!i.autoHttps && !/^(false|off|0|no|none|disable[d]?)$/i.test(i.autoHttps);
  return { url: `${https ? "https" : "http"}://${i.host}:${i.remotePort}`, auto: true };
}

export const GAME_DIR = () => path.join(expand(config.gameRoot), "current");
export const UPDATE_DIR = () => path.join(expand(config.gameRoot), "updates");

// ---------------------------------------------------------------------------
// shared mutable state — modules own their own slice, nobody else writes it
// ---------------------------------------------------------------------------
export const state = {
  game: "stopped",          // stopped | starting | running | stopping | error   (game.mjs)
  tunnel: "off",            // off | connecting | connected | error              (tunnel.mjs)
  hub: { bound: false },    //                                                   (hub.mjs)
  health: null,             // game /healthz payload                             (game.mjs)
  rooms: {},                // code -> room, parsed from lobby logs              (game.mjs)
  activity: [],             // recent lobby events                               (game.mjs)
  connections: [],          // live hub peers                                    (hub.mjs)
  bw: { tunnelIn: 0, tunnelOut: 0, lanIn: 0, lanOut: 0, totalInMB: 0, totalOutMB: 0, history: [] }, // hub.mjs
  notice: { text: "", at: null },                                               // hub.mjs
  autoNotice: null,         // automatic 流量提醒 for players                    (usage.mjs)
  usage: null,              // today's data budget                               (usage.mjs)
  version: null, latestVersion: null, latestZipUrl: null, latestSize: 0,       // updater.mjs
  installedPackage: null, latestPackage: null, latestAssets: null, assets: null,
  plan: null,               // what 下载并安装 will do: { kind: "patch"|"full"|"lite", steps: [{tag,name,url,size}], bytes, fullBytes, why }  (updater.mjs)
  autoCheck: { min: 0, last: null, next: null },                               // updater.mjs
  update: { phase: "idle", steps: [], dl: { received: 0, total: 0, bps: 0, eta: null, route: "" }, ex: { files: 0, total: 0 }, as: null, received: 0, total: 0, route: "" },
  sakura: { user: null, plans: null, myNode: null },                           // sakura.mjs
};
export const procs = { game: null, frpc: null, caffeinate: null };

// ---------------------------------------------------------------------------
// log bus + SSE fan-out
// ---------------------------------------------------------------------------
export const sseClients = new Set();
export const backlog = { panel: [], game: [], tunnel: [] };
const BACKLOG_MAX = 800;

export function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

export function log(source, line) {
  const entry = { t: new Date().toISOString(), source, line: String(line).slice(0, 2000) };
  const b = backlog[source] || backlog.panel;
  b.push(entry);
  if (b.length > BACKLOG_MAX) b.shift();
  broadcast({ type: "log", ...entry });
  if (source === "panel") console.log(`[${entry.t.slice(11, 19)}] ${line}`);
}

// sendState() is cheap to call: bursts within 80 ms collapse into one push
let buildState = () => ({});
export function setStateBuilder(fn) { buildState = fn; }
export function publicState() { return buildState(); }
let pending = null;
const stateListeners = new Set();
/** Run fn after every (coalesced) state change — used by the hub's live 中转站 feed. */
export function onStateChange(fn) { stateListeners.add(fn); }
export function sendState() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    broadcast({ type: "state", state: buildState() });
    for (const fn of stateListeners) { try { fn(); } catch {} }
  }, 80);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
