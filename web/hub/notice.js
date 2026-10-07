// Injected by the host hub into every game page: the host's announcement and the automatic
// 流量提醒 (daily data budget), each as its own bar. A closed bar stays closed until its text changes.
(function () {
  var host = null, bars = {}, closed = {};
  // language: the hub choice (sh-lang), else the game page's own language
  function isEn() {
    try {
      var v = localStorage.getItem("sh-lang");
      if (v) return v === "en";
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/(^|[.:_-])lang$/i.test(k) && /^"?en/i.test(localStorage.getItem(k) || "")) return true;
      }
    } catch (e) {}
    return /^en/i.test(document.documentElement.lang || "");
  }
  var KINDS = [
    { key: "text", label: "房主公告", labelEn: "HOST", color: "#ffc600" },
    { key: "auto", label: "流量提醒", labelEn: "DATA", color: "#f6a329" },
  ];
  function ensureHost() {
    if (host) return host;
    host = document.createElement("div");
    host.setAttribute("role", "status");
    host.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;flex-direction:column;pointer-events:none";
    document.body.appendChild(host);
    return host;
  }
  function bar(kind) {
    if (bars[kind.key]) return bars[kind.key];
    var el = document.createElement("div");
    el.style.cssText = "pointer-events:auto;display:flex;align-items:center;gap:12px;padding:9px 16px;" +
      "background:rgba(12,15,14,.94);color:#eef1ef;border-bottom:2px solid " + kind.color + ";" +
      "font:600 14px/1.4 -apple-system,'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif;" +
      "box-shadow:0 4px 18px rgba(0,0,0,.45);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)";
    el.innerHTML = '<span style="flex:none;color:' + kind.color + ';font:400 10.5px/1 \'Novecento Wide\',\'Bender\',sans-serif;letter-spacing:.2em">' + (isEn() ? kind.labelEn : kind.label) + '</span>' +
      '<span data-t style="flex:1;min-width:0"></span>' +
      '<button aria-label="' + (isEn() ? "Close" : "关闭") + '" style="flex:none;background:none;border:0;color:#8e9893;font:inherit;font-size:18px;cursor:pointer;padding:0 4px">×</button>';
    el.querySelector("button").onclick = function () { closed[kind.key] = el.getAttribute("data-v"); el.style.display = "none"; };
    ensureHost().appendChild(el);
    return (bars[kind.key] = el);
  }
  function show(d) {
    KINDS.forEach(function (k) {
      var text = (d && ((k.key === "auto" && isEn() && d.autoEn) || d[k.key])) || "";
      var el = bars[k.key];
      if (!text) { if (el) el.style.display = "none"; return; }
      el = bar(k);
      if (el.getAttribute("data-v") !== text) { el.setAttribute("data-v", text); el.querySelector("[data-t]").textContent = text; }
      el.style.display = closed[k.key] === text ? "none" : "flex";
    });
  }
  function tick() {
    fetch("/__panel/notice", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(show).catch(function () {});
  }
  tick();
  setInterval(tick, 5000);
})();
