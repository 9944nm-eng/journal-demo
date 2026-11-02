/* Карточка «Поделиться» для закрытой сделки: конструктор с предпросмотром, PNG и копирование */
"use strict";

const SHARE_THEMES = {
  dark: { bg1: "#0b1020", bg2: "#18213a", text: "#f2f5fb", muted: "#8d97ad", grid: "rgba(255,255,255,.05)", surface: "#111830", chartBg: "rgba(0,0,0,0)" },
  light: { bg1: "#f7f8fc", bg2: "#e6ebf5", text: "#121826", muted: "#5f6b80", grid: "rgba(0,0,0,.05)", surface: "#ffffff", chartBg: "rgba(0,0,0,0)" },
  accent: { bg1: "#0a0f24", bg2: null, text: "#ffffff", muted: "#b9c2e6", grid: "rgba(255,255,255,.06)", surface: "#101735", chartBg: "rgba(0,0,0,0)" },
};
const SHARE_FIELDS = [
  ["chart", "График с позицией"], ["prices", "Цены входа и выхода"], ["date", "Дата и время"], ["duration", "Длительность"],
  ["rr", "Плановое R:R"], ["setup", "Сетап"], ["volume", "Объём"], ["second", "Результат во второй единице"], ["caption", "Своя фраза"],
];

