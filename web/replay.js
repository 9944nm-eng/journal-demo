/* Бэктест: пошаговое воспроизведение графика. Будущие свечи скрыты, вход - кнопками или кликом по графику.
   Закрытая по стопу или тейку сделка сохраняется в бэктест, итог пересчитывается сервером по минуткам. */
"use strict";

const RP_TFS = ["M1", "M5", "M15", "M30", "H1", "H4"];
const rpFmtTime = (ts) => new Date(ts * 1000).toISOString().slice(0, 16);

async function renderReplay() {
  const d = await api("/api/backtests");
  const st = (S.rp = S.rp || { symbol: S.btLast?.symbol || d.symbols.find((s) => /XAU/i.test(s)) || "", tf: "M5", start: "", setup: S.btLast?.setup || "" });
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><a class="btn sm" href="#/backtest">‹ Бэктест</a><h1>Пошаговый режим</h1></div>
      <span class="muted" style="font-size:13px">будущее скрыто: листай свечи и входи так, как вошёл бы в реальности</span></div>
    <section class="panel rp-setup"><form id="rpForm" class="rp-form" autocomplete="off">
      <label class="f"><span>Актив</span><input name="symbol" list="rpSyms" value="${esc(st.symbol)}" required></label>
      <div class="f"><span class="muted" style="font-size:13px">Таймфрейм</span><div class="seg" id="rpTf">${RP_TFS.map((t) => `<button type="button" data-tf="${t}" class="${t === st.tf ? "on" : ""}">${t}</button>`).join("")}</div></div>
      <label class="f"><span>Начать с (время графика)</span><input type="datetime-local" name="start" value="${esc(st.start)}" required></label>
      <label class="f"><span>Сетап</span><input name="setup" list="rpSetups" value="${esc(st.setup)}" placeholder="для статистики по сетапам"></label>
      <button class="btn primary" type="submit">Загрузить</button>
    </form>
    <datalist id="rpSyms">${d.symbols.map((x) => `<option value="${esc(x)}">`).join("")}</datalist>
    <datalist id="rpSetups">${[...new Set([...d.setups, ...(S.st.options?.setups || [])])].map((x) => `<option value="${esc(x)}">`).join("")}</datalist></section>
    <div class="rp-grid">
      <section class="panel"><div class="trade-chart rp-chart" id="rpChart"><div class="chart-note">Выбери актив, таймфрейм и дату, с которой начать</div></div>
        <div class="replay-bar" id="rpCtl"></div></section>
      <div class="rp-side">
        <section class="panel panel-b" id="rpTrade"></section>
        <section class="panel panel-b" id="rpSession"></section>
      </div>
    </div>`;
  const form = $("#rpForm");
  $("#rpTf").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; st.tf = b.dataset.tf; $("#rpTf").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    Object.assign(st, { symbol: form.elements.symbol.value.trim().toUpperCase(), start: form.elements.start.value, setup: form.elements.setup.value });
    const t0 = Date.parse(st.start + ":00Z") / 1000, step = { M1: 60, M5: 300, M15: 900, M30: 1800, H1: 3600, H4: 14400 }[st.tf];
    $("#rpChart").innerHTML = '<div class="chart-note skel-note"><span><span class="spin"></span> Загружаю котировки</span></div>';
    try {
      const c = await api(`/api/bars?symbol=${encodeURIComponent(st.symbol)}&tf=${st.tf}&from=${t0 - step * 250}&to=${t0 + step * 1500}`);
      if (!c.bars.length) { $("#rpChart").innerHTML = '<div class="chart-note">Котировок за этот период нет. Запусти терминал MT5 и попробуй снова; если не помогло - добавь инструмент в «Обзор рынка» терминала.</div>'; return; }
      rpStart(c, t0, st);
    } catch (err) { toast(err.message, true); }
  };
  rpSessionDraw();
}

function rpStart(c, t0, st) {
  killCharts();
  const el = $("#rpChart");
  el.innerHTML = "";
  const sh = c.shift || 0, d = c.digits;
  const bars = c.bars.map((b) => ({ ...b, time: b.time + sh }));
  const chart = chartBase(el);
  const series = chart.addCandlestickSeries({ upColor: css("--profit"), downColor: css("--loss"), wickUpColor: css("--profit"), wickDownColor: css("--loss"),
    borderVisible: false, priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) } });
  const barStep = bars.length > 1 ? bars[1].time - bars[0].time : 60;
  let i = Math.max(30, bars.findIndex((b) => b.time >= t0));
  if (i < 0) i = bars.length - 1;
  let timer = null, speed = 2, pos = null, mode = null, lines = [];
  const markers = [];
  const P = (v) => Number(v).toFixed(d);

  const redrawLines = () => {
    lines.forEach((l) => series.removePriceLine(l)); lines = [];
    if (!pos) return;
    const add = (p, color, title) => p && lines.push(series.createPriceLine({ price: p, color, lineWidth: 2, lineStyle: title === "вход" ? 2 : 0, axisLabelVisible: true, title }));
    add(pos.entry, css("--accent"), pos.filled ? "вход" : "лимит"); add(pos.sl, css("--loss"), "SL"); add(pos.tp, css("--profit"), "TP");
  };
  const show = () => {
    series.setData(bars.slice(0, i + 1));
    series.setMarkers(markers.filter((m) => m.time <= bars[i].time));
    $("#rpClock") && ($("#rpClock").textContent = dt(bars[i].time - sh));
  };
  // проверка позиции на новой свече: исполнение лимита, стоп, тейк (стоп первым, если оба в одной свече)
  const onBar = (b) => {
    if (!pos) return;
    const dir = pos.dir;
    if (!pos.filled) {
      if (b.low <= pos.entry && pos.entry <= b.high) { pos.filled = true; pos.fillTime = b.time; markers.push({ time: b.time, position: dir > 0 ? "belowBar" : "aboveBar", color: css("--accent"), shape: dir > 0 ? "arrowUp" : "arrowDown", text: dir > 0 ? "Buy" : "Sell" }); redrawLines(); }
      else return;
    }
    if (!pos.sl) return;
    const hitSl = dir > 0 ? b.low <= pos.sl : b.high >= pos.sl, hitTp = pos.tp && (dir > 0 ? b.high >= pos.tp : b.low <= pos.tp);
    if (hitSl || hitTp) close(hitSl ? pos.sl : pos.tp, b.time, hitSl ? "стоп" : "тейк");
  };
  const tick = () => { if (i >= bars.length - 1) { stop(); toast("Котировки закончились: загрузи период дальше"); return; } i++; onBar(bars[i]); show(); drawTrade(); };
  const play = () => { stop(); timer = setInterval(tick, Math.max(40, 500 / speed)); syncCtl(); };
  const stop = () => { clearInterval(timer); timer = null; syncCtl(); };

  const open = (dir, limit) => {
    if (pos) return;
    stop();
    const cur = bars[i].close, closeT = bars[i].time + barStep;  // решение принимается после закрытия свечи
    pos = { dir, entry: cur, sl: null, tp: null, filled: !limit, fillTime: limit ? null : closeT, placed: closeT, limit };
    if (!limit) markers.push({ time: bars[i].time, position: dir > 0 ? "belowBar" : "aboveBar", color: css("--accent"), shape: dir > 0 ? "arrowUp" : "arrowDown", text: dir > 0 ? "Buy" : "Sell" });
    mode = limit ? "entry" : "sl";
    redrawLines(); show(); drawTrade();
  };
  const close = async (price, time, how) => {
    const p = pos; pos = null; mode = null;
    const r = Math.round(((price - p.entry) * p.dir / Math.abs(p.entry - p.sl)) * 100) / 100;
    markers.push({ time, position: p.dir > 0 ? "aboveBar" : "belowBar", color: r >= 0 ? css("--profit") : css("--loss"), shape: "circle", text: `${how} ${rfmt(r)}` });
    redrawLines(); show(); drawTrade();
    try {
      const res = await api("/api/backtests", { method: "POST", body: JSON.stringify({ symbol: c.symbol, direction: p.dir, entry_type: p.limit ? "limit" : "market",
        time: rpFmtTime(p.limit ? p.placed : p.fillTime), entry: p.entry, sl: p.sl, tp: p.tp, setup: st.setup, notes: "пошаговый режим" }) });
      // точный итог - по минуткам на сервере: на старшем ТФ стоп и тейк могут попасть в одну свечу
      const rr = res.result.r ?? r, label = (BT_OUT[res.result.outcome] || [how])[0];
      const mk = markers[markers.length - 1];
      if (mk && mk.time === time) { mk.text = `${label.toLowerCase()} ${rfmt(rr)}`; mk.color = rr >= 0 ? css("--profit") : css("--loss"); show(); }
      (S.rpSession = S.rpSession || []).push({ id: res.id, symbol: c.symbol, dir: p.dir, r: rr, outcome: res.result.outcome });
      toast(`Сделка сохранена в бэктест: ${label.toLowerCase()}, ${rfmt(rr)}${res.result.ambiguous ? " (стоп и тейк в одну минуту, засчитан стоп)" : ""}`);
    } catch (err) { toast(err.message, true); }
    rpSessionDraw();
  };
  // клик по графику ставит уровень, который сейчас ждём: лимитный вход, стоп или тейк
  chart.subscribeClick((param) => {
    if (!pos || !mode || !param.point) return;
    const price = series.coordinateToPrice(param.point.y);
    if (price === null) return;
    const v = +P(price);
    if (mode === "entry") { pos.entry = v; pos.placed = bars[i].time + barStep; mode = "sl"; }
    else if (mode === "sl") {
      if ((v - pos.entry) * pos.dir >= 0) { toast(`Стоп для ${pos.dir > 0 ? "Buy ставится ниже" : "Sell ставится выше"} входа`, true); return; }
      pos.sl = v; mode = "tp";
    } else if (mode === "tp") {
      if ((v - pos.entry) * pos.dir <= 0) { toast(`Тейк для ${pos.dir > 0 ? "Buy ставится выше" : "Sell ставится ниже"} входа`, true); return; }
      pos.tp = v; mode = null;
    }
    redrawLines(); drawTrade();
  });

  const drawTrade = () => {
    const box = $("#rpTrade");
    if (!pos) {
      box.innerHTML = `<b>Новая сделка</b><p class="muted" style="font-size:12px;margin:4px 0 10px">По рынку - по цене закрытия текущей свечи. Лимит - кликни по графику цену входа.</p>
        <div class="rp-buttons"><button class="btn rp-buy" data-o="1">Buy</button><button class="btn rp-sell" data-o="-1">Sell</button></div>
        <div class="rp-buttons" style="margin-top:6px"><button class="btn sm" data-l="1">Buy лимит</button><button class="btn sm" data-l="-1">Sell лимит</button></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Клавиши: пробел - пуск/пауза, → - свеча, B / S - вход.</p>`;
      box.querySelectorAll("[data-o]").forEach((b) => (b.onclick = () => open(+b.dataset.o, false)));
      box.querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => open(+b.dataset.l, true)));
      return;
    }
    const risk = pos.sl ? Math.abs(pos.entry - pos.sl) : null;
    const hint = { entry: "Кликни по графику цену лимитного входа", sl: "Кликни по графику уровень стопа", tp: "Кликни по графику уровень тейка (или «Без тейка»)" }[mode] || "";
    const curR = risk && pos.filled ? ((bars[i].close - pos.entry) * pos.dir) / risk : null;
    box.innerHTML = `<div class="row" style="display:flex;justify-content:space-between"><b>${pos.dir > 0 ? "Buy" : "Sell"} ${esc(c.symbol)}</b><span class="tag">${pos.filled ? "открыта" : "лимит ждёт"}</span></div>
      ${hint ? `<div class="rp-hint">${hint}</div>` : ""}
      <div class="rp-levels">
        <label>Вход<input type="text" inputmode="decimal" data-k="entry" value="${pos.entry ?? ""}" ${pos.filled ? "disabled" : ""}></label>
        <label>Стоп<input type="text" inputmode="decimal" data-k="sl" value="${pos.sl ?? ""}"></label>
        <label>Тейк<input type="text" inputmode="decimal" data-k="tp" value="${pos.tp ?? ""}"></label></div>
      <div class="bt-preview">${risk ? `<span>RR <b>${pos.tp ? (Math.abs(pos.tp - pos.entry) / risk).toFixed(2).replace(".", ",") : "—"}</b></span>` : ""}${curR !== null ? `<span>сейчас <b class="${cls(curR)}">${rfmt(Math.round(curR * 100) / 100)}</b></span>` : ""}</div>
      <div class="rp-buttons" style="margin-top:8px">${mode === "tp" ? '<button class="btn sm" data-x="notp">Без тейка</button>' : ""}${!pos.filled || !pos.sl ? '<button class="btn sm" data-x="cancel">Отменить</button>' : ""}</div>`;
    box.querySelectorAll("[data-k]").forEach((inp) => (inp.onchange = () => { const v = btNum(inp.value); pos[inp.dataset.k] = v; if (inp.dataset.k === "sl" && mode === "sl" && v) mode = "tp"; redrawLines(); drawTrade(); }));
    box.querySelector('[data-x="notp"]')?.addEventListener("click", () => { mode = null; drawTrade(); });
    box.querySelector('[data-x="cancel"]')?.addEventListener("click", () => { if (pos.filled) markers.pop(); pos = null; mode = null; redrawLines(); show(); drawTrade(); });
  };

  const ctl = $("#rpCtl");
  ctl.innerHTML = `<button class="btn sm primary" data-a="play">▶ Пуск</button><button class="btn sm" data-a="step">Свеча →</button><button class="btn sm" data-a="jump">+20</button>
    <div class="seg">${[1, 2, 5, 10].map((s) => `<button data-s="${s}" class="${s === speed ? "on" : ""}">${s}×</button>`).join("")}</div>
    <span class="muted" style="font-size:12px;margin-left:auto">${esc(c.symbol)} ${esc(c.tf)} · <span id="rpClock"></span></span>`;
  const syncCtl = () => { const b = ctl.querySelector('[data-a="play"]'); if (b) b.textContent = timer ? "⏸ Пауза" : "▶ Пуск"; };
  ctl.onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.s) { speed = +b.dataset.s; ctl.querySelectorAll("[data-s]").forEach((x) => x.classList.toggle("on", x === b)); if (timer) play(); return; }
    if (b.dataset.a === "play") timer ? stop() : play();
    if (b.dataset.a === "step") { stop(); tick(); }
    if (b.dataset.a === "jump") { stop(); for (let k = 0; k < 20 && i < bars.length - 1; k++) { i++; onBar(bars[i]); } show(); drawTrade(); }
  };
  document.onkeydown = (e) => {
    if (location.hash !== "#/backtest/replay") { document.onkeydown = null; stop(); return; }
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key === " ") { e.preventDefault(); timer ? stop() : play(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stop(); tick(); }
    else if (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "и") open(1, false);
    else if (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "ы") open(-1, false);
  };
  window.addEventListener("hashchange", stop, { once: true });
  show();
  const span = 120;
  setTimeout(() => { try { chart.timeScale().setVisibleLogicalRange({ from: i - span, to: i + 15 }); } catch (e) {} }, 50);
  drawTrade();
}

function rpSessionDraw() {
  const box = $("#rpSession");
  if (!box) return;
  const s = S.rpSession || [];
  const sum = s.reduce((a, x) => a + (x.r || 0), 0), wins = s.filter((x) => x.r > 0).length;
  box.innerHTML = `<b>Эта сессия</b>
    <div class="rp-sum"><div><span>Сделок</span><b>${s.length}</b></div><div><span>Прибыльных</span><b>${s.length ? Math.round((100 * wins) / s.length) + "%" : "—"}</b></div><div><span>Сумма</span><b class="${cls(sum)}">${rfmt(Math.round(sum * 100) / 100)}</b></div></div>
    ${s.slice().reverse().map((x) => `<a class="rp-row" href="#/backtest/${x.id}"><span>${esc(x.symbol)} ${x.dir > 0 ? "Buy" : "Sell"}</span><b class="${cls(x.r)}">${rfmt(x.r)}</b></a>`).join("") || '<p class="muted" style="font-size:12px;margin:6px 0 0">Сделки появятся здесь и в общем списке бэктеста.</p>'}`;
}
