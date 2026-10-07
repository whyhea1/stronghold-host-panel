// hub.mjs — the public-facing port (3000). Players and frpc talk only to this.
//   /                           中转站 (default landing page): who's online, which rooms are open
//   /play, /?room=CODE          the game itself (hub rewrites to the game's /)
//   /play?watch=CODE            the same, but the deep link opens the room as a spectator (观战)
//   /backup                     back up / restore a player's 干员调配 (same origin as the game)
//   /status.json                中转站 data;  /__panel/events  live push of the same (SSE)
//   /__panel/*                  hub assets, announcement feed, fonts, player cache list (/__panel/cache/manifest.json)
//   game down                   offline page (503) instead of a raw frpc error
//   everything else             reverse-proxied to the game (assets, /ws WebSocket, /healthz),
//                               with the announcement, cache and 观战 scripts injected into HTML
// It also counts every byte that passes, which is the tunnel bandwidth gauge.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { config, state, log, sendState, broadcast, onStateChange, WEB_DIR, GAME_DIR } from "./core.mjs";
import { watchUpstream } from "./roomwatch.mjs";
import { addTraffic } from "./usage.mjs";
import { isLoopback, cleanIp } from "./util.mjs";
import zlib from "node:zlib";
import { cacheId, cacheManifestGzip } from "./assetcache.mjs";

const HUB_DIR = path.join(WEB_DIR, "hub");
const NOTICE_TAG = `<script src="/__panel/notice.js" defer></script>`;
// Runs before the game's modules:
//  * keeps players on /play when the game rewrites its URL (e.g. after consuming ?room=), so a refresh stays in-game;
//  * ?watch=CODE becomes the game's own ?room=CODE deep link, and the one room.join that link sends goes out as
//    room.spectate (the game's 观战 request, same fields). Valid for 3 minutes, only for that code.
const HEAD_FIX = `<script>(function(){try{var q=new URLSearchParams(location.search),w=(q.get("watch")||"").toUpperCase().replace(/[^A-Z0-9]/g,"");` +
  `if(w){q.delete("watch");q.set("room",w);sessionStorage.setItem("sh-watch",w+"|"+Date.now());}var s=q.toString();` +
  `if(w||location.pathname==="/"||location.pathname==="/index.html")history.replaceState(history.state,"","/play"+(s?"?"+s:"")+location.hash);` +
  `var W=(sessionStorage.getItem("sh-watch")||"").split("|");if(!W[0]||Date.now()-Number(W[1])>180000){sessionStorage.removeItem("sh-watch");return;}W=W[0];` +
  `var send=WebSocket.prototype.send;WebSocket.prototype.send=function(d){try{if(W&&typeof d==="string"&&d.indexOf('"room.join"')>=0){var m=JSON.parse(d);` +
  `if(m&&m.t==="room.join"&&String(m.code||"").toUpperCase()===W){m.t="room.spectate";d=JSON.stringify(m);W=null;sessionStorage.removeItem("sh-watch");}}}catch(e){}` +
  `return send.call(this,d);};}catch(e){}})();</script>`;
// the players' asset cache (web/hub/cache.js), inlined so it runs before the game's first fetch
let cacheJs = { at: 0, text: "" };
function cacheScript() {
  const file = path.join(HUB_DIR, "cache.js");
  try { const m = fs.statSync(file).mtimeMs; if (m !== cacheJs.at) cacheJs = { at: m, text: fs.readFileSync(file, "utf8") }; } catch { return ""; }
  const cfg = { id: cacheId(), on: config.playerCache !== false, game: true };
  return `<script>window.__SH_CACHE=${JSON.stringify(cfg)}</script><script>${cacheJs.text.replace(/<\/script/gi, "<\\/script")}</script>`;
}
const wantsGzip = (req) => !!req && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
/** End a response, gzipped when the client takes it (the tunnel carries every byte). */
function endBody(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { ...headers };
  delete h["transfer-encoding"]; delete h["content-encoding"];
  if (buf.length > 1024 && wantsGzip(req)) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    h["content-encoding"] = "gzip"; h["content-length"] = gz.length; h["vary"] = "Accept-Encoding";
    res.writeHead(status, h); return res.end(gz);
  }
  h["content-length"] = buf.length;
  res.writeHead(status, h); res.end(buf);
}
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".woff2": "font/woff2", ".otf": "font/otf", ".ttf": "font/ttf", ".svg": "image/svg+xml" };

