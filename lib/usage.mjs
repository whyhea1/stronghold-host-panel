// Daily data budget (default 2 GiB per day, days roll over at 00:00 UTC+8).
//
// Usage = max(tunnel bytes counted by the hub, SakuraFrp's own "本日消耗流量" from /user/info).
//   * hub count  — live, every byte frpc moves for players (LAN traffic is free and not counted)
//   * SakuraFrp  — what the account is actually billed; lags a little and covers every tunnel on the account
// Taking the larger keeps the bar honest either way.
//
// Crossing 80 % / 95 % / 100 % fires once per day: a desktop notification + panel banner for the host and,
// unless turned off, an automatic 流量提醒 bar for players (separate from the host's own announcement).
// Nothing is ever stopped automatically.

import fs from "node:fs";
import path from "node:path";
import { notify } from "./platform.mjs";
import { config, state, log, sendState, PANEL_DIR } from "./core.mjs";

const FILE = path.join(PANEL_DIR, "usage.json");
const GiB = 1073741824;
const dayKey = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);   // UTC+8 calendar day
const fmt = (b) => (b / GiB).toFixed(2);

const LEVELS = [
  { pct: 80, player: (u, l) => `今日联机流量已用 80%（${u} / ${l} GiB），快到上限了，请尽量别开新局`,
    host: "今日流量已用 80%" },
  { pct: 95, player: (u, l) => `今日流量快用完了（${u} / ${l} GiB），服务器可能随时暂停，请准备收尾`,
    host: "今日流量已用 95%" },
  { pct: 100, player: (u, l) => `今日流量已达上限（${l} GiB），房主可能会暂停服务器，感谢理解`,
    host: "今日流量已超过上限" },
];

function fresh() { return { day: dayKey(), tunnelBytes: 0, lanBytes: 0, fired: [], auto: null }; }
function load() {
  try {
    const u = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (u && u.day === dayKey()) return { ...fresh(), ...u };
  } catch {}
  return fresh();
}
let u = load();
let dirty = false;
export function saveUsage() {
  if (!dirty) return;
  dirty = false;
  try { fs.writeFileSync(FILE, JSON.stringify(u)); } catch {}
}
setInterval(saveUsage, 30000).unref();

const limitBytes = () => Math.max(0.01, Number(config.dailyLimitGB) || 2) * GiB;
function sakuraToday() {
  const t = state.sakura && state.sakura.user && state.sakura.user.traffic;
  return Array.isArray(t) && Number.isFinite(t[0]) ? t[0] : null;
}

function rollover() {
  if (u.day === dayKey()) return false;
  log("panel", `new day (UTC+8): yesterday used ${fmt(Math.max(u.tunnelBytes, 0))} GiB through the tunnel — counter reset`);
  u = fresh(); dirty = true; saveUsage();
  return true;
}

/** Called by the hub every 2 s with the bytes moved since the last call. */
export function addTraffic(tunnelBytes, lanBytes) {
  const rolled = rollover();
  if (tunnelBytes > 0 || lanBytes > 0) { u.tunnelBytes += tunnelBytes; u.lanBytes += lanBytes; dirty = true; }
  evaluate(rolled);
}

function hostAlert(title, body) {
  notify(title, body);
}

let lastView = "";
function evaluate(force = false) {
  const lim = limitBytes();
  const sk = sakuraToday();
  const used = Math.max(u.tunnelBytes, sk ?? 0);
  const pct = (used / lim) * 100;

  // only the highest newly crossed level speaks (a jump from 70 % to 101 % gives one alert, not three)
  const crossed = LEVELS.filter((L) => pct >= L.pct && !u.fired.includes(L.pct));
  for (const L of crossed.slice(-1)) {
    for (const c of crossed) u.fired.push(c.pct);
    dirty = true;
    const msg = `${L.host}：${fmt(used)} / ${fmt(lim)} GiB（UTC+8 今天）`;
    log("panel", `data budget: ${msg}`);
    hostAlert("卫戍协议 · 流量提醒", msg + (config.dailyAutoBroadcast !== false ? "，已自动提醒玩家" : ""));
    if (config.dailyAutoBroadcast !== false) {
      u.auto = { text: L.player(fmt(used), fmt(lim)), level: L.pct, at: new Date().toISOString() };
      log("panel", `auto notice to players: "${u.auto.text}"`);
    }
    saveUsage();
  }
  // a raised limit (or a new day) un-fires levels that no longer apply
  const still = u.fired.filter((p) => pct >= p);
  if (still.length !== u.fired.length) {
    u.fired = still; dirty = true;
    if (u.auto && pct < u.auto.level) u.auto = null;
  }

  state.autoNotice = u.auto;
  state.usage = {
    day: u.day, usedBytes: used, limitBytes: lim, pct: +pct.toFixed(1),
    hubBytes: u.tunnelBytes, lanBytes: u.lanBytes, sakuraBytes: sk,
    source: sk != null && sk > u.tunnelBytes ? "sakura" : "hub",
    level: u.fired.length ? Math.max(...u.fired) : 0,
    autoBroadcast: config.dailyAutoBroadcast !== false,
  };
  const key = JSON.stringify([state.usage.pct, state.usage.level, state.usage.sakuraBytes, u.auto && u.auto.text, Math.round(u.tunnelBytes / 1048576)]);
  if (force || key !== lastView) { lastView = key; sendState(); }
}

/** Host clicked 撤下 on the automatic reminder (it will not come back until the next level). */
export function clearAutoNotice() {
  if (!u.auto) return;
  u.auto = null; dirty = true; saveUsage();
  log("panel", "auto data notice cleared");
  evaluate(true);
}

/** Host sends the current usage to players right now. */
export function sendUsageNotice() {
  const lim = limitBytes(), used = state.usage ? state.usage.usedBytes : u.tunnelBytes;
  const pct = Math.round((used / lim) * 100);
  u.auto = { text: `今日联机流量已用 ${pct}%（${fmt(used)} / ${fmt(lim)} GiB）`, level: pct, at: new Date().toISOString() };
  dirty = true; saveUsage();
  log("panel", `usage notice to players: "${u.auto.text}"`);
  evaluate(true);
}

export function recheckUsage() { rollover(); evaluate(true); }
evaluate(true);
setInterval(() => { rollover(); evaluate(); }, 60000).unref();   // picks up SakuraFrp numbers + midnight while idle
