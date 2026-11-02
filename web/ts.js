/* Моя ТС: мастер вопросов с готовыми ответами и подсказками из сделок и заметок */
"use strict";

const TS_COMMON_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "GER40", "NAS100", "US30", "SPX500", "USDJPY", "BTCUSD"];

// вопросы мастера; sg - подсказки из данных журнала (подставляются ответом по умолчанию)
function tsQuestions(sg) {
  const syms = (sg.symbols || []).map(([s]) => s);
  const tfs = (sg.tfs || []).map(([t]) => t);
  const pick = (opts, have) => opts.filter((o) => have.includes(o));
  const sessW = { "Азия": ["Азия"], "Лондон": ["London open"], "Нью-Йорк": ["NYSE open", "New York"] };
  const winSg = [...new Set((sg.sessions || []).filter(([, n]) => n >= Math.max(2, (sg.count || 0) * 0.15)).flatMap(([s]) => sessW[s] || []))];
  const near = (opts, v) => (v === null || v === undefined ? [] : [opts.reduce((a, b) => (Math.abs(parseFloat(b) - v) < Math.abs(parseFloat(a) - v) ? b : a))]);
  const why = (txt) => (txt ? `По твоим данным: ${txt}` : "");
  return [
    { key: "symbols", sec: "Рынок", title: "Чем торгуешь?", type: "multi", options: [...new Set([...syms, ...TS_COMMON_SYMBOLS])], suggested: syms.slice(0, 3),
      hint: "Выбери инструменты, по которым есть понятная модель. Сделки по другим журнал пометит как нарушение.",
      why: why(sg.symbols?.length ? sg.symbols.slice(0, 4).map(([s, n]) => `${s} - ${n}`).join(", ") + " сделок" : "") },
    { key: "style", sec: "Рынок", title: "Какой стиль торговли?", type: "single", options: ["скальпинг", "интрадей", "интрадей + перенос", "свинг"], suggested: [],
      hint: "Определяет, сколько держишь позицию и какие таймфреймы нужны." },
    { key: "ctx_tf", sec: "Таймфреймы", title: "Где смотришь контекст?", type: "multi", options: ["1W", "1D", "4H", "1H"], suggested: pick(["1D", "4H", "1H"], tfs).slice(0, 1).concat(tfs.length ? [] : ["4H"]),
      hint: "Старший таймфрейм, на котором определяешь направление и ключевые зоны." },
    { key: "conf_tf", sec: "Таймфреймы", title: "Где ждёшь подтверждение?", type: "multi", options: ["1H", "30M", "15M", "5M"], suggested: pick(["1H", "30M", "15M", "5M"], tfs).slice(0, 2),
      hint: "Таймфрейм, на котором цена должна показать реакцию от зоны." },
    { key: "entry_tf", sec: "Таймфреймы", title: "На каком таймфрейме входишь?", type: "multi", options: ["15M", "5M", "3M", "1M"], suggested: pick(["15M", "5M", "3M", "1M"], tfs).slice(0, 2),
      hint: "Чем младше таймфрейм входа, тем короче стоп и тем важнее фильтр по времени.", why: why(tfs.length ? "в заметках чаще всего " + tfs.slice(0, 4).join(", ") : "") },
    { key: "windows", sec: "Время", title: "В какие окна торгуешь?", type: "multi", options: ["Азия", "Франкфурт open", "London open", "NY open", "NYSE open", "New York", "London close"], suggested: winSg,
      hint: "Окна, совпадающие с сессиями журнала (Азия, Лондон, Нью-Йорк), станут правилом: вход вне них - нарушение.",
      why: why(sg.sessions?.length ? sg.sessions.map(([s, n]) => `${s} - ${n}`).join(", ") : "") },
    { key: "bias", sec: "Анализ", title: "Как определяешь направление?", type: "multi", options: ["структура старшего ТФ", "снятие ликвидности", "премиум / дискаунт", "план недели", "COT", "новости и макро"], suggested: [],
      hint: "То, без чего ты не открываешь сделку в эту сторону." },
    { key: "models", sec: "Вход", title: "Модели входа", type: "multi",
      options: [...new Set(["BOS", "CHoCH", "FVG", "Inversion FVG", "Order block", "Breaker", "Снятие ликвидности", "SMT", "Ретест уровня", ...(sg.entry_models || []), ...(sg.setups || [])])],
      suggested: [...new Set([...(sg.models || []), ...(sg.entry_models || []).slice(0, 2)])],
      hint: "Конкретные паттерны, по которым входишь. Они появятся подсказками в разборе сделки.", why: why(sg.models?.length ? "в заметках встречаются " + sg.models.join(", ") : "") },
    { key: "stop", sec: "Риск", title: "Где ставишь стоп?", type: "single", options: ["за тень свечи", "за свинг / структуру", "за order block", "за зону FVG", "фиксированный в пунктах", "по ATR"], suggested: (sg.stops || []).slice(0, 1),
      hint: "Сделка без стопа будет отмечаться нарушением." },
    { key: "target", sec: "Риск", title: "Где цель?", type: "multi", options: ["ближайший имбаланс", "противоположная ликвидность", "следующий уровень", "фиксированный RR", "трейлинг по структуре"], suggested: (sg.targets || []).slice(0, 1) },
    { key: "risk", sec: "Риск", title: "Риск на сделку", type: "single", options: ["0,25%", "0,5%", "0,75%", "1%", "1,5%", "2%"], suggested: near(["0,25%", "0,5%", "0,75%", "1%", "1,5%", "2%"], sg.risk),
      hint: "Сделки с риском выше на 10% и больше журнал пометит.", why: why(sg.risk ? `средний риск ${String(sg.risk).replace(".", ",")}%` : "") },
    { key: "rr", sec: "Риск", title: "Минимальный RR", type: "single", options: ["1", "1,5", "2", "2,5", "3", "4"], suggested: near(["1", "1,5", "2", "2,5", "3", "4"], sg.rr ? Math.min(sg.rr, 3) : null),
      hint: "Плановое соотношение тейка к стопу при входе.", why: why(sg.rr ? `медианный плановый RR ${String(sg.rr).replace(".", ",")}` : "") },
    { key: "day_limit", sec: "Риск", title: "Лимит убытка за день", type: "single", options: ["1%", "2%", "3%", "4%", "5%"], suggested: sg.worst_day_pct ? near(["1%", "2%", "3%", "4%", "5%"], Math.max(2, Math.ceil(sg.worst_day_pct))) : [],
      hint: "После такого убытка за день входы отмечаются нарушением.", why: why(sg.worst_day_pct ? `худший день −${String(sg.worst_day_pct).replace(".", ",")}%` : "") },
    { key: "per_day", sec: "Риск", title: "Сколько сделок в день максимум?", type: "single", options: ["1", "2", "3", "4", "5"], suggested: sg.per_day ? [String(Math.min(5, sg.per_day))] : [],
      why: why(sg.per_day ? `в активные дни обычно до ${sg.per_day}` : "") },
    { key: "after_loss", sec: "Дисциплина", title: "Что делаешь после убыточной сделки?", type: "single", options: ["пауза 30 мин", "пауза 60 мин", "стоп до конца дня", "продолжаю по плану"], suggested: [] },
    { key: "be", sec: "Сопровождение", title: "Безубыток", type: "multi", options: ["не перевожу", "когда RR дошёл до 1", "после слома структуры", "после частичной фиксации"], suggested: sg.be_share === null || sg.be_share === undefined ? [] : sg.be_share < 0.1 ? ["не перевожу"] : ["когда RR дошёл до 1"],
      why: why(sg.be_share !== null && sg.be_share !== undefined && sg.count ? `в безубыток закрыто ${Math.round(sg.be_share * 100)}% сделок` : "") },
    { key: "partial", sec: "Сопровождение", title: "Частичная фиксация", type: "single", options: ["нет, закрываю всё сразу", "50% на 1R", "50% на 2R", "по уровням"], suggested: sg.partial_share === null || sg.partial_share === undefined ? [] : sg.partial_share < 0.1 ? ["нет, закрываю всё сразу"] : ["по уровням"] },
    { key: "no_trade", sec: "Дисциплина", title: "Когда не торгуешь?", type: "multi", options: ["важные новости ±30 мин", "после 2 убытков подряд", "после 3 убытков подряд", "пятница после обеда", "достигнута дневная цель", "плохое состояние"], suggested: [],
      hint: "«После N убытков подряд» станет правилом журнала." },
  ];
}

