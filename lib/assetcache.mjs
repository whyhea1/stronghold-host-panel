// assetcache.mjs — the file list behind the players' browser cache (web/hub/cache.js).
//
// SakuraFrp's 自动 HTTPS uses a self-signed certificate. Chrome keeps no HTTP cache and allows no service worker
// on a page with a certificate error, so every visit downloads the game's art again through the tunnel. The hub
// page script keeps the files in IndexedDB instead, and this manifest tells it which copy is current:
//
//   { id, version, count, bytes, files: { "/assets/x.png": "<crc32 hex>-<size base36>", "/media/bgm/a": "=/assets/audio/bgm/a.mp3" } }
//
// CRC32 + size is also what every ZIP entry records, so a player can fill the cache from the official full package
// (downloaded from GitHub, not through the tunnel) and the browser can match each entry without reading it.
// URL layout = the game's static server: public/ → /, data/ → /data/, shared/ → /shared/, server/sim/*.js → /sim/,
// public/assets/audio/<x>.<ext> also as /media/<x> (the game fetches audio there).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { state, log, sendState, GAME_DIR, PANEL_DIR } from "./core.mjs";

const AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav"];
const ROOTS = [
  ["public", "/"],
  ["data", "/data/"],
  ["shared", "/shared/"],
  [path.join("server", "sim"), "/sim/"],
];
const CRC_FILE = path.join(PANEL_DIR, ".cache", "crc.json");   // "<rel>|<size>|<mtimeMs>" -> crc hex

let manifest = null;        // { id, version, count, bytes, files }
let gzipped = null;         // Buffer
let building = null;

/** The current manifest (null until the first build finishes). */
export function cacheManifest() { return manifest; }
export function cacheManifestGzip() { return gzipped; }
export function cacheId() { return manifest ? manifest.id : ""; }

// zlib.crc32 is Node 22.2+; the table version is the fallback for older runtimes
const TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crcUpdate(crc, buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf, crc);
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
async function crcFile(file) {
  let crc = 0;
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      crc = crcUpdate(crc, buf.subarray(0, bytesRead));
    }
  } finally { await fh.close(); }
  return (crc >>> 0).toString(16).padStart(8, "0");
}

async function walk(dir, rel, out) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const d of list) {
    if (d.name.startsWith(".") || d.name.endsWith("~")) continue;
    const abs = path.join(dir, d.name), r = rel ? rel + "/" + d.name : d.name;
    if (d.isDirectory()) await walk(abs, r, out);
    else if (d.isFile()) out.push([abs, r]);
  }
}

/** (Re)build the manifest from the installed game. Cheap when nothing changed: the CRCs are kept by size + mtime. */
export function buildCacheManifest(reason = "") {
  if (building) return building;
  building = (async () => {
    const t0 = Date.now();
    const root = GAME_DIR();
    if (!fs.existsSync(root)) { manifest = null; gzipped = null; return null; }
    let known = {};
    try { known = JSON.parse(fs.readFileSync(CRC_FILE, "utf8")); } catch {}
    const next = {};
    const files = {};
    let bytes = 0, hashed = 0;
    for (const [dirRel, prefix] of ROOTS) {
      const list = [];
      await walk(path.join(root, dirRel), "", list);
      for (const [abs, rel] of list) {
        const low = rel.toLowerCase();
        if (prefix === "/" && low.endsWith(".html")) continue;          // pages are navigations, never fetch()
        if (prefix === "/sim/" && (!low.endsWith(".js") || path.basename(low) === "nodedata.js")) continue;
        let st; try { st = await fsp.stat(abs); } catch { continue; }
        const key = `${dirRel}/${rel}|${st.size}|${Math.round(st.mtimeMs)}`;
        let crc = known[key];
        if (!crc) { try { crc = await crcFile(abs); hashed++; } catch { continue; } }
        next[key] = crc;
        files[prefix + rel] = `${crc}-${st.size.toString(36)}`;
        bytes += st.size;
      }
    }
    // /media/<x> → /assets/audio/<x>.<ext>; a name with two audio files is left out (the server picks one of them)
    const media = new Map();
    for (const p of Object.keys(files)) {
      if (!p.startsWith("/assets/audio/")) continue;
      const ext = AUDIO_EXTS.find((e) => p.toLowerCase().endsWith(e));
      if (!ext) continue;
      const alias = "/media/" + p.slice(14, -ext.length);
      media.set(alias, media.has(alias) ? null : p);
    }
    for (const [alias, target] of media) if (target) files[alias] = "=" + target;

    const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
    const id = crypto.createHash("sha1").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
    const count = Object.values(sorted).filter((v) => v[0] !== "=").length;
    manifest = { id, version: state.version || null, count, bytes, files: sorted };
    gzipped = zlib.gzipSync(JSON.stringify(manifest), { level: 9 });
    try { fs.mkdirSync(path.dirname(CRC_FILE), { recursive: true }); fs.writeFileSync(CRC_FILE, JSON.stringify(next)); } catch {}
    log("panel", `player cache list ready: ${count} files, ${(bytes / 1048576).toFixed(0)} MB` +
      `${hashed ? `, ${hashed} checked` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s${reason ? ", " + reason : ""})`);
    sendState();
    return manifest;
  })().catch((e) => { log("panel", "player cache list failed: " + e.message); return null; })
    .finally(() => { building = null; });
  return building;
}
