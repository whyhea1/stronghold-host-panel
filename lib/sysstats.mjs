// sysstats.mjs — host load for the panel: CPU, memory, disk, and the game / frpc / panel processes.
// Sampled every 2 s (Windows: 4 s, because each sample starts PowerShell) and only while a panel page is open.
//   CPU            os.cpus() deltas, all cores together (100 % = the whole machine)
//   memory         macOS: vm_stat (app + wired + compressed, like Activity Monitor; file cache is not "used")
//                  Linux: /proc/meminfo MemTotal - MemAvailable · Windows: total - free
//   processes      the game's process tree (npm → node, or a server adopted on the port), frpc, the panel itself;
//                  CPU as a share of the whole machine, memory as resident set (RSS / working set)
import os from "node:os";
import fs from "node:fs";
import { config, state, procs, sseClients, broadcast, expand } from "./core.mjs";
import { run } from "./util.mjs";
import { IS_WIN, IS_MAC, pidsOnPort } from "./platform.mjs";

const CORES = Math.max(1, os.cpus().length);
const HIST = 90;
const sys = {
  cores: CORES, model: (os.cpus()[0] || {}).model || "", platform: process.platform,
  cpu: null, mem: null, disk: null, load: null, procs: { game: null, frpc: null, panel: null },
  history: { cpu: [], mem: [], game: [] }, at: null,
};
export const sysStats = () => sys;

// ---- CPU (whole machine) -----------------------------------------------------------------------------------------
let lastCpu = null;
function cpuPct() {
  const t = os.cpus().reduce((a, c) => { const x = c.times; a.idle += x.idle; a.total += x.user + x.nice + x.sys + x.idle + x.irq; return a; }, { idle: 0, total: 0 });
  const prev = lastCpu; lastCpu = t;
  if (!prev || t.total <= prev.total) return null;
  return Math.max(0, Math.min(100, 100 * (1 - (t.idle - prev.idle) / (t.total - prev.total))));
}

// ---- memory ------------------------------------------------------------------------------------------------------
async function memory() {
  const total = os.totalmem();
  if (IS_MAC) {
    const r = await run("vm_stat", []);
    if (r.ok) {
      const page = Number((r.stdout.match(/page size of (\d+) bytes/) || [])[1]) || 4096;
      const g = (k) => Number((r.stdout.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1]) || 0;
      const anon = g("Anonymous pages"), purge = g("Pages purgeable"), wired = g("Pages wired down"), comp = g("Pages occupied by compressor");
      const file = g("File-backed pages");
      const used = anon ? (anon - purge + wired + comp) * page
        : (g("Pages active") + g("Pages inactive") + g("Pages speculative") + wired + comp - purge - file) * page;
      return { total, used: Math.max(0, Math.min(total, used)), cached: file * page };
    }
  } else if (!IS_WIN) {
    try {
      const t = fs.readFileSync("/proc/meminfo", "utf8");
      const kb = (k) => Number((t.match(new RegExp(`^${k}:\\s+(\\d+)`, "m")) || [])[1]) * 1024;
      const avail = kb("MemAvailable");
      if (avail) return { total, used: total - avail, cached: kb("Cached") || 0 };
    } catch {}
  }
  return { total, used: total - os.freemem(), cached: null };
}

