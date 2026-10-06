#!/usr/bin/env node
// setup.mjs — first-time setup, shared by install.sh (macOS / Linux) and install.ps1 (Windows).
// Run it again at any time to repair or change the setup:  node lib/setup.mjs [--lang zh|en] [--yes]
//
//   1. SakuraFrp frpc:  download the newest build (api.natfrp.com/v4/system/clients), check the MD5
//   2. 访问密钥:         read from frpc.ini, or ask (hidden input), then check it with /user/info
//   3. Tunnel:          pick a TCP tunnel to local port 3000, or create one (API v4), with 自动 HTTPS
//   4. frpc.ini:        `frpc -f <key>:<id> -w` writes it (the same file the panel reads)
//   5. Game:            the panel's own updater (local proxy → direct → mirrors)
//
// Bilingual: 简体中文 when the system language is Chinese, otherwise English.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------- language, output
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const YES = argv.includes("--yes") || argv.includes("-y");
function detectLang() {
  const v = (flag("--lang") || process.env.SH_LANG || "").toLowerCase();
  if (v.startsWith("zh")) return "zh";
  if (v.startsWith("en")) return "en";
  const loc = [process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, Intl.DateTimeFormat().resolvedOptions().locale].join(" ");
  return /\bzh/i.test(loc) ? "zh" : "en";
}
const ZH = detectLang() === "zh";
const T = (zh, en) => (ZH ? zh : en);

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c("1"), dim = c("2"), green = c("32"), yellow = c("33"), red = c("31"), cyan = c("36");
const say = (s = "") => process.stdout.write(s + "\n");
const step = (n, zh, en) => say("\n" + bold(cyan(`[${n}/5] `) + T(zh, en)));
const ok = (s) => say("  " + green("✓ ") + s);
const warn = (s) => say("  " + yellow("! ") + s);
const fail = (s) => say("  " + red("✗ ") + s);
const info = (s) => say("  " + s);

// Panel modules print their own log lines as "[HH:MM:SS] text". Show the useful ones, dimmed.
const realLog = console.log.bind(console);
console.log = (...a) => {
  const s = a.join(" ");
  const m = s.match(/^\[\d\d:\d\d:\d\d\] (.*)$/);
  if (!m) return realLog(...a);
  if (/download attempt|attempt (failed|timed out)|installed v|install failed|download failed|cannot reach GitHub/.test(m[1])) {
    if (tty) process.stdout.write("\r\x1b[K");
    say("    " + dim(m[1]));
  }
};

