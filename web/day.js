/* Распорядок дня и лента дней */
"use strict";

const MOODS = ["Плохо", "Ниже обычного", "Нормально", "Хорошо", "Отлично"];
const todayStr = () => new Date(Date.now() + shift() * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayTitle = (d) => new Date(d + "T00:00:00Z").toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).replace(/^./, (c) => c.toUpperCase());

function sparkSVG(points, w = 220, h = 54) {
  if (!points.length) return `<svg width="${w}" height="${h}" aria-hidden="true"><line x1="0" x2="${w}" y1="${h / 2}" y2="${h / 2}" stroke="var(--line)" stroke-dasharray="3 3"/></svg>`;
  const vals = [0, ...points.map((p) => p.value)];
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const xs = (i) => 4 + ((w - 8) * i) / Math.max(1, vals.length - 1);
  const ys = (v) => 4 + (h - 8) * (1 - (v - lo) / span);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1], color = last >= 0 ? "var(--profit)" : "var(--loss)";
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="${w}" y1="${ys(0).toFixed(1)}" y2="${ys(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${xs(vals.length - 1).toFixed(1)}" cy="${ys(last).toFixed(1)}" r="3" fill="${color}"/></svg>`;
}

/* ---------- распорядок дня ---------- */
async function renderDay(d) {
  d = d || todayStr();
  const [x, days, streak, wf] = await Promise.all([api(`/api/day?date=${d}`), api("/api/days"), api("/api/streaks"), api("/api/week/focus").catch(() => null)]);
  const pre = x.premarket || {}, wrap = x.wrap || {};
  const preChecks = x.checklist_items.filter((c) => (pre.checks || {})[c]).length;
  const preDone = pre.mood != null && preChecks === x.checklist_items.length;
  const tradeDone = x.count > 0 && x.reviewed === x.count;
  const steps = [
    ["План до рынка", `${preChecks} из ${x.checklist_items.length} пунктов${pre.mood != null ? ", состояние отмечено" : ""}`, preDone, pre.mood != null || preChecks > 0],
    ["Сделки", x.count ? `${x.count} ${plural(x.count, "сделка", "сделки", "сделок")}, ${x.closed} закрыто` : "сделок нет", x.count > 0, x.count > 0],
    ["Разбор сделок", x.count ? `разобрано ${x.reviewed} из ${x.count}` : "нечего разбирать", tradeDone || (!x.count && x.signed_off), x.reviewed > 0],
    ["Итог дня", x.signed_off ? "день закрыт" : "не закрыт", x.signed_off, !!(wrap.good || wrap.improve)],
  ];
  const dmap = new Map(days.map((v) => [v.date, v]));

  view.innerHTML = `
    <div class="td-head">
      <div class="td-title"><button class="btn sm" id="dPrev" aria-label="Предыдущий день">‹</button><button class="btn sm" id="dNext" aria-label="Следующий день">›</button>
        <h1>${dayTitle(d)}</h1>${d === todayStr() ? '<span class="tag">сегодня</span>' : `<button class="btn sm" id="dToday">Сегодня</button>`}</div>
      <div style="display:flex;gap:8px"><span class="pill ${streak.journal ? "ok" : "wait"}" title="Торговых дней подряд с полным разбором или закрытым днём">Разбор: ${streak.journal} ${plural(streak.journal, "день", "дня", "дней")} подряд</span>
        <span class="pill ${streak.discipline ? "ok" : "wait"}" title="Торговых дней подряд, когда все сделки отмечены «по плану»">Дисциплина: ${streak.discipline} ${plural(streak.discipline, "день", "дня", "дней")}</span></div>
    </div>
    ${wf && (wf.focus || wf.goals.length || (wf.plan?.instruments || []).length) ? `<section class="panel panel-b focus-bar"><div><span class="muted" style="font-size:12px">Фокус недели, общий для всех счетов</span><div><b>${esc(wf.focus || "не задан")}</b></div>
        ${(wf.plan?.instruments || []).length ? `<div class="chips" style="margin-top:6px">${wf.plan.instruments.map((x) => `<span class="tag ${x.bias === "long" ? "pos" : x.bias === "short" ? "neg" : ""}" title="${esc([x.levels, x.scenario].filter(Boolean).join(". "))}">${esc(x.symbol)}: ${{ long: "лонги", short: "шорты", neutral: "нейтрально" }[x.bias] || ""}</span>`).join("")}</div>` : ""}</div>
      <div class="chips">${wf.goals.map((g) => `<span class="pill ${g.ok ? "ok" : "bad"}" title="${esc(g.text)}">${g.ok ? "✓" : "✗"} ${esc(g.title)}</span>`).join("")}</div><a class="btn sm" href="#/week">Неделя</a></section>` : ""}
    <div class="flow">${steps.map(([t, s, done, started], i) => `<div class="step ${done ? "done" : started ? "started" : ""}">
      <div class="num">${done ? "✓" : i + 1}</div><div><b>${t}</b><div class="muted" style="font-size:12px">${s}</div></div></div>`).join("")}</div>

    <div class="day-grid">
      <div>
        <section class="panel"><div class="panel-h"><h2>План до рынка</h2><span class="muted" style="font-size:12px">общий для всех счетов</span></div>
          <div class="form" id="preForm">
            <div class="f"><span class="muted" style="font-size:13px">Состояние</span><div class="seg" id="mood">${MOODS.map((m, i) => `<button type="button" data-v="${i + 1}" class="${pre.mood === i + 1 ? "on" : ""}">${m}</button>`).join("")}</div></div>
            <div class="row2"><div class="f"><span class="muted" style="font-size:13px">Сон</span><div class="seg" id="sleep">${[1, 2, 3, 4, 5].map((v) => `<button type="button" data-v="${v}" class="${pre.sleep === v ? "on" : ""}">${v}</button>`).join("")}</div></div>
              <div class="f"><span class="muted" style="font-size:13px">Энергия</span><div class="seg" id="energy">${[1, 2, 3, 4, 5].map((v) => `<button type="button" data-v="${v}" class="${pre.energy === v ? "on" : ""}">${v}</button>`).join("")}</div></div></div>
            <div class="checks">${x.checklist_items.map((c, i) => `<label><input type="checkbox" data-i="${i}" ${(pre.checks || {})[c] ? "checked" : ""}> ${esc(c)}</label>`).join("")}</div>
            <label class="f"><span>Ключевые уровни и сценарии</span><textarea name="levels" rows="3" placeholder="XAUUSD: 4050 поддержка, при пробое...">${esc(pre.levels || "")}</textarea></label>
            <label class="f"><span>План на день</span><textarea name="plan" rows="2" placeholder="Что торгую, что не торгую, максимум сделок и риск">${esc(pre.plan || "")}</textarea></label>
            <div class="form-foot"><a class="muted" style="font-size:12px" href="#/settings">изменить пункты</a><button type="button" class="btn primary sm" id="preSave">Сохранить план</button></div>
          </div></section>

        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сделки дня</h2>${x.count > x.reviewed ? `<a class="btn sm" href="#/review">Разобрать подряд</a>` : ""}</div>
          <div class="panel-b">${x.trades.length ? `<div class="rows">${x.trades.map((t) => tradeLine(t)).join("")}</div>`
            : '<div class="empty">В этот день сделок нет.</div>'}</div></section>

        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Итог дня</h2></div>
          <div class="form" id="wrapForm">
            <label class="f"><span>Что получилось</span><textarea name="good" rows="2">${esc(wrap.good || "")}</textarea></label>
            <label class="f"><span>Что улучшить завтра</span><textarea name="improve" rows="2">${esc(wrap.improve || "")}</textarea></label>
            <div class="row2"><div class="f"><span class="muted" style="font-size:13px">Оценка дня</span><div class="grade" id="dGrade">${[1, 2, 3, 4, 5].map((g) => `<button type="button" data-g="${g}" class="${wrap.grade === g ? "on" : ""}">${g}</button>`).join("")}</div></div>
              <div class="f"><span class="muted" style="font-size:13px">Правила соблюдены</span><div class="seg" id="dRules"><button type="button" data-v="1" class="${wrap.rules === 1 ? "on" : ""}">Да</button><button type="button" data-v="0" class="${wrap.rules === 0 ? "on" : ""}">Нет</button></div></div></div>
            <div class="form-foot"><button type="button" class="btn sm" id="wrapSave">Сохранить</button>
              <button type="button" class="btn primary sm" id="signOff">${x.signed_off ? "Открыть день снова" : "Закрыть день"}</button></div>
          </div></section>
      </div>

      <div>
        <section class="panel"><div class="panel-h"><h2 id="mTitle"></h2><div class="seg"><button id="mPrev" aria-label="Предыдущий месяц">‹</button><button id="mNext" aria-label="Следующий месяц">›</button></div></div>
          <div class="panel-b"><div class="cal mini" id="mCal"></div>
          <div class="legend" style="margin-top:8px"><span>фон - результат дня</span><span>точка - день закрыт</span></div></div></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Результат дня</h2></div>
          <div class="panel-b"><div class="mini-list">
            <div class="row"><span class="muted">Итог</span><b class="${cls(x.net)}">${money(x.net)}</b></div>
            <div class="row"><span class="muted">Сделок</span><b>${x.count}</b></div>
            <div class="row"><span class="muted">Прибыльных</span><b>${x.closed ? Math.round((100 * x.wins) / x.closed) + "%" : "—"}</b></div>
            <div class="row"><span class="muted">В R по всем счетам</span><b class="${cls(x.r)}">${rfmt(x.r)}</b></div>
            ${(x.accounts || []).map((a) => `<div class="row"><span class="muted">${esc(accShort(a))}</span><span><b class="${cls(a.net)}">${money(a.net)}</b> <span class="muted">${rfmt(a.r)}</span></span></div>`).join("")}</div>
            <div style="margin-top:12px">${sparkSVG(x.curve, 320, 90)}</div></div></section>
        <section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Заметка к дню</h2><a class="btn sm" href="#/notes">Все заметки</a></div>
          <div class="form"><textarea id="dayNote" rows="3" placeholder="Наблюдение по рынку, мысль на будущее"></textarea>
            <div class="form-foot"><span></span><button class="btn sm" id="dayNoteSave">Добавить в заметки</button></div></div></section>
      </div>
    </div>`;

  // навигация
  $("#dPrev").onclick = () => (location.hash = `#/day/${addDays(d, -1)}`);
  $("#dNext").onclick = () => (location.hash = `#/day/${addDays(d, 1)}`);
  $("#dToday")?.addEventListener("click", () => (location.hash = "#/day"));
  view.querySelectorAll("[data-id]").forEach((r) => (r.onclick = () => (location.hash = `#/trade/${r.dataset.lg || S.login}/${r.dataset.id}`)));

  // мини-календарь
  let m = new Date(d.slice(0, 8) + "01T00:00:00Z");
  const drawM = () => {
    const y = m.getUTCFullYear(), mo = m.getUTCMonth();
    $("#mTitle").textContent = m.toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).replace(/^./, (c) => c.toUpperCase());
    const first = (new Date(Date.UTC(y, mo, 1)).getUTCDay() + 6) % 7, n = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    let h = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((w) => `<div class="dow">${w}</div>`).join("");
    for (let i = 0; i < first; i++) h += '<div class="d out"></div>';
    for (let i = 1; i <= n; i++) {
      const key = `${y}-${String(mo + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
      const v = dmap.get(key);
      h += `<div class="d ${v && v.count ? (v.net >= 0 ? "win" : "lose") : ""} ${key === d ? "today" : ""}" data-day="${key}" role="button" tabindex="0" style="cursor:pointer" title="${v ? `${v.count} сделок, ${money(v.net)}` : ""}">
        <span class="n">${i}</span>${v && v.signed_off ? '<span class="dot"></span>' : ""}</div>`;
    }
    $("#mCal").innerHTML = h;
  };
  drawM();
  $("#mPrev").onclick = () => { m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() - 1, 1)); drawM(); };
  $("#mNext").onclick = () => { m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)); drawM(); };
  $("#mCal").onclick = (e) => { const c = e.target.closest("[data-day]"); if (c) location.hash = `#/day/${c.dataset.day}`; };

  // план
  let mood = pre.mood ?? null;
  $("#mood").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; mood = mood === +b.dataset.v ? null : +b.dataset.v; $("#mood").querySelectorAll("button").forEach((q) => q.classList.toggle("on", +q.dataset.v === mood)); };
  const save = async (body, msg) => { try { await api(`/api/day/${d}`, { method: "PUT", body: JSON.stringify(body) }); toast(msg); renderDay(d); } catch (e) { toast(e.message, true); } };
  let sleep = pre.sleep ?? null, energy = pre.energy ?? null;
  const scale = (id, get, set) => ($(id).onclick = (e) => { const b = e.target.closest("button"); if (!b) return; set(get() === +b.dataset.v ? null : +b.dataset.v); $(id).querySelectorAll("button").forEach((q) => q.classList.toggle("on", +q.dataset.v === get())); });
  scale("#sleep", () => sleep, (v) => (sleep = v));
  scale("#energy", () => energy, (v) => (energy = v));
  $("#preSave").onclick = () => {
    const checks = {};
    x.checklist_items.forEach((c, i) => (checks[c] = !!$(`#preForm input[data-i="${i}"]`).checked));
    save({ premarket: { mood, sleep, energy, checks, levels: $("#preForm [name=levels]").value, plan: $("#preForm [name=plan]").value } }, "План сохранён");
  };
  // итог
  let grade = wrap.grade ?? null, rules = wrap.rules ?? null;
  $("#dGrade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; grade = grade === +b.dataset.g ? null : +b.dataset.g; $("#dGrade").querySelectorAll("button").forEach((q) => q.classList.toggle("on", +q.dataset.g === grade)); };
  $("#dRules").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; rules = rules === +b.dataset.v ? null : +b.dataset.v; $("#dRules").querySelectorAll("button").forEach((q) => q.classList.toggle("on", +q.dataset.v === rules)); };
  const wrapBody = () => ({ good: $("#wrapForm [name=good]").value, improve: $("#wrapForm [name=improve]").value, grade, rules });
  $("#wrapSave").onclick = () => save({ wrap: wrapBody() }, "Итог сохранён");
  $("#signOff").onclick = () => {
    if (!x.signed_off && x.count > x.reviewed && !confirm(`Не разобрано сделок: ${x.count - x.reviewed}. Закрыть день всё равно?`)) return;
    save({ wrap: wrapBody(), signed_off: !x.signed_off }, x.signed_off ? "День снова открыт" : "День закрыт");
  };
  $("#dayNoteSave").onclick = async () => {
    const body = $("#dayNote").value.trim();
    if (!body) return;
    await api("/api/notes", { method: "POST", body: JSON.stringify({ title: `Заметка за ${ddmm(d)}`, body, date: d }) });
    toast("Заметка добавлена"); $("#dayNote").value = "";
  };
}

