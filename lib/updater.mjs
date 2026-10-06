// updater.mjs — GitHub release check + download (local proxy → direct → mirrors) + install.
// Direct GitHub from mainland China is often reachable but very slow, so GitHub traffic tries a
// working local proxy port first, and a download that stays slow moves on to the next route.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { config, state, log, sendState, broadcast, GAME_DIR, UPDATE_DIR } from "./core.mjs";
import { run } from "./util.mjs";
import { extractZip, IS_WIN } from "./platform.mjs";
import { startGame, stopGame } from "./game.mjs";

const VERSION_FILE = () => path.join(GAME_DIR(), "VERSION");
export function readVersion() {
  try { state.version = fs.readFileSync(VERSION_FILE(), "utf8").trim() || null; } catch { state.version = null; }
}
readVersion();

/** Local proxy ports (HTTP, SOCKS5, or mixed) that actually reach GitHub (cached 5 min). */
let pxCache = { at: 0, list: [] };
export async function proxyCandidates() {
  if (config.ghProxy === "none") return [];
  if (config.ghProxy !== "auto") return [config.ghProxy];
  if (Date.now() - pxCache.at < 300000) return pxCache.list;
  const checks = await Promise.all(config.proxyPorts.map(async (port) => {
    for (const px of [`http://127.0.0.1:${port}`, `socks5h://127.0.0.1:${port}`]) {
      const r = await run("curl", ["-sf", "--max-time", "4", "-x", px, "-o", os.devNull, "https://api.github.com"]);
      if (r.ok) return px;
    }
    return null;
  }));
  pxCache = { at: Date.now(), list: checks.filter(Boolean) };
  return pxCache.list;
}

const isGitHub = (url) => { try { return /(^|\.)github(usercontent)?\.com$/.test(new URL(url).hostname); } catch { return false; } };

/** curl GET. GitHub: local proxies first, then direct. Other hosts: direct first, then proxies. Returns body text or null. */
export async function fetchText(url, headers = [], timeout = 20, curlArgs = []) {
  const base = ["-sfL", "--connect-timeout", "8", "--max-time", String(timeout), ...headers.flatMap((h) => ["-H", h]), ...curlArgs];
  const proxies = (await proxyCandidates()).map((px) => ["-x", px]);
  const order = isGitHub(url) ? [...proxies, []] : [[], ...proxies];
  for (const extra of order) {
    const r = await run("curl", [...base, ...extra, url]);
    if (r.ok) return r.stdout;
  }
  return null;
}

/**
 * The same release data from the github.com pages. api.github.com allows 60 requests per hour per IP,
 * and shared IPs (carrier-grade NAT, proxy nodes) often use them up; the pages have no such limit.
 */
async function releaseFromPages() {
  const base = `https://github.com/${config.repo}/releases`;
  const final = await fetchText(`${base}/latest`, [], 20, ["-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{url_effective}"]);
  const tag = ((final || "").match(/\/releases\/tag\/([^/?#\s]+)/) || [])[1];
  if (!tag) return null;
  log("panel", `GitHub API not available (rate limit?), using the release page: ${tag}`);
  const html = await fetchText(`${base}/expanded_assets/${tag}`);
  const name = ((html || "").match(/\/releases\/download\/[^"]+\/([^"/]*Stronghold-Protocol[^"/]*\.zip)"/) || [])[1];
  if (!name) return { tag_name: tag, assets: [] };
  const url = `${base}/download/${tag}/${name}`;
  const head = await fetchText(url, [], 20, ["-I"]);
  const sizes = [...String(head || "").matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
  return { tag_name: tag, assets: [{ name, browser_download_url: url, size: sizes.length ? sizes[sizes.length - 1] : 0 }] };
}

let checking = false;
export async function checkUpdate() {
  if (checking) return;
  checking = true;
  try {
    log("panel", "checking GitHub for the latest release...");
    const raw = await fetchText(`https://api.github.com/repos/${config.repo}/releases/latest`);
    let rel = null; try { rel = raw && JSON.parse(raw); } catch {}
    if (!rel || !rel.tag_name) rel = await releaseFromPages();
    if (!rel) return log("panel", "cannot reach GitHub — check your network or proxy app");
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
    ...(await proxyCandidates()).map((px) => [`proxy ${px}`, ["-x", px], url]),
    ["direct", [], url],
    ...(config.ghMirrors || []).map((m) => [`mirror ${m}`, [], m + url]),
  ];
  let ok = false;
  for (const [i, [label, extra, target]] of routes.entries()) {
    // every route but the last must keep 100 KB/s over 20 s; the last one only has to keep moving
    const floor = i < routes.length - 1 ? [102400, 20] : [1024, 25];
    setUpdate({ route: label });
    log("panel", `download attempt: ${label}`);
    if ((ok = await download(target, zipPath, extra, size, floor))) break;
  }
  if (!ok) { setUpdate({ phase: "error" }); return log("panel", "download failed on every route — make sure that your proxy app is on and its proxy group is not set to DIRECT"); }

  // players keep seeing the hub's offline page (and any announcement) while we swap
  if (wasRunning) { log("panel", "stopping game for install..."); await stopGame(); }
  setUpdate({ phase: "installing" });
  try {
    const tmp = path.join(dir, `extract-${tag}`);
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    if (!(await extractZip(zipPath, tmp))) throw new Error("could not extract the ZIP — corrupt download, or no unzip tool (Linux: install unzip)");
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

function download(url, out, extra, total, [minBps, minSecs] = [1024, 25]) {
  return new Promise((resolve) => {
    const part = out + ".part";
    try { fs.rmSync(part, { force: true }); } catch {}
    const p = spawn("curl", ["-fL", "-sS", "--connect-timeout", "10", "--speed-limit", String(minBps), "--speed-time", String(minSecs),
      ...extra, "-o", part, url], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
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
      else if (code === 28) { log("panel", `attempt timed out or too slow (under ${Math.round(minBps / 1024)} KB/s for ${minSecs} s), trying the next route`); resolve(false); }
      else { log("panel", `attempt failed (curl ${code}): ${err.trim().slice(0, 200)}`); resolve(false); }
    });
  });
}
