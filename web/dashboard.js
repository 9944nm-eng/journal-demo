/* Аналитика → Результат: кривая, показатели, календарь, разбивки (блоки-виджеты в фиксированном порядке) */
"use strict";

const BREAKDOWNS = [
  ["by_symbol", "Инструменты"], ["by_setup", "Сетапы"], ["by_source", "Откуда открыта"],
  ["by_close", "Как закрыта"], ["by_weekday", "Дни недели"], ["by_hour", "Часы входа"], ["by_session", "Сессии"],
  ["by_plan", "По плану"], ["by_checklist", "Чек-лист"], ["by_model", "Модель входа"], ["by_argument", "Торговые аргументы"], ["by_mistake", "Ошибки"],
];

const stat = (k, v, s, c = "") => `<div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div>`;

const WIDGETS = {
  equity: { title: "Кривая доходности", sizes: [12, 8, 6], def: 12, panel: true, need: ["stats"], render: wEquity },
  s_exp: { title: "Ожидание на сделку", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Ожидание на сделку", U(x.s.expectancy, x.s.avg_r), S.unit === "R" ? `в деньгах ${money(x.s.expectancy)}` : `средний R ${rfmt(x.s.avg_r)}`, cls(S.unit === "R" && x.s.avg_r !== null ? x.s.avg_r : x.s.expectancy))) },
  s_pf: { title: "Profit factor", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Profit factor", x.s.profit_factor ?? "—", `${compact(x.s.gross_profit || 0)} / ${compact(-(x.s.gross_loss || 0))}`)) },
  s_wr: { title: "Прибыльных", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Прибыльных", x.s.win_rate !== null ? String(x.s.win_rate).replace(".", ",") + "%" : "—", `${x.s.wins} в плюс, ${x.s.losses} в минус`)) },
  s_avg: { title: "Средняя прибыль / убыток", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Средняя прибыль",
      `<span class="pos">${UC(x.s.avg_win || 0, x.s.avg_win_r)}</span>`,
      `убыток <span class="neg">${UC(x.s.avg_loss || 0, x.s.avg_loss_r)}</span> · соотношение ${x.s.avg_win && x.s.avg_loss ? (x.s.avg_win / -x.s.avg_loss).toFixed(2).replace(".", ",") : "—"}`)) },
  s_dd: { title: "Макс. просадка", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Макс. просадка", U(-x.s.max_dd, x.s.max_dd_r === null ? null : -x.s.max_dd_r), x.s.max_dd_pct !== null ? String(x.s.max_dd_pct).replace(".", ",") + "% от пика" : "от пика кривой", "neg")) },
  s_streak: { title: "Серии подряд", sizes: [2, 3, 4], def: 2, stat: true, need: ["stats"],
    render: (el, x) => (el.innerHTML = stat("Серии подряд", `${x.s.streak_win} / ${x.s.streak_loss}`, `в плюс / в минус, ср. длит. ${dur(x.s.avg_duration)}`)) },
  rhist: { title: "Распределение R", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wRHist },
  rolling: { title: "Скользящее матожидание", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wRolling },
  holdtime: { title: "Время в позиции", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wHoldTime },
  longshort: { title: "Лонги и шорты", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wLongShort },
  heat: { title: "Время входа: день и час", sizes: [12, 8, 6], def: 12, panel: true, need: ["stats"], render: wHeat },
  week: { title: "Результат по дням недели", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wWeek },
  sessions: { title: "Винрейт по сессиям", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wSessions },
  calendar: { title: "Календарь", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wCalendar },
  breakdown: { title: "Разбивка результата", sizes: [6, 4, 8, 12], def: 6, panel: true, need: ["stats"], render: wBreakdown },
};
/* ---------- Аналитика → Результат: продуманный набор блоков, без конструктора ---------- */
const periodLabel = () => ({ 7: "за неделю", 30: "за месяц", 90: "за квартал", 365: "за год", 0: "за всё время" }[S.period] || "");
const RESULT_LAYOUT = [["equity", 12], ["s_exp", 2], ["s_wr", 2], ["s_pf", 2], ["s_avg", 2], ["s_dd", 2], ["s_streak", 2],
  ["calendar", 6], ["breakdown", 6], ["rhist", 6], ["rolling", 6], ["week", 6], ["sessions", 6], ["longshort", 6], ["holdtime", 6], ["heat", 12]];

async function renderResult() {
  const pqs = new URLSearchParams(periodQuery()); if (S.nv) pqs.set("nv", "1");
  const [stats, base] = await Promise.all([api("/api/stats?" + pqs), S.nv ? api("/api/stats?" + periodQuery()) : null]);
  const ctx = { st: stats, s: stats?.summary, base };
  killCharts();
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Результат</h1><span class="muted">${periodLabel()}</span></div>
      <label class="toggle" title="Показать результат без сделок, нарушивших правила ТС"><input type="checkbox" id="nvT" ${S.nv ? "checked" : ""}> Без нарушений ТС</label></div>
    ${S.nv && base ? `<div class="week-banner"><span>Без ${base.summary.trades - ctx.s.trades} ${plural(base.summary.trades - ctx.s.trades, "сделки", "сделок", "сделок")} с нарушениями ТС: было бы <b class="${cls(ctx.s.net)}">${money(ctx.s.net)}</b> вместо <b>${money(base.summary.net)}</b>.</span></div>` : ""}
    ${!ctx.s || !ctx.s.trades ? emptyState(`Закрытых сделок ${periodLabel()} нет`, "Выберите период длиннее вверху или запустите синхронизацию.") : `
    <div class="wgrid">${RESULT_LAYOUT.map(([id, w]) => `<section class="w ${WIDGETS[id].stat ? "panel stat" : "panel"}" style="grid-column: span ${w}" data-id="${id}"><div class="w-body"></div></section>`).join("")}</div>`}`;
  $("#nvT").onchange = (e) => { S.nv = e.target.checked; renderResult(); };
  if (!ctx.s || !ctx.s.trades) return;
  for (const [id] of RESULT_LAYOUT) {
    const el = view.querySelector(`.w[data-id="${id}"] .w-body`);
    try {
      WIDGETS[id].render(el, ctx, { id });
      const head = el.querySelector(".panel-h h2") || el.querySelector(".k");
      if (head && !head.querySelector(".help")) head.insertAdjacentHTML("beforeend", " " + hb(id));
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
}

/* ---------- виджеты ---------- */
function wEquity(el, x) {
  const s = x.s;
  const periodName = { 7: "за неделю", 30: "за месяц", 90: "за квартал", 365: "за год", 0: "за всё время" }[S.period];
  el.innerHTML = `<div class="hero">
    <div class="hero-head">
      <div><div class="muted">Результат ${periodName}</div>
        <div class="hero-num ${cls(S.unit === "R" && s.sum_r !== null ? s.sum_r : s.net)}">${U(s.net, s.sum_r)}</div>
        <div class="hero-sub">${s.trades} ${plural(s.trades, "сделка", "сделки", "сделок")}${s.win_rate !== null ? `, прибыльных ${s.win_rate}%` : ""}${s.sum_r !== null ? `, итог ${rfmt(s.sum_r)}` : ""}</div></div>
      <div class="muted" style="text-align:right">Лучшая <span class="pos">${U(s.best, s.best_r)}</span><br>Худшая <span class="neg">${U(s.worst, s.worst_r)}</span></div>
    </div><div class="hero-chart"></div></div>`;
  if (!x.st.equity.length) { el.querySelector(".hero-chart").innerHTML = '<div class="empty">Закрытых сделок за период нет</div>'; return; }
  const box = el.querySelector(".hero-chart");
  // несколько сделок в один день дают повторяющиеся метки дня: внутридневные метки не подписываем
  const MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const tick = (t, type) => { const d = new Date(t * 1000); return type === 0 ? String(d.getUTCFullYear()) : type === 1 ? MON[d.getUTCMonth()] : type === 2 ? `${d.getUTCDate()} ${MON[d.getUTCMonth()]}` : ""; };
  const ec = chartBase(box, { rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: tick } });
  // выше нуля - зелёный, ниже - красный: цвет говорит только о знаке результата
  const pf = css("--profit"), ls = css("--loss");
  const area = ec.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2,
    topLineColor: pf, topFillColor1: pf + "30", topFillColor2: pf + "04", bottomLineColor: ls, bottomFillColor1: ls + "04", bottomFillColor2: ls + "30",
    priceFormat: { type: "price", precision: 2, minMove: 0.01 }, priceLineVisible: false });
  const useR = S.unit === "R" && s.sum_r !== null;  // кривая в тех же единицах, что и число над ней
  const k = S.unit === "%" && pctBase() ? 100 / pctBase() : 1;
  const pts = x.st.equity.map((p) => ({ time: p.time, value: useR ? p.r : Math.round(p.value * k * 100) / 100 }));
  pts.unshift({ time: pts[0].time - 3600, value: 0 });
  area.setData(pts);
  area.createPriceLine({ price: 0, color: css("--muted"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  if (x.base && x.base.equity.length) {
    const b = x.base.equity.map((p) => ({ time: p.time, value: useR ? p.r : Math.round(p.value * k * 100) / 100 }));
    b.unshift({ time: b[0].time - 3600, value: 0 });
    ec.addLineSeries({ color: css("--muted"), lineWidth: 1.5, lineStyle: 2, priceLineVisible: false, lastValueVisible: true, title: "фактически" }).setData(b);
  }
  fitOnResize(ec, box);
  setTimeout(() => { try { ec.timeScale().fitContent(); } catch (e) {} }, 60);
  const byTime = new Map(x.st.equity.map((p) => [p.time, p.id]));
  ec.subscribeClick((p) => { const id = p.time && byTime.get(p.time); if (id) location.hash = `#/trade/${S.login}/${id}`; });
}

function wCalendar(el, x) {
  const daily = x.st.daily;
  const days = Object.keys(daily).sort();
  if (!S.calMonth) {
    const last = days.length ? new Date(days[days.length - 1] + "T00:00:00Z") : new Date();
    S.calMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1));
  }
  el.innerHTML = `<div class="panel-h"><h2 class="calTitle"></h2>
      <div class="seg"><button class="calPrev" aria-label="Предыдущий месяц">‹</button><button class="calNext" aria-label="Следующий месяц">›</button></div></div>
    <div class="panel-b"><div class="cal wk8"></div><div class="cal-sum"></div></div>`;
  const draw = () => {
    const m = S.calMonth, y = m.getUTCFullYear(), mo = m.getUTCMonth();
    el.querySelector(".calTitle").textContent = m.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).replace(/^./, (c) => c.toUpperCase());
    const first = (new Date(Date.UTC(y, mo, 1)).getUTCDay() + 6) % 7;
    const n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const today = new Date(Date.now() + shift() * 1000).toISOString().slice(0, 10);
    let html = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс", "Неделя"].map((d) => `<div class="dow">${d}</div>`).join("");
    for (let i = 0; i < first; i++) html += '<div class="d out"></div>';
    let mNet = 0, mDays = 0, mWin = 0, wk = { net: 0, r: 0, n: 0 }, col = first;
    const flush = () => { html += `<div class="d wsum ${wk.n ? (wk.net >= 0 ? "win" : "lose") : ""}"><span class="n">${wk.n ? `${wk.n} ${plural(wk.n, "сделка", "сделки", "сделок")}` : "—"}</span>${wk.n ? `<span class="p">${UC(wk.net, wk.r)}</span>` : ""}</div>`; wk = { net: 0, r: 0, n: 0 }; };
    for (let d = 1; d <= n; d++) {
      const key = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const v = daily[key];
      if (v) { mNet += v.net; mDays++; mWin += v.net > 0; wk.net += v.net; wk.r += v.r || 0; wk.n += v.count; }
      html += `<div class="d ${v ? (v.net >= 0 ? "win" : "lose") : ""} ${key === today ? "today" : ""}" ${v ? `title="${v.count} ${plural(v.count, "сделка", "сделки", "сделок")}: ${money(v.net)}" role="button" tabindex="0" data-day="${key}" style="cursor:pointer"` : ""}>
        <span class="n">${d}</span>${v ? `<span class="p">${UC(v.net, v.r)}</span><span class="wl">${v.w ?? 0}W/${v.l ?? 0}L</span>` : ""}</div>`;
      col++;
      if (col % 7 === 0) flush();
    }
    if (col % 7) { for (let i = col % 7; i < 7; i++) html += '<div class="d out"></div>'; flush(); }
    el.querySelector(".cal").innerHTML = html;
    el.querySelector(".cal-sum").innerHTML = mDays
      ? `<span>Торговых дней ${mDays}, в плюс ${mWin}</span><span class="${cls(mNet)}">${money(mNet)}</span>`
      : `<span>В этом месяце закрытых сделок нет</span><span></span>`;
  };
  draw();
  el.querySelector(".calPrev").onclick = () => { S.calMonth = new Date(Date.UTC(S.calMonth.getUTCFullYear(), S.calMonth.getUTCMonth() - 1, 1)); draw(); };
  el.querySelector(".calNext").onclick = () => { S.calMonth = new Date(Date.UTC(S.calMonth.getUTCFullYear(), S.calMonth.getUTCMonth() + 1, 1)); draw(); };
  const open = (e) => { const d = e.target.closest("[data-day]"); if (d) openDay(d.dataset.day); };
  el.querySelector(".cal").addEventListener("click", open);
  el.querySelector(".cal").addEventListener("keydown", (e) => e.key === "Enter" && open(e));
}

