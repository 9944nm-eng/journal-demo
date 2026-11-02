/* Быстрые действия на «Сегодня»: разбор сделки за 20 секунд, план выхода у открытой позиции,
   недельный разбор из трёх вопросов, предупреждение о позднем окне ТС. */
"use strict";

/* ---------- разбор за 20 секунд ---------- */
const quickSetups = () => {
  const pb = (S.st?.playbooks || []).map((p) => p.name);
  const used = (S.st?.options?.setups || []).filter((s) => s && s.length <= 30 && !pb.includes(s));
  return [...pb, ...used].slice(0, 8);
};

function quickReviewTile() {
  const n = S.todo?.unreviewed?.length || 0;
  if (!n) return "";
  return `<section class="tile qr-tile" aria-labelledby="qrh"><div class="tile-h"><h2 id="qrh">Разбор за 20 секунд</h2><span class="muted" style="font-size:12px">${n} ${plural(n, "сделка ждёт", "сделки ждут", "сделок ждут")}</span></div>
    <div id="qrBox"><div class="muted" style="font-size:13px"><span class="spin"></span> Загружаю</div></div></section>`;
}

async function loadQuickReview() {
  const box = $("#qrBox");
  if (!box) return;
  const keys = [...(S.todo?.unreviewed || [])].reverse().slice(0, 3);
  const trades = (await Promise.all(keys.map((k) => { const [l, p] = k.split(":"); return api(`/api/trade/${l}/${p}`).catch(() => null); }))).filter(Boolean);
  const setups = quickSetups();
  box.innerHTML = trades.map((t) => `<div class="qr-item" data-l="${t.login}" data-p="${t.position_id}">
      <div class="qr-h"><b class="t-mono">${esc(t.symbol)}</b>${dirBadge(t.direction)}<span class="muted">${dt(t.close_time)}</span>
        <span class="t-mono ${cls(t.r ?? t.net)}" style="font-weight:600">${t.r !== null && t.r !== undefined ? rfmt(t.r) : money(t.net)}</span>
        ${(t.twins || []).length ? '<span class="twin-mark" title="Разбор сохранится и во вторую сделку пары">' + LINK_ICON + "</span>" : ""}
        <a href="#/trade/${t.login}/${t.position_id}" class="qr-open">карточка</a></div>
      <div class="qr-row"><span class="qr-k">Сетап</span><div class="qr-chips">${setups.map((s) => `<button type="button" class="chip" data-setup="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>
      <div class="qr-row"><span class="qr-k">По плану</span><div class="seg qr-plan"><button type="button" data-v="1">Да</button><button type="button" data-v="0">Нет</button></div>
        <span class="qr-k">Качество</span><div class="seg qr-grade">${["A", "B", "C"].map((g) => `<button type="button" data-v="${g}">${g}</button>`).join("")}</div></div>
      <div class="qr-row"><input type="text" class="qr-why" placeholder="Почему вошёл - одной строкой" maxlength="200"><button type="button" class="btn primary sm qr-save" disabled>Готово</button></div>
    </div>`).join("") || '<p class="muted" style="margin:0;font-size:14px">Всё разобрано.</p>';
  initThumbs(box);
  box.querySelectorAll(".qr-item").forEach((it) => {
    const st = { setup: null, plan: null, grade: null };
    const ready = () => (it.querySelector(".qr-save").disabled = !(st.setup && st.plan !== null));
    it.querySelector(".qr-chips").onclick = (e) => {
      const b = e.target.closest("[data-setup]"); if (!b) return;
      st.setup = st.setup === b.dataset.setup ? null : b.dataset.setup;
      it.querySelectorAll("[data-setup]").forEach((x) => x.classList.toggle("on", x.dataset.setup === st.setup)); ready();
    };
    it.querySelector(".qr-plan").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.plan = +b.dataset.v;
      it.querySelectorAll(".qr-plan button").forEach((x) => x.classList.toggle("on", x === b)); ready(); };
    it.querySelector(".qr-grade").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.grade = st.grade === b.dataset.v ? null : b.dataset.v;
      it.querySelectorAll(".qr-grade button").forEach((x) => x.classList.toggle("on", x.dataset.v === st.grade)); };
    it.querySelector(".qr-save").onclick = async () => {
      const body = { setup: st.setup, followed_plan: st.plan };
      if (st.grade) body.setup_grade = st.grade;
      const why = it.querySelector(".qr-why").value.trim();
      if (why) body.entry_reason = why;
      try {
        const r = await api(`/api/trade/${it.dataset.l}/${it.dataset.p}/quick`, { method: "PUT", body: JSON.stringify(body) });
        toast(r.twins ? "Разобрано, в обе сделки пары" : "Разобрано");
        it.classList.add("qr-done");
        setTimeout(async () => { await loadState(); quietRefresh(); }, 350);
      } catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------- план выхода у открытой позиции ---------- */
function exitPlanHTML(p) {
  return `<div class="xp" data-pid="${p.position_id}">
    <div class="xp-h">План выхода <span class="muted">записывается до движения цены, не после</span></div>
    <div class="xp-row"><label><span>Частичная фиксация</span><input type="text" data-k="exit_partial" placeholder="например: половина на +1,5R"></label>
      <label><span>Выхожу руками, если</span><input type="text" data-k="exit_manual" placeholder="например: закрытие H1 ниже 4012"></label></div></div>`;
}
async function bindExitPlans(login) {
  for (const el of view.querySelectorAll(".xp[data-pid]")) {
    const pid = el.dataset.pid;
    try {
      const p = await api(`/api/trade/${login}/${pid}/plan`);
      el.querySelectorAll("input[data-k]").forEach((i) => { i.value = p[i.dataset.k] || ""; });
      el.classList.toggle("xp-empty", !(p.exit_partial || p.exit_manual));
    } catch (e) { /* позиция ещё не известна журналу */ }
    el.querySelectorAll("input[data-k]").forEach((i) => (i.onchange = async () => {
      try {
        await api(`/api/trade/${login}/${pid}/quick`, { method: "PUT", body: JSON.stringify({ [i.dataset.k]: i.value.trim() }) });
        el.classList.toggle("xp-empty", ![...el.querySelectorAll("input")].some((x) => x.value.trim()));
        toast("План выхода записан");
      } catch (e) { toast(e.message, true); }
    }));
  }
}

/* ---------- позднее окно ТС ---------- */
function lateAlert(c) {
  const r = c.rules.find((x) => x.kind === "late_reduced");
  if (!r) return null;
  const off = c.acc?.server_offset || 0;
  const hour = Math.floor((((c.now + off) % 86400) + 86400) % 86400 / 3600);
  if (hour < (r.params.hour ?? 16)) return null;
  const lim = Math.round((r.params.max_pct ?? 1) * (r.params.factor ?? 0.5) * 100) / 100;
  return ["warn", `Позднее окно (после ${r.params.hour ?? 16}:00).`, `Только A-сетап и риск не выше ${String(lim).replace(".", ",")}%: в октябре это время дало минус.`];
}

/* ---------- недельный разбор из трёх вопросов ---------- */
function weekQuickTile(due) {
  if (!due) return "";
  return `<section class="tile wq-tile" aria-labelledby="wqh"><div class="tile-h"><h2 id="wqh">Недельный разбор: 3 вопроса</h2><a href="#/week/${due}">Полный</a></div>
    <div id="wqBox" data-week="${due}"><div class="muted" style="font-size:13px"><span class="spin"></span> Собираю неделю</div></div></section>`;
}
async function loadWeekQuick() {
  const box = $("#wqBox");
  if (!box) return;
  const d = await api(`/api/week?week=${box.dataset.week}`).catch(() => null);
  if (!d) { box.innerHTML = ""; return; }
  const a = d.record?.answers || {}, s = d.summary || {};
  const best = (d.best || [])[0], worst = (d.worst || [])[0];
  const vio = (d.violations || []).length;
  box.innerHTML = `<p class="muted" style="margin:0 0 12px;font-size:13px">Неделя: ${s.trades || 0} ${plural(s.trades || 0, "сделка", "сделки", "сделок")}, ${s.sum_r !== null && s.sum_r !== undefined ? rfmt(s.sum_r) : money(s.net || 0)}, нарушений ТС ${vio}.${best ? ` Лучшая: ${esc(best.symbol)} ${rfmt(best.r)}.` : ""}${worst ? ` Худшая: ${esc(worst.symbol)} ${rfmt(worst.r)}.` : ""}</p>
    <form class="form" style="padding:0" id="wqForm" autocomplete="off">
      <label class="f"><span>Что сработало</span><textarea name="worked" rows="2" placeholder="${best ? "Что было правильным в " + esc(best.symbol) + "?" : "Что получилось"}">${esc(a.worked || "")}</textarea></label>
      <label class="f"><span>Главная ошибка недели</span><textarea name="repeat" rows="2" placeholder="${vio ? "Нарушений ТС: " + vio + ". Какое повторялось?" : "Что повторилось"}">${esc(a.repeat || "")}</textarea></label>
      <label class="f"><span>Фокус следующей недели (одно правило)</span><input type="text" name="focus" value="${esc(d.plan_next?.focus || "")}" placeholder="например: после стопа 60 минут без входа на этом инструменте"></label>
      <div class="form-foot"><span class="muted" style="font-size:12px">Уровни и цели - в полном разборе</span><button type="submit" class="btn primary sm">Разбор сделан</button></div></form>`;
  $("#wqForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.worked.value.trim() || !f.repeat.value.trim() || !f.focus.value.trim()) { toast("Ответь на все три вопроса", true); return; }
    try {
      const pn = d.plan_next || {};
      await api(`/api/plan/${d.next_week}`, { method: "PUT", body: JSON.stringify({ focus: f.focus.value.trim(), notes: pn.notes || "", instruments: pn.instruments || [] }) });
      await api(`/api/week/${d.week}`, { method: "PUT", body: JSON.stringify({ answers: { ...a, worked: f.worked.value.trim(), repeat: f.repeat.value.trim() }, done: true, next_week: d.next_week, next_goals: d.next_goals || [] }) });
      toast("Недельный разбор сделан");
      await loadState(); quietRefresh();
    } catch (err) { toast(err.message, true); }
  };
}
