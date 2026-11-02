/* Бэктест: ручные уровни -> позиция на графике и итог по минуткам из MT5 */
"use strict";

const BT_OUT = { tp: ["Тейк", "pos"], sl: ["Стоп", "neg"], open: ["Ни стоп, ни тейк", ""], missed: ["Вход не исполнен", "muted"],
  nodata: ["Нет котировок", "muted"], invalid: ["Ошибка в уровнях", "neg"] };
const btLocal = (ts) => { const x = new Date((ts + shift()) * 1000); return x.toISOString().slice(0, 16); };
const btNum = (v) => (v === "" || v === null || v === undefined ? null : parseFloat(String(v).replace(",", ".")));

async function renderBacktest(id) {
  if (id === "replay") return renderReplay();
  const d = await api("/api/backtests");
  if (id && id !== "new") return renderBacktestTrade(d, d.items.find((x) => String(x.id) === id));
  const s = d.stats;
  const edit = S.btEdit || null;
  const real = s.by_setup.some((g) => g.real);
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Бэктест</h1><span class="muted" style="font-size:13px">журнал сам проверяет по минуткам MT5, что сработало первым</span></div>
      <a class="btn primary" href="#/backtest/replay">▶ Пошаговый режим</a></div>
    <div class="bt-grid">
      <section class="panel bt-form-panel"><div class="panel-h"><h2>${edit ? "Изменить сделку" : "Новая сделка"}</h2>${edit ? '<button class="btn sm" id="btCancel">Отмена</button>' : ""}</div>
        <form class="form" id="btForm" autocomplete="off">
          <div class="row2">
            <label class="f"><span>Актив</span><input type="text" name="symbol" list="btSyms" required value="${esc(edit?.symbol || S.btLast?.symbol || "")}" placeholder="XAUUSD"></label>
            <div class="f"><span class="muted" style="font-size:13px">Направление</span><div class="seg" id="btDir"><button type="button" data-v="1">Buy</button><button type="button" data-v="-1">Sell</button></div></div>
          </div>
          <div class="row2">
            <label class="f"><span>Время входа (как на графиках)</span><input type="datetime-local" name="time" required value="${edit ? btLocal(edit.entry_time) : S.btLast?.time || ""}"></label>
            <div class="f"><span class="muted" style="font-size:13px">Тип входа</span><div class="seg" id="btType"><button type="button" data-v="market" title="Вход в указанное время по указанной цене">По рынку</button><button type="button" data-v="limit" title="Ждать, пока цена дойдёт до входа">Лимитный</button></div></div>
          </div>
          <div class="row3">
            <label class="f"><span>Вход</span><input type="text" inputmode="decimal" name="entry" required value="${edit?.entry ?? ""}"></label>
            <label class="f"><span>Стоп</span><input type="text" inputmode="decimal" name="sl" required value="${edit?.sl ?? ""}"></label>
            <label class="f"><span>Тейк</span><input type="text" inputmode="decimal" name="tp" value="${edit?.tp ?? ""}" placeholder="необязательно"></label>
          </div>
          <div class="bt-preview" id="btPrev"></div>
          <label class="f"><span>Сетап</span><input type="text" name="setup" list="btSetups" value="${esc(edit?.setup || S.btLast?.setup || "")}" placeholder="Как в плейбуке: тогда будет сравнение с реальными сделками"></label>
          <div class="row2"><div class="f"><span class="muted" style="font-size:13px">Качество сетапа</span><div class="seg grade-seg" id="btGrade">${["A", "B", "C"].map((g) => `<button type="button" data-v="${g}">${g}</button>`).join("")}</div></div>
            <label class="f"><span>Теги</span><input type="text" name="tags" value="${esc(edit?.tags || "")}" placeholder="через запятую"></label></div>
          <label class="f"><span>Заметка</span><textarea name="notes" rows="2">${esc(edit?.notes || "")}</textarea></label>
          <div class="form-foot"><span class="muted" style="font-size:12px" id="btMsg"></span><button class="btn primary" type="submit">${edit ? "Пересчитать и сохранить" : "Добавить и посчитать"}</button></div>
        </form>
        <datalist id="btSyms">${d.symbols.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
        <datalist id="btSetups">${[...new Set([...d.setups, ...(S.st.options?.setups || [])])].map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
      </section>
      <div class="bt-main">
        <section class="panel strip bt-kpi">
          <div><div class="k">Сделок</div><div class="v"><b>${s.count}</b></div><div class="s">${s.total - s.count ? `ещё ${s.total - s.count} без итога` : "все посчитаны"}</div></div>
          <div><div class="k">Прибыльных</div><div class="v"><b>${s.win_rate ?? "—"}</b>${s.win_rate !== null ? "%" : ""}</div><div class="s">${s.wins} из ${s.count}</div></div>
          <div><div class="k">Средний результат</div><div class="v ${cls(s.avg_r)}">${rfmt(s.avg_r)}</div><div class="s">матожидание на сделку</div></div>
          <div><div class="k">Сумма</div><div class="v ${cls(s.sum_r)}">${rfmt(s.sum_r)}</div><div class="s">PF ${s.pf ?? "—"}</div></div>
          <div><div class="k">Макс. просадка</div><div class="v">${s.max_dd_r ? "−" + String(s.max_dd_r).replace(".", ",") + "R" : "—"}</div><div class="s">серия убытков ${s.loss_streak}</div></div>
        </section>
        <section class="panel" style="margin-top:16px" id="btVsReal"></section>
        <section class="panel" style="margin-top:16px" id="propSim"></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Кривая в R</h2></div>
          <div class="bt-curve" id="btCurve">${s.curve.length < 2 ? '<div class="chart-note">Кривая появится после двух посчитанных сделок</div>' : ""}</div></section>
        ${s.by_setup.length ? `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>По сетапам${real ? ": бэктест и реальные сделки" : ""}</h2></div>
          <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Сетап</th><th class="num">Сделок</th><th class="num">Прибыльных</th><th class="num">Средний R</th>${real ? '<th class="num">Реал: сделок</th><th class="num">Реал: прибыльных</th><th class="num">Реал: средний R</th>' : ""}</tr></thead><tbody>
          ${s.by_setup.map((g) => `<tr><td>${esc(g.setup)}</td><td class="num">${g.count}</td><td class="num">${g.win_rate}%</td><td class="num ${cls(g.avg_r)}"><b>${rfmt(g.avg_r)}</b></td>
            ${real ? (g.real ? `<td class="num">${g.real.count}</td><td class="num">${g.real.win_rate}%</td><td class="num ${cls(g.real.avg_r)}"><b>${rfmt(g.real.avg_r)}</b></td>` : '<td class="num muted" colspan="3">нет реальных сделок</td>') : ""}</tr>`).join("")}
          </tbody></table></div></section>` : ""}
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сделки</h2><span class="muted">${d.items.length}</span></div>
          <div class="panel-b tbl-wrap">${d.items.length ? `<table class="t"><thead><tr><th>Время</th><th>Актив</th><th></th><th>Сетап</th><th class="num">Вход</th><th class="num">Стоп</th><th class="num">Тейк</th><th>Итог</th><th class="num">R</th></tr></thead><tbody>
            ${d.items.map((x) => { const r = x.result, [ol, oc] = BT_OUT[r.outcome] || ["—", ""];
              return `<tr class="click ${S.btFlash === x.id ? "bt-flash" : ""}" data-bt="${x.id}"><td>${dt(x.entry_time)}</td><td><b>${esc(x.symbol)}</b></td><td>${dirBadge(x.direction)}</td><td>${x.grade ? `<span class="grade-chip g${x.grade}">${x.grade}</span> ` : ""}${esc(x.setup || "")}${x.shots?.length ? ' <span class="muted" title="Есть скриншоты">📷</span>' : ""}</td>
                <td class="num">${x.entry}</td><td class="num">${x.sl}</td><td class="num">${x.tp ?? "—"}</td><td><span class="${oc}">${ol}</span>${r.ambiguous ? ' <span class="tag" title="Стоп и тейк задеты одной минутной свечой: засчитан стоп">?</span>' : ""}</td>
                <td class="num ${cls(r.r)}"><b>${r.r !== undefined && r.r !== null ? rfmt(r.r) : ""}</b></td></tr>`; }).join("")}
          </tbody></table>` : '<div class="empty">Добавь первую сделку слева: актив, время, вход, стоп и тейк. Журнал подтянет котировки из MT5 и нарисует позицию.</div>'}</div></section>
      </div>
    </div>`;
  S.btFlash = null;

  const form = $("#btForm");
  let dir = edit?.direction ?? S.btLast?.direction ?? 1, type = edit?.entry_type || S.btLast?.entry_type || "market", grade = edit?.grade || null;
  const drawGrade = () => $("#btGrade").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === grade));
  $("#btGrade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; grade = grade === b.dataset.v ? null : b.dataset.v; drawGrade(); };
  drawGrade();
  const segs = () => {
    $("#btDir").querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.v === dir));
    $("#btType").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === type));
    preview();
  };
  // проверка уровней и RR прямо при вводе
  const preview = () => {
    const e = btNum(form.elements.entry.value), sl = btNum(form.elements.sl.value), tp = btNum(form.elements.tp.value);
    const box = $("#btPrev");
    if (e === null || sl === null) { box.innerHTML = ""; return; }
    if ((sl - e) * dir >= 0) { box.innerHTML = `<span class="neg">Стоп для ${dir > 0 ? "Buy должен быть ниже" : "Sell должен быть выше"} входа</span>`; return; }
    if (tp !== null && (tp - e) * dir <= 0) { box.innerHTML = `<span class="neg">Тейк для ${dir > 0 ? "Buy должен быть выше" : "Sell должен быть ниже"} входа</span>`; return; }
    const risk = Math.abs(e - sl);
    box.innerHTML = `<span>Риск <b>${+risk.toPrecision(6)}</b></span>${tp !== null ? `<span>Цель <b>${+Math.abs(tp - e).toPrecision(6)}</b></span><span>RR <b class="pos">${(Math.abs(tp - e) / risk).toFixed(2).replace(".", ",")}</b></span>` : ""}`;
  };
  segs();
  $("#btDir").onclick = (e) => { const b = e.target.closest("button"); if (b) { dir = +b.dataset.v; segs(); } };
  $("#btType").onclick = (e) => { const b = e.target.closest("button"); if (b) { type = b.dataset.v; segs(); } };
  ["entry", "sl", "tp"].forEach((k) => form.elements[k].addEventListener("input", preview));
  $("#btCancel")?.addEventListener("click", () => { S.btEdit = null; renderBacktest(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements, btn = form.querySelector("[type=submit]");
    const body = { id: edit?.id, symbol: f.symbol.value, direction: dir, entry_type: type, time: f.time.value,
      entry: btNum(f.entry.value), sl: btNum(f.sl.value), tp: btNum(f.tp.value), setup: f.setup.value, notes: f.notes.value, tags: f.tags.value, grade };
    btn.disabled = true; $("#btMsg").innerHTML = '<span class="spin"></span> Считаю по минуткам';
    try {
      const r = await api("/api/backtests", { method: "POST", body: JSON.stringify(body) });
      const [ol] = BT_OUT[r.result.outcome] || [""];
      toast(`${ol}${r.result.r !== undefined ? ", " + rfmt(r.result.r) : ""}${r.result.message ? ": " + r.result.message : ""}`, ["invalid", "nodata"].includes(r.result.outcome));
      S.btLast = { symbol: body.symbol, setup: body.setup, direction: dir, entry_type: type, time: body.time };
      S.btEdit = null; S.btFlash = r.id;
      edit ? (location.hash = `#/backtest/${r.id}`) : renderBacktest();
    } catch (err) { toast(err.message, true); btn.disabled = false; $("#btMsg").textContent = ""; }
  };
  view.querySelectorAll("[data-bt]").forEach((r) => (r.onclick = () => (location.hash = `#/backtest/${r.dataset.bt}`)));

  propSim($("#propSim"), d.items);
  btVsReal($("#btVsReal"));
  if (s.curve.length >= 2) {
    const c = chartBase($("#btCurve"), { timeScale: { borderColor: css("--line"), timeVisible: false } });
    const ser = c.addBaselineSeries({ baseValue: { type: "price", price: 0 }, lineWidth: 2,
      topLineColor: css("--profit"), topFillColor1: css("--profit") + "33", topFillColor2: css("--profit") + "05",
      bottomLineColor: css("--loss"), bottomFillColor1: css("--loss") + "05", bottomFillColor2: css("--loss") + "33",
      priceFormat: { type: "custom", formatter: (v) => rfmt(Math.round(v * 100) / 100) } });
    let last = -Infinity;
    const pts = [{ time: s.curve[0].time - 3600, value: 0 }, ...s.curve].map((p) => { const t = Math.max(p.time + shift(), last + 1); last = t; return { time: t, value: p.value }; });
    ser.setData(pts);
    c.timeScale().fitContent();
    fitOnResize(c, $("#btCurve"));
  }
}

