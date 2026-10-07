// Stronghold Host Panel — client. State arrives over SSE; actions are POSTs. Text: 中文 by default, English via I18N.
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, timeZone: "Asia/Shanghai" }); } catch { return ""; } };
const fmtUp = (s) => s == null ? "—" : s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m`;
const GiB = (b) => (b / 1073741824).toFixed(2) + " GiB";
const MB = (b) => (b / 1048576).toFixed(b >= 1048576 * 100 ? 0 : 1) + " MB";
const bytes = (b) => b == null ? "—" : b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : (b / 1048576).toFixed(0) + " MB";
const dur = (s) => s == null ? "—" : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
const { T } = I18N;
const EN = I18N.lang === "en";

I18N.add({
  "卫戍协议 · 主机面板": "Stronghold Protocol · Host panel",
  "开始联机": "Start session", "全部停止": "Stop all", "自动": "Auto", "浅色": "Light", "深色": "Dark",
  "主题：自动 / 浅色 / 深色": "Theme: auto / light / dark", "界面语言 / Language": "Language / 界面语言",
  "端口 :": "Port :", "被其他进程占用": "is held by another process",
  "中转站、离线页和公告暂时不可用，玩家会直接连到旧进程。点「重启」会清掉占用进程并接管端口。": "The hub, the offline page and announcements are unavailable, and players reach the old process directly. Restart stops that process and takes the port back.",
  "重启并接管": "Restart and take over", "今日流量已用 80%": "80% of today's data used",
  "不会自动停服，只是提醒你。": "Nothing stops automatically. This is only a reminder.", "撤下玩家提醒": "Remove player notice", "提醒玩家": "Notify players",
  "今日 SakuraFrp 免费流量还没签到": "Today's SakuraFrp free data is not claimed yet",
  "官方 API 不提供签到接口，只能在主站完成。打开后点「点击签到」即可。": "The API has no check-in call, so do it on the website: open it and click 点击签到.",
  "去签到": "Check in", "游戏有新版本": "New game version",
  "下载和解压期间游戏继续运行；安装时玩家会看到离线页和你的公告，装好后自动重启。旧版本保留在 previous/。": "The game keeps running while the package downloads and extracts. During the install, players see the offline page and your announcement, and the game restarts after it. The old version stays in previous/.",
  "停止下载素材": "Stop art download", "知道了": "OK", "下载并安装": "Download and install",
  "游戏素材未下载": "Game art is not downloaded", "换成完整包": "Switch to full package", "下载素材": "Download art",
  "游戏服务器": "Game server", "版本": "Version", "安装包": "Package", "运行时长": "Uptime", "监听": "Listening",
  "启动": "Start", "重启": "Restart", "停止": "Stop", "停止、清理占用端口的旧进程，再启动": "Stop, clear old processes on the port, then start",
  "打开大厅": "Open lobby", "检查更新": "Check for update", "游戏目录": "Game folder",
  "穿透隧道": "Tunnel", "公网地址": "Public address", "节点": "Node", "连接": "Connect", "断开": "Disconnect",
  "frpc 以命令行运行，不需要打开 Sakura 启动器。断开时会顺便清理残留的 frpc 进程，避免「隧道已在线」。": "frpc runs from the command line, so the Sakura launcher is not needed. Disconnect also ends leftover frpc processes, which prevents 隧道已在线 errors.",
  "SakuraFrp 账户": "SakuraFrp account", "正在连接 api.natfrp.com…": "Connecting to api.natfrp.com…",
  "设置": "Settings", "公网地址（发给玩家）": "Public address (for players)", "留空 = 从 frpc.ini 自动生成": "Empty = from frpc.ini",
  "监控节点": "Node to watch", "留空 = 按 frpc.ini 自动识别": "Empty = from frpc.ini", "frpc 程序路径": "frpc program path",
  "frpc 配置路径": "frpc config path", "SakuraFrp 访问密钥": "SakuraFrp access key (访问密钥)", "带宽上限 (Mbps)": "Bandwidth limit (Mbps)",
  "每日流量上限 (GiB)": "Daily data limit (GiB)", "游戏安装包": "Game package",
  "完整包（推荐，约 430 MB）": "Full (recommended, about 430 MB)", "精简包（约 22 MB，素材另下约 460 MB）": "Lite (about 22 MB, art about 460 MB more)",
  "到 80% / 95% / 100% 时自动提醒玩家": "Notify players at 80% / 95% / 100%",
  "玩家浏览器保存游戏文件，重连不再走隧道下载": "Players' browsers keep the game files, so a reconnect downloads nothing through the tunnel",
  "保存设置": "Save settings", "访问密钥留空则保留已保存的值，或自动从 frpc.ini 的": "An empty key keeps the saved one, or the panel reads", "读取。": "from frpc.ini.",
  "玩家入口": "Player access", "先到中转站，看人数和房间": "Opens the hub with players and rooms", "复制": "Copy", "打开": "Open",
  "跳过中转站": "Skips the hub", "手机用流量扫码测试": "Scan with mobile data to test",
  "手机关掉 Wi-Fi、用流量扫码，可以在开局前先测一遍外网能不能进。": "Turn off Wi-Fi on your phone and scan with mobile data to test outside access before a match.",
  "全员公告": "Announcement", "例：5 分钟后重启服务器更新游戏": "Example: server restarts in 5 minutes for an update", "发布": "Publish", "撤下": "Remove",
  "5 分钟后重启服务器更新游戏，请尽快结束对局": "The server restarts in 5 minutes for a game update. Please finish your match.",
  "服务器正在更新，几分钟后回来": "The server is updating. Back in a few minutes.", "服务器即将关闭，感谢游玩": "The server closes soon. Thanks for playing.",
  "Today · 流量": "Today", "Player link · 玩家链接": "Player link", "Direct · 直接进游戏": "Direct", "Memory · 内存": "Memory",
  "Today · 今日用量 (UTC+8)": "Today (UTC+8)", "Down · 玩家上传": "Down · from players", "Up · 发给玩家": "Up · to players",
  "当前没有公告": "No announcement", "5 秒内出现在所有玩家屏幕顶部，包括对局中、中转站和离线页。": "Shows at the top of every player's screen within 5 s: in matches, on the hub and on the offline page.",
  "局域网": "LAN", "同一 Wi-Fi / 网线下的设备直接用这个地址，不走隧道、不占流量，延迟最低。": "Devices on the same Wi-Fi or cable use this address directly: no tunnel, no data use, lowest latency.",
  "战况": "Live", "主机负载": "Host load", "最近 3 分钟 CPU": "CPU, last 3 minutes", "最近 3 分钟内存": "Memory, last 3 minutes",
  "CPU 按整台电脑计算（100% = 所有核心）；内存为常驻内存，不含文件缓存。": "CPU is for the whole computer (100% = all cores). Memory is resident memory, without the file cache.",
  "当前连接": "Connections",
  "「隧道」来自 SakuraFrp，所有外网玩家共用 127.0.0.1（frpc），看 socket 数判断热度；「局域网」显示真实设备 IP。": "Tunnel traffic comes through SakuraFrp, so all remote players share 127.0.0.1 (frpc): the socket count shows activity. LAN rows show real device IPs.",
  "隧道流量": "Tunnel traffic", "上限": "Limit", "发送流量提醒": "Send data notice", "撤下提醒": "Remove notice",
  "最近 3 分钟隧道流量": "Tunnel traffic, last 3 minutes", "日志": "Logs", "全部": "All", "面板": "Panel", "游戏": "Game", "隧道": "Tunnel",
  "筛选…": "Filter…", "自动滚动": "Auto-scroll", "清屏": "Clear",
  // dynamic
  "面板无响应": "The panel does not answer", "面板离线": "Panel offline", "运行中": "Running", "启动中": "Starting", "停止中": "Stopping",
  "异常": "Error", "已停止": "Stopped", "已连接": "Connected", "连接中": "Connecting", "未连接": "Not connected", "在线": "Online", "端口被占": "Port taken",
  "未安装": "Not installed", "  · 已是最新": "  · up to date", "中转 :{p}": "hub :{p}", "（直连）": " (direct)", "未设置": "Not set",
  "未设置 — 在设置里填写": "Not set: enter it in Settings", "播报中": "Live", "无": "None",
  "没有检测到局域网接口": "No LAN interface found", "游戏未运行": "Game not running",
  "房主": "Host", "已准备": "Ready", "未准备": "Not ready", "离线": "Offline", "观战": "Watch", "观": "W",
  "对局中": "In match", "可加入": "Open", "加入": "Join", "复制邀请": "Copy invite", "复制观战链接": "Copy watch link",
  "在这台电脑上打开并加入": "Open on this computer and join", "在这台电脑上打开并观战": "Open on this computer and watch",
  "暂无房间 — 在大厅创建后会出现在这里": "No rooms yet. Rooms created in the lobby show here.",
  "没有人连接": "Nobody is connected", "局域网 ↓{a} ↑{b} Mbps · 本次累计 ↓{c} MB ↑{d} MB": "LAN ↓{a} ↑{b} Mbps · this session ↓{c} MB ↑{d} MB",
  "中转统计 {a} GiB · SakuraFrp 记录 {b} · 取较大值 · 局域网 {c} GiB 不计": "Hub count {a} GiB · SakuraFrp record {b} · the larger one counts · LAN {c} GiB not counted",
  "玩家提醒中": "Players notified", "今日流量已超过上限：{a} / {b} GiB": "Today's data limit is passed: {a} / {b} GiB",
  "今日流量已用 {p}%：{a} / {b} GiB": "{p}% of today's data used: {a} / {b} GiB",
  "玩家正在看到：「{t}」": "Players see: \"{t}\"", "自动提醒玩家已关闭。": "Automatic player notices are off.",
  "节点在线": "Node online", "节点离线": "Node offline", "节点未知": "Node unknown",
  "正在读取 api.natfrp.com…": "Reading api.natfrp.com…", "未找到访问密钥 — 在设置里填写，或确认 frpc.ini 中有 user = …": "No access key: enter it in Settings, or make sure frpc.ini has user = …",
  "用户": "User", "剩余流量": "Data left", "今日已用": "Used today", "流量包": "Data plans", "{n} 个有效": "{n} active", "签到": "Check-in",
  "今日已签": "Done today", "未签到": "Not done", "连续 {d} 天 · 累计 {t} GiB": "{d} days in a row · {t} GiB in total",
  "未找到「{n}」。可选：{k}": "\"{n}\" not found. Available: {k}", "负载": "load", "运行": "up",
  "已复制": "Copied", "手动复制：": "Copy manually:", "公告已发布": "Announcement published", "公告已撤下": "Announcement removed", "设置已保存": "Settings saved",
  "留空 = 自动：{u}": "Empty = auto: {u}", "已从 frpc.ini 读取": "Read from frpc.ini", "已保存 — 留空不修改": "Saved. Leave empty to keep it.",
  "停止游戏和隧道？正在玩的人会断线。": "Stop the game and the tunnel? Players are disconnected.",
  "停止游戏服务器？正在玩的人会断线。": "Stop the game server? Players are disconnected.", "重启游戏服务器？正在玩的人会断线。": "Restart the game server? Players are disconnected.",
  "换成完整包会重新安装游戏，正在玩的人会断线。继续？": "Switching to the full package reinstalls the game and disconnects players. Continue?",
  // packages, install steps
  "完整包": "Full", "精简包": "Lite", "完整包 · {s}": "Full · {s}", "精简包 · {s}": "Lite · {s}",
  "素材完整": "art complete", "素材未下载": "art not downloaded", "缺 {m}/{t} 个素材文件": "{m} of {t} art files missing",
  "游戏素材未下载（玩家看到的是占位图）": "Game art is not downloaded (players see placeholder images)",
  "游戏素材不完整：缺 {m}/{t} 个文件": "Game art is incomplete: {m} of {t} files missing",
  "精简包第一次需要下载美术和音频（约 {s}，可续传，不走 GitHub）。完整包已带全部素材，还包括 3D 棋盘和召唤物模型。": "The lite package downloads its art and audio once (about {s}, resumable, not from GitHub). The full package has all art, also the 3D board and the summon models.",
  "已安装精简包。设置里选的是完整包：带 3D 棋盘和召唤物模型等本机客户端素材。": "The lite package is installed, but Settings select the full package: it adds the client-only art such as the 3D board and the summon models.",
  "可以换成完整包 {v}": "Full package {v} available", "游戏有新版本 {v}": "New game version {v}", "安装游戏 {v}": "Install the game {v}",
  "正在安装 {v}": "Installing {v}", "正在下载素材": "Downloading art", "安装完成": "Install complete", "素材下载完成": "Art download complete", "安装失败": "Install failed", "素材下载未完成": "Art download not complete",
  "重新安装为完整包": "Reinstall as full package", "重试": "Try again",
  "下载安装包": "Download package", "解压": "Extract", "替换文件": "Install files", "下载美术和音频": "Download art and audio", "启动游戏": "Start the game",
  "{a} / {b} · {s}/s · 剩余 {e}": "{a} / {b} · {s}/s · {e} left", "（{r}）": " ({r})", "{a} / {b} 个文件": "{a} / {b} files",
  "{l}：{a}/{b} 个文件 · 已下 {m} · {s} MB/s": "{l}: {a}/{b} files · {m} downloaded · {s} MB/s", "准备中…": "Preparing…", "用时 {t}": "took {t}",
  "旧版本在 previous/。": "The old version is in previous/.", "游戏继续运行。可以随时停止，下次会续传。": "The game keeps running. You can stop at any time: the next run resumes.", "素材已下载。重启游戏服务器后，玩家才能看到新素材（会断线）。": "The art is downloaded. Restart the game server so that players get it (they reconnect).",
  "失败步骤见日志（面板 / 游戏）。": "See the logs (Panel / Game) for the failed step.", "素材下载会续传：再点一次即可。": "The art download resumes: click again to continue.",
  // load
  "{n} 核": "{n} cores", "进程": "Process", "内存": "Memory", "游戏服务器（{n} 个进程）": "Game server ({n} processes)", "本面板": "This panel",
  "未运行": "not running", "磁盘剩余 {f} / {t}": "Disk free {f} / {t}", "负载均值 {l}": "load average {l}", "打开面板时每 2 秒采样": "sampled every 2 s while the panel is open",
  "玩家缓存：开启 · 可缓存 {n} 个文件（{s}）。玩家第一次进游戏后，再次连接只走联机数据；中转站还可以导入完整包，完全不走隧道。": "Player cache: on · {n} files ({s}) can be kept. After a player's first visit, a reconnect only uses game data. Players can also import the full package on the hub, with no tunnel traffic.",
  "玩家缓存：开启。": "Player cache: on.", "玩家缓存：关闭（设置里可开启）。每次连接都会重新下载游戏文件。": "Player cache: off (turn it on in Settings). Every visit downloads the game files again.",
  // activity
  "房间 {code} 已创建：{who}（{mode}/{difficulty}）": "Room {code} created by {who} ({mode}/{difficulty})",
  "房间 {code} 开局（{seats} 席）": "Room {code}: match started ({seats} seats)", "房间 {code} 对局结束": "Room {code}: match ended",
  "房间 {code}：房主移出了 {who}": "Room {code}: the host removed {who}", "房间 {code}：房主变为 {who}": "Room {code}: {who} is now the host",
  "房间 {code} 已关闭（{why}）": "Room {code} closed ({why})",
});
I18N.apply(document.body);
$("btnlang").textContent = EN ? "中文" : "EN";
$("btnlang").onclick = () => { const next = EN ? "zh" : "en"; act("setLang", { lang: next }); I18N.set(next); };

let S = null;

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
function act(action, extra) {
  return fetch("/api/action", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Stronghold-Panel": "1" },
    body: JSON.stringify({ action, ...(extra || {}) }),
  }).catch(() => toast(T("面板无响应")));
}

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.type === "state") { const first = !S; S = d.state; render(); if (first) fillConfig(); }
    else if (d.type === "log") addLine(d);
    else if (d.type === "bw") { if (S) { S.bw = d.bw; renderBw(); } }
    else if (d.type === "sys") { if (S) { S.sys = d.sys; renderSys(); } }
    else if (d.type === "progress") { if (S) { S.update = d.update; renderUpdate(); } }
  };
  es.onerror = () => { setState($("hgame"), "bad", T("面板离线")); };
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
  setState($("hgame"), g[0], T(g[1])); setState($("gamestate"), g[0], T(g[1]));
  setState($("htun"), t[0], T(t[1])); setState($("tunstate"), t[0], T(t[1]));
  setState($("hhub"), S.hub.bound ? "ok" : "bad", S.hub.bound ? T("在线") : T("端口被占"));
  $("hubwarn").classList.toggle("hidden", S.hub.bound);
  $("hubport").textContent = S.port;

  const h = S.health;
  $("hplayers").textContent = h ? h.humans : "—";
  $("ver").textContent = S.version || T("未安装");
  $("gver").textContent = (S.version || T("未安装")) + (S.latestVersion && !S.updateAvailable && S.version ? T("  · 已是最新") : "");
  $("gup").textContent = h ? fmtUp(h.uptimeSec) : "—";
  $("gport").textContent = S.hub.bound ? `127.0.0.1:${S.gamePort}  ←  ${T("中转 :{p}", { p: S.port })}` : `0.0.0.0:${S.port}${T("（直连）")}`;
  $("gpkg").textContent = pkgText();

  $("tunaddr").textContent = S.publicUrl || T("未设置");
  const n = S.sakura && S.sakura.myNode;
  $("tunnode").textContent = n ? n.name : (S.config.nodeName || "—");

  renderUpdate(); renderAssets();

  // links
  $("plink").textContent = S.publicUrl || T("未设置 — 在设置里填写");
  $("hublink").textContent = S.playUrl || "—";
  renderQR(S.publicUrl);
  const pc = S.playerCache || {};
  $("cacheinfo").textContent = !pc.on ? T("玩家缓存：关闭（设置里可开启）。每次连接都会重新下载游戏文件。")
    : pc.count ? T("玩家缓存：开启 · 可缓存 {n} 个文件（{s}）。玩家第一次进游戏后，再次连接只走联机数据；中转站还可以导入完整包，完全不走隧道。", { n: pc.count.toLocaleString(), s: bytes(pc.bytes) })
    : T("玩家缓存：开启。");

  // notice
  const live = S.notice && S.notice.text;
  setState($("noticestate"), live ? "ok" : "", live ? T("播报中") : T("无"));
  const nc = $("noticecur");
  nc.classList.toggle("off", !live);
  nc.innerHTML = live ? `<span class="micro" style="color:var(--gold)">Live · ${fmtT(S.notice.at)}</span><div style="margin-top:4px">${esc(live)}</div>` : esc(T("当前没有公告"));

  renderLAN(); renderLive(); renderConns(); renderBw(); renderSakura(); renderSys();
}

function pkgText() {
  if (!S.version) return "—";
  const p = S.installedPackage === "lite" ? "精简包" : "完整包";
  const a = S.assets;
  const st = !a ? "" : a.status === "ok" ? T("素材完整") : a.status === "missing" ? T("素材未下载") : a.status === "partial" ? T("缺 {m}/{t} 个素材文件", { m: a.missing, t: a.total }) : "";
  return st ? T(p + " · {s}", { s: st }) : T(p);
}

// ---- install / update card ------------------------------------------------------------------------------------
const STEP_NAME = { download: "下载安装包", extract: "解压", install: "替换文件", assets: "下载美术和音频", start: "启动游戏" };
let dismissedAt = 0;
function renderUpdate() {
  if (!S) return;
  const u = S.update || {}, running = u.phase === "running";
  const finished = (u.phase === "done" || u.phase === "error") && u.endedAt && u.endedAt > dismissedAt;
  const offer = S.updateAvailable || S.packageSwitch || (!S.version && S.latestVersion);
  const card = $("updatecard");
  card.classList.toggle("hidden", !(running || finished || offer));
  card.classList.toggle("alert--bad", u.phase === "error" && finished && !running);
  const size = S.latestSize ? ` · ${(S.latestSize / 1048576).toFixed(0)} MB` : "";
  const pkgName = S.latestPackage === "lite" ? T("精简包") : T("完整包");
  let title, hint = T("下载和解压期间游戏继续运行；安装时玩家会看到离线页和你的公告，装好后自动重启。旧版本保留在 previous/。");
  if (running) {
    title = u.kind === "assets" ? T("正在下载素材") : T("正在安装 {v}", { v: u.tag || "" });
    if (u.kind === "assets") hint = T("游戏继续运行。可以随时停止，下次会续传。");
  }
  else if (finished && u.phase === "done") { title = u.kind === "assets" ? T("素材下载完成") : T("安装完成"); hint = u.restartHint ? T("素材已下载。重启游戏服务器后，玩家才能看到新素材（会断线）。") : u.kind === "assets" || !u.from ? "" : T("旧版本在 previous/。"); }
  else if (finished) { title = u.kind === "assets" ? T("素材下载未完成") : T("安装失败"); hint = u.error === "assets" ? T("素材下载会续传：再点一次即可。") : T("失败步骤见日志（面板 / 游戏）。"); }
  else if (S.packageSwitch) { title = T("可以换成完整包 {v}", { v: S.latestVersion }); hint = T("已安装精简包。设置里选的是完整包：带 3D 棋盘和召唤物模型等本机客户端素材。"); }
  else title = S.version ? T("游戏有新版本 {v}", { v: S.latestVersion }) : T("安装游戏 {v}", { v: S.latestVersion || "" });
  $("updtitle").textContent = title;
  $("updtag").textContent = running || finished || S.packageSwitch || !S.version ? "" : `${S.version} → ${S.latestVersion}`;
  $("updsize").textContent = running || finished ? "" : ` · ${pkgName}${size}`;
  $("updhint").textContent = hint;
  $("updhint").classList.toggle("hidden", !hint);

  const btn = $("btnupd");
  btn.classList.toggle("hidden", running || (finished && u.phase === "done"));
  btn.textContent = finished && u.phase === "error" ? T("重试") : S.packageSwitch ? T("重新安装为完整包") : T("下载并安装");
  btn.dataset.mode = finished && u.phase === "error" && u.kind === "assets" ? "assets" : S.packageSwitch && !S.updateAvailable ? "switch" : "update";
  $("btnupdok").classList.toggle("hidden", !(finished && !running));
  $("btnupdstop").classList.toggle("hidden", !(running && (u.steps || []).some((s) => s.id === "assets" && s.status === "run")));

  const ol = $("updsteps");
  const show = running || finished;
  ol.classList.toggle("hidden", !show);
  if (!show) return;
  ol.innerHTML = (u.steps || []).filter((s) => s.status !== "skip").map((s) => {
    let det = "", pct = null;
    if (s.id === "download" && (s.status === "run" || s.status === "done") && u.dl) {
      const d = u.dl;
      pct = d.total ? Math.min(100, (d.received / d.total) * 100) : null;
      det = s.status === "run"
        ? T("{a} / {b} · {s}/s · 剩余 {e}", { a: MB(d.received), b: d.total ? MB(d.total) : "?", s: MB(d.bps || 0), e: d.eta == null ? "—" : dur(d.eta) }) + (d.route ? T("（{r}）", { r: d.route }) : "")
        : MB(d.total || d.received);
    } else if (s.id === "extract" && s.status === "run" && u.ex) {
      pct = u.ex.total ? Math.min(100, (u.ex.files / u.ex.total) * 100) : null;
      det = T("{a} / {b} 个文件", { a: u.ex.files.toLocaleString(), b: u.ex.total ? u.ex.total.toLocaleString() : "?" });
    } else if (s.id === "assets" && (s.status === "run" || s.status === "fail") && u.as) {
      const a = u.as;
      if (a.total) { pct = s.status === "run" ? (a.done / a.total) * 100 : null; det = T("{l}：{a}/{b} 个文件 · 已下 {m} · {s} MB/s", { l: a.label, a: a.done.toLocaleString(), b: a.total.toLocaleString(), m: MB((a.mb || 0) * 1048576), s: (a.mbps || 0).toFixed(2) }); }
      else if (s.status === "run") det = T("准备中…");
    }
    if ((s.status === "done" || s.status === "fail") && s.secs != null && s.id !== "download") det = (det ? det + " · " : "") + T("用时 {t}", { t: dur(s.secs) });
    else if (s.status === "done" && s.id === "download" && s.secs != null) det += " · " + T("用时 {t}", { t: dur(s.secs) });
    return `<li class="${s.status}"><div><span class="s-name">${esc(T(STEP_NAME[s.id] || s.id))}</span>${det ? `<span class="s-det num">${esc(det)}</span>` : ""}</div>` +
      (pct != null && s.status === "run" ? `<div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : "") + "</li>";
  }).join("");
}
$("btnupd").onclick = () => {
  const mode = $("btnupd").dataset.mode;
  const players = S && S.health ? S.health.humans : 0;
  if (mode === "switch" && players > 0 && !confirm(T("换成完整包会重新安装游戏，正在玩的人会断线。继续？"))) return;
  act(mode === "assets" ? "fetchAssets" : mode === "switch" ? "switchPackage" : "applyUpdate");
};
$("btnupdok").onclick = () => { dismissedAt = Date.now(); renderUpdate(); };

