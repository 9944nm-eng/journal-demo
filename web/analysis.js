/* Анализ: инсайты, «Что если», вероятность пройти челлендж */
"use strict";

// «Преимущество»: что работает и где теряется результат. Правила ТС живут в «Дисциплине»
const AN_TABS = [["insights", "Инсайты"], ["exec", "Исполнение"], ["whatif", "Что если"], ["mc", "Прохождение челленджа"], ["market", "Статистика рынка"]];
const r2 = (v) => (v === null || v === undefined ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + "R");
const pc = (v) => (v === null || v === undefined ? "—" : String(v).replace(".", ",") + "%");

async function renderAnalysis(tab) {
  if (tab === "rules") { location.hash = "#/discipline"; return; }
  tab = AN_TABS.some(([k]) => k === tab) ? tab : "insights";
  view.innerHTML = `<div class="td-head"><h1>Преимущество</h1><span class="muted" style="font-size:13px">${periodLabel()}</span></div>
    <div class="tabs">${AN_TABS.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>
    <div id="anBody"><div class="panel panel-b empty"><span class="spin"></span> Считаю</div></div>`;
  view.querySelectorAll(".tabs [data-t]").forEach((b) => (b.onclick = () => (location.hash = `#/analysis/${b.dataset.t}`)));
  const body = $("#anBody");
  try {
    if (tab === "insights") await anInsights(body);
    else if (tab === "whatif") await anWhatif(body);
    else if (tab === "rules") await anRules(body);
    else if (tab === "exec") await anExec(body);
    else if (tab === "market") await anMarket(body);
    else await anMC(body);
  } catch (e) { body.innerHTML = `<div class="panel panel-b neg">${esc(e.message)}</div>`; }
}

/* ---------- инсайты ---------- */
function insightCard(i, compact = false) {
  const g = (x, name) => x ? `<span class="tag">${name}: ${x.n} ${plural(x.n, "сделка", "сделки", "сделок")}, прибыльных ${pc(x.win_rate)}, ср. ${r2(x.avg_r)}</span>` : "";
  return `<div class="ins ins-${i.kind}">
    <div class="ins-h"><b>${esc(i.title)}</b>${i.weak ? '<span class="tag" title="Меньше 15 сделок в одной из групп: вывод может быть случайным">выборка мала</span>' : ""}</div>
    <div class="ins-t">${esc(i.text)}</div>
    ${compact ? "" : `<div class="chips" style="margin-top:8px">${g(i.a, "группа")}${g(i.b, "остальные")}
      ${i.link ? `<button class="btn sm" data-link='${esc(JSON.stringify(i.link))}'>Показать сделки</button>` : ""}</div>
      ${(i.suggest || []).length ? `<div class="chips" style="margin-top:8px">${i.suggest.map((sg) => `<button class="btn sm primary" data-sg='${esc(JSON.stringify({ ...sg, source: i.title }))}'>+ ${sg.type === "rule" ? "Правило" : "В чек-лист"}: ${esc(sg.title)}</button>`).join("")}</div>` : ""}`}</div>`;
}
function bindInsightLinks(el) {
  el.querySelectorAll("[data-sg]").forEach((b) => (b.onclick = async () => {
    const sg = JSON.parse(b.dataset.sg);
    try {
      const r = await api("/api/rules", { method: "POST", body: JSON.stringify(sg) });
      toast(r.added === "checklist" ? "Пункт добавлен в чек-лист перед входом" : r.added === "updated" ? "Правило обновлено" : "Правило добавлено: журнал будет отмечать нарушения");
      b.disabled = true; b.textContent = "Добавлено";
      await loadState();
    } catch (e) { toast(e.message, true); }
  }));
  el.querySelectorAll("[data-link]").forEach((b) => (b.onclick = () => {
    const l = JSON.parse(b.dataset.link);
    Object.assign(S.filters, { q: "", symbol: "", direction: "", source: "", setup: "", status: "closed", day: "", session: "", plan: "" }, l);
    location.hash = "#/trades";
  }));
}

