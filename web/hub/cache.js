// cache.js — players' persistent asset cache (IndexedDB), injected into the game page and loaded by the 中转站.
//
// Why: SakuraFrp's 自动 HTTPS certificate is self-signed. Chrome keeps no HTTP cache and allows no service worker
// on such a page, so every visit downloaded the game's art again through the tunnel (and the host's daily data).
// This script keeps each file in IndexedDB and answers the game's own fetch() calls from there. The hub's manifest
// (/__panel/cache/manifest.json, lib/assetcache.mjs) names the current copy of every file as "<crc32>-<size>", so
// only files that changed in a game update are downloaded again.
//
// Game page:  window.fetch, <img>.src and PIXI's texture loader (worker off, so it uses fetch) go through the cache.
// 中转站:     window.SHCache — stats, on/off, clear, and import from the official full package ZIP (no tunnel).
(function () {
  "use strict";
  if (window.SHCache) return;
  var CFG = window.__SH_CACHE || {};
  var DB_NAME = "stronghold-cache", FILES = "files", META = "meta", MODE_KEY = "sh-cache-mode";
  var PREFIXES = ["/assets/", "/media/", "/data/", "/vendor/", "/fonts/", "/sim/", "/shared/", "/i18n/"];
  var TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
    json: "application/json", js: "text/javascript", mjs: "text/javascript", css: "text/css", atlas: "text/plain; charset=utf-8",
    txt: "text/plain; charset=utf-8", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg",
    opus: "audio/ogg", wav: "audio/wav", woff2: "font/woff2", woff: "font/woff", otf: "font/otf", ttf: "font/ttf",
    glb: "model/gltf-binary", gltf: "model/gltf+json", ktx2: "image/ktx2" };
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var hasIDB = (function () { try { return !!window.indexedDB; } catch (e) { return false; } })();
  var enabled = function () { try { return CFG.on !== false && localStorage.getItem(MODE_KEY) !== "off"; } catch (e) { return CFG.on !== false; } };
  var typeFor = function (p) { return TYPES[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream"; };
  var sizeOf = function (tag) { return parseInt(String(tag).split("-")[1], 36); };

  // ---- IndexedDB ------------------------------------------------------------------------------------------------
  var dbP = null;
  function db() {
    if (!dbP) dbP = new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES); if (!d.objectStoreNames.contains(META)) d.createObjectStore(META); };
      r.onsuccess = function () { var d = r.result; d.onversionchange = function () { d.close(); dbP = null; }; res(d); };
      r.onerror = function () { rej(r.error); };
      r.onblocked = function () { rej(new Error("blocked")); };
    }).catch(function (e) { dbP = null; throw e; });
    return dbP;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), out, r = fn(t.objectStore(store));
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error || new Error("idb")); };
      });
    });
  }
  var get = function (k) { return tx(FILES, "readonly", function (s) { return s.get(k); }); };
  var metaGet = function (k) { return tx(META, "readonly", function (s) { return s.get(k); }); };
  var metaPut = function (k, v) { return tx(META, "readwrite", function (s) { return s.put(v, k); }); };
  function putMany(list) {
    return tx(FILES, "readwrite", function (s) { list.forEach(function (x) { s.put(x[1], x[0]); }); return null; });
  }
  /** Map key -> tag of everything stored (blobs are not read). */
  function storedTags() {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var out = new Map(), bytes = 0;
        var c = d.transaction(FILES, "readonly").objectStore(FILES).openCursor();
        c.onsuccess = function () { var cur = c.result; if (!cur) return res({ tags: out, bytes: bytes }); out.set(cur.key, cur.value.tag); bytes += cur.value.size || 0; cur.continue(); };
        c.onerror = function () { rej(c.error); };
      });
    });
  }
  var persistAsked = false;
  function askPersist() {
    if (persistAsked) return; persistAsked = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {}); } catch (e) {}
  }

  // ---- manifest -------------------------------------------------------------------------------------------------
  var manifestP = null;
  function manifest() {
    if (manifestP) return manifestP;
    manifestP = (async function () {
      var want = CFG.id;
      if (!want) { var s = await origFetch("/status.json", { cache: "no-store" }).then(function (r) { return r.json(); }).catch(function () { return {}; }); want = s.cacheId; }
      if (!want || !hasIDB) return null;
      var have = await metaGet("manifest").catch(function () { return null; });
      if (have && have.id === want) return have;
      var r = await origFetch("/__panel/cache/manifest.json", { cache: "no-store" });
      if (!r.ok) return null;                       // an old list could name stale copies: no cache this time
      var m = await r.json();
      await metaPut("manifest", m).catch(function () {});
      setTimeout(function () { prune(m).catch(function () {}); }, 15000);
      return m;
    })().catch(function () { manifestP = null; return null; });
    return manifestP;
  }
  function resolve(m, p) {
    var tag = m.files[p], key = p;
    if (tag && tag.charAt(0) === "=") { key = tag.slice(1); tag = m.files[key]; }
    return tag ? { key: key, tag: tag } : null;
  }
  /** Drop copies the current game no longer has (after an update). */
  async function prune(m) {
    var st = await storedTags(), dead = [];
    st.tags.forEach(function (tag, key) { if (m.files[key] !== tag) dead.push(key); });
    if (dead.length) await tx(FILES, "readwrite", function (s) { dead.forEach(function (k) { s.delete(k); }); return null; });
    return dead.length;
  }

  // ---- game page: answer fetch() from the cache -----------------------------------------------------------------
  var stats = { hits: 0, misses: 0, savedBytes: 0 };
  function eligible(url) { return url.origin === location.origin && PREFIXES.some(function (p) { return url.pathname.indexOf(p) === 0; }); }
  function respond(rec, href) {
    var r = new Response(rec.blob, { status: 200, statusText: "OK", headers: { "Content-Type": rec.type, "Content-Length": String(rec.size), "X-Stronghold-Cache": "hit" } });
    try { Object.defineProperty(r, "url", { value: href }); } catch (e) {}
    return r;
  }
  async function cachedFetch(input, init, url) {
    var m = await manifest();
    var path; try { path = decodeURIComponent(url.pathname); } catch (e) { path = url.pathname; }
    var hit = m && resolve(m, path);
    if (!hit) return origFetch(input, init);
    try {
      var rec = await get(hit.key);
      if (rec && rec.tag === hit.tag && rec.blob) { stats.hits++; stats.savedBytes += rec.size; return respond(rec, url.href); }
    } catch (e) { /* storage unavailable: network */ }
    var res = await origFetch(input, init);
    if (res.status === 200 && !res.headers.get("content-range")) {
      stats.misses++;
      var type = res.headers.get("content-type") || typeFor(hit.key);
      res.clone().blob().then(function (b) {
        if (b.size !== sizeOf(hit.tag)) return;         // not the file the list names (changed under us): skip
        askPersist();
        return putMany([[hit.key, { tag: hit.tag, type: type, size: b.size, blob: b, at: Date.now() }]]);
      }).catch(function () {});
    }
    return res;
  }
  var active = !!(CFG.game && origFetch && hasIDB && enabled() && typeof Response === "function");
  if (active) {
    window.fetch = function (input, init) {
      try {
        var req = typeof Request !== "undefined" && input instanceof Request ? input : null;
        var method = String((init && init.method) || (req && req.method) || "GET").toUpperCase();
        if (method === "GET") {
          var url = new URL(req ? req.url : String(input), location.href);
          var h = init && init.headers ? new Headers(init.headers) : req ? req.headers : null;
          if (eligible(url) && !(h && h.has("range"))) return cachedFetch(input, init, url);
        }
      } catch (e) { /* fall through */ }
      return origFetch(input, init);
    };

    // <img>.src: load through the cache, then hand the element a blob: URL
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
      if (d && d.set && d.get) {
        Object.defineProperty(HTMLImageElement.prototype, "src", {
          configurable: true, enumerable: d.enumerable,
          get: function () { return this.__shSrc || d.get.call(this); },
          set: function (v) {
            var el = this, url;
            try { url = new URL(String(v), location.href); } catch (e) { url = null; }
            if (!url || !eligible(url) || url.pathname.indexOf("/assets/") !== 0) { el.__shSrc = null; d.set.call(el, v); return; }
            var href = url.href; el.__shSrc = href;
            window.fetch(href).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.blob(); }).then(function (b) {
              if (el.__shSrc !== href) return;
              var bu = URL.createObjectURL(b), done = function () { URL.revokeObjectURL(bu); };
              el.addEventListener("load", done, { once: true }); el.addEventListener("error", done, { once: true });
              d.set.call(el, bu);
            }).catch(function () { if (el.__shSrc === href) d.set.call(el, v); });
          },
        });
      }
    } catch (e) { /* leave images alone */ }

    // PIXI 7 decodes textures in a Web Worker by default, which this page script cannot see. Main-thread decoding
    // uses window.fetch. pixi.min.js is a classic script with a top-level `var PIXI`, so the setter sees it.
    try {
      var P;
      Object.defineProperty(window, "PIXI", {
        configurable: true,
        get: function () { return P; },
        set: function (v) { P = v; try { if (v && v.Assets && v.Assets.setPreferences) v.Assets.setPreferences({ preferWorkers: false }); } catch (e) {} },
      });
    } catch (e) { /* PIXI already defined */ }
  }

  // ---- ZIP import (official full package → cache, nothing through the tunnel) ------------------------------------
  var CRC_T = (function () { var t = new Int32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  function crc32(u8) { var c = -1; for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (~c) >>> 0; }

  async function readCentral(file) {
    var tailLen = Math.min(file.size, 65557);
    var tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    var i = tailLen - 22;
    while (i >= 0 && tail.getUint32(i, true) !== 0x06054b50) i--;
    if (i < 0) throw new Error("notzip");
    var count = tail.getUint16(i + 10, true), cdSize = tail.getUint32(i + 12, true), cdOff = tail.getUint32(i + 16, true);
    if ((count === 0xffff || cdOff === 0xffffffff) && i >= 20 && tail.getUint32(i - 20, true) === 0x07064b50) {
      var e64 = Number(tail.getBigUint64(i - 20 + 8, true));
      var z = new DataView(await file.slice(e64, e64 + 56).arrayBuffer());
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    var cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer()), dec = new TextDecoder();
    var out = [], p = 0;
    while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
      var method = cd.getUint16(p + 10, true), crc = cd.getUint32(p + 16, true);
      var csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true);
      var nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
      var off = cd.getUint32(p + 42, true);
      var name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
      if (usize === 0xffffffff || csize === 0xffffffff || off === 0xffffffff) {     // ZIP64 extra field
        var x = p + 46 + nlen, xe = x + xlen;
        while (x + 4 <= xe) {
          var id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true), q = x + 4;
          if (id === 1) {
            if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
            if (off === 0xffffffff) { off = Number(cd.getBigUint64(q, true)); }
          }
          x += 4 + sz;
        }
      }
      out.push({ name: name, method: method, crc: crc, csize: csize, usize: usize, off: off });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }
  /** "Stronghold-Protocol/public/assets/x.png" → "/assets/x.png" (the game server's URL layout). */
  function zipKey(name) {
    var parts = name.split("/");
    if (["public", "data", "shared", "server"].indexOf(parts[0]) < 0) parts.shift();
    var rel = parts.join("/");
    if (rel.indexOf("public/") === 0) return /\.html$/i.test(rel) ? null : "/" + rel.slice(7);
    if (rel.indexOf("data/") === 0 || rel.indexOf("shared/") === 0) return "/" + rel;
    if (rel.indexOf("server/sim/") === 0) return "/sim/" + rel.slice(11);
    return null;
  }
  async function entryBlob(file, e) {
    var h = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error("bad entry");
    var start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    var comp = file.slice(start, start + e.csize);
    var buf;
    if (e.method === 0) buf = new Uint8Array(await comp.arrayBuffer());
    else if (e.method === 8) buf = new Uint8Array(await new Response(comp.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error("method " + e.method);
    if (buf.length !== e.usize || crc32(buf) !== e.crc) throw new Error("crc");
    return new Blob([buf]);
  }
  /**
   * Fill the cache from the game's full package. onProgress({ phase, done, total, bytes, totalBytes, matched, skipped, failed }).
   * Only entries whose CRC32 + size equal the hub's list are imported, so an older package still helps for the files that did not change.
   */
  async function importZip(file, onProgress, signal) {
    if (typeof DecompressionStream === "undefined") throw new Error("nodecomp");
    var m = await manifest();
    if (!m) throw new Error("nomanifest");
    var tell = onProgress || function () {};
    tell({ phase: "read", done: 0, total: 0 });
    var entries = await readCentral(file);
    var have = (await storedTags()).tags;
    var jobs = [], matched = 0, other = 0, already = 0;
    entries.forEach(function (e) {
      if (/\/$/.test(e.name)) return;
      var key = zipKey(e.name), tag = key && m.files[key];
      if (!tag || tag.charAt(0) === "=") return;
      if (tag !== e.crc.toString(16).padStart(8, "0") + "-" + e.usize.toString(36)) { other++; return; }
      matched++;
      if (have.get(key) === tag) { already++; return; }
      jobs.push({ e: e, key: key, tag: tag });
    });
    var totalBytes = jobs.reduce(function (s, j) { return s + j.e.usize; }, 0);
    var st = { phase: "import", done: 0, total: jobs.length, bytes: 0, totalBytes: totalBytes, matched: matched, already: already, other: other, failed: 0 };
    tell(st);
    askPersist();
    var next = 0, batch = [], batchBytes = 0, lastTell = 0;
    async function flush() { if (!batch.length) return; var b = batch; batch = []; batchBytes = 0; await putMany(b); }
    async function worker() {
      while (next < jobs.length) {
        if (signal && signal.aborted) return;
        var j = jobs[next++];
        try {
          var blob = await entryBlob(file, j.e);
          batch.push([j.key, { tag: j.tag, type: typeFor(j.key), size: blob.size, blob: blob, at: Date.now() }]);
          batchBytes += blob.size;
          if (batch.length >= 40 || batchBytes > 24 << 20) await flush();
          st.bytes += j.e.usize;
        } catch (e) { st.failed++; }
        st.done++;
        var now = Date.now(); if (now - lastTell > 250) { lastTell = now; tell(st); }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    await flush();
    st.phase = signal && signal.aborted ? "aborted" : "done";
    tell(st);
    return st;
  }

  async function info() {
    var m = await manifest();
    if (!m) return { available: false, enabled: enabled() };
    var st = await storedTags(), files = 0, bytes = 0;
    st.tags.forEach(function (tag, key) { if (m.files[key] === tag) { files++; bytes += sizeOf(tag); } });
    var est = null;
    try { if (navigator.storage && navigator.storage.estimate) est = await navigator.storage.estimate(); } catch (e) {}
    return { available: true, enabled: enabled(), files: files, bytes: bytes, totalFiles: m.count, totalBytes: m.bytes, version: m.version,
      quota: est && est.quota || null, usage: est && est.usage || null };
  }
  async function clear() {
    try { var d = await db(); d.close(); } catch (e) {}
    dbP = null; manifestP = null;
    await new Promise(function (res) { var r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = function () { res(); }; });
  }
  function setEnabled(on) { try { localStorage.setItem(MODE_KEY, on ? "on" : "off"); } catch (e) {} }

  window.SHCache = { active: active, supported: hasIDB, enabled: enabled, setEnabled: setEnabled, info: info, clear: clear, importZip: importZip, stats: stats,
    canImport: typeof DecompressionStream !== "undefined" };
})();
