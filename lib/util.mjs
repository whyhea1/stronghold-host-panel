// util.mjs — process, network and shell helpers with no shared state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { IS_WIN, killTree, killPid, pidsOnPort } from "./platform.mjs";
export { killTree };

const NODE_PATHS = IS_WIN ? [] : [   // Homebrew (macOS) and /usr/local (Linux); Windows uses its own PATH
  "/opt/homebrew/opt/node@22/bin", "/opt/homebrew/opt/node@24/bin",
  "/usr/local/opt/node@22/bin", "/usr/local/opt/node@24/bin",
  "/opt/homebrew/bin", "/usr/local/bin",
].filter((p) => fs.existsSync(p));

export function augmentEnv(extra = {}) {
  if (!NODE_PATHS.length) return { ...process.env, ...extra };   // keep Windows' own "Path" key untouched
  return { ...process.env, PATH: [...NODE_PATHS, process.env.PATH || ""].join(path.delimiter), ...extra };
}

// frpc must reach the SakuraFrp node directly. frp reads http_proxy / HTTP_PROXY from the environment,
// so a proxy exported in the shell would otherwise push the tunnel through the user's proxy app.
const PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
export function directEnv() {
  const env = augmentEnv();
  for (const k of PROXY_VARS) delete env[k];
  return env;
}

export const isPrivateIp = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip || "");
export const isLoopback = (ip) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
export const cleanIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

export function lanAddresses(port) {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal && isPrivateIp(a.address))
        out.push({ iface, address: a.address, url: `http://${a.address}:${port}` });
    }
  }
  return out;
}

/** GET /healthz on 127.0.0.1:port; resolves to the JSON payload when ok:true, else null. */
export function probeHealth(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/healthz", timeout }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => { try { const j = JSON.parse(buf); resolve(j && j.ok ? j : null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) =>
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || ""), stderr: String(stderr || "") })));
}

/** Kill every process LISTENING on `port` except this panel. Returns killed pids. */
export async function killPortListeners(port) {
  const pids = await pidsOnPort(port);
  for (const p of pids) killPid(p);
  return pids;
}

/** Resolve once child `p` exits, or after `ms` (then SIGKILL the group). */
export function waitExit(p, ms = 6000) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => { killTree(p, "SIGKILL"); resolve(); }, ms);
    p.once("exit", () => { clearTimeout(t); resolve(); });
  });
}

/** Split a child's stdout+stderr into lines. */
export function onLines(p, fn) {
  for (const stream of [p.stdout, p.stderr]) {
    if (!stream) continue;
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) if (l.trim()) fn(l);
    });
  }
}
