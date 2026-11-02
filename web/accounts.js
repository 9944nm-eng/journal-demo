/* Цели счёта (проп-панель) и управление счетами */
"use strict";

const OBJ_STATUS = {
  passed: ["Выполнено", "ok"], pending: ["В процессе", "wait"], ok: ["В норме", "ok"],
  fail: ["Нарушено", "bad"], fail_soft: ["Не выполнено", "warn"],
};
const ACC_STATUS = { active: ["Активен", "wait"], passed: ["Цель выполнена", "ok"], failed: ["Правило нарушено", "bad"] };

/* ---------- цели счёта ---------- */
async function renderGoals() {
  if (!S.login) {
    view.innerHTML = emptyState("Счетов пока нет", "Подключите счёт MT5: журнал только читает историю и не торгует.", '<a class="btn primary sm" href="#/accounts/new">Подключить счёт</a>');
    return;
  }
  const g = await api("/api/progress" + (S.nv ? "?nv=1" : ""));
  const acc = S.st.accounts.find((a) => a.login === S.login) || {};
  const r = g.rules, isProp = r.kind === "prop";
  const [stTxt, stCls] = ACC_STATUS[g.status] || ACC_STATUS.active;
  const days = S.goalDaysAll ? g.days : g.days.slice(0, 14);

  view.innerHTML = `
    <div class="td-head">
      <div class="td-title">
        <h1>${esc(accShort(acc))}</h1>
        ${isProp ? `<span class="pill ${stCls}">${stTxt}</span>` : ""}
        <span class="muted" style="font-size:14px">${S.login}${acc.server ? " · " + esc(acc.server) : ""}${isProp && g.elapsed_days ? ` · идёт ${g.elapsed_days}-й день` : ""}</span>
      </div>
      <div style="display:flex;gap:12px;align-items:center"><label class="toggle"><input type="checkbox" id="gNv" ${S.nv ? "checked" : ""}> Без нарушений ТС</label><a class="btn sm" href="#/accounts/${S.login}">Настроить цели</a></div>
    </div>
    ${S.nv ? `<div class="week-banner"><span>Без ${g.excluded} ${plural(g.excluded, "сделки", "сделок", "сделок")} с нарушениями ТС: итог и статус - как было бы без них.</span></div>` : ""}
    ${isProp && g.status === "passed" ? '<div class="status-banner ok">Все цели челленджа выполнены по расчёту журнала. Официальный статус - в кабинете фирмы.</div>' : ""}
    ${isProp && g.status === "failed" ? `<div class="status-banner bad">По расчёту журнала нарушено: ${esc(g.objectives.filter((o) => o.status === "fail").map((o) => o.title).join(", "))}. Сверьтесь с кабинетом фирмы.</div>` : ""}

    <div class="today-grid">
      ${limitsHero({ prog: g, acc })}
      <section class="panel c8" style="align-self:stretch">
        <div class="chart-tools">
          <b>Баланс от старта</b>
          <div class="legend">
            ${g.target_level !== null ? '<span><i style="color:var(--profit)"></i>цель</span>' : ""}
            ${g.today_floor !== null ? '<span><i style="color:var(--muted)"></i>дневной порог</span>' : ""}
            ${g.floor_level !== null ? '<span><i style="color:var(--loss);border-top-style:solid"></i>уровень провала</span>' : ""}
            <label class="toggle"><input type="checkbox" id="gLines" ${S.goalLines !== false ? "checked" : ""}> линии</label>
          </div>
        </div>
        <div class="goal-chart" id="gChart"></div>
      </section>
      <section class="panel c4" style="align-self:stretch">
        <div class="panel-h"><h2>Правила челленджа ${hb("goals_rules")}</h2></div>
        <div class="panel-b objectives">${isProp && g.objectives.length ? g.objectives.map(objRow).join("") :
          `<div class="empty">Цели для этого счёта не заданы.<br><br><a class="btn primary sm" href="#/accounts/${S.login}">Задать цели</a></div>`}</div>
      </section>
      <section class="panel c12">
        <div class="panel-h"><h2>По дням</h2><span class="muted">${g.days.length} ${plural(g.days.length, "день", "дня", "дней")}</span></div>
        <div class="panel-b tbl-wrap"><table class="t"><thead><tr>
          <th>Дата</th><th class="num">Входов</th><th class="num">Результат</th><th class="num">Баланс на конец</th><th class="num">Минимум дня</th>
          ${isProp && r.max_daily_loss_pct ? '<th style="min-width:220px">Дневной лимит</th>' : ""}</tr></thead><tbody>
          ${days.map((d) => `<tr>
            <td class="t-mono" style="font-size:13px">${d.date.split("-").reverse().join(".")}</td><td class="num">${d.entries}</td>
            <td class="num ${cls(d.pnl)}"><b>${money(d.pnl)}</b></td><td class="num">${money(d.end, false)}</td><td class="num">${money(d.min, false)}</td>
            ${isProp && r.max_daily_loss_pct ? `<td><div class="meter ${d.breach ? "bad" : d.used / d.limit > 0.8 ? "bad" : d.used / d.limit >= 0.5 ? "warn" : "use"}" title="${money(d.used, false)} из ${money(d.limit, false)}"><i style="width:${Math.min(100, (100 * d.used) / d.limit)}%"></i></div></td>` : ""}
          </tr>`).join("")}</tbody></table>
          ${g.days.length > 14 ? `<div style="text-align:center;margin-top:12px"><button class="btn sm" id="gAll" type="button">${S.goalDaysAll ? "Последние 14 дней" : `Показать все ${g.days.length}`}</button></div>` : ""}</div>
      </section>
    </div>
    <p class="muted" style="font-size:12px;max-width:90ch;margin-top:14px">Лимиты считаются по балансу после закрытых сделок и по средствам на момент последней синхронизации (${ago(g.last_sync)}). Проп-фирмы отслеживают средства непрерывно, поэтому фактическая просадка внутри дня могла быть глубже. Пополнения и снятия в результат не входят.</p>`;

  drawGoalChart($("#gChart"), g);
  $("#gLines").onchange = (e) => { S.goalLines = e.target.checked; quietRefresh(); };
  $("#gNv").onchange = (e) => { S.nv = e.target.checked; quietRefresh(); };
  $("#gAll")?.addEventListener("click", () => { S.goalDaysAll = !S.goalDaysAll; quietRefresh(); });
}