function renderAssets() {
  const a = S.assets, busy = S.update && S.update.phase === "running";
  const show = !!(S.version && a && (a.status === "missing" || a.status === "partial") && !busy);
  $("assetbanner").classList.toggle("hidden", !show);
  if (!show) return;
  $("assettitle").textContent = a.status === "missing" ? T("游戏素材未下载（玩家看到的是占位图）") : T("游戏素材不完整：缺 {m}/{t} 个文件", { m: a.missing, t: a.total });
  $("assethint").textContent = T("精简包第一次需要下载美术和音频（约 {s}，可续传，不走 GitHub）。完整包已带全部素材，还包括 3D 棋盘和召唤物模型。", { s: a.bytes ? bytes(a.bytes) : "460 MB" });
  $("btnswitch").classList.toggle("hidden", !(S.latestAssets && S.latestAssets.full));
}

function renderLAN() {
  const el = $("lanlist");
  if (!S.lan.length) { el.innerHTML = `<div class="empty">${esc(T("没有检测到局域网接口"))}</div>`; return; }
  el.innerHTML = S.lan.map((l) => `<div class="field"><span class="val">${esc(l.url)}</span>
    <span class="btn btn--ghost" style="cursor:default;color:var(--text-dim)">${esc(l.iface)}</span>
    <button class="btn btn--ghost" data-copytext="${esc(l.url)}">${esc(T("复制"))}</button></div>`).join("");
}