export function sendFile(res, file, status = 200) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); return; }
    const ext = path.extname(file);
    endBody(res.req, res, status, { "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": /\.(woff2|otf|ttf)$/.test(ext) ? "max-age=86400" : "no-store" }, buf);
  });
}
export function sendJson(res, obj, status = 200) {
  endBody(res.req, res, status, { "Content-Type": "application/json", "Cache-Control": "no-store" }, JSON.stringify(obj));
}
/** Game UI fonts (Bender / Novecento) from the installed game, so no CDN is needed. */
export function serveFont(res, name) {
  if (!/^[\w.-]+\.(woff2|otf|ttf)$/.test(name)) return sendJson(res, { error: "bad name" }, 400);
  sendFile(res, path.join(GAME_DIR(), "public", "fonts", name));
}

/** The official full package of the installed version: players can import it on the 中转站 (no tunnel traffic). */
function fullZip() {
  const tag = state.version;
  if (!tag || config.playerCache === false) return null;
  const same = state.latestVersion === tag && state.latestAssets && state.latestAssets.full;
  if (same) return { url: state.latestAssets.full.url, size: state.latestAssets.full.size, name: state.latestAssets.full.name };
  const name = `Stronghold-Protocol-${tag}.zip`;
  return { url: `https://github.com/${config.repo}/releases/download/${tag}/${name}`, size: 0, name };
}

export function hubData() {
  const h = state.health;
  const rooms = Object.values(state.rooms);
  return {
    online: state.game === "running" && !!h,
    version: (h && (h.app || h.version)) || state.version || null,
    uptimeSec: h ? h.uptimeSec : null,
    players: h ? h.humans : null, bots: h ? h.bots : null, spectators: h ? h.spectators : null,
    roomCount: h ? h.rooms : rooms.length, inMatch: h ? h.matches : rooms.filter((r) => r.status === "in match").length,
    rooms: rooms.map((r) => ({ code: r.code, host: r.host || "?", mode: r.mode || "", difficulty: r.difficulty || "",
      seats: r.seats, capacity: r.capacity || null, inMatch: r.status === "in match",
      members: r.members || null, watchers: r.watchers || [] })),
    notice: state.notice.text,
    autoNotice: state.autoNotice ? state.autoNotice.text : "",
    autoNoticeEn: state.autoNotice ? state.autoNotice.textEn || "" : "",
    usage: state.usage ? { usedBytes: state.usage.usedBytes, limitBytes: state.usage.limitBytes, pct: Math.round(state.usage.pct), level: state.usage.level } : null,
    cacheId: config.playerCache !== false ? cacheId() : "",
    gamePackage: state.installedPackage || null,
    fullZip: fullZip(),
    time: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// request routing
// ---------------------------------------------------------------------------
const gameUp = () => state.game === "running";

const server = http.createServer((req, res) => {
  const q = req.url.indexOf("?");
  const p = q < 0 ? req.url : req.url.slice(0, q);
  const query = q < 0 ? "" : req.url.slice(q);
  try {
    const isRoot = p === "/" || p === "/index.html";
    const wantsRoom = /[?&](room|watch)=/.test(query);
    if ((isRoot && !wantsRoom) || p === "/status" || p === "/status/") return sendFile(res, path.join(HUB_DIR, "status.html"));
    if (p === "/backup" || p === "/backup/") return sendFile(res, path.join(HUB_DIR, "backup.html"));
    if (p === "/status.json") return sendJson(res, hubData());
    if (p === "/__panel/events") return openFeed(req, res);
    if (p === "/__panel/notice") return sendJson(res, { ...state.notice, auto: state.autoNotice ? state.autoNotice.text : "", autoEn: state.autoNotice ? state.autoNotice.textEn || "" : "" });
    if (p === "/__panel/cache/manifest.json") {
      const gz = cacheManifestGzip();
      if (!gz || config.playerCache === false) return sendJson(res, { error: "not ready" }, 503);
      if (wantsGzip(req)) { res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": gz.length, "Cache-Control": "no-store", Vary: "Accept-Encoding" }); return res.end(gz); }
      return endBody(req, res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }, zlib.gunzipSync(gz));
    }
    if (p.startsWith("/__panel/fonts/")) return serveFont(res, p.slice(15));
    if (p.startsWith("/__panel/")) {
      const name = p.slice(9);
      if (name === "i18n.js") return sendFile(res, path.join(WEB_DIR, "i18n.js"));   // shared with the panel
      if (/^[\w-]+\.(js|css|html)$/.test(name)) return sendFile(res, path.join(HUB_DIR, name));
      return sendJson(res, { error: "not found" }, 404);
    }
    if (!gameUp()) {
      if (p === "/healthz") return sendJson(res, { ok: false, panel: true }, 503);
      return sendFile(res, path.join(HUB_DIR, "offline.html"), 503);
    }
    // the game lives at /play; upstream it is the game's own "/"
    const page = p === "/play" || p === "/play/" || isRoot;
    proxyHttp(req, res, page ? "/" + query : req.url, page || /\btext\/html\b/.test(String(req.headers.accept || "")));
  } catch (e) { log("panel", "hub error: " + e.message); try { res.destroy(); } catch {} }
});

function upstreamHeaders(req) {
  const h = { ...req.headers, host: `127.0.0.1:${config.gameInternalPort}` };
  const prior = req.headers["x-forwarded-for"];
  const ip = cleanIp(req.socket.remoteAddress);
  h["x-forwarded-for"] = prior ? `${prior}, ${ip}` : ip;
  return h;
}

// Pages come back plain so the hub can add its scripts (then gzips them itself); everything else keeps the
// game's own gzip, which matters: the game's code and data are several MB of text per visit.
function proxyHttp(req, res, upstreamPath, isPage) {
  const headers = upstreamHeaders(req);
  if (isPage) delete headers["accept-encoding"];
  const up = http.request({ host: "127.0.0.1", port: config.gameInternalPort, path: upstreamPath, method: req.method, headers }, (pr) => {
    const isHtml = pr.statusCode === 200 && String(pr.headers["content-type"] || "").includes("text/html");
    if (!isHtml) { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); return; }
    const chunks = [];
    pr.on("data", (c) => chunks.push(c));
    pr.on("end", () => {
      let raw = Buffer.concat(chunks);
      const enc = String(pr.headers["content-encoding"] || "");
      try { if (enc === "gzip") raw = zlib.gunzipSync(raw); else if (enc === "br") raw = zlib.brotliDecompressSync(raw); else if (enc === "deflate") raw = zlib.inflateSync(raw); } catch {}
      let body = raw.toString("utf8");
      const head = HEAD_FIX + cacheScript();
      body = body.includes("</body>") ? body.replace("</body>", NOTICE_TAG + "</body>") : body + NOTICE_TAG;
      body = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, (m) => m + head) : head + body;
      endBody(req, res, pr.statusCode, { ...pr.headers, "cache-control": "no-store" }, body);
    });
  });
  up.on("error", () => { if (!res.headersSent) sendFile(res, path.join(HUB_DIR, "offline.html"), 503); else res.destroy(); });
  req.pipe(up);
}