async function anInsights(body) {
  const d = await api("/api/analysis/insights?" + periodQuery());
  if (d.total < 8) { body.innerHTML = emptyState("Мало сделок для выводов", `Нужно хотя бы 8 закрытых сделок за период, сейчас ${d.total}. Выберите период длиннее вверху.`); return; }
  body.innerHTML = `
    <p class="muted" style="margin:0 0 14px;max-width:90ch;font-size:13px">${hb("an_insights")} Журнал сравнивает группы ваших сделок между собой и показывает только заметные различия: от 0,25R в среднем или от 10 п.п. по доле прибыльных. Выводы отсортированы по силе и объёму выборки. Это закономерности на истории, а не доказанные причины: проверяйте их на следующих сделках.</p>
    ${d.items.length ? `<div class="ins-list">${d.items.map((i) => insightCard(i)).join("")}</div>` : `<div class="panel panel-b empty">Заметных закономерностей за период не найдено (${d.total} ${plural(d.total, "сделка", "сделки", "сделок")}). Чем больше сделок с заполненным разбором, тем больше журнал может проверить.</div>`}
    <p class="muted" style="font-size:12px;margin-top:14px">Часть проверок работает только при заполненном разборе: сетап, состояние, оценка, «по плану» и чек-лист. Риск считается по стопу и балансу на момент входа, лимит риска задаётся в «Настройки».</p>`;
  bindInsightLinks(body);
}