const ACT_TEXT = {
  created: "房间 {code} 已创建：{who}（{mode}/{difficulty}）", started: "房间 {code} 开局（{seats} 席）", ended: "房间 {code} 对局结束",
  kicked: "房间 {code}：房主移出了 {who}", host: "房间 {code}：房主变为 {who}", closed: "房间 {code} 已关闭（{why}）",
};
function renderLive() {
  const h = S.health;
  const tile = (v, label, hl) => `<div class="tile"><b class="${hl ? "hl" : ""}">${v ?? "—"}</b><span class="micro">${label}</span></div>`;
  $("livestats").innerHTML = h
    ? tile(h.humans, "Players", h.humans > 0) + tile(h.rooms, "Rooms") + tile(h.matches, "In match") +
      tile(h.bots, "Bots") + tile(h.spectators, "Watching") + tile(h.sockets, "Sockets")
    : `<div class="tile" style="grid-column:1/-1"><span class="empty">${esc(T("游戏未运行"))}</span></div>`;
  $("healthmeta").textContent = h ? `UP ${fmtUp(h.uptimeSec)}` : "";

  const rooms = S.rooms || [];
  const chip = (m) => `<span class="mem${m.host ? " host" : ""}${m.bot ? " bot" : ""}${m.online ? "" : " off"}" title="${esc(T(m.host ? "房主" : m.bot ? "AI" : m.online ? (m.ready ? "已准备" : "未准备") : "离线"))}">${esc(m.name)}${m.ready && !m.host && !m.bot ? '<i>✓</i>' : ""}</span>`;
  const link = (code, watch) => S.publicUrl ? `${S.publicUrl}/play?${watch ? "watch" : "room"}=${encodeURIComponent(code)}` : "";
  $("rooms").innerHTML = rooms.length
    ? `<table class="t"><tr><th>Room</th><th>Members</th><th>Mode</th><th>Status</th></tr>${rooms.map((r) => {
        const inMatch = r.status === "in match";
        const acts = [
          inMatch ? "" : `<button class="btn" data-room="${esc(r.code)}" title="${esc(T("在这台电脑上打开并加入"))}">${esc(T("加入"))}</button>`,
          `<button class="btn" data-room="${esc(r.code)}" data-watch="1" title="${esc(T("在这台电脑上打开并观战"))}">${EN ? "Watch" : "观战"}</button>`,
          link(r.code) && !inMatch ? `<button class="btn btn--ghost" data-copytext="${esc(link(r.code))}">${esc(T("复制邀请"))}</button>` : "",
          link(r.code, true) ? `<button class="btn btn--ghost" data-copytext="${esc(link(r.code, true))}">${esc(T("复制观战链接"))}</button>` : "",
        ].join("");
        return `<tr>
        <td class="code">${esc(r.code)}</td>
        <td><div class="mems">${r.members ? r.members.map(chip).join("") + (r.watchers || []).map((w) => `<span class="mem watch${w.online ? "" : " off"}" title="${esc(T("观战"))}">${esc(w.name)}<i>${esc(T("观"))}</i></span>`).join("")
          : `<span class="mem host">${esc(r.host || "?")}</span>`}</div></td>
        <td class="dim">${esc(r.mode || "")}${r.difficulty ? " · " + esc(r.difficulty) : ""}${r.capacity ? ` · ${r.members.length}/${r.capacity}` : ""}</td>
        <td>${inMatch ? `<span class="tag busy">${esc(T("对局中"))}</span>` : `<span class="tag open">${esc(T("可加入"))}</span>`}</td></tr>
        <tr class="acts-row"><td></td><td colspan="3"><div class="room-acts">${acts}</div></td></tr>`;
      }).join("")}</table>`
    : `<div class="empty">${esc(T("暂无房间 — 在大厅创建后会出现在这里"))}</div>`;
  $("activity").innerHTML = (S.activity || []).map((a) => {
    const text = a.key && ACT_TEXT[a.key] ? T(ACT_TEXT[a.key], a.v || {}) : a.text;
    return `<li><span class="t">${fmtT(a.t)}</span><span>${esc(text)}</span></li>`;
  }).join("");
}