const TS_LABELS = { symbols: "Чем торгую", style: "Стиль", ctx_tf: "Контекст", conf_tf: "Подтверждение", entry_tf: "Вход", windows: "Окна", bias: "Направление", models: "Модели входа",
  stop: "Где стоп", target: "Где цель", risk: "Риск на сделку", rr: "Минимальный RR", day_limit: "Лимит за день", per_day: "Сделок за день", after_loss: "После убытка",
  be: "Безубыток", partial: "Частичная фиксация", no_trade: "Не торгую" };

const tsVal = (v) => (Array.isArray(v) ? v : v ? [v] : []);
function tsSummary(answers) {
  return `<div class="ts-sum">${Object.keys(TS_LABELS).filter((k) => tsVal(answers[k]).length).map((k) =>
    `<div class="ts-row"><span>${TS_LABELS[k]}</span><b>${tsVal(answers[k]).map(esc).join(" · ")}</b></div>`).join("")}</div>`;
}

async function renderTS(mode) {
  const d = await api("/api/ts");
  const sg = d.suggest || {};
  if (mode !== "edit" && d.saved) return renderTSCard(d);
  const qs = tsQuestions(sg);
  const ans = {};
  for (const q of qs) {
    const prev = tsVal(d.answers?.[q.key]);
    ans[q.key] = prev.length ? [...prev] : [...q.suggested];
    for (const v of prev) if (!q.options.includes(v)) q.options.push(v);
  }
  let i = 0;
  const intro = sg.count ? `Журнал посмотрел ${sg.count} ${plural(sg.count, "сделку", "сделки", "сделок")}${sg.notes_count ? ` и ${sg.notes_count} ${plural(sg.notes_count, "заметку", "заметки", "заметок")}` : ""} и подставил ответы, похожие на твою торговлю. Их можно поменять.`
    : "Сделок пока мало, поэтому ответы не подставлены: выбери варианты или впиши свои.";

  const draw = (dir = 1) => {
    if (i >= qs.length) return drawFinal();
    const q = qs[i], cur = ans[q.key] || [];
    view.innerHTML = `<div class="ts-wrap">
      <div class="ts-top"><span class="muted">${q.sec} · вопрос ${i + 1} из ${qs.length}</span><div class="ts-prog"><i style="width:${(100 * i) / qs.length}%"></i></div>
        ${d.saved ? '<a class="btn sm" href="#/ts">Отмена</a>' : ""}</div>
      ${i === 0 ? `<p class="muted ts-intro">${intro}</p>` : ""}
      <section class="panel ts-q ${dir > 0 ? "fwd" : "back"}">
        <h2>${q.title}</h2>${q.hint ? `<p class="muted">${q.hint}</p>` : ""}
        <div class="ts-opts" role="group" aria-label="${esc(q.title)}">${q.options.map((o, k) => `<button type="button" class="ts-opt ${cur.includes(o) ? "on" : ""}" data-o="${esc(o)}" aria-pressed="${cur.includes(o)}">
          ${k < 9 ? `<kbd>${k + 1}</kbd>` : ""}<span>${esc(o)}</span>${q.suggested.includes(o) ? '<em title="Подсказано по твоим сделкам и заметкам">из журнала</em>' : ""}</button>`).join("")}</div>
        <form class="ts-custom" autocomplete="off"><input type="text" placeholder="Свой вариант" aria-label="Свой вариант"><button class="btn sm" type="submit">Добавить</button></form>
        ${q.why ? `<div class="ts-why">${esc(q.why)}</div>` : ""}
        <div class="muted ts-type">${q.type === "multi" ? "Можно выбрать несколько" : "Один вариант"} · цифры 1-9 выбирают, Enter - дальше</div>
      </section>
      <div class="ts-nav"><button class="btn" id="tsBack" ${i ? "" : "disabled"}>Назад</button>
        <span class="spacer"></span><button class="btn" id="tsSkip">Пропустить</button><button class="btn primary" id="tsNext">${i === qs.length - 1 ? "Готово" : "Далее"}</button></div>
    </div>`;
    const toggle = (o) => {
      const now = ans[q.key];
      if (q.type === "single") ans[q.key] = now.includes(o) ? [] : [o];
      else ans[q.key] = now.includes(o) ? now.filter((x) => x !== o) : [...now, o];
      view.querySelectorAll(".ts-opt").forEach((b) => { const on = ans[q.key].includes(b.dataset.o); b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      // один вариант: после выбора сразу следующий вопрос
      if (q.type === "single" && ans[q.key].length) setTimeout(() => { if (qs[i] === q) { i++; draw(1); } }, 260);
    };
    view.querySelector(".ts-opts").onclick = (e) => { const b = e.target.closest(".ts-opt"); if (b) toggle(b.dataset.o); };
    view.querySelector(".ts-custom").onsubmit = (e) => {
      e.preventDefault();
      const v = e.target.querySelector("input").value.trim();
      if (!v) return;
      if (!q.options.includes(v)) q.options.push(v);
      if (!ans[q.key].includes(v)) ans[q.key] = q.type === "single" ? [v] : [...ans[q.key], v];
      draw(0);
    };
    $("#tsBack").onclick = () => { i = Math.max(0, i - 1); draw(-1); };
    $("#tsNext").onclick = () => { i++; draw(1); };
    $("#tsSkip").onclick = () => { ans[q.key] = []; i++; draw(1); };
    document.onkeydown = (e) => {
      if (!location.hash.startsWith("#/ts")) { document.onkeydown = null; return; }
      if (document.activeElement.tagName === "INPUT") return;
      if (/^[1-9]$/.test(e.key) && q.options[+e.key - 1]) toggle(q.options[+e.key - 1]);
      else if (e.key === "Enter") { e.preventDefault(); i++; draw(1); }
      else if (e.key === "Backspace" && i) { i--; draw(-1); }
    };
  };

  const drawFinal = () => {
    document.onkeydown = null;
    const out = {};
    for (const q of qs) if (ans[q.key].length) out[q.key] = q.type === "single" ? ans[q.key][0] : ans[q.key];
    view.innerHTML = `<div class="ts-wrap"><section class="panel ts-final">
      <h1>Это твоя ТС</h1><p class="muted">Теперь журнал будет сверять с ней каждую сделку.</p>
      ${tsSummary(out)}
      <label class="ts-apply"><input type="checkbox" id="tsRules" checked> Создать правила проверки: инструменты, окна, риск, RR, лимит за день, число сделок, пауза после убытка</label>
      <div class="ts-nav"><button class="btn primary" id="tsSave">Сохранить</button><button class="btn link" id="tsAgain">Пройти ещё раз</button><span class="spacer"></span><button class="btn" id="tsBack2">Назад</button></div>
    </section></div>`;
    enterView(view);
    $("#tsAgain").onclick = () => { i = 0; draw(-1); };
    $("#tsBack2").onclick = () => { i = qs.length - 1; draw(-1); };
    $("#tsSave").onclick = async () => {
      try {
        const r = await api("/api/ts", { method: "PUT", body: JSON.stringify({ answers: out, apply_rules: $("#tsRules").checked }) });
        toast(r.rules.length ? `ТС сохранена, правил проверки: ${r.rules.length}` : "ТС сохранена");
        await loadState();
        location.hash = "#/ts";
        if (location.hash === "#/ts") route();
      } catch (e) { toast(e.message, true); }
    };
  };
  draw(1);
}

// результат по оценке сетапа A/B/C: стоит ли брать B и C
function gradesHTML(g) {
  const rows = ["A", "B", "C"].filter((k) => g.real[k] || g.backtest[k]);
  if (!rows.length) return `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Качество сетапов A/B/C</h2></div>
    <div class="panel-b empty">Ставь оценку A, B или C в разборе сделки и в бэктесте: здесь появится, отличаются ли A-сетапы по результату.</div></section>`;
  const cell = (x) => (x ? `<td class="num">${x.count}</td><td class="num">${x.win_rate}%</td><td class="num ${cls(x.avg_r)}"><b>${rfmt(x.avg_r)}</b></td>` : '<td class="num muted" colspan="3">—</td>');
  const a = g.real.A, worst = ["B", "C"].map((k) => g.real[k]).filter(Boolean);
  const tip = a && worst.length && worst.some((x) => x.avg_r < a.avg_r) ? `<p class="muted" style="font-size:12px;margin:10px 0 0">Сделки A в среднем дают ${rfmt(a.avg_r)}, остальные - ${rfmt(worst.reduce((s, x) => s + x.sum_r, 0) / worst.reduce((s, x) => s + x.count, 0))}. Если разница держится, B и C можно пропускать.</p>` : "";
  return `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Качество сетапов A/B/C</h2></div>
    <div class="panel-b tbl-wrap"><table class="t"><thead><tr><th>Оценка</th><th class="num">Реал: сделок</th><th class="num">прибыльных</th><th class="num">средний R</th><th class="num">Бэктест: сделок</th><th class="num">прибыльных</th><th class="num">средний R</th></tr></thead>
    <tbody>${rows.map((k) => `<tr><td><span class="grade-chip g${k}">${k}</span></td>${cell(g.real[k])}${cell(g.backtest[k])}</tr>`).join("")}</tbody></table>${tip}</div></section>`;
}

async function renderTSCard(d) {
  const gr = api("/api/grades").catch(() => ({ real: {}, backtest: {} }));
  const r = await api("/api/rules").catch(() => ({ rules: [] }));
  const mine = r.rules.filter((x) => x.source === "ts");
  view.innerHTML = `
    <div class="td-head"><h1>Моя ТС</h1><div style="display:flex;gap:8px"><a class="btn" href="#/ts/edit">Пройти ещё раз</a></div></div>
    <div class="ts-card-grid">
      <section class="panel ts-final"><p class="muted" style="margin-top:0">Сохранена ${localTime(d.saved)}. Журнал сверяет с ней каждую сделку.</p>${tsSummary(d.answers)}</section>
      <section class="panel"><div class="panel-h"><h2>Как ты следуешь ТС</h2><span class="muted">${mine.length ? `сделок проверено: ${mine[0].total}` : ""}</span></div>
        <div class="panel-b">${mine.length ? mine.map((x) => {
          const ok = x.total ? 1 - x.violations / x.total : 1;
          return `<div class="ts-rule"><div class="row"><span>${esc(x.title)}</span><b class="${x.violations ? "neg" : "pos"}">${x.violations ? `${x.violations} ${plural(x.violations, "нарушение", "нарушения", "нарушений")}` : "без нарушений"}</b></div>
            <div class="meter ${ok < 0.8 ? "bad" : ok < 0.95 ? "warn" : "ok"}"><i style="width:${Math.round(ok * 100)}%"></i></div>
            ${x.violations && x.bad_avg_r !== null ? `<div class="muted" style="font-size:12px">с нарушением средний ${rfmt(x.bad_avg_r)}, без - ${rfmt(x.good_avg_r)}</div>` : ""}</div>`;
        }).join("") : '<div class="empty">Правила проверки не созданы. Пройди мастер ещё раз и оставь галочку «Создать правила проверки».</div>'}</div></section>
    </div>${gradesHTML(await gr)}`;
}