function objRow(o) {
  const [txt, c] = OBJ_STATUS[o.status] || ["", ""];
  const lossRule = ["daily", "total"].includes(o.key);
  const fillCls = lossRule ? (o.status === "fail" ? "bad" : o.progress > 0.7 ? "warn" : "use") : o.status === "passed" ? "ok" : "";
  return `<div class="obj">
    <div class="obj-h"><span>${esc(o.title)}</span><span class="pill ${c}">${txt}</span></div>
    <div class="meter ${fillCls}"><i style="width:${Math.round(o.progress * 100)}%"></i></div>
    <div class="obj-t muted">${esc(o.text)}</div></div>`;
}

function drawGoalChart(el, g) {
  const c = chartBase(el, { timeScale: { borderColor: css("--line"), timeVisible: false } });
  const profit = css("--profit"), loss = css("--loss"), acc = css("--accent"), muted = css("--muted");
  const uniq = (arr) => { const out = []; let last = -Infinity; for (const p of arr) { const t = p.time <= last ? last + 1 : p.time; out.push({ time: t, value: p.value }); last = t; } return out; };
  const showL = S.goalLines !== false;
  const lv = showL ? [g.target_level, g.floor_level, g.today_floor].filter((x) => x !== null) : [];
  const s = c.addBaselineSeries({
    baseValue: { type: "price", price: g.initial },
    topLineColor: profit, topFillColor1: profit + "30", topFillColor2: profit + "04",
    bottomLineColor: loss, bottomFillColor1: loss + "04", bottomFillColor2: loss + "30",
    lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    autoscaleInfoProvider: (orig) => {
      const r = orig();
      if (r && r.priceRange && lv.length) {
        r.priceRange.minValue = Math.min(r.priceRange.minValue, ...lv);
        r.priceRange.maxValue = Math.max(r.priceRange.maxValue, ...lv);
      }
      return r;
    },
  });
  const pts = uniq(g.points);
  s.setData(pts);
  s.createPriceLine({ price: g.initial, color: muted, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "старт" });
  if (showL && g.target_level !== null) s.createPriceLine({ price: g.target_level, color: profit, lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: "цель" });
  if (!showL) { /* линии целей скрыты */ } else if (g.rules.max_loss_type === "trailing" && g.floor_series.length) {
    const fl = c.addLineSeries({ color: loss, lineWidth: 2, lineType: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: "общий лимит" });
    fl.setData(uniq([{ time: pts[0].time, value: g.floor_series[0].value }, ...g.floor_series]));
  } else if (g.floor_level !== null) {
    s.createPriceLine({ price: g.floor_level, color: loss, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: "общий лимит" });
  }
  if (showL && g.today_floor !== null && g.daily_floor.length) {
    const df = c.addLineSeries({ color: muted, lineWidth: 1, lineStyle: 2, lineType: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title: "дневной" });
    const last = pts[pts.length - 1].time;
    const data = uniq(g.daily_floor);
    if (data[data.length - 1].time < last) data.push({ time: last, value: data[data.length - 1].value });
    df.setData(data);
  }
  fitOnResize(c, el);
  setTimeout(() => { try { c.timeScale().fitContent(); } catch (e) {} }, 60);
}

