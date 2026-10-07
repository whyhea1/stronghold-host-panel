// i18n.js — 中文 / English for the panel and the 中转站 pages. Chinese is the source language and the default.
//   I18N.T("中文 {n}", { n })   the English text when English is on (and known), else the Chinese one
//   I18N.add({ "中文": "English" })   dictionary entries (each page adds its own)
//   I18N.apply(root)            translates the static text nodes and placeholder / title / aria-label attributes
//   I18N.set("en")              remembers the choice (localStorage "sh-lang") and reloads
// Order: ?lang= in the URL, then the saved choice, then the game's own choice on the same site, then Chinese.
(function () {
  "use strict";
  var KEY = "sh-lang";
  var ls = function (k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
  var q = null;
  try { q = new URLSearchParams(location.search).get("lang"); } catch (e) {}
  q = q === "en" || q === "zh" ? q : null;
  if (q) ls(KEY, q);
  var lang = q || ls(KEY);
  if (lang !== "en" && lang !== "zh") {
    lang = "zh";
    try {   // the game remembers its language under a key ending in "lang"
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k !== KEY && /(^|[.:_-])lang$/i.test(k) && /^"?en/i.test(localStorage.getItem(k) || "")) { lang = "en"; break; }
      }
    } catch (e) {}
  }
  var dict = {};
  function T(zh, vars) {
    var s = lang === "en" && Object.prototype.hasOwnProperty.call(dict, zh) ? dict[zh] : zh;
    if (vars) s = String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  }
  function add(d) { for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) dict[k] = d[k]; }
  var ATTRS = ["placeholder", "title", "aria-label"];
  function apply(root) {
    if (lang !== "en") return;
    root = root || document.body;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), n, list = [];
    while ((n = w.nextNode())) list.push(n);
    list.forEach(function (t) {
      var p = t.parentNode && t.parentNode.nodeName;
      if (p === "SCRIPT" || p === "STYLE" || p === "CODE") return;
      var raw = t.nodeValue, key = raw.trim();
      if (key && Object.prototype.hasOwnProperty.call(dict, key)) t.nodeValue = raw.replace(key, dict[key]);
    });
    var els = root.querySelectorAll ? root.querySelectorAll("[placeholder],[title],[aria-label]") : [];
    for (var j = 0; j < els.length; j++) ATTRS.forEach(function (a) {
      var v = els[j].getAttribute(a);
      if (v && Object.prototype.hasOwnProperty.call(dict, v.trim())) els[j].setAttribute(a, dict[v.trim()]);
    });
    if (Object.prototype.hasOwnProperty.call(dict, document.title)) document.title = dict[document.title];
  }
  function set(l) { ls(KEY, l === "en" ? "en" : "zh"); location.reload(); }
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
  document.documentElement.dataset.lang = lang;
  window.I18N = { lang: lang, T: T, add: add, apply: apply, set: set };
})();