// ---------------------------------------------------------------------------- input
// One shared buffer: answers can arrive faster than the questions (pasted or piped input).
let inbuf = "", waiting = null, secret = null, ended = false;
process.stdin.on("data", (d) => { if (secret) return secret(d); inbuf += d.toString("utf8"); pump(); });
process.stdin.on("end", () => { ended = true; pump(); });
process.stdin.pause();
function pump() {
  if (!waiting) return;
  const i = inbuf.search(/\r?\n/);
  if (i < 0 && !ended) return;
  const line = i < 0 ? inbuf : inbuf.slice(0, i);
  inbuf = i < 0 ? "" : inbuf.slice(inbuf[i] === "\r" ? i + 2 : i + 1);
  const w = waiting; waiting = null; process.stdin.pause(); w(line.trim());
}
function readLine(question) {
  process.stdout.write(question);
  return new Promise((resolve) => { waiting = resolve; pump(); if (waiting) process.stdin.resume(); });
}
/** Hidden input: shows one * per character. Falls back to visible input when stdin is not a terminal. */
function readSecret(question) {
  if (!process.stdin.isTTY) return readLine(question);
  return new Promise((resolve) => {
    process.stdout.write(question);
    let v = "";
    process.stdin.setRawMode(true);
    secret = (d) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false); secret = null; process.stdin.pause();
          process.stdout.write("\n"); return resolve(v.trim());
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") { if (v) { v = v.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        if (ch >= " ") { v += ch; process.stdout.write("*"); }
      }
    };
    process.stdin.resume();
  });
}
async function confirm(zh, en, def = true) {
  if (YES) return def;
  const a = (await readLine(`  ${T(zh, en)} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") || a === "是" : def;
}
async function choose(zh, en, max, def = 1) {
  if (YES) return def;
  for (;;) {
    const a = await readLine(`  ${T(zh, en)} [${def}] `);
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    warn(T(`请输入 1 到 ${max} 之间的数字`, `Enter a number from 1 to ${max}`));
  }
}

// ---------------------------------------------------------------------------- panel modules
const core = await import("./core.mjs");
const { config, state, expand, frpcIni, effectivePublicUrl } = core;
const { IS_WIN, IS_MAC } = await import("./platform.mjs");
const { run, directEnv, killTree } = await import("./util.mjs");
const updater = await import("./updater.mjs");

const API = process.env.SH_SAKURA_API || "https://api.natfrp.com/v4";   // override for tests only
const FRPC = expand(config.frpcBin);
const INI = expand(config.frpcConfig);
let token = "";

/** SakuraFrp API v4. Uses Node's fetch, which never goes through proxy variables (the API is in mainland China). */
async function sakura(method, p, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) { return { ok: false, msg: T(`无法连接 SakuraFrp API：${e.message}`, `cannot reach the SakuraFrp API: ${e.message}`) }; }
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch {}
  if (!res.ok) return { ok: false, status: res.status, msg: (data && data.msg) || `HTTP ${res.status}` };
  return { ok: true, data: data ?? text };
}

// ---------------------------------------------------------------------------- 1. frpc
const ARCH = { arm64: "arm64", x64: "amd64", ia32: "386", arm: "armv7" }[process.arch] || process.arch;
const PLAT = IS_WIN ? "windows" : IS_MAC ? "darwin" : "linux";

async function frpcVersion() {
  if (!fs.existsSync(FRPC)) return "";
  const r = await run(FRPC, ["-V"], { env: directEnv() });
  return r.ok ? r.stdout.trim().split(/\s+/)[0] : "";
}

async function setupFrpc() {
  step(1, "SakuraFrp frpc（命令行客户端）", "SakuraFrp frpc (CLI)");
  const have = await frpcVersion();
  const rel = await sakura("GET", "/system/clients");
  const latest = rel.ok && rel.data && rel.data.frpc;
  const asset = latest && latest.archs && latest.archs[`${PLAT}_${ARCH}`];
  if (have && /sakura/.test(have) && (!latest || have === latest.ver)) { ok(T(`已安装 ${have}：${FRPC}`, `installed ${have}: ${FRPC}`)); return true; }
  if (!asset) {
    if (have) { warn(T(`无法查询最新版本，继续使用 ${have}`, `cannot check the newest version, keeping ${have}`)); return true; }
    fail(T(`无法获取 ${PLAT}_${ARCH} 的 frpc 下载地址：${rel.msg || ""}`, `no frpc download for ${PLAT}_${ARCH}: ${rel.msg || ""}`));
    info(T("请按安装指南「手动安装」第 3 步手动下载。", "Download it by hand: see step 3 of Manual install in INSTALL.md."));
    return false;
  }
  if (have && !(await confirm(`当前 ${have}，更新到 ${latest.ver}？`, `Installed: ${have}. Update to ${latest.ver}?`))) return true;
  info(T(`下载 frpc ${latest.ver}（${PLAT}_${ARCH}，${(asset.size / 1048576).toFixed(1)} MB）…`, `downloading frpc ${latest.ver} (${PLAT}_${ARCH}, ${(asset.size / 1048576).toFixed(1)} MB)...`));
  let buf;
  try {
    const res = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) { fail(T(`下载失败：${e.message}`, `download failed: ${e.message}`)); return false; }
  const md5 = crypto.createHash("md5").update(buf).digest("hex");
  if (asset.hash && md5 !== asset.hash) { fail(T(`MD5 校验失败（${md5}），已放弃`, `MD5 check failed (${md5}), nothing changed`)); return false; }
  fs.mkdirSync(path.dirname(FRPC), { recursive: true });
  const tmp = FRPC + ".new";
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  try { fs.renameSync(tmp, FRPC); } catch (e) {
    fail(T(`无法替换 ${FRPC}（frpc 可能正在运行）：${e.message}`, `cannot replace ${FRPC} (is frpc running?): ${e.message}`)); return false;
  }
  if (IS_MAC) await run("xattr", ["-d", "com.apple.quarantine", FRPC]);
  if (IS_WIN) await run("powershell.exe", ["-NoProfile", "-Command", `Unblock-File -LiteralPath '${FRPC.replace(/'/g, "''")}'`]);
  const v = await frpcVersion();
  if (!/sakura/.test(v)) { fail(T(`frpc 无法运行（${v || "无输出"}）`, `frpc does not run (${v || "no output"})`)); return false; }
  ok(T(`已安装 ${v}，MD5 校验通过：${FRPC}`, `installed ${v}, MD5 OK: ${FRPC}`));
  return true;
}

