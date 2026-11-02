/* Недельный разбор */
"use strict";

function weekShift(w, n) {
  const [y, wk] = w.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000 + (wk - 1) * 7 * 86400000 + n * 7 * 86400000);
  const t = new Date(mon.getTime() + 3 * 86400000);
  const y2 = t.getUTCFullYear(), first = new Date(Date.UTC(y2, 0, 4));
  const w2 = 1 + Math.round((t - first) / 86400000 / 7 - 3 + ((first.getUTCDay() + 6) % 7) / 7);
  return `${y2}-W${String(w2).padStart(2, "0")}`;
}

const BIAS = { long: ["Лонги", "pos"], short: ["Шорты", "neg"], neutral: ["Нейтрально", "muted"] };

async function renderWeek(week) {
  const d = await api(`/api/week${week ? "?week=" + week : ""}`);
  const s = d.summary, rec = d.record, a = rec.answers || {};
  const startD = new Date((d.start + shift()) * 1000), endD = new Date((d.end - 1 + shift()) * 1000);
  const fmtD = (x) => x.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
  let nextGoals = [...(d.next_goals || [])];
  const pn = d.plan_next || {}, pt = d.plan_this || {};
  let instr = (pn.instruments || []).map((x) => ({ ...x }));
  const symOpts = [...new Set([...(S.st.options.symbols || []), ...instr.map((x) => x.symbol)])];
  const tl = (t) => `<div class="row click" data-id="${t.position_id}" data-lg="${t.login}" style="cursor:pointer"><span><b>${esc(t.symbol)}</b> ${dirBadge(t.direction)} <span class="muted">${dt(t.open_time, false)}</span></span><b class="${cls(t.net)}">${U(t.net, t.r)}</b></div>`;
  view.innerHTML = `
    <div class="td-head">
      <div class="td-title"><button class="btn sm" id="wPrev" aria-label="Прошлая неделя">‹</button><button class="btn sm" id="wNext" aria-label="Следующая неделя">›</button>
        <h1>Неделя ${fmtD(startD)} - ${fmtD(endD)}</h1>${rec.done ? '<span class="pill ok">разбор сделан</span>' : '<span class="pill wait">разбор не сделан</span>'} ${hb("week_review")}</div>
      <span class="pill ${d.streak ? "ok" : "wait"}">Разборы: ${d.streak} ${plural(d.streak, "неделя", "недели", "недель")} подряд</span>
    </div>
    <div class="mc-kpi" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="panel"><span>Результат, все счета</span><b class="${cls(s.sum_r ?? s.net)}">${s.trades ? (S.unit === "$" || s.sum_r === null ? money(s.net) : rfmt(s.sum_r)) : "—"}</b><small>${s.trades} ${plural(s.trades, "сделка", "сделки", "сделок")}${s.trades && S.unit === "$" && s.sum_r !== null ? `, ${rfmt(s.sum_r)}` : ""}</small></div>
      <div class="panel"><span>Прибыльных</span><b>${s.win_rate ?? "—"}${s.win_rate !== null ? "%" : ""}</b><small>средний ${rfmt(s.avg_r)}</small></div>
      <div class="panel"><span>Разобрано</span><b class="${d.closed && d.reviewed === d.closed ? "pos" : ""}">${d.reviewed} / ${d.closed}</b><small>${d.closed > d.reviewed ? '<a href="#/review">разобрать подряд</a>' : "все разобраны"}</small></div>
      <div class="panel"><span>Нарушения правил</span><b class="${d.violations.length ? "neg" : "pos"}">${d.violations.length}</b><small>${d.violations.length ? "итог этих сделок " + money(d.violations.reduce((x, v) => x + v.net, 0)) : "ни одного"}</small></div>
    </div>
    ${(d.accounts || []).length > 1 ? `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>По счетам</h2></div><div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Счёт</th><th class="num">Сделок</th><th class="num">Результат</th><th class="num">В R</th><th class="num">Разобрано</th><th class="num">Нарушения</th></tr></thead><tbody>
      ${d.accounts.map((a) => `<tr><td><b>${esc(accShort(a))}</b></td><td class="num">${a.trades}</td><td class="num ${cls(a.net)}">${a.trades ? nf2.format(a.net) : "—"}</td><td class="num ${cls(a.sum_r)}">${rfmt(a.sum_r)}</td><td class="num">${a.reviewed} / ${a.trades}</td><td class="num ${a.violations ? "neg" : ""}">${a.violations}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
    <div class="day-grid" style="margin-top:16px">
      <div>
        ${pt.focus || (pt.instruments || []).length ? `<section class="panel" style="margin-bottom:16px"><div class="panel-h"><h2>План рынка на эту неделю</h2><span class="muted" style="font-size:12px">общий для всех счетов</span></div>
          <div class="panel-b">${pt.focus ? `<div style="margin-bottom:8px"><span class="muted" style="font-size:12px">Фокус</span><div><b>${esc(pt.focus)}</b></div></div>` : ""}
          <div class="mini-list">${(pt.instruments || []).map((x) => `<div><div class="row"><span><b>${esc(x.symbol)}</b> <span class="${BIAS[x.bias]?.[1] || ""}">${BIAS[x.bias]?.[0] || ""}</span></span><span class="muted" style="font-size:12px;text-align:right">${esc(x.levels || "")}</span></div>${cotLine(x.symbol, d.cot_brief, x.bias)}</div>`).join("")}</div></div></section>` : ""}
        <div class="grid2" style="margin-top:0">
          <section class="panel"><div class="panel-h"><h2>Лучшие сделки</h2></div><div class="panel-b mini-list">${d.best.map(tl).join("") || '<div class="empty">Сделок нет</div>'}</div></section>
          <section class="panel"><div class="panel-h"><h2>Худшие сделки</h2></div><div class="panel-b mini-list">${d.worst.map(tl).join("") || '<div class="empty">Сделок нет</div>'}</div></section>
        </div>
        ${d.violations.length ? `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Нарушения</h2></div><div class="panel-b mini-list">${d.violations.map((v) => `<div class="row click" data-id="${v.position_id}" data-lg="${v.login}" style="cursor:pointer"><span><b>${esc(v.symbol)}</b> ${v.rules.map((r) => `<span class="violation">${esc(r)}</span>`).join("")}</span><b class="${cls(v.net)}">${money(v.net)}</b></div>`).join("")}</div></section>` : ""}
        ${d.insights.length ? `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Выводы за последний месяц</h2><a class="btn sm" href="#/analysis/insights">Все</a></div><div class="panel-b"><div class="ins-list">${d.insights.map((i) => insightCard(i, true)).join("")}</div></div></section>` : ""}
        <div class="grid2">
          <section class="panel"><div class="panel-h"><h2>COT за неделю</h2><a class="btn sm" href="#/cot">Разбор</a></div><div class="panel-b mini-list">${Object.values(d.cot_brief || {}).map((c) => `<div><div class="row"><b>${esc(c.symbol)}</b><span class="${c.bg > 0 ? "pos" : c.bg < 0 ? "neg" : "muted"}">${{ 1: "фон за рост", "-1": "фон за снижение", 0: "нет фона" }[c.bg]}</span></div><div class="muted" style="font-size:12px">${esc(c.headline)}</div></div>`).join("") || '<div class="empty">Нет данных</div>'}</div></section>
          <section class="panel"><div class="panel-h"><h2>Макро за неделю</h2></div><div class="panel-b mini-list">${d.macro.map((m) => `<div class="row"><span>${esc(m.name)}</span><span><b>${fmtVal(m.value, m.unit)}</b> <span class="${cls(m.chg_w)}">${fmtChg(m.chg_w)}</span></span></div>`).join("") || '<div class="empty">Нет данных</div>'}</div></section>
        </div>
      </div>
      <div>
        ${d.goals_eval.length ? `<section class="panel"><div class="panel-h"><h2>Цели процесса этой недели</h2></div><div class="panel-b objectives">${d.goals_eval.map((g) => `<div class="obj-h"><span>${esc(g.title)}</span><span class="pill ${g.ok ? "ok" : "bad"}">${g.ok ? "выполнено" : "не выполнено"}</span></div><div class="obj-t muted" style="margin-top:-10px">${esc(g.text)}</div>`).join("")}</div></section>` : ""}
        <section class="panel" style="margin-top:${d.goals_eval.length ? "16px" : "0"}"><div class="panel-h"><h2>Итоги недели</h2><span class="pill wait">общие для всех счетов</span></div>
          <div class="form">
            <label class="f"><span>Что сработало</span><textarea id="wa_worked" rows="3">${esc(a.worked || "")}</textarea></label>
            <label class="f"><span>Какие ошибки повторились</span><textarea id="wa_repeat" rows="3">${esc(a.repeat || "")}</textarea></label>
          </div></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>План рынка на следующую неделю</h2><span class="pill wait" title="Виден на любом счёте в разделе «День» и в карточках сделок">общий для всех счетов</span></div>
          <div class="form">
            <label class="f"><span>Фокус недели</span><textarea id="pl_focus" rows="2" placeholder="Например: только лучший сетап по золоту, не больше 2 сделок в день">${esc(pn.focus || a.focus || "")}</textarea></label>
            <div class="f"><span class="muted" style="font-size:13px">Инструменты</span><div id="plList" class="plan-list"></div>
              <button type="button" class="btn sm" id="plAdd" style="align-self:flex-start;margin-top:6px">Добавить инструмент</button></div>
            <label class="f"><span>Общие заметки по рынку</span><textarea id="pl_notes" rows="3" placeholder="Новости недели, макро, что важно помнить">${esc(pn.notes || a.levels || "")}</textarea></label>
            <datalist id="dlSym">${symOpts.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
          </div></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Цели процесса на следующую неделю</h2></div>
          <div class="panel-b"><div class="list-edit" id="ngList"></div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><select id="ngKind" style="width:auto">${Object.entries(d.goal_kinds).map(([k, l]) => `<option value="${k}">${l.replace("{n}", "N").replace("{pct}", "X")}</option>`).join("")}</select>
              <button class="btn sm" id="ngAdd">Добавить цель</button></div>
            <p class="muted" style="font-size:12px;margin:8px 0 0">Цели процесса - про действия, а не про деньги. Журнал проверит их сам в конце недели.</p></div></section>
        <div class="form-foot" style="margin-top:12px"><button class="btn" id="wSave">Сохранить</button><button class="btn primary" id="wDone">${rec.done ? "Сохранить разбор" : "Разбор сделан"}</button></div>
      </div>
    </div>`;
  const drawPl = () => {
    $("#plList").innerHTML = instr.map((x, i) => `<div class="plan-item">
      <div class="row" style="gap:8px"><input type="text" list="dlSym" data-i="${i}" data-k="symbol" value="${esc(x.symbol)}" placeholder="XAUUSD" style="width:140px">
        <div class="seg" data-i="${i}">${Object.entries(BIAS).map(([k, [l]]) => `<button type="button" data-b="${k}" class="${x.bias === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <button type="button" class="btn sm" data-del="${i}" aria-label="Убрать" style="margin-left:auto">✕</button></div>
      <div class="cot-slot" data-i="${i}">${cotLine(x.symbol, d.cot_brief, x.bias)}</div>
      <input type="text" data-i="${i}" data-k="levels" value="${esc(x.levels || "")}" placeholder="Ключевые уровни: 4050 поддержка, 4120 сопротивление">
      <textarea data-i="${i}" data-k="scenario" rows="2" placeholder="Сценарий: что жду и при каком условии вхожу">${esc(x.scenario || "")}</textarea></div>`).join("") || '<div class="muted" style="font-size:13px">Добавьте инструменты, по которым планируете торговать.</div>';
    $("#plList").querySelectorAll("[data-k]").forEach((el) => (el.oninput = () => {
      const i = +el.dataset.i;
      instr[i][el.dataset.k] = el.value;
      if (el.dataset.k === "symbol") $(`#plList .cot-slot[data-i="${i}"]`).innerHTML = cotLine(el.value, d.cot_brief, instr[i].bias);
    }));
    $("#plList").querySelectorAll(".seg").forEach((sg) => (sg.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; instr[+sg.dataset.i].bias = b.dataset.b; drawPl(); }));
    $("#plList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { instr.splice(+b.dataset.del, 1); drawPl(); }));
  };
  drawPl();
  $("#plAdd").onclick = () => { instr.push({ symbol: "", bias: "neutral", levels: "", scenario: "" }); drawPl(); };


  const drawNg = () => {
    $("#ngList").innerHTML = nextGoals.length ? nextGoals.map((g, i) => {
      const p = g.params || {};
      const inp = g.kind.includes("max_trades") ? `<input type="number" data-i="${i}" data-k="n" value="${p.n ?? 2}" style="width:80px">` : g.kind === "max_risk" ? `<input type="number" step="0.05" data-i="${i}" data-k="pct" value="${p.pct ?? 0.5}" style="width:80px">` : "";
      return `<div class="row" style="align-items:center"><span style="flex:1">${esc(d.goal_kinds[g.kind].replace("{n}", "N").replace("{pct}", "X"))}</span>${inp}<button class="btn sm" data-del="${i}" aria-label="Удалить">✕</button></div>`;
    }).join("") : '<div class="muted" style="font-size:13px">Целей пока нет.</div>';
    $("#ngList").querySelectorAll("input").forEach((x) => (x.oninput = () => { nextGoals[+x.dataset.i].params = { ...(nextGoals[+x.dataset.i].params || {}), [x.dataset.k]: +x.value }; }));
    $("#ngList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { nextGoals.splice(+b.dataset.del, 1); drawNg(); }));
  };
  drawNg();
  $("#ngAdd").onclick = () => { const k = $("#ngKind").value; if (nextGoals.some((g) => g.kind === k)) return; nextGoals.push({ kind: k, params: k.includes("max_trades") ? { n: k === "max_trades_week" ? 10 : 2 } : k === "max_risk" ? { pct: 0.5 } : {} }); drawNg(); };
  const save = async (done) => {
    const answers = { ...a, worked: $("#wa_worked").value, repeat: $("#wa_repeat").value };
    delete answers.focus; delete answers.levels;
    try {
      await api(`/api/plan/${d.next_week}`, { method: "PUT", body: JSON.stringify({ focus: $("#pl_focus").value, notes: $("#pl_notes").value, instruments: instr }) });
      await api(`/api/week/${d.week}`, { method: "PUT", body: JSON.stringify({ answers, done: done ?? rec.done, next_week: d.next_week, next_goals: nextGoals }) });
      toast(done ? "Недельный разбор сделан" : "Сохранено");
      await loadState(); renderWeek(d.week);
    } catch (e) { toast(e.message, true); }
  };
  $("#wSave").onclick = () => save(null);
  $("#wDone").onclick = () => save(true);
  $("#wPrev").onclick = () => (location.hash = `#/week/${weekShift(d.week, -1)}`);
  $("#wNext").onclick = () => (location.hash = `#/week/${weekShift(d.week, 1)}`);
  view.querySelectorAll("[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#/trade/${r.dataset.lg || S.login}/${r.dataset.id}`)));
}


async function renderWeekAll(week) {
  const d = await api(`/api/week/all${week ? "?week=" + week : ""}`);
  const tot = d.accounts.reduce((x, a) => ({ trades: x.trades + a.trades, vio: x.vio + a.violations, rev: x.rev + a.reviewed }), { trades: 0, vio: 0, rev: 0 });
  view.innerHTML = `
    <div class="tabs"><button id="wOne">Этот счёт</button><button class="on">Все счета</button></div>
    <div class="td-head"><div class="td-title"><button class="btn sm" id="wPrev" aria-label="Прошлая неделя">‹</button><button class="btn sm" id="wNext" aria-label="Следующая неделя">›</button>
      <h1>Все счета: неделя ${esc(d.week.split("-W")[1])}</h1></div></div>
    <div class="mc-kpi" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="panel"><span>Сделок на всех счетах</span><b>${tot.trades}</b><small>разобрано ${tot.rev}</small></div>
      <div class="panel"><span>Нарушения правил</span><b class="${tot.vio ? "neg" : "pos"}">${tot.vio}</b><small>по всем счетам</small></div>
      <div class="panel"><span>Счетов с разбором недели</span><b>${d.accounts.filter((a) => a.done).length} / ${d.accounts.length}</b><small>итоги пишутся по каждому счёту</small></div>
    </div>
    <section class="panel" style="margin-top:16px"><div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Счёт</th><th class="num">Сделок</th><th class="num">Результат</th><th class="num">В R</th><th class="num">Прибыльных</th><th class="num">Разобрано</th><th class="num">Нарушения</th><th>Разбор</th></tr></thead><tbody>
      ${d.accounts.map((a) => `<tr class="click" data-login="${a.login}"><td><b>${esc(accShort(a))}</b> <span class="muted">${a.login}</span></td><td class="num">${a.trades}</td>
        <td class="num ${cls(a.net)}"><b>${a.trades ? nf2.format(a.net) + " " + esc(a.currency || "") : "—"}</b></td><td class="num ${cls(a.sum_r)}">${rfmt(a.sum_r)}</td>
        <td class="num">${a.win_rate === null ? "—" : String(a.win_rate).replace(".", ",") + "%"}</td><td class="num">${a.reviewed} / ${a.trades}</td>
        <td class="num ${a.violations ? "neg" : ""}">${a.violations}</td><td>${a.done ? '<span class="pill ok">сделан</span>' : '<span class="pill wait">нет</span>'}</td></tr>`).join("")}</tbody></table>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Результат по каждому счёту в его валюте: суммировать деньги разных счетов некорректно, поэтому сравнивайте в R. Клик по строке открывает разбор недели этого счёта.</p></div></section>`;
  $("#wOne").onclick = () => { S.weekTab = "one"; renderWeek(d.week); };
  $("#wPrev").onclick = () => { location.hash = `#/week/${weekShift(d.week, -1)}`; };
  $("#wNext").onclick = () => { location.hash = `#/week/${weekShift(d.week, 1)}`; };
  view.querySelectorAll("[data-login]").forEach((r) => (r.onclick = () => { S.login = +r.dataset.login; localStorage.setItem("login", S.login); S.weekTab = "one"; loadState(); renderWeek(d.week); }));
}