/* ---------- что если ---------- */
async function anWhatif(body, tps = S.wiTp || "1; 1,5; 2; 3", hours = S.wiH || "2; 4; 8") {
  const p = periodQuery();
  const norm = (s) => s.split(/[;\s]+/).map((x) => x.replace(",", ".")).filter((x) => x && !isNaN(+x)).join(",");
  p.set("tp", norm(tps)); p.set("hours", norm(hours));
  const d = await api("/api/analysis/whatif?" + p);
  const base = d.scenarios[0];
  const best = [...d.scenarios.slice(1)].sort((a, b) => (b.sum_r ?? -1e9) - (a.sum_r ?? -1e9));
  S.wiShow = S.wiShow || new Set(["actual_0", best[0]?.id, best[1]?.id]);
  body.innerHTML = `
    <section class="panel panel-b" style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:end;justify-content:space-between">
      <div><div>Сценарии посчитаны для <b>${d.usable}</b> из ${d.with_sl} ${plural(d.with_sl, "сделки", "сделок", "сделок")} со стопом${d.total > d.with_sl ? `, без стопа ${d.total - d.with_sl}` : ""}.</div>
        ${d.missing ? `<div class="muted" style="font-size:13px">Для ${d.missing} ${plural(d.missing, "сделки", "сделок", "сделок")} нет минутных котировок в базе.</div>` : ""}</div>
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap">
        <label class="f"><span>Тейки, R (через ;)</span><input type="text" id="wiTp" value="${esc(tps)}" style="width:150px"></label>
        <label class="f"><span>Выход через, ч (через ;)</span><input type="text" id="wiH" value="${esc(hours)}" style="width:120px"></label>
        <button class="btn" id="wiRun">Пересчитать</button>
        ${d.missing ? '<button class="btn primary" id="wiPrep">Догрузить котировки</button>' : ""}</div>
    </section>
    ${d.usable ? `<div class="wi-grid">
      <section class="panel"><div class="panel-h"><h2>Сценарии управления сделкой ${hb("an_whatif")}</h2></div>
        <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th></th><th>Сценарий</th><th class="num">Итог</th><th class="num">Разница</th><th class="num">Средний</th><th class="num">Прибыльных</th><th class="num">PF</th><th class="num">Просадка</th></tr></thead><tbody>
        ${d.scenarios.map((s) => `<tr><td><input type="checkbox" data-s="${s.id}" ${S.wiShow.has(s.id) ? "checked" : ""} aria-label="Показать на графике"></td>
          <td>${s.id === "actual_0" ? "<b>" + esc(s.name) + "</b>" : esc(s.name)}</td><td class="num"><b class="${cls(s.sum_r)}">${r2(s.sum_r)}</b></td>
          <td class="num ${s.id === "actual_0" ? "" : cls(s.sum_r - base.sum_r)}">${s.id === "actual_0" ? "" : r2(s.sum_r - base.sum_r)}</td>
          <td class="num">${r2(s.avg_r)}</td><td class="num">${pc(s.win_rate)}</td><td class="num">${s.pf ?? "—"}</td><td class="num neg">${s.max_dd_r !== undefined ? "−" + String(s.max_dd_r).replace(".", ",") + "R" : "—"}</td></tr>`).join("")}
        </tbody></table></div></section>
      <section class="panel"><div class="chart-tools"><b>Накопленный результат, R</b></div><div id="wiChart" style="height:340px"></div></section>
    </div>` : emptyState("Нечего пересчитывать", "Нет сделок со стопом и минутными котировками за период. Догрузите котировки или выберите период длиннее.")}
    <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Если не открывать такие сделки</h2><span class="muted" style="font-size:12px">по фактическому результату, все ${d.total} ${plural(d.total, "сделка", "сделки", "сделок")} периода</span></div>
      <div class="panel-b tbl-wrap">${d.exclusions.length ? `<table class="t"><thead><tr><th>Группа</th><th class="num">Сделок</th><th class="num">Их итог</th><th class="num">Итог без них</th><th class="num">Разница</th><th class="num">Прибыльных без них</th></tr></thead><tbody>
        ${d.exclusions.map((e) => `<tr><td>${esc(e.name)}</td><td class="num">${e.excluded}</td><td class="num ${cls(e.excluded_net)}">${money(e.excluded_net)} <span class="muted">${r2(e.excluded_r)}</span></td>
          <td class="num">${money(e.without.net)} <span class="muted">${r2(e.without.sum_r)}</span></td><td class="num"><b class="${cls(-e.excluded_net)}">${money(-e.excluded_net)}</b></td><td class="num">${pc(e.without.win_rate)}</td></tr>`).join("")}</tbody></table>`
        : '<div class="empty">Нет групп для сравнения.</div>'}</div></section>
    <p class="muted" style="font-size:12px;max-width:100ch;margin-top:12px">Сценарии считаются по минутным свечам после входа от исходного стопа, без комиссий и свопов. Если стоп и тейк попали в одну свечу, засчитывается стоп. Сделки дольше 5 дней не моделируются. Результат «Как было» - фактический R по ценам. Разница показывает, где теряется результат: на выходах (сценарии) или на выборе сделок (таблица исключений).</p>`;

  $("#wiRun").onclick = () => { S.wiTp = $("#wiTp").value; S.wiH = $("#wiH").value; S.wiShow = null; anWhatif(body, S.wiTp, S.wiH); };
  $("#wiPrep")?.addEventListener("click", async () => {
    const b = $("#wiPrep"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Загружаю из терминала';
    try { const r = await api("/api/analysis/prepare?" + periodQuery(), { method: "POST" }); toast(`Котировки загружены для ${r.loaded} ${plural(r.loaded, "сделки", "сделок", "сделок")}`); }
    catch (e) { toast(e.message, true); }
    anWhatif(body, tps, hours);
  });
  if (!d.usable) return;
  const colors = [css("--text"), css("--accent"), css("--profit"), "#e2a85b", "#d98bd0", "#4cc7d6", css("--loss"), css("--muted")];
  const draw = () => {
    killCharts();
    const c = chartBase($("#wiChart"), { timeScale: { borderColor: css("--line"), timeVisible: false } });
    let i = 0;
    for (const s of d.scenarios) {
      if (!S.wiShow.has(s.id)) continue;
      const pts = []; let last = -Infinity;
      for (const p of s.series) { const t = p.time <= last ? last + 1 : p.time; pts.push({ time: t, value: p.value }); last = t; }
      c.addLineSeries({ color: s.id === "actual_0" ? css("--text") : colors[1 + (i++ % (colors.length - 1))], lineWidth: s.id === "actual_0" ? 3 : 2,
        priceLineVisible: false, title: s.id === "actual_0" ? "как было" : s.name.split(",")[0] }).setData(pts);
    }
    setTimeout(() => { try { c.timeScale().fitContent(); } catch (e) {} }, 50);
  };
  draw();
  body.querySelectorAll("[data-s]").forEach((cb) => (cb.onchange = () => { cb.checked ? S.wiShow.add(cb.dataset.s) : S.wiShow.delete(cb.dataset.s); draw(); }));
}

/* ---------- Монте-Карло ---------- */
async function anMC(body, params = null) {
  const p = periodQuery();
  if (params) for (const [k, v] of Object.entries(params)) p.set(k, v);
  let d;
  try { d = await api("/api/analysis/mc?" + p); }
  catch (e) { body.innerHTML = emptyState("Не удалось посчитать", esc(e.message), "", "error"); return; }
  const r = d.rules, m = d.main;
  const best = d.sweep.reduce((a, b) => (b.pass > a.pass + 0.5 || (Math.abs(b.pass - a.pass) <= 0.5 && b.risk < a.risk) ? b : a), d.sweep[0]);
  body.innerHTML = `
    <section class="panel panel-b" style="margin-bottom:16px">
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:end">
        <label class="f"><span>Риск на сделку, %</span><input type="number" step="0.05" id="mcRisk" value="${d.risk}" style="width:110px"></label>
        <label class="f"><span>Цель, %</span><input type="number" step="0.5" id="mcT" value="${r.profit_target_pct}" style="width:90px"></label>
        <label class="f"><span>Дневной лимит, %</span><input type="number" step="0.5" id="mcD" value="${r.max_daily_loss_pct}" style="width:100px"></label>
        <label class="f"><span>Общий лимит, %</span><input type="number" step="0.5" id="mcL" value="${r.max_loss_pct}" style="width:100px"></label>
        <label class="f"><span>Тип общего</span><select id="mcLT" style="width:auto"><option value="static" ${r.max_loss_type !== "trailing" ? "selected" : ""}>статичный</option><option value="trailing" ${r.max_loss_type === "trailing" ? "selected" : ""}>трейлинг</option></select></label>
        <label class="f"><span>Мин. торговых дней</span><input type="number" id="mcMin" value="${r.min_trading_days}" style="width:100px"></label>
        <label class="f"><span>Срок, торговых дней</span><input type="number" id="mcH" value="${m.horizon}" style="width:100px"></label>
        <button class="btn primary" id="mcRun">Посчитать</button>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Основа: ${d.n} ${plural(d.n, "сделка", "сделки", "сделок")} со стопом за период, прибыльных ${pc(d.win_rate)}, средний ${r2(d.avg_r)}, в среднем ${String(d.tpd_avg).replace(".", ",")} ${plural(Math.round(d.tpd_avg), "сделка", "сделки", "сделок")} в торговый день${d.current_risk ? `, ваш фактический риск около ${String(d.current_risk).replace(".", ",")}%` : ""}. Правила взяты из целей счёта, если они заданы.</p>
    </section>
    <div class="mc-kpi">
      <div class="panel"><span>Пройдёт цель</span><b class="pos">${pc(m.pass)}</b><small>${m.median_days ? `медиана ${m.median_days} ${plural(m.median_days, "торговый день", "торговых дня", "торговых дней")}` : "цель не задана или не достигается"}</small></div>
      <div class="panel"><span>Нарушит дневной лимит</span><b class="neg">${pc(m.fail_daily)}</b><small>по закрытым сделкам</small></div>
      <div class="panel"><span>Нарушит общий лимит</span><b class="neg">${pc(m.fail_total)}</b><small>просадка p90: ${String(m.maxdd_p90).replace(".", ",")}%</small></div>
      <div class="panel"><span>Не успеет за ${m.horizon} дн.</span><b>${pc(m.timeout)}</b><small>медиана итога ${m.final_p50 > 0 ? "+" : ""}${String(m.final_p50).replace(".", ",")}%</small></div>
    </div>
    <div class="grid2" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
      <section class="panel"><div class="chart-tools"><b>Результат счёта по торговым дням, % ${hb("an_mc")}</b><div class="legend"><span>полоса - 80% сценариев, линия - медиана</span></div></div>
        <div class="panel-b">${mcSVG(m.bands, r)}</div></section>
      <section class="panel"><div class="panel-h"><h2>Риск на сделку</h2></div>
        <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th class="num">Риск</th><th class="num">Пройдёт</th><th class="num">Дневной</th><th class="num">Общий</th><th class="num">Не успеет</th><th class="num">Дней</th></tr></thead><tbody>
        ${d.sweep.map((x) => `<tr class="${x.risk === best.risk ? "best" : ""}"><td class="num"><b>${String(x.risk).replace(".", ",")}%</b></td><td class="num pos">${pc(x.pass)}</td><td class="num neg">${pc(x.fail_daily)}</td><td class="num neg">${pc(x.fail_total)}</td><td class="num">${pc(x.timeout)}</td><td class="num">${x.median_days ?? "—"}</td></tr>`).join("")}
        </tbody></table>
        <p class="muted" style="font-size:12px;margin:8px 0 0">Выделен риск с наибольшей вероятностью пройти (при равной вероятности - меньший).</p></div></section>
    </div>
    <p class="muted" style="font-size:12px;max-width:100ch;margin-top:12px">Метод: 4000 раз случайно составляется будущая последовательность из ваших прошлых результатов в R и числа сделок в день. Риск - % от стартового размера счёта. Допущения: прошлое распределение сохранится, сделки независимы (серии и тильт не моделируются), просадка внутри сделки не учитывается, комиссии не учтены. Чем меньше сделок в основе, тем грубее оценка.</p>`;
  $("#mcRun").onclick = () => anMC(body, { risk: $("#mcRisk").value, profit_target_pct: $("#mcT").value, max_daily_loss_pct: $("#mcD").value,
    max_loss_pct: $("#mcL").value, max_loss_type: $("#mcLT").value, min_trading_days: $("#mcMin").value, max_days: $("#mcH").value });
}

function mcSVG(bands, r) {
  const w = 640, h = 280, padL = 44, padB = 22;
  const vals = bands.flatMap((b) => [b.p10, b.p90]).concat([r.profit_target_pct || 0, -(r.max_loss_pct || 0)]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const n = bands.length - 1 || 1;
  const x = (i) => padL + ((w - padL - 8) * i) / n, y = (v) => 8 + (h - padB - 16) * (1 - (v - lo) / span);
  const area = bands.map((b, i) => `${x(i)},${y(b.p90)}`).join(" ") + " " + [...bands].reverse().map((b, i) => `${x(n - i)},${y(b.p10)}`).join(" ");
  const med = bands.map((b, i) => `${i ? "L" : "M"}${x(i)},${y(b.p50)}`).join(" ");
  const ticks = [lo, 0, hi].concat(r.profit_target_pct ? [r.profit_target_pct] : []).concat(r.max_loss_pct ? [-r.max_loss_pct] : []);
  const line = (v, color, label) => `<line x1="${padL}" x2="${w - 8}" y1="${y(v)}" y2="${y(v)}" stroke="${color}" stroke-dasharray="5 4"/><text x="${w - 10}" y="${y(v) - 4}" text-anchor="end" fill="${color}" font-size="11">${label}</text>`;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="max-height:340px" role="img" aria-label="Диапазон результатов по сценариям">
    ${[...new Set(ticks.map((t) => Math.round(t * 10) / 10))].map((t) => `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end" fill="var(--muted)" font-size="11">${String(t).replace(".", ",")}%</text>`).join("")}
    <line x1="${padL}" x2="${w - 8}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/>
    ${r.profit_target_pct ? line(r.profit_target_pct, "var(--profit)", "цель") : ""}${r.max_loss_pct ? line(-r.max_loss_pct, "var(--loss)", "общий лимит") : ""}
    <polygon points="${area}" fill="color-mix(in srgb, var(--accent) 22%, transparent)"/>
    <path d="${med}" fill="none" stroke="var(--accent)" stroke-width="2.5"/>
    ${[0, Math.round(n / 2), n].map((i) => `<text x="${x(i)}" y="${h - 4}" text-anchor="${i === n ? "end" : i === 0 ? "start" : "middle"}" fill="var(--muted)" font-size="11">день ${i}</text>`).join("")}</svg>`;
}


/* ---------- правила системы ---------- */
async function anRules(body) {
  const d = await api("/api/rules?" + periodQuery());
  const st = S.st.sessions || [];
  const defaults = { cooldown: { minutes: 30 }, max_trades_day: { n: 2 }, stop_after_losses: { n: 2 }, max_risk: { pct: 0.5 },
    sessions_only: { sessions: st.map((x) => x.name) }, no_phone: {}, require_sl: {} };
  body.innerHTML = `
    <p class="muted" style="margin:0 0 14px;max-width:90ch;font-size:13px">${hb("an_rules")} Правила проверяются автоматически по каждой сделке. Нарушения видны в карточке сделки. Добавлять правила удобно прямо из «Инсайтов».</p>
    ${d.rules.length ? `<div class="ins-list">${d.rules.map((r) => `<div class="ins ${r.violations ? "ins-neg" : "ins-pos"}">
      <div class="ins-h"><b>${esc(r.title)}</b><button class="btn sm" data-del="${r.id}">Удалить</button></div>
      <div class="ins-t">${r.violations ? `Нарушено в ${r.violations} из ${r.total} ${plural(r.total, "сделки", "сделок", "сделок")} за период, итог этих сделок <b class="${cls(r.bad_net)}">${money(r.bad_net)}</b> (средний ${r2(r.bad_avg_r)} против ${r2(r.good_avg_r)} у остальных).
        После добавления правила: ${r.violations_since} ${plural(r.violations_since, "нарушение", "нарушения", "нарушений")}${r.violations_since ? `, ${money(r.since_net)}` : ""}.` : `Нарушений за период нет (${r.total} ${plural(r.total, "сделка", "сделки", "сделок")}).`}
        ${r.source ? `<br><span style="font-size:12px">Из инсайта: ${esc(r.source)}</span>` : ""}</div>
      ${r.recent.length ? `<div class="chips" style="margin-top:6px">${r.recent.map((t) => `<button class="btn sm" data-tid="${t.position_id}">${esc(t.symbol)} ${dt(t.open_time, false)} <span class="${cls(t.net)}">${compact(t.net)}</span></button>`).join("")}</div>` : ""}</div>`).join("")}</div>`
      : '<div class="panel panel-b empty">Правил пока нет. Добавьте их из «Инсайтов» или ниже.</div>'}
    <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Добавить правило вручную</h2></div>
      <div class="panel-b" style="display:flex;flex-wrap:wrap;gap:10px;align-items:end">
        <label class="f"><span>Правило</span><select id="rKind" style="width:auto">${Object.entries(d.kinds).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        <label class="f" id="rParamBox"><span id="rParamLbl">Значение</span><input type="text" id="rParam" style="width:220px"></label>
        <button class="btn primary" id="rAdd">Добавить</button>
      </div></section>`;
  const setParam = () => {
    const k = $("#rKind").value, p = defaults[k];
    const key = Object.keys(p)[0];
    $("#rParamBox").classList.toggle("hidden", !key);
    $("#rParamLbl").textContent = { minutes: "Пауза, минут", n: "Число", pct: "Риск, % счёта", sessions: "Сессии через запятую" }[key] || "";
    $("#rParam").value = key === "sessions" ? p.sessions.join(", ") : key ? String(p[key]).replace(".", ",") : "";
  };
  $("#rKind").onchange = setParam; setParam();
  $("#rAdd").onclick = async () => {
    const k = $("#rKind").value, key = Object.keys(defaults[k])[0], v = $("#rParam").value;
    const params = !key ? {} : key === "sessions" ? { sessions: v.split(",").map((x) => x.trim()).filter(Boolean) } : { [key]: +v.replace(",", ".") };
    try { await api("/api/rules", { method: "POST", body: JSON.stringify({ type: "rule", kind: k, params }) }); toast("Правило сохранено"); anRules(body); } catch (e) { toast(e.message, true); }
  };
  body.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { if (!confirm("Удалить правило?")) return; await api(`/api/rules/${b.dataset.del}`, { method: "DELETE" }); anRules(body); }));
  body.querySelectorAll("[data-tid]").forEach((b) => (b.onclick = () => (location.hash = `#/trade/${S.login}/${b.dataset.tid}`)));
}

/* ---------- статистика рынка ---------- */
async function anMarket(body, sym = S.mkSym) {
  const d = await api(`/api/analysis/market${sym ? "?symbol=" + encodeURIComponent(sym) : ""}`);
  S.mkSym = d.symbol;
  const opts = [...new Set([d.symbol, ...(d.symbols || [])])];
  const pr = (v) => (v === null || v === undefined ? "—" : String(+v.toFixed(v < 10 ? 5 : 2)).replace(".", ","));
  body.innerHTML = `
    <section class="panel panel-b" style="margin-bottom:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:end;justify-content:space-between">
      <div style="display:flex;gap:10px;align-items:end"><label class="f"><span>Инструмент ${hb("an_market")}</span><select id="msSym" style="width:auto">${opts.map((x) => `<option ${x === d.symbol ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label>
        <span class="muted" style="font-size:13px">${d.ready ? `${d.days} торговых дней, ${d.first.split("-").reverse().join(".")} - ${d.last.split("-").reverse().join(".")}, часовые свечи` : `в базе ${d.bars} часовых свечей, нужно больше`}</span></div>
      <button class="btn ${d.ready ? "" : "primary"}" id="msLoad">${d.ready ? "Обновить историю" : "Загрузить 2 года истории из терминала"}</button>
    </section>
    ${d.ready ? `<div class="mc-kpi">
      <div class="panel"><span>Средний диапазон Азии</span><b>${pr(d.asia_range_avg)}</b><small>медиана ${pr(d.asia_range_med)}, ${d.asia.start}:00-${d.asia.end}:00 UTC</small></div>
      <div class="panel"><span>Лондон пробил только максимум</span><b>${pc(d.break_hi)}</b><small>закрылись выше максимума Азии: ${pc(d.hold_hi)} (${d.n_hi} дн.)</small></div>
      <div class="panel"><span>Лондон пробил только минимум</span><b>${pc(d.break_lo)}</b><small>закрылись ниже минимума Азии: ${pc(d.hold_lo)} (${d.n_lo} дн.)</small></div>
      <div class="panel"><span>Обе стороны / ни одной</span><b>${pc(d.break_both)} / ${pc(d.break_none)}</b><small>Лондон ${d.london.start}:00-${d.london.end}:00 UTC</small></div>
    </div>
    <div class="grid2">
      <section class="panel"><div class="panel-h"><h2>Средний дневной диапазон по дням недели</h2></div>
        <div class="panel-b">${(() => { const mx = Math.max(...d.weekday.map((x) => x.avg)); return d.weekday.map((x) => `<div class="hbar"><div class="h"><span>${x.day} <span class="muted">${x.n} дн.</span></span><b>${pr(x.avg)}</b></div><div class="track"><i style="width:${(100 * x.avg) / mx}%"></i></div></div>`).join(""); })()}</div></section>
      <section class="panel"><div class="panel-h"><h2>Гэпы понедельника</h2></div>
        <div class="panel-b">${d.gaps.n ? `<div class="mini-list"><div class="row"><span class="muted">Понедельников с гэпом</span><b>${d.gaps.n}</b></div>
          <div class="row"><span class="muted">Средний размер гэпа</span><b>${pr(d.gaps.avg)}</b></div>
          <div class="row"><span class="muted">Закрыт в тот же день</span><b>${pc(d.gaps.filled)}</b></div></div>` : '<div class="empty">Гэпов в истории не найдено.</div>'}</div></section>
    </div>
    <p class="muted" style="font-size:12px;max-width:100ch;margin-top:12px">Часы сессий берутся из «Настройки», время сервера брокера пересчитывается в UTC. Это частоты на истории, а не сигнал: например, если Лондон пробивает максимум Азии в 45% дней, а удерживается выше него только в трети случаев, пробой сам по себе преимущества не даёт.</p>` : ""}`;
  $("#msSym").onchange = (e) => anMarket(body, e.target.value);
  $("#msLoad").onclick = async () => {
    const b = $("#msLoad"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Загружаю из терминала';
    try { const r = await api(`/api/analysis/market/load?symbol=${encodeURIComponent(d.symbol)}`, { method: "POST" }); toast(`Загружено ${r.bars} часовых свечей`); }
    catch (e) { toast(e.message, true); }
    anMarket(body, d.symbol);
  };
}


/* ---------- исполнение ---------- */
async function anExec(body) {
  const d = await api("/api/analysis/execution?" + periodQuery());
  const vcls = { "работает": "ok", "против": "bad", "не влияет": "wait", "мало данных": "wait" };
  const grpRow = (label, g) => `<td class="num">${g.n}</td><td class="num">${pc(g.win_rate)}</td><td class="num ${cls(g.avg_r)}">${r2(g.avg_r)}</td>`;
  const lvl = (arr, name) => arr.length ? `<table class="t"><thead><tr><th>${name}</th><th class="num">Сделок</th><th class="num">Прибыльных</th><th class="num">Средний</th></tr></thead><tbody>
    ${arr.map((x) => `<tr><td>${"●".repeat(x.level)}<span class="muted">${"●".repeat(5 - x.level)}</span> ${x.level}</td>${grpRow("", x)}</tr>`).join("")}</tbody></table>`
    : `<div class="empty">Отмечайте ${name.toLowerCase()} в плане до рынка (раздел «День»), и здесь появится связь с результатом.</div>`;
  const m = d.mae, lm = d.losers_mfe;
  body.innerHTML = `
    <p class="muted" style="margin:0 0 14px;max-width:90ch;font-size:13px">${hb("an_exec")} Что в вашем процессе связано с результатом. Считается по закрытым сделкам за выбранный период (${d.total}).</p>
    <section class="panel"><div class="panel-h"><h2>Какие пункты чек-листа работают</h2></div>
      <div class="panel-b tbl-wrap">${d.checklist.length ? `<table class="t"><thead><tr><th>Пункт</th><th class="num">Выполнен</th><th class="num">Прибыльных</th><th class="num">Средний</th><th class="num">Не выполнен</th><th class="num">Прибыльных</th><th class="num">Средний</th><th>Итог</th></tr></thead><tbody>
        ${d.checklist.map((c) => `<tr><td style="white-space:normal">${esc(c.item)}</td>${grpRow("", c.done)}${grpRow("", c.not_done)}<td><span class="pill ${vcls[c.verdict]}">${c.verdict}</span></td></tr>`).join("")}</tbody></table>
        <p class="muted" style="font-size:12px;margin:8px 0 0">«Работает» - сделки с выполненным пунктом лучше на 0,25R и больше (от 5 сделок в каждой группе). «Против» - наоборот: пункт стоит пересмотреть. «Не влияет» - пункт можно убрать или переформулировать.</p>`
        : '<div class="empty">Отмечайте чек-лист в карточках сделок, и здесь появится сравнение.</div>'}</div></section>
    <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сделки и план рынка недели</h2></div>
      <div class="panel-b tbl-wrap">${d.plan_align.with.n + d.plan_align.against.n + d.plan_align.neutral.n ? `<table class="t"><thead><tr><th>Группа</th><th class="num">Сделок</th><th class="num">Прибыльных</th><th class="num">Средний</th></tr></thead><tbody>
        <tr><td>По направлению плана</td>${grpRow("", d.plan_align.with)}</tr><tr><td>Против плана</td>${grpRow("", d.plan_align.against)}</tr><tr><td>План «нейтрально»</td>${grpRow("", d.plan_align.neutral)}</tr></tbody></table>
        <p class="muted" style="font-size:12px;margin:8px 0 0">Направление берётся из общего плана рынка недели («День» → «Неделя»). Если сделки против плана стабильно хуже, их стоит превратить в правило.</p>`
        : '<div class="empty">Задайте направление по инструментам в плане рынка недели («День» → «Неделя»), и здесь появится сравнение.</div>'}</div></section>
    <div class="grid2">
      <section class="panel"><div class="panel-h"><h2>Сон перед торговым днём</h2><span class="muted" style="font-size:12px">${d.sleep_n} ${plural(d.sleep_n, "сделка", "сделки", "сделок")}</span></div><div class="panel-b tbl-wrap">${lvl(d.sleep, "Сон")}</div></section>
      <section class="panel"><div class="panel-h"><h2>Энергия перед торговым днём</h2><span class="muted" style="font-size:12px">${d.energy_n} ${plural(d.energy_n, "сделка", "сделки", "сделок")}</span></div><div class="panel-b tbl-wrap">${lvl(d.energy, "Энергия")}</div></section>
    </div>
    <div class="grid2">
      <section class="panel"><div class="panel-h"><h2>Где ставить стоп: MAE прибыльных сделок</h2></div>
        <div class="panel-b">${m.n >= 8 ? `<div class="mini-list">
          <div class="row"><span class="muted">Половина прибыльных уходила против вас не дальше</span><b>${r2(-m.p50)}</b></div>
          <div class="row"><span class="muted">80% прибыльных - не дальше</span><b>${r2(-m.p80)}</b></div>
          <div class="row"><span class="muted">90% прибыльных - не дальше</span><b>${r2(-m.p90)}</b></div></div>
          <table class="t" style="margin-top:12px"><thead><tr><th>Стоп на</th><th class="num">Сохранил бы прибыльных</th></tr></thead><tbody>
          ${m.kept.map((k) => `<tr><td>${String(k.stop).replace(".", ",")}R</td><td class="num">${pc(k.share)}</td></tr>`).join("")}</tbody></table>
          <p class="muted" style="font-size:12px;margin:8px 0 0">Если 90% прибыльных сделок не уходили дальше ${String(m.p90).replace(".", ",")}R, стоп в 1R, возможно, шире нужного: более близкий стоп при том же риске в деньгах даёт больший объём. Проверьте вывод на убыточных: стоп ближе превратит часть «почти» прибыльных в убыточные. ${m.n} ${plural(m.n, "сделка", "сделки", "сделок")}.</p>`
          : `<div class="empty">Нужно хотя бы 8 прибыльных сделок со стопом и минутными котировками, сейчас ${m.n}.</div>`}</div></section>
      <section class="panel"><div class="panel-h"><h2>Убыточные сделки, которые были в плюсе</h2></div>
        <div class="panel-b">${lm.n >= 8 ? `<table class="t"><thead><tr><th>Доходили до</th><th class="num">Доля убыточных</th></tr></thead><tbody>
          ${lm.reached.map((x) => `<tr><td>+${String(x.r).replace(".", ",")}R</td><td class="num">${pc(x.share)}</td></tr>`).join("")}</tbody></table>
          <p class="muted" style="font-size:12px;margin:8px 0 0">Если заметная часть убыточных сделок сначала доходила до +1R, стоит проверить в «Что если» безубыток или частичное закрытие на 1R. ${lm.n} ${plural(lm.n, "сделка", "сделки", "сделок")}.</p>`
          : `<div class="empty">Нужно хотя бы 8 убыточных сделок со стопом, сейчас ${lm.n}.</div>`}</div></section>
    </div>`;
}