function renderConns() {
  const c = S.connections || [];
  const total = c.reduce((s, x) => s + x.sockets, 0);
  $("conncount").textContent = total ? `${total} SOCKETS` : "";
  $("conntable").innerHTML = c.length
    ? `<table class="t"><tr><th>Address</th><th>Via</th><th>Sockets</th></tr>${c.map((x) => `<tr>
        <td class="num">${esc(x.address)}</td><td><span class="tag ${x.via}">${esc(T(x.via === "tunnel" ? "隧道" : "局域网"))}</span></td>
        <td class="num">${x.sockets}</td></tr>`).join("")}</table>`
    : `<div class="empty">${esc(T("没有人连接"))}</div>`;
}

function spark(el, hist, top, cls = "") {
  const n = Math.max(2, hist.length), pts = hist.map((v, i) => `${(i / 89) * 90},${40 - ((v || 0) / top) * 38}`).join(" ");
  void n;
  el.innerHTML = hist.length > 1 ? `<polygon class="ar${cls}" points="0,40 ${pts} ${((hist.length - 1) / 89) * 90},40"/><polyline class="ln${cls}" points="${pts}"/>` : "";
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
  $("bwtot").textContent = T("局域网 ↓{a} ↑{b} Mbps · 本次累计 ↓{c} MB ↑{d} MB", { a: b.lanIn.toFixed(2), b: b.lanOut.toFixed(2), c: b.totalInMB.toFixed(1), d: b.totalOutMB.toFixed(1) });
  // sparkline over the last 90 samples (3 min)
  const hist = b.history || [];
  const top = Math.max(lim * 1.1, ...hist, 0.1);
  const pts = hist.map((v, i) => `${(i / 89) * 90},${40 - (v / top) * 38}`).join(" ");
  const limY = 40 - (lim / top) * 38;
  $("spark").innerHTML = hist.length > 1
    ? `<line class="lim" x1="0" x2="90" y1="${limY}" y2="${limY}"/><polygon class="ar" points="0,40 ${pts} ${((hist.length - 1) / 89) * 90},40"/><polyline class="ln" points="${pts}"/>`
    : "";
}