async function openShare(t, chartData) {
  const st = (await api("/api/settings")).share;
  const o = { ...st, fields: { ...st.fields } };
  const box = document.createElement("div");
  box.className = "share-modal";
  box.innerHTML = `<div class="share-box" role="dialog" aria-label="Поделиться сделкой">
    <div class="share-prev"><canvas id="shCanvas"></canvas></div>
    <div class="share-ctl">
      <div class="row" style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:16px">Карточка сделки</b><button class="btn sm" id="shClose" aria-label="Закрыть">✕</button></div>
      <label class="f"><span>Подпись (водяной знак)</span><input type="text" id="shWm" value="${esc(o.watermark || "")}"></label>
      <label class="f"><span>Заголовок</span><input type="text" id="shTitle" value="${esc(o.title || "")}"></label>
      <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label class="f"><span>Главный результат</span><select id="shUnit"><option value="R">в R</option><option value="$">в деньгах</option><option value="%">в % счёта</option></select></label>
        <label class="f"><span>Формат</span><select id="shFmt"><option value="square">Квадрат 1080×1080</option><option value="tall">Вертикальный 1080×1350</option><option value="wide">Широкий 1600×900</option></select></label>
      </div>
      <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <label class="f"><span>Шаблон</span><select id="shTpl"><option value="chart">С графиком свечей</option><option value="compact">Компактный с кривой сделки</option></select></label>
        <label class="f"><span>Фраза-плашка</span><input type="text" id="shTag" value="${esc(o.tag || "")}" placeholder="Проиграл сделку, а не игру"></label>
      </div>
      <label class="f"><span>Оформление</span><select id="shTheme"><option value="dark">Тёмное</option><option value="light">Светлое</option><option value="accent">Цвет акцента</option></select></label>
      <div class="f"><span class="muted" style="font-size:13px">Что показать</span><div class="sh-fields">${SHARE_FIELDS.map(([k, l]) => `<label><input type="checkbox" data-f="${k}" ${o.fields[k] ? "checked" : ""}> ${l}</label>`).join("")}</div></div>
      <label class="f"><span>Своя фраза</span><input type="text" id="shCap" value="${esc(o.caption || "")}" placeholder="Например: дисциплина важнее результата"></label>
      <p class="muted" style="font-size:12px;margin:0">Номер счёта, баланс и название фирмы на карточку не попадают. Делиться можно только закрытыми сделками.</p>
      <div class="form-foot" style="gap:6px;flex-wrap:wrap"><button class="btn sm" id="shSave">Запомнить настройки</button><span style="flex:1"></span><button class="btn" id="shCopy">Копировать</button><button class="btn primary" id="shDl">Скачать PNG</button></div>
    </div></div>`;
  document.body.appendChild(box);
  o.template = o.template || "chart";
  ["Unit", "Fmt", "Theme", "Tpl"].forEach((k) => (box.querySelector("#sh" + k).value = o[{ Unit: "unit", Fmt: "format", Theme: "theme", Tpl: "template" }[k]]));
  const close = () => { box.remove(); offscreen?.remove(); };
  box.querySelector("#shClose").onclick = close;
  box.onclick = (e) => { if (e.target === box) close(); };
  document.addEventListener("keydown", function esc1(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc1); } });

  let offscreen = null, chartImg = null, chartKey = "";
  const canvas = box.querySelector("#shCanvas");
  const makeChart = async () => {
    const W = o.format === "wide" ? 900 : 960, H = o.format === "wide" ? 620 : 430;
    const key = o.theme + o.format;
    if (chartImg && chartKey === key) return chartImg;
    offscreen?.remove();
    offscreen = document.createElement("div");
    offscreen.style.cssText = `position:fixed;left:-5000px;top:0;width:${W}px;height:${H}px`;
    document.body.appendChild(offscreen);
    const th = SHARE_THEMES[o.theme];
    const pc = renderTradeChart(offscreen, chartData, t, { theme: { bg: th.chartBg, grid: th.grid, text: th.text, muted: th.muted, surface: th.surface,
      profit: css("--profit"), loss: css("--loss"), accent: o.theme === "light" ? css("--accent") : css("--accent"), accentInk: css("--accent-ink") }, levels: false, fontSize: 13, share: true });
    await new Promise((r) => setTimeout(r, 350));
    pc.draw();
    chartImg = pc.compose();
    chartKey = key;
    return chartImg;
  };
  const render = async () => {
    if (o.template === "compact") return drawCompactCard(canvas, t, chartData, o);
    drawShareCard(canvas, t, chartData, o);
  };
  box.querySelectorAll("[data-f]").forEach((cb) => (cb.onchange = () => { o.fields[cb.dataset.f] = cb.checked; render(); }));
  const bind = (id, key, ev = "input") => (box.querySelector(id)[ev === "input" ? "oninput" : "onchange"] = (e) => { o[key] = e.target.value; render(); });
  bind("#shWm", "watermark"); bind("#shTitle", "title"); bind("#shCap", "caption");
  bind("#shUnit", "unit", "change"); bind("#shFmt", "format", "change"); bind("#shTheme", "theme", "change");
  bind("#shTpl", "template", "change"); bind("#shTag", "tag");
  box.querySelector("#shDl").onclick = () => { const a = document.createElement("a"); a.download = `trade-${t.symbol}-${t.position_id}.png`; a.href = canvas.toDataURL("image/png"); a.click(); };
  box.querySelector("#shCopy").onclick = () => canvas.toBlob(async (b) => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); toast("Картинка скопирована"); }
    catch (e) { toast("Браузер не дал скопировать картинку: используйте «Скачать PNG»", true); }
  });
  box.querySelector("#shSave").onclick = async () => {
    await api("/api/settings/share", { method: "PUT", body: JSON.stringify(o) }); toast("Настройки карточки сохранены");
  };
  render();
}

