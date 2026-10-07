// updater.mjs — GitHub release check, download (local proxy → direct → mirrors), install, and the art download of
// the lite package. Every install runs as a list of steps with live progress (state.update, "progress" events):
//   download   the release ZIP: bytes, speed, time left, which route
//   extract    files written / files in the ZIP
//   install    swap current/ → previous/, new copy → current/
//   assets     lite package only: the game's own tools/setup.mjs downloads the art and audio (~460 MB, resumable)
//   start      only when the game was running before
// The release has two packages since 0.2.0: Stronghold-Protocol-<tag>.zip (full, recommended: all art, the 3D board
// and the summon models taken from the game client) and Stronghold-Protocol-<tag>-lite.zip (~22 MB, the art comes
// from public mirrors on the first start, without the client-only art). config.gamePackage picks one.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { config, state, log, sendState, broadcast, GAME_DIR, UPDATE_DIR } from "./core.mjs";
import { run, augmentEnv, killTree } from "./util.mjs";
import { extractZip, zipFileCount, IS_WIN } from "./platform.mjs";
import { startGame, stopGame } from "./game.mjs";
import { buildCacheManifest } from "./assetcache.mjs";

const VERSION_FILE = () => path.join(GAME_DIR(), "VERSION");
const PACKAGE_FILE = () => path.join(GAME_DIR(), "PACKAGE");
const wantPackage = () => (config.gamePackage === "lite" ? "lite" : "full");

/** The installed package: the panel's PACKAGE file, else the client-only art folder only the full package has. */
function detectPackage() {
  const dir = GAME_DIR();
  if (!fs.existsSync(dir)) return null;
  try { const v = fs.readFileSync(PACKAGE_FILE(), "utf8").trim(); if (v === "full" || v === "lite") return v; } catch {}
  return fs.existsSync(path.join(dir, "public", "assets", "local")) ? "full" : "lite";
}
export function readVersion() {
  try { state.version = fs.readFileSync(VERSION_FILE(), "utf8").trim() || null; } catch { state.version = null; }
  state.installedPackage = state.version ? detectPackage() : null;
}
readVersion();

/**
 * Art/audio on disk, from the game's own check (tools/setup.mjs checkAssets, 0.2.0+):
 * { status: "ok" | "missing" | "partial" | "unknown", total, missing, bytes }. Older games: by the folder alone.
 */
