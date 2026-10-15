// mods.mjs — the dancing mod (cyanfish.dj-all) from the CyanFish mod pack, as a separate copy of the game.
//
// The mod pack (github.com/CyanF1sh/Stronghold-Protocol-CyanModPack) is a platform overlay (105 files) plus mods. The mod
// loader is in the overlay, and the loader needs the exact game version of the pack (VERSION file, "0.2.6").
// The panel never changes the vanilla game in current/. It builds a second tree, <gameRoot>/modded/:
//   1. copy current/ to modded.new/
//   2. run the pack's own tools/apply-overlay.mjs on the copy (its checks and backup stay in use)
//   3. copy only cyanfish.dj-all and cyanfish.mod-settings (the settings shell that holds the mod's page) into mods/
//   4. run the pack's tools/mod.mjs validate, then swap modded.new/ to modded/
// config.launchProfile "modded" starts the game from modded/ with SP_MODS set. "vanilla" starts current/ as before.
// When the game updates, the panel rebuilds modded/ for the new version if the pack supports it.
import fs from "node:fs";
import path from "node:path";
import { config, state, log, sendState, GAME_DIR, MOD_DIR, expand, saveConfig } from "./core.mjs";
import { run, augmentEnv } from "./util.mjs";
import { extractZip, notify, IS_WIN } from "./platform.mjs";
import { fetchText, fetchWithRoutes } from "./updater.mjs";
import { startGame, stopGame } from "./game.mjs";
import { buildCacheManifest } from "./assetcache.mjs";

export const MOD_IDS = ["cyanfish.dj-all", "cyanfish.mod-settings"];
const ROOT = () => path.join(expand(config.gameRoot), "modpack");
const META = () => path.join(MOD_DIR(), ".panel-mod.json");
const STEPS = ["download", "extract", "copy", "overlay", "check", "swap"];

state.mods = state.mods || { run: null, remote: null, checkedAt: null, notified: null };

// ---------------------------------------------------------------------------
// what is installed, what exists
// ---------------------------------------------------------------------------
function readMeta() { try { return JSON.parse(fs.readFileSync(META(), "utf8")); } catch { return null; } }
let baseCache = { at: 0, v: null };
/** The version in the package.json of the vanilla game (the pack compares exactly this). */
function baseVersion() {
  if (Date.now() - baseCache.at < 3000) return baseCache.v;
  let v = null;
  try { v = JSON.parse(fs.readFileSync(path.join(GAME_DIR(), "package.json"), "utf8")).version || null; } catch {}
  baseCache = { at: Date.now(), v };
  return v;
}

export function modsInfo() {
  const rec = readMeta(), base = baseVersion(), r = state.mods.remote;
  const live = state.game === "running" || state.game === "starting";
  return {
    installed: rec ? { tag: rec.packTag, game: rec.gameVersion, at: rec.at } : null,
    base, profile: config.launchProfile,
    running: live ? state.runningProfile : null,
    stale: !!(rec && rec.gameVersion !== base),
    remote: r ? { tag: r.tag, game: r.game } : null,
    canBuild: !!(r && base && r.game === base),
    newer: !!(rec && r && r.tag !== rec.packTag && r.game === base),
    lagging: !!(r && base && r.game !== base),
    run: state.mods.run, checkedAt: state.mods.checkedAt,
  };
}

/** True when the modded copy exists and was built from the game version in current/. */
export function moddedReady() {
  const rec = readMeta();
  return !!(rec && fs.existsSync(path.join(MOD_DIR(), "server")) && rec.gameVersion === baseVersion());
}