/* ---------- бэктест против реальных сделок по правилам ТС ---------- */
async function btVsReal(box) {
  let v;
  try { v = await api("/api/backtests/vs-real"); } catch (e) { box.remove(); return; }
  if (!box.isConnected) return;
  const tile = (title, x, note) => `<div><span>${title}</span><b class="${cls(x.avg_r)}">${x.avg_r !== null ? rfmt(x.avg_r) : "—"}</b><small>${x.count} ${plural(x.count, "сделка", "сделки", "сделок")}${note ? " · " + note : ""}</small></div>`;
  const gap = v.backtest.avg_r !== null && v.violated.avg_r !== null ? Math.round((v.backtest.avg_r - v.violated.avg_r) * 100) / 100 : null;
  box.innerHTML = `<div class="panel-h"><h2>Бэктест против реала по ТС</h2><span class="muted" style="font-size:12px">средний результат сделки, текущий счёт</span></div>
    <div class="panel-b">
      <div class="ps-res">${tile("Бэктест", v.backtest)}${tile("Реал по правилам", v.clean)}${tile("Реал с нарушениями", v.violated, gap !== null && gap > 0 ? `хуже бэктеста на ${String(gap).replace(".", ",")}R` : "")}</div>
      ${v.rules.length ? `<table class="t"><thead><tr><th>Где реал теряет</th><th class="num">Нарушений</th><th class="num">Средний R</th><th class="num">Итого R</th></tr></thead><tbody>
        ${v.rules.map((r) => `<tr><td>${esc(r.title)}</td><td class="num">${r.violations}</td><td class="num ${cls(r.bad_avg_r)}">${rfmt(r.bad_avg_r)}</td><td class="num ${cls(r.lost_r)}"><b>${rfmt(r.lost_r)}</b></td></tr>`).join("")}
      </tbody></table>` : '<p class="muted" style="font-size:13px;margin:0">Нарушений правил ТС в реальных сделках нет - или ТС ещё не составлена («Система → Моя ТС»).</p>'}
    </div>`;
}

