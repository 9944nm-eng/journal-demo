/* Сегодня: главная страница. Показывает то, что нужно именно сейчас.
   Фаза выбирается сама по времени, окну ТС и состоянию счёта, её можно переключить вручную:
     выходные  - итоги недели, недельный разбор, следующая неделя, практика;
     подготовка - лимиты, окно ТС, план, чек-лист, новости дня, заметки;
     торговля   - позиции и запас до лимитов; между сделками - результат дня и стоп-условия ТС;
     итог       - результат и кривая дня, разбор, итог, что завтра.
   Поверх любой фазы - предупреждения по счёту: лимит почти исчерпан, лимит сделок ТС, серия убытков, цель достигнута. */
"use strict";

const PHASES = [["week", "Выходные"], ["prep", "Подготовка"], ["trade", "Торговля"], ["wrap", "Итог"]];

// валюты, от новостей которых зависит инструмент (как на сервере, journal/news.py)
function symCcys(sym) {
  const s = String(sym || "").toUpperCase(), base = s.split(".")[0].replace(/[^A-Z]/g, "");
  const fx = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "CNY"];
  if (base.length >= 6 && fx.includes(base.slice(0, 3)) && fx.includes(base.slice(3, 6))) return [base.slice(0, 3), base.slice(3, 6)];
  const idx = [["GER", "EUR"], ["DE", "EUR"], ["DAX", "EUR"], ["EU50", "EUR"], ["FRA", "EUR"], ["UK100", "GBP"], ["JP225", "JPY"], ["AUS200", "AUD"]];
  for (const [k, v] of idx) if (s.startsWith(k)) return [v];
  return ["USD"];
}

// глиф сделки: стоп слева (−1R), вход в нуле, тейк и выход справа - одинаково для Buy и Sell
function tradeGlyph(t, w = 64) {
  const sl = t.sl_used || t.sl_initial, risk = sl ? Math.abs(t.entry_price - sl) : 0;
  if (!risk) return '<span class="muted" title="Стоп не найден">—</span>';
  const R = (p) => ((p - t.entry_price) * t.direction) / risk;
  const tpR = t.tp_initial ? R(t.tp_initial) : null;
  const exR = t.status === "closed" && t.exit_price ? R(t.exit_price) : t.price_current ? R(t.price_current) : null;
  const lo = -1, hi = Math.max(1, tpR ?? 1, exR ?? 1), x = (v) => 3 + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (w - 6);
  const ec = exR === null ? "var(--muted)" : exR >= 0 ? "var(--profit)" : "var(--loss)";
  return `<svg class="glyph" viewBox="0 0 ${w} 16" width="${w}" height="16" role="img" aria-label="Стоп −1R${tpR !== null ? ", тейк +" + tpR.toFixed(1) + "R" : ""}${exR !== null ? ", выход " + exR.toFixed(2) + "R" : ""}">
    <line x1="${x(lo)}" x2="${x(hi)}" y1="8" y2="8" stroke="var(--line)" stroke-width="2"/>
    <line x1="${x(-1)}" x2="${x(-1)}" y1="3" y2="13" stroke="var(--loss)" stroke-width="2"/>
    ${tpR !== null ? `<line x1="${x(tpR)}" x2="${x(tpR)}" y1="3" y2="13" stroke="var(--profit)" stroke-width="2"/>` : ""}
    ${exR !== null ? `<line x1="${x(0)}" x2="${x(exR)}" y1="8" y2="8" stroke="${ec}" stroke-width="2"/>` : ""}
    <circle cx="${x(0)}" cy="8" r="2.5" fill="var(--text)"/>
    ${exR !== null ? `<circle cx="${x(exR)}" cy="8" r="3.5" fill="${ec}"/>` : ""}</svg>`;
}

// шкала: провал ← старт → цель (или стоп ← вход → тейк). lo/hi/zero/cur - в одних единицах
function rulerHTML(o) {
  const span = o.hi - o.lo || 1, pos = (v) => Math.max(0, Math.min(100, (100 * (v - o.lo)) / span));
  const z = pos(o.zero), m = pos(o.cur), up = o.cur >= o.zero;
  const ticks = (o.ticks || []).map((v) => `<span class="ruler-tick" style="left:${pos(v)}%"></span>`).join("");
  return `<div class="ruler">
    <div class="ruler-track"><span class="ruler-zone loss" style="width:${z}%"></span><span class="ruler-zone gain" style="left:${z}%"></span>
      <span class="ruler-fill ${up ? "pos" : "neg"}" style="left:${Math.min(z, m)}%;width:${Math.abs(m - z)}%"></span>
      <span class="ruler-zero" style="left:${z}%"></span>${ticks}<span class="ruler-mark ${up ? "pos" : "neg"}" style="left:${m}%"></span></div>
    <div class="ruler-lab"><span>${o.loLabel}</span><span class="now">${o.curLabel}</span><span style="text-align:right">${o.hiLabel}</span></div></div>`;
}

