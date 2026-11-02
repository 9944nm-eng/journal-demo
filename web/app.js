/* Торговый журнал MT5 - интерфейс */
"use strict";

const S = {
  st: null,                  // /api/state
  login: null,
  period: +(localStorage.getItem("period") ?? 30),
  calMonth: null,            // Date (UTC) первого числа отображаемого месяца
  breakdown: "by_symbol",
  tf: null,
  charts: [],
  filters: { q: "", symbol: "", direction: "", source: "", setup: "", status: "", day: "", session: "", plan: "" },
};

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------- formatting ---------- */
const ccy = () => (S.st?.accounts?.find((a) => a.login === S.login)?.currency) || "";
const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// результат торговли - в R по умолчанию; деньги и % - переключателем в Сделках и Аналитике
S.unit = localStorage.getItem("unit2") || "R";
const pctBase = () => S.st?.base || S.st?.deposits || null;
// % - результат в процентах от размера счёта. Балансы (signed=false) всегда в валюте.
function money(n, signed = true) {
  if (signed !== false && S.unit === "%" && pctBase() && n !== null && n !== undefined) {
    const v = (100 * n) / pctBase();
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + "%";
  }
  if (n === null || n === undefined) return "—";
  const s = nf2.format(Math.abs(n));
  const sign = n > 0 ? (signed ? "+" : "") : n < 0 ? "−" : "";
  return `${sign}${s}${ccy() ? " " + ccy() : ""}`;
}
function compact(n) {
  if (S.unit === "%" && pctBase()) { const v = (100 * n) / pctBase(); return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + "%"; }
  const a = Math.abs(n), sign = n > 0 ? "+" : n < 0 ? "−" : "";
  if (a >= 10000) return sign + Math.round(a / 1000) + "k";
  if (a >= 1000) return sign + (a / 1000).toFixed(1).replace(".", ",") + "k";
  return sign + Math.round(a);
}
// R - если у сделки или группы есть R, иначе деньги
const U = (net, r) => (S.unit === "R" && r !== null && r !== undefined ? rfmt(r) : money(net));
const UC = (net, r) => (S.unit === "R" && r !== null && r !== undefined ? rfmt(r) : compact(net));
const cls = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const price = (n, d) => (n === null || n === undefined ? "—" : Number(n).toFixed(d ?? 5));
const rfmt = (r) => (r === null || r === undefined ? "—" : (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r).toFixed(2).replace(".", ",") + "R");
const shift = () => S.st?.shift || 0;
function dt(ts, withTime = true) {
  if (!ts) return "—";
  const d = new Date((ts + shift()) * 1000);
  const p = (x) => String(x).padStart(2, "0");
  const date = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}`;
  return withTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
function dur(sec) {
  if (!sec && sec !== 0) return "—";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `${h} ч ${mm} мин` : `${h} ч`;
  const d = Math.floor(h / 24), hh = h % 24;
  return hh ? `${d} д ${hh} ч` : `${d} д`;
}
const localTime = (ts) => new Date(ts * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
function ago(ts) {
  if (!ts) return "ещё не синхронизировано";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "обновлено только что";
  if (s < 3600) return `обновлено ${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `обновлено ${Math.round(s / 3600)} ч назад`;
  return `обновлено ${localTime(ts)}`;
}
const dirBadge = (d) => (d === 1 ? '<span class="dir buy">Buy</span>' : '<span class="dir sell">Sell</span>');
const srcLabel = (t) => `<span class="src ${t.open_reason === 1 ? "phone" : ""}">${esc(t.source)}</span>`;
const stars = (g) => (g ? `<span class="stars" aria-label="Оценка ${g} из 5">${"★".repeat(g)}${"☆".repeat(5 - g)}</span>` : "");

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = path.startsWith("/api/trade/") || path.startsWith("/api/chart/") ? path : `${path}${sep}login=${S.login || ""}`;
  const r = await fetch(url, { headers: { "Content-Type": "application/json" }, ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `Ошибка ${r.status}`);
  return data;
}
function periodQuery() {
  const p = new URLSearchParams();
  if (S.period > 0) p.set("from", Math.floor(Date.now() / 1000) - S.period * 86400);
  return p;
}
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), err ? 6000 : 2600);
}
function fitOnResize(chart, el) {
  // у удалённого графика fitContent не падает сразу, а ломает следующий кадр отрисовки: проверяем заранее
  const ro = new ResizeObserver(() => {
    if (DEAD_CHARTS.has(chart) || !el.isConnected) { ro.disconnect(); return; }
    try { chart.timeScale().fitContent(); } catch (e) { ro.disconnect(); }
  });
  ro.observe(el);
}
const DEAD_CHARTS = new WeakSet();
function killCharts() {
  S.charts.forEach((c) => { DEAD_CHARTS.add(c); try { c.remove(); } catch (e) {} });
  S.charts = [];
}
// подсказка при наведении на любой график: время и значения всех линий (у свечей - O/H/L/C)
function chartTooltip(c, el) {
  const tip = document.createElement("div");
  tip.className = "chart-tip hidden";
  el.appendChild(tip);
  const tfmt = (t) => {
    if (typeof t !== "number") return t && t.year ? `${String(t.day).padStart(2, "0")}.${String(t.month).padStart(2, "0")}.${String(t.year).slice(2)}` : "";
    const d = new Date(t * 1000), p = (x) => String(x).padStart(2, "0");
    const hm = d.getUTCHours() || d.getUTCMinutes() ? ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : "";
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${String(d.getUTCFullYear()).slice(2)}${hm}`;
  };
  c.subscribeCrosshairMove((param) => {
    if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) { tip.classList.add("hidden"); return; }
    const rows = [];
    for (const [s, v] of param.seriesData) {
      if (!v) continue;
      let f = (x) => x;
      try { const pf = s.priceFormatter(); f = (x) => pf.format(x); } catch (e) {}
      const title = s.options().title;
      if (v.open !== undefined) rows.push(`<span>O <b>${f(v.open)}</b> H <b>${f(v.high)}</b> L <b>${f(v.low)}</b> C <b class="${v.close >= v.open ? "pos" : "neg"}">${f(v.close)}</b></span>`);
      else if (v.value !== undefined) rows.push(`<span>${title ? esc(title) + " " : ""}<b>${f(v.value)}</b></span>`);
    }
    if (!rows.length) { tip.classList.add("hidden"); return; }
    tip.innerHTML = `<small>${tfmt(param.time)}</small>${rows.join("")}`;
    tip.classList.remove("hidden");
    const w = tip.offsetWidth, h = tip.offsetHeight, W = el.clientWidth;
    let x = param.point.x + 14, y = param.point.y + 14;
    if (x + w > W - 70) x = param.point.x - w - 14;
    if (y + h > el.clientHeight - 30) y = param.point.y - h - 14;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  });
}

function chartBase(el, extra = {}) {
  const { tooltip = true, ...rest } = extra;
  extra = rest;
  const c = LightweightCharts.createChart(el, {
    autoSize: true,
    // единый стиль графиков: без вертикальной сетки, едва заметные горизонтали, цифры моноширинным
    layout: { background: { type: "solid", color: "transparent" }, textColor: css("--muted"), fontFamily: css("--mono") || css("--font"), fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--line-soft") } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0, vertLine: { color: css("--muted"), width: 1, style: 3, labelBackgroundColor: css("--surface-3") }, horzLine: { color: css("--muted"), width: 1, style: 3, labelBackgroundColor: css("--surface-3") } },
    localization: { locale: "ru-RU" },
    ...extra,
  });
  S.charts.push(c);
  if (motionOn() && !S.quiet) wipeChart(el);
  if (tooltip) { if (getComputedStyle(el).position === "static") el.style.position = "relative"; chartTooltip(c, el); }
  return c;
}

/* ---------- shell ---------- */
async function loadState() {
  S.st = await api("/api/state");
  if (!S.login) S.login = +localStorage.getItem("login") || S.st.login;
  if (S.st.accounts.length && !S.st.accounts.some((a) => a.login === S.login)) S.login = S.st.accounts[0].login;
  const acc = S.st.accounts.find((a) => a.login === S.login) || S.st.accounts[0];
  drawAccountSwitch(acc);
  if (!syncBar.classList.contains("on")) drawSyncStatus(acc);
  const open = await api("/api/trades?status=open");
  S.openN = open.length;
  try { const td = await api("/api/todo"); S.todo = { ...td, cur_week: (await api("/api/week/focus")).week }; } catch (e) {}
  const n = S.todo?.unreviewed?.length || 0;
  $("#reviewCount").textContent = n || "";
  // недельный разбор ждёт: точка у «Аналитики», ссылка ведёт сразу в «Недели»
  const wa = document.querySelector('.rail nav a[data-view="analytics"]');
  if (wa) { wa.classList.toggle("has-dot", !!S.todo?.week_due); wa.title = S.todo?.week_due ? "Недельный разбор не сделан" : ""; wa.href = S.todo?.week_due ? `#/week/${S.todo.week_due}` : "#/analytics"; }
}

// короткое имя счёта: «Alpha Capital Group - Alpha pro Stage 1 - Имя» -> «Alpha Capital Group · Фаза 1»
function accShort(a) {
  if (!a) return "Счёт";
  const parts = String(a.label || a.name || "").split(/\s+[-–—|]\s+/).filter(Boolean);
  const firm = parts.length >= 3 ? parts[0] : (a.label || a.name || a.company || String(a.login));
  const phase = (String(a.label || "").match(/(phase|stage|фаза)\s*(\d)/i) || [])[2];
  return (firm.replace(/[\s,]+(limited|ltd\.?|llc|inc\.?)$/i, "") + (phase ? ` · Фаза ${phase}` : "")).trim();
}
function drawAccountSwitch(acc) {
  $("#accLabel").textContent = acc ? accShort(acc) : "Нет счетов";
  const pop = $("#accPop");
  pop.innerHTML = `<h3>Счёт</h3>${S.st.accounts.map((a) => `<button class="menu-item" data-lg="${a.login}" type="button">
      <span style="width:8px;height:8px;border-radius:50%;flex:none;background:${a.login === S.login ? "var(--accent-text)" : "var(--surface-3)"}"></span>
      <span style="display:flex;flex-direction:column;min-width:0"><b style="font-weight:${a.login === S.login ? 600 : 500}">${esc(accShort(a))}</b><small style="margin:0;color:var(--muted)">${a.login} · ${money(a.balance, false)}</small></span></button>`).join("")}
    <div class="menu-sep"></div><a class="menu-item" href="#/accounts">Все счета</a><a class="menu-item" href="#/accounts/new">Подключить счёт</a>`;
  pop.querySelectorAll("[data-lg]").forEach((b) => (b.onclick = () => {
    S.login = +b.dataset.lg; localStorage.setItem("login", S.login); S.calMonth = null; closePops(); loadState().then(route);
  }));
}
function drawSyncStatus(acc) {
  const last = S.st?.log?.[0];
  $("#syncDot").className = "sync-dot" + (last && last.status === "error" ? " err" : "");
  $("#syncStatus").textContent = (S.st?.mode === "demo" ? "демо · " : "") + ago(acc?.last_sync).replace("обновлено ", "");
}
function drawSyncPop() {
  const log = (S.st?.log || []).slice(0, 8);
  $("#syncPop").innerHTML = `<h3>Синхронизация с MT5</h3>
    ${S.st?.sync_paused ? '<p class="muted" style="margin:0 4px 10px;font-size:13px">Выходные: рынок закрыт, журнал сам не синхронизируется до вечера воскресенья. Кнопка ниже работает.</p>' : ""}
    <div class="sync-log">${log.map((l) => `<div><span>${localTime(l.started)}</span><span class="${l.status === "ok" ? "" : l.status === "skip" ? "muted" : "neg"}">${esc(l.message || l.status)}</span></div>`).join("") || '<div><span>—</span><span class="muted">запусков ещё не было</span></div>'}</div>
    <div style="display:flex;gap:8px;padding:0 4px 4px"><button class="btn primary sm" id="spNow" type="button">Синхронизировать</button><button class="btn sm" id="spFull" type="button" title="Перечитать историю сделок с начала">Вся история</button>
      <a class="btn sm link" href="#/sync" style="margin-left:auto">Подробнее</a></div>`;
  $("#spNow").onclick = () => { closePops(); doSync(false); };
  $("#spFull").onclick = () => { closePops(); doSync(true); };
}
// всплывающие панели шапки: одна открыта за раз, закрываются кликом мимо и Esc
const POPS = { accBtn: "accPop", syncBtn: "syncPop", menuBtn: "menuPop" };
function closePops() { for (const [b, p] of Object.entries(POPS)) { $("#" + p).classList.add("hidden"); $("#" + b).setAttribute("aria-expanded", "false"); } }
for (const [b, p] of Object.entries(POPS)) {
  $("#" + b).addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("#" + p).classList.contains("hidden");
    closePops();
    if (!open) return;
    if (p === "syncPop") drawSyncPop();
    if (p === "menuPop") exportLinks();
    $("#" + p).classList.remove("hidden"); $("#" + b).setAttribute("aria-expanded", "true");
  });
}
document.addEventListener("click", (e) => { if (!e.target.closest(".top .pop-wrap")) closePops(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePops(); });
$("#menuPop").addEventListener("click", (e) => { if (e.target.closest("a")) setTimeout(closePops, 100); });

function setPeriodButtons() {
  document.querySelectorAll("#periods button").forEach((b) => b.classList.toggle("on", +b.dataset.p === S.period));
}
$("#periods").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  S.period = +b.dataset.p;
  localStorage.setItem("period", S.period);
  S.calMonth = null;
  setPeriodButtons();
  route();
});

