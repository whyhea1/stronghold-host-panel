#!/usr/bin/env node
// Stronghold Host Panel — entry point. No npm dependencies; Node 18+.
// Run: node server.mjs   (or double-click Start-Stronghold-Panel.command on macOS / .bat on Windows)
//
//   lib/core.mjs     config, shared state, log bus
//   lib/util.mjs     process / network helpers
//   lib/hub.mjs      public port 3000: 中转站, offline page, proxy to game, bandwidth
//   lib/game.mjs     game lifecycle, health, lobby tracker
//   lib/tunnel.mjs   SakuraFrp frpc
//   lib/updater.mjs  GitHub release update
//   lib/sakura.mjs   SakuraFrp account / node / 签到
//   lib/sysstats.mjs CPU / memory / disk / process load for the panel
//   lib/assetcache.mjs  file list behind the players' browser cache (web/hub/cache.js)
//   lib/api.mjs      host panel on 127.0.0.1:3100
//   web/             panel UI (index.html, app.css, app.js) and hub pages (web/hub/)
import { openTarget, OS_NAME } from "./lib/platform.mjs";
import { config, procs, log } from "./lib/core.mjs";
import { killTree } from "./lib/util.mjs";
import { startHub, stopHub } from "./lib/hub.mjs";
import { checkUpdate, checkAssets, scheduleAutoCheck } from "./lib/updater.mjs";
import { startSysStats } from "./lib/sysstats.mjs";
import { buildCacheManifest } from "./lib/assetcache.mjs";
import { startSakuraPolling } from "./lib/sakura.mjs";
import { startPanel } from "./lib/api.mjs";
import { saveUsage } from "./lib/usage.mjs";

startHub();
startSakuraPolling();
startSysStats();
buildCacheManifest("panel start").then(() => checkAssets());
startPanel(() => {
  const url = `http://localhost:${config.panelPort}`;
  log("panel", `panel ready on ${OS_NAME} — ${url}`);
  checkUpdate().catch(() => {}).then(() => scheduleAutoCheck());
  if (!process.env.NO_OPEN) openTarget(url);
});

function shutdown() {
  log("panel", "panel shutting down — stopping managed processes");
  for (const k of ["frpc", "game", "caffeinate"]) killTree(procs[k]);
  stopHub();
  saveUsage();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGHUP", shutdown);   // Terminal / console window closed (also fires on Windows)