// ---- processes ---------------------------------------------------------------------------------------------------
let lastProc = new Map(), lastProcAt = 0;   // pid -> cpu seconds
/** pid -> { ppid, cpuSec, rss } for every process (null when the platform tool fails). */
async function processTable() {
  const out = new Map();
  if (IS_WIN) {
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize),$($_.KernelModeTime),$($_.UserModeTime)\" }"]);
    if (!r.ok) return null;
    for (const l of r.stdout.split(/\r?\n/)) {
      const [pid, ppid, ws, k, u] = l.trim().split(",").map(Number);
      if (pid) out.set(pid, { ppid, rss: ws || 0, cpuSec: ((k || 0) + (u || 0)) / 1e7 });
    }
    return out;
  }
  if (IS_MAC) {
    // macOS ps has no cumulative CPU in seconds with sub-second precision; %cpu is already a recent average
    const r = await run("ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss="]);
    if (!r.ok) return null;
    for (const l of r.stdout.split("\n")) {
      const [pid, ppid, pcpu, rss] = l.trim().split(/\s+/).map(Number);
      if (pid) out.set(pid, { ppid, pcpu, rss: rss * 1024 });
    }
    return out;
  }
  const tick = 100;
  let list = [];
  try { list = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n)); } catch { return null; }
  for (const n of list) {
    try {
      const s = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");     // fields from #3 (state) on
      out.set(Number(n), { ppid: Number(f[1]), cpuSec: (Number(f[11]) + Number(f[12])) / tick, rss: Number(f[21]) * 4096 });
    } catch {}
  }
  return out;
}
function tree(table, roots) {
  const kids = new Map();
  for (const [pid, p] of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const seen = new Set(), stack = roots.filter((x) => table.has(x));
  while (stack.length) { const pid = stack.pop(); if (seen.has(pid)) continue; seen.add(pid); for (const k of kids.get(pid) || []) stack.push(k); }
  return [...seen];
}
function sumGroup(table, pids, dt) {
  if (!pids.length) return null;
  let rss = 0, cpu = 0;
  for (const pid of pids) {
    const p = table.get(pid); if (!p) continue;
    rss += p.rss || 0;
    if (p.pcpu != null) cpu += p.pcpu;
    else if (dt > 0 && lastProc.has(pid)) cpu += Math.max(0, (p.cpuSec - lastProc.get(pid)) / dt) * 100;
  }
  return { pct: Math.min(100, cpu / CORES), rss, count: pids.length };
}
let portPids = { at: 0, list: [] };
async function gameRoots() {
  const roots = procs.game && procs.game.pid ? [procs.game.pid] : [];
  if (state.game === "running" && Date.now() - portPids.at > 10000) {
    const port = state.hub.bound ? config.gameInternalPort : config.port;
    try { portPids = { at: Date.now(), list: (await pidsOnPort(port)).filter((p) => p !== process.pid) }; } catch { portPids = { at: Date.now(), list: [] }; }
  }
  return [...roots, ...(state.game === "running" ? portPids.list : [])];
}

// ---- sampler -----------------------------------------------------------------------------------------------------
const push = (a, v) => { a.push(v == null ? null : +v.toFixed(1)); if (a.length > HIST) a.shift(); };
let busy = false;
async function sample() {
  if (busy || !sseClients.size) { if (!sseClients.size) lastCpu = null; return; }
  busy = true;
  try {
    sys.cpu = cpuPct();
    sys.mem = await memory();
    sys.load = IS_WIN ? null : os.loadavg().map((x) => +x.toFixed(2));
    try {
      const st = fs.statfsSync(fs.existsSync(expand(config.gameRoot)) ? expand(config.gameRoot) : os.homedir());
      sys.disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    } catch { sys.disk = null; }
    const table = await processTable();
    const now = Date.now(), dt = lastProcAt ? (now - lastProcAt) / 1000 : 0;
    if (table) {
      const panelPids = [process.pid];
      sys.procs.game = sumGroup(table, tree(table, await gameRoots()), dt);
      sys.procs.frpc = sumGroup(table, tree(table, procs.frpc && procs.frpc.pid ? [procs.frpc.pid] : []), dt);
      sys.procs.panel = sumGroup(table, panelPids, dt);
      lastProc = new Map([...table].filter(([, p]) => p.cpuSec != null).map(([pid, p]) => [pid, p.cpuSec]));
      lastProcAt = now;
    } else {
      const mu = process.memoryUsage();
      sys.procs = { game: null, frpc: null, panel: { pct: null, rss: mu.rss, count: 1 } };
    }
    push(sys.history.cpu, sys.cpu);
    push(sys.history.mem, sys.mem ? (sys.mem.used / sys.mem.total) * 100 : null);
    push(sys.history.game, sys.procs.game ? sys.procs.game.pct : 0);
    sys.at = new Date().toISOString();
    broadcast({ type: "sys", sys });
  } catch {} finally { busy = false; }
}
export function startSysStats() {
  cpuPct();
  setInterval(sample, IS_WIN ? 4000 : 2000).unref();
}