/* ---------- общие элементы оформления ---------- */
const SH_FONT = (px, w = 700) => `${w} ${px}px ${css("--font") || "sans-serif"}`;
function shBackground(ctx, W, H, th, rc, acc) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, th.bg2 || acc); g.addColorStop(0.55, th.bg1); g.addColorStop(1, th.bg1);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, c, a) => { const gg = ctx.createRadialGradient(x, y, 0, x, y, r); gg.addColorStop(0, c + a); gg.addColorStop(1, c + "00"); ctx.fillStyle = gg; ctx.fillRect(0, 0, W, H); };
  glow(W * 0.85, H * 0.08, W * 0.75, rc, "38");
  glow(W * 0.05, H * 0.95, W * 0.6, acc, "22");
  // мелкая точечная фактура
  ctx.fillStyle = th.grid;
  for (let x = 24; x < W; x += 36) for (let y = 24; y < H; y += 36) { ctx.beginPath(); ctx.arc(x, y, 1.1, 0, Math.PI * 2); ctx.fill(); }
}
function shLogo(ctx, x, y, th, acc, profit, loss) {
  [[0, 12, 18, profit], [11, 0, 30, acc], [22, 16, 14, loss]].forEach(([dx, dy, h, c]) => { ctx.fillStyle = c; ctx.beginPath(); ctx.roundRect(x + dx, y + dy, 8, h, 2); ctx.fill(); });
}
function shPill(ctx, x, y, txt, px, bg, fg, border, padX = 18, h = null) {
  ctx.font = SH_FONT(px, 700);
  const w = ctx.measureText(txt).width + padX * 2, hh = h || px * 1.9;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x, y, w, hh, hh / 2); ctx.fill();
  if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1.5; ctx.stroke(); }
  ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.fillText(txt, x + padX, y + hh / 2 + 1); ctx.textBaseline = "alphabetic";
  return w;
}
function shChips(ctx, x, y, w, items, th, light, cols) {
  const gap = 14, cw = (w - gap * (cols - 1)) / cols, ch = 104;
  items.forEach(([k, v], i) => {
    const cx = x + (i % cols) * (cw + gap), cy = y + Math.floor(i / cols) * (ch + gap);
    ctx.fillStyle = light ? "rgba(20,30,60,.05)" : "rgba(255,255,255,.055)";
    ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, 20); ctx.fill();
    ctx.strokeStyle = light ? "rgba(20,30,60,.08)" : "rgba(255,255,255,.08)"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = SH_FONT(19, 600); ctx.fillStyle = th.muted; ctx.fillText(k.toUpperCase(), cx + 22, cy + 38);
    // значение уменьшается по ширине плашки, а не обрезается
    let fs = 31, vv = String(v);
    ctx.font = SH_FONT(fs, 700);
    while (ctx.measureText(vv).width > cw - 40 && fs > 20) { fs -= 1; ctx.font = SH_FONT(fs, 700); }
    while (ctx.measureText(vv).width > cw - 40 && vv.length > 4) vv = vv.slice(0, -2) + "…";
    ctx.fillStyle = th.text; ctx.fillText(vv, cx + 22, cy + 80);
  });
  return Math.ceil(items.length / cols) * (ch + gap) - gap;
}

