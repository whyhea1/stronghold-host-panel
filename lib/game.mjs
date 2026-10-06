// game.mjs — game server lifecycle, health polling, lobby-log room tracker.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, state, procs, log, sendState, broadcast, GAME_DIR, sleep } from "./core.mjs";
import { augmentEnv, probeHealth, killPortListeners, killTree, waitExit, onLines } from "./util.mjs";
import { hubBindNow } from "./hub.mjs";

/** Where the game itself listens: behind the hub when the hub owns the public port. */
export const gamePort = () => (state.hub.bound ? config.gameInternalPort : config.port);

let intent = "idle";   // "idle" | "starting" | "stopping" — what the panel is doing on purpose

function setGame(s) { if (state.game !== s) { state.game = s; sendState(); } }

// ---------------------------------------------------------------------------
// start / stop / restart
// ---------------------------------------------------------------------------
export async function startGame() {
  if (procs.game || intent === "starting") return log("panel", "game is already starting/running");
  const port = gamePort();
  if (await probeHealth(port)) { log("panel", `a game server already answers on :${port} — adopted`); return markRunning(); }

  const dir = GAME_DIR();
  if (!fs.existsSync(dir)) { setGame("error"); return log("panel", `game not installed at ${dir} — click "Check for update" first`); }

  intent = "starting";
  setGame("starting");
  let cmd = "npm", args = ["start"], env = augmentEnv();
  if (state.hub.bound) {
    env = augmentEnv({ PORT: String(port), HOST: "127.0.0.1" });
    log("panel", `starting game on 127.0.0.1:${port} (hub serves players on :${config.port})`);
  } else {
    if (fs.existsSync(path.join(dir, "scripts", "start.sh"))) { cmd = "bash"; args = ["scripts/start.sh"]; }
    log("panel", `hub not bound — starting game directly on :${port}. Press Restart to fix.`);
  }

  const p = spawn(cmd, args, { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  procs.game = p;
  onLines(p, (l) => { log("game", l); parseLobbyLine(l); });
  p.on("error", (e) => log("panel", `could not launch game: ${e.message}`));
  p.on("exit", (code, sig) => onGameExit(p, code, sig));

  for (let i = 0; i < 90 && procs.game === p; i++) {
    if (await probeHealth(port)) { intent = "idle"; log("panel", `game is live (internal :${port})`); return markRunning(); }
    await sleep(1000);
  }
  if (procs.game === p) { intent = "idle"; setGame("error"); log("panel", "game did not answer /healthz within 90 s — see Game logs"); }
}

async function onGameExit(p, code, sig) {
  if (procs.game === p) procs.game = null;
  if (intent === "stopping") return;               // stopGame() handles state
  log("panel", `game process exited (${sig || "code " + code})`);
  intent = "recovering";                          // keep pollHealth out while we look
  // start.sh may hand off to a server that keeps running — look before reporting a crash
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    if (await probeHealth(gamePort())) { intent = "idle"; log("panel", "a server is still answering — adopted"); return markRunning(); }
  }
  intent = "idle";
  stopCaffeinate();
  setGame(code === 0 ? "stopped" : "error");
  state.health = null; state.rooms = {}; sendState();
}

function markRunning() { setGame("running"); startCaffeinate(); }

export async function stopGame() {
  intent = "stopping";
  setGame("stopping");
  const p = procs.game;
  if (p) { log("panel", "stopping game server..."); killTree(p); await waitExit(p, 6000); procs.game = null; }
  const killed = await killPortListeners(gamePort());   // adopted/orphaned servers (never the panel)
  if (killed.length) log("panel", `killed leftover server on :${gamePort()} (pid ${killed.join(", ")})`);
  intent = "idle";
  stopCaffeinate();
  state.health = null; state.rooms = {};
  setGame("stopped"); sendState();
}

/** Stop everything game-related, reclaim the public port for the hub if needed, start fresh. */
export async function restartGame() {
  await stopGame();
  if (!state.hub.bound) {
    const killed = await killPortListeners(config.port);
    if (killed.length) log("panel", `freed :${config.port} from pid ${killed.join(", ")}`);
    await hubBindNow();
  }
  await startGame();
}

// ---------------------------------------------------------------------------
// health — the game's own /healthz (ok, app, uptimeSec, sockets, sessions,
// rooms, matches, humans, bots, spectators). Also detects external start/stop.
// ---------------------------------------------------------------------------
async function pollHealth() {
  const h = await probeHealth(gamePort());
  if (h) {
    const { ok, build, ...rest } = h;
    if (JSON.stringify(rest) !== JSON.stringify(state.health)) { state.health = rest; sendState(); }
    if (intent === "idle" && (state.game === "stopped" || state.game === "error")) {
      log("panel", "game server detected on the port — adopted"); markRunning();
    }
  } else {
    if (state.health) { state.health = null; sendState(); }
    if (intent === "idle" && state.game === "running" && !procs.game) {
      log("panel", "adopted game server went away"); stopCaffeinate(); setGame("stopped");
    }
  }
}
setInterval(pollHealth, 3000);

// ---------------------------------------------------------------------------
// lobby tracker — parses server/lobby.js log lines
// ---------------------------------------------------------------------------
function pushActivity(text) {
  const entry = { t: new Date().toISOString(), text };
  state.activity.push(entry);
  if (state.activity.length > 30) state.activity.shift();
  broadcast({ type: "activity", entry });
}

const LOBBY_RULES = [
  [/\[lobby\] (\w+) created \((.+?)\/(.+?)\) by (.+)$/, (code, mode, difficulty, host) => {
    state.rooms[code] = { code, mode, difficulty, host: host.trim(), seats: null, status: "lobby", since: new Date().toISOString() };
    pushActivity(`room ${code} created by ${host.trim()} (${mode}/${difficulty})`);
  }],
  [/\[lobby\] (\w+) match #\d+ starting \((.+?)\/(.+?), (\d+) seats/, (code, mode, difficulty, seats) => {
    const r = state.rooms[code] || (state.rooms[code] = { code, mode, difficulty, host: "?" });
    r.status = "in match"; r.seats = Number(seats);
    pushActivity(`room ${code} match started (${seats} seats)`);
  }],
  [/\[lobby\] (\w+) match #\d+ ended/, (code) => {
    if (state.rooms[code]) state.rooms[code].status = "lobby";
    pushActivity(`room ${code} match ended`);
  }],
  [/\[lobby\] (\w+) (.+?) removed by the host/, (code, who) => pushActivity(`room ${code}: ${who.trim()} kicked by host`)],
  [/\[lobby\] (\w+) host (?:\u2192|->) (.+)$/, (code, who) => {
    if (state.rooms[code]) state.rooms[code].host = who.trim();
    pushActivity(`room ${code}: host is now ${who.trim()}`);
  }],
  [/\[lobby\] (\w+) disposed \((.+?)\)/, (code, why) => { delete state.rooms[code]; pushActivity(`room ${code} closed (${why})`); }],
];

function parseLobbyLine(l) {
  for (const [re, fn] of LOBBY_RULES) {
    const m = l.match(re);
    if (m) { fn(...m.slice(1)); sendState(); return; }
  }
}

// ---------------------------------------------------------------------------
// sleep prevention while the game runs
// ---------------------------------------------------------------------------
function startCaffeinate() {
  if (procs.caffeinate) return;
  try {
    procs.caffeinate = spawn("caffeinate", ["-dimsu"], { stdio: "ignore" });
    procs.caffeinate.on("error", () => (procs.caffeinate = null));
    procs.caffeinate.on("exit", () => (procs.caffeinate = null));
    log("panel", "sleep prevention on");
  } catch {}
}
function stopCaffeinate() {
  if (procs.caffeinate) { try { procs.caffeinate.kill(); } catch {} procs.caffeinate = null; }
}