// ---------------------------------------------------------------------------- 2. 访问密钥
async function setupToken() {
  step(2, "SakuraFrp 访问密钥", "SakuraFrp 访问密钥 (access key)");
  const fromIni = frpcIni().user || config.sakuraToken;
  if (fromIni) {
    token = fromIni;
    const me = await sakura("GET", "/user/info");
    if (me.ok) { ok(T(`已从 frpc.ini 读取，账号：${me.data.name}（${me.data.group?.name || ""}）`, `read from frpc.ini, account: ${me.data.name} (${me.data.group?.name || ""})`)); return me.data; }
    warn(T(`frpc.ini 中的访问密钥无效：${me.msg}`, `the key in frpc.ini does not work: ${me.msg}`));
  }
  info(T("还没有账号：先在 https://www.natfrp.com/ 注册并完成实名认证（https://doc.natfrp.com/faq/realname.html）。",
         "No account yet: register at https://www.natfrp.com/ and do the real-name verification first (https://doc.natfrp.com/faq/realname.html)."));
  info(T("访问密钥在 SakuraFrp 管理面板 → 用户信息（https://www.natfrp.com/user/）。输入时不显示明文。",
         "The key is in the SakuraFrp panel → 用户信息 (https://www.natfrp.com/user/). Input is hidden."));
  for (let i = 0; i < 3; i++) {
    token = await readSecret(`  ${T("访问密钥", "访问密钥 (access key)")}: `);
    if (!token) continue;
    const me = await sakura("GET", "/user/info");
    if (me.ok) { ok(T(`账号：${me.data.name}（${me.data.group?.name || ""}）`, `account: ${me.data.name} (${me.data.group?.name || ""})`)); return me.data; }
    fail(T(`访问密钥无效：${me.msg}`, `the key does not work: ${me.msg}`));
  }
  return null;
}

// ---------------------------------------------------------------------------- 3. tunnel
const hasAutoHttps = (extra) => /^\s*auto_https\s*=\s*(?!false|off|0|no|none|disable)\S/im.test(extra || "");
const withAutoHttps = (extra) =>
  [...String(extra || "").split(/\r?\n/).filter((l) => l.trim() && !/^\s*auto_https\s*=/.test(l)), "auto_https = auto"].join("\n");

