// updater.mjs — GitHub release check (also on a timer), the plan, download (local proxy → direct → mirrors), install, and
// the art download of the lite package. Every install runs as a list of steps with live progress (state.update, "progress" events):
//   download   the release ZIP (or all update packs): bytes, speed, time left, which route
//   extract    files written / files in the ZIP
//   install    swap current/ → previous/, new copy → current/ (update packs: copy current/, apply every pack on the copy, then swap)
//   assets     lite package only: the game's own tools/setup.mjs downloads the art and audio (~460 MB, resumable)
//   start      only when the game was running before
// The release has two packages since 0.2.0: Stronghold-Protocol-<tag>.zip (full, recommended: all art, the 3D board
// and the summon models taken from the game client) and Stronghold-Protocol-<tag>-lite.zip (~22 MB, the art comes
// from public mirrors on the first start, without the client-only art). config.gamePackage picks one.
// Since 0.2.1 a release also has Stronghold-Protocol-<tag>-update.zip, the 更新包: only the files that differ from the release
// before it, with UPDATE.json ({from: [versions it applies over], removed: [...]}). config.updateMode "patch" (default) installs
// the packs of every release between the installed version and the latest, in order; "full" installs the whole package.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { config, state, log, sendState, broadcast, GAME_DIR, UPDATE_DIR } from "./core.mjs";
import { run, augmentEnv, killTree } from "./util.mjs";
import { extractZip, zipFileCount, IS_WIN } from "./platform.mjs";
import { startGame, stopGame } from "./game.mjs";
import { buildCacheManifest } from "./assetcache.mjs";
import { notify } from "./platform.mjs";

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

// ---------------------------------------------------------------------------
// releases and the plan
// ---------------------------------------------------------------------------
const verParts = (t) => (String(t || "").match(/\d+/g) || []).slice(0, 3).map(Number);
export function cmpVer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
const isNewer = (a, b) => (verParts(a).length && verParts(b).length ? cmpVer(a, b) > 0 : a !== b);

/**
 * The three ZIPs of a release: Stronghold-Protocol-<tag>.zip (full), -lite.zip, and -update.zip (the 更新包: only the files
 * that differ from the release before it). The full one is never "the first ZIP that is not lite": that would pick the update pack.
 */
function pickAssets(assets) {
  const zips = (assets || []).filter((a) => /\.zip$/i.test(a.name) && a.name.includes("Stronghold-Protocol"));
  const kind = (a) => (/-update\.zip$/i.test(a.name) ? "update" : /-lite\.zip$/i.test(a.name) ? "lite" : "full");
  const full = zips.find((a) => kind(a) === "full" && /^Stronghold-Protocol-v?\d[\d.]*\.zip$/i.test(a.name)) || zips.find((a) => kind(a) === "full") || null;
  const lite = zips.find((a) => kind(a) === "lite") || null;
  const update = zips.find((a) => kind(a) === "update") || null;
  const pack = (a) => (a ? { name: a.name, url: a.browser_download_url, size: a.size || 0 } : null);
  return { full: pack(full), lite: pack(lite), update: pack(update) };
}