/* ---------- симулятор проп-челленджа ---------- */
const PROP_SIM_PRESETS = {
  p1: ["Фаза 1: 10% / 5% / 10%", { target: 10, daily: 5, total: 10, days: 4 }],
  p1b: ["Фаза 1: 8% / 4% / 8%", { target: 8, daily: 4, total: 8, days: 3 }],
  p2: ["Фаза 2: 5% / 5% / 10%", { target: 5, daily: 5, total: 10, days: 4 }],
  funded: ["Funded: 5% / 10%, без цели", { target: 0, daily: 5, total: 10, days: 0 }],
};

// прогон серии сделок по правилам: риск фиксированный от стартового размера, дни - по дате выхода
function propRun(seq, p) {
  const init = 100, riskAmt = (init * p.risk) / 100;
  let bal = init, peak = init, dayKey = null, dayStart = init, days = new Set(), path = [init];
  for (let k = 0; k < seq.length; k++) {
    const t = seq[k];
    if (t.day !== dayKey) { dayKey = t.day; dayStart = bal; }
    bal += t.r * riskAmt;
    path.push(bal);
    days.add(t.day);
    peak = Math.max(peak, bal);
    if (p.daily && dayStart - bal >= (init * p.daily) / 100 - 1e-9) return { res: "fail", why: "дневной лимит", at: k + 1, days: days.size, bal, path };
    if (p.total && bal <= init * (1 - p.total / 100) + 1e-9) return { res: "fail", why: "общий лимит", at: k + 1, days: days.size, bal, path };
    if (p.target && bal >= init * (1 + p.target / 100) && days.size >= (p.days || 0)) return { res: "pass", at: k + 1, days: days.size, bal, path };
  }
  return { res: "open", at: seq.length, days: days.size, bal, path };
}

