// platform.mjs — the only place that knows which OS the panel runs on.
// macOS, Windows 10/11 and Linux. Everything here fails soft: a missing tool
// means "no notification" or "no sleep prevention", never a crash.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const OS_NAME = IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";

const quiet = (cmd, args, opts = {}) => {
  try {
    const p = spawn(cmd, args, { stdio: "ignore", windowsHide: true, ...opts });
    p.on("error", () => {});
    return p;
  } catch { return null; }
};
const run = (cmd, args) => new Promise((resolve) =>
  execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
    resolve({ ok: !err, stdout: String(stdout || "") })));

/** Open a URL or folder with the default app. */
export function openTarget(target) {
  if (IS_MAC) return quiet("open", [target]);
  if (IS_WIN) return quiet("explorer.exe", [target]);
  return quiet("xdg-open", [target], { detached: true });
}

/** Desktop notification for the host. */
export function notify(title, body) {
  const t = String(title), b = String(body);
  if (IS_MAC) {
    const q = (s) => s.replace(/["\\]/g, "");
    return quiet("osascript", ["-e", `display notification "${q(b)}" with title "${q(t)}" sound name "Glass"`]);
  }
  if (IS_WIN) {
    const q = (s) => s.replace(/'/g, "''");
    const ps = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
      "$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;" +
      `$n.ShowBalloonTip(8000,'${q(t)}','${q(b)}','Info');Start-Sleep 9;$n.Dispose()`;
    return quiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]);
  }
  return quiet("notify-send", [t, b]);
}

/** Keep the computer awake while the game runs. Returns the child process, or null. */
export function keepAwake() {
  if (IS_MAC) return quiet("caffeinate", ["-dimsu"], { detached: true });
  if (IS_WIN) {
    const ps = "$t=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' " +
      "-Name P -Namespace W -PassThru;while($true){[void]$t::SetThreadExecutionState([uint32]2147483651);Start-Sleep 30}";
    return quiet("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps]);
  }
  return quiet("systemd-inhibit", ["--what=idle:sleep", "--who=Stronghold Host Panel", "--why=hosting a game", "sleep", "infinity"], { detached: true });
}

/** spawn() options for a managed child (game, frpc): own process group on Unix, hidden console on Windows. */
export const childOpts = (extra = {}) => ({ detached: !IS_WIN, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...extra });

/** Command to run `npm start` (npm is a .cmd on Windows, which needs a shell). */
export const npmStart = () => (IS_WIN ? { cmd: "npm start", args: [], shell: true } : { cmd: "npm", args: ["start"], shell: false });

/** Stop a child and everything it started. */
export function killTree(p, sig = "SIGTERM") {
  if (!p || !p.pid) return;
  if (IS_WIN) { quiet("taskkill", ["/pid", String(p.pid), "/T", "/F"]); return; }
  try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} }
}

export function killPid(pid) {
  if (IS_WIN) return quiet("taskkill", ["/pid", String(pid), "/T", "/F"]);
  try { process.kill(pid, "SIGKILL"); } catch {}
}

/** PIDs listening on a TCP port. */
export async function pidsOnPort(port) {
  if (IS_WIN) {
    const r = await run("netstat", ["-ano", "-p", "tcp"]);
    return uniq(r.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 5 && /LISTEN/i.test(c[3]) && c[1].endsWith(`:${port}`))
      .map((c) => Number(c[4])));
  }
  const r = await run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  if (r.ok && r.stdout.trim()) return uniq(r.stdout.split(/\s+/).map(Number));
  if (IS_MAC) return [];
  const s = await run("ss", ["-ltnpH", `sport = :${port}`]);          // Linux without lsof
  return uniq([...s.stdout.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])));
}

/** PIDs of running processes started from `bin` (leftover frpc). */
export async function pidsOfBinary(bin) {
  if (IS_WIN) {
    const r = await run("tasklist", ["/FI", `IMAGENAME eq ${path.basename(bin)}`, "/FO", "CSV", "/NH"]);
    return uniq(r.stdout.split(/\r?\n/).map((l) => (l.match(/^"[^"]*","(\d+)"/) || [])[1]).map(Number));
  }
  const r = await run("pgrep", ["-f", bin]);
  return uniq(r.stdout.split(/\s+/).map(Number));
}

/** Extract a .zip into `dir`: unzip, then tar (Windows 10+ and macOS), then PowerShell, then Python. */
export async function extractZip(zip, dir) {
  const tries = [
    ["unzip", ["-q", "-o", zip, "-d", dir]],
    ...(IS_WIN || IS_MAC ? [["tar", ["-xf", zip, "-C", dir]]] : []),
    ...(IS_WIN ? [["powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]]] : []),
    [IS_WIN ? "python" : "python3", ["-m", "zipfile", "-e", zip, dir]],
  ];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args);
    if (r.ok && fs.readdirSync(dir).length) return true;
  }
  return false;
}

const uniq = (a) => [...new Set(a.filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid))];