/** Asset names and sizes of one release from its github.com page (no API). */
async function pageAssets(base, tag) {
  const html = await fetchText(`${base}/expanded_assets/${tag}`);
  const names = [...new Set([...String(html || "").matchAll(/\/releases\/download\/[^"]+\/([^"/]*Stronghold-Protocol[^"/]*\.zip)"/g)].map((m) => m[1]))];
  const assets = [];
  for (const name of names) {
    const url = `${base}/download/${tag}/${name}`;
    const head = await fetchText(url, [], 20, ["-I"]);
    const sizes = [...String(head || "").matchAll(/^content-length:\s*(\d+)/gim)].map((m) => Number(m[1]));
    assets.push({ name, browser_download_url: url, size: sizes.length ? sizes[sizes.length - 1] : 0 });
  }
  return pickAssets(assets);
}

/**
 * The same release data from the github.com pages. api.github.com allows 60 requests per hour per IP,
 * and shared IPs (carrier-grade NAT, proxy nodes) often use them up; the pages have no such limit.
 * The latest tag comes from the /latest redirect, the older ones (the update packs in between) from the Atom feed.
 */
async function releasesFromPages() {
  const base = `https://github.com/${config.repo}/releases`;
  const final = await fetchText(`${base}/latest`, [], 20, ["-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{url_effective}"]);
  const latest = ((final || "").match(/\/releases\/tag\/([^/?#\s]+)/) || [])[1];
  if (!latest) return [];
  log("panel", `GitHub API not available (rate limit?), using the release pages: ${latest}`);
  const atom = await fetchText(`${base}.atom`);
  const tags = new Set([latest]);
  for (const m of String(atom || "").matchAll(/\/releases\/tag\/([^"<\s]+)/g)) tags.add(decodeURIComponent(m[1]));
  const cur = state.version;
  let list = [...tags].filter((t) => verParts(t).length).sort((a, b) => cmpVer(b, a));
  if (cur) list = list.filter((t) => cmpVer(t, cur) >= 0);
  const out = [];
  for (const tag of list.slice(0, 10)) out.push({ tag, assets: cur && cmpVer(tag, cur) === 0 && tag !== latest ? {} : await pageAssets(base, tag) });
  return out;
}

/** Recent published releases, newest first: [{ tag, assets: { full, lite, update } }]. One API request; the pages when the API fails. */
async function fetchReleases() {
  const raw = await fetchText(`https://api.github.com/repos/${config.repo}/releases?per_page=30`);
  let list = null; try { list = raw && JSON.parse(raw); } catch {}
  let rels = Array.isArray(list)
    ? list.filter((r) => r && r.tag_name && !r.draft && !r.prerelease).map((r) => ({ tag: r.tag_name, assets: pickAssets(r.assets) }))
    : [];
  if (!rels.length) rels = await releasesFromPages();
  return rels.sort((a, b) => cmpVer(b.tag, a.tag));
}

let RELEASES = [];

function zipPlan(latest, why) {
  const a = latest.assets || {}, want = wantPackage();
  const pick = a[want] || a.full || a.lite || null;
  if (!pick) return null;
  const pkg = pick === a.lite ? "lite" : "full";
  return { kind: pkg, pkg, tag: latest.tag, steps: [{ tag: latest.tag, name: pick.name, url: pick.url, size: pick.size }], bytes: pick.size, fullBytes: pick.size, why };
}

/**
 * What 下载并安装 does:
 *   patch  one 更新包 per release between the installed version and the latest, applied in order (default; needs an unbroken chain)
 *   full / lite  one whole package: nothing installed yet, the package was switched, updateMode is "full", the chain has a gap
 *          (a release without an update pack, or the installed version is not a published release), or the packs add up to more
 *          than the full package. `why` tells the panel which one it was.
 * opts.zip forces the whole package for this run (the 改用完整包 button).
 */
export function computePlan(opts = {}) {
  const latest = RELEASES[0];
  if (!latest) return null;
  const cur = state.version, want = wantPackage();
  if (!cur) return zipPlan(latest, "fresh");
  if (!isNewer(latest.tag, cur)) return state.installedPackage && state.installedPackage !== want ? zipPlan(latest, "switch") : null;
  if (opts.zip) return zipPlan(latest, "choice");
  if (config.updateMode === "full") return zipPlan(latest, "mode");
  if (state.installedPackage && state.installedPackage !== want) return zipPlan(latest, "switch");
  const asc = RELEASES.slice().reverse();
  const i = asc.findIndex((r) => cmpVer(r.tag, cur) === 0);
  const chain = i < 0 ? [] : asc.slice(i + 1);
  if (!chain.length || !chain.every((r) => r.assets && r.assets.update)) return zipPlan(latest, "gap");
  const steps = chain.map((r) => ({ tag: r.tag, name: r.assets.update.name, url: r.assets.update.url, size: r.assets.update.size }));
  const bytes = steps.reduce((n, s) => n + (s.size || 0), 0);
  const whole = zipPlan(latest, "");
  const pkg = state.installedPackage || want;
  if (pkg !== "lite" && whole && whole.bytes && bytes > whole.bytes * 0.9) return { ...whole, why: "big", patchBytes: bytes, patchCount: steps.length };
  return { kind: "patch", pkg, tag: latest.tag, steps, bytes, fullBytes: whole ? whole.bytes : 0, why: "" };
}
/** The plan without download URLs, for the panel UI. */
export const planInfo = () => {
  const p = state.plan;
  return p ? { kind: p.kind, pkg: p.pkg, why: p.why, tag: p.tag, tags: p.steps.map((s) => s.tag), count: p.steps.length, bytes: p.bytes, fullBytes: p.fullBytes, patchBytes: p.patchBytes || 0, patchCount: p.patchCount || 0 } : null;
};

let checking = false;
export async function checkUpdate(opts = {}) {
  if (checking) return;
  checking = true;
  state.autoCheck.tried = Date.now();
  try {
    log("panel", "checking GitHub for the latest release...");
    readVersion();
    const rels = await fetchReleases();
    if (!rels.length) return log("panel", "cannot reach GitHub — check your network or proxy app");
    RELEASES = rels;
    state.autoCheck.last = Date.now();
    state.latestVersion = rels[0].tag || null;
    state.latestAssets = rels[0].assets;
    choosePackage();
    const p = state.plan;
    log("panel", `installed ${state.version || "none"}${state.installedPackage ? ` (${state.installedPackage})` : ""} · latest ${state.latestVersion}` +
      `${updateAvailable() ? ` — update available: ${p ? (p.kind === "patch" ? `${p.steps.length} update pack${p.steps.length > 1 ? "s" : ""}` : `${p.kind} package`) + `, ${(p.bytes / 1048576).toFixed(0)} MB` : ""}` : packageSwitch() ? ` — ${wantPackage()} package available` : ""}`);
    if (opts.auto) notifyNew();
    sendState();
  } finally { checking = false; }
}
/** plan + latest* fields follow the settings (updateMode, gamePackage) and the installed version. */
export function choosePackage() {
  readVersion();
  const p = state.plan = computePlan();
  state.latestPackage = p ? p.pkg : null;
  state.latestZipUrl = p ? p.steps[0].url : null;
  state.latestSize = p ? p.bytes : 0;
}
export const updateAvailable = () => !!(state.latestVersion && state.latestZipUrl && state.version && isNewer(state.latestVersion, state.version));
/** Same version installed, but as the other package (e.g. lite installed, full chosen in the settings). */
export const packageSwitch = () => !!(state.version && state.latestVersion === state.version && state.latestZipUrl &&
  state.installedPackage && state.latestPackage && state.installedPackage !== state.latestPackage);

// ---------------------------------------------------------------------------
// automatic check: every config.autoCheckMin minutes (0 = off). It only checks and tells the host, it never installs.
// ---------------------------------------------------------------------------
let autoTimer = null, notifiedTag = null;
export function scheduleAutoCheck() {
  clearTimeout(autoTimer); autoTimer = null;
  const min = Number(config.autoCheckMin) || 0;
  state.autoCheck.min = min;
  if (min <= 0) { state.autoCheck.next = null; return sendState(); }
  const every = Math.max(3000, min * 60000);
  const due = Math.max(Date.now() + 1000, (state.autoCheck.tried || Date.now()) + every);
  state.autoCheck.next = due;
  autoTimer = setTimeout(async () => {
    if (busy() || checking) { state.autoCheck.tried = Date.now() - every + 60000; return scheduleAutoCheck(); }   // try again in a minute
    await checkUpdate({ auto: true });
    scheduleAutoCheck();
  }, due - Date.now());
  sendState();
}
/** Desktop notification, once per new version, when the automatic check finds one. */
function notifyNew() {
  if (!updateAvailable() || notifiedTag === state.latestVersion) return;
  notifiedTag = state.latestVersion;
  const p = state.plan, en = config.lang === "en", mb = p ? Math.max(1, Math.round(p.bytes / 1048576)) : 0;
  const what = !p ? "" : p.kind === "patch" ? (en ? `${p.steps.length} update pack${p.steps.length > 1 ? "s" : ""}, ${mb} MB` : `更新包 ${p.steps.length} 个，约 ${mb} MB`)
    : (en ? `${p.kind} package, ${mb} MB` : `${p.kind === "lite" ? "精简包" : "完整包"}，约 ${mb} MB`);
  if (en) notify(`Stronghold Protocol ${state.latestVersion} is out`, `Installed ${state.version}. ${what}. Open the panel and click 下载并安装.`);
  else notify(`卫戍协议 ${state.latestVersion} 已发布`, `当前 ${state.version}。${what}。打开面板点「下载并安装」。`);
  log("panel", `auto check: new version ${state.latestVersion} (${what})`);
}

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

/** One download of a file over the routes (local proxy, direct, mirrors); the route that worked last goes first. */
let goodRoute = null;
async function fetchWithRoutes(url, out, size) {
  const routes = [
    ...(await proxyCandidates()).map((px) => [`proxy ${px}`, ["-x", px], url]),
    ["direct", [], url],
    ...(config.ghMirrors || []).map((m) => [`mirror ${m}`, [], m + url]),
  ];
  const i0 = goodRoute ? routes.findIndex((r) => r[0] === goodRoute) : -1;
  if (i0 > 0) routes.unshift(...routes.splice(i0, 1));
  for (const [i, [label, extra, target]] of routes.entries()) {
    // every route but the last must keep 100 KB/s over 20 s; the last one only has to keep moving
    const floor = i < routes.length - 1 ? [102400, 20] : [1024, 25];
    state.update.dl.route = state.update.route = label;
    log("panel", `download attempt: ${label}`);
    if (await download(target, out, extra, size, floor)) { goodRoute = label; return true; }
  }
  return false;
}

/** Download + install what the plan says: update packs in order, or one whole package. opts.full forces the whole package. */
export async function applyUpdate(opts = {}) {
  if (busy()) return;
  const plan = opts.full ? computePlan({ zip: true }) : state.plan;
  if (!plan) return;
  return plan.kind === "patch" ? runPatch(plan) : runZip(plan);
}

/** After the files are in place: art (lite), cache list, start again. */
async function finishInstall(pkg, wasRunning) {
  if (pkg === "lite") await assetsStep();
  buildCacheManifest("new game version");
  checkAssets();
  if (wasRunning) {
    step("start", "run");
    await startGame();
    step("start", state.game === "running" ? "done" : "fail");
  }
  choosePackage();
  finish(true);
}

/** One whole package (full or lite): download, extract, swap current/ and previous/. */
async function runZip(plan, extra = {}) {
  const tag = plan.tag, { url, size } = plan.steps[0], pkg = plan.pkg;
  const wasRunning = state.game === "running";
  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, path.basename(new URL(url).pathname) || `Stronghold-Protocol-${tag}.zip`);
  begin("install", tag, pkg, size, [...(pkg === "lite" ? [] : ["assets"]), ...(wasRunning ? [] : ["start"])]);
  Object.assign(state.update, extra);
  log("panel", `installing ${tag} (${pkg} package, ${(size / 1048576).toFixed(0)} MB)`);

  // 1. download
  step("download", "run");
  if (!(await fetchWithRoutes(url, zipPath, size))) {
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
  await finishInstall(pkg, wasRunning);
}

// ---------------------------------------------------------------------------
// update packs (更新包)
// ---------------------------------------------------------------------------
/** `fallback`: the packs do not fit this folder, so the panel installs the whole package instead. */
class PatchError extends Error { constructor(code, msg, fallback = true) { super(msg); this.code = code; this.fallback = fallback; } }

const countTree = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).length; } catch { return 0; } };
/** fs.cp with a counter. Symlinks stay as they are, and a copy-on-write clone is used where the disk can do it. */
const copyTree = (src, dst, onEntry) => fs.promises.cp(src, dst, {
  recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE,
  filter: () => { onEntry(); return true; },
});
const freeBytes = (p) => { try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } };

/** The game's own boot step, run on the staged folder: it checks every file against MANIFEST.json and deletes the files this version dropped. */
function gameApply(root) {
  return new Promise((resolve) => {
    const code = 'import{pathToFileURL}from"node:url";import path from"node:path";' +
      'const m=await import(pathToFileURL(path.join(process.argv[1],"server","update.js")).href);' +
      'console.log("@@RESULT "+JSON.stringify(m.applyPendingUpdate(process.argv[1])));';
    if (!fs.existsSync(path.join(root, "server", "update.js"))) return resolve({ state: "error", error: "server/update.js is missing, so the game cannot check the files" });
    let p;
    try { p = spawn(process.execPath, ["--input-type=module", "-e", code, root], { cwd: root, env: augmentEnv({ NO_COLOR: "1" }), stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (e) { return resolve({ state: "error", error: e.message }); }
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => killTree(p), 180000);
    p.on("error", () => { clearTimeout(timer); resolve({ state: "error", error: "cannot start node" }); });
    p.on("close", () => {
      clearTimeout(timer);
      let res = null;
      for (const l of out.split(/\r?\n/)) {
        if (l.startsWith("@@RESULT ")) { try { res = JSON.parse(l.slice(9)); } catch {} }
        else if (l.trim()) log("game", "[update] " + l.trim());
      }
      if (err.trim()) log("game", "[update] " + err.trim().slice(0, 300));
      resolve(res || { state: "error", error: err.trim().split(/\r?\n/).filter(Boolean).pop()?.slice(0, 200) || "no result" });
    });
  });
}

/**
 * Apply the update packs of the plan one after the other (0.2.0 → 0.2.1 → 0.2.2 …) on a copy of the installed folder.
 * Each pack: check that it was made for the version before it, extract it over the copy, then let the game's own boot step
 * (server/update.js) verify the result against MANIFEST.json and delete the dropped files. Only when every pack went through,
 * the game stops, current/ goes to previous/ and the copy becomes current/. A pack that does not fit leaves current/ untouched
 * and the panel installs the whole package instead.
 */
async function runPatch(plan) {
  const steps = plan.steps, tag = plan.tag, pkg = plan.pkg, n = steps.length;
  const wasRunning = state.game === "running";
  const dir = UPDATE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const total = steps.reduce((a, s) => a + (s.size || 0), 0);
  begin("patch", tag, pkg, total, [...(pkg === "lite" ? [] : ["assets"]), ...(wasRunning ? [] : ["start"])]);
  Object.assign(state.update, { multi: true, dlBase: 0, cur: 0, n, chain: steps.map((s) => ({ tag: s.tag, size: s.size })) });
  log("panel", `updating ${state.version} → ${tag} with ${n} update pack${n > 1 ? "s" : ""}: ${steps.map((s) => s.tag).join(" → ")} (${(total / 1048576).toFixed(0)} MB)`);
  const cur = GAME_DIR(), prev = cur.replace(/current$/, "previous"), stage = path.join(dir, "stage");
  const zips = steps.map((s) => path.join(dir, s.name)), tmps = steps.map((s) => path.join(dir, `extract-${s.tag}`));
  const cleanup = () => { for (const f of [stage, ...tmps]) fs.rmSync(f, { recursive: true, force: true }); for (const z of zips) fs.rmSync(z, { force: true }); };
  let at = "download", swapped = false;
  try {
    const need = (pkg === "lite" ? 150 : 750) * 1048576 + total * 2.5;
    if (freeBytes(dir) < need) throw new PatchError("space", `not enough free disk space (about ${(need / 1048576).toFixed(0)} MB needed)`, false);

    // 1. download every pack
    step("download", "run");
    for (const [i, s] of steps.entries()) {
      Object.assign(state.update, { cur: i + 1, curTag: s.tag });
      if (!(await fetchWithRoutes(s.url, zips[i], s.size))) {
        log("panel", "download failed on every route — make sure that your proxy app is on and its proxy group is not set to DIRECT");
        throw new PatchError("download", "download failed", false);
      }
      state.update.dlBase += fs.statSync(zips[i]).size;
    }
    Object.assign(state.update.dl, { received: state.update.dlBase, total: state.update.dlBase, eta: 0, bps: 0 });
    step("download", "done");

    // 2. extract every pack (the game keeps running)
    at = "extract"; step("extract", "run");
    state.update.ex = { files: 0, total: zips.reduce((a, z) => a + zipFileCount(z), 0) };
    for (const [i, z] of zips.entries()) {
      fs.rmSync(tmps[i], { recursive: true, force: true }); fs.mkdirSync(tmps[i], { recursive: true });
      if (!(await extractZip(z, tmps[i], () => { state.update.ex.files++; push(); })))
        throw new PatchError("extract", "could not extract the ZIP — corrupt download, or no unzip tool (Linux: install unzip)", false);
    }
    state.update.ex.files = Math.max(state.update.ex.files, state.update.ex.total);
    step("extract", "done");

    // 3. apply, on a copy
    at = "install"; step("install", "run");
    state.update.ip = { phase: "copy", i: 0, n, files: 0, total: countTree(cur) };
    fs.rmSync(stage, { recursive: true, force: true });
    await copyTree(cur, stage, () => { state.update.ip.files++; push(); });
    let base = state.version;
    for (const [i, s] of steps.entries()) {
      const ents = fs.readdirSync(tmps[i]).map((x) => path.join(tmps[i], x));
      const inner = ents.length === 1 && fs.statSync(ents[0]).isDirectory() ? ents[0] : tmps[i];
      let up;
      try { up = JSON.parse(fs.readFileSync(path.join(inner, "UPDATE.json"), "utf8")); }
      catch { throw new PatchError("format", `${s.name} has no readable UPDATE.json`); }
      const from = (Array.isArray(up.from) ? up.from : []).map((v) => String(v).replace(/^v/i, ""));
      if (!from.includes(String(base).replace(/^v/i, "")))
        throw new PatchError("base", `${s.name} is made for ${from.map((v) => "v" + v).join(", ") || "?"}, the folder has ${base}`);
      state.update.ip = { phase: "apply", i: i + 1, n, tag: s.tag, files: 0, total: countTree(inner) };
      await copyTree(inner, stage, () => { state.update.ip.files++; push(); });
      state.update.ip = { phase: "verify", i: i + 1, n, tag: s.tag };
      push(true);
      log("panel", `update pack ${i + 1}/${n} (${s.tag}) extracted, the game checks the files...`);
      const r = await gameApply(stage);
      if (r.state !== "applied") {
        const names = (a) => (Array.isArray(a) ? a : []).slice(0, 3).join(", ");
        const why = r.reason || r.error || (r.missing && r.missing.length ? `${r.missing.length} files missing: ${names(r.missing)}` : "") || (r.mismatched && r.mismatched.length ? `${r.mismatched.length} files differ: ${names(r.mismatched)}` : "") || r.state;
        throw new PatchError("verify", `${s.name}: the game's check says ${r.state} (${why})`);
      }
      for (const note of r.notes || []) log("panel", `update pack note: ${note}`);
      log("panel", `update pack ${i + 1}/${n} applied: ${s.tag}${r.removed ? ` (${r.removed.length || r.removed} old files removed)` : ""}`);
      base = s.tag;
      fs.rmSync(tmps[i], { recursive: true, force: true }); fs.rmSync(zips[i], { force: true });
    }

    // 4. swap: players see the hub's offline page (and any announcement) for a moment
    state.update.ip = { phase: "swap", i: n, n };
    if (wasRunning) { log("panel", "stopping game for install..."); await stopGame(); }
    fs.rmSync(prev, { recursive: true, force: true });
    fs.renameSync(cur, prev); swapped = true;
    fs.renameSync(stage, cur);
    swapped = false;
    fs.writeFileSync(VERSION_FILE(), tag + "\n");
    fs.writeFileSync(PACKAGE_FILE(), pkg + "\n");
    try { fs.chmodSync(path.join(cur, "scripts", "start.sh"), 0o755); } catch {}
    cleanup();
    readVersion();
    step("install", "done");
    log("panel", `installed ${tag} from ${n} update pack${n > 1 ? "s" : ""} (${pkg}; old version kept in ${path.basename(prev)}/)`);
  } catch (e) {
    const err = e instanceof PatchError ? e : new PatchError("install", e && e.message || String(e), false);
    if (swapped) { try { fs.rmSync(cur, { recursive: true, force: true }); fs.renameSync(prev, cur); } catch {} }
    cleanup();
    log("panel", `update packs: ${err.message}`);
    if (wasRunning && state.game !== "running") startGame();
    if (err.fallback) {
      const whole = computePlan({ zip: true });
      if (whole) {
        log("panel", "the update packs do not fit this folder — installing the whole package instead (current/ was not changed)");
        return runZip(whole, { fellBack: err.code });
      }
    }
    step(at, "fail"); finish(false, err.code);
    return;
  }
  await finishInstall(pkg, wasRunning);
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
        const dl = state.update.dl, base = state.update.dlBase || 0;
        dl.received = state.update.received = base + received;
        dl.bps = bps;
        dl.eta = bps > 0 && dl.total ? Math.max(0, Math.round((dl.total - dl.received) / bps)) : null;
        push();
      } catch {}
    }, 400);
    p.on("exit", (code) => {
      clearInterval(timer);
      if (code === 0) {
        try {
          const n = fs.statSync(part).size, base = state.update.dlBase || 0;
          if (state.update.multi) Object.assign(state.update.dl, { received: base + n, eta: 0 });
          else { Object.assign(state.update.dl, { received: n, total: n, eta: 0 }); state.update.total = n; }
          state.update.received = base + n;
        } catch {}
        fs.renameSync(part, out); push(); resolve(true);
      }
      else if (code === 28) { log("panel", `attempt timed out or too slow (under ${Math.round(minBps / 1024)} KB/s for ${minSecs} s), trying the next route`); resolve(false); }
      else { log("panel", `attempt failed (curl ${code}): ${err.trim().slice(0, 200)}`); resolve(false); }
    });
  });
}