/* ---------- график, нарисованный в стиле карточки ---------- */
function shChart(ctx, box, t, c, th, light) {
  if (!c || !c.bars || c.bars.length < 3) return false;
  const profit = css("--profit"), loss = css("--loss"), acc = css("--accent");
  const sh = c.shift || 0, T = c.trade || t;
  const tIn = t.open_time + sh, tOut = (t.close_time || t.open_time) + sh;
  let bars = c.bars.map((b) => ({ ...b, time: b.time + sh }));
  const step = bars.length > 1 ? bars[1].time - bars[0].time : 60;
  const pad = Math.max((tOut - tIn) * 0.9, step * 18);
  bars = bars.filter((b) => b.time >= tIn - pad && b.time <= tOut + pad * 0.7);
  // не больше ~70 свечей: объединяем мелкие в крупные
  const k = Math.max(1, Math.ceil(bars.length / 70));
  if (k > 1) {
    const agg = [];
    for (let i = 0; i < bars.length; i += k) {
      const g = bars.slice(i, i + k);
      agg.push({ time: g[0].time, open: g[0].open, close: g[g.length - 1].close, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)) });
    }
    bars = agg;
  }
  if (bars.length < 3) return false;
  const span = (bars[bars.length - 1].time - bars[0].time) || 1;
  const sl = t.sl_used || T.sl_initial, tp = t.tp_initial || T.tp_initial;
  const levels = [t.entry_price, t.exit_price, sl, tp].filter(Boolean);
  let lo = Math.min(...bars.map((b) => b.low), ...levels), hi = Math.max(...bars.map((b) => b.high), ...levels);
  const m = (hi - lo) * 0.1; lo -= m; hi += m;
  const X = (tt) => box.x + ((tt - bars[0].time) / span) * box.w;
  const Y = (p) => box.y + box.h * (1 - (p - lo) / (hi - lo));
  const slot = box.w / bars.length;
  ctx.save(); ctx.beginPath(); ctx.rect(box.x - 40, box.y - 30, box.w + 80, box.h + 60); ctx.clip();
  // блок позиции
  const xa = X(tIn), xb = Math.max(X(tOut), xa + slot), ye = Y(t.entry_price);
  const zone = (lvl, col) => {
    if (!lvl) return;
    const y = Y(lvl), top = Math.min(y, ye), hh = Math.abs(y - ye);
    const g = ctx.createLinearGradient(0, top, 0, top + hh);
    const farTop = y < ye;
    g.addColorStop(farTop ? 0 : 1, col + "50"); g.addColorStop(farTop ? 1 : 0, col + "10");
    ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect(xa, top, xb - xa, hh, 10); ctx.fill();
    ctx.strokeStyle = col + "70"; ctx.lineWidth = 1.5; ctx.stroke();
  };
  zone(tp, profit); zone(sl, loss);
  // свечи
  bars.forEach((b, i) => {
    const x = box.x + slot * (i + 0.5), up = b.close >= b.open, col = up ? profit : loss;
    const inTrade = b.time + step * k > tIn && b.time <= tOut;
    ctx.globalAlpha = inTrade ? 1 : 0.55;
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, slot * 0.12);
    ctx.beginPath(); ctx.moveTo(x, Y(b.high)); ctx.lineTo(x, Y(b.low)); ctx.stroke();
    const bw = Math.max(3, slot * 0.62), y1 = Y(Math.max(b.open, b.close)), y2 = Y(Math.min(b.open, b.close));
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(x - bw / 2, y1, bw, Math.max(2, y2 - y1), Math.min(3, bw / 3)); ctx.fill();
  });
  ctx.globalAlpha = 1;
  // линия входа и путь к выходу
  ctx.strokeStyle = light ? "rgba(20,30,60,.55)" : "rgba(255,255,255,.7)"; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
  ctx.beginPath(); ctx.moveTo(xa, ye); ctx.lineTo(xb, ye); ctx.stroke();
  const rc = t.net >= 0 ? profit : loss;
  if (t.exit_price) { ctx.strokeStyle = rc; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(xa, ye); ctx.lineTo(X(tOut), Y(t.exit_price)); ctx.stroke(); }
  ctx.setLineDash([]);
  // точки со свечением
  const dot = (x, y, col) => {
    ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 28;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.fillStyle = light ? "#fff" : th.bg1; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill();
  };
  dot(xa, ye, acc);
  if (t.exit_price) dot(X(tOut), Y(t.exit_price), rc);
  ctx.restore();
  // подписи
  const lab = (x, y, txt, col, below) => {
    ctx.font = SH_FONT(21, 700);
    const w = ctx.measureText(txt).width + 30, hh = 40;
    let px = Math.max(box.x, Math.min(x - w / 2, box.x + box.w - w));
    const py = below ? y + 22 : y - 22 - hh;
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(px, py, w, hh, 12); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(txt, px + 15, py + hh / 2 + 1); ctx.textBaseline = "alphabetic";
  };
  const longT = t.direction === 1;
  lab(xa, ye, `ВХОД  ${price(t.entry_price, t.digits)}`, acc, longT);
  if (t.exit_price) lab(X(tOut), Y(t.exit_price), `ВЫХОД  ${price(t.exit_price, t.digits)}`, rc, !longT ? t.exit_price < t.entry_price : t.exit_price < t.entry_price);
  return true;
}