export async function checkAssets() {
  const dir = GAME_DIR();
  if (!fs.existsSync(dir)) { state.assets = null; sendState(); return null; }
  let a = null;
  if (fs.existsSync(path.join(dir, "tools", "setup.mjs"))) {
    const r = await run(process.execPath, ["--input-type=module", "-e",
      "const m=await import('./tools/setup.mjs');if(m.checkAssets)console.log(JSON.stringify(m.checkAssets()))"], { cwd: dir, timeout: 30000 });
    try { a = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  }
  if (a && a.manifest) state.assets = { status: a.ok ? "ok" : !a.present ? "missing" : "partial", total: a.total, missing: a.missing, bytes: a.bytes || 0 };
  else state.assets = { status: fs.existsSync(path.join(dir, "public", "assets")) ? "ok" : "unknown", total: 0, missing: 0, bytes: 0 };
  sendState();
  return state.assets;
}

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

/** Full and lite ZIP among a release's assets (names: Stronghold-Protocol-<tag>.zip / -lite.zip; older releases: one ZIP). */
function pickAssets(assets) {
  const zips = (assets || []).filter((a) => /\.zip$/i.test(a.name) && a.name.includes("Stronghold-Protocol"));
  const lite = zips.find((a) => /-lite\.zip$/i.test(a.name)) || null;
  const full = zips.find((a) => !/-lite\.zip$/i.test(a.name)) || null;
  const pack = (a) => (a ? { name: a.name, url: a.browser_download_url, size: a.size || 0 } : null);
  return { full: pack(full), lite: pack(lite) };
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
  const names = [...new Set([...String(html || "").matchAll(/\/releases\/download\/[^"]+\/([^"/]*Stronghold-Protocol[^"/]*\.zip)"/g)].map((m) => m[1]))];
  const assets = [];
  for (const name of names) {
    const url = `${base}/download/${tag}/${name}`;
    const head = await fetchText(url, [], 20, ["-I"]);
    const sizes = [...String(head || "").matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
    assets.push({ name, browser_download_url: url, size: sizes.length ? sizes[sizes.length - 1] : 0 });
  }
  return { tag_name: tag, assets };
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
    state.latestVersion = rel.tag_name || null;
    state.latestAssets = pickAssets(rel.assets);
    choosePackage();
    readVersion();
    log("panel", `installed ${state.version || "none"}${state.installedPackage ? ` (${state.installedPackage})` : ""} · latest ${state.latestVersion}` +
      `${updateAvailable() ? " — update available" : packageSwitch() ? ` — ${wantPackage()} package available` : ""}`);
    sendState();
  } finally { checking = false; }
}
/** latestZipUrl / latestSize follow config.gamePackage (falling back to the other package when a release has one). */
export function choosePackage() {
  const a = state.latestAssets || {};
  const pick = a[wantPackage()] || a.full || a.lite || null;
  state.latestPackage = pick ? (pick === a.lite ? "lite" : "full") : null;
  state.latestZipUrl = pick ? pick.url : null;
  state.latestSize = pick ? pick.size : 0;
}
export const updateAvailable = () => !!(state.latestVersion && state.latestZipUrl && state.latestVersion !== state.version);
/** Same version installed, but as the other package (e.g. lite installed, full chosen in the settings). */
export const packageSwitch = () => !!(state.version && state.latestVersion === state.version && state.latestZipUrl &&
  state.installedPackage && state.latestPackage && state.installedPackage !== state.latestPackage);

// ---------------------------------------------------------------------------
// install run: steps + progress
// ---------------------------------------------------------------------------
const STEPS = ["download", "extract", "install", "assets", "start"];
const busy = () => state.update.phase === "running";
let pushAt = 0, pushTimer = null;
function push(now = false) {
  const go = () => { pushAt = Date.now(); pushTimer = null; broadcast({ type: "progress", update: state.update }); };
  if (now || Date.now() - pushAt > 400) { clearTimeout(pushTimer); go(); }
  else if (!pushTimer) pushTimer = setTimeout(go, 400);
}
function step(id, status, detail) {
  const s = state.update.steps.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  if (status === "run") s.at = Date.now();
  if (status === "done" || status === "fail") s.secs = s.at ? Math.round((Date.now() - s.at) / 1000) : 0;
  if (detail !== undefined) s.detail = detail;
  sendState(); push(true);
}
function begin(kind, tag, pkg, size, skip) {
  state.update = {
    phase: "running", kind, tag, pkg, from: state.version || null, startedAt: Date.now(), error: "",
    steps: STEPS.map((id) => ({ id, status: skip.includes(id) ? "skip" : "wait" })),
    dl: { received: 0, total: size, bps: 0, eta: null, route: "" }, ex: { files: 0, total: 0 }, as: null,
    // kept for older consumers
    received: 0, total: size, route: "",
  };
  sendState(); push(true);
}
function finish(ok, error = "") {
  state.update.phase = ok ? "done" : "error";
  state.update.error = error;
  state.update.endedAt = Date.now();
  for (const s of state.update.steps) if (s.status === "wait" || s.status === "run") s.status = ok ? "skip" : s.status === "run" ? "fail" : "wait";
  sendState(); push(true);
}

/** Download + install the chosen package. { force: true } reinstalls the same version (package switch). */
export async function applyUpdate(opts = {}) {
  if (busy()) return;
  if (!(updateAvailable() || (opts.force && state.latestZipUrl) || (!state.version && state.latestZipUrl))) return;
  const tag = state.latestVersion, url = state.latestZipUrl, size = state.latestSize, pkg = state.latestPackage || "full";
  const wasRunning = state.game === "running";
  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, path.basename(new URL(url).pathname) || `Stronghold-Protocol-${tag}.zip`);
  begin("install", tag, pkg, size, [...(pkg === "lite" ? [] : ["assets"]), ...(wasRunning ? [] : ["start"])]);
  log("panel", `installing ${tag} (${pkg} package, ${(size / 1048576).toFixed(0)} MB)`);

  // 1. download
  step("download", "run");
  const routes = [
    ...(await proxyCandidates()).map((px) => [`proxy ${px}`, ["-x", px], url]),
    ["direct", [], url],
    ...(config.ghMirrors || []).map((m) => [`mirror ${m}`, [], m + url]),
  ];
  let ok = false;
  for (const [i, [label, extra, target]] of routes.entries()) {
    // every route but the last must keep 100 KB/s over 20 s; the last one only has to keep moving
    const floor = i < routes.length - 1 ? [102400, 20] : [1024, 25];
    state.update.dl.route = state.update.route = label;
    log("panel", `download attempt: ${label}`);
    if ((ok = await download(target, zipPath, extra, size, floor))) break;
  }
  if (!ok) {
    step("download", "fail");
    finish(false, "download");
    return log("panel", "download failed on every route — make sure that your proxy app is on and its proxy group is not set to DIRECT");
  }
  step("download", "done");

  // 2. extract (the game keeps running; players notice nothing yet)
  step("extract", "run");
  const tmp = path.join(dir, `extract-${tag}`);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
  state.update.ex = { files: 0, total: zipFileCount(zipPath) };
  const extracted = await extractZip(zipPath, tmp, () => { state.update.ex.files++; push(); });
  if (!extracted) {
    step("extract", "fail"); finish(false, "extract");
    return log("panel", "could not extract the ZIP — corrupt download, or no unzip tool (Linux: install unzip)");
  }
  state.update.ex.files = Math.max(state.update.ex.files, state.update.ex.total);
  step("extract", "done");

  // 3. install: players see the hub's offline page (and any announcement) while we swap
  if (wasRunning) { log("panel", "stopping game for install..."); await stopGame(); }
  step("install", "run");
  try {
    const entries = fs.readdirSync(tmp).map((n) => path.join(tmp, n));
    const inner = entries.length === 1 && fs.statSync(entries[0]).isDirectory() ? entries[0] : tmp;
    const cur = GAME_DIR(), prev = cur.replace(/current$/, "previous");
    fs.rmSync(prev, { recursive: true, force: true });
    const hadOld = fs.existsSync(cur);
    if (hadOld) fs.renameSync(cur, prev);          // keep one rollback copy
    fs.renameSync(inner, cur);
    // lite: the art already on disk moves over, so the asset step only fetches what changed
    const oldArt = path.join(prev, "public", "assets"), newArt = path.join(cur, "public", "assets");
    if (pkg === "lite" && fs.existsSync(oldArt) && !fs.existsSync(newArt)) {
      try { fs.renameSync(oldArt, newArt); log("panel", "kept the art of the old version (previous/ now has none)"); } catch {}
    }
    fs.writeFileSync(VERSION_FILE(), tag + "\n");
    fs.writeFileSync(PACKAGE_FILE(), pkg + "\n");
    try { fs.chmodSync(path.join(cur, "scripts", "start.sh"), 0o755); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zipPath, { force: true });
    readVersion();
    step("install", "done");
    log("panel", `installed ${tag} (${pkg}${hadOld ? `; old version kept in ${path.basename(prev)}/` : ""})`);
    if (!hadOld) state.update.from = null;
  } catch (e) {
    step("install", "fail"); finish(false, "install");
    log("panel", `install failed: ${e.message}`);
    if (wasRunning) startGame();
    return;
  }

  // 4. art (lite)
  if (pkg === "lite") await assetsStep();
  buildCacheManifest("new game version");
  checkAssets();

  // 5. start again
  if (wasRunning) {
    step("start", "run");
    await startGame();
    step("start", state.game === "running" ? "done" : "fail");
  }
  finish(true);
}

/**
 * Banner action: download the missing art of an installed lite game, as its own run. The game keeps running:
 * files appear on disk as they arrive, and a restart (the host's choice, players reconnect) loads the new art index.
 */
export async function fetchAssets() {
  if (busy() || !state.version) return;
  begin("assets", state.version, state.installedPackage || "lite", 0, ["download", "extract", "install", "start"]);
  const ok = await assetsStep();
  buildCacheManifest("art downloaded");
  await checkAssets();
  state.update.restartHint = ok && state.game === "running";
  finish(ok, ok ? "" : "assets");
}

/** The game's own setup (dependencies, vendor libs, art download): node tools/setup.mjs --no-local, progress from its log. */
function assetsStep() {
  step("assets", "run");
  const dir = GAME_DIR();
  let bytes = 0;
  try { bytes = Number(JSON.parse(fs.readFileSync(path.join(dir, "data", "assets.json"), "utf8")).stats?.bytes) || 0; } catch {}
  state.update.as = { label: "", done: 0, total: 0, mb: 0, mbps: 0, expectBytes: bytes, err: 0 };
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(process.execPath, ["tools/setup.mjs", "--no-local"], { cwd: dir, env: augmentEnv({ NO_COLOR: "1", FORCE_COLOR: "0" }),
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: !IS_WIN });
    } catch (e) { log("panel", "could not run the game's setup: " + e.message); step("assets", "fail"); return resolve(false); }
    assetProc = p;
    let rest = "";
    const eat = (c) => {
      const lines = (rest + c).split(/\r?\n|\r/); rest = lines.pop();
      for (let l of lines) {
        l = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        if (!l.trim()) continue;
        const m = l.match(/\[([^\]]+)\]\s+(\d+)\/(\d+)\s+ok=(\d+)\s+skip=(\d+)\s+miss=(\d+)\s+err=(\d+)\s+([\d.]+)\s*(KB|MB|GB|B)\b.*?([\d.]+)\s*MB\/s/);
        if (m) {
          const unit = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024 }[m[9]] || 1;
          state.update.as = { ...state.update.as, label: m[1], done: +m[2], total: +m[3], ok: +m[4], skip: +m[5], miss: +m[6], err: +m[7], mb: +m[8] * unit, mbps: +m[10] };
          push();
        }
        log("game", "[setup] " + l);
      }
    };
    p.stdout.on("data", eat); p.stderr.on("data", eat);
    p.on("error", () => {});
    p.on("close", (code) => {
      assetProc = null;
      const good = code === 0;
      step("assets", good ? "done" : "fail");
      log("panel", good ? "game setup finished (art downloaded or already there)" : `game setup ended with code ${code} — the art download resumes next time`);
      resolve(good);
    });
  });
}
let assetProc = null;
export function stopAssets() { if (assetProc) { killTree(assetProc); log("panel", "art download stopped (it resumes next time)"); } }