/* ---------- счета ---------- */
const RULE_FIELDS = [
  ["account_size", "Размер счёта", "number", "Пусто: первый баланс в истории"],
  ["start_date", "Дата начала", "date", "Пусто - с первой сделки"],
  ["profit_target_pct", "Цель по прибыли, %", "number", "0 - без цели"],
  ["max_daily_loss_pct", "Дневной лимит убытка, %", "number", "0 - без лимита"],
  ["max_loss_pct", "Общий лимит убытка, %", "number", "0 - без лимита"],
  ["min_trading_days", "Минимум торговых дней", "number", ""],
  ["max_days", "Срок, календарных дней", "number", "0 - без срока"],
  ["consistency_pct", "Лучший день не больше, % прибыли", "number", "0 - без правила"],
  ["day_shift_hours", "Сдвиг начала дня, ч", "number", "Относительно полуночи сервера брокера"],
];

/* ---------- карточка счёта ---------- */
// этап одним языком: «Phase 1» и «Фаза 1» -> «Фаза 1»
const phaseName = (p) => String(p || "").replace(/^\s*(phase|фаза)\s*(\d+)\s*$/i, "Фаза $2").trim();
const firmName = (s) => String(s || "").replace(/[\s,]+(limited|ltd\.?|llc|inc\.?|corp\.?)$/i, "").trim();
const fmtSigned = (v, digits = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(v));

// название счёта у проп-фирм: «Фирма - Программа Phase 1 - Имя владельца»
const labelParts = (a) => String(a.label || "").split(/\s+[-–—|]\s+/).map((x) => x.trim()).filter(Boolean);
const cardFirm = (a) => firmName(a.rules.firm || (labelParts(a).length >= 3 ? labelParts(a)[0] : a.company)) || a.label || "Счёт";
// программа без фирмы, этапа и имени владельца (пользователь один): «Unlimited»
function programName(a, firm) {
  const skip = [firm, a.firm, a.company, a.holder].filter(Boolean).map((x) => firmName(x).toLowerCase());
  let parts = labelParts(a);
  if (parts.length >= 3) parts = parts.slice(0, -1);
  return parts.map((x) => x.replace(/\b(phase|фаза|stage|этап)\s*\d+\b/gi, "").trim())
    .filter((x) => x && !skip.includes(firmName(x).toLowerCase()) && !/^\d+$/.test(x)).join(" · ");
}

