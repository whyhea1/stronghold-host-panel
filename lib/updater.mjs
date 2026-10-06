// updater.mjs — GitHub release check + download (direct → local proxy → mirrors) + install.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, state, log, sendState, broadcast, GAME_DIR, UPDATE_DIR } from "./core.mjs";
import { run } from "./util.mjs";
import { startGame, stopGame } from "./game.mjs";

const VERSION_FILE = () => path.join(GAME_DIR(), "VERSION");
export function readVersion() {
  try { state.version = fs.readFileSync(VERSION_FILE(), "utf8").trim() || null; } catch { state.version = null; }
}
readVersion();

/** Mihomo/Clash-style local proxies that actually reach GitHub (cached 5 min). */
let pxCache = { at: 0, list: [] };
export async function proxyCandidates() {
  if (config.ghProxy === "none") return [];
  if (config.ghProxy !== "auto") return [config.ghProxy];
  if (Date.now() - pxCache.at < 300000) return pxCache.list;
  const checks = await Promise.all(config.proxyPorts.map(async (port) => {
    const px = `http://127.0.0.1:${port}`;
    const r = await run("curl", ["-sf", "--max-time", "4", "-x", px, "-o", "/dev/null", "https://api.github.com"]);
    return r.ok ? px : null;
  }));
  pxCache = { at: Date.now(), list: checks.filter(Boolean) };
  return pxCache.list;
}

/** curl GET with fallback through local proxies. Returns body text or null. */
export async function fetchText(url, headers = [], timeout = 20) {
  const base = ["-sfL", "--connect-timeout", "8", "--max-time", String(timeout), ...headers.flatMap((h) => ["-H", h])];
  let r = await run("curl", [...base, url]);
  if (r.ok) return r.stdout;
  for (const px of await proxyCandidates()) {
    r = await run("curl", [...base, "-x", px, url]);
    if (r.ok) return r.stdout;
  }
  return null;
}

let checking = false;
export async function checkUpdate() {
  if (checking) return;
  checking = true;
  try {
    log("panel", "checking GitHub for the latest release...");
    const raw = await fetchText(`https://api.github.com/repos/${config.repo}/releases/latest`);
    if (!raw) return log("panel", "cannot reach GitHub — check Mihomo Party / network");
    let rel; try { rel = JSON.parse(raw); } catch { return log("panel", "GitHub returned unparseable JSON"); }
    const asset = (rel.assets || []).find((a) => a.name.endsWith(".zip") && a.name.includes("Stronghold-Protocol"));
    state.latestVersion = rel.tag_name || null;
    state.latestZipUrl = asset ? asset.browser_download_url : null;
    state.latestSize = asset ? asset.size : 0;
    readVersion();
    log("panel", `installed ${state.version || "none"} · latest ${state.latestVersion}${updateAvailable() ? " — update available" : ""}`);
    sendState();
  } finally { checking = false; }
}
export const updateAvailable = () => !!(state.latestVersion && state.latestZipUrl && state.latestVersion !== state.version);

function setUpdate(patch) { Object.assign(state.update, patch); sendState(); }

export async function applyUpdate() {
  if (!updateAvailable() || ["downloading", "installing"].includes(state.update.phase)) return;
  const tag = state.latestVersion, url = state.latestZipUrl, size = state.latestSize;
  const wasRunning = state.game === "running";
  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `Stronghold-Protocol-${tag}.zip`);

  setUpdate({ phase: "downloading", received: 0, total: size, route: "" });
  const routes = [
    ["direct", [], url],
    ...(await proxyCandidates()).map((px) => [`proxy ${px}`, ["-x", px], url]),
    ...(config.ghMirrors || []).map((m) => [`mirror ${m}`, [], m + url]),
  ];
  let ok = false;
  for (const [label, extra, target] of routes) {
    setUpdate({ route: label });
    log("panel", `download attempt: ${label}`);
    if ((ok = await download(target, zipPath, extra, size))) break;
  }
  if (!ok) { setUpdate({ phase: "error" }); return log("panel", "download failed on every route — in Mihomo Party, make sure the PROXY group isn't on DIRECT"); }

  // players keep seeing the hub's offline page (and any announcement) while we swap
  if (wasRunning) { log("panel", "stopping game for install..."); await stopGame(); }
  setUpdate({ phase: "installing" });
  try {
    const tmp = path.join(dir, `extract-${tag}`);
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    const uz = await run("unzip", ["-q", zipPath, "-d", tmp]);
    if (!uz.ok) throw new Error("unzip failed — corrupt download?");
    const entries = fs.readdirSync(tmp).map((n) => path.join(tmp, n));
    const inner = entries.length === 1 && fs.statSync(entries[0]).isDirectory() ? entries[0] : tmp;
    const cur = GAME_DIR(), prev = cur.replace(/current$/, "previous");
    fs.rmSync(prev, { recursive: true, force: true });
    if (fs.existsSync(cur)) fs.renameSync(cur, prev);          // keep one rollback copy
    fs.renameSync(inner, cur);
    fs.writeFileSync(VERSION_FILE(), tag + "\n");
    try { fs.chmodSync(path.join(cur, "scripts", "start.sh"), 0o755); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zipPath, { force: true });
    readVersion();
    setUpdate({ phase: "done", received: size, total: size, route: "" });
    log("panel", `installed ${tag} (old version kept in ${path.basename(prev)}/)`);
  } catch (e) {
    setUpdate({ phase: "error" }); log("panel", `install failed: ${e.message}`);
  }
  if (wasRunning) startGame();
}

function download(url, out, extra, total) {
  return new Promise((resolve) => {
    const part = out + ".part";
    try { fs.rmSync(part, { force: true }); } catch {}
    const p = spawn("curl", ["-fL", "-sS", "--connect-timeout", "10", "--speed-limit", "1024", "--speed-time", "25",
      ...extra, "-o", part, url], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    const timer = setInterval(() => {
      try {
        const received = fs.statSync(part).size;
        state.update.received = received;
        broadcast({ type: "progress", received, total });
      } catch {}
    }, 400);
    p.on("exit", (code) => {
      clearInterval(timer);
      if (code === 0) { fs.renameSync(part, out); resolve(true); }
      else { log("panel", `attempt failed (curl ${code}): ${err.trim().slice(0, 200)}`); resolve(false); }
    });
  });
}