function wBreakdown(el, x) {
  el.innerHTML = `<div class="panel-h"><h2>Разбивка результата</h2>
      <select class="bdSel" style="width:auto" aria-label="Разбивка">${BREAKDOWNS.map(([k, l]) => `<option value="${k}" ${k === S.breakdown ? "selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="panel-b bd"></div>`;
  const draw = () => {
    let data = x.st[S.breakdown] || [];
    if (S.breakdown === "by_weekday") data = data.map((v) => ({ ...v, key: v.label }));
    if (S.breakdown === "by_hour") data = data.map((v) => ({ ...v, key: String(v.key).padStart(2, "0") + ":00" }));
    const box = el.querySelector(".bd");
    if (!data.length) {
      box.innerHTML = `<div class="empty">${["by_setup", "by_mistake", "by_model", "by_argument"].includes(S.breakdown) ? "Заполните сетап, модель входа, аргументы и ошибки в карточках сделок, и здесь появится разбивка." : "Нет данных."}</div>`;
      return;
    }
    const max = Math.max(...data.map((v) => Math.abs(v.net)), 1);
    box.innerHTML = `<div class="bars">${data.map((v) => {
      const w = (Math.abs(v.net) / max) * 100;
      return `<div class="bar-row" title="${esc(v.key)}: ${v.count} ${plural(v.count, "сделка", "сделки", "сделок")}, прибыльных ${v.win_rate}%${v.avg_r !== null ? ", средний " + rfmt(v.avg_r) : ""}">
        <div class="lbl">${esc(v.key)}<small>${v.count}</small></div>
        <div class="neg-side">${v.net < 0 ? `<i style="width:${w}%"></i>` : ""}</div>
        <div class="pos-side">${v.net > 0 ? `<i style="width:${w}%"></i>` : ""}</div>
        <div class="val ${cls(v.net)}">${compact(v.net)}</div></div>`;
    }).join("")}</div>`;
  };
  draw();
  el.querySelector(".bdSel").onchange = (e) => { S.breakdown = e.target.value; draw(); };
}

function wWeek(el, x) {
  const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const map = new Map((x.st.by_weekday || []).map((d) => [d.key, d]));
  const show = [0, 1, 2, 3, 4].concat([5, 6].filter((k) => map.has(k)));
  const max = Math.max(1, ...[...map.values()].flatMap((d) => [d.gross_profit, -d.gross_loss]));
  const total = [...map.values()].reduce((a, d) => a + d.net, 0);
  el.innerHTML = `<div class="panel-h"><h2>Результат по дням недели</h2><div class="big-total"><span>Итог за период</span><b class="${cls(total)}">${money(total)}</b></div></div>
    <div class="panel-b"><div class="wk">${show.map((k) => {
      const d = map.get(k) || { gross_profit: 0, gross_loss: 0, net: 0, count: 0, win_rate: 0 };
      return `<div class="col" title="${days[k]}: ${d.count} ${plural(d.count, "сделка", "сделки", "сделок")}, прибыльных ${d.win_rate}%. Прибыльные ${money(d.gross_profit)}, убыточные ${money(d.gross_loss)}">
        <div class="bars2"><i class="p" style="height:${(d.gross_profit / max) * 100}%"></i><i class="l" style="height:${(-d.gross_loss / max) * 100}%"></i></div>
        <div class="v ${cls(d.net)}">${compact(d.net)}</div><div class="d">${days[k]}</div></div>`;
    }).join("")}</div>
    <div class="legend" style="margin-top:8px"><span><i style="color:var(--profit);border-top-style:solid;border-top-width:6px"></i>сумма прибыльных</span><span><i style="color:var(--loss);border-top-style:solid;border-top-width:6px"></i>сумма убыточных</span></div></div>`;
}

function wSessions(el, x) {
  const order = (S.st?.sessions || []).map((s) => s.name).concat(["Вне сессий"]);
  const list = [...(x.st.by_session || [])].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  el.innerHTML = `<div class="panel-h"><h2>Винрейт по сессиям</h2><a class="btn sm" href="#/settings">Часы сессий</a></div>
    <div class="panel-b">${list.length ? list.map((v) => `<div class="hbar" title="${v.count} ${plural(v.count, "сделка", "сделки", "сделок")}, итог ${money(v.net)}">
      <div class="h"><span>${esc(v.key)} <span class="muted">${v.count} ${plural(v.count, "сделка", "сделки", "сделок")}, <span class="${cls(v.net)}">${compact(v.net)}</span></span></span><b>${String(v.win_rate).replace(".", ",")}%</b></div>
      <div class="track"><i style="width:${v.win_rate}%"></i></div></div>`).join("") : '<div class="empty">Нет данных</div>'}</div>`;
}

function wLongShort(el, x) {
  const by = Object.fromEntries((x.st.by_direction || []).map((d) => [d.key, d]));
  const half = (k, label) => {
    const d = by[k];
    if (!d) return `<div class="ls"><b>${label}</b><div class="empty">Сделок нет</div></div>`;
    const wr = d.win_rate, r = 46, c = Math.PI * r;
    return `<div class="ls"><div class="ls-h"><b>${label}</b><span class="muted">${d.count} ${plural(d.count, "сделка", "сделки", "сделок")}</span></div>
      <svg viewBox="0 0 120 70" width="150" height="88" aria-hidden="true"><path d="M14 62 A46 46 0 0 1 106 62" fill="none" stroke="var(--loss)" stroke-width="10" stroke-linecap="round" opacity=".85"/>
        <path d="M14 62 A46 46 0 0 1 106 62" fill="none" stroke="var(--profit)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * wr) / 100} ${c}"/></svg>
      <div class="ls-v ${cls(d.net)}">${UC(d.net, d.avg_r !== null ? d.avg_r * d.count : null)}</div>
      <div class="ls-row"><span>прибыльных <b>${String(wr).replace(".", ",")}%</b></span><span>средний <b>${rfmt(d.avg_r)}</b></span></div>
      <div class="ls-row muted"><span>+${compact(d.gross_profit).replace("+", "")}</span><span>${compact(d.gross_loss)}</span></div></div>`;
  };
  el.innerHTML = `<div class="panel-h"><h2>Лонги и шорты</h2></div><div class="panel-b"><div class="ls-grid">${half("Buy", "Лонги")}${half("Sell", "Шорты")}</div></div>`;
}

function tabsHTML(key, opts) {
  const cur = S.wtabs?.[key] || opts[0][0];
  return `<div class="wtabs" data-wt="${key}">${opts.map(([k, l]) => `<button class="${k === cur ? "on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>`;
}
function bindTabs(el, key, redraw) {
  el.querySelectorAll(`.wtabs[data-wt="${key}"] button`).forEach((b) => (b.onclick = () => { S.wtabs = { ...(S.wtabs || {}), [key]: b.dataset.k }; redraw(); }));
}
const emptyW = (txt) => `<div class="w-empty"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M3 21h18"/></svg><span>${txt}</span></div>`;

function wHoldTime(el, x) {
  const draw = () => {
    const mode = S.wtabs?.hold || "long";
    const pts = [...(x.st.dur_points || [])];
    const avg = pts.length ? pts.reduce((a, p) => a + p.d, 0) / pts.length : 0;
    const list = mode === "avg" ? [] : pts.sort((a, b) => (mode === "long" ? b.d - a.d : a.d - b.d)).slice(0, 3);
    const head = mode === "avg" ? avg : list[0]?.d;
    el.innerHTML = `<div class="panel-h"><h2>Время в позиции</h2>${tabsHTML("hold", [["long", "Самая долгая"], ["short", "Самая короткая"], ["avg", "Средняя"]])}</div>
      <div class="panel-b">${pts.length ? `<div class="w-big">${dur(Math.round(head || 0))}</div>
        <div class="w-cap">${mode === "avg" ? `В среднем сделка длится ${dur(Math.round(avg))}. Прибыльные: ${dur(Math.round(avgOf(pts.filter((p) => p.net > 0))))}, убыточные: ${dur(Math.round(avgOf(pts.filter((p) => p.net < 0))))}.`
          : `${mode === "long" ? "Самую долгую" : "Самую короткую"} позицию вы держали ${dt(list[0].open - shift(), false)}.`}</div>
        ${list.length ? `<div class="w-list">${list.map((p) => `<div class="row click" data-id="${p.id}"><span><b>${esc(p.symbol)}</b><small>${dur(p.d)}</small></span><span class="${cls(p.net)}">${UC(p.net, p.r)}</span></div>`).join("")}</div>` : ""}`
        : emptyW("Позиции не найдены")}</div>`;
    bindTabs(el, "hold", draw);
    el.querySelectorAll("[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#/trade/${S.login}/${r.dataset.id}`)));
  };
  draw();
}
const avgOf = (arr) => (arr.length ? arr.reduce((a, p) => a + p.d, 0) / arr.length : 0);

function wRHist(el, x) {
  const d = x.st.r_hist || [], mx = Math.max(1, ...d.map((b) => b.count));
  el.innerHTML = `<div class="panel-h"><h2>Распределение R</h2><span class="muted" style="font-size:12px">${x.s.r_count} ${plural(x.s.r_count, "сделка", "сделки", "сделок")} со стопом</span></div>
    <div class="panel-b"><div class="rh">${d.map((b) => `<div class="rh-col" title="${b.r === -4 ? "−4R и хуже" : b.r === 6 ? "+6R и лучше" : (b.r > 0 ? "+" : "") + b.r + "R"}: ${b.count}">
      <i style="height:${(100 * b.count) / mx}%;background:${b.r < 0 ? "var(--loss)" : b.r > 0 ? "var(--profit)" : "var(--muted)"}"></i><span>${b.r > 0 ? "+" : ""}${b.r}${b.r === -4 ? "↓" : b.r === 6 ? "↑" : ""}</span></div>`).join("")}</div></div>`;
}

function wRolling(el, x) {
  el.innerHTML = `<div class="panel-h"><h2>Скользящее матожидание</h2><span class="muted" style="font-size:12px">средний R последних 20 сделок</span></div><div class="panel-b"><div class="roll-chart"></div></div>`;
  const pts = x.st.rolling || [];
  const box = el.querySelector(".roll-chart");
  if (pts.length < 2) { box.innerHTML = '<div class="empty">Нужно больше 20 сделок со стопом.</div>'; return; }
  const c = chartBase(box, { timeScale: { borderColor: css("--line"), timeVisible: false } });
  const data = []; let last = -Infinity;
  for (const p of pts) { const t = p.time <= last ? last + 1 : p.time; data.push({ time: t, value: p.value }); last = t; }
  const s = c.addBaselineSeries({ baseValue: { type: "price", price: 0 }, topLineColor: css("--profit"), bottomLineColor: css("--loss"),
    topFillColor1: css("--profit") + "33", topFillColor2: css("--profit") + "05", bottomFillColor1: css("--loss") + "05", bottomFillColor2: css("--loss") + "33", lineWidth: 2, lineType: 2, priceLineVisible: false });
  s.setData(data);
  setTimeout(() => { try { c.timeScale().fitContent(); } catch (e) {} }, 60);
}

function wHeat(el, x) {
  const days = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  const cells = new Map((x.st.heat || []).map((c) => [`${c.wd}-${c.h}`, c]));
  const wds = [0, 1, 2, 3, 4].concat([5, 6].filter((w) => [...cells.values()].some((c) => c.wd === w)));
  const max = Math.max(1, ...[...cells.values()].map((c) => Math.abs(c.net)));
  const s = x.s;
  el.innerHTML = `<div class="panel-h"><h2>Время входа: день и час</h2>
      <span class="muted" style="font-size:12px">${s.best_hour ? `лучший час ${String(s.best_hour.hour).padStart(2, "0")}:00 (${compact(s.best_hour.net)})` : ""}${s.best_session ? `, лучшая сессия ${esc(s.best_session.name)}` : ""}</span></div>
    <div class="panel-b tbl-wrap"><div class="heat" style="grid-template-columns:36px repeat(24, minmax(22px, 1fr))">
      <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="hh">${h % 3 ? "" : String(h).padStart(2, "0")}</span>`).join("")}
      ${wds.map((w) => `<span class="hh" style="text-align:left">${days[w]}</span>` + Array.from({ length: 24 }, (_, h) => {
        const c = cells.get(`${w}-${h}`);
        if (!c) return '<i class="hc"></i>';
        const a = 0.18 + 0.82 * Math.min(1, Math.abs(c.net) / max);
        return `<i class="hc" title="${days[w]} ${String(h).padStart(2, "0")}:00: ${c.count} ${plural(c.count, "сделка", "сделки", "сделок")}, прибыльных ${Math.round((100 * c.wins) / c.count)}%, ${money(c.net)}"
          style="background:color-mix(in srgb, ${c.net >= 0 ? "var(--profit)" : "var(--loss)"} ${Math.round(a * 100)}%, transparent)"></i>`;
      }).join("")).join("")}</div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Время входа${shift() ? " со сдвигом из config.json" : " по серверу брокера"}. Цвет - результат, насыщенность - величина.</p></div>`;
}

/* ---------- форматирование рыночных данных ---------- */
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
function fmtInt(n, signed = false) {
  if (n === null || n === undefined) return "—";
  return (signed && n > 0 ? "+" : n < 0 ? "−" : "") + nf0.format(Math.abs(n));
}
function fmtVal(v, unit) { return v === null || v === undefined ? "—" : Number(v).toFixed(2).replace(".", ",") + (unit ? " " + unit : ""); }
function fmtChg(v) { return v === null || v === undefined ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ","); }
function idxBadge(v) { return v === null || v === undefined ? "—" : `<span class="idx ${v >= 80 ? "hi" : v <= 20 ? "lo" : ""}">${Math.round(v)}</span>`; }