/** The latest release of the pack: { tag, game, url }. API first, release page second. */
async function latestPack() {
  const repo = config.modRepo;
  let tag = null;
  const raw = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
  try { tag = JSON.parse(raw).tag_name || null; } catch {}
  if (!tag) {
    const final = await fetchText(`https://github.com/${repo}/releases/latest`, [], 20, ["-o", IS_WIN ? "NUL" : "/dev/null", "-w", "%{url_effective}"]);
    tag = ((final || "").match(/\/releases\/tag\/([^/?#\s]+)/) || [])[1] || null;
  }
  if (!tag) return null;
  const ver = String((await fetchText(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/VERSION`)) || "").trim().split(/\s+/)[0];
  const game = /^\d+\.\d+\.\d+/.test(ver) ? ver : (tag.match(/\d+\.\d+\.\d+/) || [])[0] || null;
  return { tag, game, url: `https://github.com/${repo}/archive/refs/tags/${encodeURIComponent(tag)}.zip` };
}

let checking = false;
export async function checkMods(opts = {}) {
  if (checking) return;
  checking = true;
  try {
    const r = await latestPack();
    if (!r) { if (!opts.auto) log("panel", "mod pack: cannot reach GitHub"); return; }
    state.mods.remote = r; state.mods.checkedAt = Date.now();
    const info = modsInfo();
    log("panel", `mod pack ${r.tag} (for game ${r.game || "?"}); game ${info.base || "none"}; ${info.installed ? `built ${info.installed.tag}` : "not built"}`);
    if (opts.auto && info.installed && (info.newer || (info.stale && info.canBuild)) && state.mods.notified !== r.tag) {
      state.mods.notified = r.tag;
      const en = config.lang === "en";
      notify(en ? "Dancing mod update" : "整活 Mod 有新版本", en ? `Mod pack ${r.tag} is out. Open the panel and update it.` : `Mod 包 ${r.tag} 已发布，打开面板更新。`);
    }
    sendState();
  } finally { checking = false; }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------
function begin() {
  state.modBusy = true;
  state.mods.run = {
    phase: "running", error: "", startedAt: Date.now(),
    steps: STEPS.map((id) => ({ id, status: "wait" })),
    dl: { received: 0, total: 0, bps: 0, eta: null, route: "" }, received: 0, total: 0, route: "",
    cp: { files: 0, total: 0 },
  };
  sendState();
}
function step(id, status, detail) {
  const s = state.mods.run.steps.find((x) => x.id === id);
  if (!s) return;
  s.status = status; if (detail !== undefined) s.detail = detail;
  sendState();
}
function end(ok, error = "") {
  const r = state.mods.run;
  r.phase = ok ? "done" : "error"; r.error = error; r.endedAt = Date.now();
  for (const s of r.steps) if (s.status === "run") s.status = ok ? "done" : "fail";
  state.modBusy = false;
  sendState();
}
class BuildError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const countTree = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).length; } catch { return 0; } };
const copyTree = (src, dst, onEntry) => fs.promises.cp(src, dst, {
  recursive: true, force: true, verbatimSymlinks: true, preserveTimestamps: true, mode: fs.constants.COPYFILE_FICLONE,
  filter: () => { onEntry(); return true; },
});
const node = (args, cwd) => run(process.execPath, args, { cwd, env: augmentEnv({ NO_COLOR: "1" }) });

/** Build modded/ from current/ and the pack release `r`. Throws BuildError. */
async function buildFrom(r) {
  const root = ROOT(), base = baseVersion();
  const zip = path.join(root, "pack.zip"), ex = path.join(root, "src"), fresh = MOD_DIR() + ".new", back = path.join(root, "backup");
  const clean = () => { for (const p of [ex, fresh, back]) fs.rmSync(p, { recursive: true, force: true }); fs.rmSync(zip, { force: true }); };
  clean(); fs.mkdirSync(root, { recursive: true });
  try {
    step("download", "run", r.tag);
    if (!(await fetchWithRoutes(r.url, zip, 0, state.mods.run))) throw new BuildError("download", "download failed on every route");
    step("download", "done");

    step("extract", "run");
    fs.mkdirSync(ex, { recursive: true });
    if (!(await extractZip(zip, ex))) throw new BuildError("extract", "could not extract the ZIP");
    const ents = fs.readdirSync(ex).map((n) => path.join(ex, n));
    const src = ents.length === 1 && fs.statSync(ents[0]).isDirectory() ? ents[0] : ex;
    for (const f of ["tools/apply-overlay.mjs", "overlay/tools/mod.mjs", "overlay/MANIFEST.sha256", "overlay/ORIGIN.sha256", ...MOD_IDS.map((m) => `mods/${m}/mod.json`)])
      if (!fs.existsSync(path.join(src, f))) throw new BuildError("format", `the pack has no ${f}`);
    let packGame = ""; try { packGame = fs.readFileSync(path.join(src, "VERSION"), "utf8").trim().split(/\s+/)[0]; } catch {}
    if (packGame !== base) throw new BuildError("version", `the pack is for game ${packGame || "?"}, the game is ${base}`);
    step("extract", "done");

    step("copy", "run");
    state.mods.run.cp = { files: 0, total: countTree(GAME_DIR()) };
    await copyTree(GAME_DIR(), fresh, () => { state.mods.run.cp.files++; if (!(state.mods.run.cp.files % 400)) sendState(); });
    step("copy", "done");

    step("overlay", "run");
    const tool = path.join(src, "tools", "apply-overlay.mjs"), jf = path.join(root, "dry.json");
    await node([tool, "--target", fresh, "--dry-run", "--json", jf], src);
    let dry; try { dry = JSON.parse(fs.readFileSync(jf, "utf8")); } catch { throw new BuildError("overlay", "the pack's installer gave no report"); }
    fs.rmSync(jf, { force: true });
    if (dry.corrupt && dry.corrupt.length) throw new BuildError("overlay", "the pack download is damaged");
    const conflicts = (dry.plan && dry.plan.conflict) || [];
    // The release package has no test/ and some docs/ files that the pack lists. Those are not needed to run the game.
    const benign = conflicts.every((c) => c.now === "ABSENT" && /^(docs|test)\//.test(c.rel));
    if (conflicts.length && !benign) throw new BuildError("overlay", `${conflicts.length} game files differ from the official version (${conflicts.slice(0, 3).map((c) => c.rel).join(", ")})`);
    const ap = await node([tool, "--target", fresh, ...(conflicts.length ? ["--force"] : []), "--backup", back], src);
    if (!ap.ok || !/RESULT: OK/.test(ap.stdout)) throw new BuildError("overlay", "the pack's installer failed: " + (ap.stdout.trim().split("\n").pop() || ap.stderr.trim().split("\n").pop() || ""));
    step("overlay", "done");

    step("check", "run");
    for (const id of MOD_IDS) await fs.promises.cp(path.join(src, "mods", id), path.join(fresh, "mods", id), { recursive: true });
    const v = await node([path.join(fresh, "tools", "mod.mjs"), "validate"], fresh);
    if (!v.ok) throw new BuildError("check", "the mod check failed: " + (v.stdout.split("\n").filter((l) => /✗|错误|error/i.test(l))[0] || "").trim());
    fs.writeFileSync(path.join(fresh, ".panel-mod.json"), JSON.stringify({ gameVersion: base, packTag: r.tag, mods: MOD_IDS, at: new Date().toISOString() }, null, 2) + "\n");
    step("check", "done");

    step("swap", "run");
    const wasLive = state.game !== "stopped" && state.game !== "error" && state.runningProfile === "modded";
    if (wasLive) await stopGame();
    fs.rmSync(MOD_DIR(), { recursive: true, force: true });
    fs.renameSync(fresh, MOD_DIR());
    try { fs.chmodSync(path.join(MOD_DIR(), "scripts", "start.sh"), 0o755); } catch {}
    clean();
    baseCache.at = 0;
    step("swap", "done");
    log("panel", `dancing mod ready: pack ${r.tag} on game ${base}`);
    if (config.launchProfile === "modded") await buildCacheManifest("mod copy");
    if (wasLive) await startGame();
  } catch (e) { clean(); throw e; }
}

/** Build or update the dancing mod. */
export async function prepareMods() {
  if (state.modBusy || state.update.phase === "running") return;
  begin();
  try {
    const r = await latestPack();
    if (!r) throw new BuildError("network", "cannot reach GitHub");
    state.mods.remote = r; state.mods.checkedAt = Date.now();
    const base = baseVersion();
    if (!base) throw new BuildError("version", "the game is not installed");
    if (r.game !== base) throw new BuildError("version", `the newest mod pack is for game ${r.game || "?"}, the game is ${base}`);
    await buildFrom(r);
    end(true);
  } catch (e) {
    const code = e instanceof BuildError ? e.code : "build";
    log("panel", `dancing mod: ${e.message}`);
    const run = state.mods.run; const cur = run && run.steps.find((s) => s.status === "run");
    if (cur) cur.status = "fail";
    end(false, code);
  }
}

/** After a game update: build modded/ again for the new version, or fall back to the vanilla game. */
export async function refreshAfterGameUpdate() {
  const rec = readMeta();
  if (!rec) return;
  baseCache.at = 0;
  const base = baseVersion();
  if (rec.gameVersion === base) return;
  begin();
  try {
    const r = await latestPack();
    state.mods.remote = r || state.mods.remote;
    if (!r || r.game !== base) throw new BuildError("version", `no mod pack for game ${base} yet (newest: ${r ? r.game : "?"})`);
    await buildFrom(r);
    end(true);
  } catch (e) {
    log("panel", `dancing mod: ${e.message}; the game starts without it`);
    if (config.launchProfile === "modded") saveConfig({ launchProfile: "vanilla" });
    const run = state.mods.run; const cur = run && run.steps.find((s) => s.status === "run");
    if (cur) cur.status = "fail";
    end(false, e instanceof BuildError ? e.code : "build");
  }
}

export async function removeMods() {
  if (state.modBusy) return;
  const wasLive = state.game !== "stopped" && state.game !== "error" && state.runningProfile === "modded";
  saveConfig({ launchProfile: "vanilla" });
  if (wasLive) await stopGame();
  fs.rmSync(MOD_DIR(), { recursive: true, force: true });
  fs.rmSync(ROOT(), { recursive: true, force: true });
  state.mods.run = null; baseCache.at = 0;
  log("panel", "dancing mod removed (the vanilla game was not touched)");
  await buildCacheManifest("mod copy removed");
  if (wasLive) await startGame();
  sendState();
}

export function setProfile(p) {
  const want = p === "modded" ? "modded" : "vanilla";
  if (want === "modded" && !moddedReady()) return log("panel", "the dancing mod is not ready for this game version");
  saveConfig({ launchProfile: want });
  log("panel", `launch with: ${want === "modded" ? "dancing mod" : "vanilla game"}${state.game === "running" ? " (restart the game to apply)" : ""}`);
  buildCacheManifest("launch profile");
  sendState();
}