const fmtN = (v, d = 2) => (v === null || v === undefined ? "—" : new Intl.NumberFormat("ru-RU", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
const sgn = (v, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmtN(Math.abs(v), d);
const hm = (ts) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
const inMin = (ts) => { const m = Math.round((ts - Date.now() / 1000) / 60); return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${String(m % 60).padStart(2, "0")} мин`; };
const localDate = (ts) => { const x = new Date(ts * 1000); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
// следующий торговый день (пн-пт) после даты YYYY-MM-DD
function nextTradingDay(d) {
  let x = addDays(d, 1);
  while ([0, 6].includes(new Date(x + "T12:00:00").getDay())) x = addDays(x, 1);
  return x;
}
// короткая метка счёта: Alpha Capital Group → ACG, Blue Guardian → BG
function accAbbr(login) {
  const a = (S.st?.accounts || []).find((x) => x.login === login);
  const firm = accShort(a).split(" · ")[0].trim();
  const w = firm.split(/\s+/).filter(Boolean);
  return w.length > 1 ? w.map((x) => x[0]).join("").toUpperCase().slice(0, 3) : firm.slice(0, 3).toUpperCase();
}

// окно торговли по ТС: сессии из правила «Торговать только» (или все сессии), время UTC → метки сегодняшнего дня
function tsWindow(rules) {
  const all = S.st?.sessions || [];
  const names = rules.find((r) => r.kind === "sessions_only")?.params?.sessions || [];
  const ses = names.length ? all.filter((s) => names.includes(s.name)) : all;
  if (!ses.length) return null;
  const start = Math.min(...ses.map((s) => s.start)), end = Math.max(...ses.map((s) => s.end));
  const n = new Date(), base = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) / 1000;
  return { start: base + start * 3600, end: base + end * 3600, label: ses.map((s) => s.name).join(", ") };
}

async function renderToday(forced) {
  const d = todayStr();
  const now = Math.floor(Date.now() / 1000);
  const acc = S.st?.accounts?.find((a) => a.login === S.login) || {};
  const weekend = [0, 6].includes(new Date().getDay());
  const [prog, day, days, wf, rules, newsRes, live, pinned, week, sleep, tasks] = await Promise.all([
    api("/api/progress").catch(() => null),
    api(`/api/day?date=${d}`).catch(() => null),
    api("/api/days").catch(() => []),
    api("/api/week/focus").catch(() => null),
    api("/api/rules").catch(() => ({ rules: [] })),
    api(`/api/news?from=${now - 18 * 3600}&to=${now + 8 * 86400}`).catch(() => ({ items: [] })),
    fetch("/api/live").then((r) => r.json()).catch(() => null),
    api("/api/notes?pinned=1").catch(() => []),
    weekend ? api("/api/week").catch(() => null) : null,
    api("/api/sleep?impact=1").catch(() => null),
    api("/api/review/tasks").catch(() => null),
  ]);
  if (live) S.live = live;
  // что сейчас на экране: живое отслеживание перерисует страницу, только если это изменится (live.js)
  S.liveSig = (live?.status || "") + "|" + (live?.status === "live" ? live.positions || [] : []).map((p) => p.position_id).join(",");
  const isLive = live?.status === "live" && live.login === S.login;
  const openPos = isLive ? live.positions || [] : [];
  const rl = rules.rules || [];
  const win = tsWindow(rl);
  const sessionOver = win ? now > win.end : new Date().getHours() >= 23;

  // мои инструменты: план недели, ТС, торгуемые на счёте → валюты для новостей
  const tsSyms = (rl.find((r) => r.kind === "symbols_only")?.params?.symbols) || [];
  const mySyms = [...new Set([...(wf?.plan?.instruments || []).map((x) => x.symbol), ...tsSyms, ...(S.st?.options?.symbols || []).slice(0, 6)])];
  const ccys = new Set(mySyms.flatMap(symCcys));
  const mine = (newsRes.items || []).filter((n) => ccys.has(n.currency));
  const news = mine.filter((n) => localDate(n.time) === d);
  const tomorrow = nextTradingDay(d);

  const ctx = { prog, day, days, wf, rules: rl, news, newsAll: mine, tomorrow, pinned: (pinned || []).filter((n) => n.pinned),
    newsLoaded: (newsRes.items || []).length > 0, ccys: [...ccys], live, isLive, openPos, acc, now, win, sessionOver, weekend, week, sleep, tasks };
  const auto = openPos.length ? "trade" : weekend ? (day?.count ? "wrap" : "week")
    : day?.signed_off ? "wrap" : day?.count ? (sessionOver ? "wrap" : "trade") : sessionOver ? "wrap" : "prep";
  const phases = PHASES.filter(([k]) => k !== "week" || weekend);
  const mode = forced && phases.some(([k]) => k === forced) ? forced : phases.some(([k]) => k === S.todayMode) ? S.todayMode : auto;

  view.innerHTML = `
    <div class="today-head">
      <h1>Сегодня</h1><span class="date">${dayTitle(d).toLowerCase()}</span>
      <div class="seg mode-seg" role="group" aria-label="Фаза дня">${phases.map(([k, l]) => `<button type="button" data-m="${k}" class="${k === mode ? "on" : ""}" aria-pressed="${k === mode}" title="${k === auto ? "Выбрано автоматически" : ""}">${k === "trade" && openPos.length ? '<span class="live" aria-hidden="true"></span>' : ""}${l}</button>`).join("")}</div>
    </div>
    ${stateAlerts(ctx, mode)}
    ${tasks?.unseen ? `<div class="week-banner"><span><b>Разбор за ${esc((tasks.title || "").toLowerCase())} готов.</b> Что стоило тебе денег и задания на месяц.</span><a class="btn sm primary" href="#/month/${tasks.month}">Открыть</a></div>` : ""}
    <div class="today-grid tg" id="todayBody"></div>`;
  view.querySelector(".mode-seg").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.m === mode) return;
    // смена фазы - тот же раздел, поэтому переход вбок: вправо к более поздней фазе дня, влево к ранней
    const order = phases.map(([k]) => k);
    S.modeDir = order.indexOf(b.dataset.m) > order.indexOf(mode) ? "dir-r" : "dir-l";
    S.todayMode = b.dataset.m === auto ? null : b.dataset.m;
    route();
  };
  const body = $("#todayBody");
  body.innerHTML = { week: todayWeekend, prep: todayPrep, trade: todayTrade, wrap: todayWrap }[mode](ctx);
  bindToday(ctx, mode);
}

/* ---------- предупреждения по состоянию счёта: показываются в любой фазе, самое важное первым ---------- */
function stateAlerts(c, mode) {
  const trading = mode === "trade" || mode === "prep";  // «пауза» и «лимит сделок» нужны, пока можно войти
  const out = [];
  const p = c.prog, r = p?.rules || {};
  const mineToday = (c.day?.trades || []).filter((t) => t.login === S.login);
  const closed = mineToday.filter((t) => t.status === "closed").sort((a, b) => a.close_time - b.close_time);
  if (p && r.kind === "prop" && p.today_limit) {
    const left = Math.max(0, p.today_limit - (p.today_used || 0));
    if (left <= p.today_limit * 0.2) out.push(["bad", `Дневной лимит фирмы почти исчерпан: осталось ${fmtN(left)} ${esc(c.acc.currency || "")}.`, "На сегодня лучше закончить."]);
  }
  const dl = c.rules.find((x) => x.kind === "daily_loss");
  if (dl && p && p.today_used > 0) {
    const ts = ((p.day_start || p.balance) * (dl.params.pct || 0)) / 100;
    if (ts && p.today_used >= ts) out.push(["bad", `Дневной убыток по ТС (${String(dl.params.pct).replace(".", ",")}%) достигнут.`, "Новые входы сегодня будут нарушением ТС."]);
  }
  const mt = c.rules.find((x) => x.kind === "max_trades_day");
  if (mt && mineToday.length >= mt.params.n && trading) out.push(["warn", `Лимит сделок по ТС: ${mineToday.length} из ${mt.params.n}.`, "Следующая сделка сегодня будет вне ТС."]);
  const last2 = closed.slice(-2);
  if (last2.length === 2 && last2.every((t) => t.net < 0) && !c.openPos.length && trading) out.push(["warn", "Два убытка подряд.", "Сделай паузу и вернись к плану, прежде чем входить снова."]);
  // ночь заметно хуже нормы: предупреждаем, пока можно войти, с цифрами из своей истории
  const la = trading && typeof lateAlert === "function" ? lateAlert(c) : null;
  if (la) out.push(la);
  const ra = trading && typeof revengeAlert === "function" ? revengeAlert(c) : null;
  if (ra) out.unshift(ra);
  const si = trading && typeof sleepIssue === "function" ? sleepIssue(c.sleep) : null;
  if (si) out.push(["warn", si.text, si.tip]);
  if (p && p.target_level !== null && p.target_level !== undefined && p.balance >= p.target_level) {
    const need = (r.min_trading_days || 0) - (p.trading_days || 0);
    out.push(["good", "Цель челленджа достигнута.", need > 0 ? `Осталось торговых дней: ${need}. Достаточно минимального риска.` : "Все условия выполнены: проверь результат у фирмы."]);
  }
  return out.length ? `<div class="state-alerts">${out.map(([k, a, b]) => `<div class="alert ${k}" role="${k === "bad" ? "alert" : "status"}"><b>${a}</b><span>${b}</span></div>`).join("")}</div>` : "";
}

/* ---------- блок лимитов: главное число до и во время сессии ---------- */
function limitsHero(c, compact = false) {
  const p = c.prog, r = p?.rules || {}, cur = c.acc.currency || "";
  if (!p || r.kind !== "prop") {
    const bal = c.acc.balance;
    return `<section class="tile c12"><div class="hero-limits">
      <div><div class="t-label">Баланс счёта</div><div style="margin-top:10px"><span class="t-big">${fmtN(bal)}</span><span class="t-unit">${esc(cur)}</span></div>
      <div class="t-sub">${ago(c.acc.last_sync)} · цели и лимиты не заданы — <a href="#/accounts/${S.login}" style="color:var(--accent-text)">задать</a></div></div></div></section>`;
  }
  const dayLeft = Math.max(0, (p.today_limit || 0) - (p.today_used || 0));
  const totalLeft = Math.max(0, Math.min(p.balance, p.equity) - p.floor_level);
  const toTarget = p.target_level !== null ? Math.max(0, p.target_level - p.balance) : null;
  const usedPct = p.today_limit ? Math.round((100 * (p.today_used || 0)) / p.today_limit) : 0;
  const lossPct = r.max_loss_pct || 0, tgtPct = r.profit_target_pct || 0;
  const ticks = []; for (let k = -Math.floor(lossPct); k <= Math.floor(tgtPct); k++) if (k) ticks.push(p.initial * (1 + k / 100));
  const w = c.win;
  const winNote = w && !c.weekend ? (c.now < w.start ? ` · окно ТС с ${hm(w.start)}, через ${inMin(w.start)}` : c.now <= w.end ? ` · окно ТС до ${hm(w.end)}` : " · окно ТС закрыто") : "";
  return `<section class="tile c12" aria-labelledby="hl">
    <div class="hero-limits">
      <div><h2 id="hl" class="t-label" style="margin:0;font-weight:500">Можно потерять сегодня</h2>
        <div style="margin-top:10px"><span class="t-big">${fmtN(dayLeft)}</span><span class="t-unit">${esc(cur)}</span></div>
        <div class="t-sub">${usedPct ? `использовано ${usedPct}% дневного лимита` : `дневной лимит ${String(r.max_daily_loss_pct).replace(".", ",")}% свободен`} · сброс через <span class="t-mono" data-reset="${p.day_reset_at}" style="color:var(--text)">—</span>${winNote}</div></div>
      <dl><dt>Запас до провала</dt><dd>${fmtN(totalLeft)}</dd>
        <dt>${toTarget === 0 ? "Цель" : "До цели"}</dt><dd class="${toTarget === 0 ? "pos" : ""}">${toTarget === null ? "—" : toTarget === 0 ? "достигнута" : fmtN(toTarget)}</dd>
        <dt>Торговых дней</dt><dd>${p.trading_days}${r.min_trading_days ? ` <span class="muted" style="font-weight:500">/ ${r.min_trading_days}</span>` : ""}</dd></dl>
    </div>
    ${compact ? "" : rulerHTML({ lo: p.floor_level, hi: p.target_level ?? p.initial * (1 + lossPct / 100), zero: p.initial, cur: p.balance, ticks,
      loLabel: `провал <b>${fmtN(p.floor_level, 0)}</b> · −${lossPct}%`,
      curLabel: `сейчас <b class="${p.profit >= 0 ? "pos" : "neg"}">${fmtN(p.balance)}</b> · ${sgn(p.profit_pct ?? 0)}%`,
      hiLabel: p.target_level !== null ? `цель <b>${fmtN(p.target_level, 0)}</b> · +${tgtPct}%` : "без цели" })}
  </section>`;
}

// три колонки: главное, рядом, дополнительно (на обычном экране «дополнительно» уходит под «рядом»)
const cols = (main, side, extra = "") => `<div class="col t-main">${main}</div><div class="col t-side">${side}</div>${extra ? `<div class="col t-extra">${extra}</div>` : ""}`;

/* ---------- подготовка ---------- */
function todayPrep(c) {
  const plan = c.wf?.plan?.instruments || [];
  const pre = c.day?.premarket || {}, items = c.day?.checklist_items || [];
  const tsRules = c.rules.filter((r) => r.source === "ts");
  const biasL = { long: ["Лонг", "long"], short: ["Шорт", "short"], neutral: ["Нейтрально", ""] };
  return `${limitsHero(c)}${cols(`${new Date().getDay() === 1 ? weekQuickTile(S.todo?.week_due) : ""}
      <section class="tile" aria-labelledby="tp-plan">
        <div class="tile-h"><h2 id="tp-plan">План на день</h2><a href="#/day">${pre.plan || pre.levels ? "Изменить" : "Заполнить"}</a></div>
        ${c.wf?.focus ? `<p style="margin:0 0 10px;font-size:14px"><span class="muted">Фокус недели:</span> ${esc(c.wf.focus)}</p>` : ""}
        ${plan.length ? `<div class="rows">${plan.map((x) => `<div class="row-line plan-row"><span class="t-mono" style="font-weight:600">${esc(x.symbol)}</span>
            <span class="bias ${biasL[x.bias]?.[1] || ""}">${biasL[x.bias]?.[0] || "—"}</span><span class="muted">${esc([x.levels, x.scenario].filter(Boolean).join(". ") || "уровни не заданы")}</span></div>${cotLine(x.symbol, c.wf?.cot_brief, x.bias)}`).join("")}</div>` : ""}
        ${pre.plan || pre.levels ? `<p style="margin:${plan.length ? "12px" : "0"} 0 0;font-size:14px;white-space:pre-line">${esc([pre.plan, pre.levels].filter(Boolean).join("\n"))}</p>` : ""}
        ${!plan.length && !pre.plan && !pre.levels ? `<p class="muted" style="margin:0;font-size:14px">План на сегодня не заполнен. Направление по инструментам задаётся в плане недели, уровни и сценарии - в плане дня.</p>
          <div style="display:flex;gap:8px;margin-top:14px"><a class="btn sm" href="#/day">План дня</a><a class="btn sm" href="#/week">План недели</a></div>` : ""}
      </section>
      ${items.length ? `<section class="tile" aria-labelledby="tp-check">
        <div class="tile-h"><h2 id="tp-check">Перед сессией</h2><span class="muted" style="font-size:13px" id="chkCount">${items.filter((x) => (pre.checks || {})[x]).length} из ${items.length}</span></div>
        <div class="checks" id="dayChecks">${items.map((x, i) => `<label><input type="checkbox" data-i="${i}" ${(pre.checks || {})[x] ? "checked" : ""}> ${esc(x)}</label>`).join("")}</div>
      </section>` : ""}`,
    `${quickReviewTile()}${tasksTile(c)}${sleepTile(c)}${newsTile(c)}
      ${tsRules.length ? `<section class="tile" aria-labelledby="tp-ts">
        <div class="tile-h"><h2 id="tp-ts">Правила ТС</h2><a href="#/ts">Моя ТС</a></div>
        <div class="ok-chips" style="margin:0">${tsRules.map((r) => `<span>${esc(r.title)}</span>`).join("")}</div>
      </section>` : ""}`,
    `${pinnedTile(c)}${prevDayTile(c)}`)}`;
}

function pinnedTile(c) {
  return c.pinned.length ? `<section class="tile" aria-labelledby="tp-notes"><div class="tile-h"><h2 id="tp-notes">Закреплённые заметки</h2><a href="#/notes">Все</a></div>
    <div class="rows">${c.pinned.slice(0, 4).map((n) => `<a class="row-line" href="#/notes/${n.id}" style="grid-template-columns:minmax(0,1fr)"><span><b style="font-weight:600">${esc(n.title || "Заметка")}</b>
      <span class="muted" style="display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((n.body || "").slice(0, 140))}</span></span></a>`).join("")}</div></section>` : "";
}

function prevDayTile(c) {
  const prev = (c.days || []).find((x) => x.date < todayStr() && x.count);
  const unrev = S.todo?.unreviewed?.length || 0;
  return `<section class="tile" aria-labelledby="tp-prev">
    <div class="tile-h"><h2 id="tp-prev">${prev ? (prev.date === addDays(todayStr(), -1) ? "Вчера" : dayTitle(prev.date)) : "Прошлый день"}</h2>${prev ? `<a href="#/day/${prev.date}">День</a>` : ""}</div>
    ${prev ? `<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="t-mid ${cls(prev.r)}" style="font-size:30px">${rfmt(prev.r)}</span>
        <span class="muted">${prev.closed} ${plural(prev.closed, "сделка", "сделки", "сделок")} · ${money(prev.net)}</span></div>
      <p class="muted" style="margin:8px 0 0;font-size:14px">Разобрано ${prev.reviewed} из ${prev.count}${prev.signed_off ? " · день закрыт" : ""}</p>` : '<p class="muted" style="margin:0">Сделок ещё не было.</p>'}
    ${unrev ? `<a class="cta" href="#/review" style="margin-top:18px"><span>Разобрать ${unrev} ${plural(unrev, "сделку", "сделки", "сделок")}</span><span aria-hidden="true">→</span></a>` : ""}
  </section>`;
}

function newsTile(c, compact = false) {
  const upcoming = c.news.filter((n) => n.time >= c.now - 1800);
  return `<section class="tile" aria-labelledby="tn">
    <div class="tile-h"><h2 id="tn">Важные новости сегодня</h2><span class="muted" style="font-size:12px">время компьютера</span></div>
    ${c.news.length ? `<div class="rows">${(compact ? upcoming.slice(0, 4) : c.news).map((n) => {
      const past = n.time < c.now - 1800, next = !past && n === upcoming[0];
      return `<div class="row-line news-row ${past ? "past" : ""}"><span class="t-mono">${hm(n.time)}</span><span class="ccy">${esc(n.currency)}</span>
        <span>${esc(n.title)}</span>${next ? `<span class="soon">через ${inMin(n.time)}</span>` : past ? '<span class="muted" style="font-size:12px">прошло</span>' : "<span></span>"}</div>`;
    }).join("")}</div>
      ${c.rules.some((r) => r.kind === "no_news") ? `<p class="muted" style="margin:12px 0 0;font-size:12px">Входы ±${c.rules.find((r) => r.kind === "no_news").params.minutes || 30} минут от этих новостей журнал отметит как нарушение ТС.</p>` : ""}`
      : `<p class="muted" style="margin:0;font-size:14px">${c.newsLoaded ? `Сегодня важных новостей по ${c.ccys.join(", ")} нет.` : "Календарь новостей ещё не загружен: он обновляется при работе журнала раз в 6 часов."}</p>`}
  </section>`;
}

/* ---------- торговля: позиции или «между сделками» ---------- */
function todayTrade(c) {
  const l = c.live, lim = l?.limits;
  const mine = (c.day?.trades || []);
  const posCards = c.openPos.map((p) => {
    const alerts = (l.alerts || []).filter((a) => a.position_id === p.position_id).flatMap((a) => a.items);
    const risk = p.sl_initial ? Math.abs(p.price_open - p.sl_initial) : null;
    const tpR = risk && p.tp ? ((p.tp - p.price_open) * p.direction) / risk : null;
    return `<section class="tile pos-card" aria-label="Позиция ${esc(p.symbol)}">
      <div class="head"><span class="sym">${esc(p.symbol)}</span>${dirBadge(p.direction)}<span class="muted" style="font-size:13px">${p.volume} лот · вход ${price(p.price_open, p.digits)} · ${dur(Math.round(l.updated - p.opened))}</span></div>
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px 40px;margin-top:18px">
        <div><div class="r ${cls(p.r)}">${p.r !== null ? rfmt(p.r) : "без стопа"}</div><div class="money">${money(p.profit)}</div></div>
        <div class="muted" style="font-size:13px;line-height:1.7">лучшее <b class="pos t-mono">${rfmt(p.mfe_r)}</b><br>худшее <b class="neg t-mono">${rfmt(p.mae_r)}</b></div>
      </div>
      ${risk ? rulerHTML({ lo: -1, hi: Math.max(tpR ?? 2, (p.r ?? 0) + 0.2), zero: 0, cur: p.r ?? 0,
        loLabel: `стоп <b>${price(p.sl || p.sl_initial, p.digits)}</b> · −1R`, curLabel: `цена <b>${price(p.price_current, p.digits)}</b>`,
        hiLabel: tpR !== null ? `тейк <b>${price(p.tp, p.digits)}</b> · ${rfmt(Math.round(tpR * 100) / 100)}` : "тейк не задан" }) : '<div class="note-bad" style="margin-top:18px"><b>У позиции нет стопа.</b></div>'}
      <div class="ok-chips">${alerts.length ? alerts.map((a) => `<span class="bad">${esc(a)}</span>`).join("") : `<span>${okIcon()}по правилам ТС</span>`}</div>
      ${exitPlanHTML(p)}
    </section>`;
  }).join("");
  // между сделками: результат дня вместо пустой карточки позиции
  const idle = !c.openPos.length ? `<section class="tile" aria-labelledby="tt-idle">
      <div class="tile-h"><h2 id="tt-idle">${mine.length ? "Между сделками" : "Позиций нет"}</h2><span class="muted" style="font-size:13px">${c.isLive ? "терминал подключён" : "терминал не подключён"}</span></div>
      ${mine.length ? `<div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="t-mid ${cls(c.day.r)}" style="font-size:34px">${rfmt(c.day.r)}</span><span class="muted">${money(c.day.net)} · ${c.day.closed} ${plural(c.day.closed, "сделка", "сделки", "сделок")}${maxTradesNote(c, true)}</span></div>
        ${dayCurve(mine)}` : `<p class="muted" style="margin:0;font-size:14px">${c.isLive ? "Новая позиция появится здесь сразу и будет сверена с ТС." : esc(l?.reason || l?.error || "Живое отслеживание ждёт запущенный торговый терминал этого счёта") + ". Журнал подключится сам: только чтение позиций и средств."}</p>`}
    </section>` : "";
  const limTile = lim ? `<section class="tile" aria-labelledby="ts-lim"><div class="tile-h"><h2 id="ts-lim">Лимиты сейчас</h2><span class="muted" style="font-size:12px">по текущим средствам</span></div>
      ${lim.daily_left !== undefined ? `<div class="kv-line"><span class="t-label">Дневной запас</span><span class="t-mid">${fmtN(lim.daily_left)}</span></div>
        <div class="minibar ${lim.daily_used_share > 0.8 ? "bad" : lim.daily_used_share >= 0.5 ? "warn" : ""}"><i style="width:${Math.max(0, Math.min(100, 100 * (lim.daily_used_share || 0)))}%"></i></div>
        <div class="muted" style="font-size:12px">использовано ${Math.round(100 * Math.max(0, lim.daily_used_share || 0))}% · сброс через <span data-reset="${lim.day_reset_at}">—</span></div>` : ""}
      ${lim.total_left !== undefined ? `<div class="kv-line" style="margin-top:18px"><span class="t-label">Запас до провала</span><span class="t-mid">${fmtN(lim.total_left)}</span></div>` : ""}
      ${lim.target_left !== undefined ? `<div class="kv-line" style="margin-top:14px"><span class="t-label">До цели</span><span class="t-mid ${lim.target_left <= 0 ? "pos" : ""}">${lim.target_left <= 0 ? "достигнута" : fmtN(lim.target_left)}</span></div>` : ""}
      <div class="kv-line" style="margin-top:18px"><span class="t-label">Плавающий результат</span><span class="t-mid ${cls(l.floating)}">${money(l.floating)}</span></div>
    </section>` : "";
  return `${c.openPos.length && lim ? "" : limitsHero(c, !!c.openPos.length)}${cols(`${posCards}${idle}
      <section class="tile" aria-labelledby="ts-tr"><div class="tile-h"><h2 id="ts-tr">Сделки сегодня</h2><span class="muted" style="font-size:13px">${maxTradesNote(c) ? `${esc(accAbbr(S.login))}: ${mine.filter((t) => t.login === S.login).length}${maxTradesNote(c)} по ТС` : mine.length}</span></div>
        ${mine.length ? `<div class="rows">${tradeRows(mine)}</div>` : '<p class="muted" style="margin:0">Сделок сегодня ещё не было.</p>'}</section>${quickReviewTile()}`,
    `${limTile}${tasksTile(c)}${nextNewsNote(c)}${newsTile(c, true)}`,
    `<p class="muted" style="margin:0;font-size:12px;line-height:1.5">Журнал только читает терминал: позиции, средства и сделки. Он ничего не открывает и не закрывает.</p>`)}`;
}
const okIcon = () => '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="var(--profit)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
function maxTradesNote(c, long = false) {
  const r = c.rules.find((x) => x.kind === "max_trades_day");
  if (!r) return "";
  const n = (c.day?.trades || []).filter((t) => t.login === S.login).length;
  return long ? ` · по ТС ещё ${Math.max(0, r.params.n - n)} из ${r.params.n}` : ` из ${r.params.n}`;
}
function nextNewsNote(c) {
  const n = c.news.find((x) => x.time >= c.now && x.time - c.now < 3 * 3600);
  if (!n) return "";
  const nr = c.rules.find((r) => r.kind === "no_news");
  return `<div class="note-warn"><b>Через ${inMin(n.time)} · ${esc(n.currency)} ${esc(n.title)}</b><span class="muted" style="font-size:13px">${nr ? `Входы с ${hm(n.time - (nr.params.minutes || 30) * 60)} до ${hm(n.time + (nr.params.minutes || 30) * 60)} будут вне ТС.` : "Важная новость по твоим валютам."}</span></div>`;
}

// строки сделок дня: метка счёта, если счетов несколько, и значок общей пары
const LINK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
function tradeRows(list) {
  const multi = new Set(list.map((t) => t.login)).size > 1;
  return list.map((t) => tradeLine(t, multi)).join("");
}
function tradeLine(t, showAcc = false) {
  const rev = !!(t.grade || t.followed_plan !== null && t.followed_plan !== undefined || (t.entry_reason || "").trim() || t.setup);
  const vio = (t.violations || []).length;
  return `<a class="row-line trade-row${showAcc ? " with-acc" : ""}" href="#/trade/${t.login}/${t.position_id}">
    <span class="t-mono muted" style="font-size:13px">${dt(t.open_time).slice(-5)}</span>${showAcc ? `<span class="acc-chip" title="${esc(accShort((S.st?.accounts || []).find((a) => a.login === t.login)))}">${esc(accAbbr(t.login))}</span>` : ""}<span class="t-mono" style="font-weight:600">${esc(t.symbol)}</span>${dirBadge(t.direction)}
    <span style="display:flex;align-items:center;gap:10px;min-width:0">${tradeGlyph(t)}${(t.twins || []).length ? `<span class="twin-mark" title="Та же идея на другом счёте: разбор общий">${LINK_ICON}</span>` : ""}<span class="${rev ? "muted" : "unrev"}" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t.status === "open" ? "открыта" : rev ? esc(t.setup || "разобрана") : "разобрать →"}</span>${vio ? `<span class="violation" title="${esc(t.violations.join("; "))}">не по ТС</span>` : ""}</span>
    <span class="t-mono ${cls(t.r ?? t.net)}" style="font-weight:600">${t.r !== null && t.r !== undefined ? rfmt(t.r) : money(t.net)}</span></a>`;
}

// кривая дня в R по закрытым сделкам (все счета)
function dayCurve(trades) {
  const cl = trades.filter((t) => t.status === "closed" && t.r !== null && t.r !== undefined).sort((a, b) => a.close_time - b.close_time);
  if (cl.length < 2) return "";
  let s = 0; const pts = [0, ...cl.map((t) => (s += t.r))];
  const W = 320, H = 56, lo = Math.min(0, ...pts), hi = Math.max(0, ...pts), sp = hi - lo || 1;
  const x = (i) => 4 + (i * (W - 8)) / (pts.length - 1), y = (v) => 4 + ((hi - v) * (H - 8)) / sp;
  const col = s >= 0 ? "var(--profit)" : "var(--loss)";
  return `<svg class="day-curve" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Кривая дня: ${rfmt(s)}">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <polyline fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" points="${pts.map((v, i) => `${x(i)},${y(v)}`).join(" ")}"/>
    ${pts.map((v, i) => (i ? `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${cl[i - 1].r >= 0 ? "var(--profit)" : "var(--loss)"}"/>` : "")).join("")}</svg>`;
}

/* ---------- итог дня ---------- */
function todayWrap(c) {
  const x = c.day || { trades: [], count: 0, closed: 0, r: 0, net: 0, reviewed: 0, wrap: {}, accounts: [] };
  const w = x.wrap || {};
  const unrevToday = x.count - x.reviewed;
  const plan = x.trades.filter((t) => t.followed_plan === 1).length;
  const vio = x.trades.filter((t) => (t.violations || []).length).length;
  const multi = (x.accounts || []).length > 1;
  return `<section class="tile c12" aria-labelledby="tw-h">
      <div class="hero-limits">
        <div><h2 id="tw-h" class="t-label" style="margin:0;font-weight:500">Результат дня${multi ? " · все счета" : ""}</h2>
          <div style="margin-top:10px"><span class="t-big ${cls(x.r)}">${rfmt(x.r)}</span><span class="t-unit">${money(x.net)}</span></div>
          <div class="t-sub">${x.count ? `${x.closed} ${plural(x.closed, "сделка закрыта", "сделки закрыто", "сделок закрыто")}${x.count > x.closed ? ` · ${x.count - x.closed} открыто` : ""}${multi ? " · " + x.accounts.map((a) => `${esc(accAbbr(a.login))} ${rfmt(a.r)}`).join(", ") : ""}` : "сделок не было"}</div></div>
        <dl><dt>Разобрано</dt><dd>${x.reviewed} <span class="muted" style="font-weight:500">/ ${x.count}</span></dd>
          <dt>По плану</dt><dd>${plan} <span class="muted" style="font-weight:500">/ ${x.closed}</span></dd>
          <dt>Нарушений ТС</dt><dd class="${vio ? "neg" : x.count ? "pos" : ""}">${vio}</dd></dl>
      </div></section>
    ${cols(`<section class="tile" aria-labelledby="tw-tr"><div class="tile-h"><h2 id="tw-tr">Сделки дня</h2>${unrevToday > 0 ? `<a href="#/review">Разобрать ${unrevToday}</a>` : ""}</div>
        ${x.trades.length ? `${dayCurve(x.trades)}<div class="rows">${tradeRows(x.trades)}</div>` : '<p class="muted" style="margin:0">Сегодня сделок не было. День без входов вне плана - тоже результат: можно коротко записать, почему не было сетапа.</p>'}</section>${quickReviewTile()}`,
    `<section class="tile" aria-labelledby="tw-w"><div class="tile-h"><h2 id="tw-w">Итог дня</h2><a href="#/day">Подробнее</a></div>
        <form class="form" id="wrapForm" style="padding:0" autocomplete="off">
          <label class="f"><span>Что получилось</span><textarea name="good" rows="2">${esc(w.good || "")}</textarea></label>
          <label class="f"><span>Что улучшить завтра</span><textarea name="improve" rows="2">${esc(w.improve || "")}</textarea></label>
          <div class="f"><span>Правила ТС соблюдены</span><div class="seg" id="wRules"><button type="button" data-v="1" class="${w.rules === 1 ? "on" : ""}">Да</button><button type="button" data-v="0" class="${w.rules === 0 ? "on" : ""}">Нет</button></div></div>
          <div class="form-foot">${x.signed_off ? `<button type="button" class="btn sm" id="wClose">Открыть день снова</button><button type="submit" class="btn primary sm">Сохранить</button>`
            : `<button type="submit" class="btn sm">Сохранить</button><button type="button" class="btn primary sm" id="wClose">Закрыть день</button>`}</div>
        </form>${x.signed_off ? '<p class="muted" style="margin:10px 0 0;font-size:12px">День закрыт.</p>' : ""}</section>`,
    tomorrowTile(c))}`;
}

// что ждёт на следующем торговом дне: новости по моим валютам, фокус недели, условия челленджа
function tomorrowTile(c) {
  const t = c.tomorrow, list = c.newsAll.filter((n) => localDate(n.time) === t);
  const p = c.prog, r = p?.rules || {};
  const need = r.min_trading_days ? Math.max(0, r.min_trading_days - (p.trading_days || 0)) : 0;
  return `<section class="tile" aria-labelledby="tw-next"><div class="tile-h"><h2 id="tw-next">${t === addDays(todayStr(), 1) ? "Завтра" : dayTitle(t)}</h2><span class="muted" style="font-size:12px">важные новости</span></div>
    ${list.length ? `<div class="rows">${list.map((n) => `<div class="row-line news-row"><span class="t-mono">${hm(n.time)}</span><span class="ccy">${esc(n.currency)}</span><span>${esc(n.title)}</span><span></span></div>`).join("")}</div>`
      : `<p class="muted" style="margin:0;font-size:14px">${c.newsLoaded ? `Важных новостей по ${c.ccys.join(", ")} нет${c.newsAll.some((n) => n.time > Date.parse(t + "T23:59:59") / 1000) ? "" : " (или календарь на эти дни ещё не вышел)"}.` : "Календарь новостей ещё не загружен."}</p>`}
    ${c.wf?.focus ? `<p style="margin:12px 0 0;font-size:14px"><span class="muted">Фокус недели:</span> ${esc(c.wf.focus)}</p>` : ""}
    ${need ? `<p class="muted" style="margin:8px 0 0;font-size:13px">До минимума торговых дней: ${need}.</p>` : ""}
  </section>`;
}

/* ---------- выходные: неделя целиком ---------- */
function todayWeekend(c) {
  const wk = c.week, s = wk?.summary || {};
  const due = S.todo?.week_due || (wk && !wk.record?.done ? wk.week : null);  // в выходные разбор текущей недели доступен сразу
  const closed = s.trades || 0;
  const nextMon = (() => { let x = addDays(todayStr(), 1); while (new Date(x + "T12:00:00").getDay() !== 1) x = addDays(x, 1); return x; })();
  const nextNews = c.newsAll.filter((n) => localDate(n.time) >= nextMon).slice(0, 8);
  const unrev = S.todo?.unreviewed?.length || 0;
  return `<section class="tile c12" aria-labelledby="we-h">
      <div class="hero-limits">
        <div><h2 id="we-h" class="t-label" style="margin:0;font-weight:500">Неделя · все счета</h2>
          <div style="margin-top:10px"><span class="t-big ${cls(s.sum_r ?? s.net)}">${closed ? (s.sum_r !== null && s.sum_r !== undefined ? rfmt(s.sum_r) : money(s.net)) : "—"}</span>${closed ? `<span class="t-unit">${money(s.net)}</span>` : ""}</div>
          <div class="t-sub">${closed ? `${closed} ${plural(closed, "сделка", "сделки", "сделок")}${s.win_rate !== null && s.win_rate !== undefined ? ` · прибыльных ${String(s.win_rate).replace(".", ",")}%` : ""}` : "сделок на этой неделе не было"}</div></div>
        <dl><dt>Разобрано</dt><dd>${wk?.reviewed ?? 0} <span class="muted" style="font-weight:500">/ ${wk?.closed ?? closed}</span></dd>
          <dt>Нарушений ТС</dt><dd class="${(wk?.violations || []).length ? "neg" : ""}">${(wk?.violations || []).length}</dd>
          <dt>Разбор недели</dt><dd style="font-family:var(--font);font-size:17px" class="${due ? "" : "pos"}">${due ? "не сделан" : "сделан"}</dd></dl>
      </div></section>
    ${cols(`${due ? weekQuickTile(due) : ""}${tasksTile(c)}${due ? ""
      : `<section class="tile"><div class="tile-h"><h2>Следующая неделя</h2><a href="#/week">Неделя</a></div>
        ${c.wf?.focus ? `<p style="margin:0;font-size:14px"><span class="muted">Фокус:</span> ${esc(c.wf.focus)}</p>` : '<p class="muted" style="margin:0;font-size:14px">Фокус на следующую неделю не задан.</p>'}</section>`}
      ${(wk?.best || []).length ? `<section class="tile"><div class="tile-h"><h2>Лучшие и худшие сделки</h2></div><div class="rows">${tradeRows([...(wk.best || []).slice(0, 2), ...(wk.worst || []).slice(0, 2)])}</div></section>` : ""}`,
    `<section class="tile" aria-labelledby="we-news"><div class="tile-h"><h2 id="we-news">Новости следующей недели</h2><span class="muted" style="font-size:12px">${c.ccys.join(", ")}</span></div>
        ${nextNews.length ? `<div class="rows">${nextNews.map((n) => `<div class="row-line news-row"><span class="t-mono">${new Date(n.time * 1000).toLocaleDateString("ru-RU", { weekday: "short" })} ${hm(n.time)}</span><span class="ccy">${esc(n.currency)}</span><span>${esc(n.title)}</span><span></span></div>`).join("")}</div>`
          : '<p class="muted" style="margin:0;font-size:14px">Календарь следующей недели появится к воскресенью: журнал загрузит его сам.</p>'}</section>
      ${sleepWeekTile(c)}${pinnedTile(c)}`,
    `<section class="tile"><div class="tile-h"><h2>Практика</h2><a href="#/backtest">Бэктест</a></div>
        <p class="muted" style="margin:0 0 14px;font-size:14px">Выходные - время для бэктеста своих сетапов в пошаговом режиме: будущее скрыто, итог считается по минуткам.</p>
        <a class="btn sm" href="#/backtest/replay">Пошаговый режим</a></section>
      ${quickReviewTile()}`)}`;
}

function bindToday(c, mode) {
  const d = todayStr();
  loadQuickReview();
  loadWeekQuick();
  if (c.openPos.length) bindExitPlans(S.login);
  const chk = $("#dayChecks");
  if (chk) chk.onchange = async () => {
    const pre = { ...(c.day?.premarket || {}), checks: { ...(c.day?.premarket?.checks || {}) } };
    chk.querySelectorAll("input").forEach((i) => (pre.checks[c.day.checklist_items[+i.dataset.i]] = i.checked));
    c.day.premarket = pre;
    $("#chkCount").textContent = `${Object.values(pre.checks).filter(Boolean).length} из ${c.day.checklist_items.length}`;
    try { await api(`/api/day/${d}`, { method: "PUT", body: JSON.stringify({ premarket: pre }) }); } catch (e) { toast(e.message, true); }
  };
  const form = $("#wrapForm");
  if (form) {
    let rules = c.day?.wrap?.rules ?? null;
    $("#wRules").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; rules = rules === +b.dataset.v ? null : +b.dataset.v; $("#wRules").querySelectorAll("button").forEach((x) => x.classList.toggle("on", +x.dataset.v === rules)); };
    const body = () => ({ ...(c.day?.wrap || {}), good: form.elements.good.value, improve: form.elements.improve.value, rules });
    form.onsubmit = async (e) => { e.preventDefault(); try { await api(`/api/day/${d}`, { method: "PUT", body: JSON.stringify({ wrap: body() }) }); toast("Итог дня сохранён"); } catch (err) { toast(err.message, true); } };
    $("#wClose").onclick = async () => {
      const x = c.day;
      if (!x.signed_off && x.count > x.reviewed && !confirm(`Не разобрано сделок: ${x.count - x.reviewed}. Закрыть день всё равно?`)) return;
      try { await api(`/api/day/${d}`, { method: "PUT", body: JSON.stringify({ wrap: body(), signed_off: !x.signed_off }) }); toast(x.signed_off ? "День снова открыт" : "День закрыт"); quietRefresh(); }
      catch (err) { toast(err.message, true); }
    };
  }
}