const tone = (pct) => pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--mint)";
function renderSys() {
  const y = S && S.sys; if (!y) return;
  const memPct = y.mem ? (y.mem.used / y.mem.total) * 100 : null;
  $("scpu").innerHTML = y.cpu == null ? "—" : `${y.cpu.toFixed(0)}<small>%</small>`;
  $("scpubar").style.width = (y.cpu || 0) + "%"; $("scpubar").style.background = tone(y.cpu || 0);
  $("smem").innerHTML = y.mem ? `${(y.mem.used / 1073741824).toFixed(1)}<small>/ ${(y.mem.total / 1073741824).toFixed(0)} GB</small>` : "—";
  $("smembar").style.width = (memPct || 0) + "%"; $("smembar").style.background = tone(memPct || 0);
  spark($("scpuspark"), y.history.cpu || [], 100);
  spark($("smemspark"), y.history.mem || [], 100);
  $("hsys").textContent = y.cpu == null ? "—" : `${y.cpu.toFixed(0)}% · ${memPct == null ? "—" : memPct.toFixed(0) + "%"}`;
  $("hsys").style.color = (y.cpu || 0) >= 90 || (memPct || 0) >= 90 ? "var(--red)" : "";
  $("sysmeta").textContent = [T("{n} 核", { n: y.cores }), y.model ? y.model.replace(/\(R\)|\(TM\)|CPU|@.*$/g, "").replace(/\s+/g, " ").trim() : ""].filter(Boolean).join(" · ");
  const P = y.procs || {};
  const row = (name, p, sub) => `<tr><td>${esc(name)}${sub ? `<span class="sub-l">${esc(sub)}</span>` : ""}</td>` +
    (p ? `<td class="r num">${p.pct == null ? "—" : p.pct.toFixed(1) + "%"}</td><td class="r num">${bytes(p.rss)}</td>` : `<td class="r dim">${esc(T("未运行"))}</td><td class="r dim">—</td>`) + "</tr>";
  $("sysprocs").innerHTML = `<table class="t"><tr><th>${esc(T("进程"))}</th><th class="r">CPU</th><th class="r">${esc(T("内存"))}</th></tr>` +
    row(P.game && P.game.count > 1 ? T("游戏服务器（{n} 个进程）", { n: P.game.count }) : T("游戏服务器"), P.game) +
    row("frpc", P.frpc) + row(T("本面板"), P.panel, "node") + "</table>";
  const extra = [y.disk ? T("磁盘剩余 {f} / {t}", { f: bytes(y.disk.free), t: bytes(y.disk.total) }) : "", y.load ? T("负载均值 {l}", { l: y.load.join(" ") }) : "", T("打开面板时每 2 秒采样")].filter(Boolean).join(" · ");
  $("syshint").textContent = T("CPU 按整台电脑计算（100% = 所有核心）；内存为常驻内存，不含文件缓存。") + " " + extra;
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
  $("qsrc").textContent = T("中转统计 {a} GiB · SakuraFrp 记录 {b} · 取较大值 · 局域网 {c} GiB 不计", { a: g(u.hubBytes), b: u.sakuraBytes == null ? "—" : g(u.sakuraBytes) + " GiB", c: g(u.lanBytes) });
  const auto = S.autoNotice;
  $("qtag").className = "tag" + (auto ? " busy" : " hidden"); $("qtag").textContent = auto ? T("玩家提醒中") : "";
  $("qclear").classList.toggle("hidden", !auto);
  $("usagebanner").classList.toggle("hidden", pct < 80);
  $("usagebanner").classList.toggle("alert--bad", pct >= 95);
  $("usagetitle").textContent = pct >= 100 ? T("今日流量已超过上限：{a} / {b} GiB", { a: g(u.usedBytes), b: g(u.limitBytes) }) : T("今日流量已用 {p}%：{a} / {b} GiB", { p: Math.round(pct), a: g(u.usedBytes), b: g(u.limitBytes) });
  $("usagehint").textContent = T("不会自动停服，只是提醒你。") + (auto ? T("玩家正在看到：「{t}」", { t: EN && auto.textEn ? auto.textEn : auto.text }) : u.autoBroadcast ? "" : T("自动提醒玩家已关闭。"));
  $("btnusageclear").classList.toggle("hidden", !auto);
  $("btnusagesend").classList.toggle("hidden", !!auto);
}