function drawShareCard(cv, t, c, o) {
  const wide = o.format === "wide", tall = o.format === "tall";
  const W = wide ? 1600 : 1080, H = wide ? 900 : tall ? 1350 : 1080;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const th = SHARE_THEMES[o.theme] || SHARE_THEMES.dark, light = o.theme === "light";
  const profit = css("--profit"), loss = css("--loss"), acc = css("--accent");
  const rc = t.net >= 0 ? profit : loss;
  shBackground(ctx, W, H, th, rc, acc);
  const P = 72;
  // верхняя строка: знак и дата
  shLogo(ctx, P, P - 6, th, acc, profit, loss);
  ctx.font = SH_FONT(28, 800); ctx.fillStyle = th.text; ctx.textBaseline = "alphabetic";
  if (o.watermark) ctx.fillText(o.watermark, P + 46, P + 22);
  const right = [o.title, o.fields.date ? dt(t.close_time || t.open_time, false) : ""].filter(Boolean).join("  ·  ");
  if (right) { ctx.font = SH_FONT(22, 600); ctx.fillStyle = th.muted; const rw = ctx.measureText(right.toUpperCase()).width; ctx.fillText(right.toUpperCase(), W - P - rw, P + 20); }
  // инструмент, направление, результат
  const colW = wide ? 640 : W - 2 * P;
  let y = P + 118;
  ctx.font = SH_FONT(58, 800); ctx.fillStyle = th.text; ctx.fillText(t.symbol, P, y);
  const sw = ctx.measureText(t.symbol).width;
  const dc = t.direction === 1 ? profit : loss;
  shPill(ctx, P + sw + 22, y - 44, t.direction === 1 ? "↗ BUY" : "↘ SELL", 24, dc + "26", dc, dc + "55");
  if (o.tag) { y += 30; shPill(ctx, P, y, o.tag, 24, light ? "rgba(20,30,60,.06)" : "rgba(255,255,255,.07)", th.text, light ? "rgba(20,30,60,.12)" : "rgba(255,255,255,.14)"); y += 46; }
  const base = S.st?.base || S.st?.deposits;
  const val = { R: t.r !== null && t.r !== undefined ? rfmt(t.r) : null, "$": money0(t.net), "%": base ? pct0((100 * t.net) / base) : null };
  const main = val[o.unit] || val["$"];
  y += wide ? 170 : 160;
  ctx.save(); ctx.shadowColor = rc + (light ? "55" : "99"); ctx.shadowBlur = light ? 18 : 40;
  ctx.font = SH_FONT(wide ? 150 : 148, 800); ctx.fillStyle = rc; ctx.fillText(main, P - 6, y); ctx.restore();
  if (o.fields.second) {
    const sec = Object.entries(val).filter(([, v]) => v && v !== main).map(([, v]) => v).slice(0, 2).join("   ");
    ctx.font = SH_FONT(34, 600); ctx.fillStyle = th.muted; ctx.fillText(sec, P, y + 54);
  }
  // детали
  const items = [];
  if (o.fields.prices) { items.push(["Вход", price(t.entry_price, t.digits)]); items.push(["Выход", price(t.exit_price, t.digits)]); }
  if (o.fields.duration) items.push(["Время в сделке", dur(t.duration)]);
  if (o.fields.rr && t.sl_used && t.tp_initial) items.push(["Плановое R:R", "1:" + (Math.abs(t.tp_initial - t.entry_price) / Math.abs(t.entry_price - t.sl_used)).toFixed(1).replace(".", ",")]);
  if (o.fields.setup && t.setup) items.push(["Сетап", t.setup]);
  if (o.fields.volume) items.push(["Объём", t.volume + " лот"]);
  const hasChart = o.fields.chart && c && c.bars && c.bars.length > 2;
  if (wide) {
    // слева текст и плашки, справа график
    const used = shChips(ctx, P, y + (o.fields.second ? 100 : 60), colW - 20, items.slice(0, 6), th, light, 2);
    if (hasChart) shChart(ctx, { x: 760, y: 170, w: W - 760 - P, h: H - 170 - 150 }, t, c, th, light);
  } else {
    const chipRows = Math.ceil(Math.min(items.length, 4) / 4) || 0;
    const chipsH = items.length ? (items.length > 4 ? 2 : 1) * 118 : 0;
    const capH = o.fields.caption && o.caption ? 56 : 0;
    const chartTop = y + (o.fields.second ? 100 : 56), chartBottom = H - P - chipsH - capH - 30;
    if (hasChart && chartBottom - chartTop > 160) shChart(ctx, { x: P + 10, y: chartTop + 20, w: W - 2 * P - 20, h: chartBottom - chartTop - 40 }, t, c, th, light);
    if (items.length) shChips(ctx, P, H - P - chipsH - capH + 14, W - 2 * P, items.slice(0, 8), th, light, Math.min(4, items.length > 4 ? Math.ceil(items.length / 2) : items.length));
  }
  if (o.fields.caption && o.caption) {
    ctx.font = SH_FONT(26, 500); ctx.fillStyle = th.muted;
    let cap = o.caption; while (ctx.measureText(cap).width > W - 2 * P && cap.length > 4) cap = cap.slice(0, -2) + "…";
    ctx.fillText(cap, P, H - P + 16);
  }
}
const money0 = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + nf2.format(Math.abs(n)) + (ccy() ? " " + ccy() : "");
const pct0 = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + "%";


