/* Аналитика → Месяц: жёсткий месячный разбор поведения, задания месяца, состояние журнала.
   Разбор делается сам в начале месяца (journal/review.py); задания проверяются каждый день по сделкам. */
"use strict";

const rR = (x) => (x === null || x === undefined ? "—" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(2).replace(".", ",") + "R");

async function renderMonth(month) {
  const d = await api("/api/review/month" + (month ? "?month=" + month : ""));
  const r = d.review;
  if (!r) {
    view.innerHTML = `<div class="td-head"><h1>Месяц</h1></div>${emptyState("Месячного разбора ещё нет",
      "Журнал делает его сам в начале каждого месяца: разбор поведения, задания на месяц, проверка и чистка журнала. Можно посмотреть текущий месяц прямо сейчас.",
      '<button class="btn primary sm" id="mRun">Разобрать текущий месяц</button>')}`;
    $("#mRun").onclick = () => runMonth();
    return;
  }
  const s = r.now || {}, p = r.prev;
  const kpi = (label, v, pv, fmt, better) => {
    const diff = pv !== undefined && pv !== null && v !== null ? v - pv : null;
    const good = diff === null || diff === 0 || better === null ? "" : (diff > 0) === better ? "pos" : "neg";
    return `<div class="panel stat"><div class="k">${label}</div><div class="v">${fmt(v)}</div><div class="s ${good}">${diff === null ? "нет прошлого месяца" : (diff > 0 ? "▲ " : diff < 0 ? "▼ " : "= ") + "было " + fmt(pv)}</div></div>`;
  };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
  const prog = new Map((r.progress || []).map((t) => [t.id, t]));
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Разбор: ${esc(r.title)}</h1><span class="muted">${r.partial ? "месяц ещё идёт · " : ""}${r.trades} ${plural(r.trades, "сделка", "сделки", "сделок")}, все счета</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${d.months.length > 1 ? `<div class="seg" id="mSel">${d.months.slice(0, 6).map((m) => `<button data-m="${m}" class="${m === r.month ? "on" : ""}">${m.split("-").reverse().join(".")}</button>`).join("")}</div>` : ""}
        <button class="btn sm" id="mRun">Пересчитать текущий месяц</button></div></div>

    <section class="panel verdict-box"><div class="panel-b">
      <div class="vk">Вердикт</div>
      ${(r.verdict || []).map((l, i) => `<p class="${i ? "" : "lead"}">${esc(l)}</p>`).join("")}
    </div></section>

    <div class="m-kpis">
      ${kpi("Итог", s.sum_r ?? 0, p?.sum_r, rR, true)}
      ${kpi("Прибыльных", s.win_rate ?? null, p?.win_rate, (v) => (v === null || v === undefined ? "—" : v + "%"), true)}
      ${kpi("Нарушений ТС", pct(s.vio, s.n), p ? pct(p.vio, p.n) : null, (v) => (v === null || v === undefined ? "—" : v + "%"), false)}
      ${kpi("Разобрано", pct(s.reviewed, s.n), p ? pct(p.reviewed, p.n) : null, (v) => (v === null || v === undefined ? "—" : v + "%"), true)}
      ${kpi("Торговых дней", s.days ?? 0, p?.days, (v) => (v ?? "—"), null)}
    </div>

    <h2 class="m-h">Что тебе мешает <span class="muted">самое дорогое - первым</span></h2>
    ${(r.patterns || []).length ? `<div class="m-pats">${r.patterns.map((x) => `<section class="panel m-pat ${x.cost_r < -1 ? "bad" : x.cost_r < 0 ? "warn" : ""}">
        <div class="m-pat-h"><h3>${esc(x.title)}</h3><span class="m-cost">${x.cost_r < 0 ? rR(x.cost_r) : `${x.n} раз`}</span></div>
        <p>${esc(x.text)}</p>
        <div class="m-meta">${x.unit === "idea" ? `${x.n} ${plural(x.n, "идея", "идеи", "идей")} на двух счетах` : x.unit === "day" ? `${x.n} ${plural(x.n, "день", "дня", "дней")} · ${x.share}% торговых дней` : `${x.n} ${plural(x.n, "сделка", "сделки", "сделок")} · ${x.share}% от всех`}${x.prev_n !== null && x.prev_n !== undefined ? ` · в прошлом месяце ${x.prev_n}` : ""}</div>
        <div class="m-task"><b>Правило:</b> ${esc(x.task)}</div></section>`).join("")}</div>`
      : `<section class="panel panel-b muted">${r.trades < 5 ? "Сделок слишком мало, чтобы говорить о привычках." : "Повторяющихся ошибок поведения не найдено. Это не повод расслабляться: проверь, все ли сделки разобраны честно."}</section>`}

    ${(r.tasks || []).length ? `<h2 class="m-h">Задания на ${r.partial ? "оставшийся месяц" : "следующий месяц"} <span class="muted">журнал проверяет их сам по сделкам</span></h2>
    <section class="panel"><div class="panel-b m-tasks">${r.tasks.map((t, i) => { const g = prog.get(t.id); const n = g ? g.now : null; return `<div class="m-taskrow">
        <span class="m-num">${i + 1}</span><div><b>${esc(t.task)}</b><div class="muted" style="font-size:13px">${esc(t.title)} · было ${t.base} ${plural(t.base, "раз", "раза", "раз")}${n !== null ? ` · в этом месяце <span class="${n > t.target ? "neg" : "pos"}">${n} ${plural(n, "раз", "раза", "раз")}</span>` : ""}</div></div></div>`; }).join("")}</div></section>` : ""}

    ${(r.health || []).length ? `<h2 class="m-h">Состояние журнала</h2><section class="panel"><div class="panel-b m-health">${r.health.map((h) => `<div class="m-hrow ${h.status}"><i></i><b>${esc(h.title)}</b><span>${esc(h.text)}</span></div>`).join("")}</div></section>` : ""}
    ${(r.maintenance || []).length ? `<h2 class="m-h">Обслуживание</h2><section class="panel"><div class="panel-b"><ul class="m-maint">${r.maintenance.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="muted" style="font-size:12px;margin:8px 0 0">Удалённые файлы лежат в корзине Windows, их можно восстановить.</p></div></section>` : ""}`;
  $("#mRun").onclick = () => runMonth();
  $("#mSel")?.addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (b) renderMonth(b.dataset.m).then(() => enterView(view)); });
  if ((d.unseen || []).includes(r.month)) api("/api/review/month/seen", { method: "POST", body: JSON.stringify({ month: r.month }) }).then(loadState).catch(() => {});
}

async function runMonth() {
  const b = $("#mRun"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Разбираю';
  try { await api("/api/review/month", { method: "POST", body: JSON.stringify({}) }); } catch (e) { toast(e.message, true); }
  route();
}

/* «Сегодня»: задания месяца и их выполнение */
function tasksTile(c) {
  const t = c.tasks;
  if (!t || !(t.tasks || []).length) return "";
  return `<section class="tile m-today" aria-labelledby="tmt"><div class="tile-h"><h2 id="tmt">Задания месяца</h2><a href="#/month">Разбор</a></div>
    ${t.tasks.map((x) => `<div class="m-trow ${x.now > x.target ? "bad" : ""}"><span>${esc(x.task)}</span><b>${x.now > x.target ? `нарушено ${x.now}` : "держишь"}</b></div>`).join("")}</section>`;
}

// задание «пауза после убытка»: сколько ещё ждать
function revengeAlert(c) {
  if (!(c.tasks?.tasks || []).some((x) => x.id === "revenge" || x.id === "tilt")) return null;
  const last = (c.day?.trades || []).filter((t) => t.status === "closed" && t.login === S.login).sort((a, b) => b.close_time - a.close_time)[0];
  if (!last || last.net >= 0) return null;
  const closedAgo = Date.now() / 1000 - (last.close_time - (last.server_offset || 0));
  const left = Math.ceil((30 * 60 - closedAgo) / 60);
  return left > 0 ? ["bad", `Пауза после убытка: ещё ${left} мин.`, "Задание месяца. Вход сейчас - то же, что в прошлом месяце стоило тебе денег."] : null;
}
