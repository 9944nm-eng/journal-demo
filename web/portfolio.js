/* Все счета вместе и трекер привычек */
"use strict";

const PF_COLORS = ["--accent", "--profit", "--warn", "--loss", "--muted"];

async function renderPortfolio() {
  const d = await api("/api/portfolio");
  const t = d.total;
  const name = (a) => accShort(a);
  view.innerHTML = `
    <div class="td-head"><h1>Все счета</h1><span class="muted" style="font-size:13px">${d.accounts.length} ${plural(d.accounts.length, "счёт", "счёта", "счетов")}, закрытые сделки за всё время</span></div>
    <section class="panel strip pf-kpi">
      <div><div class="k">Сделок</div><div class="v">${t.count}</div><div class="s">по всем счетам</div></div>
      <div><div class="k">Результат</div><div class="v ${cls(t.net)}">${fmtSigned(t.net)}</div><div class="s">в валюте счетов</div></div>
      <div><div class="k">Сумма R</div><div class="v ${cls(t.sum_r)}">${rfmt(t.sum_r)}</div><div class="s">средний ${rfmt(t.avg_r)}</div></div>
      <div><div class="k">Прибыльных</div><div class="v">${t.win_rate ?? "—"}${t.win_rate !== null ? "%" : ""}</div><div class="s">PF ${t.pf ?? "—"}</div></div>
      <div><div class="k">Балансы</div><div class="v">${nf2.format(t.balance)}</div><div class="s">сумма по счетам</div></div>
    </section>
    <div class="pf-grid">
      <section class="panel"><div class="panel-h"><h2>Общая кривая в R</h2><div class="seg" id="pfUnit"><button data-u="r" class="${S.pfUnit !== "net" ? "on" : ""}">R</button><button data-u="net" class="${S.pfUnit === "net" ? "on" : ""}">Деньги</button></div></div>
        <div class="bt-curve" id="pfCurve">${d.curve.length < 2 ? '<div class="chart-note">Мало сделок для кривой</div>' : ""}</div></section>
      <section class="panel"><div class="panel-h"><h2>По месяцам</h2></div><div class="panel-b pf-months">
        ${d.months.map((m) => { const vals = d.accounts.map((a) => m[String(a.login)] || 0), sum = vals.reduce((x, y) => x + y, 0);
          return `<div class="pf-m"><span>${new Date(m.month + "-01T00:00:00Z").toLocaleDateString("ru-RU", { month: "short", year: "2-digit", timeZone: "UTC" })}</span>
            <div class="pf-bars">${vals.map((v, k) => `<i title="${esc(name(d.accounts[k]))}: ${fmtSigned(v)}" style="--c:var(${PF_COLORS[k % PF_COLORS.length]});width:${Math.min(100, (Math.abs(v) / Math.max(1, ...d.months.flatMap((mm) => d.accounts.map((a) => Math.abs(mm[String(a.login)] || 0))))) * 100)}%" class="${v < 0 ? "neg" : ""}"></i>`).join("")}</div>
            <b class="${cls(sum)}">${fmtSigned(sum)}</b></div>`; }).join("") || '<div class="empty">Нет закрытых сделок</div>'}</div></section>
    </div>
    <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сравнение счетов</h2></div>
      <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Счёт</th><th>Статус</th><th class="num">Баланс</th><th class="num">Результат</th><th class="num">Сделок</th><th class="num">Прибыльных</th><th class="num">PF</th><th class="num">Средний R</th><th class="num">Сумма R</th></tr></thead><tbody>
      ${d.accounts.map((a, k) => `<tr class="click" data-lg="${a.login}"><td><span class="pf-dot" style="--c:var(${PF_COLORS[k % PF_COLORS.length]})"></span><b>${esc(name(a))}</b> <span class="muted">${a.login}</span></td>
        <td>${a.rules?.kind === "prop" ? esc(phaseName(a.rules.phase) || "челлендж") : "обычный"}</td>
        <td class="num">${nf2.format(a.balance || 0)} ${esc(a.currency || "")}</td><td class="num ${cls(a.profit)}"><b>${a.profit !== undefined ? fmtSigned(a.profit) : "—"}</b>${a.profit_pct !== null && a.profit_pct !== undefined ? ` <small>${fmtSigned(a.profit_pct)}%</small>` : ""}</td>
        <td class="num">${a.count}</td><td class="num">${a.win_rate ?? "—"}${a.win_rate !== null ? "%" : ""}</td><td class="num">${a.pf ?? "—"}</td>
        <td class="num ${cls(a.avg_r)}">${rfmt(a.avg_r)}</td><td class="num ${cls(a.sum_r)}"><b>${rfmt(a.sum_r)}</b></td></tr>`).join("")}
      </tbody></table></div></section>`;
  view.querySelectorAll("[data-lg]").forEach((r) => (r.onclick = () => { S.login = +r.dataset.lg; localStorage.setItem("login", S.login); loadState(); location.hash = "#/goals"; }));
  const draw = () => {
    if (d.curve.length < 2) return;
    killCharts();
    const el = $("#pfCurve"); el.innerHTML = "";
    const c = chartBase(el, { timeScale: { borderColor: css("--line"), timeVisible: false } });
    const k = S.pfUnit === "net" ? "net" : "r";
    const s = c.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2,
      topLineColor: css("--profit"), topFillColor1: css("--profit") + "33", topFillColor2: css("--profit") + "05",
      bottomLineColor: css("--loss"), bottomFillColor1: css("--loss") + "05", bottomFillColor2: css("--loss") + "33",
      priceFormat: k === "r" ? { type: "custom", formatter: (v) => rfmt(Math.round(v * 100) / 100) } : { type: "price", precision: 2, minMove: 0.01 } });
    let last = -Infinity;
    s.setData([{ time: d.curve[0].time - 3600, [k]: 0 }, ...d.curve].map((p) => { const t = Math.max(p.time + shift(), last + 1); last = t; return { time: t, value: p[k] }; }));
    c.timeScale().fitContent(); fitOnResize(c, el);
  };
  $("#pfUnit").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.pfUnit = b.dataset.u; $("#pfUnit").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
  draw();
}

