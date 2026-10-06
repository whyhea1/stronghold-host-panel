// Room membership, read passively from the game's own WebSocket traffic.
//
// Every player's socket already passes through the hub. The game (ws library, perMessageDeflate off)
// sends each room member a plain-text `room.state` frame whenever the room changes:
//   { t: "room.state", code, hostId, mode, difficulty, inMatch, seats: [ {name, isBot, ready, connected} | null ], spectators }
// This module only *reads* the game -> player direction and keeps the latest copy per room.
// Nothing is sent to the game and no game file is modified.

import { state, sendState } from "./core.mjs";

const MAX_KEEP = 64 * 1024;                 // room.state is small; bigger frames (battle snapshots) are skipped
const PREFIX = Buffer.from('{"t":"room.');  // only frames starting with this are parsed

/** Returns a chunk handler for one upstream (game -> player) socket. */
export function watchUpstream() {
  let buf = Buffer.alloc(0);
  let handshakeDone = false;
  let skip = 0;            // payload bytes still to drop for an ignored frame
  let dead = false;

  return function onChunk(chunk) {
    if (dead) return;
    try {
      if (skip) {
        if (chunk.length <= skip) { skip -= chunk.length; return; }
        chunk = chunk.subarray(skip); skip = 0;
      }
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      if (!handshakeDone) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) { if (buf.length > 16384) dead = true; return; }
        if (!buf.subarray(0, 12).toString().includes("101")) { dead = true; return; }
        buf = buf.subarray(end + 4); handshakeDone = true;
      }
      for (;;) {
        if (buf.length < 2) break;
        const b0 = buf[0], b1 = buf[1];
        const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (masked) off += 4;
        if (buf.length < off) break;
        const wanted = fin && op === 1 && len <= MAX_KEEP;
        if (!wanted) {
          const have = buf.length - off;
          if (have >= len) { buf = buf.subarray(off + len); continue; }
          skip = len - have; buf = Buffer.alloc(0); break;
        }
        if (buf.length < off + len) break;   // wait for the rest of a small frame
        let payload = buf.subarray(off, off + len);
        if (masked) { const k = buf.subarray(off - 4, off); payload = Buffer.from(payload.map((x, i) => x ^ k[i & 3])); }
        buf = buf.subarray(off + len);
        if (payload.length > PREFIX.length && payload.subarray(0, PREFIX.length).equals(PREFIX)) handle(payload);
      }
      if (buf.length) buf = Buffer.from(buf);   // detach from the big chunk so it can be freed
    } catch { dead = true; }
  };
}

function handle(payload) {
  let m;
  try { m = JSON.parse(payload.toString("utf8")); } catch { return; }
  if (!m || m.t !== "room.state" || typeof m.code !== "string") return;
  applyRoomState(m);
}

/** Merge one room.state frame into state.rooms (also creates rooms the log parser missed). */
export function applyRoomState(m) {
  const code = m.code.toUpperCase();
  const seats = Array.isArray(m.seats) ? m.seats : [];
  const members = seats.filter(Boolean).map((s) => ({
    name: String(s.name ?? "?").slice(0, 32),
    bot: !!s.isBot, ready: !!s.ready, online: s.connected !== false,
    host: s.playerId != null && s.playerId === m.hostId,
  }));
  const watchers = (Array.isArray(m.spectators) ? m.spectators : []).map((s) => ({
    name: String(s.name ?? "?").slice(0, 32), online: s.connected !== false,
  }));
  const host = members.find((x) => x.host);
  const r = state.rooms[code] || (state.rooms[code] = { code, since: new Date().toISOString() });
  if (m.mode) r.mode = String(m.mode);
  if (m.difficulty) r.difficulty = String(m.difficulty);
  if (host) r.host = host.name;
  r.status = m.inMatch ? "in match" : "lobby";
  r.members = members;
  r.watchers = watchers;
  r.capacity = seats.length || null;
  r.seats = members.length;
  r.seenAt = Date.now();
  sendState();
}