async function setupTunnel(user) {
  step(3, "隧道（TCP → 127.0.0.1:" + config.port + "，自动 HTTPS）", `Tunnel (TCP → 127.0.0.1:${config.port}, 自动 HTTPS)`);
  const [tl, nl] = await Promise.all([sakura("GET", "/tunnels"), sakura("GET", "/nodes")]);
  if (!tl.ok) { fail(T(`无法读取隧道列表：${tl.msg}`, `cannot read the tunnel list: ${tl.msg}`)); return null; }
  const nodes = nl.ok && nl.data && typeof nl.data === "object" ? nl.data : {};
  const nodeName = (id) => (nodes[id] && nodes[id].name) || `#${id}`;
  const fits = (t) => t.type === "tcp" && Number(t.local_port) === Number(config.port);
  const list = (Array.isArray(tl.data) ? tl.data : []).filter(fits);

  let t = null;
  if (list.length) {
    info(T(`找到本地端口为 ${config.port} 的 TCP 隧道：`, `TCP tunnels to local port ${config.port}:`));
    list.forEach((x, i) => info(`  [${i + 1}] #${x.id} ${x.name} · ${nodeName(x.node)} · ${T("远程端口", "remote port")} ${x.remote} · ${T("自动 HTTPS", "自动 HTTPS")} ${hasAutoHttps(x.extra) ? T("已启用", "on") : T("未启用", "off")}`));
    info(`  [${list.length + 1}] ${T("新建隧道", "Create a new tunnel")}`);
    const n = await choose("选择隧道", "Select a tunnel", list.length + 1);
    if (n <= list.length) t = list[n - 1];
  } else {
    info(T(`账号中没有本地端口为 ${config.port} 的 TCP 隧道，现在新建一条。`, `The account has no TCP tunnel to local port ${config.port}. Creating one now.`));
  }

  if (!t) {
    const level = Number(user?.group?.level ?? 0);
    const usable = Object.entries(nodes)
      .map(([id, n]) => ({ id: Number(id), ...n }))
      .filter((n) => (n.flag & 4) && !(n.flag & 512) && Number(n.vip || 0) <= level)
      .sort((a, b) => ((b.flag & 8) - (a.flag & 8)) || a.id - b.id);
    if (!usable.length) { fail(T("没有可用于创建隧道的节点（可能需要实名认证，或节点已满）。", "No node accepts new tunnels (real-name verification may be missing, or the nodes are full).")); return null; }
    info(T("选择节点（国内节点在前；选离你和玩家都近的）：", "Select a node (mainland nodes first; pick one close to you and your players):"));
    const shown = usable.slice(0, 40);
    shown.forEach((n, i) => info(`  [${i + 1}] ${n.name}${n.flag & 8 ? T(" · 国内", " · mainland") : T(" · 海外", " · overseas")}${n.description ? dim(" · " + n.description.slice(0, 40)) : ""}`));
    const n = shown[(await choose("节点", "Node", shown.length)) - 1];
    const body = { name: `stronghold${Math.floor(Math.random() * 9000 + 1000)}`, type: "tcp", node: n.id, local_ip: "127.0.0.1", local_port: Number(config.port), extra: "auto_https = auto", note: "Stronghold Host Panel" };
    const r = await sakura("POST", "/tunnels", body);
    if (!r.ok) { fail(T(`创建隧道失败：${r.msg}`, `cannot create the tunnel: ${r.msg}`)); return null; }
    ok(T(`已创建隧道 #${r.data.id} ${r.data.name}（${n.name}，远程端口 ${r.data.remote}）`, `created tunnel #${r.data.id} ${r.data.name} (${n.name}, remote port ${r.data.remote})`));
    return { id: r.data.id };
  }

  const fix = !hasAutoHttps(t.extra) || t.local_ip !== "127.0.0.1";
  if (fix) {
    warn(T("这条隧道没有启用自动 HTTPS（或本地 IP 不是 127.0.0.1），玩家会看到 501。", "This tunnel does not use 自动 HTTPS (or its local IP is not 127.0.0.1). Players would get 501."));
    if (await confirm("现在修改隧道设置？", "Change the tunnel settings now?")) {
      const r = await sakura("POST", "/tunnel/edit", { id: t.id, local_ip: "127.0.0.1", local_port: Number(config.port), extra: withAutoHttps(t.extra) });
      if (r.ok) ok(T("已启用自动 HTTPS", "自动 HTTPS is on"));
      else fail(T(`修改失败：${r.msg}。请在网站上编辑隧道，自动 HTTPS 选「自动」。`, `edit failed: ${r.msg}. Edit the tunnel on the website and set 自动 HTTPS to 自动.`));
    }
  } else ok(T(`使用隧道 #${t.id} ${t.name}`, `using tunnel #${t.id} ${t.name}`));
  return { id: t.id };
}

// ---------------------------------------------------------------------------- 4. frpc.ini
async function writeIni(id) {
  step(4, "写入 frpc.ini", "Write frpc.ini");
  fs.mkdirSync(path.dirname(INI), { recursive: true });
  let before = 0;
  if (fs.existsSync(INI)) { fs.copyFileSync(INI, INI + ".bak"); before = fs.statSync(INI).mtimeMs; info(dim(T(`旧文件已备份为 ${INI}.bak`, `old file saved as ${INI}.bak`))); }
  // `-w` writes the fetched config, then frpc goes on to start the tunnel: stop it once the file is there
  const p = spawn(FRPC, ["-n", "-c", INI, "-f", `${token}:${id}`, "-w"], { cwd: path.dirname(INI), env: directEnv(), stdio: "ignore", detached: !IS_WIN, windowsHide: true });
  const done = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let s = null; try { s = fs.statSync(INI); } catch {}
      if (s && s.mtimeMs > before && /server_addr/.test(fs.readFileSync(INI, "utf8"))) { clearInterval(iv); resolve(true); }
      else if (Date.now() - t0 > 30000 || p.exitCode !== null) { clearInterval(iv); resolve(false); }
    }, 300);
  });
  await new Promise((r) => setTimeout(r, 500));
  killTree(p);
  if (!done) { fail(T("frpc 没有写出配置文件（30 秒内）。检查网络后重新运行安装脚本。", "frpc did not write the config file within 30 s. Check the network, then run the installer again.")); return false; }
  const ini = frpcIni();
  ok(T(`已写入 ${INI}（节点 ${ini.host}，远程端口 ${ini.remotePort}）`, `wrote ${INI} (node ${ini.host}, remote port ${ini.remotePort})`));
  if (!ini.autoHttps) warn(T("frpc.ini 中没有 auto_https。在网站上编辑隧道，自动 HTTPS 选「自动」，然后重新运行安装脚本。", "frpc.ini has no auto_https. Edit the tunnel on the website, set 自动 HTTPS to 自动, then run the installer again."));
  return true;
}