function renderSakura() {
  const s = S.sakura || {}, u = s.user, n = s.myNode, el = $("sakuraacct");
  if (n && !n.notFound) setState($("nodestate"), n.online ? "ok" : n.online === false ? "bad" : "", T(n.online ? "节点在线" : n.online === false ? "节点离线" : "节点未知"));
  else setState($("nodestate"), "", "—");
  const needSign = !!(u && u.sign && u.sign.config !== false && u.sign.signed === false);
  $("signbanner").classList.toggle("hidden", !needSign);
  if (!u && !n) {
    el.innerHTML = `<div class="empty">${esc(T(S.config.hasToken ? "正在读取 api.natfrp.com…" : "未找到访问密钥 — 在设置里填写，或确认 frpc.ini 中有 user = …"))}</div>`;
    return;
  }
  let rows = "";
  if (u) {
    const today = u.traffic ? u.traffic[0] : 0, left = u.traffic ? u.traffic[1] : 0;
    rows += `<dt>${esc(T("用户"))}</dt><dd>${esc(u.name || "")} <span class="dim">· ${esc(u.group?.name || u.speed || "")}</span></dd>
      <dt>${esc(T("剩余流量"))}</dt><dd class="num" style="color:${left < 1073741824 ? "var(--red)" : "var(--mint)"}">${GiB(left)}</dd>
      <dt>${esc(T("今日已用"))}</dt><dd class="num">${GiB(today)}</dd>`;
    if (Array.isArray(s.plans)) rows += `<dt>${esc(T("流量包"))}</dt><dd>${esc(T("{n} 个有效", { n: s.plans.length }))}</dd>`;
    if (u.sign && u.sign.config !== false)
      rows += `<dt>${esc(T("签到"))}</dt><dd>${u.sign.signed ? `<span class="tag open">${esc(T("今日已签"))}</span>` : `<span class="tag busy">${esc(T("未签到"))}</span>`} <span class="dim">· ${esc(T("连续 {d} 天 · 累计 {t} GiB", { d: u.sign.days, t: u.sign.traffic }))}</span></dd>`;
  }
  if (n) {
    rows += n.notFound
      ? `<dt>${esc(T("节点"))}</dt><dd class="dim">${esc(T("未找到「{n}」。可选：{k}", { n: n.name, k: (n.known || []).join(EN ? ", " : "、") }))}</dd>`
      : `<dt>${esc(T("节点"))}</dt><dd>${esc(n.name)}${n.load != null ? ` <span class="dim">· ${esc(T("负载"))} <span class="num">${n.load}%</span></span>` : ""}${n.uptimeHours != null ? ` <span class="dim">· ${esc(T("运行"))} <span class="num">${n.uptimeHours}h</span></span>` : ""}</dd>`;
  }
  el.innerHTML = `<dl class="kv">${rows}</dl>`;
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
    if (CONFIRM[name] && players > 0 && !confirm(T(CONFIRM[name]))) return;
    if (name === "switchPackage" && players > 0 && !confirm(T("换成完整包会重新安装游戏，正在玩的人会断线。继续？"))) return;
    act(name); return;
  }
  const r = e.target.closest("[data-room]");
  if (r) { act("openRoom", { code: r.dataset.room, watch: !!r.dataset.watch }); return; }
  const c = e.target.closest("[data-copy],[data-copytext]");
  if (c) {
    const text = c.dataset.copytext || (S && S[c.dataset.copy]);
    if (!text) return;
    try { await navigator.clipboard.writeText(text); toast(T("已复制")); } catch { prompt(T("手动复制："), text); }
    return;
  }
  const chip = e.target.closest(".chip");
  if (chip) { $("noticetext").value = chip.textContent; $("noticetext").focus(); }
});
$("btnsession").onclick = () => act("startSession");
$("btnstopall").onclick = () => { const p = S && S.health ? S.health.humans : 0; if (p > 0 && !confirm(T(CONFIRM.stopAll))) return; act("stopAll"); };
$("btnnotice").onclick = () => { const t = $("noticetext").value.trim(); if (!t) return $("noticetext").focus(); act("setNotice", { text: t }); toast(T("公告已发布")); };
$("noticetext").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnnotice").click(); });
$("btnnotclear").onclick = () => { $("noticetext").value = ""; act("setNotice", { text: "" }); toast(T("公告已撤下")); };

