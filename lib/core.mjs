// core.mjs — config, shared state, log bus. Every other module imports this;
// this module imports nothing from the project, so there are no cycles.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const PANEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = path.join(PANEL_DIR, "web");
const CONFIG_PATH = path.join(PANEL_DIR, "config.json");

const DEFAULTS = {
  repo: "sganggs/Stronghold-Protocol",
  gameRoot: "~/StrongholdProtocol",
  port: 3000,                 // public port: hub listens here, frpc tunnels here
  gameInternalPort: 3001,     // game binds 127.0.0.1:<this> behind the hub
  panelPort: 3100,
  publicUrl: "https://node.example.com:12345",
  frpcBin: "~/SakuraFrp/frpc",
  frpcConfig: "~/SakuraFrp/frpc.ini",
  ghProxy: "auto",            // "auto" | "none" | "http://127.0.0.1:7890"
  proxyPorts: [7890, 7897, 10809, 1080],
  ghMirrors: ["https://ghfast.top/", "https://gh-proxy.com/"],
  sakuraToken: "",            // SakuraFrp 访问密钥; falls back to `user =` in frpc.ini
  nodeName: "示例节点",
  speedLimitMbps: 10,
  dailyLimitGB: 2,            // daily tunnel data budget (GiB, UTC+8 days) — warn only, never stops anything
  dailyAutoBroadcast: true,   // also show players an automatic 流量提醒 at 80 / 95 / 100 %
};

// keys the UI is allowed to change (everything else is file-only)
export const EDITABLE_KEYS = ["publicUrl", "frpcBin", "frpcConfig", "sakuraToken", "nodeName", "speedLimitMbps", "dailyLimitGB", "dailyAutoBroadcast"];

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export const config = { ...DEFAULTS, ...(readJson(CONFIG_PATH) || {}) };
export function saveConfig(patch = {}) {
  for (const k of EDITABLE_KEYS) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === "speedLimitMbps") v = Math.max(1, Number(v) || DEFAULTS.speedLimitMbps);
    else if (k === "dailyLimitGB") v = Math.min(1000, Math.max(0.01, Number(v) || DEFAULTS.dailyLimitGB));
    else if (k === "dailyAutoBroadcast") v = v === true || v === "true" || v === 1;
    else v = String(v ?? "").trim();
    if (k === "sakuraToken" && v === "") continue;   // blank = keep the saved key
    config[k] = v;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
if (!fs.existsSync(CONFIG_PATH)) saveConfig();

export const expand = (p) => String(p || "").replace(/^~(?=$|\/)/, os.homedir());
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
  update: { phase: "idle", received: 0, total: 0, route: "" },
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
