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

/**
 * Extract a .zip into `dir`: unzip, then tar (Windows 10+ and macOS), then PowerShell, then Python.
 * `onFile()` is called once per extracted file where the tool lists them (unzip, tar -v), for a progress count.
 */
export async function extractZip(zip, dir, onFile = null) {
  const tries = [
    ["unzip", ["-o", zip, "-d", dir], /^\s*(inflating|extracting):/],
    ...(IS_WIN || IS_MAC ? [["tar", ["-xvf", zip, "-C", dir], /^x?\s*\S/]] : []),
    ...(IS_WIN ? [["powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`], null]] : []),
    [IS_WIN ? "python" : "python3", ["-m", "zipfile", "-e", zip, dir], null],
  ];
  for (const [cmd, args, re] of tries) {
    const ok = await new Promise((resolve) => {
      let p;
      try { p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch { return resolve(false); }
      let rest = "";
      const eat = (c) => {
        if (!onFile || !re) return;
        const lines = (rest + c).split(/\r?\n/); rest = lines.pop();
        for (const l of lines) if (re.test(l) && !/\/$/.test(l.trim())) onFile();
      };
      p.stdout.on("data", eat); p.stderr.on("data", eat);   // bsdtar -v lists on stderr
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
    });
    if (ok && fs.readdirSync(dir).length) return true;
  }
  return false;
}

/** Number of files (not folders) in a .zip, read from its central directory (ZIP64 aware). 0 when unreadable. */
export function zipFileCount(zip) {
  try {
    const fd = fs.openSync(zip, "r");
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, 65557), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      let i = len - 22;
      while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
      if (i < 0) return 0;
      let cdSize = buf.readUInt32LE(i + 12), cdOff = buf.readUInt32LE(i + 16);
      if ((cdOff === 0xffffffff || buf.readUInt16LE(i + 10) === 0xffff) && i >= 20 && buf.readUInt32LE(i - 20) === 0x07064b50) {
        const z = Buffer.alloc(56);
        fs.readSync(fd, z, 0, 56, Number(buf.readBigUInt64LE(i - 12)));
        cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
      }
      const cd = Buffer.alloc(cdSize);
      fs.readSync(fd, cd, 0, cdSize, cdOff);
      let n = 0;
      for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
        const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
        if (cd[p + 46 + nl - 1] !== 0x2f) n++;
        p += 46 + nl + xl + cl;
      }
      return n;
    } finally { fs.closeSync(fd); }
  } catch { return 0; }
}

const uniq = (a) => [...new Set(a.filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid))];
