// api.mjs — the host-only control panel (127.0.0.1:panelPort): UI, SSE, actions.
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, state, log, sendState, publicState, setStateBuilder, saveConfig, sseClients, backlog, WEB_DIR, GAME_DIR, EDITABLE_KEYS } from "./core.mjs";
import { lanAddresses } from "./util.mjs";
import { startGame, stopGame, restartGame, gamePort } from "./game.mjs";
import { startTunnel, stopTunnel } from "./tunnel.mjs";
import { checkUpdate, applyUpdate, updateAvailable } from "./updater.mjs";
import { setNotice, sendFile, sendJson, serveFont } from "./hub.mjs";
import { clearAutoNotice, sendUsageNotice, recheckUsage } from "./usage.mjs";
import { sakuraToken, pollSakura } from "./sakura.mjs";

setStateBuilder(() => {
  const pub = (config.publicUrl || "").replace(/\/+$/, "");
  const cfg = Object.fromEntries(EDITABLE_KEYS.filter((k) => k !== "sakuraToken").map((k) => [k, config[k]]));
  return {
    game: state.game, tunnel: state.tunnel, hub: state.hub,
    port: config.port, gamePort: gamePort(), panelPort: config.panelPort,
    publicUrl: pub, hubUrl: pub ? pub + "/" : "", playUrl: pub ? pub + "/play" : "",
    lan: lanAddresses(config.port),
    version: state.version, latestVersion: state.latestVersion, updateAvailable: updateAvailable(),
    latestSize: state.latestSize, update: state.update,
    health: state.health, rooms: Object.values(state.rooms), activity: state.activity.slice(-15).reverse(),
    connections: state.connections, bw: { ...state.bw, limitMbps: config.speedLimitMbps },
    notice: state.notice, autoNotice: state.autoNotice, usage: state.usage, sakura: state.sakura,
    config: { ...cfg, hasToken: !!sakuraToken(), tokenFromIni: !config.sakuraToken && !!sakuraToken() },
  };
});

const open = (target) => spawn("open", [target], { stdio: "ignore" }).on("error", () => {});

const ACTIONS = {
  startGame, stopGame, restartGame, startTunnel, stopTunnel,
  startSession: async () => { await Promise.all([startGame(), startTunnel()]); },
  stopAll: async () => { await Promise.all([stopTunnel(), stopGame()]); },
  checkUpdate, applyUpdate,
  saveConfig: (a) => { saveConfig(a.config || {}); log("panel", "settings saved"); recheckUsage(); sendState(); pollSakura(); },
  clearAutoNotice: () => clearAutoNotice(),
  sendUsageNotice: () => sendUsageNotice(),
  setNotice: (a) => setNotice(a.text),
  openLobby: () => open(`http://localhost:${config.port}/play`),
  openHub: () => open(`http://localhost:${config.port}/`),
  openCheckin: () => open("https://www.natfrp.com/user/"),
  openGameFolder: () => open(GAME_DIR()),
};

// Only this machine's browser, only from the panel page: rejects other hosts
// (DNS rebinding) and cross-site POSTs (custom header forces a CORS preflight we never allow).
function trusted(req) {
  const host = String(req.headers.host || "");
  return host === `localhost:${config.panelPort}` || host === `127.0.0.1:${config.panelPort}`;
}

const server = http.createServer((req, res) => {
  if (!trusted(req)) return sendJson(res, { error: "forbidden host" }, 403);
  const url = new URL(req.url, "http://panel");
  const p = url.pathname;

  if (req.method === "GET") {
    if (p === "/") return sendFile(res, path.join(WEB_DIR, "index.html"));
    if (/^\/(app\.css|app\.js|qrcodegen\.js)$/.test(p)) return sendFile(res, path.join(WEB_DIR, p.slice(1)));
    if (p.startsWith("/fonts/")) return serveFont(res, p.slice(7));
    if (p === "/api/state") return sendJson(res, publicState());
    if (p === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "state", state: publicState() })}\n\n`);
      const replay = Object.values(backlog).flatMap((b) => b.slice(-250)).sort((a, b) => a.t.localeCompare(b.t));
      for (const e of replay) res.write(`data: ${JSON.stringify({ type: "log", ...e })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
  }

  if (req.method === "POST" && p === "/api/action") {
    if (req.headers["x-stronghold-panel"] !== "1") return sendJson(res, { error: "missing panel header" }, 403);
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      let a; try { a = JSON.parse(body); } catch { return sendJson(res, { error: "bad json" }, 400); }
      const fn = ACTIONS[a.action];
      if (!fn) return sendJson(res, { error: "unknown action" }, 400);
      log("panel", `> ${a.action}`);
      // actions can take a while (start waits for the game); reply now, progress arrives over SSE
      Promise.resolve().then(() => fn(a)).catch((e) => log("panel", `${a.action} failed: ${e.message}`));
      sendJson(res, { ok: true });
    });
    return;
  }
  sendJson(res, { error: "not found" }, 404);
});

export function startPanel(onReady) {
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") { console.error(`panel port ${config.panelPort} is busy — is another panel already running?`); process.exit(1); }
    throw e;
  });
  server.listen(config.panelPort, "127.0.0.1", onReady);
}