function propSim(box, items) {
  const done = items.filter((x) => ["tp", "sl", "open"].includes(x.result.outcome)).sort((a, b) => (a.result.exit_time || a.entry_time) - (b.result.exit_time || b.entry_time));
  const seq = done.map((x) => ({ r: x.result.r, day: new Date(((x.result.exit_time || x.entry_time) + shift()) * 1000).toISOString().slice(0, 10) }));
  const p = (S.propSim = S.propSim || { preset: "p1", risk: parseFloat(String(S.st.ts_risk || 1)) || 1, ...PROP_SIM_PRESETS.p1[1] });
  box.innerHTML = `<div class="panel-h"><h2>Симулятор проп-челленджа</h2><span class="muted" style="font-size:12px">${seq.length} ${plural(seq.length, "сделка", "сделки", "сделок")} бэктеста по порядку</span></div>
    <div class="panel-b">
      <div class="ps-form">
        <label class="f"><span>Правила</span><select id="psPreset">${Object.entries(PROP_SIM_PRESETS).map(([k, [l]]) => `<option value="${k}" ${k === p.preset ? "selected" : ""}>${l}</option>`).join("")}<option value="custom" ${p.preset === "custom" ? "selected" : ""}>Свои</option></select></label>
        ${[["risk", "Риск на сделку, %"], ["target", "Цель, %"], ["daily", "Дневной лимит, %"], ["total", "Общий лимит, %"], ["days", "Мин. дней"]].map(([k, l]) => `<label class="f"><span>${l}</span><input type="number" step="any" data-k="${k}" value="${p[k]}"></label>`).join("")}
      </div>
      <div id="psOut"></div>
    </div>`;
  const run = () => {
    const out = $("#psOut");
    if (seq.length < 3) { out.innerHTML = '<div class="empty">Нужно хотя бы 3 посчитанные сделки бэктеста.</div>'; return; }
    const one = propRun(seq, p);
    // Монте-Карло: та же серия в случайном порядке, сделки раскладываются по дням так же плотно, как в бэктесте
    const perDay = seq.length / new Set(seq.map((x) => x.day)).size;
    let pass = 0, fail = 0, daysSum = 0;
    const N = 2000;
    for (let n = 0; n < N; n++) {
      const sh = seq.map((x) => x.r).sort(() => Math.random() - 0.5).map((r, k) => ({ r, day: String(Math.floor(k / perDay)) }));
      const res = propRun(sh, p);
      if (res.res === "pass") { pass++; daysSum += res.days; } else if (res.res === "fail") fail++;
    }
    const lo = Math.min(...one.path, 100 - p.total), hi = Math.max(...one.path, 100 + (p.target || 5));
    const w = 600, h = 120, y = (v) => 6 + (h - 12) * (hi - v) / (hi - lo || 1);
    const line = one.path.map((v, k) => `${k ? "L" : "M"}${((k * w) / Math.max(1, one.path.length - 1)).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const verdict = { pass: ["Челлендж пройден", "pos"], fail: ["Челлендж провален", "neg"], open: ["Не завершён", ""] }[one.res];
    out.innerHTML = `<div class="ps-res">
        <div><span>Ваша серия по порядку</span><b class="${verdict[1]}">${verdict[0]}</b><small>${one.res === "fail" ? `${one.why}, сделка ${one.at}, день ${one.days}` : one.res === "pass" ? `на сделке ${one.at}, день ${one.days}` : `итог ${fmtSigned(one.bal - 100)}%, нужно больше сделок`}</small></div>
        <div><span>Вероятность пройти</span><b class="pos">${Math.round((100 * pass) / N)}%</b><small>${pass ? `в среднем за ${Math.round(daysSum / pass)} дн.` : "ни разу из 2000"}</small></div>
        <div><span>Вероятность провала</span><b class="neg">${Math.round((100 * fail) / N)}%</b><small>не завершено: ${Math.round((100 * (N - pass - fail)) / N)}%</small></div>
      </div>
      <svg class="ps-path" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Баланс челленджа по сделкам">
        ${p.target ? `<line x1="0" x2="${w}" y1="${y(100 + p.target)}" y2="${y(100 + p.target)}" stroke="var(--profit)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>` : ""}
        <line x1="0" x2="${w}" y1="${y(100)}" y2="${y(100)}" stroke="var(--muted)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>
        <line x1="0" x2="${w}" y1="${y(100 - p.total)}" y2="${y(100 - p.total)}" stroke="var(--loss)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Риск каждой сделки - ${String(p.risk).replace(".", ",")}% от стартового размера. Вероятность - 2000 перестановок тех же сделок в случайном порядке: показывает, насколько итог зависит от удачного порядка, а не только от средней сделки.</p>`;
    drawLines(out);
  };
  box.querySelector("#psPreset").onchange = (e) => {
    p.preset = e.target.value;
    if (PROP_SIM_PRESETS[p.preset]) Object.assign(p, PROP_SIM_PRESETS[p.preset][1]);
    box.querySelectorAll("[data-k]").forEach((inp) => (inp.value = p[inp.dataset.k]));
    run();
  };
  box.querySelectorAll("[data-k]").forEach((inp) => (inp.oninput = () => { p[inp.dataset.k] = parseFloat(inp.value) || 0; p.preset = "custom"; box.querySelector("#psPreset").value = "custom"; run(); }));
  run();
}

async function renderBacktestTrade(d, x) {
  if (!x) { view.innerHTML = emptyState("Сделка бэктеста не найдена", "Возможно, она была удалена.", '<a class="btn sm" href="#/backtest">К бэктесту</a>'); return; }
  const r = x.result, [ol, oc] = BT_OUT[r.outcome] || ["—", ""];
  const i = d.items.indexOf(x), prev = d.items[i + 1], next = d.items[i - 1];
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><a class="btn sm" href="#/backtest">‹ Бэктест</a><h1>${esc(x.symbol)}</h1>${dirBadge(x.direction)}
      <span class="tag">бэктест</span><span class="${oc}" style="font-weight:600">${ol}</span>${r.r !== undefined ? `<span class="net ${cls(r.r)}">${rfmt(r.r)}</span>` : ""}</div>
      <div class="td-nav"><button class="btn sm" id="btPrevT" ${prev ? "" : "disabled"}>Предыдущая</button><button class="btn sm" id="btNextT" ${next ? "" : "disabled"}>Следующая</button></div></div>
    <div class="td-grid">
      <section class="panel"><div class="chart-tools"><div class="seg" id="btTf"><button data-tf="">Авто</button>${TFS.map((t) => `<button data-tf="${t}">${t}</button>`).join("")}</div>
        <div class="chart-btns"><button class="btn sm" id="btReplay">▶ Воспроизвести</button><span class="muted" style="font-size:12px" id="btSrc"></span></div></div>
        <div class="trade-chart" id="btChart"></div><div class="replay-bar hidden" id="btRpBar"></div></section>
      <div>
        <section class="panel facts">
          <div><div class="k">Вход${x.entry_type === "limit" ? " (лимитный)" : ""}</div><div class="v">${x.entry}</div></div>
          <div><div class="k">${r.outcome === "open" ? "Последняя цена" : "Выход"}</div><div class="v">${r.exit_price ?? "—"}</div></div>
          <div><div class="k">Стоп</div><div class="v">${x.sl}</div></div>
          <div><div class="k">Тейк</div><div class="v">${x.tp ?? "—"}</div></div>
          <div><div class="k">Плановый RR</div><div class="v">${r.planned_rr ?? "—"}</div></div>
          <div><div class="k">Длительность</div><div class="v">${r.duration !== undefined ? dur(r.duration) : "—"}</div></div>
          <div><div class="k">Против позиции (MAE)</div><div class="v neg">${r.mae_r !== undefined ? "−" + r.mae_r.toFixed(2) + "R" : "—"}</div></div>
          <div><div class="k">В пользу (MFE)</div><div class="v pos">${r.mfe_r !== undefined ? "+" + r.mfe_r.toFixed(2) + "R" : "—"}</div></div>
          <div><div class="k">Время входа</div><div class="v">${dt(r.fill_time || x.entry_time)}</div></div>
          <div><div class="k">${r.outcome === "open" ? "Данные до" : "Время выхода"}</div><div class="v">${r.exit_time ? dt(r.exit_time) : "—"}</div></div>
          ${r.message || r.ambiguous ? `<div style="grid-column:1/-1;border-right:0"><div class="k">Примечание</div>${esc(r.message || "Стоп и тейк задеты одной минутной свечой: порядок внутри минуты неизвестен, засчитан стоп.")}</div>` : ""}
          ${x.setup || x.notes ? `<div style="grid-column:1/-1;border-right:0"><div class="k">${esc(x.setup || "Заметка")}</div>${esc(x.notes || "")}</div>` : ""}
        </section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Разбор</h2></div>
          <form class="form" id="btMeta" autocomplete="off">
            <div class="f"><span class="muted" style="font-size:13px">Качество сетапа</span><div class="seg grade-seg" id="btMetaGrade">${["A", "B", "C"].map((g) => `<button type="button" data-v="${g}" class="${x.grade === g ? "on" : ""}">${g}</button>`).join("")}</div></div>
            <label class="f"><span>Сетап</span><input type="text" name="setup" value="${esc(x.setup || "")}"></label>
            <label class="f"><span>Теги</span><input type="text" name="tags" value="${esc(x.tags || "")}" placeholder="через запятую"></label>
            <label class="f"><span>Заметка</span><textarea name="notes" rows="3">${esc(x.notes || "")}</textarea></label>
            <div class="form-foot"><span class="muted" style="font-size:12px">без пересчёта по котировкам</span><button class="btn primary" type="submit">Сохранить</button></div>
          </form></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Скриншоты</h2><span class="muted" style="font-size:12px">Ctrl+V добавляет из буфера</span></div>
          <div class="panel-b"><div class="shots" id="btShots">${(x.shots || []).map((s) => `<div class="shot" data-src="/shots/${esc(s.file)}"><img src="/shots/${esc(s.file)}" alt="Скриншот сделки бэктеста" loading="lazy"><button data-del="${s.id}" aria-label="Удалить скриншот">✕</button></div>`).join("")}</div>
            <div class="dropzone" id="btDrop" style="margin-top:${x.shots?.length ? "10px" : "0"}">Вставь скриншот (Ctrl+V) или перетащи файл. <button class="btn sm" type="button" id="btShotChart">Сохранить график</button></div></div></section>
        <div class="form-foot" style="margin-top:12px"><button class="btn" id="btDel" style="color:var(--loss)">Удалить</button><button class="btn" id="btEdit">Изменить уровни</button></div>
      </div>
    </div>`;
  // разбор без пересчёта
  let mgrade = x.grade || null;
  $("#btMetaGrade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; mgrade = mgrade === b.dataset.v ? null : b.dataset.v; $("#btMetaGrade").querySelectorAll("button").forEach((y) => y.classList.toggle("on", y.dataset.v === mgrade)); };
  $("#btMeta").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try { await api(`/api/backtests/${x.id}/meta`, { method: "PUT", body: JSON.stringify({ grade: mgrade, tags: f.tags.value, notes: f.notes.value, setup: f.setup.value }) }); toast("Разбор сохранён"); }
    catch (err) { toast(err.message, true); }
  };
  // скриншоты: тот же механизм, что у сделок, под служебным счётом 0
  const upload = async (data) => {
    try { await api(`/api/trade/0/${x.id}/shots`, { method: "POST", body: JSON.stringify({ data }) }); toast("Скриншот добавлен"); renderBacktest(String(x.id)); }
    catch (err) { toast(err.message, true); }
  };
  const fromFile = (file) => { if (!file?.type.startsWith("image/")) return; const rd = new FileReader(); rd.onload = () => upload(rd.result); rd.readAsDataURL(file); };
  document.onpaste = (e) => {
    if (!location.hash.startsWith("#/backtest/")) { document.onpaste = null; return; }
    const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (it) { e.preventDefault(); fromFile(it.getAsFile()); }
  };
  const drop = $("#btDrop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); [...e.dataTransfer.files].forEach(fromFile); };
  $("#btShotChart").onclick = () => S.btChart && upload(S.btChart.compose().toDataURL("image/png"));
  $("#btShots").onclick = async (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); if (confirm("Удалить скриншот?")) { await api(`/api/shots/${del.dataset.del}`, { method: "DELETE" }); renderBacktest(String(x.id)); } return; }
    const sh = e.target.closest(".shot");
    if (sh) { const lb = document.createElement("div"); lb.className = "lightbox"; lb.innerHTML = `<img src="${sh.dataset.src}" alt="Скриншот">`; lb.onclick = () => lb.remove(); document.body.appendChild(lb); }
  };
  $("#btPrevT").onclick = () => (location.hash = `#/backtest/${prev.id}`);
  $("#btNextT").onclick = () => (location.hash = `#/backtest/${next.id}`);
  $("#btEdit").onclick = () => { S.btEdit = x; location.hash = "#/backtest"; };
  $("#btDel").onclick = async () => { if (!confirm("Удалить сделку бэктеста?")) return; await api(`/api/backtests/${x.id}`, { method: "DELETE" }); location.hash = "#/backtest"; };
  const draw = async () => {
    killCharts();
    $("#btTf").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.tf === (S.btTf || "")));
    const el = $("#btChart");
    el.innerHTML = '<div class="chart-note"><span><span class="spin"></span> Загружаю котировки</span></div>';
    const c = await api(`/api/backtests/${x.id}/chart${S.btTf ? "?tf=" + S.btTf : ""}`);
    el.innerHTML = "";
    $("#btSrc").textContent = `${c.tf}, ${c.source === "terminal" ? "из терминала" : "из базы"}`;
    if (!c.bars.length) { el.innerHTML = '<div class="chart-note">Котировок за этот период нет. Запустите терминал MT5 и откройте сделку снова; если не помогло - добавьте инструмент в «Обзор рынка» терминала.</div>'; return; }
    S.btChart = renderTradeChart(el, c, { ...c.trade, duration: r.duration }, { levels: true, backtest: true });
  };
  $("#btReplay").onclick = () => replayControls($("#btRpBar"), S.btChart);
  $("#btTf").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; S.btTf = b.dataset.tf || null; draw(); };
  await draw();
}
