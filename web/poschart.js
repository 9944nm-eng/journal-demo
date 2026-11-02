/* График сделки: блок позиции как в TradingView, точные точки входа и выхода, MAE/MFE */
"use strict";

function renderTradeChart(el, c, t, opts = {}) {
  const sh = c.shift || 0, d = t.digits;
  const th = opts.theme || {};
  const col = (k, v) => th[k] || css(v);
  const profit = col("profit", "--profit"), loss = col("loss", "--loss"), acc = col("accent", "--accent"),
    muted = col("muted", "--muted"), text = col("text", "--text"), panel = col("surface", "--surface");
  el.style.position = "relative";
  const chart = opts.theme ? LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: th.bg || "transparent" }, textColor: muted, fontFamily: css("--font"), fontSize: opts.fontSize || 12 },
    grid: { vertLines: { color: th.grid || "rgba(128,128,128,.12)" }, horzLines: { color: th.grid || "rgba(128,128,128,.12)" } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    crosshair: { mode: 0 }, handleScroll: false, handleScale: false, localization: { locale: "ru-RU" },
  }) : chartBase(el);
  if (opts.theme) S.charts.push(chart);
  const T = c.trade;
  const series = chart.addCandlestickSeries({
    upColor: profit, downColor: loss, wickUpColor: profit, wickDownColor: loss, borderVisible: false, priceLineVisible: false,
    lastValueVisible: !opts.compact,
    priceFormat: { type: "price", precision: d, minMove: Math.pow(10, -d) },
    autoscaleInfoProvider: (orig) => {
      const r = orig();
      const lv = [T.sl_initial, T.tp_initial, T.sl_current, T.tp_current, T.entry_price, T.exit_price].filter(Boolean);
      if (r && r.priceRange && lv.length) {
        r.priceRange.minValue = Math.min(r.priceRange.minValue, ...lv);
        r.priceRange.maxValue = Math.max(r.priceRange.maxValue, ...lv);
      }
      return r;
    },
  });
  const bars = c.bars.map((b) => ({ ...b, time: b.time + sh }));
  series.setData(bars);
  // воспроизведение: показываются свечи и отметки только до момента until
  let until = Infinity;
  let drawings = opts.drawings || [];
  const times = bars.map((b) => b.time);
  const step = times.length > 1 ? times[1] - times[0] : 60;
  const idxOf = (ts) => { let lo = 0, hi = times.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };

  // линии уровней на всю ширину - по переключателю
  const sl0 = T.sl_initial, tp0 = T.tp_initial;
  const lines = opts.levels !== false && !opts.compact;
  const pl = (p, color, title) => p && series.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: 2, lineVisible: lines, axisLabelVisible: !opts.compact, title });
  pl(T.entry_price, acc, "вход"); pl(sl0, loss, "SL"); pl(tp0, profit, "TP");
  if (T.status === "open") { pl(T.sl_current !== sl0 ? T.sl_current : null, loss, "SL сейчас"); pl(T.tp_current !== tp0 ? T.tp_current : null, profit, "TP сейчас"); }

  // слой рисования поверх графика
  const cv = document.createElement("canvas");
  cv.className = "pos-overlay";
  el.appendChild(cv);
  const dpr = window.devicePixelRatio || 1;
  const ts = chart.timeScale();
  const tIn = T.open_time + sh, tOut = (T.close_time || (times[times.length - 1] - sh + step)) + sh;
  const dir = T.direction;
  const risk = sl0 ? Math.abs(T.entry_price - sl0) : null;
  const R = (p) => (risk ? ((p - T.entry_price) * dir) / risk : null);
  // MAE / MFE по свечам внутри сделки
  let mfe = null, mae = null;
  for (let i = Math.max(0, idxOf(tIn)); i < bars.length && bars[i].time < tOut; i++) {
    const b = bars[i];
    const fav = dir > 0 ? b.high : b.low, adv = dir > 0 ? b.low : b.high;
    if (!mfe || (fav - mfe.p) * dir > 0) mfe = { p: fav, t: b.time };
    if (!mae || (adv - mae.p) * dir < 0) mae = { p: adv, t: b.time };
  }
  const xOf = (tt) => {
    const i = idxOf(tt);
    if (i < 0) return null;
    const x0 = ts.timeToCoordinate(times[i]);
    if (x0 === null) return null;
    const sp = ts.options().barSpacing;
    return x0 - sp / 2 + Math.min(1, (tt - times[i]) / step) * sp;
  };
  const yOf = (p) => series.priceToCoordinate(p);
  const font = (px, w = 600) => `${w} ${px}px ${css("--font") || "sans-serif"}`;
  let paneWidth = 0;
  const pill = (ctx, x, y, txt, bg, fg, align = "left") => {
    ctx.font = font(opts.compact ? 10 : 11);
    const w = ctx.measureText(txt).width + 12, h = opts.compact ? 16 : 19;
    let px = align === "right" ? x - w : x;
    if (px + w > paneWidth - 4) px = x - w - 12;  // не помещается справа - ставим слева от точки
    px = Math.max(2, Math.min(px, paneWidth - w - 4));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(px, y - h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.fillText(txt, px + 6, y + 0.5);
  };
  const tfmt = (tt) => { const x = new Date(tt * 1000); return `${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")}`; };

  const draw = () => {
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = W + "px"; cv.style.height = H + "px";
    }
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    let paneW, paneH;
    try { paneW = W - chart.priceScale("right").width(); paneH = H - ts.height(); } catch (e) { return; }
    paneWidth = paneW;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, paneW, paneH); ctx.clip();
    // важные новости: вертикальная линия и подпись сверху
    if (!opts.compact && !opts.share) for (const n of c.news || []) {
      const t = n.time + sh;
      if (t > until) continue;
      const x = xOf(t);
      if (x === null || t < times[0] || t > times[times.length - 1] + step) continue;
      ctx.strokeStyle = col("warn", "--warn") + "aa"; ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, paneH); ctx.stroke(); ctx.setLineDash([]);
      pill(ctx, x + 3, 12, `${n.currency} ${n.title} ${tfmt(t)}`, col("warn", "--warn") + "2e", col("warn", "--warn"));
    }
    // свои отметки: уровни, зоны, подписи
    for (const dr of drawings) {
      const c2 = dr.color || acc, y1 = yOf(dr.p1);
      if (y1 === null) continue;
      if (dr.type === "level") {
        ctx.strokeStyle = c2; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
        ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(paneW, y1); ctx.stroke(); ctx.setLineDash([]);
        if (dr.text) pill(ctx, paneW - 6, y1 - 11, dr.text, c2 + "33", c2, "right");
      } else if (dr.type === "zone") {
        const xa_ = dr.t1 !== undefined ? xOf(dr.t1) : 0, xb_ = dr.t2 !== undefined ? xOf(dr.t2) : paneW, y2 = yOf(dr.p2);
        if (xa_ === null || xb_ === null || y2 === null) continue;
        ctx.fillStyle = c2 + "22"; ctx.strokeStyle = c2 + "99"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(Math.min(xa_, xb_), Math.min(y1, y2), Math.abs(xb_ - xa_), Math.abs(y2 - y1), 3); ctx.fill(); ctx.stroke();
        if (dr.text) pill(ctx, Math.min(xa_, xb_) + 4, Math.min(y1, y2) + 11, dr.text, c2 + "33", c2);
      } else if (dr.type === "text") {
        const x = xOf(dr.t1);
        if (x !== null) pill(ctx, x, y1, dr.text || "", panel + "ee", text);
      }
    }
    const xa = tIn <= until ? xOf(tIn) : null, xb = tOut <= until ? xOf(tOut) : (until < Infinity ? xOf(until) : null), ye = yOf(T.entry_price);
    if (xa !== null && ye !== null) {
      const x2 = xb !== null ? xb : paneW;
      // зоны тейка и стопа на время сделки: заливка гуще у уровня, светлее у входа
      const zone = (lvl, c2, label) => {
        const y = yOf(lvl);
        if (y === null) return;
        const top = Math.min(ye, y), h = Math.abs(y - ye), w = Math.max(2, x2 - xa);
        const g = ctx.createLinearGradient(0, ye, 0, y);
        g.addColorStop(0, c2 + "14"); g.addColorStop(1, c2 + "3a");
        ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(xa, top, w, h, 3); ctx.fill();
        ctx.strokeStyle = c2 + "aa"; ctx.lineWidth = 1.25; ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(xa + w, y); ctx.stroke();
        if (!opts.compact && w > 70 && h > 14) pill(ctx, xa + w - 4, y + (y < ye ? 11 : -11), label, c2 + "2e", c2, "right");
      };
      const rTxt = (p) => { const v = R(p); return v === null ? "" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(1).replace(".", ",") + "R"; };
      if (tp0) zone(tp0, profit, `TP ${rTxt(tp0)}`);
      if (sl0) zone(sl0, loss, "SL −1R");
      ctx.strokeStyle = acc; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(xa, ye); ctx.lineTo(x2, ye); ctx.stroke(); ctx.setLineDash([]);
      // MAE / MFE
      if (!opts.compact && until >= tOut) for (const [m, c2, lbl] of [[mfe, profit, "MFE"], [mae, loss, "MAE"]]) {
        if (!m) continue;
        const x = xOf(m.t + step / 2), y = yOf(m.p);
        if (x === null || y === null) continue;
        ctx.strokeStyle = c2; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(xa, y); ctx.lineTo(x2, y); ctx.stroke(); ctx.setLineDash([]);
        const rr = R(m.p);
        pill(ctx, xa + 4, y + (lbl === "MFE" ? (dir > 0 ? -11 : 11) : (dir > 0 ? 11 : -11)), `${lbl} ${rr !== null ? rfmt(rr) : price(m.p, d)}`, c2 + "33", c2);
      }
    }
    // соединение входа и итогового выхода
    const exits = c.deals.filter((x) => x.entry !== 0);
    const last = exits[exits.length - 1];
    if (xa !== null && last && last.time + sh <= until) {
      const xl = xOf(last.time + sh), yl = yOf(last.price);
      if (xl !== null && yl !== null && ye !== null) { ctx.strokeStyle = (T.net >= 0 ? profit : loss) + "cc"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(xa, ye); ctx.lineTo(xl, yl); ctx.stroke(); ctx.setLineDash([]); }
    }
    // точные точки сделок
    c.deals.forEach((x, i) => {
      if (x.time + sh > until) return;
      const px = xOf(x.time + sh), py = yOf(x.price);
      if (px === null || py === null) return;
      const isIn = x.entry === 0, c2 = isIn ? acc : x.profit >= 0 ? profit : loss;
      ctx.fillStyle = c2; ctx.strokeStyle = panel; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, opts.compact ? 4 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (opts.compact) return;
      const up = (isIn ? dir > 0 : dir < 0);
      const ly = py + (up ? 18 : -18);
      const vol = x.volume ? ` ${x.volume}` : "";
      if (isIn) pill(ctx, px - 6, ly, `${dir > 0 ? "Buy" : "Sell"}${vol} · ${price(x.price, d)} · ${tfmt(x.time + sh)}`, acc, col("accentInk", "--accent-ink"), "right");
      else {
        const isLast = x === last;
        const rr = t.r ?? T.r, du = t.duration ?? (T.close_time ? T.close_time - T.open_time : null);
        const res = opts.backtest ? "" : (rr !== null && rr !== undefined ? " · " : "") + money(T.net);
        const tail = isLast && (T.status === "closed" || opts.backtest) ? ` · ${rr !== null && rr !== undefined ? rfmt(rr) : ""}${res}${du ? " · " + dur(du) : ""}` : ` · ${compact(x.profit)}`;
        pill(ctx, px + 6, ly, `Выход${vol} · ${price(x.price, d)} · ${tfmt(x.time + sh)}${tail}`, c2, "#fff");
      }
    });
    ctx.restore();
  };
  ts.subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(draw));
  chart.subscribeCrosshairMove(() => requestAnimationFrame(draw));
  const ro = new ResizeObserver(() => { try { requestAnimationFrame(draw); } catch (e) { ro.disconnect(); } });
  ro.observe(el);

  const fit = (k = 1) => {
    const span = Math.max(tOut - tIn, step * 12);
    try { ts.setVisibleRange({ from: tIn - span * (0.6 * k + 0.2), to: tOut + span * (0.4 * k + 0.1) }); } catch (e) { ts.fitContent(); }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(() => fit(opts.wide || 1));
  setTimeout(draw, 120);

  // снимок графика вместе со слоем позиции
  const compose = () => {
    draw();
    const shot = chart.takeScreenshot();
    const out = document.createElement("canvas");
    out.width = shot.width; out.height = shot.height;
    const ctx = out.getContext("2d");
    // у графика прозрачный фон: заливаем, чтобы картинка не просвечивала
    if (opts.transparent !== true) { ctx.fillStyle = th.bg && th.bg !== "transparent" && !th.bg.startsWith("rgba(0,0,0,0") ? th.bg : css("--surface"); ctx.fillRect(0, 0, out.width, out.height); }
    ctx.drawImage(shot, 0, 0);
    ctx.drawImage(cv, 0, 0, shot.width, shot.height);
    return out;
  };
  // воспроизведение сделки: свечи появляются по одной от начала окна до выхода (и немного после)
  const replay = (ctl = {}) => {
    const startT = Math.max(times[0], tIn - Math.max(tOut - tIn, step * 12) * 0.8);
    let i = Math.max(1, idxOf(startT));
    const endI = Math.min(bars.length - 1, Math.max(idxOf(tOut) + 12, i + 1));
    let timer = null, speed = ctl.speed || 1;
    const show = () => { until = bars[i].time + step - 1; series.setData(bars.slice(0, i + 1)); requestAnimationFrame(draw); ctl.onStep?.(i, endI); };
    try { ts.setVisibleRange({ from: startT, to: bars[endI].time }); } catch (e) {}
    const tick = () => { if (i >= endI) { stop(); ctl.onEnd?.(); return; } i++; show(); };
    const play = () => { stop(); timer = setInterval(tick, Math.max(30, 220 / speed)); };
    const stop = () => { clearInterval(timer); timer = null; };
    const reset = () => { stop(); until = Infinity; series.setData(bars); fit(1); };
    show();
    return { play, stop, step: tick, reset, setSpeed: (s) => { speed = s; if (timer) play(); }, playing: () => !!timer };
  };
  // точка на графике -> время и цена (для своих отметок); ближайшая свеча слева
  const pointAt = (pt) => {
    const p = series.coordinateToPrice(pt.y);
    const lg = ts.coordinateToLogical(pt.x);
    if (p === null || lg === null) return null;
    const k = Math.max(0, Math.min(bars.length - 1, Math.floor(lg)));
    const t = bars[k].time + Math.max(0, Math.min(1, lg - k)) * step;
    return { t: Math.round(t), p: +p.toFixed(d) };
  };
  const nearestTime = (t) => { const k = idxOf(t); return k >= 0 ? times[k] : times[0]; };
  return { chart, series, draw, fit, compose, replay, pointAt, nearestTime,
    setDrawings: (arr) => { drawings = arr || []; requestAnimationFrame(draw); } };
}