/* компактный шаблон: кривая результата внутри сделки, крупный фоновый знак, список деталей */
function tradePath(t, c) {
  if (!c || !c.bars || !c.bars.length) return [];
  const sh = c.shift || 0, a = t.open_time + sh, b = (t.close_time || t.open_time) + sh;
  const risk = t.sl_used ? Math.abs(t.entry_price - t.sl_used) : null;
  const pts = c.bars.filter((x) => x.time + 0 >= a - 60 && x.time <= b).map((x) => ((x.close - t.entry_price) * t.direction) / (risk || t.entry_price / 100));
  if (pts.length) { pts[0] = 0; if (t.r !== null && t.r !== undefined && risk) pts.push(t.r); }
  return pts;
}

function drawCompactCard(cv, t, c, o) {
  const wide = o.format === "wide";
  const W = wide ? 1600 : 1080, H = wide ? 900 : o.format === "tall" ? 1350 : 1080;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const th = SHARE_THEMES[o.theme] || SHARE_THEMES.dark;
  const profit = css("--profit"), loss = css("--loss"), acc = css("--accent");
  const rc = t.net >= 0 ? profit : loss;
  const F = (px, w = 700) => `${w} ${px}px ${css("--font") || "sans-serif"}`;
  shBackground(ctx, W, H, th, rc, acc);
  // крупный полупрозрачный знак на фоне
  if (o.watermark) {
    ctx.save(); ctx.globalAlpha = 0.06; ctx.fillStyle = th.text; ctx.font = F(wide ? 260 : 210, 800);
    const tw = ctx.measureText(o.watermark).width, sc = Math.min(1, (W - 80) / tw);
    ctx.translate(W / 2, H * (wide ? 0.55 : 0.47)); ctx.scale(sc, sc); ctx.textAlign = "center"; ctx.fillText(o.watermark, 0, 80); ctx.restore();
  }
  const P = 80;
  let y = P + 40;
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  ctx.font = F(54, 800); ctx.fillStyle = th.text; ctx.fillText(t.symbol, P, y);
  const sw = ctx.measureText(t.symbol).width;
  ctx.font = F(32, 700); ctx.fillStyle = t.direction === 1 ? profit : loss;
  ctx.fillText((t.direction === 1 ? "↗ Лонг" : "↘ Шорт"), P + sw + 26, y - 4);
  if (o.watermark) { ctx.font = F(26, 800); ctx.fillStyle = th.muted; const w2 = ctx.measureText(o.watermark).width; ctx.fillText(o.watermark, W - P - w2, y - 8); }
  if (o.tag) {
    y += 34; ctx.font = F(28, 600);
    const tw = ctx.measureText(o.tag).width + 40;
    ctx.strokeStyle = th.grid.replace(/[\d.]+\)$/, ".25)"); ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(P, y, tw, 56, 14); ctx.stroke();
    ctx.fillStyle = th.text; ctx.fillText(o.tag, P + 20, y + 38);
    y += 56;
  }
  y += 90;
  ctx.font = F(30, 600); ctx.fillStyle = th.muted; ctx.fillText("Результат", P, y);
  const base = S.st?.base || S.st?.deposits;
  const val = { R: t.r !== null && t.r !== undefined ? rfmt(t.r) : null, "$": money0(t.net), "%": base ? pct0((100 * t.net) / base) : null };
  const main = val[o.unit] || val["$"];
  y += 92; ctx.font = F(96, 800); ctx.fillStyle = rc; ctx.fillText(main, P - 3, y);
  if (o.fields.second) {
    const mw = ctx.measureText(main).width;
    const sec = Object.entries(val).filter(([k, v]) => v && v !== main).map(([, v]) => v)[0];
    if (sec) { ctx.font = F(36, 600); ctx.fillStyle = rc + "cc"; ctx.fillText(sec, P + mw + 24, y - 6); }
  }
  // кривая результата внутри сделки
  const path = o.fields.chart ? tradePath(t, c) : [];
  const chartH = wide ? 300 : o.format === "tall" ? 440 : 300, chartY = y + 50;
  if (path.length > 2) {
    const lo = Math.min(0, ...path), hi = Math.max(0, ...path), sp = hi - lo || 1;
    const X = (i) => P + ((W - 2 * P) * i) / (path.length - 1), Y = (v) => chartY + chartH * (1 - (v - lo) / sp);
    ctx.strokeStyle = th.muted + "55"; ctx.setLineDash([6, 8]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(P, Y(0)); ctx.lineTo(W - P, Y(0)); ctx.stroke(); ctx.setLineDash([]);
    const grad = ctx.createLinearGradient(0, chartY, 0, chartY + chartH);
    grad.addColorStop(0, rc + "55"); grad.addColorStop(1, rc + "00");
    ctx.beginPath(); ctx.moveTo(X(0), Y(path[0]));
    for (let i = 1; i < path.length; i++) { const xm = (X(i - 1) + X(i)) / 2; ctx.bezierCurveTo(xm, Y(path[i - 1]), xm, Y(path[i]), X(i), Y(path[i])); }
    ctx.lineTo(X(path.length - 1), chartY + chartH); ctx.lineTo(X(0), chartY + chartH); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); ctx.moveTo(X(0), Y(path[0]));
    for (let i = 1; i < path.length; i++) { const xm = (X(i - 1) + X(i)) / 2; ctx.bezierCurveTo(xm, Y(path[i - 1]), xm, Y(path[i]), X(i), Y(path[i])); }
    ctx.strokeStyle = rc; ctx.lineWidth = 5; ctx.lineJoin = "round"; ctx.stroke();
    ctx.fillStyle = rc; ctx.beginPath(); ctx.arc(X(path.length - 1), Y(path[path.length - 1]), 9, 0, Math.PI * 2); ctx.fill();
    y = chartY + chartH + 30;
  } else y += 40;
  // детали списком
  const rows = [];
  if (o.fields.prices) { rows.push(["Цена входа", price(t.entry_price, t.digits)]); rows.push(["Цена выхода", price(t.exit_price, t.digits)]); }
  if (o.fields.date) { rows.push(["Открыта", dt(t.open_time)]); rows.push(["Закрыта", dt(t.close_time)]); }
  if (o.fields.duration) rows.push(["Время в позиции", dur(t.duration)]);
  if (o.fields.rr && t.sl_used && t.tp_initial) rows.push(["Плановое R:R", "1:" + (Math.abs(t.tp_initial - t.entry_price) / Math.abs(t.entry_price - t.sl_used)).toFixed(1).replace(".", ",")]);
  if (o.fields.setup && t.setup) rows.push(["Сетап", t.setup]);
  if (o.fields.volume) rows.push(["Объём", t.volume + " лот"]);
  const rh = 54, room = Math.floor((H - P - y - (o.fields.caption && o.caption ? 50 : 0)) / rh);
  rows.slice(0, Math.max(0, room)).forEach(([k, v], i) => {
    const yy = y + 30 + i * rh;
    ctx.font = F(30, 500); ctx.fillStyle = th.muted; ctx.textAlign = "left"; ctx.fillText(k, P, yy);
    ctx.font = F(30, 700); ctx.fillStyle = th.text; ctx.textAlign = "right"; ctx.fillText(String(v), W - P, yy);
    ctx.textAlign = "left";
  });
  if (o.fields.caption && o.caption) { ctx.font = F(26, 500); ctx.fillStyle = th.muted; ctx.fillText(o.caption, P, H - P + 20); }
}