/* Аналитика → Дисциплина: правила ТС, качество сетапов, привычки */
async function renderDiscipline() {
  const [h, g] = await Promise.all([api("/api/habits"), api("/api/grades").catch(() => ({ real: {}, backtest: {} }))]);
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Дисциплина</h1><span class="muted">правила ТС ${periodLabel()}, привычки за 12 недель</span></div><a class="btn sm" href="#/ts">Моя ТС</a></div>
    <section class="panel" style="margin-bottom:16px"><div class="panel-h"><h2>Правила ТС</h2></div><div class="panel-b" id="discRules"><span class="spin"></span></div></section>
    ${gradesHTML(g)}
    <div style="margin-top:16px">${habitsHTML(h)}</div>
    <div id="discSleep"></div>`;
  sleepSection($("#discSleep"));
  await anRules($("#discRules"));
}

function habitsHTML(h) {
  const keys = ["premarket", "wrap", "reviewed", "clean"];
  const links = { premarket: "#/day", wrap: "#/day", reviewed: "#/review", clean: "#/ts" };
  return `<h2 style="margin:8px 0 14px;font-size:17px;font-weight:600">Привычки <span class="muted" style="font-size:13px;font-weight:400">серия не прерывается днём без сделок</span></h2>
    <div class="hb-cards">${keys.map((k) => { const x = h.habits[k]; return `<a class="panel hb-card" href="${links[k]}">
      <span>${esc(x.title)}</span><b>${x.streak}</b><small>${plural(x.streak, "день", "дня", "дней")} подряд · лучшая серия ${x.best} · выполнено ${x.rate ?? 0}%</small></a>`; }).join("")}</div>
    <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>По дням</h2>
      <div class="hb-legend"><span><i class="on"></i>сделано</span><span><i class="off"></i>не сделано</span><span><i></i>без сделок / выходной</span></div></div>
      <div class="panel-b hb-rows">${keys.map((k) => `<div class="hb-row"><span>${esc(h.habits[k].title)}</span><div class="hb-grid">${h.days.map((d) => {
        const v = d[k], we = d.weekday >= 5;
        return `<i class="${v === true ? "on" : v === false && !we ? "off" : ""}${we ? " we" : ""}" title="${d.date.split("-").reverse().join(".")}: ${v === true ? "сделано" : v === false ? "не сделано" : "нет сделок"}"></i>`;
      }).join("")}</div></div>`).join("")}
      <div class="hb-row"><span>Недельный разбор</span><div class="hb-weeks">${h.weeks.map((w) => `<a href="#/week/${w.week}" class="${w.done ? "on" : "off"}" title="${w.week}: ${w.done ? "сделан" : "не сделан"}">${w.week.split("-W")[1]}</a>`).join("")}</div></div>
      </div></section>`;
}