function fillConfig() {
  const c = S.config;
  $("cfgurl").value = c.publicUrl || "";
  $("cfgurl").placeholder = S.publicUrlAuto && S.publicUrl ? T("留空 = 自动：{u}", { u: S.publicUrl }) : T("留空 = 从 frpc.ini 自动生成");
  $("cfgbin").value = c.frpcBin || "";
  $("cfgcfg").value = c.frpcConfig || "";
  $("cfgnode").value = c.nodeName || "";
  $("cfgspeed").value = c.speedLimitMbps || 10;
  $("cfgdaily").value = c.dailyLimitGB ?? 2;
  $("cfgautob").checked = c.dailyAutoBroadcast !== false;
  $("cfgpkg").value = c.gamePackage === "lite" ? "lite" : "full";
  $("cfgcache").checked = c.playerCache !== false;
  $("cfgtok").placeholder = c.hasToken ? T(c.tokenFromIni ? "已从 frpc.ini 读取" : "已保存 — 留空不修改") : T("未设置");
}
$("btnsave").onclick = () => {
  act("saveConfig", { config: {
    publicUrl: $("cfgurl").value, frpcBin: $("cfgbin").value, frpcConfig: $("cfgcfg").value,
    nodeName: $("cfgnode").value, speedLimitMbps: $("cfgspeed").value, sakuraToken: $("cfgtok").value,
    dailyLimitGB: $("cfgdaily").value, dailyAutoBroadcast: $("cfgautob").checked,
    gamePackage: $("cfgpkg").value, playerCache: $("cfgcache").checked,
  } });
  $("cfgtok").value = "";
  toast(T("设置已保存"));
};

// theme: auto → light → dark
const THEMES = ["auto", "light", "dark"], THEME_LABEL = { auto: "自动", light: "浅色", dark: "深色" };
const mq = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "auto" && mq.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.pref = pref;
  $("btntheme").textContent = T(THEME_LABEL[pref]);
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
