// sakura.mjs — SakuraFrp account / node / check-in monitoring via open API v4.
// Docs: https://github.com/natfrp/api  (Bearer <访问密钥>). The API has no
// check-in endpoint, so the panel reminds instead of auto-claiming.
import { notify } from "./platform.mjs";
import { config, state, log, sendState, frpcIni } from "./core.mjs";
import { fetchText } from "./updater.mjs";

export function sakuraToken() {
  return config.sakuraToken || frpcIni().user || "";
}

async function api(pathname) {
  const token = sakuraToken();
  if (!token) return null;
  const raw = await fetchText("https://api.natfrp.com/v4" + pathname, [`Authorization: Bearer ${token}`], 15);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

let nodesCache = { at: 0, data: null };
let remindedFor = "";

export async function pollSakura() {
  if (!sakuraToken()) return;
  const needNodes = !nodesCache.data || Date.now() - nodesCache.at > 600000;
  const [user, plans, nodes, stats] = await Promise.all([
    api("/user/info"), api("/user/data_plans"), needNodes ? api("/nodes") : null, api("/node/stats"),
  ]);
  if (user && !user.ban) state.sakura.user = user;
  if (Array.isArray(plans)) state.sakura.plans = plans;
  if (nodes && typeof nodes === "object") nodesCache = { at: Date.now(), data: nodes };

  const all = Object.entries(nodesCache.data || {});
  if (all.length) {
    // node: by name from settings, otherwise by the server_addr that frpc.ini connects to
    const host = frpcIni().host;
    const entry = config.nodeName
      ? all.find(([, n]) => n.name === config.nodeName) || all.find(([, n]) => (n.name || "").includes(config.nodeName))
      : host ? all.find(([, n]) => n.host === host) : null;
    if (!entry) state.sakura.myNode = (config.nodeName || host)
      ? { name: config.nodeName || host, notFound: true, known: all.slice(0, 12).map(([, n]) => n.name) }
      : null;
    else {
      const id = Number(entry[0]);
      const st = stats && Array.isArray(stats.nodes) ? stats.nodes.find((s) => s.id === id) : null;
      state.sakura.myNode = {
        id, name: entry[1].name, host: entry[1].host,
        online: st ? st.online >= 0 : null, load: st ? st.load : null,
        uptimeHours: st ? Math.round(st.uptime / 3600) : null,
      };
    }
  }

  const sign = state.sakura.user && state.sakura.user.sign;
  if (sign && sign.config !== false && sign.signed === false) {
    const today = new Date().toDateString();
    if (remindedFor !== today) {
      remindedFor = today;
      log("panel", "reminder: today's SakuraFrp 签到 is not done yet");
      notify("SakuraFrp 签到提醒", "今日免费流量还没签到，打开面板一键前往");
    }
  }
  sendState();
}

export function startSakuraPolling() {
  setTimeout(pollSakura, 3000);
  setInterval(pollSakura, 60000);
}
