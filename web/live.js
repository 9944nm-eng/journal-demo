/* Живое отслеживание: индикатор открытых позиций в шапке, режим «Сессия» на главной, «Открытые позиции» */
"use strict";

// предупреждения по ещё открытым позициям; о новом - всплывающее сообщение один раз
const openAlerts = (l) => (l.alerts || []).filter((a) => (l.positions || []).some((p) => p.position_id === a.position_id));
function announceAlerts(l) {
  S.seenAlerts = S.seenAlerts || new Set();
  for (const a of l.alerts || []) {
    const k = a.position_id + ":" + a.time;
    if (S.seenAlerts.has(k)) continue;
    S.seenAlerts.add(k);
    if (Date.now() / 1000 - a.time < 120) toast(`${a.symbol} ${a.direction > 0 ? "Buy" : "Sell"} ${a.volume}: не по ТС - ${a.items.join("; ")}`, true);
  }
}

// индикатор в шапке: открытые позиции и суммарный R; клик - «Сегодня» в режиме «Сессия»
function drawLiveBar() {
  const el = $("#livePill"), l = S.live;
  const ps = l && l.status === "live" ? l.positions || [] : [];
  el.classList.toggle("hidden", !ps.length);
  if (!ps.length) return;
  const bad = openAlerts(l).length, sumR = ps.reduce((a, p) => a + (p.r || 0), 0);
  el.style.background = bad ? "var(--loss-soft)" : sumR >= 0 ? "var(--profit-soft)" : "var(--loss-soft)";
  el.style.color = bad || sumR < 0 ? "var(--loss)" : "var(--profit)";
  el.title = ps.map((p) => `${p.symbol} ${p.direction === 1 ? "Buy" : "Sell"} ${p.volume}: ${p.r !== null ? rfmt(p.r) : "без стопа"}`).join("\n") + (bad ? `\nНе по ТС: ${bad}` : "");
  el.innerHTML = `<span class="lb-dot" aria-hidden="true" style="background:currentColor"></span>${ps.length === 1 ? esc(ps[0].symbol) : ps.length + " " + plural(ps.length, "позиция", "позиции", "позиций")} ${rfmt(Math.round(sumR * 100) / 100)}${bad ? " · не по ТС" : ""}`;
  el.onclick = (e) => { e.preventDefault(); S.todayMode = "trade"; if (location.hash.replace(/^#\/?/, "") === "") quietRefresh(); else location.hash = "#/"; };
}

function sparkR(series) {
  if (!series || series.length < 2) return "";
  const w = 220, h = 40, vals = series.map((x) => x[1]).concat([0]);
  const lo = Math.min(...vals), hi = Math.max(...vals), sp = hi - lo || 1;
  const y = (v) => 3 + (h - 6) * (1 - (v - lo) / sp);
  const d = series.map((x, i) => `${i ? "L" : "M"}${((i * w) / (series.length - 1)).toFixed(1)},${y(x[1]).toFixed(1)}`).join(" ");
  const last = series[series.length - 1][1];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-dasharray="3 3"/>
    <path d="${d}" fill="none" stroke="${last >= 0 ? "var(--profit)" : "var(--loss)"}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}

function slTpBar(p) {
  if (p.to_sl_r === null || p.to_tp_r === null || p.r === null) return "";
  const lo = p.r - p.to_sl_r, hi = p.r + p.to_tp_r, sp = hi - lo || 1;
  const pos = Math.max(0, Math.min(100, (100 * (p.r - lo)) / sp)), zero = Math.max(0, Math.min(100, (100 * (0 - lo)) / sp));
  return `<div class="sltp" title="От стопа до тейка, текущая цена отмечена"><i class="z" style="left:${zero}%"></i><i class="c" style="left:${pos}%"></i></div>
    <div class="row muted" style="font-size:11px"><span>стоп ${p.to_sl_r !== null ? rfmt(-p.to_sl_r) + " от цены" : ""}</span><span>тейк ${p.to_tp_r !== null ? rfmt(p.to_tp_r) + " от цены" : ""}</span></div>`;
}

function liveSectionHTML(l) {
  if (!l || l.status === "off") return `<section class="panel panel-b live-panel"><b>Живое отслеживание выключено.</b> <span class="muted">Включается в «Настройки» → «Живое отслеживание».</span></section>`;
  if (l.status !== "live") return `<section class="panel panel-b live-panel"><span class="lb-dot off"></span> <b>Ожидаю торговый терминал:</b> <span class="muted">${esc(l.reason || l.error || "")}. Журнал подключится сам, как только терминал будет запущен. ${l.status === "error" ? "" : 'Путь к торговому терминалу - в «Настройки» → «Живое отслеживание».'}</span></section>`;
  const lim = l.limits;
  const limRow = lim ? `<div class="live-lims">
    ${lim.daily_left !== undefined ? `<div><span>До дневного лимита${lim.day_reset_at ? `, сброс через <span data-reset="${lim.day_reset_at}">—</span>` : ""}</span><b class="${lim.daily_used_share > 0.7 ? "neg" : ""}">${nf2.format(lim.daily_left)}</b><div class="meter ${lim.daily_used_share > 0.8 ? "bad" : lim.daily_used_share > 0.5 ? "warn" : "use"}"><i style="width:${Math.max(0, Math.min(100, 100 * (lim.daily_used_share || 0)))}%"></i></div></div>` : ""}
    ${lim.total_left !== undefined ? `<div><span>До общего лимита</span><b>${nf2.format(lim.total_left)}</b></div>` : ""}
    ${lim.target_left !== undefined ? `<div><span>До цели</span><b class="${lim.target_left <= 0 ? "pos" : ""}">${lim.target_left <= 0 ? "достигнута" : nf2.format(lim.target_left)}</b></div>` : ""}
  </div>` : "";
  return `<section class="panel live-panel">
    <div class="panel-h"><h2><span class="lb-dot"></span> Сейчас в рынке: ${esc(l.label)} ${hb("live")}</h2><span class="muted" style="font-size:12px">обновлено ${new Date(l.updated * 1000).toLocaleTimeString("ru-RU")}</span></div>
    <div class="panel-b">
      <div class="live-acc"><div><span>Средства</span><b>${nf2.format(l.equity)} ${esc(l.currency || "")}</b></div><div><span>Плавающий результат</span><b class="${cls(l.floating)}">${money(l.floating)}</b></div><div><span>Баланс</span><b>${nf2.format(l.balance)}</b></div></div>
      ${limRow}
      <div class="live-pos">${(l.positions || []).map((p) => `<div class="lp">
        <div class="row"><span><b>${esc(p.symbol)}</b> ${dirBadge(p.direction)} <span class="muted">${p.volume} лот, вход ${price(p.price_open, p.digits)}</span></span><span class="muted" style="font-size:12px">${dur(Math.round(l.updated - p.opened))}</span></div>
        <div class="row" style="align-items:baseline"><span class="lp-r ${cls(p.r)}">${p.r !== null ? rfmt(p.r) : "без стопа"}</span><b class="${cls(p.profit)}">${money(p.profit)}</b></div>
        ${slTpBar(p)}
        <div class="row" style="font-size:12px"><span class="muted">лучшее <span class="pos">${rfmt(p.mfe_r)}</span>, худшее <span class="neg">${rfmt(p.mae_r)}</span></span><span class="muted">цена ${price(p.price_current, p.digits)}</span></div>
        ${sparkR(p.series)}
        ${(l.alerts || []).filter((a) => a.position_id === p.position_id).flatMap((a) => a.items).map((x) => `<div class="violation">${esc(x)}</div>`).join("")}
        ${p.sl === null ? '<div class="violation">У позиции нет стопа</div>' : p.sl_initial && p.sl !== p.sl_initial ? `<div class="muted" style="font-size:12px">стоп сдвинут: был ${price(p.sl_initial, p.digits)}, сейчас ${price(p.sl, p.digits)}</div>` : ""}
      </div>`).join("") || '<div class="empty">Открытых позиций нет.</div>'}</div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Журнал только читает данные из запущенного терминала: ничего не меняет и не закрывает. Лучшее и худшее значение считаются с момента, как журнал увидел позицию. Официальные лимиты - в кабинете фирмы.</p>
    </div></section>`;
}

// пользователь что-то вводит или выбирает на странице: фокус в поле, выбор в быстром разборе, действия за последние 20 секунд
let lastUserAct = 0;
["pointerdown", "keydown", "input"].forEach((ev) => document.addEventListener(ev, () => (lastUserAct = Date.now()), true));
function userBusy() {
  const a = document.activeElement;
  return (a && view.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || Date.now() - lastUserAct < 20000
    || !!view.querySelector(".qr-item .on, .qr-item .qr-why:not(:placeholder-shown)");
}

async function pollLive() {
  if (document.hidden) return;
  try { S.live = await (await fetch("/api/live")).json(); } catch (e) { return; }
  announceAlerts(S.live);
  drawLiveBar();
  // режим «Торговля» на главной обновляется вместе с терминалом, но не во время ввода:
  // перерисовка стирала выбор в быстром разборе и план выхода. Без позиций - только когда что-то изменилось
  if (/^#?\/?$/.test(location.hash) && document.querySelector('.mode-seg [data-m="trade"].on') && !S.syncing && !userBusy()) {
    const pos = S.live?.status === "live" ? S.live.positions || [] : [];
    const sig = (S.live?.status || "") + "|" + pos.map((p) => p.position_id).join(",");
    if (pos.length || sig !== S.liveSig) quietRefresh();
    S.liveSig = sig;
  }
  const box = $("#liveSection");
  if (box) box.innerHTML = liveSectionHTML(S.live);
}
setInterval(pollLive, 4000);
setTimeout(pollLive, 800);

/* обратный отсчёт до сброса дневного лимита */
function tickReset() {
  const now = Date.now() / 1000;
  document.querySelectorAll("[data-reset]").forEach((el) => {
    const left = Math.max(0, Math.round(+el.dataset.reset - now));
    const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = left % 60;
    el.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  });
}
setInterval(tickReset, 1000);