/* ход синхронизации: тонкая полоса сверху и шаг рядом с кнопкой. Ловит и фоновые синхронизации */
const syncBar = (() => { const d = document.createElement("div"); d.className = "sync-progress"; d.innerHTML = "<i></i>"; document.body.appendChild(d); return d; })();
let syncWasRunning = false;
function showSyncProgress(p) {
  const i = syncBar.firstChild;
  if (p.running) {
    syncBar.classList.add("on");
    const pct = p.total ? (p.done + 0.5) / (p.total + 1) : 0.15;
    i.style.width = Math.round(Math.min(0.95, Math.max(0.08, pct)) * 100) + "%";
    $("#syncStatus").textContent = [p.label, p.step].filter(Boolean).join(": ") || "синхронизация";
    $("#syncStatus").classList.add("sync-step");
    $("#syncDot").className = "sync-dot busy";
  } else if (syncBar.classList.contains("on")) {
    i.style.width = "100%";
    setTimeout(() => { syncBar.classList.remove("on"); setTimeout(() => (i.style.width = "0"), 350); }, 350);
    $("#syncStatus").classList.remove("sync-step");
  }
}
// перерисовать раздел тихо: без анимаций появления и с сохранением прокрутки
async function quietRefresh() {
  const y = window.scrollY;
  S.quiet = true;
  try { await route(); } finally { S.quiet = false; }
  window.scrollTo(0, y);
}
// фоновая синхронизация по расписанию: когда закончится, данные на экране обновятся сами
setInterval(async () => {
  if (document.hidden || S.syncing) return;
  try {
    const p = await fetch("/api/sync/status").then((r) => r.json());
    showSyncProgress(p);
    if (syncWasRunning && !p.running) {
      await loadState();
      const name = location.hash.replace(/^#\/?/, "").split("/")[0];
      if (["", "accounts", "goals", "trades", "open", "day", "days", "sync", "portfolio", "analytics"].includes(name) && !(typeof userBusy === "function" && userBusy())) quietRefresh();
    }
    syncWasRunning = p.running;
  } catch (e) { /* сервер недоступен */ }
}, 4000);

async function doSync(full) {
  if (S.syncing) return;
  S.syncing = true;
  showSyncProgress({ running: true, total: 0, done: 0, step: "подключение к терминалу" });
  const poll = setInterval(() => fetch("/api/sync/status").then((r) => r.json()).then((p) => p.running && showSyncProgress(p)).catch(() => {}), 700);
  try {
    const r = await api("/api/sync", { method: "POST", body: JSON.stringify({ full }) }).catch((e) => ({ status: "error", message: e.message }));
    const bad = (r.accounts || []).filter((x) => x.status === "error");
    toast(r.status === "busy" ? r.message : bad.length ? `Синхронизация с ошибками: ${bad.map((x) => (x.login || "счёт") + " - " + x.message).join("; ")}` : `Синхронизировано: ${(r.accounts || []).map((x) => x.login).filter(Boolean).join(", ")}`, !!bad.length);
    // выбранный счёт не меняется: журнал остаётся на том счёте, который вы смотрели
  } catch (e) {
    toast(e.message, true);
  } finally {
    clearInterval(poll);
    showSyncProgress({ running: false });
    S.syncing = false;
    await loadState();
    quietRefresh();
  }
}

/* тема: как в Windows (по умолчанию), тёмная или светлая. Графики перерисовываются под новые цвета */
const darkMQ = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(t, redraw = true) {
  t = ["system", "dark", "light"].includes(t) ? t : "system";
  localStorage.setItem("theme", t);
  const dark = t === "dark" || (t === "system" && darkMQ.matches);
  const prev = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelectorAll("#themeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
  if (redraw && prev !== document.documentElement.dataset.theme) quietRefresh();
}
darkMQ.addEventListener("change", () => { if ((localStorage.getItem("theme") || "system") === "system") applyTheme("system"); });
$("#themeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) applyTheme(b.dataset.t); });

/* ---------- router ---------- */
// заготовка раздела, пока он грузится дольше 150 мс (вместо пустого экрана)
const skeletonHTML = () => `<div class="skel"><div class="skel-h"></div><div class="skel-row">${'<div class="skel-b"></div>'.repeat(4)}</div><div class="skel-big"></div><div class="skel-row">${'<div class="skel-b tall"></div>'.repeat(2)}</div></div>`;

async function route() {
  killCharts();
  leaveView(view);
  const first = view.firstElementChild;
  const sk = S.quiet ? null : setTimeout(() => { if (view.firstElementChild === first) { view.classList.remove("view-out"); view.innerHTML = skeletonHTML(); } }, 150);
  const h = location.hash.replace(/^#\/?/, "");
  let [name, a, b] = h.split("/");
  if (name === "today") name = "";
  const grp = groupOf(name);
  document.querySelectorAll(".rail nav a, .rail-foot a").forEach((x) => x.classList.toggle("active", x.dataset.view === grp));
  // период и единицы нужны только там, где считается статистика
  $("#pageTools").classList.toggle("hidden", !["trades", "analytics", "analysis", "discipline", "days"].includes(name));
  if (name !== "trade") S.reviewMode = name === "review" ? S.reviewMode : false;
  countVisit(grp);
  try {
    if (!name) await renderToday(a);
    else if (name === "trades") await renderTrades();
    else if (name === "open") await renderOpen();
    else if (name === "sync") await renderSync();
    else if (name === "goals") await renderGoals();
    else if (name === "market") await renderMarket();
    else if (name === "cot") await renderCot(a);
    else if (name === "day") await renderDay(a);
    else if (name === "days") await renderDays();
    else if (name === "analytics") await renderResult();
    else if (name === "analysis") await renderAnalysis(a);
    else if (name === "discipline" || name === "habits") await renderDiscipline();
    else if (name === "playbooks") await renderPlaybooks(a);
    else if (name === "notes") await renderNotes(a);
    else if (name === "settings") await renderSettings();
    else if (name === "accounts") await renderAccounts(a);
    else if (name === "trade") await renderTrade(+a, +b);
    else if (name === "week") await renderWeek(a);
    else if (name === "review") await startReview();
    else if (name === "ts") await renderTS(a);
    else if (name === "backtest") await renderBacktest(a);
    else if (name === "portfolio") await renderPortfolio();
    else if (name === "month") await renderMonth(a);
    else { location.hash = "#/"; return; }
    addSubtabs(name);
    weekBanner(name);
    clearTimeout(sk);
    view.classList.toggle("m-quiet", !!S.quiet);
    // новая страница открывается сверху; смена периода или тихое обновление прокрутку не трогают
    if (!S.quiet && S.lastHash !== location.hash) window.scrollTo(0, 0);
    S.lastHash = location.hash;
    if (typeof tickReset === "function") tickReset();  // таймер сброса лимита сразу, а не через секунду с прочерком
    enterView(view);
  } catch (e) {
    clearTimeout(sk);
    view.classList.remove("view-out");
    view.innerHTML = emptyState("Не удалось загрузить раздел", `${esc(e.message)}. Если ошибка повторяется, перезапустите журнал через значок в трее.`,
      '<button class="btn primary sm" onclick="route()">Повторить</button>', "error");
  }
}
window.addEventListener("hashchange", route);

/* Единое пустое состояние / ошибка уровня страницы: заголовок, пояснение, действие */
const STATE_ICONS = {
  empty: '<path d="M4 13h4l2 3h4l2-3h4"/><path d="M5.5 6h13L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z"/>',
  done: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  error: '<path d="M12 8v5"/><path d="M12 16.5v.5"/><path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/>',
};
function emptyState(title, text = "", action = "", kind = "empty") {
  return `<section class="panel state state-${kind}" role="${kind === "error" ? "alert" : "status"}">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STATE_ICONS[kind] || STATE_ICONS.empty}</svg>
    <h2>${title}</h2>${text ? `<p>${text}</p>` : ""}${action ? `<div class="state-act">${action}</div>` : ""}</section>`;
}

/* ---------- разделы и вкладки внутри них ---------- */
const GROUPS = {
  today: [["", "#/", "Сегодня"], ["days", "#/days", "Дни"]],
  trades: [["trades", "#/trades", "Все сделки"], ["review", "#/review", "Разбор подряд"]],
  analytics: [["analytics", "#/analytics", "Результат"], ["analysis", "#/analysis", "Преимущество"], ["discipline", "#/discipline", "Дисциплина"], ["week", "#/week", "Недели"], ["month", "#/month", "Месяц"]],
  strategy: [["ts", "#/ts", "Моя ТС"], ["playbooks", "#/playbooks", "Плейбуки"], ["backtest", "#/backtest", "Бэктест"], ["cot", "#/cot", "Рынок"], ["notes", "#/notes", "Заметки"]],
  accounts: [["accounts", "#/accounts", "Счета"], ["portfolio", "#/portfolio", "Все вместе"], ["goals", "#/goals", "Цели счёта"]],
  settings: [["settings", "#/settings", "Настройки"], ["sync", "#/sync", "Синхронизация"]],
};
// страницы, которые живут во вкладке другого раздела
const TAB_ALIAS = { open: "trades", trade: "trades", day: "", market: "cot", habits: "discipline" };
function groupOf(name) {
  const n = TAB_ALIAS[name] ?? name;
  for (const [g, items] of Object.entries(GROUPS)) if (items.some(([k]) => k === n)) return g;
  return "today";
}
function addSubtabs(name) {
  const cur = TAB_ALIAS[name] ?? name;
  const g = GROUPS[groupOf(name)];
  if (!g || name === "trade" || view.querySelector(".subtabs")) return;
  const n = S.todo?.unreviewed?.length || 0;
  const extra = cur === "cot" ? `<div class="seg" style="margin:-8px 0 20px"><a href="#/cot" class="${name === "cot" ? "on" : ""}">COT</a><a href="#/market" class="${name === "market" ? "on" : ""}">Макро</a></div>` : "";
  view.insertAdjacentHTML("afterbegin", `<nav class="subtabs" aria-label="Подразделы">${g.map(([k, href, l]) =>
    `<a href="${href}" class="${k === cur ? "on" : ""}">${l}${k === "review" && n ? `<span class="count">${n}</span>` : ""}</a>`).join("")}</nav>${extra}`);
}
function weekBanner(name) {
  if (name) return;  // напоминания только на «Сегодня»: остальные разделы без лишнего
  const due = S.todo?.week_due;
  if (due && !view.querySelector(".week-banner")) view.querySelector(".today-head")?.insertAdjacentHTML("afterend", `<div class="week-banner"><span><b>Недельный разбор.</b> ${due === S.todo.cur_week ? "Подведите итоги недели и задайте фокус на следующую." : "Разбор прошлой недели ещё не сделан."}</span><a class="btn sm" href="#/week/${due}">Сделать разбор</a></div>`);
  if (S.st && !S.st.ts_saved && !view.querySelector(".ts-banner")) view.querySelector(".today-head")?.insertAdjacentHTML("afterend", `<div class="week-banner ts-banner"><span><b>Составь свою ТС.</b> 18 вопросов с готовыми ответами по твоим сделкам, после чего журнал будет сверять с ней каждую сделку.</span><a class="btn sm primary" href="#/ts">Начать</a></div>`);
}
// какие разделы открываются чаще: только локально, для будущей настройки структуры
function countVisit(grp) {
  try { const v = JSON.parse(localStorage.getItem("visits") || "{}"); v[grp] = (v[grp] || 0) + 1; localStorage.setItem("visits", JSON.stringify(v)); } catch (e) {}
}

/* ---------- разбор подряд ---------- */
async function startReview() {
  const td = await api("/api/todo");
  S.todo = { ...td, cur_week: S.todo?.cur_week };
  if (!td.unreviewed.length) {
    view.innerHTML = emptyState("Все сделки за 3 недели разобраны", "Новые сделки после синхронизации появятся здесь.", '<a class="btn sm" href="#/trades">Все сделки</a>', "done");
    return;
  }
  S.reviewMode = true;
  S.reviewQueue = [...td.unreviewed];  // "login:pid" - очередь по всем счетам
  const [lg, id] = S.reviewQueue[0].split(":");
  location.hash = `#/trade/${lg}/${id}`;
}

/* ---------- быстрый поиск Ctrl+K ---------- */
(function palette() {
  const ACTIONS = [
    ["Сегодня", "#/"], ["План и итог дня", "#/day"], ["Дни", "#/days"],
    ["Все сделки", "#/trades"], ["Открытые позиции", "#/open"], ["Разобрать сделки подряд", "#/review"],
    ["Результат", "#/analytics"], ["Инсайты", "#/analysis/insights"], ["Исполнение", "#/analysis/exec"], ["Что если", "#/analysis/whatif"],
    ["Вероятность пройти челлендж", "#/analysis/mc"], ["Статистика рынка", "#/analysis/market"], ["Дисциплина и привычки", "#/discipline"], ["Недельный разбор", "#/week"],
    ["Моя ТС", "#/ts"], ["Плейбуки", "#/playbooks"], ["Новый плейбук", "#/playbooks/new"], ["Бэктест", "#/backtest"], ["Пошаговый бэктест", "#/backtest/replay"],
    ["COT", "#/cot"], ["Макро", "#/market"], ["Заметки", "#/notes"], ["Новая заметка", "#/notes/new"],
    ["Счета", "#/accounts"], ["Все счета вместе", "#/portfolio"], ["Цели счёта", "#/goals"], ["Подключить счёт", "#/accounts/new"],
    ["Синхронизация", "#/sync"], ["Настройки", "#/settings"], ["Синхронизировать сейчас", "action:sync"],
  ];
  let box = null, trades = null, sel = 0, items = [];
  const close = () => { box?.remove(); box = null; };
  const go = (it) => { close(); if (it.href === "action:sync") doSync(false); else location.hash = it.href; };
  const draw = () => {
    const qv = box.querySelector("input").value.trim().toLowerCase();
    const acts = ACTIONS.filter(([l]) => !qv || l.toLowerCase().includes(qv)).map(([l, href]) => ({ l, href, kind: "Раздел" }));
    const tr = qv && trades ? trades.filter((t) => [t.symbol, t.position_id, t.setup, t.entry_model, t.notes, t.tags].join(" ").toLowerCase().includes(qv)).slice(0, 8)
      .map((t) => ({ l: `${t.symbol} ${t.direction === 1 ? "Buy" : "Sell"}, ${dt(t.open_time)}, ${money(t.net)}`, href: `#/trade/${S.login}/${t.position_id}`, kind: "Сделка" })) : [];
    items = [...acts.slice(0, qv ? 8 : 12), ...tr];
    sel = Math.min(sel, Math.max(0, items.length - 1));
    box.querySelector(".cmd-list").innerHTML = items.map((it, i) => `<div class="cmd-item ${i === sel ? "on" : ""}" data-i="${i}"><span>${esc(it.l)}</span><small>${it.kind}</small></div>`).join("") || '<div class="empty">Ничего не найдено</div>';
    box.querySelectorAll(".cmd-item").forEach((el) => (el.onclick = () => go(items[+el.dataset.i])));
  };
  const open = async () => {
    if (box) return;
    box = document.createElement("div");
    box.className = "cmd";
    box.innerHTML = `<div class="cmd-box" role="dialog" aria-label="Быстрый поиск"><input type="search" placeholder="Раздел, действие, инструмент, тикет, заметка" aria-label="Поиск"><div class="cmd-list"></div>
      <div class="cmd-foot muted">↑↓ выбрать, Enter открыть, Esc закрыть</div></div>`;
    document.body.appendChild(box);
    box.onclick = (e) => { if (e.target === box) close(); };
    const inp = box.querySelector("input");
    inp.focus();
    inp.oninput = () => { sel = 0; draw(); };
    inp.onkeydown = (e) => {
      if (e.key === "ArrowDown") { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
      if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
      if (e.key === "Enter" && items[sel]) go(items[sel]);
      if (e.key === "Escape") close();
    };
    draw();
    if (!trades) { try { trades = await api("/api/trades"); } catch (e) { trades = []; } if (box) draw(); }
  };
  document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); } });
  $("#cmdBtn")?.addEventListener("click", open);
  window.addEventListener("hashchange", () => { trades = null; });
})();

/* ---------- единицы ---------- */
(function units() {
  const seg = $("#unitSeg");
  const draw = () => seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.u === S.unit));
  draw();
  seg.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.unit = b.dataset.u; localStorage.setItem("unit2", S.unit); draw(); quietRefresh(); };
})();

