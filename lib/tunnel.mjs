// tunnel.mjs — SakuraFrp frpc CLI lifecycle.
import fs from "node:fs";
import { spawn } from "node:child_process";
import { config, state, procs, log, sendState, expand } from "./core.mjs";
import { killTree, waitExit, onLines, directEnv } from "./util.mjs";
import { childOpts, pidsOfBinary, killPid } from "./platform.mjs";

let stopping = false;
const setTunnel = (s) => { if (state.tunnel !== s) { state.tunnel = s; sendState(); } };

export async function startTunnel() {
  if (procs.frpc) return log("panel", "tunnel already running");
  const bin = expand(config.frpcBin), cfg = expand(config.frpcConfig);
  if (!fs.existsSync(bin)) { setTunnel("error"); return log("panel", `frpc not found at ${bin} — fix the path in Settings`); }
  if (!fs.existsSync(cfg)) { setTunnel("error"); return log("panel", `frpc config not found at ${cfg} — run ./frpc -f <访问密钥>:<隧道ID> -w first`); }

  await sweepGhosts();   // a ghost frpc holds the slot → node says 隧道已在线, 请勿重复开启
  log("panel", "starting frpc tunnel...");
  setTunnel("connecting");
  const p = spawn(bin, ["-c", cfg], childOpts({ env: directEnv() }));
  procs.frpc = p;
  onLines(p, (l) => {
    log("tunnel", l);
    if (/start proxy success|启动成功/i.test(l) && state.tunnel !== "connected") { setTunnel("connected"); log("panel", "tunnel connected"); }
    if (/隧道已在线|请勿重复开启/.test(l)) log("panel", "node thinks the tunnel is still online — wait ~30 s and press Start again");
  });
  p.on("error", (e) => log("panel", `could not launch frpc: ${e.message}`));
  p.on("exit", (code) => {
    if (procs.frpc === p) procs.frpc = null;
    log("panel", `frpc exited (code ${code})`);
    setTunnel(stopping || code === 0 ? "off" : "error");
    stopping = false;
  });
  setTimeout(() => {
    if (procs.frpc === p && state.tunnel === "connecting") {
      setTunnel("error");
      log("panel", "no tunnel handshake after 20 s — check Tunnel logs and the Mihomo `PROCESS-NAME,frpc,DIRECT` rule");
    }
  }, 20000);
}

export async function stopTunnel() {
  const p = procs.frpc;
  if (p) { stopping = true; log("panel", "stopping tunnel..."); killTree(p); await waitExit(p, 4000); }
  await sweepGhosts();
  setTunnel("off");
}

async function sweepGhosts() {
  const pids = (await pidsOfBinary(expand(config.frpcBin))).filter((pid) => pid !== procs.frpc?.pid);
  for (const pid of pids) killPid(pid);
  if (pids.length) log("panel", `killed leftover frpc (pid ${pids.join(", ")})`);
}