function extrasReviewed(t) {
  return !!(t.setup || t.grade || t.entry_reason || t.exit_reason || t.notes || t.followed_plan !== null && t.followed_plan !== undefined || t.check_done);
}

/* ---------- лента дней ---------- */
async function renderDays() {
  const p = periodQuery();
  const from = p.get("from") ? new Date(+p.get("from") * 1000).toISOString().slice(0, 10) : "";
  const days = (await api(`/api/days${from ? "?from=" + from : ""}`)).filter((x) => x.count);
  let limit = 30;
  view.innerHTML = `<div class="td-head"><div class="td-title"><h1>Дни</h1><span class="muted">${days.length} торговых ${plural(days.length, "день", "дня", "дней")} ${periodLabel()}</span></div></div><div id="dayList" class="day-list"></div>`;
  const draw = () => {
    $("#dayList").innerHTML = days.slice(0, limit).map((x) => `<section class="panel day-card" data-day="${x.date}" tabindex="0" role="button">
      <div><div style="font-weight:600">${dayTitle(x.date)}</div><div class="muted" style="font-size:12px">${x.symbols.map(esc).join(", ")}</div>
        <div class="chips" style="margin-top:8px"><span class="tag">${x.count} ${plural(x.count, "сделка", "сделки", "сделок")}</span>
          <span class="tag ${x.reviewed === x.count ? "pos" : ""}">разобрано ${x.reviewed}/${x.count}</span>
          <span class="tag">прибыльных ${x.closed ? Math.round((100 * x.wins) / x.closed) : 0}%</span>
          ${x.off_plan ? `<span class="tag neg">вне плана ${x.off_plan}</span>` : ""}${x.signed_off ? '<span class="tag pos">день закрыт</span>' : ""}</div></div>
      <div class="day-net ${cls(x.net)}">${U(x.net, x.r)}</div>
      <div class="day-spark">${sparkSVG(x.curve, 400, 64)}</div></section>`).join("") +
      (limit < days.length ? `<div style="text-align:center"><button class="btn" id="moreDays">Показать ещё</button></div>` : "") +
      (days.length ? "" : emptyState("Торговых дней за период нет", "Выберите период длиннее вверху."));
    $("#dayList").querySelectorAll("[data-day]").forEach((c) => { c.onclick = () => (location.hash = `#/day/${c.dataset.day}`); c.onkeydown = (e) => e.key === "Enter" && c.onclick(); });
    $("#moreDays")?.addEventListener("click", () => { limit += 30; draw(); });
  };
  draw();
}