function openDay(day) {
  S.filters.day = day;
  location.hash = "#/trades";
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/* ---------- trades ---------- */
const isReviewed = (t) => !!(t.grade || (t.followed_plan !== null && t.followed_plan !== undefined) || (t.entry_reason || "").trim() || t.setup);
const TFIELDS = {
  open_time: ["Открыта", (t) => `<span class="t-mono" style="font-size:13px">${dt(t.open_time)}</span>`],
  glyph: ["Стоп · вход · тейк", (t) => tradeGlyph(t, 72)],
  reviewed: ["Разбор", (t) => (t.status === "open" ? "" : isReviewed(t) ? `<span class="muted">${t.setup_grade ? `<span class="grade-chip g${t.setup_grade}">${t.setup_grade}</span> ` : ""}разобрана</span>` : '<span style="color:var(--warn)">не разобрана</span>')],
  close_time: ["Закрыта", (t) => (t.status === "closed" ? dt(t.close_time) : '<span class="muted">открыта</span>')],
  volume: ["Объём", (t) => t.volume, true],
  entry: ["Вход", (t) => price(t.entry_price, t.digits), true],
  exit: ["Выход", (t) => (t.status === "closed" ? price(t.exit_price, t.digits) : '<span class="muted">открыта</span>'), true],
  sl: ["Стоп", (t) => (t.sl_used ? price(t.sl_used, t.digits) : "—"), true],
  tp: ["Тейк", (t) => (t.tp_initial ? price(t.tp_initial, t.digits) : "—"), true],
  duration: ["Длительность", (t) => dur(t.duration)],
  r: ["R", (t) => `<span class="${cls(t.r)}">${rfmt(t.r)}</span>`, true],
  mae: ["MAE", (t) => (t.mae_r !== null ? `<span class="neg">−${t.mae_r.toFixed(2)}R</span>` : "—"), true],
  mfe: ["MFE", (t) => (t.mfe_r !== null ? `<span class="pos">+${t.mfe_r.toFixed(2)}R</span>` : "—"), true],
  net: ["Результат", (t) => `<b class="${cls(t.net)}">${S.unit === "R" ? money(t.net) : U(t.net, t.r)}</b>`, true],
  model: ["Модель входа", (t) => esc(t.entry_model || "")],
  arguments: ["Аргументы", (t) => esc(t.arguments || "")],
  profit: ["До издержек", (t) => `<span class="${cls(t.profit)}">${money(t.profit)}</span>`, true],
  costs: ["Издержки", (t) => money(t.commission + t.swap + t.fee), true],
  source: ["Источник", (t) => srcLabel(t)],
  close_label: ["Как закрыта", (t) => `<span class="muted">${esc(t.close_label)}</span>`],
  setup: ["Сетап", (t) => esc(t.setup || "")],
  grade: ["Оценка", (t) => stars(t.grade)],
  emotion: ["Состояние", (t) => esc(t.emotion || "")],
  mistakes: ["Ошибки", (t) => esc(t.mistakes || "")],
  tags: ["Теги", (t) => esc(t.tags || "")],
  notes: ["Заметки", (t) => esc((t.notes || "").slice(0, 120))],
  session: ["Сессия", (t) => esc(t.session || "")],
  plan: ["По плану", (t) => ({ 1: '<span class="pos">да</span>', 0: '<span class="neg">нет</span>' })[t.followed_plan] || ""],
  check: ["Чек-лист", (t) => (t.check_pct === null ? "" : `<span class="${t.check_pct === 100 ? "pos" : t.check_pct < 70 ? "neg" : ""}">${t.check_pct}%</span>`), true],
  shots: ["Скриншоты", (t) => (t.shots ? `${t.shots}` : ""), true],
};
const FIELD_DEFAULTS = {
  rows: ["open_time", "glyph", "r", "net", "setup", "session", "duration", "reviewed"],
  cards: ["open_time", "session", "duration", "r", "entry", "exit", "setup", "plan", "notes"],
};
const getFields = (mode) => { try { return JSON.parse(localStorage.getItem("fields2_" + mode)) || FIELD_DEFAULTS[mode]; } catch (e) { return FIELD_DEFAULTS[mode]; } };
const setFields = (mode, f) => localStorage.setItem("fields2_" + mode, JSON.stringify(f));

function tradesHTML(list, mode, fields) {
  if (!list.length) return '<div class="empty">Сделок по этим условиям нет.</div>';
  fields = fields.filter((f) => TFIELDS[f]);
  if (mode === "cards") {
    return `<div class="cards">${list.map((t) => {
      const rr = t.r === null ? null : Math.max(-3, Math.min(3, t.r));
      const bar = rr === null ? "" : `<div class="rbar" title="${rfmt(t.r)}"><span class="mid"></span><i style="${rr >= 0 ? `left:50%;width:${(rr / 3) * 50}%;background:var(--profit)` : `right:50%;width:${(-rr / 3) * 50}%;background:var(--loss)`}"></i></div>`;
      const dl = fields.filter((f) => !["notes", "net"].includes(f));
      return `<div class="tcard ${t.net > 0 ? "win" : t.net < 0 ? "lose" : ""}" tabindex="0" data-id="${t.position_id}">
        <div class="tc-top"><span><span class="sym">${esc(t.symbol)}</span> ${dirBadge(t.direction)} <span class="muted" style="font-size:12px">${t.volume}</span></span>
          <span class="net ${cls(t.net)}">${U(t.net, t.r)}</span></div>
        ${fields.includes("r") ? bar : ""}
        ${dl.length ? `<dl>${dl.map((f) => `<dt>${TFIELDS[f][0]}</dt><dd>${TFIELDS[f][1](t) || "—"}</dd>`).join("")}</dl>` : ""}
        ${fields.includes("notes") && t.notes ? `<div class="note">${esc(t.notes)}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }
  return `<table class="t"><thead><tr><th>Инструмент</th><th></th>${fields.map((f) => `<th class="${TFIELDS[f][2] ? "num" : ""}">${TFIELDS[f][0]}</th>`).join("")}</tr></thead>
    <tbody>${list.map((t) => `<tr class="click" tabindex="0" data-id="${t.position_id}"><td><b class="t-mono">${esc(t.symbol)}</b></td><td>${dirBadge(t.direction)}</td>
      ${fields.map((f) => `<td class="${TFIELDS[f][2] ? "num" : ""}">${TFIELDS[f][1](t)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function bindRows(el) {
  el.querySelectorAll("[data-id]").forEach((r) => {
    const go = () => (location.hash = `#/trade/${S.login}/${r.dataset.id}`);
    r.addEventListener("click", go);
    r.addEventListener("keydown", (e) => e.key === "Enter" && go());
  });
}

async function renderTrades() {
  const f = S.filters, o = S.st.options;
  const mode = localStorage.getItem("tradesView") || "rows";
  const opt = (arr, cur, all) => `<option value="">${all}</option>` + arr.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Сделки</h1><span class="muted">${f.day ? "за " + f.day.split("-").reverse().join(".") : periodLabel()}</span></div></div>
    <div class="filters">
      <input type="search" id="fq" placeholder="Поиск: инструмент, тег, заметка, тикет" value="${esc(f.q)}" aria-label="Поиск">
      <select id="fsym" aria-label="Инструмент">${opt(o.symbols, f.symbol, "Все инструменты")}</select>
      <select id="fdir" aria-label="Направление"><option value="">Buy и Sell</option><option value="1" ${f.direction === "1" ? "selected" : ""}>Только Buy</option><option value="-1" ${f.direction === "-1" ? "selected" : ""}>Только Sell</option></select>
      <select id="fsrc" aria-label="Источник"><option value="">Откуда угодно</option>${[[0, "С ПК"], [1, "С телефона"], [2, "Из веба"], [3, "Советник"]].map(([v, l]) => `<option value="${v}" ${f.source === String(v) ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select id="fset" aria-label="Сетап">${opt(o.setups, f.setup, "Любой сетап")}</select>
      <select id="fses" aria-label="Сессия"><option value="">Любая сессия</option>${(S.st.sessions || []).map((x) => x.name).concat(["Вне сессий"]).map((v) => `<option ${v === f.session ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <select id="fplan" aria-label="По плану"><option value="">План: любой</option><option value="1" ${f.plan === "1" ? "selected" : ""}>По плану</option><option value="0" ${f.plan === "0" ? "selected" : ""}>Вне плана</option><option value="none" ${f.plan === "none" ? "selected" : ""}>Не отмечено</option></select>
      <select id="fst" aria-label="Статус"><option value="">Открытые и закрытые</option><option value="closed" ${f.status === "closed" ? "selected" : ""}>Закрытые</option><option value="open" ${f.status === "open" ? "selected" : ""}>Открытые</option></select>
      ${f.day ? `<button class="btn sm" id="fday">День ${f.day.split("-").reverse().join(".")} ✕</button>` : ""}
      <span class="spacer"></span>
      <div class="seg" id="viewSeg" aria-label="Вид"><button data-m="rows" class="${mode === "rows" ? "on" : ""}">Строки</button><button data-m="cards" class="${mode === "cards" ? "on" : ""}">Карточки</button></div>
      <div class="pop-wrap"><button class="btn" id="fieldsBtn" aria-expanded="false">Поля</button><div class="pop hidden" id="fieldsPop"></div></div>
      <a class="btn" id="exportBtn" href="#">Экспорт в CSV</a>
    </div>
    <div id="tbl" class="${mode === "rows" ? "panel tbl-wrap" : ""}"></div><div class="tbl-foot ${mode === "rows" ? "" : "panel"}" id="tfoot" style="${mode === "rows" ? "" : "margin-top:12px"}"></div>`;

  let list = [];
  const draw = () => {
    $("#tbl").innerHTML = tradesHTML(list, mode, getFields(mode));
    bindRows($("#tbl"));
  };
  const load = async () => {
    const p = f.day ? new URLSearchParams() : periodQuery();
    if (f.day) {
      const a = Date.parse(f.day + "T00:00:00Z") / 1000 - shift();
      p.set("from", a); p.set("to", a + 86400);
    }
    for (const k of ["q", "symbol", "direction", "source", "setup", "status", "session", "plan"]) if (f[k]) p.set(k, f[k]);
    $("#exportBtn").href = `/api/export.csv?${p}&login=${S.login}`;
    list = await api("/api/trades?" + p);
    draw();
    const net = list.reduce((a, t) => a + t.net, 0);
    $("#tfoot").innerHTML = `<span>${list.length} ${plural(list.length, "позиция", "позиции", "позиций")}</span><span>Итого <b class="${cls(net)}">${money(net)}</b></span>`;
  };
  const bind = (id, key) => $(id).addEventListener(id === "#fq" ? "input" : "change", (e) => { f[key] = e.target.value; clearTimeout(load._t); load._t = setTimeout(load, 200); });
  bind("#fq", "q"); bind("#fsym", "symbol"); bind("#fdir", "direction"); bind("#fsrc", "source"); bind("#fset", "setup"); bind("#fst", "status"); bind("#fses", "session"); bind("#fplan", "plan");
  $("#fday")?.addEventListener("click", () => { f.day = ""; renderTrades(); });
  $("#viewSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; localStorage.setItem("tradesView", b.dataset.m); renderTrades(); };

  const pop = $("#fieldsPop");
  const drawPop = () => {
    const cur = getFields(mode);
    pop.innerHTML = `<h3>${mode === "rows" ? "Колонки таблицы" : "Что показывать на карточке"}</h3>
      <div class="cols">${Object.entries(TFIELDS).map(([k, [l]]) => `<label><input type="checkbox" value="${k}" ${cur.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <div class="foot"><button class="btn sm" id="fReset">По умолчанию</button><button class="btn sm primary" id="fClose">Готово</button></div>`;
    pop.querySelectorAll("input").forEach((i) => (i.onchange = () => {
      const keys = Object.keys(TFIELDS).filter((k) => pop.querySelector(`input[value="${k}"]`).checked);
      setFields(mode, keys); draw();
    }));
    $("#fReset").onclick = () => { localStorage.removeItem("fields2_" + mode); drawPop(); draw(); };
    $("#fClose").onclick = () => togglePop(false);
  };
  const togglePop = (on) => { pop.classList.toggle("hidden", !on); $("#fieldsBtn").setAttribute("aria-expanded", on); if (on) drawPop(); };
  $("#fieldsBtn").onclick = () => togglePop(pop.classList.contains("hidden"));
  document.addEventListener("click", function off(e) {
    if (!document.body.contains(pop)) { document.removeEventListener("click", off); return; }
    if (!e.target.closest(".pop-wrap")) togglePop(false);
  });
  await load();
}

/* ---------- open positions ---------- */
async function renderOpen() {
  const list = await api("/api/trades?status=open");
  setTimeout(() => { const v = $("#view"); if (v && !$("#liveSection")) { v.querySelector(".td-head")?.insertAdjacentHTML("afterend", `<div id="liveSection">${liveSectionHTML(S.live)}</div>`); } }, 0);
  const fl = list.reduce((a, t) => a + t.net, 0);
  view.innerHTML = `
    <div class="td-head"><h1>Открытые позиции</h1><span class="muted">Плавающий результат <b class="${cls(fl)}">${money(fl)}</b>, данные на момент последней синхронизации</span></div>
    <section class="panel tbl-wrap">${list.length ? `<table class="t"><thead><tr>
      <th>Открыта</th><th>Инструмент</th><th></th><th class="num">Объём</th><th class="num">Вход</th><th class="num">Текущая</th>
      <th class="num">SL</th><th class="num">TP</th><th class="num">R сейчас</th><th class="num">Плавающий</th><th>Источник</th></tr></thead><tbody>
      ${list.map((t) => `<tr class="click" tabindex="0" data-id="${t.position_id}">
        <td>${dt(t.open_time)}</td><td><b>${esc(t.symbol)}</b></td><td>${dirBadge(t.direction)}</td><td class="num">${t.volume}</td>
        <td class="num">${price(t.entry_price, t.digits)}</td><td class="num">${price(t.price_current, t.digits)}</td>
        <td class="num">${t.sl_current ? price(t.sl_current, t.digits) : '<span class="neg">нет</span>'}</td>
        <td class="num">${t.tp_current ? price(t.tp_current, t.digits) : "—"}</td>
        <td class="num ${cls(t.r)}">${rfmt(t.r)}</td><td class="num ${cls(t.net)}"><b>${money(t.net)}</b></td><td>${srcLabel(t)}</td></tr>`).join("")}
      </tbody></table>` : '<div class="empty">Открытых позиций нет.</div>'}</section>`;
  bindRows(view);
}

/* ---------- trade detail ---------- */
const TFS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const EMOTIONS = ["Спокойствие", "Уверенность", "Сомнение", "Страх", "Жадность", "FOMO", "Азарт", "Усталость", "Раздражение"];
const MISTAKES = ["Ранний вход", "Поздний вход", "Вход вне плана", "Сдвинул стоп", "Без стопа", "Превышен риск", "Ранний выход", "Пересиживание", "Отыгрыш"];

async function renderTrade(login, pid) {
  const t = await api(`/api/trade/${login}/${pid}`);
  const d = t.digits;
  const o = S.st.options;
  const rkey = `${login}:${pid}`;
  const inReview = S.reviewMode && (S.reviewQueue || []).includes(rkey);
  view.innerHTML = `
    ${inReview ? `<div class="week-banner"><span><b>Разбор подряд:</b> сделка ${S.reviewQueue.indexOf(rkey) + 1} из ${S.reviewQueue.length}. Заполните разбор и нажмите «Сохранить и следующая».</span><button class="btn sm" id="rvExit">Выйти из режима</button></div>` : ""}
    <div class="td-head">
      <div class="td-title">
        <a class="btn sm" href="#/trades" aria-label="К списку сделок">‹ Сделки</a>
        <h1 class="t-mono">${esc(t.symbol)}</h1>${dirBadge(t.direction)}<span class="muted t-mono" style="font-size:13px">${t.volume}</span>
        <span class="muted" style="font-size:14px">${dt(t.open_time)}${t.status === "closed" ? " – " + dt(t.close_time).slice(-5) : " · открыта"} · #${t.position_id}</span>
      </div>
      <div class="td-title">
        ${t.r !== null ? `<span class="net t-mono ${cls(t.r)}" style="font-size:28px;letter-spacing:-.03em">${rfmt(t.r)}</span>` : ""}
        <span class="t-mono ${t.r !== null ? "muted" : cls(t.net)}" style="font-size:${t.r !== null ? "15px" : "26px"};font-weight:${t.r !== null ? 500 : 600}">${money(t.net)}</span>
        <div class="td-nav">
          <button class="btn sm" id="prevT" ${t.prev_id ? "" : "disabled"} title="Предыдущая (стрелка влево)" aria-label="Предыдущая сделка">‹</button>
          <button class="btn sm" id="nextT" ${t.next_id ? "" : "disabled"} title="Следующая (стрелка вправо)" aria-label="Следующая сделка">›</button>
        </div>
      </div>
    </div>
    <div class="td-grid">
      <div>
        <section class="panel">
          <div class="chart-tools">
            <div class="seg" id="tfSeg"><button data-tf="">Авто</button>${TFS.map((x) => `<button data-tf="${x}">${x}</button>`).join("")}</div>
            <div class="chart-btns">
              <button class="btn sm ${S.showLevels !== false ? "on" : ""}" id="lvlBtn" title="Линии входа, стопа и тейка на всю ширину">Уровни</button>
              <button class="btn sm" id="fitBtn" title="Уместить сделку">Сделка</button>
              <button class="btn sm" id="wideBtn" title="Показать больше контекста">Шире</button>
              <button class="btn sm" id="replayBtn" title="Свечи появляются по одной: что было видно в момент входа">▶ Воспроизвести</button>
              <button class="btn sm ${S.dualTf ? "on" : ""}" id="dualBtn" title="Старший таймфрейм с контекстом под графиком входа">Два ТФ</button>
            </div>
            <div class="chart-btns draw-tools">
              <span class="muted" style="font-size:12px">Отметки:</span>
              <div class="seg" id="drawSeg"><button data-d="level" title="Горизонтальный уровень: один клик">Уровень</button><button data-d="zone" title="Зона: два клика по углам">Зона</button><button data-d="text" title="Подпись: клик и текст">Подпись</button></div>
              <span class="muted" style="font-size:12px" id="drawHint"></span>
              <button class="btn sm" id="drawUndo" title="Убрать последнюю отметку">Отменить</button>
              <button class="btn sm" id="shotBtn" title="Сохранить этот вид графика в скриншоты сделки">В скриншоты</button>
              ${t.status === "closed" ? '<button class="btn sm primary" id="shareBtn">Поделиться</button>' : ""}
              <span class="muted" style="font-size:12px" id="chartSrc"></span>
            </div>
          </div>
          <div class="trade-chart" id="tChart"></div>
          <div class="replay-bar hidden" id="rpBar"></div>
          <div class="dual-box ${S.dualTf ? "" : "hidden"}" id="dualBox">
            <div class="chart-tools"><span class="muted" style="font-size:12px">Старший таймфрейм</span><div class="seg" id="tf2Seg">${["M15", "H1", "H4", "D1"].map((x) => `<button data-tf="${x}">${x}</button>`).join("")}</div><span class="muted" style="font-size:12px">перекрестие синхронно с графиком входа</span></div>
            <div class="trade-chart second" id="tChart2"></div></div>
        </section>
        <ol class="timeline" aria-label="События сделки">${tradeEvents(t).map((e) => `<li><div class="tl-time"><span class="tl-dot" style="background:${e.color}"></span>${e.time}</div>
          <div class="tl-title">${e.title}</div><div class="tl-detail">${e.detail}</div></li>`).join("")}</ol>
        <section class="panel" style="margin-top:16px">
          <div class="panel-h"><h2>Скриншоты</h2><span class="muted" style="font-size:12px">Ctrl+V на этой странице добавляет картинку из буфера</span></div>
          <div class="panel-b"><div class="shots" id="shotList">${t.shot_list.map((x) => `<div class="shot" data-src="/shots/${esc(x.file)}"><img src="/shots/${esc(x.file)}" alt="Скриншот сделки" loading="lazy"><button data-del="${x.id}" aria-label="Удалить скриншот">✕</button></div>`).join("")}</div>
            <div class="dropzone" id="drop" style="margin-top:${t.shot_list.length ? "10px" : "0"}">Вставьте скриншот (Ctrl+V), перетащите файл сюда или <label style="text-decoration:underline;cursor:pointer">выберите файл<input type="file" accept="image/*" id="shotFile" hidden multiple></label></div></div>
        </section>
      </div>
      <div class="td-side">
        ${t.violations && t.violations.length ? `<div class="note-bad" style="order:-2"><b>Не по ТС:</b> ${t.violations.map(esc).join("; ")}.</div>` : ""}
        <section class="panel facts" aria-label="Детали сделки">
          <div><div class="k">Средний вход</div><div class="v">${price(t.entry_price, d)}</div></div>
          <div><div class="k">${t.status === "closed" ? "Средний выход" : "Текущая цена"}</div><div class="v">${price(t.status === "closed" ? t.exit_price : t.price_current, d)}</div></div>
          <div><div class="k">Стоп${t.sl_manual ? " (вручную)" : ""}</div><div class="v">${t.sl_used ? price(t.sl_used, d) : '<span class="neg">не найден</span>'}</div></div>
          <div><div class="k">Тейк</div><div class="v">${t.tp_initial ? price(t.tp_initial, d) : "—"}</div></div>
          <div><div class="k">Объём</div><div class="v">${t.volume} лот</div></div>
          <div><div class="k">Длительность</div><div class="v">${t.status === "closed" ? dur(t.duration) : "открыта"}</div></div>
          <div><div class="k">Против позиции (MAE)</div><div class="v neg">${t.mae_r !== null ? "−" + t.mae_r.toFixed(2) + "R" : t.mae != null ? price(t.mae, d) : "—"}</div></div>
          <div><div class="k">В пользу (MFE)</div><div class="v pos">${t.mfe_r !== null ? "+" + t.mfe_r.toFixed(2) + "R" : t.mfe != null ? price(t.mfe, d) : "—"}</div></div>
          <div><div class="k">Открыта</div><div class="v">${dt(t.open_time)}</div><div class="k">${esc(t.source)}</div></div>
          <div><div class="k">Закрыта</div><div class="v">${t.status === "closed" ? dt(t.close_time) : "—"}</div><div class="k">${esc(t.close_label)}</div></div>
          <div><div class="k">Комиссия и своп</div><div class="v">${money(t.commission + t.swap + t.fee)}</div></div>
          <div><div class="k">Прибыль до издержек</div><div class="v ${cls(t.profit)}">${money(t.profit)}</div></div>
          ${t.sleep_min !== undefined && t.sleep_min !== null ? `<div style="grid-column:1/-1;border-right:0"><div class="k">Сон перед сделкой</div>
            <span class="${t.sleep_short ? "neg" : ""}" style="font-weight:600">${durHM(t.sleep_min)}</span>${t.sleep_short ? ' <span class="violation">меньше нормы</span>' : ""}${t.bed_late ? ' <span class="tag">поздний отбой</span>' : ""}
            ${t.hours_awake !== null && t.hours_awake !== undefined ? `<span class="muted" style="font-size:13px"> · вход через ${String(t.hours_awake).replace(".", ",")} ч после пробуждения</span>` : ""}</div>` : ""}
          ${t.week_plan && t.week_plan.bias !== null ? `<div style="grid-column:1/-1;border-right:0"><div class="k">План недели по ${esc(t.week_plan.symbol)}</div>
            <span class="${t.week_plan.bias === 1 ? "pos" : t.week_plan.bias === -1 ? "neg" : ""}" style="font-weight:600">${{ 1: "лонги", "-1": "шорты", 0: "нейтрально" }[t.week_plan.bias]}</span>
            ${t.week_plan.bias !== 0 && t.week_plan.bias !== t.direction ? ' <span class="violation">сделка против плана недели</span>' : t.week_plan.bias === t.direction ? ' <span class="tag pos">по плану недели</span>' : ""}
            ${t.week_plan.levels ? `<div class="muted" style="font-size:12px;margin-top:2px">${esc(t.week_plan.levels)}</div>` : ""}</div>` : ""}
        </section>

        ${ctxBlock(t)}
        <section class="panel" style="order:-1">
          <div class="panel-h"><h2>Разбор</h2>${t.status === "closed" && !isReviewed(t) ? '<span class="pill warn">не разобрана</span>' : ""}</div>
          ${(t.twins || []).map((x) => `<div class="twin-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>
            <div><b>Та же идея на ${esc(accShort(S.st.accounts.find((a) => a.login === x.login) || { label: String(x.login) }))}</b>
              <a href="#/trade/${x.login}/${x.position_id}">${esc(x.symbol)} · вход ${dt(x.open_time)}${x.r !== null && x.r !== undefined ? ` · <span class="${cls(x.r)}">${rfmt(x.r)}</span>` : ""}</a>
              ${x.r !== null && x.r !== undefined && t.r !== null && t.r !== undefined && Math.abs(x.r - t.r) >= 1 ? `<span class="twin-split">Выход разошёлся: ${rfmt(t.r)} здесь против ${rfmt(x.r)} там. Одна идея должна вестись одинаково.</span>` : ""}
              <span>Разбор общий: сохраняется в обе сделки. Стоп вручную, план выхода и отметки на графике у каждой свои.</span></div>
            <button type="button" class="btn sm" data-unlink="${x.login}:${x.position_id}" title="Разбирать сделки отдельно">Это разные сделки</button></div>`).join("")}
          <form class="form" id="noteForm" autocomplete="off">
            <label class="f"><span>Сетап (плейбук)</span><input type="text" name="setup" list="dlSetup" value="${esc(t.setup || "")}" placeholder="Название из плейбуков, коротко"><span class="setup-hint" id="setupHint"></span></label>
            <div class="row2"><label class="f"><span>План выхода: частичная фиксация</span><input type="text" name="exit_partial" value="${esc(t.exit_partial || "")}" placeholder="половина на +1,5R"></label>
              <label class="f"><span>Выхожу руками, если</span><input type="text" name="exit_manual" value="${esc(t.exit_manual || "")}" placeholder="закрытие H1 за уровнем"></label></div>
            <label class="f"><span>Модель входа</span><input type="text" name="entry_model" list="dlModel" value="${esc(t.entry_model || "")}" placeholder="Например: ретест FVG, слом структуры"></label>
            <div class="f"><span class="muted" style="font-size:13px">Качество сетапа <span title="A - идеальный по ТС, B - есть отступления, C - слабый. Статистика по оценкам - в «Система → Моя ТС»">(?)</span></span>
              <div class="seg grade-seg" id="sgrade">${["A", "B", "C"].map((g) => `<button type="button" data-v="${g}" class="${t.setup_grade === g ? "on" : ""}">${g}</button>`).join("")}</div></div>
            <div class="f"><span class="muted" style="font-size:13px">Торговые аргументы</span>
              <div class="chips" id="args">${[...new Set([...(o.arguments || []), ...((t.arguments || "").split(",").map((x) => x.trim()).filter(Boolean))])].map((m) => `<button type="button" class="btn sm" data-a="${esc(m)}">${esc(m)}</button>`).join("")}</div>
              <input type="text" name="arguments" value="${esc(t.arguments || "")}" placeholder="Через запятую: PWL, 1H FVG, COT" style="margin-top:6px"></div>
            <div class="row2">
              <div class="f"><span class="muted" style="font-size:13px">Оценка исполнения</span>
                <div class="grade" id="grade">${[1, 2, 3, 4, 5].map((g) => `<button type="button" data-g="${g}" class="${t.grade === g ? "on" : ""}" aria-label="Оценка ${g}">${g}</button>`).join("")}</div></div>
              <div class="f"><span class="muted" style="font-size:13px">По плану</span>
                <div class="seg" id="plan"><button type="button" data-v="1" class="${t.followed_plan === 1 ? "on" : ""}">Да</button><button type="button" data-v="0" class="${t.followed_plan === 0 ? "on" : ""}">Нет</button></div></div>
            </div>
            <div class="f"><span class="muted" style="font-size:13px">Чек-лист перед входом <a href="#/settings" style="font-size:12px;color:var(--muted)">изменить пункты</a></span>
              <div class="checks" id="checks">${(S.st.checklist || []).map((c, i) => `<label><input type="checkbox" data-c="${i}" ${t.checklist[c] ? "checked" : ""}> ${esc(c)}</label>`).join("")}
              ${Object.keys(t.checklist).filter((k) => !(S.st.checklist || []).includes(k) && !(S.st.playbooks || []).some((p) => k.startsWith(p.name + ": "))).map((k) => `<label class="muted"><input type="checkbox" disabled ${t.checklist[k] ? "checked" : ""}> ${esc(k)} (пункт удалён)</label>`).join("")}</div></div>
            <div class="f" id="pbChecksBox"></div>
            <label class="f"><span>Состояние</span><input type="text" name="emotion" list="dlEmo" value="${esc(t.emotion || "")}"></label>
            <label class="f"><span>Почему вошёл</span><textarea name="entry_reason" rows="3">${esc(t.entry_reason || "")}</textarea></label>
            <label class="f"><span>Почему вышел</span><textarea name="exit_reason" rows="2">${esc(t.exit_reason || "")}</textarea></label>
            <div class="f"><span class="muted" style="font-size:13px">Ошибки</span>
              <div class="chips" id="mist">${[...new Set([...MISTAKES, ...o.mistakes])].map((m) => `<button type="button" class="btn sm" data-m="${esc(m)}">${esc(m)}</button>`).join("")}</div>
              <input type="text" name="mistakes" value="${esc(t.mistakes || "")}" placeholder="Через запятую" style="margin-top:6px"></div>
            <label class="f"><span>Теги</span><input type="text" name="tags" value="${esc(t.tags || "")}" placeholder="новости, NFP, лондон"></label>
            <label class="f"><span>Заметки</span><textarea name="notes" rows="4">${esc(t.notes || "")}</textarea></label>
            <label class="f"><span>Начальный стоп вручную</span><input type="number" step="any" name="sl_manual" value="${t.sl_manual ?? ""}" placeholder="${t.sl_initial ? "из терминала: " + price(t.sl_initial, d) : "стоп не найден в истории"}"></label>
            <div class="form-foot"><span class="muted" style="font-size:12px">Ctrl+S</span><button class="btn primary" type="submit">${inReview ? "Сохранить и следующая" : "Сохранить разбор"}</button></div>
          </form>
          <datalist id="dlSetup">${[...new Set([...(S.st.playbooks || []).map((p) => p.name), ...o.setups])].map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
          <datalist id="dlModel">${(o.models || []).map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
          <datalist id="dlEmo">${[...new Set([...EMOTIONS, ...o.emotions])].map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
        </section>
      </div>
    </div>`;

  // форма
  const form = $("#noteForm");
  let grade = t.grade || null, plan = t.followed_plan ?? null, sgrade = t.setup_grade || null;
  $("#sgrade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; sgrade = sgrade === b.dataset.v ? null : b.dataset.v; $("#sgrade").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === sgrade)); };
  $("#grade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; grade = grade === +b.dataset.g ? null : +b.dataset.g; $("#grade").querySelectorAll("button").forEach((x) => x.classList.toggle("on", +x.dataset.g === grade)); };
  $("#plan").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; plan = plan === +b.dataset.v ? null : +b.dataset.v; $("#plan").querySelectorAll("button").forEach((x) => x.classList.toggle("on", +x.dataset.v === plan)); };
  const pbFor = () => (S.st.playbooks || []).find((p) => p.name.trim().toLowerCase() === form.elements.setup.value.trim().toLowerCase());
  const drawPb = () => {
    const pb = pbFor();
    $("#pbChecksBox").innerHTML = pb && pb.checklist.length ? `<span class="muted" style="font-size:13px">Чек-лист плейбука «${esc(pb.name)}» <a href="#/playbooks" style="font-size:12px;color:var(--muted)">открыть</a></span>
      <div class="checks" id="pbChecks">${pb.checklist.map((c, i) => `<label><input type="checkbox" data-pc="${i}" ${t.checklist[pb.name + ": " + c] ? "checked" : ""}> ${esc(c)}</label>`).join("")}</div>` : "";
  };
  drawPb();
  form.elements.setup.addEventListener("input", drawPb);
  // сетап - короткое название из плейбуков, иначе статистика по сетапам не собирается
  const setupHint = () => {
    const v = form.elements.setup.value.trim();
    const known = (S.st.playbooks || []).some((p) => p.name.trim().toLowerCase() === v.toLowerCase());
    $("#setupHint").textContent = !v || known ? "" : v.length > 40 ? "Это рассуждение, а не название сетапа: перенесите его в «Почему вошёл»." : "Такого плейбука нет: создайте его в «Стратегия → Плейбуки», чтобы сетап попал в статистику.";
  };
  form.elements.setup.addEventListener("input", setupHint); setupHint();
  const mi = form.elements.mistakes;
  const syncMist = () => { const cur = mi.value.split(",").map((s) => s.trim()).filter(Boolean); $("#mist").querySelectorAll("button").forEach((b) => b.classList.toggle("primary", cur.includes(b.dataset.m))); };
  $("#mist").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    let cur = mi.value.split(",").map((s) => s.trim()).filter(Boolean);
    cur = cur.includes(b.dataset.m) ? cur.filter((x) => x !== b.dataset.m) : [...cur, b.dataset.m];
    mi.value = cur.join(", "); syncMist();
  };
  mi.addEventListener("input", syncMist); syncMist();
  const ai = form.elements.arguments;
  const syncArgs = () => { const cur = ai.value.split(",").map((x) => x.trim()).filter(Boolean); $("#args").querySelectorAll("button").forEach((b) => b.classList.toggle("primary", cur.includes(b.dataset.a))); };
  $("#args").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    let cur = ai.value.split(",").map((x) => x.trim()).filter(Boolean);
    cur = cur.includes(b.dataset.a) ? cur.filter((x) => x !== b.dataset.a) : [...cur, b.dataset.a];
    ai.value = cur.join(", "); syncArgs();
  };
  ai.addEventListener("input", syncArgs); syncArgs();
  const save = async (e) => {
    e?.preventDefault();
    const body = Object.fromEntries(new FormData(form));
    body.grade = grade; body.followed_plan = plan; body.setup_grade = sgrade;
    const ck = { ...t.checklist };
    (S.st.checklist || []).forEach((c, i) => { ck[c] = !!form.querySelector(`#checks input[data-c="${i}"]`)?.checked; });
    const pb = pbFor();
    if (pb) pb.checklist.forEach((c, i) => { ck[pb.name + ": " + c] = !!form.querySelector(`#pbChecks input[data-pc="${i}"]`)?.checked; });
    body.checklist = ck;
    try {
      const res = await api(`/api/trade/${login}/${pid}/notes`, { method: "PUT", body: JSON.stringify(body) });
      toast(res.twins ? "Разбор сохранён в обе сделки" : "Разбор сохранён");
      if (inReview) {
        const i = S.reviewQueue.indexOf(rkey);
        const next = S.reviewQueue[i + 1];
        if (next) { const [lg, id] = next.split(":"); location.hash = `#/trade/${lg}/${id}`; return; }
        S.reviewMode = false; toast("Все сделки из очереди разобраны"); location.hash = "#/"; return;
      }
      await loadState();
      if (body.sl_manual !== String(t.sl_manual ?? "")) renderTrade(login, pid);
    } catch (err) { toast(err.message, true); }
  };
  form.addEventListener("submit", save);
  view.querySelectorAll("[data-unlink]").forEach((b) => (b.onclick = async () => {
    const [ol, op] = b.dataset.unlink.split(":");
    try {
      await api(`/api/trade/${login}/${pid}/twins`, { method: "POST", body: JSON.stringify({ other_login: +ol, other_pid: +op, linked: false }) });
      toast("Сделки разделены: разбор у каждой свой"); renderTrade(login, pid);
    } catch (err) { toast(err.message, true); }
  }));
  document.onkeydown = (e) => {
    if (!location.hash.startsWith("#/trade/")) { document.onkeydown = null; return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); return; }
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    // A / B / C - качество сетапа (и в русской раскладке: Ф / И / С)
    const g = { a: "A", b: "B", c: "C", "ф": "A", "и": "B", "с": "C" }[e.key.toLowerCase()];
    if (g && !e.ctrlKey && !e.metaKey && !e.altKey) { $(`#sgrade [data-v="${g}"]`)?.click(); return; }
    if (e.key === "ArrowLeft" && t.prev_id) location.hash = `#/trade/${login}/${t.prev_id}`;
    if (e.key === "ArrowRight" && t.next_id) location.hash = `#/trade/${login}/${t.next_id}`;
    if (e.key === "Escape") location.hash = "#/trades";
  };
  // скриншоты
  const upload = async (file) => {
    if (!file || !file.type.startsWith("image/")) return;
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    try { await api(`/api/trade/${login}/${pid}/shots`, { method: "POST", body: JSON.stringify({ data }) }); toast("Скриншот добавлен"); renderTrade(login, pid); }
    catch (e) { toast(e.message, true); }
  };
  document.onpaste = (e) => {
    if (!location.hash.startsWith("#/trade/")) { document.onpaste = null; return; }
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); upload(item.getAsFile()); }
  };
  const drop = $("#drop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); [...e.dataTransfer.files].forEach(upload); };
  $("#shotFile").onchange = (e) => [...e.target.files].forEach(upload);
  $("#shotList").onclick = async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); if (confirm("Удалить скриншот?")) { await api(`/api/shots/${del.dataset.del}`, { method: "DELETE" }); renderTrade(login, pid); } return; }
    const sh = e.target.closest(".shot");
    if (sh) { const lb = document.createElement("div"); lb.className = "lightbox"; lb.innerHTML = `<img src="${sh.dataset.src}" alt="Скриншот сделки">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb); }
  };
  $("#rvExit")?.addEventListener("click", () => { S.reviewMode = false; renderTrade(login, pid); });
  $("#prevT").onclick = () => (location.hash = `#/trade/${login}/${t.prev_id}`);
  $("#nextT").onclick = () => (location.hash = `#/trade/${login}/${t.next_id}`);

  // график
  const drawChart = async () => {
    killCharts();
    $("#tfSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tf === (S.tf || "")));
    const el = $("#tChart");
    el.innerHTML = '<div class="chart-note"><span><span class="spin"></span> Загружаю котировки<br><span style="font-size:12px">Если их нет в базе, терминал MT5 запустится на время загрузки</span></span></div>';
    const c = await api(`/api/chart/${login}/${pid}${S.tf ? "?tf=" + S.tf : ""}`);
    el.innerHTML = "";
    $("#chartSrc").textContent = `${c.tf}, ${c.source === "terminal" ? "из терминала" : "из базы"}`;
    if (!c.bars.length) {
      el.innerHTML = `<div class="chart-note">Котировок за этот период нет в базе.<br>Запустите терминал MT5 и откройте сделку снова: котировки подтянутся и сохранятся. Если не помогло - добавьте инструмент в «Обзор рынка» терминала: журнал сам его туда не добавляет.</div>`;
      return;
    }
    S.chartData = c;
    S.tradeChart = renderTradeChart(el, c, t, { levels: S.showLevels !== false, wide: S.chartWide ? 3 : 1, drawings });
    S.tradeChart.chart.subscribeClick(onChartClick);
    if (S.dualTf) drawSecond();
  };

  // свои отметки на графике: уровень (1 клик), зона (2 клика), подпись (клик + текст); сохраняются со сделкой
  let drawings = [];
  try { drawings = JSON.parse(t.drawings || "[]"); } catch (e) { drawings = []; }
  let drawMode = null, zoneStart = null;
  const saveDrawings = () => api(`/api/trade/${login}/${pid}/drawings`, { method: "PUT", body: JSON.stringify({ items: drawings }) }).catch((e) => toast(e.message, true));
  const setMode = (m) => {
    drawMode = drawMode === m ? null : m; zoneStart = null;
    $("#drawSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.d === drawMode));
    $("#drawHint").textContent = { level: "кликни по цене уровня", zone: "кликни первый угол зоны", text: "кликни, где поставить подпись" }[drawMode] || "";
    $("#tChart").classList.toggle("drawing", !!drawMode);
  };
  const commit = (dr) => { drawings.push(dr); S.tradeChart.setDrawings(drawings); saveDrawings(); setMode(null); };
  const askText = (pt, done) => {
    const box = document.createElement("form");
    box.className = "draw-input";
    box.style.left = Math.min(pt.x, $("#tChart").clientWidth - 230) + "px"; box.style.top = pt.y + "px";
    box.innerHTML = '<input type="text" placeholder="Текст, Enter - сохранить" aria-label="Текст отметки">';
    $("#tChart").appendChild(box);
    const inp = box.querySelector("input"); inp.focus();
    box.onsubmit = (e) => { e.preventDefault(); box.remove(); done(inp.value.trim()); };
    inp.onblur = () => setTimeout(() => box.isConnected && box.remove(), 150);
    inp.onkeydown = (e) => { if (e.key === "Escape") box.remove(); };
  };
  function onChartClick(param) {
    if (!drawMode || !param.point || !S.tradeChart) return;
    const at = S.tradeChart.pointAt(param.point);
    if (!at) return;
    if (drawMode === "level") askText(param.point, (txt) => commit({ type: "level", p1: at.p, text: txt }));
    else if (drawMode === "text") askText(param.point, (txt) => txt && commit({ type: "text", p1: at.p, t1: at.t, text: txt }));
    else if (drawMode === "zone") {
      if (!zoneStart) { zoneStart = at; $("#drawHint").textContent = "кликни второй угол зоны"; return; }
      const z = zoneStart;
      askText(param.point, (txt) => commit({ type: "zone", p1: z.p, t1: Math.min(z.t, at.t), p2: at.p, t2: Math.max(z.t, at.t), text: txt }));
    }
  }
  $("#drawSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setMode(b.dataset.d); };
  $("#drawUndo").onclick = () => { if (!drawings.length) return; drawings.pop(); S.tradeChart?.setDrawings(drawings); saveDrawings(); };

  // старший таймфрейм под графиком входа, перекрестие синхронно
  const drawSecond = async () => {
    const box = $("#tChart2");
    if (!box) return;
    const tf2 = S.tf2 || ({ M1: "M15", M5: "H1", M15: "H1", M30: "H4", H1: "H4" }[S.chartData?.tf] || "D1");
    $("#tf2Seg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tf === tf2));
    box.innerHTML = '<div class="chart-note"><span><span class="spin"></span> Загружаю старший таймфрейм</span></div>';
    try {
      const c2 = await api(`/api/chart/${login}/${pid}?tf=${tf2}`);
      box.innerHTML = "";
      if (!c2.bars.length) { box.innerHTML = '<div class="chart-note">Котировок старшего таймфрейма нет</div>'; return; }
      const a = S.tradeChart, b = renderTradeChart(box, c2, t, { levels: S.showLevels !== false, wide: 4, drawings });
      S.tradeChart2 = b;
      let lock = false;
      const link = (from, to) => from.chart.subscribeCrosshairMove((param) => {
        if (lock) return;
        lock = true;
        try {
          const v = param.time && param.seriesData.get(from.series);
          if (v) to.chart.setCrosshairPosition(v.close ?? v.value, to.nearestTime(param.time), to.series);
          else to.chart.clearCrosshairPosition();
        } catch (e) {}
        lock = false;
      });
      if (a) { link(a, b); link(b, a); }
    } catch (e) { box.innerHTML = `<div class="chart-note">${esc(e.message)}</div>`; }
  };
  $("#dualBtn").onclick = () => { S.dualTf = !S.dualTf; $("#dualBtn").classList.toggle("on", S.dualTf); $("#dualBox").classList.toggle("hidden", !S.dualTf); if (S.dualTf) drawSecond(); };
  $("#tf2Seg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.tf2 = b.dataset.tf; drawSecond(); };
  $("#lvlBtn").onclick = () => { S.showLevels = S.showLevels === false; $("#lvlBtn").classList.toggle("on", S.showLevels !== false); drawChart(); };
  $("#fitBtn").onclick = () => { S.chartWide = false; S.tradeChart?.fit(1); };
  $("#wideBtn").onclick = () => { S.chartWide = true; S.tradeChart?.fit(3); };
  $("#shotBtn").onclick = async () => {
    if (!S.tradeChart) return;
    const data = S.tradeChart.compose().toDataURL("image/png");
    try { await api(`/api/trade/${login}/${pid}/shots`, { method: "POST", body: JSON.stringify({ data }) }); toast("График сохранён в скриншоты сделки"); renderTrade(login, pid); }
    catch (e) { toast(e.message, true); }
  };
  $("#shareBtn")?.addEventListener("click", () => openShare(t, S.chartData));
  $("#replayBtn").onclick = () => replayControls($("#rpBar"), S.tradeChart);
  $("#tfSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.tf = b.dataset.tf || null; drawChart(); };
  await drawChart();
}

// панель воспроизведения под графиком сделки: пуск/пауза, шаг, скорость, выход
function replayControls(box, pc) {
  if (!pc?.replay) return;
  box.classList.remove("hidden");
  box.innerHTML = `<button class="btn sm primary" data-a="play">⏸ Пауза</button><button class="btn sm" data-a="step" title="Стрелка вправо">Свеча →</button>
    <div class="seg" data-a="speed">${[1, 2, 5, 10].map((s) => `<button data-s="${s}" class="${s === 2 ? "on" : ""}">${s}×</button>`).join("")}</div>
    <div class="rp-prog"><i></i></div><button class="btn sm" data-a="exit">Выйти</button>`;
  const prog = box.querySelector(".rp-prog i"), playBtn = box.querySelector('[data-a="play"]');
  const r = pc.replay({ speed: 2, onStep: (i, end) => (prog.style.width = Math.min(100, (100 * i) / end) + "%"),
    onEnd: () => (playBtn.textContent = "▶ Сначала") });
  const sync = () => (playBtn.textContent = r.playing() ? "⏸ Пауза" : "▶ Пуск");
  r.play();
  box.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.s) { r.setSpeed(+b.dataset.s); box.querySelectorAll("[data-s]").forEach((x) => x.classList.toggle("on", x === b)); return; }
    if (b.dataset.a === "play") { if (playBtn.textContent.includes("Сначала")) { r.stop(); replayControls(box, pc); return; } r.playing() ? r.stop() : r.play(); sync(); }
    if (b.dataset.a === "step") { r.stop(); r.step(); sync(); }
    if (b.dataset.a === "exit") { r.reset(); box.classList.add("hidden"); box.onclick = null; }
  };
}

// лента событий сделки: вход, стоп и тейк, частичные выходы, выход, худшая и лучшая точки
function tradeEvents(t) {
  const d = t.digits, ev = [], hhmm = (ts) => dt(ts).slice(-5);
  for (const x of t.deals) {
    const isIn = x.entry === 0, side = x.type === 0 ? "Buy" : "Sell";
    ev.push(isIn
      ? { time: hhmm(x.time), color: "var(--text)", title: `Вход ${side} ${x.volume}`, detail: `${price(x.price, d)} · ${dealReason(x.reason)}` }
      : { time: hhmm(x.time), color: x.profit >= 0 ? "var(--profit)" : "var(--loss)", title: `${x.entry === 2 ? "Разворот" : x.reason === 4 ? "Выход по стопу" : x.reason === 5 ? "Выход по тейку" : "Выход"} ${x.volume}`,
          detail: `${price(x.price, d)} · ${money(x.profit)}` });
  }
  if (t.sl_used || t.tp_initial) ev.splice(1, 0, { time: hhmm(t.open_time), color: "var(--muted)", title: "Стоп и тейк", detail: `SL ${t.sl_used ? price(t.sl_used, d) : "нет"} · TP ${t.tp_initial ? price(t.tp_initial, d) : "нет"}` });
  if (t.mae_r !== null && t.mae_r !== undefined) ev.push({ time: "в сделке", color: "var(--loss)", title: "Худшая точка", detail: `MAE −${t.mae_r.toFixed(2).replace(".", ",")}R` });
  if (t.mfe_r !== null && t.mfe_r !== undefined) ev.push({ time: "в сделке", color: "var(--profit)", title: "Лучшая точка", detail: `MFE +${t.mfe_r.toFixed(2).replace(".", ",")}R` });
  return ev;
}

function ctxBlock(t) {
  const c = t.context;
  if (!c) return "";
  const cells = [];
  if (c.cot) cells.push(`<div><div class="k">COT ${esc(c.cot.name)}, отчёт ${c.cot.date.split("-").reverse().join(".")}</div>нетто ${fmtInt(c.cot.net_nc)} <span class="${cls(c.cot.net_nc_chg)}">${fmtInt(c.cot.net_nc_chg, true)}</span>, индекс ${idxBadge(c.cot.index_nc)}</div>`);
  if (c.atr) cells.push(`<div><div class="k">ATR 14 дней / диапазон прошлого дня</div>${price(c.atr.atr14, t.digits)} / ${price(c.atr.prev_range, t.digits)}</div>`);
  for (const m of c.macro) cells.push(`<div><div class="k">${esc(m.name)}</div>${fmtVal(m.value, m.unit)} <span class="${cls(m.chg_w)}" style="font-size:12px">${fmtChg(m.chg_w)} за неделю</span></div>`);
  if (!cells.length) return "";
  if (cells.length % 2) cells.push("<div></div>");
  return `<details class="panel" style="margin-top:16px" ${localStorage.getItem("ctxOpen") ? "open" : ""} ontoggle="localStorage.setItem('ctxOpen', this.open ? '1' : '')">
    <summary><h2>Рынок на момент входа ${hb("context")}</h2></summary><div class="ctx">${cells.join("")}</div></details>`;
}

function dealReason(r) {
  return ({ 0: "ПК", 1: "Телефон", 2: "Веб", 3: "Советник", 4: "Stop Loss", 5: "Take Profit", 6: "Stop Out" })[r] ?? "—";
}


/* ---------- sync page ---------- */
async function renderSync() {
  await loadState();
  const st = S.st;
  view.innerHTML = `
    <div class="td-head"><h1>Синхронизация</h1>
      <div style="display:flex;gap:8px"><button class="btn primary" id="sNow">Синхронизировать</button><button class="btn" id="sFull">Перечитать всю историю</button><button class="btn" id="sStop">Выключить журнал</button></div></div>
    ${st.mode === "demo" ? `<div class="week-banner"><span><b>Включён демо-режим.</b> Данные синтетические. Чтобы подключить свой счёт, добавьте его в «Счета».</span><a class="btn sm" href="#/accounts/new">Подключить счёт</a></div>` : ""}
    <div class="sync-facts">
      <div><b>Телефон и веб</b><span>История хранится у брокера: сделки с телефона появятся при следующей синхронизации на ПК.</span></div>
      <div><b>Как часто</b><span>При запуске журнала и по расписанию из «Настроек». Задача планировщика (install_task.bat) проверяет каждые 5 минут.</span></div>
      <div><b>Что сохраняется</b><span>Сделки, ордера, позиции и котировки. Ваш разбор синхронизация не перезаписывает.</span></div>
      <div><b>Перечитать всю историю</b><span>Если меняли history_start в config.json или подключили счёт с давней историей.</span></div>
    </div>
    <section class="panel">
      <div class="panel-h"><h2>Последние запуски</h2></div>
      <div class="tbl-wrap">${st.log.length ? `<table class="t sync-log"><thead><tr><th>Время</th><th>Статус</th><th class="num">Новых сделок</th><th>Сообщение</th></tr></thead><tbody>
        ${st.log.map((l) => `<tr><td>${localTime(l.started)}</td><td><span class="st ${l.status}">${l.status === "ok" ? "успешно" : l.status === "busy" ? "занято" : l.status === "skip" ? "пропущено" : "ошибка"}</span></td><td class="num">${l.new_deals ?? 0}</td><td>${esc(l.message)}</td></tr>`).join("")}
        </tbody></table>` : '<div class="empty">Запусков ещё не было.</div>'}</div>
    </section>`;
  $("#sNow").onclick = () => doSync(false);
  $("#sFull").onclick = () => doSync(true);
  $("#sStop").onclick = async () => {
    if (!confirm("Выключить журнал? Чтобы открыть его снова, запустите run.bat.")) return;
    try { await api("/api/shutdown", { method: "POST" }); } catch (e) {}
    view.innerHTML = emptyState("Журнал выключен", "Эту вкладку можно закрыть. Запустить снова: run.bat.", "", "done");
  };
}

/* ---------- скачать журнал ---------- */
// ссылки «Скачать» в меню: период и счёт - текущие
function exportLinks() {
  const p = periodQuery(); p.set("login", S.login || "");
  $("#expXlsx").href = `/api/export.xlsx?${p}`;
  $("#expHtml").href = `/api/export.html?${p}`;
  $("#expHtml2").href = `/api/export.html?${p}&shots=0`;
  $("#expCsv").href = `/api/export.csv?${p}`;
  $("#expPack").href = `/api/export/pack.json?login=${S.login || ""}`;
  $("#expPackZip").href = `/api/export/pack.zip?login=${S.login || ""}`;
}

/* ---------- боковое меню ---------- */
const NAV_ICONS = {
  today: "M8 3v3M16 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  trades: "M4 7h16M4 12h16M4 17h10",
  analytics: "M4 20V10M10 20V4M16 20v-7M21 20H3",
  strategy: "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  accounts: "M3 7h18v12H3zM3 11h18M7 15h4",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3 2-1-1-3-2 .3-1.5-1.5L18 5l-3-1-1 2h-2l-1-2-3 1 .5 2L7 8.5 5 8.3 4 11l2 1v1l-2 1 1 3 2-.3L8.5 17.5 8 20l3 1 1-2h2l1 2 3-1-.5-2.5L18.5 16l2 .3 1-3-2-1z",
};
(function navSetup() {
  document.querySelectorAll(".rail nav a, .rail-foot a").forEach((a) => {
    const lbl = a.childNodes[0]?.nodeType === 3 ? a.childNodes[0].textContent.trim() : a.textContent.trim();
    if (a.childNodes[0]?.nodeType === 3) a.childNodes[0].remove();
    a.insertAdjacentHTML("afterbegin", `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${NAV_ICONS[a.dataset.view] || ""}"/></svg><span class="lbl">${lbl}</span>`);
    a.title = lbl;
  });
  const app = $(".app"), btn = $("#collapseBtn");
  const set = (c) => { app.classList.toggle("collapsed", c); localStorage.setItem("navCollapsed", c ? "1" : ""); btn.textContent = c ? "»" : "«"; btn.title = c ? "Развернуть меню" : "Свернуть меню"; };
  set(!!localStorage.getItem("navCollapsed"));
  btn.onclick = () => { set(!app.classList.contains("collapsed")); setTimeout(() => window.dispatchEvent(new Event("resize")), 50); };
})();

/* ---------- boot ---------- */
(async function boot() {
  // старые настройки оформления больше не используются: один акцент, тема - как в Windows или вручную
  delete document.documentElement.dataset.accent; delete document.documentElement.dataset.skin;
  applyTheme(localStorage.getItem("theme") || "system", false);
  setPeriodButtons();
  try { await loadState(); } catch (e) { /* сервер недоступен - покажет route */ }
  route();
  setInterval(() => { if (!document.hidden && !location.hash.startsWith("#/trade/")) loadState().catch(() => {}); }, 60000);
})();