function download(url, out, extra, total, [minBps, minSecs] = [1024, 25]) {
  return new Promise((resolve) => {
    const part = out + ".part";
    try { fs.rmSync(part, { force: true }); } catch {}
    const p = spawn("curl", ["-fL", "-sS", "--connect-timeout", "10", "--speed-limit", String(minBps), "--speed-time", String(minSecs),
      ...extra, "-o", part, url], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    const samples = [];
    const timer = setInterval(() => {
      try {
        const received = fs.statSync(part).size, now = Date.now();
        samples.push([now, received]); while (samples.length > 1 && now - samples[0][0] > 5000) samples.shift();
        const [t0, b0] = samples[0];
        const bps = now > t0 ? ((received - b0) * 1000) / (now - t0) : 0;
        const dl = state.update.dl;
        dl.received = state.update.received = received;
        dl.bps = bps;
        dl.eta = bps > 0 && total ? Math.max(0, Math.round((total - received) / bps)) : null;
        push();
      } catch {}
    }, 400);
    p.on("exit", (code) => {
      clearInterval(timer);
      if (code === 0) {
        try { const n = fs.statSync(part).size; Object.assign(state.update.dl, { received: n, total: n, eta: 0 }); state.update.received = state.update.total = n; } catch {}
        fs.renameSync(part, out); push(); resolve(true);
      }
      else if (code === 28) { log("panel", `attempt timed out or too slow (under ${Math.round(minBps / 1024)} KB/s for ${minSecs} s), trying the next route`); resolve(false); }
      else { log("panel", `attempt failed (curl ${code}): ${err.trim().slice(0, 200)}`); resolve(false); }
    });
  });
}