// ---------------------------------------------------------------------------- 5. game
async function setupGame() {
  step(5, "游戏（" + config.repo + "）", `Game (${config.repo})`);
  const px = await updater.proxyCandidates();
  info(dim(px.length ? T(`GitHub 走本机代理：${px.join("、")}`, `GitHub through local proxy: ${px.join(", ")}`) : T("未发现本机代理端口，GitHub 直连", "no local proxy port found, GitHub direct")));
  await updater.checkUpdate();
  if (!state.latestVersion) { fail(T("无法从 GitHub 获取游戏版本。打开代理软件后，在面板中点「检查更新」。", "Cannot get the game version from GitHub. Turn on your proxy app, then click 检查更新 in the panel.")); return false; }
  if (!updater.updateAvailable()) { ok(T(`已是最新版本 ${state.version}`, `up to date: ${state.version}`)); return true; }
  const mb = (state.latestSize / 1048576).toFixed(0);
  const q = state.version ? [`从 ${state.version} 更新到 ${state.latestVersion}（${mb} MB）？`, `Update from ${state.version} to ${state.latestVersion} (${mb} MB)?`]
                          : [`下载并安装 ${state.latestVersion}（${mb} MB）？`, `Download and install ${state.latestVersion} (${mb} MB)?`];
  if (!(await confirm(...q))) { info(T("跳过。之后可以在面板中点「检查更新」。", "Skipped. You can click 检查更新 in the panel later.")); return true; }
  const iv = setInterval(() => {
    const u = state.update;
    if (u.phase === "downloading" && tty) process.stdout.write(`\r\x1b[K    ${(u.received / 1048576).toFixed(1)} / ${mb} MB ${dim(u.route || "")}`);
    if (u.phase === "installing" && tty) process.stdout.write(`\r\x1b[K    ${T("正在安装…", "installing...")}`);
  }, 500);
  await updater.applyUpdate();
  clearInterval(iv);
  if (tty) process.stdout.write("\r\x1b[K");
  if (state.update.phase !== "done") { fail(T("游戏安装失败，见上方日志。之后可以在面板中重试。", "The game install failed, see the log above. You can try again in the panel.")); return false; }
  ok(T(`已安装 ${state.version} → ${expand(config.gameRoot)}`, `installed ${state.version} → ${expand(config.gameRoot)}`));
  return true;
}

// ---------------------------------------------------------------------------- main
say(bold(T("卫戍协议 · 主机面板 · 设置", "Stronghold Host Panel · setup")));
let good = await setupFrpc();
let user = null;
const ini0 = frpcIni();
if (good && ini0.host && ini0.user && ini0.autoHttps && !argv.includes("--tunnel")) {
  step(2, "SakuraFrp 访问密钥", "SakuraFrp 访问密钥 (access key)");
  ok(T("使用 frpc.ini 中的访问密钥", "using the key in frpc.ini"));
  step(3, "隧道", "Tunnel");
  ok(T(`已有隧道配置：${ini0.host}:${ini0.remotePort}，自动 HTTPS 已启用（${INI}）`, `tunnel config found: ${ini0.host}:${ini0.remotePort}, 自动 HTTPS on (${INI})`));
  info(dim(T("要换隧道，运行 node lib/setup.mjs --tunnel", "To change the tunnel, run node lib/setup.mjs --tunnel")));
  step(4, "写入 frpc.ini", "Write frpc.ini"); ok(T("保持不变", "unchanged"));
} else if (good) {
  user = await setupToken();
  const t = user && (await setupTunnel(user));
  good = !!t && (await writeIni(t.id));
}
const gameOk = await setupGame();

const link = effectivePublicUrl().url;
say("\n" + bold(good && gameOk ? green(T("设置完成", "Setup complete")) : yellow(T("设置未全部完成，见上方提示", "Setup is not complete, see the messages above"))));
if (link) info(T(`玩家链接：${bold(link)}`, `Player link: ${bold(link)}`));
const px = await updater.proxyCandidates();
if (px.length) {
  warn(T("检测到本机代理端口。如果代理软件使用 TUN / 全局接管模式，请在规则最前面加入：",
         "A local proxy port is on. If your proxy app uses a TUN or capture-all mode, put this rule at the top:"));
  info(`    PROCESS-NAME,${IS_WIN ? "frpc.exe" : "frpc"},DIRECT`);
  info(dim(T("其他规则格式见 INSTALL.md「手动安装」第 5 步。", "Other rule formats: INSTALL.md, Manual install, step 5.")));
}
process.exit(good && gameOk ? 0 : 1);