// WebSocket (/ws): replay the handshake upstream, then splice the two sockets
server.on("upgrade", (req, sock, head) => {
  if (!gameUp()) { sock.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
  const up = net.connect(config.gameInternalPort, "127.0.0.1", () => {
    const h = upstreamHeaders(req);
    const lines = Object.entries(h).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`));
    up.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (head && head.length) up.write(head);
    up.on("data", watchUpstream());   // read-only: picks room.state frames out of the game -> player stream
    up.pipe(sock); sock.pipe(up);
  });
  const kill = () => { up.destroy(); sock.destroy(); };
  up.on("error", kill); sock.on("error", kill);
  up.on("close", () => sock.destroy()); sock.on("close", () => up.destroy());
});

// ---------------------------------------------------------------------------
// live peers + byte accounting (every player byte crosses one of these sockets)
// ---------------------------------------------------------------------------
const peers = new Map();   // socket -> { ip, via, r, w }
const closed = { tunnelIn: 0, tunnelOut: 0, lanIn: 0, lanOut: 0 };
server.on("connection", (sock) => {
  const ip = cleanIp(sock.remoteAddress);
  const rec = { ip, via: isLoopback(ip) ? "tunnel" : "lan", r: 0, w: 0 };
  peers.set(sock, rec);
  sock.on("close", () => {
    const dIn = sock.bytesRead - rec.r, dOut = sock.bytesWritten - rec.w;
    closed[rec.via + "In"] += dIn; closed[rec.via + "Out"] += dOut;
    peers.delete(sock);
  });
});

let lastAt = Date.now();
setInterval(() => {
  const now = Date.now(), dt = (now - lastAt) / 1000; lastAt = now;
  const d = { ...closed }; closed.tunnelIn = closed.tunnelOut = closed.lanIn = closed.lanOut = 0;
  const groups = new Map();
  for (const [sock, rec] of peers) {
    d[rec.via + "In"] += sock.bytesRead - rec.r; d[rec.via + "Out"] += sock.bytesWritten - rec.w;
    rec.r = sock.bytesRead; rec.w = sock.bytesWritten;
    const g = groups.get(rec.ip) || { address: rec.ip, via: rec.via, sockets: 0 };
    g.sockets++; groups.set(rec.ip, g);
  }
  const mbps = (bytes) => +((bytes * 8) / dt / 1e6).toFixed(2);
  const bw = state.bw;
  bw.tunnelIn = mbps(d.tunnelIn); bw.tunnelOut = mbps(d.tunnelOut);
  bw.lanIn = mbps(d.lanIn); bw.lanOut = mbps(d.lanOut);
  addTraffic(d.tunnelIn + d.tunnelOut, d.lanIn + d.lanOut);
  bw.totalInMB += (d.tunnelIn + d.lanIn) / 1048576; bw.totalOutMB += (d.tunnelOut + d.lanOut) / 1048576;
  bw.history.push(Math.max(bw.tunnelIn, bw.tunnelOut)); if (bw.history.length > 90) bw.history.shift();
  broadcast({ type: "bw", bw: { ...bw, limitMbps: config.speedLimitMbps } });

  const list = [...groups.values()].sort((a, b) => b.sockets - a.sockets);
  if (JSON.stringify(list) !== JSON.stringify(state.connections)) { state.connections = list; sendState(); }
}, 2000);

// ---------------------------------------------------------------------------
// live 中转站 feed — Server-Sent Events, pushed the moment anything changes
// ---------------------------------------------------------------------------
const feedClients = new Set();
let lastFeed = "";
function openFeed(req, res) {
  if (feedClients.size >= 200) return sendJson(res, { error: "busy" }, 503);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`retry: 3000\ndata: ${JSON.stringify(hubData())}\n\n`);
  feedClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => { clearInterval(ping); feedClients.delete(res); });
}
function pushFeed() {
  if (!feedClients.size) return;
  const { time, ...d } = hubData();
  const key = JSON.stringify(d);
  if (key === lastFeed) return;
  lastFeed = key;
  const msg = `data: ${JSON.stringify({ ...d, time: new Date().toISOString() })}\n\n`;
  for (const res of feedClients) { try { res.write(msg); } catch {} }
}
onStateChange(pushFeed);

// ---------------------------------------------------------------------------
// announcements
// ---------------------------------------------------------------------------
export function setNotice(text) {
  const t = String(text || "").trim().slice(0, 200);
  state.notice = { text: t, at: t ? new Date().toISOString() : null };
  log("panel", t ? `announcement live: "${t}"` : "announcement cleared");
  sendState();
}

// ---------------------------------------------------------------------------
// binding: retries every 5 s while something else holds the port
// ---------------------------------------------------------------------------
let warned = false, retry = null;
server.on("listening", () => {
  state.hub.bound = true; warned = false;
  log("panel", `hub live on :${config.port} — 中转站 at /status, game proxied from 127.0.0.1:${config.gameInternalPort}`);
  sendState();
});
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") { log("panel", "hub error: " + e.message); return; }
  state.hub.bound = false;
  if (!warned) { warned = true; log("panel", `:${config.port} is held by another process — hub offline until it is freed (Restart does this)`); sendState(); }
  clearTimeout(retry); retry = setTimeout(bind, 5000);
});
function bind() { if (!server.listening) server.listen(config.port, "0.0.0.0"); }

export function startHub() { bind(); }
export function stopHub() { clearTimeout(retry); try { server.close(); } catch {} }
/** Try to bind right now; resolves to whether the hub owns the port afterwards. */
export function hubBindNow() {
  if (server.listening) return Promise.resolve(true);
  clearTimeout(retry);
  return new Promise((resolve) => {
    const done = () => { server.off("listening", done); server.off("error", done); setTimeout(() => resolve(server.listening), 0); };
    server.once("listening", done); server.once("error", done);
    bind();
  });
}