let accGid = 0;
// мини-кривая: масштаб по уровням провала и цели, пунктиры старт/цель/провал, выше старта - зелёный, ниже - красный
function accCurve(pts, initial, pg) {
  if (!pts || pts.length < 5) return '<div class="acc-curve none">Мало данных для графика</div>';
  const w = 300, h = 72, pad = 4;
  const lv = [initial, pg?.target_level, pg?.floor_level].filter((x) => x !== null && x !== undefined);
  let lo = Math.min(...pts, ...lv), hi = Math.max(...pts, ...lv);
  if (!pg?.floor_level) lo = Math.min(lo, initial * 0.97);
  if (!pg?.target_level) hi = Math.max(hi, initial * 1.03);
  const y = (v) => pad + ((h - 2 * pad) * (hi - v)) / (hi - lo || 1);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${((i * w) / (pts.length - 1)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const y0 = y(initial), id = `acg${accGid++}`;
  const dash = (v, c, t) => (v === null || v === undefined ? "" :
    `<line x1="0" x2="${w}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${c}" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke"><title>${t}</title></line>`);
  return `<svg class="acc-curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Кривая баланса от старта">
    <defs><clipPath id="${id}u"><rect x="0" y="0" width="${w}" height="${y0}"/></clipPath><clipPath id="${id}d"><rect x="0" y="${y0}" width="${w}" height="${h - y0}"/></clipPath></defs>
    ${dash(pg?.target_level, "var(--profit)", "Цель " + nf2.format(pg?.target_level ?? 0))}
    ${dash(pg?.floor_level, "var(--loss)", "Уровень провала " + nf2.format(pg?.floor_level ?? 0))}
    ${dash(initial, "var(--muted)", "Старт " + nf2.format(initial))}
    <path d="${line}" fill="none" stroke="var(--profit)" stroke-width="1.75" vector-effect="non-scaling-stroke" clip-path="url(#${id}u)"/>
    <path d="${line}" fill="none" stroke="var(--loss)" stroke-width="1.75" vector-effect="non-scaling-stroke" clip-path="url(#${id}d)"/></svg>`;
}

// шкала диапазона: уровень провала ← старт → цель, маркер - текущий результат
function accRange(a) {
  const pg = a.progress;
  if (!pg || pg.floor_level === null || pg.floor_level === undefined) return "";
  const init = a.initial, cur = a.initial + a.pnl;
  const lo = pg.floor_level, hi = pg.target_level ?? init + (init - lo);
  const pos = (v) => Math.max(0, Math.min(100, (100 * (v - lo)) / (hi - lo || 1)));
  const z = pos(init), m = pos(cur);
  const pct = (v) => fmtSigned((100 * (v - init)) / init, 0).replace(/^\+?0$/, "0") + "%";
  return `<div class="acc-range" title="Слева уровень провала, справа цель. Маркер - текущий результат по закрытым сделкам.">
    <div class="rg-track"><i class="rg-zone loss" style="width:${z}%"></i><i class="rg-zone gain" style="left:${z}%"></i>
      <i class="rg-fill ${cur >= init ? "pos" : "neg"}" style="left:${Math.min(z, m)}%;width:${Math.abs(m - z)}%"></i>
      <span class="rg-zero" style="left:${z}%"></span><span class="rg-mark ${cls(a.pnl)}" style="left:${m}%"></span></div>
    <div class="rg-lab"><span>провал ${pct(lo)}<br><b>${nf0.format(lo)}</b></span><span class="z" style="left:${z}%">0</span>
      <span class="r">${pg.target_level !== null ? "цель " + pct(hi) : "без цели"}<br><b>${pg.target_level !== null ? nf0.format(hi) : ""}</b></span></div></div>`;
}

function accBar(label, x, cur, hint) {
  if (!x) return "";
  const c = x.fail || x.pct > 0.8 ? "bad" : x.pct >= 0.5 ? "warn" : "use";
  return `<div class="acc-bar" title="${esc(hint)}"><div class="row"><span>${label}</span>
    <span><b>${Math.round(x.pct * 100)}%</b> · осталось ${nf0.format(x.left)} ${esc(cur)}</span></div>
    <div class="meter ${c}"><i style="width:${Math.min(100, x.pct * 100)}%"></i></div></div>`;
}

function accCard(a, stLabel) {
  const pg = a.progress, cur = a.currency || "";
  const firm = cardFirm(a);
  const sub = [programName(a, firm), phaseName(a.phase), a.login].filter(Boolean).map(esc).join(" · ");
  const hasPnl = a.pnl !== undefined && a.pnl !== null;
  const days = pg && pg.min_days ? `<span>дней ${pg.days} / ${pg.min_days}${pg.days >= pg.min_days ? ", выполнено" : ""}</span>` : "";
  const syncHint = a.sync_minutes === 0 ? "автосинхронизация выключена" : a.sync_minutes ? `автосинхронизация каждые ${a.sync_minutes} мин` : "";
  return `<section class="panel acc-card ${a.status}" data-login="${a.login}" tabindex="0" role="button">
    <header class="acc-h"><div><div class="acc-firm">${esc(firm)}</div><div class="acc-sub">${sub}</div></div>
      ${a.sync_note ? `<a class="acc-info" href="#/accounts/${a.login}" data-stop title="${esc(a.sync_note)} Нажмите, чтобы указать подключение." aria-label="Как обновляется счёт">i</a>` : ""}</header>
    <div class="acc-body">
      <div class="acc-viz">${hasPnl ? accCurve(a.spark, a.initial, pg) : ""}${hasPnl ? accRange(a) : ""}</div>
      <div class="acc-data">
        <div class="acc-nums"><div><span class="lab">Баланс</span><div class="bal">${a.balance != null ? nf2.format(a.balance) : "—"} <small>${esc(cur)}</small></div></div>
          <div class="r"><span class="lab">Результат</span><div class="pnl ${hasPnl ? cls(a.pnl) : ""}">${hasPnl ? fmtSigned(a.pnl) : "—"}${hasPnl && a.pnl_pct !== null ? ` <small>${fmtSigned(a.pnl_pct)}%</small>` : ""}</div></div></div>
        ${pg ? `<div class="acc-bars">
          ${accBar("Дневной лимит", pg.daily, cur, pg.daily ? `Сегодня использовано ${nf2.format(pg.daily.used)} из ${nf2.format(pg.daily.limit)} ${cur}` : "")}
          ${accBar("Общий лимит, макс. просадка", pg.total, cur, pg.total ? `Максимальная просадка от старта за весь челлендж: ${nf2.format(pg.total.used)} из ${nf2.format(pg.total.limit)} ${cur}. Осталось - запас от текущего баланса до уровня провала ${nf2.format(pg.floor_level)}${pg.trailing ? " (трейлинг)" : ""}.` : "")}
        </div>` : ""}
      </div>
    </div>
    <div class="acc-foot"><span class="st-dot ${a.status}">${stLabel[a.status] || a.status}</span><span title="${esc(syncHint)}">${ago(a.last_sync)}</span>${days}</div>
    <div class="acc-actions"><button class="btn sm" data-sync="${a.login}">Обновить</button><a class="btn sm" href="#/accounts/${a.login}" data-stop>Изменить</a></div>
  </section>`;
}

async function renderAccounts(editLogin) {
  const d = await api("/api/accounts");
  if (editLogin === "archive") return renderArchiveForm(null);
  if (editLogin && editLogin.startsWith("archive-")) {
    const arr = await api("/api/archive");
    return renderArchiveForm(arr.find((x) => String(x.id) === editLogin.slice(8)));
  }
  if (editLogin) return renderAccountForm(d, editLogin === "new" ? null : d.accounts.find((a) => String(a.login) === editLogin));
  const archive = await api("/api/archive");
  const f = (S.accF = S.accF || { firm: "", status: "", hideFailed: false });
  const firms = [...new Set([...d.accounts.map((a) => a.firm), ...archive.map((x) => x.firm)].filter(Boolean))];
  // итоги по всем челленджам: подключённые с целями + архивные
  const live = d.accounts.filter((a) => a.rules.kind === "prop");
  const all = [...live.map((a) => ({ status: a.status, reason: "" })), ...archive.map((x) => ({ status: x.status, reason: x.reason || "" }))];
  const passed = all.filter((x) => x.status === "passed").length, failed = all.filter((x) => x.status === "failed").length;
  const reasons = {};
  archive.filter((x) => x.status === "failed").forEach((x) => (reasons[x.reason || "Не указана"] = (reasons[x.reason || "Не указана"] || 0) + 1));
  const stLabel = { active: "Активен", passed: "Пройден", failed: "Провален", archived: "Архив" };
  const show = d.accounts.filter((a) => (!f.firm || a.firm === f.firm) && (!f.status || a.status === f.status) && !(f.hideFailed && a.status === "failed"));
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${esc(k)} ${v}`).join(", ");
  const showFilters = d.accounts.length > 2 || f.firm || f.status || f.hideFailed;
  view.innerHTML = `
    <div class="td-head"><h1>Счета</h1><a class="btn primary" href="#/accounts/new">Подключить счёт</a></div>
    <div class="acc-stats">
      <span>Челленджей: <b>${all.length}</b> ${hb("acc_summary")}</span>
      ${archive.length ? `<span>Пройдено: <b>${passed}</b></span><span>Провалено: <b>${failed}</b></span>
        <span>Доля пройденных: <b>${passed + failed ? Math.round((100 * passed) / (passed + failed)) + "%" : "—"}</b></span>
        ${topReasons ? `<span>Частые причины провала: ${topReasons}</span>` : ""}` : ""}
    </div>
    ${showFilters ? `<div class="filters">
      <select id="afFirm" style="width:auto"><option value="">Все фирмы</option>${firms.map((x) => `<option ${x === f.firm ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>
      <select id="afSt" style="width:auto"><option value="">Любой статус</option>${Object.entries(stLabel).map(([k, l]) => `<option value="${k}" ${k === f.status ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="afHide" ${f.hideFailed ? "checked" : ""}> Скрыть проваленные</label>
    </div>` : ""}
    <div class="acc-cards">${show.map((a) => accCard(a, stLabel)).join("") || '<div class="panel panel-b empty">Нет счетов по этим условиям.</div>'}</div>
    ${archive.length ? `<section class="panel" style="margin-top:20px"><div class="panel-h"><h2>Архив челленджей</h2><a class="btn sm" href="#/accounts/archive">Добавить архивный счёт</a></div>
      <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Фирма</th><th>Счёт</th><th>Размер</th><th>Этап</th><th>Платформа</th><th>Статус</th><th class="num">Результат</th><th>Период</th><th>Причина</th></tr></thead><tbody>
        ${archive.map((x) => `<tr class="click" data-arch="${x.id}"><td>${esc(x.firm || "")}</td><td>${esc(x.number || "")}</td><td>${x.size ? nf0.format(x.size) : ""}</td><td>${esc(phaseName(x.phase || ""))}</td><td>${esc(x.platform || "")}</td>
          <td><span class="st-dot ${x.status}">${stLabel[x.status] || ""}</span></td><td class="num ${cls(x.result)}">${x.result != null ? money(x.result) : ""}</td>
          <td>${esc([x.start, x.finish].filter(Boolean).map((v) => v.split("-").reverse().join(".")).join(" - "))}</td><td>${esc(x.reason || "")}</td></tr>`).join("")}</tbody></table></div></section>`
      : `<div class="acc-arch-empty"><span class="muted">Архив челленджей пуст: прошлые счета на любых платформах можно внести вручную.</span><a class="btn sm" href="#/accounts/archive">Добавить архивный счёт</a></div>`}`;
  const refresh = () => renderAccounts();
  $("#afFirm") && ($("#afFirm").onchange = (e) => { f.firm = e.target.value; refresh(); });
  $("#afSt") && ($("#afSt").onchange = (e) => { f.status = e.target.value; refresh(); });
  $("#afHide") && ($("#afHide").onchange = (e) => { f.hideFailed = e.target.checked; refresh(); });
  view.querySelectorAll(".acc-card").forEach((c) => (c.onclick = (e) => {
    if (e.target.closest("[data-sync],[data-stop]")) return;
    S.login = +c.dataset.login; localStorage.setItem("login", S.login); loadState(); location.hash = "#/goals";
  }));
  view.querySelectorAll("[data-arch]").forEach((r) => (r.onclick = () => (location.hash = `#/accounts/archive-${r.dataset.arch}`)));
  view.querySelectorAll("[data-sync]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); b.disabled = true; b.innerHTML = '<span class="spin"></span> Обновляю';
    showSyncProgress({ running: true, total: 1, done: 0, step: "подключение к терминалу" });
    try { const r = await api("/api/sync", { method: "POST", body: JSON.stringify({ account: +b.dataset.sync }) }); toast(r.message); }
    catch (err) { toast(err.message, true); }
    showSyncProgress({ running: false });
    await loadState(); quietRefresh();
  }));
}

function renderArchiveForm(x) {
  x = x || {};
  const F = [["firm", "Фирма", "text"], ["number", "Номер счёта", "text"], ["size", "Размер счёта", "number"], ["phase", "Этап", "text"],
    ["platform", "Платформа", "text"], ["result", "Итоговый результат", "number"], ["start", "Начало", "date"], ["finish", "Окончание", "date"]];
  view.innerHTML = `<div class="td-head"><div class="td-title"><a class="btn sm" href="#/accounts">‹ Счета</a><h1>${x.id ? "Архивный счёт" : "Новый архивный счёт"}</h1></div></div>
    <section class="panel" style="max-width:820px"><div class="form">
      <div class="row2">${F.map(([k, l, t]) => `<label class="f"><span>${l}</span><input type="${t}" step="any" id="ar_${k}" value="${esc(x[k] ?? "")}"></label>`).join("")}</div>
      <div class="row2"><label class="f"><span>Статус</span><select id="ar_status"><option value="failed" ${x.status === "failed" ? "selected" : ""}>Провален</option><option value="passed" ${x.status === "passed" ? "selected" : ""}>Пройден</option><option value="archived" ${x.status === "archived" ? "selected" : ""}>Закрыт без итога</option></select></label>
        <label class="f"><span>Причина провала</span><select id="ar_reason">${["", "Дневной лимит", "Общий лимит", "Срок", "Нарушение правил фирмы", "Другое"].map((r) => `<option ${r === (x.reason || "") ? "selected" : ""}>${r}</option>`).join("")}</select></label></div>
      <label class="f"><span>Заметки</span><textarea id="ar_notes" rows="3">${esc(x.notes || "")}</textarea></label>
      <div class="form-foot">${x.id ? '<button class="btn" id="arDel" style="color:var(--loss)">Удалить</button>' : "<span></span>"}<button class="btn primary" id="arSave">Сохранить</button></div></div></section>`;
  $("#arSave").onclick = async () => {
    const body = { id: x.id, status: $("#ar_status").value, reason: $("#ar_reason").value, notes: $("#ar_notes").value };
    for (const [k, , t] of F) body[k] = t === "number" ? ($("#ar_" + k).value === "" ? null : +$("#ar_" + k).value) : $("#ar_" + k).value;
    try { await api("/api/archive", { method: "POST", body: JSON.stringify(body) }); toast("Сохранено"); location.hash = "#/accounts"; } catch (e) { toast(e.message, true); }
  };
  $("#arDel")?.addEventListener("click", async () => { if (!confirm("Удалить архивный счёт?")) return; await api(`/api/archive/${x.id}`, { method: "DELETE" }); location.hash = "#/accounts"; });
}

function renderAccountForm(d, a) {
  const isNew = !a;
  const auto = !!a?.auto;
  const r = { ...d.defaults, ...(a?.rules || {}) };
  // 0 в размере счёта значит «взять первый баланс из истории»: показываем пустое поле с подсказкой, а не ноль
  const val = (k) => (k === "account_size" && !+r[k] ? "" : r[k] ?? "");
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><a class="btn sm" href="#/accounts">‹ Счета</a><h1>${isNew ? "Новый счёт" : esc(accShort(a))}</h1></div></div>
    ${auto ? `<section class="panel panel-b prose" style="margin-bottom:16px"><p><b>Счёт читается из терминала.</b> Он синхронизируется по настройкам config.json (или это счёт, открытый в терминале), поэтому пароль здесь не нужен: можно сразу задать цели.</p>
      <p>Такой счёт обновляется, только пока он открыт в терминале по умолчанию. Если у вас несколько счетов (например, Alpha Capital и Blue Guardian), <button type="button" class="btn sm" id="showConn">укажите данные подключения</button> и путь к терминалу этого счёта: тогда журнал будет обновлять каждый счёт сам, не переключая другие терминалы.</p></section>` : ""}
    <form id="accForm" class="acc-grid" autocomplete="off" ${auto ? `style="grid-template-columns:minmax(0,900px)"` : ""}>
      <section class="panel ${auto ? "hidden" : ""}" id="connBox">
        <div class="panel-h"><h2>Подключение</h2></div>
        <div class="form">
          <label class="f"><span>Название</span><input type="text" name="label" value="${esc(a?.label || "")}" placeholder="Например: Челлендж 100k"></label>
          <div class="row2">
            <label class="f"><span>Номер счёта</span><input type="number" name="login" value="${a?.login || ""}" ${isNew ? "" : "readonly"} required></label>
            <label class="f"><span>Сервер</span><input type="text" name="server" value="${esc(a?.server || "")}" placeholder="Как в окне входа MT5"></label>
          </div>
          <label class="f"><span>Пароль</span><input type="password" name="password" autocomplete="new-password" placeholder="${a?.has_password ? "Сохранён. Оставьте пустым, чтобы не менять" : "Инвесторский пароль"}"></label>
          <label class="f"><span>Путь к terminal64.exe этого счёта</span><input type="text" name="terminal_path" value="${esc(a?.terminal_path || "")}" placeholder="Например C:\\Program Files\\Blue Guardian MT5\\terminal64.exe"></label>
          <p class="muted" style="font-size:12px;margin:-6px 0 0">Где взять: правый клик по ярлыку терминала этой фирмы → «Свойства» → поле «Объект». Если оставить пустым, журнал войдёт в счёт через терминал по умолчанию и временно переключит в нём счёт.</p>
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="enabled" ${a?.enabled === 0 ? "" : "checked"}> Синхронизировать этот счёт</label>
          <p class="muted" style="font-size:12px;margin:0">Инвесторский пароль даёт доступ только на чтение. Пароль хранится в базе на этом ПК в зашифрованном виде (Windows DPAPI): прочитать его может только ваша учётная запись Windows.</p>
          <div class="form-foot"><span id="testRes" class="muted" style="font-size:13px"></span><button type="button" class="btn" id="testBtn">Проверить подключение</button></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Цели счёта</h2>
          <div class="seg" id="kindSeg"><button type="button" data-k="none">Обычный счёт</button><button type="button" data-k="prop">Проп-челлендж</button></div></div>
        <div class="form" style="padding-bottom:0">
          <div class="row2"><label class="f"><span>Фирма</span><input type="text" name="firm" value="${esc(r.firm || a?.firm || "")}" placeholder="Blue Guardian, Alpha Capital"></label>
            <label class="f"><span>Статус</span><select name="status_override">${[["auto", "Определять по целям"], ["active", "Активен"], ["passed", "Пройден"], ["failed", "Провален"], ["archived", "Архив"]].map(([k, l]) => `<option value="${k}" ${(r.status_override || "auto") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
          <label class="f"><span>Автосинхронизация этого счёта ${hb("sync")}</span><select name="sync_minutes">${[["", "Как в общих настройках"], ["0", "Выключена"], ["5", "Каждые 5 минут"], ["15", "Каждые 15 минут"], ["30", "Каждые 30 минут"], ["60", "Каждый час"], ["240", "Каждые 4 часа"]].map(([k, l]) => `<option value="${k}" ${String(a?.sync_minutes ?? "") === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>
        <div class="form" id="propBox">
          <div class="row2">
            <label class="f"><span>Шаблон</span><select id="preset"><option value="">Выбрать…</option><option value="phase1">Фаза 1: 10% / 5% / 10%</option><option value="phase2">Фаза 2: 5% / 5% / 10%</option><option value="funded">Funded: без цели, 5% / 10%</option></select></label>
            <label class="f"><span>Этап</span><input type="text" name="phase" value="${esc(val("phase"))}" placeholder="Фаза 1, Фаза 2, Funded"></label>
          </div>
          <p class="muted" style="font-size:12px;margin:0">Шаблоны - типичные значения. Правила у фирм различаются, сверьте цифры со своими условиями.</p>
          <div class="row2">${RULE_FIELDS.map(([k, l, t, h]) => `<label class="f"><span>${l}</span><input type="${t}" step="any" name="${k}" value="${esc(val(k))}" ${h ? `title="${esc(h)}" placeholder="${esc(h)}"` : ""}></label>`).join("")}</div>
          <div class="row2">
            <label class="f"><span>Дневной лимит считается от</span><select name="daily_basis"><option value="initial" ${val("daily_basis") === "initial" ? "selected" : ""}>размера счёта</option><option value="day_start" ${val("daily_basis") === "day_start" ? "selected" : ""}>баланса на начало дня</option></select></label>
            <label class="f"><span>Общий лимит</span><select name="max_loss_type"><option value="static" ${val("max_loss_type") === "static" ? "selected" : ""}>статичный, от размера счёта</option><option value="trailing" ${val("max_loss_type") === "trailing" ? "selected" : ""}>трейлинг от максимума баланса</option></select></label>
          </div>
          <label style="display:flex;gap:8px;align-items:center" id="lockRow"><input type="checkbox" name="trailing_lock" ${r.trailing_lock !== false ? "checked" : ""}> Трейлинг останавливается на уровне стартового баланса</label>
        </div>
        <div class="form-foot" style="padding:0 16px 16px">
          ${isNew || auto ? "<span></span>" : '<button type="button" class="btn" id="delBtn" style="color:var(--loss)">Удалить счёт и его данные</button>'}
          <button type="submit" class="btn primary">${isNew ? "Добавить и синхронизировать" : auto ? "Сохранить цели" : "Сохранить"}</button>
        </div>
      </section>
    </form>`;

  const form = $("#accForm");
  let rulesOnly = auto;
  $("#showConn")?.addEventListener("click", () => { rulesOnly = false; form.style.gridTemplateColumns = ""; $("#connBox").classList.remove("hidden"); $("#showConn").closest("section").classList.add("hidden"); });
  let kind = r.kind === "prop" ? "prop" : "none";
  const setKind = (k) => {
    kind = k;
    $("#kindSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
    $("#propBox").classList.toggle("hidden", k !== "prop");
  };
  setKind(kind);
  $("#kindSeg").onclick = (e) => { const b = e.target.closest("button"); if (b) setKind(b.dataset.k); };
  const lockVis = () => $("#lockRow").classList.toggle("hidden", form.elements.max_loss_type.value !== "trailing");
  form.elements.max_loss_type.onchange = lockVis; lockVis();
  $("#preset").onchange = (e) => {
    const p = d.presets[e.target.value];
    if (!p) return;
    for (const [k, v] of Object.entries(p)) if (form.elements[k] && k !== "kind") form.elements[k].value = v;
    lockVis();
  };

  const collect = () => {
    const f = form.elements;
    const rules = { kind };
    for (const [k, , t] of RULE_FIELDS) rules[k] = t === "number" ? (f[k].value === "" ? 0 : +f[k].value) : f[k].value;
    rules.phase = f.phase.value; rules.daily_basis = f.daily_basis.value; rules.max_loss_type = f.max_loss_type.value;
    rules.trailing_lock = f.trailing_lock.checked;
    rules.firm = f.firm.value; rules.status_override = f.status_override.value;
    return { label: f.label.value, login: +f.login.value, server: f.server.value, password: f.password.value,
      terminal_path: f.terminal_path.value, enabled: f.enabled.checked, rules };
  };

  $("#testBtn").onclick = async () => {
    const body = collect();
    if (!body.login) { toast("Укажите номер счёта", true); return; }
    $("#testRes").innerHTML = '<span class="spin"></span> Подключаюсь';
    try {
      const res = await api("/api/accounts/test", { method: "POST", body: JSON.stringify(body) });
      const x = res.account;
      $("#testRes").innerHTML = `<span class="pos">Подключено:</span> ${esc(x.name || "")}, ${esc(x.company || "")}, баланс ${nf2.format(x.balance)} ${esc(x.currency || "")}`;
      if (!form.elements.label.value && x.name) form.elements.label.value = x.name;
      if (!form.elements.account_size.value || form.elements.account_size.value === "0") form.elements.account_size.value = Math.round(x.balance);
    } catch (e) { $("#testRes").innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = collect();
    const sm = form.elements.sync_minutes.value;
    const saveSync = (lg) => api("/api/sync/overrides", { method: "PUT", body: JSON.stringify({ login: lg, minutes: sm === "" ? null : +sm }) });
    if (rulesOnly) {
      try {
        await saveSync(a.login);
        await api(`/api/accounts/${a.login}/rules`, { method: "PUT", body: JSON.stringify(body.rules) });
        toast("Цели сохранены");
        S.login = a.login; localStorage.setItem("login", S.login);
        await loadState();
        location.hash = "#/goals";
      } catch (err) { toast(err.message, true); }
      return;
    }
    if (!body.login) { toast("Укажите номер счёта", true); return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Сохраняю';
    try {
      const res = await api("/api/accounts", { method: "POST", body: JSON.stringify({ ...body, sync_now: true }) });
      await saveSync(body.login);
      const sres = res.sync?.accounts?.[0];
      toast(sres && sres.status === "error" ? `Счёт сохранён, но синхронизация не прошла: ${sres.message}` : "Счёт сохранён", sres?.status === "error");
      S.login = body.login; localStorage.setItem("login", S.login);
      await loadState();
      location.hash = sres?.status === "error" ? "#/accounts" : "#/goals";
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = isNew ? "Добавить и синхронизировать" : "Сохранить"; }
  };

  $("#delBtn")?.addEventListener("click", async () => {
    if (!confirm(`Удалить счёт ${a.login} вместе со всеми сделками и разборами из журнала? Это необратимо. На сам счёт у брокера это не влияет.`)) return;
    await api(`/api/accounts/${a.login}`.replace("/api/accounts/", "/api/accounts/"), { method: "DELETE" });
    toast("Счёт удалён");
    if (S.login === a.login) { S.login = null; localStorage.removeItem("login"); }
    await loadState();
    location.hash = "#/accounts";
  });
}
