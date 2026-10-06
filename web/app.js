// Stronghold Host Panel — client. State arrives over SSE; actions are POSTs.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Shanghai" }); } catch { return ""; } };
const fmtUp = (s) => s == null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m`;
const GiB = (b) => (b / 1073741824).toFixed(2) + " GiB";

let S = null;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
function act(action, extra) {
  return fetch("/api/action", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Stronghold-Panel": "1" },
    body: JSON.stringify({ action, ...(extra || {}) }),
  }).catch(() => toast("面板无响应"));
}

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "state") { const first = !S; S = d.state; render(); if (first) fillConfig(); }
    else if (d.type === "log") addLine(d);
    else if (d.type === "bw") { if (S) { S.bw = d.bw; renderBw(); } }
    else if (d.type === "progress") renderProgress(d);
  };
  es.onerror = () => { setState($("hgame"), "bad", "面板离线"); };
}
connect();

// ---------------------------------------------------------------------------
// state rendering
// ---------------------------------------------------------------------------
const GAME = { running: ["ok", "运行中"], starting: ["busy", "启动中"], stopping: ["busy", "停止中"], error: ["bad", "异常"], stopped: ["", "已停止"] };
const TUN = { connected: ["ok", "已连接"], connecting: ["busy", "连接中"], error: ["bad", "异常"], off: ["", "未连接"] };

function setState(el, tone, text) { el.dataset.tone = tone; el.textContent = text; }

function render() {
  if (!S) return;
  const g = GAME[S.game] || ["", S.game], t = TUN[S.tunnel] || ["", S.tunnel];
  setState($("hgame"), ...g); setState($("gamestate"), ...g);
  setState($("htun"), ...t); setState($("tunstate"), ...t);
  setState($("hhub"), S.hub.bound ? "ok" : "bad", S.hub.bound ? "在线" : "端口被占");
  $("hubwarn").classList.toggle("hidden", S.hub.bound);
  $("hubport").textContent = S.port;

  const h = S.health;
  $("hplayers").textContent = h ? h.humans : "—";
  $("ver").textContent = S.version || "未安装";
  $("gver").textContent = (S.version || "未安装") + (S.latestVersion && !S.updateAvailable ? "  · 已是最新" : "");
  $("gup").textContent = h ? fmtUp(h.uptimeSec) : "—";
  $("gport").textContent = S.hub.bound ? `127.0.0.1:${S.gamePort}  ←  中转 :${S.port}` : `0.0.0.0:${S.port}（直连）`;

  $("tunaddr").textContent = S.publicUrl || "未设置";
  const n = S.sakura && S.sakura.myNode;
  $("tunnode").textContent = n ? n.name : (S.config.nodeName || "—");

  // update
  const up = S.update || {};
  const busy = up.phase === "downloading" || up.phase === "installing";
  $("updatecard").classList.toggle("hidden", !(S.updateAvailable || busy));
  $("updtag").textContent = `${S.version || "—"} → ${S.latestVersion || ""}`;
  $("updsize").textContent = S.latestSize ? ` · ${(S.latestSize / 1048576).toFixed(0)} MB` : "";
  $("updbar").classList.toggle("hidden", !busy);
  $("btnupd").disabled = busy;
  if (busy) $("updroute").textContent = up.phase === "installing" ? "正在安装…" : `下载中（${up.route}）`;

  // links
  $("plink").textContent = S.publicUrl || "未设置 — 在设置里填写";
  $("hublink").textContent = S.playUrl || "—";
  renderQR(S.publicUrl);

  // notice
  const live = S.notice && S.notice.text;
  setState($("noticestate"), live ? "ok" : "", live ? "播报中" : "无");
  const nc = $("noticecur");
  nc.classList.toggle("off", !live);
  nc.innerHTML = live ? `<span class="micro" style="color:var(--gold)">Live · ${fmtT(S.notice.at)}</span><div style="margin-top:4px">${esc(live)}</div>` : "当前没有公告";

  renderLAN(); renderLive(); renderConns(); renderBw(); renderSakura();
}

function renderLAN() {
  const el = $("lanlist");
  if (!S.lan.length) { el.innerHTML = '<div class="empty">没有检测到局域网接口</div>'; return; }
  el.innerHTML = S.lan.map((l) => `<div class="field"><span class="val">${esc(l.url)}</span>
    <span class="btn btn--ghost" style="cursor:default;color:var(--text-dim)">${esc(l.iface)}</span>
    <button class="btn btn--ghost" data-copytext="${esc(l.url)}">复制</button></div>`).join("");
}

function renderLive() {
  const h = S.health;
  const tile = (v, label, hl) => `<div class="tile"><b class="${hl ? "hl" : ""}">${v ?? "—"}</b><span class="micro">${label}</span></div>`;
  $("livestats").innerHTML = h
    ? tile(h.humans, "Players", h.humans > 0) + tile(h.rooms, "Rooms") + tile(h.matches, "In match") +
      tile(h.bots, "Bots") + tile(h.spectators, "Watching") + tile(h.sockets, "Sockets")
    : `<div class="tile" style="grid-column:1/-1"><span class="empty">游戏未运行</span></div>`;
  $("healthmeta").textContent = h ? `UP ${fmtUp(h.uptimeSec)}` : "";

  const rooms = S.rooms || [];
  const chip = (m) => `<span class="mem${m.host ? " host" : ""}${m.bot ? " bot" : ""}${m.online ? "" : " off"}" title="${m.host ? "房主" : m.bot ? "AI" : m.online ? (m.ready ? "已准备" : "未准备") : "离线"}">${esc(m.name)}${m.ready && !m.host && !m.bot ? '<i>✓</i>' : ""}</span>`;
  $("rooms").innerHTML = rooms.length
    ? `<table class="t"><tr><th>Room</th><th>Members</th><th>Mode</th><th>Status</th></tr>${rooms.map((r) => `<tr>
        <td class="code">${esc(r.code)}</td>
        <td><div class="mems">${r.members ? r.members.map(chip).join("") + (r.watchers || []).map((w) => `<span class="mem watch${w.online ? "" : " off"}" title="观战">${esc(w.name)}<i>观</i></span>`).join("")
          : `<span class="mem host">${esc(r.host || "?")}</span>`}</div></td>
        <td class="dim">${esc(r.mode || "")}${r.difficulty ? " · " + esc(r.difficulty) : ""}${r.capacity ? ` · ${r.members.length}/${r.capacity}` : ""}</td>
        <td>${r.status === "in match" ? '<span class="tag busy">对局中</span>' : '<span class="tag open">可加入</span>'}</td></tr>`).join("")}</table>`
    : '<div class="empty">暂无房间 — 在大厅创建后会出现在这里</div>';
  $("activity").innerHTML = (S.activity || []).map((a) => `<li><span class="t">${fmtT(a.t)}</span><span>${esc(a.text)}</span></li>`).join("");
}

function renderConns() {
  const c = S.connections || [];
  const total = c.reduce((s, x) => s + x.sockets, 0);
  $("conncount").textContent = total ? `${total} SOCKETS` : "";
  $("conntable").innerHTML = c.length
    ? `<table class="t"><tr><th>Address</th><th>Via</th><th>Sockets</th></tr>${c.map((x) => `<tr>
        <td class="num">${esc(x.address)}</td><td><span class="tag ${x.via}">${x.via === "tunnel" ? "隧道" : "局域网"}</span></td>
        <td class="num">${x.sockets}</td></tr>`).join("")}</table>`
    : '<div class="empty">没有人连接</div>';
}

function renderBw() {
  const b = S.bw; if (!b) return;
  const lim = b.limitMbps || 10, peak = Math.max(b.tunnelIn, b.tunnelOut);
  const pct = Math.min(100, (peak / lim) * 100);
  $("bwin").textContent = b.tunnelIn.toFixed(2);
  $("bwout").textContent = b.tunnelOut.toFixed(2);
  $("bwlim").textContent = lim; $("bwlim2").textContent = lim;
  $("bwpct").textContent = pct.toFixed(0) + "%";
  $("hbw").textContent = `${b.tunnelIn.toFixed(1)} / ${b.tunnelOut.toFixed(1)}`;
  const bar = $("bwbar");
  bar.style.width = pct + "%";
  bar.style.background = pct > 85 ? "var(--red)" : pct > 60 ? "var(--amber)" : "var(--mint)";
  renderUsage();
  $("bwtot").textContent = `局域网 ↓${b.lanIn.toFixed(2)} ↑${b.lanOut.toFixed(2)} Mbps · 本次累计 ↓${b.totalInMB.toFixed(1)} MB ↑${b.totalOutMB.toFixed(1)} MB`;
  // sparkline over the last 90 samples (3 min)
  const hist = b.history || [];
  const top = Math.max(lim * 1.1, ...hist, 0.1);
  const pts = hist.map((v, i) => `${(i / 89) * 90},${40 - (v / top) * 38}`).join(" ");
  const limY = 40 - (lim / top) * 38;
  $("spark").innerHTML = hist.length > 1
    ? `<line class="lim" x1="0" x2="90" y1="${limY}" y2="${limY}"/><polygon class="ar" points="0,40 ${pts} ${((hist.length - 1) / 89) * 90},40"/><polyline class="ln" points="${pts}"/>`
    : "";
}

function renderUsage() {
  const u = S.usage; if (!u) return;
  const g = (b) => (b / 1073741824).toFixed(2), pct = u.pct || 0;
  const cls = pct >= 95 ? "bad" : pct >= 80 ? "warn" : "";
  const col = cls === "bad" ? "var(--red)" : cls === "warn" ? "var(--amber)" : "var(--mint)";
  $("qused").textContent = g(u.usedBytes); $("qlim").textContent = +(u.limitBytes / 1073741824).toFixed(2);
  $("qpct").textContent = Math.round(pct) + "%"; $("qpct").style.color = col;
  $("qbar").style.width = Math.min(100, pct) + "%"; $("qbar").style.background = col;
  $("hquota").textContent = `${g(u.usedBytes)} / ${+(u.limitBytes / 1073741824).toFixed(2)}`;
  $("hqbar").style.width = Math.min(100, pct) + "%"; $("hqbar").style.background = col;
  $("hquota").style.color = cls ? col : "";
  $("qsrc").textContent = `中转统计 ${g(u.hubBytes)} GiB · SakuraFrp 记录 ${u.sakuraBytes == null ? "—" : g(u.sakuraBytes) + " GiB"} · 取较大值` +
    ` · 局域网 ${g(u.lanBytes)} GiB 不计`;
  const auto = S.autoNotice;
  $("qtag").className = "tag" + (auto ? " busy" : " hidden"); $("qtag").textContent = auto ? "玩家提醒中" : "";
  $("qclear").classList.toggle("hidden", !auto);
  $("usagebanner").classList.toggle("hidden", pct < 80);
  $("usagebanner").classList.toggle("alert--bad", pct >= 95);
  $("usagetitle").textContent = pct >= 100 ? `今日流量已超过上限：${g(u.usedBytes)} / ${g(u.limitBytes)} GiB` : `今日流量已用 ${Math.round(pct)}%：${g(u.usedBytes)} / ${g(u.limitBytes)} GiB`;
  $("usagehint").textContent = "不会自动停服，只是提醒你。" + (auto ? `玩家正在看到：「${auto.text}」` : u.autoBroadcast ? "" : "自动提醒玩家已关闭。");
  $("btnusageclear").classList.toggle("hidden", !auto);
  $("btnusagesend").classList.toggle("hidden", !!auto);
}

function renderSakura() {
  const s = S.sakura || {}, u = s.user, n = s.myNode, el = $("sakuraacct");
  if (n && !n.notFound) setState($("nodestate"), n.online ? "ok" : n.online === false ? "bad" : "", n.online ? "节点在线" : n.online === false ? "节点离线" : "节点未知");
  else setState($("nodestate"), "", "—");
  const needSign = !!(u && u.sign && u.sign.config !== false && u.sign.signed === false);
  $("signbanner").classList.toggle("hidden", !needSign);
  if (!u && !n) {
    el.innerHTML = `<div class="empty">${S.config.hasToken ? "正在读取 api.natfrp.com…" : "未找到访问密钥 — 在设置里填写，或确认 frpc.ini 中有 user = …"}</div>`;
    return;
  }
  let rows = "";
  if (u) {
    const today = u.traffic ? u.traffic[0] : 0, left = u.traffic ? u.traffic[1] : 0;
    rows += `<dt>用户</dt><dd>${esc(u.name || "")} <span class="dim">· ${esc(u.group?.name || u.speed || "")}</span></dd>
      <dt>剩余流量</dt><dd class="num" style="color:${left < 1073741824 ? "var(--red)" : "var(--mint)"}">${GiB(left)}</dd>
      <dt>今日已用</dt><dd class="num">${GiB(today)}</dd>`;
    if (Array.isArray(s.plans)) rows += `<dt>流量包</dt><dd>${s.plans.length} 个有效</dd>`;
    if (u.sign && u.sign.config !== false)
      rows += `<dt>签到</dt><dd>${u.sign.signed ? '<span class="tag open">今日已签</span>' : '<span class="tag busy">未签到</span>'} <span class="dim">· 连续 ${u.sign.days} 天 · 累计 ${u.sign.traffic} GiB</span></dd>`;
  }
  if (n) {
    rows += n.notFound
      ? `<dt>节点</dt><dd class="dim">未找到「${esc(n.name)}」。可选：${(n.known || []).map(esc).join("、")}</dd>`
      : `<dt>节点</dt><dd>${esc(n.name)}${n.load != null ? ` <span class="dim">· 负载 <span class="num">${n.load}%</span></span>` : ""}${n.uptimeHours != null ? ` <span class="dim">· 运行 <span class="num">${n.uptimeHours}h</span></span>` : ""}</dd>`;
  }
  el.innerHTML = `<dl class="kv">${rows}</dl>`;
}

function renderProgress(d) {
  const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
  $("updprog").style.width = pct + "%";
  $("updroute").textContent = `下载中 ${(d.received / 1048576).toFixed(1)} / ${(d.total / 1048576).toFixed(0)} MB${S && S.update.route ? "（" + S.update.route + "）" : ""}`;
}

let qrFor = "";
function renderQR(url) {
  const box = $("qr");
  if (!url) { box.classList.add("hidden"); return; }
  if (qrFor === url || typeof qrcode === "undefined") return;
  try {
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    box.innerHTML = qr.createImgTag(4, 0);
    box.classList.remove("hidden");
    qrFor = url;
  } catch {}
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------
let tab = "all", filter = "", autoscroll = true;
const box = $("logbox");
const ERR = /error|fail|refused|denied|exception|失败|错误|异常/i;
const visible = (el) => (tab === "all" || el.dataset.src === tab) && (!filter || el.dataset.q.includes(filter));

function addLine(d) {
  const el = document.createElement("div");
  el.className = `ln-row ${d.source}${ERR.test(d.line) ? " err" : ""}`;
  el.dataset.src = d.source;
  el.dataset.q = d.line.toLowerCase();
  el.innerHTML = `<span class="t">${fmtT(d.t)}</span><span class="s">${d.source}</span><span class="m">${esc(d.line)}</span>`;
  if (!visible(el)) el.style.display = "none";
  box.appendChild(el);
  while (box.children.length > 2000) box.removeChild(box.firstChild);
  if (autoscroll) box.scrollTop = box.scrollHeight;
}
function refilter() {
  for (const el of box.children) el.style.display = visible(el) ? "" : "none";
  if (autoscroll) box.scrollTop = box.scrollHeight;
}
$("logtabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-t]"); if (!b) return;
  tab = b.dataset.t;
  for (const x of $("logtabs").children) x.classList.toggle("active", x === b);
  refilter();
});
$("logfilter").addEventListener("input", (e) => { filter = e.target.value.trim().toLowerCase(); refilter(); });
$("btnscroll").onclick = () => { autoscroll = !autoscroll; $("btnscroll").classList.toggle("is-on", autoscroll); if (autoscroll) box.scrollTop = box.scrollHeight; };
$("btnclear").onclick = () => { box.innerHTML = ""; };
box.addEventListener("scroll", () => {   // scrolling up pauses auto-scroll; back to bottom resumes
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  if (atBottom !== autoscroll) { autoscroll = atBottom; $("btnscroll").classList.toggle("is-on", autoscroll); }
});

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------
const CONFIRM = { stopAll: "停止游戏和隧道？正在玩的人会断线。", stopGame: "停止游戏服务器？正在玩的人会断线。", restartGame: "重启游戏服务器？正在玩的人会断线。" };
document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-act]");
  if (a) {
    const name = a.dataset.act;
    const players = S && S.health ? S.health.humans : 0;
    if (CONFIRM[name] && players > 0 && !confirm(CONFIRM[name])) return;
    act(name); return;
  }
  const c = e.target.closest("[data-copy],[data-copytext]");
  if (c) {
    const text = c.dataset.copytext || (S && S[c.dataset.copy]);
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast("已复制"); } catch { prompt("手动复制：", text); }
    return;
  }
  const chip = e.target.closest(".chip");
  if (chip) { $("noticetext").value = chip.textContent; $("noticetext").focus(); }
});
$("btnsession").onclick = () => act("startSession");
$("btnstopall").onclick = () => { const p = S && S.health ? S.health.humans : 0; if (p > 0 && !confirm(CONFIRM.stopAll)) return; act("stopAll"); };
$("btnnotice").onclick = () => { const t = $("noticetext").value.trim(); if (!t) return $("noticetext").focus(); act("setNotice", { text: t }); toast("公告已发布"); };
$("noticetext").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnnotice").click(); });
$("btnnotclear").onclick = () => { $("noticetext").value = ""; act("setNotice", { text: "" }); toast("公告已撤下"); };

function fillConfig() {
  const c = S.config;
  $("cfgurl").value = c.publicUrl || "";
  $("cfgbin").value = c.frpcBin || "";
  $("cfgcfg").value = c.frpcConfig || "";
  $("cfgnode").value = c.nodeName || "";
  $("cfgspeed").value = c.speedLimitMbps || 10;
  $("cfgdaily").value = c.dailyLimitGB ?? 2;
  $("cfgautob").checked = c.dailyAutoBroadcast !== false;
  $("cfgtok").placeholder = c.hasToken ? (c.tokenFromIni ? "已从 frpc.ini 读取" : "已保存 — 留空不修改") : "未设置";
}
$("btnsave").onclick = () => {
  act("saveConfig", { config: {
    publicUrl: $("cfgurl").value, frpcBin: $("cfgbin").value, frpcConfig: $("cfgcfg").value,
    nodeName: $("cfgnode").value, speedLimitMbps: $("cfgspeed").value, sakuraToken: $("cfgtok").value,
    dailyLimitGB: $("cfgdaily").value, dailyAutoBroadcast: $("cfgautob").checked,
  } });
  $("cfgtok").value = "";
  toast("设置已保存");
};

// theme: auto → light → dark
const THEMES = ["auto", "light", "dark"], THEME_LABEL = { auto: "自动", light: "浅色", dark: "深色" };
const mq = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "auto" && mq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.pref = pref;
  $("btntheme").textContent = THEME_LABEL[pref];
}
applyTheme(new URLSearchParams(location.search).get("theme") || localStorage.getItem("sh-theme") || "auto");
mq.addEventListener("change", () => applyTheme(document.documentElement.dataset.pref));
$("btntheme").onclick = () => {
  const next = THEMES[(THEMES.indexOf(document.documentElement.dataset.pref) + 1) % 3];
  localStorage.setItem("sh-theme", next); applyTheme(next);
};

let toastT;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 1400);
}
