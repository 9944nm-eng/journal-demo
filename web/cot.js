/* Вкладка COT: как читать отчёт, все рынки за неделю, разбор рынка простыми словами, ваши сделки и фон,
   график, механическое правило с проверкой на истории, история отчётов */
"use strict";

const ddmm = (d) => (d ? d.split("-").reverse().join(".") : "—");
const pctS = (v) => (v === null || v === undefined ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2).replace(".", ",") + "%");
const kS = (n) => { const a = Math.abs(n || 0); return (n > 0 ? "+" : n < 0 ? "−" : "") + (a >= 1000 ? (a / 1000).toFixed(a >= 100000 ? 0 : 1).replace(".", ",").replace(",0", "") + " тыс." : Math.round(a)); };
const BG = { 1: ["за рост", "ok"], "-1": ["за снижение", "bad"], 0: ["нет фона", "wait"] };
const SYM_NAME = { DE40: "GER40" };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} } };

// строка фона COT для плана недели и плана дня: сами направления в плане задаёт трейдер, журнал только подсказывает фон
const cotKey = (s) => { const u = String(s || "").toUpperCase().trim().replace(/[._\-+].*$/, ""); return { GER40: "DE40", GER30: "DE40", DAX40: "DE40" }[u] || u; };
function cotLine(sym, briefs, bias) {
  const c = (briefs || {})[cotKey(sym)];
  if (!c) return "";
  const [bl, bc] = { 1: ["за рост", "pos"], "-1": ["за снижение", "neg"], 0: ["нет фона", "muted"] }[c.bg];
  const b = bias === "long" ? 1 : bias === "short" ? -1 : 0;
  return `<div class="cot-line"><a href="#/cot/${esc(c.code)}">COT</a> ${esc(c.headline)}. Фон: <span class="${bc}">${bl}</span>${b && c.bg && b !== c.bg ? ' · <span class="neg">ваш план против потока фондов</span>' : ""}</div>`;
}

const COT_GUIDE = `
  <div class="cg-grid">
    <div><h3>Что это</h3><p>Раз в неделю американский регулятор CFTC публикует, кто держит фьючерсы на биржах США. Позиции снимаются во вторник, публикуются в пятницу вечером. К понедельнику данным уже 6 дней: это картина недели, а не дня.</p></div>
    <div><h3>Кто участвует</h3><p><b>Фонды</b> (крупные спекулянты) торгуют ради прибыли и обычно идут за трендом. Их поток - главное в отчёте.</p>
      <p><b>Хеджеры</b> (коммерсанты) страхуют реальный бизнес: продают на росте, покупают на падении. Почти всегда стоят против фондов.</p>
      <p><b>Мелкие трейдеры</b> - розница, на выводы почти не влияют.</p></div>
    <div><h3>Главные числа</h3><p><b>Нетто</b> - покупки минус продажи. Выше нуля - группа в целом ставит на рост.</p>
      <p><b>Изменение за 1 и 4 недели</b> - куда идут деньги прямо сейчас.</p>
      <p><b>Индекс 0-100</b> - где нетто сейчас относительно последних 3 лет: 100 - больше всего покупок, 0 - больше всего продаж.</p>
      <p><b>Открытый интерес</b> - сколько контрактов открыто всего. Растёт - в рынок входят новые деньги.</p></div>
  </div>
  <div class="cg-grid cg-2">
    <div><h3>Как читать за 5 минут в выходные</h3><ol>
      <li><b>Поток.</b> Фонды покупают или продают, и сколько недель подряд? Несколько недель в одну сторону - это фон.</li>
      <li><b>Переполненность.</b> Индекс выше 90 или ниже 10: почти все уже в позиции. Новых покупателей (продавцов) мало, резкий разворот вероятнее. Не догоняйте движение.</li>
      <li><b>Подтверждение.</b> Цена и открытый интерес растут вместе - за движением стоят новые деньги. Цена растёт, а интерес падает - это закрытие продаж, рост слабее.</li>
      <li><b>Запишите фон</b> одной строкой в <a href="#/week">план недели</a>: «золото - фонды выходят из лонгов 7 недель».</li></ol></div>
    <div><h3>Что COT может и чего не может</h3>
      <p>Вы торгуете внутри дня, а COT описывает недели. <b>Точку входа он не даёт</b> и на вопрос «сейчас лонг или шорт» не отвечает. Его польза - понимать, кто в рынке, переполнена ли позиция и есть ли за движением новые деньги.</p>
      <p>На истории ни один сигнал COT по вашим рынкам не прошёл проверку на случайность. Поэтому журнал показывает, как <b>вы сами</b> торгуете по фону и против него: так видно, стоит ли фону влиять на ваши решения.</p>
      <p class="muted">Только фьючерсы США: GER40 в отчётах нет. Валюты - фьючерсы к доллару: евро = EURUSD, иена = USDJPY наоборот.</p></div>
  </div>`;

function gaugeHTML(v, lo, hi, title) {
  if (v === null || v === undefined) return "";
  return `<div class="cg-gauge"><div class="row"><span>${title}</span><b>${Math.round(v)} <span class="muted" style="font-weight:400">из 100</span></b></div>
    <div class="cg-bar"><span class="z lo"></span><span class="z hi"></span><i style="left:${Math.max(0, Math.min(100, v))}%"></i></div>
    <div class="row muted" style="font-size:11px"><span>${lo}</span><span>обычно</span><span>${hi}</span></div></div>`;
}

function streakS(s) {
  if (!s) return '<span class="muted">—</span>';
  const n = Math.abs(s);
  return `<span class="${s > 0 ? "pos" : "neg"}">${s > 0 ? "покупают" : "продают"} ${n} ${plural(n, "нед.", "нед.", "нед.")}</span>`;
}

function boardHTML(b, code) {
  const rows = b.markets.map((k) => k.empty
    ? `<tr data-code="${esc(k.code)}" class="${k.code === code ? "on" : ""}"><td><b>${esc(k.name)}</b></td><td colspan="6" class="muted">нет данных, нажмите «Обновить данные»</td></tr>`
    : `<tr data-code="${esc(k.code)}" class="${k.code === code ? "on" : ""}">
      <td><b>${esc(k.name.split(" (")[0])}</b> <span class="muted">${esc(k.symbol || "")}</span></td>
      <td class="num">${kS(k.net)}</td><td class="num ${cls(k.chg_4w)}">${kS(k.chg_4w)}</td><td>${streakS(k.streak)}</td>
      <td><div class="cg-mini" title="Индекс позиции фондов за 3 года: ${k.index === null ? "—" : Math.round(k.index)}"><span class="z lo"></span><span class="z hi"></span>${k.index === null ? "" : `<i style="left:${k.index}%"></i>`}</div>
        ${k.index !== null && (k.index >= 90 || k.index <= 10) ? '<span class="pill warn" style="margin-left:6px">переполнено</span>' : ""}</td>
      <td><span class="pill ${BG[k.bg][1]}">${BG[k.bg][0]}</span></td>
      <td class="num">${k.mine || '<span class="muted">0</span>'}</td></tr>`).join("");
  const unc = b.uncovered.length ? `<p class="muted" style="font-size:12px;margin:10px 0 0">${b.uncovered.map(([s, n]) => `${esc(SYM_NAME[s] || s)} (${n} ${plural(n, "сделка", "сделки", "сделок")})`).join(", ")}: в отчётах CFTC ${b.uncovered.length > 1 ? "этих инструментов" : "этого инструмента"} нет или рынок не добавлен.
    ${b.uncovered.some(([s]) => s === "DE40") ? "DAX торгуется на европейской бирже Eurex, американский регулятор по ней не отчитывается. " : ""}${b.uncovered.some(([s]) => s === "US500") ? "Для US500 можно добавить рынок «S&P 500 E-mini» внизу страницы." : ""}</p>` : "";
  return `<section class="panel" style="margin-top:16px">
    <div class="panel-h"><h2>Все рынки за неделю</h2><span class="muted" style="font-size:12px">нажмите на строку, чтобы открыть разбор</span></div>
    <div class="panel-b tbl-wrap"><table class="t cot-board"><thead><tr><th>Рынок</th><th class="num">Нетто фондов</th><th class="num">За 4 нед.</th><th>Подряд</th>
      <th>Позиция фондов за 3 года</th><th>Фон для пары</th><th class="num">Ваших сделок</th></tr></thead><tbody>${rows}</tbody></table>${unc}</div></section>`;
}

function mineHTML(mine, sym) {
  if (!mine) return "";
  const g = mine.groups;
  const row = (name, x, c) => `<tr title="Сумма ${x.n ? rfmt(x.sum_r) : "—"}"><td><span class="pill ${c}">${name}</span></td><td class="num">${x.n}</td><td class="num">${x.win === null ? "—" : x.win + "%"}</td>
    <td class="num ${cls(x.avg_r)}">${x.avg_r === null ? "—" : rfmt(x.avg_r)}</td></tr>`;
  const REL = { with: ["по фону", "ok"], against: ["против", "bad"], neutral: ["без фона", "wait"] };
  return `<div class="cg-mine"><h3>Ваши сделки по ${esc(sym)} и фон COT</h3>
    ${mine.total ? `<table class="t"><thead><tr><th></th><th class="num">Сделок</th><th class="num">В плюс</th><th class="num">Средний R</th></tr></thead><tbody>
      ${row("По фону", g.with, "ok")}${row("Против фона", g.against, "bad")}${row("Без фона", g.neutral, "wait")}</tbody></table>` : ""}
    <p>${esc(mine.text)}</p>
    ${mine.trades.length ? `<details><summary class="muted" style="cursor:pointer;font-size:12px">Последние сделки (${mine.trades.length})</summary><div class="mini-list" style="margin-top:6px">
      ${mine.trades.map((t) => `<a class="row" href="#/trade/${t.login}/${t.position_id}"><span>${new Date(t.open_time * 1000).toLocaleDateString("ru-RU")} ${dirBadge(t.direction)}</span>
        <span><span class="pill ${REL[t.rel][1]}">${REL[t.rel][0]}</span> <b class="${cls(t.r)}">${t.r === null ? "—" : rfmt(t.r)}</b></span></a>`).join("")}</div></details>` : ""}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Фон - вердикт правила по последнему отчёту, вышедшему до дня сделки. Все счета вместе.</p></div>`;
}

function readHTML(d) {
  const r = d.read, mk = d.market, v = d.verdict;
  if (!r) return "";
  const when = `Позиции на вторник ${ddmm(v.date)}, опубликовано ${ddmm(v.release)}`;
  return `<section class="panel cot-read" style="margin-top:16px">
    <div class="cr-main">
      <div class="muted" style="font-size:12px">${esc(mk.name)} · ${when}</div>
      <h2 class="cr-head">${esc(r.headline)}</h2>
      <dl class="cr-items">${r.items.map((it) => `<div class="${it.tone ? "t-" + it.tone : ""}"><dt>${esc(it.k)}</dt><dd>${esc(it.t)}</dd></div>`).join("")}</dl>
    </div>
    <aside class="cr-side">
      <div class="cr-bg ${r.bg > 0 ? "long" : r.bg < 0 ? "short" : ""}"><span class="muted" style="font-size:12px">Что это значит для вас</span><b>${esc(r.bg_text)}</b></div>
      ${r.trust ? `<div class="cr-trust ${r.trust_tone}">${esc(r.trust)}</div>` : ""}
      <div id="cotProof"></div>
      ${gaugeHTML(r.index, "макс. продаж", "макс. покупок", "Позиция фондов")}
      ${gaugeHTML(r.index_c, "хеджеры продают", "хеджеры покупают", "Позиция хеджеров")}
      ${mineHTML(d.mine, mk.symbol)}
    </aside></section>`;
}

function verdictHTML(d, code) {
  const mk = d.market, v = d.verdict;
  if (!v) return "";
  const dirCls = v.direction > 0 ? "long" : v.direction < 0 ? "short" : "";
  const pos = Math.max(0, Math.min(100, 50 + (50 * v.score) / (v.max || 1)));
  return `<details class="panel" style="margin-top:16px"><summary class="panel-h"><h2>Механическое правило: откуда взялся фон ${hb("cot_verdict")}</h2>
      <span class="muted" style="font-size:12px">${esc(v.text)}, счёт ${v.score > 0 ? "+" : ""}${String(v.score).replace(".", ",")} из ±${String(v.max).replace(".", ",")}</span></summary>
    <div class="verdict" style="border-top:1px solid var(--line-soft)">
      <div class="vbox">
        <div class="vt ${dirCls}">${esc(v.text)}</div>
        <div class="gauge" title="Счёт ${v.score} из ±${v.max}"><i style="left:${pos}%"></i></div>
        <div class="muted" style="font-size:12px;display:flex;justify-content:space-between"><span>шорты</span><span>порог ±${String(v.threshold).replace(".", ",")}</span><span>лонги</span></div>
        ${mk.invert ? `<div class="pill wait" style="align-self:flex-start">Для ${esc(mk.symbol)} направление обратное: лонги по фьючерсу = шорты по паре</div>` : ""}
        <p class="muted" style="font-size:12px;margin:0">Каждый фактор даёт +1 (за рост фьючерса), −1 (за снижение) или 0 и умножается на вес. Сумма выше порога даёт вердикт. Веса и порог - в <a href="#/settings">настройках</a>.</p>
      </div>
      <div class="factors">${v.factors.map((f) => `<div class="factor"><div>${esc(f.name)}<div class="t">${esc(f.text)}</div>${f.why ? `<div class="t why">${esc(f.why)}</div>` : ""}</div>
        <span class="muted" style="font-size:12px">вес ${String(f.weight).replace(".", ",")}</span>
        <span class="sig ${cls(f.contrib)}">${f.contrib > 0 ? "+" : f.contrib < 0 ? "−" : ""}${String(Math.abs(f.contrib)).replace(".", ",")}</span></div>`).join("")}</div>
    </div>
    <div class="grid2" style="padding:0 20px 20px">
      <div><h3 class="cg-h3">Как правило работало на истории</h3>${backtestTable(d.summary, { ...mk, price_symbol: d.price_symbol, price_error: d.price_error })}
        <p class="muted" style="font-size:12px;margin:10px 0 0">«Верно» - цена через 1 или 4 недели ушла в сторону вердикта. Вердикт пересчитан на каждую неделю за 2 года только по данным, известным на день публикации. Движение считается от закрытия дня публикации${mk.invert ? ", для иены - движение самой иены, то есть USDJPY наоборот" : ""}, без спреда и комиссий. Около 50% - уровень монетки.</p></div>
      <div><h3 class="cg-h3">Последние вердикты</h3><div class="tbl-wrap" style="max-height:300px;overflow-y:auto"><table class="t"><thead><tr><th>Отчёт</th><th>Вердикт</th><th class="num">Счёт</th><th class="num">Цена через 1 нед.</th><th class="num">через 4 нед.</th></tr></thead><tbody>
        ${d.history.slice(0, 26).map((h) => `<tr><td>${ddmm(h.date)}</td><td class="${h.direction > 0 ? "pos" : h.direction < 0 ? "neg" : "muted"}">${h.direction > 0 ? "лонги" : h.direction < 0 ? "шорты" : "нейтрально"}</td>
          <td class="num">${String(h.score).replace(".", ",")}</td><td class="num ${cls(h.ret_1w)}">${pctS(h.ret_1w)}</td><td class="num ${cls(h.ret_4w)}">${pctS(h.ret_4w)}</td></tr>`).join("")}
      </tbody></table></div></div>
    </div></details>`;
}

async function renderCot(code) {
  const [m, b] = await Promise.all([api("/api/market"), api("/api/cot-board")]);
  const markets = m.markets;
  const cfg = `<details class="panel" style="margin-top:16px"${markets.length ? "" : " open"}><summary class="panel-h" style="cursor:pointer"><h2>Рынки и символы</h2><span class="muted" style="font-size:12px">${markets.length} ${plural(markets.length, "рынок", "рынка", "рынков")}</span></summary><div class="panel-b" id="mkCfg"></div></details>
    <p class="muted" style="font-size:12px;max-width:90ch;margin-top:12px">CFTC, отчёт Legacy Futures Only; managed money из Disaggregated (только товарные рынки). Цена: дневные свечи из вашего терминала MT5.</p>`;
  if (!markets.length) {
    view.innerHTML = `<div class="td-head"><h1>COT</h1></div>${emptyState("Рынки COT не выбраны", "Добавьте рынок ниже: журнал загрузит отчёты CFTC и разберёт их.")}${cfg}`;
    drawMarketCfg(m);
    return;
  }
  code = code || S.cotCode || markets[0].code;
  if (!markets.some((k) => k.code === code)) code = markets[0].code;
  S.cotCode = code;
  const d = await api(`/api/cot/${encodeURIComponent(code)}`);
  const last = b.markets.find((k) => !k.empty);
  const nr = b.next_release ? new Date(b.next_release * 1000) : null;
  const guideOpen = store.get("cotGuide") !== "closed";

  view.innerHTML = `
    <div class="td-head"><h1>COT</h1>
      <div style="display:flex;gap:10px;align-items:center"><span class="muted">${m.updated ? "данные " + ago(m.updated) : ""}</span>
        <button class="btn primary" id="cotUpd">Обновить данные</button></div></div>
    <p class="muted cot-when">${last ? `Последний отчёт: позиции на вторник ${ddmm(last.date)}.` : ""}${nr ? ` Следующий выйдет в ${nr.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })} около ${nr.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })} по вашему времени, в праздничные недели позже.` : ""}</p>
    <details class="panel cot-guide" id="cotGuide"${guideOpen ? " open" : ""}><summary class="panel-h"><h2>Как читать COT и зачем он вам</h2><span class="muted" style="font-size:12px">${guideOpen ? "свернуть" : "открыть"}</span></summary>
      <div class="panel-b">${COT_GUIDE}</div></details>
    ${boardHTML(b, code)}
    ${!d.rows.length ? emptyState("По этому рынку данных пока нет", "Нажмите «Обновить данные»: отчёты загрузятся с сайта CFTC.") : `
    ${readHTML(d)}
    <section class="panel" style="margin-top:16px">
      <div class="chart-tools"><b>Позиции групп и цена</b>
        <div class="seg" id="cotMode"><button data-m="abs" class="on">Контракты</button><button data-m="idx">Индекс 0-100</button></div>
        <div class="legend">
          ${d.price.length ? `<span><i style="color:var(--text);border-top-style:solid"></i>цена ${esc(d.market.symbol)}</span>` : ""}
          <span><i style="color:var(--profit);border-top-style:solid;border-top-width:6px"></i>фонды</span>
          <span><i style="color:var(--loss);border-top-style:solid"></i>хеджеры</span>
          ${d.series.some((p) => p.net_mm !== null) ? '<span><i style="color:var(--accent);border-top-style:solid"></i>managed money</span>' : ""}
          <span><i style="color:var(--muted);border-top-style:dotted"></i>мелкие трейдеры</span>
        </div></div>
      <div class="cot-chart" id="cotChart"></div>
      <p class="muted cot-howto" id="cotHow"></p>
    </section>
    ${verdictHTML(d, code)}
    <details class="panel" style="margin-top:16px" id="cotTestBox"><summary class="panel-h"><h2>Проверка сигналов на случайность ${hb("cot_test")}</h2><span class="muted" style="font-size:12px" id="cotTestSum">считаю…</span></summary>
      <div id="cotTest"><div class="panel-b empty"><span class="spin"></span> Проверяю сигналы на истории</div></div></details>
    <details class="panel" style="margin-top:16px"><summary class="panel-h"><h2>История отчётов ${hb("cot_hist")}</h2><span class="muted" style="font-size:12px">${d.rows.length} недель, ${esc(markets.find((k) => k.code === code)?.cot?.market_name || "")}</span></summary>
      <div class="panel-b tbl-wrap" id="cotHist"></div></details>`}${cfg}`;
  drawMarketCfg(m);

  $("#cotGuide").addEventListener("toggle", (e) => { store.set("cotGuide", e.target.open ? "open" : "closed"); e.target.querySelector("summary .muted").textContent = e.target.open ? "свернуть" : "открыть"; });
  view.querySelectorAll(".cot-board tr[data-code]").forEach((tr) => (tr.onclick = () => (location.hash = `#/cot/${tr.dataset.code}`)));
  $("#cotUpd").onclick = async () => {
    const bt = $("#cotUpd"); bt.disabled = true; bt.innerHTML = '<span class="spin"></span> Загружаю';
    try { const r = await api("/api/market/update", { method: "POST" }); toast(r.errors?.length ? r.errors.join("; ") : "Данные обновлены", !!r.errors?.length); }
    catch (e) { toast(e.message, true); }
    renderCot(code);
  };
  if (!d.rows.length) return;

  drawCotChart(d, "abs");
  $("#cotMode").querySelectorAll("button").forEach((bt) => (bt.onclick = () => {
    $("#cotMode").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === bt));
    drawCotChart(d, bt.dataset.m);
  }));

  // таблица истории
  const hmap = new Map(d.history.map((h) => [h.date, h]));
  let limit = 26;
  const drawHist = () => {
    $("#cotHist").innerHTML = `<table class="t"><thead><tr><th>Отчёт</th><th class="num">Открытый интерес</th><th class="num">Фонды лонг</th><th class="num">Фонды шорт</th>
      <th class="num">Нетто фондов</th><th class="num">Изм.</th><th class="num">Индекс фондов</th><th class="num">Хеджеры</th><th class="num">Изм.</th><th class="num">Индекс хедж.</th>
      <th class="num">Managed money</th><th class="num">Мелкие</th><th class="num">Фонды, % ОИ</th><th>Вердикт</th></tr></thead><tbody>
      ${d.rows.slice(0, limit).map((r) => { const h = hmap.get(r.date); return `<tr><td>${ddmm(r.date)}</td>
        <td class="num">${fmtInt(r.oi)} <span class="${cls(r.oi_chg)}" style="font-size:12px">${fmtInt(r.oi_chg, true)}</span></td>
        <td class="num">${fmtInt(r.nc_long)}</td><td class="num">${fmtInt(r.nc_short)}</td><td class="num"><b>${fmtInt(r.net_nc)}</b></td>
        <td class="num ${cls(r.net_nc_chg)}">${fmtInt(r.net_nc_chg, true)}</td><td class="num">${idxBadge(r.index_nc)}</td>
        <td class="num">${fmtInt(r.net_c)}</td><td class="num ${cls(r.net_c_chg)}">${fmtInt(r.net_c_chg, true)}</td><td class="num">${idxBadge(r.index_c)}</td>
        <td class="num">${r.net_mm === null ? "—" : fmtInt(r.net_mm)}</td><td class="num">${fmtInt(r.net_nr)}</td><td class="num">${r.pct_oi === null ? "—" : String(r.pct_oi).replace(".", ",") + "%"}</td>
        <td class="${h ? (h.direction > 0 ? "pos" : h.direction < 0 ? "neg" : "muted") : "muted"}">${h ? (h.direction > 0 ? "лонги" : h.direction < 0 ? "шорты" : "нейтрально") : ""}</td></tr>`; }).join("")}
      </tbody></table>
      ${limit < d.rows.length ? `<div style="text-align:center;margin-top:10px"><button class="btn sm" id="moreHist">Показать ещё 52 недели</button></div>` : ""}`;
    $("#moreHist")?.addEventListener("click", () => { limit += 52; drawHist(); });
  };
  drawHist();
  api("/api/cot-test").then((t) => drawCotTest(t, code)).catch((e) => ($("#cotTest").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`));
}

// индекс 0-100 по скользящему окну 3 года (156 недель), как в отчёте
function rollIndex(series, key) {
  return series.map((p, i) => {
    if (p[key] === null) return null;
    const w = series.slice(Math.max(0, i - 155), i + 1).map((x) => x[key]).filter((x) => x !== null);
    if (w.length < 26) return null;
    const lo = Math.min(...w), hi = Math.max(...w);
    return { time: p.time, value: hi > lo ? Math.round((1000 * (p[key] - lo)) / (hi - lo)) / 10 : 50 };
  }).filter(Boolean);
}

function drawCotChart(d, mode) {
  const box = $("#cotChart");
  if (!box) return;
  box.innerHTML = "";
  const profit = css("--profit"), loss = css("--loss"), muted = css("--muted"), acc = css("--accent"), text = css("--text");
  const ch = chartBase(box, { leftPriceScale: { visible: d.price.length > 0, borderColor: css("--line") }, timeScale: { borderColor: css("--line"), timeVisible: false } });
  const opts = { priceScaleId: "right", priceLineVisible: false, lastValueVisible: false };
  if (mode === "idx") {
    const f = ch.addLineSeries({ ...opts, color: profit, lineWidth: 2.5, lastValueVisible: true });
    f.setData(rollIndex(d.series, "net_nc"));
    f.createPriceLine({ price: 90, color: css("--warn"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "переполнено" });
    f.createPriceLine({ price: 10, color: css("--warn"), lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "переполнено" });
    ch.addLineSeries({ ...opts, color: loss, lineWidth: 1.5 }).setData(rollIndex(d.series, "net_c"));
    $("#cotHow").innerHTML = "<b>Как читать:</b> зелёная линия - где позиция фондов относительно последних 3 лет. У 100 фонды покупают больше, чем когда-либо за 3 года, у 0 - продают. За пунктиром 90 и 10 позиция переполнена: смотрите на цену в такие моменты - движение часто выдыхалось или разворачивалось. Красная линия - хеджеры, обычно зеркальна фондам.";
  } else {
    ch.addHistogramSeries({ priceScaleId: "right", priceFormat: { type: "volume" }, priceLineVisible: false })
      .setData(d.series.map((p) => ({ time: p.time, value: p.net_nc, color: (p.net_nc >= 0 ? profit : loss) + "99" })));
    const line = (key, color, style = 0, width = 2) => {
      const pts = d.series.filter((p) => p[key] !== null).map((p) => ({ time: p.time, value: p[key] }));
      if (pts.length) ch.addLineSeries({ ...opts, color, lineWidth: width, lineStyle: style }).setData(pts);
    };
    line("net_c", loss, 0, 1.5); line("net_mm", acc); line("net_nr", muted, 1, 1);
    $("#cotHow").innerHTML = "<b>Как читать:</b> столбики - нетто фондов: выше нуля фонды в целом покупают, ниже - продают. Важен не уровень, а поворот: несколько недель подряд столбики уменьшаются - фонды выходят из позиции. Сравните с ценой (тонкая линия, левая шкала): если цена растёт, а столбики уже падают, рост держится не на фондах. Красная линия - хеджеры, почти всегда против фондов.";
  }
  if (d.price.length) {
    const first = d.series[0].time;
    ch.addLineSeries({ priceScaleId: "left", color: text, lineWidth: 1.5, priceLineVisible: false }).setData(d.price.filter((p) => p.time >= first - 7 * 86400));
  }
  setTimeout(() => { try { ch.timeScale().fitContent(); } catch (e) {} }, 60);
}

function drawCotTest(t, code) {
  const box = $("#cotTest");
  if (!box) return;
  const sum = $("#cotTestSum");
  if (!t.n_tests) {
    box.innerHTML = '<div class="panel-b empty">Для проверки нужны дневные цены по символам рынков COT (синхронизация с терминалом).</div>';
    if (sum) sum.textContent = "нет цен";
    return;
  }
  const mine = t.markets.find((m) => m.code === code);
  const proof = $("#cotProof");
  if (proof) proof.innerHTML = mine && mine.passed.length
    ? `<span class="pill ok">Есть сигналы, прошедшие проверку на случайность: ${mine.passed.length}</span>`
    : '<span class="pill bad" title="Ни один сигнал COT по этому рынку не прошёл поправку на множественные проверки. Подробности - в «Проверке сигналов» ниже.">Сигналы COT по рынку не подтверждены статистикой</span>';
  if (sum) sum.textContent = `прошли проверку ${t.passed} из ${t.n_tests}`;
  const mx = Math.max(...t.hist, 1);
  box.innerHTML = `<div class="panel-b" style="border-top:1px solid var(--line-soft)">
      <p style="margin:0 0 14px;max-width:90ch">Журнал проверяет ${t.n_tests} ${plural(t.n_tests, "вариант", "варианта", "вариантов")}: ${t.markets.length} ${plural(t.markets.length, "рынок", "рынка", "рынков")} × 8 типовых сигналов COT × горизонты 1, 4 и 12 недель. Если перебрать столько вариантов, часть «сработает» случайно. Поэтому важно не сколько сигналов выглядят удачно, а сколько остаётся после поправки на перебор.</p>
      <div class="mc-kpi" style="margin-bottom:14px">
        <div class="panel"><span>Выглядят удачными (p &lt; 0,05)</span><b>${t.significant_raw}</b><small>так показал бы простой подбор</small></div>
        <div class="panel"><span>Столько дал бы чистый случай</span><b>${String(t.expected_random).replace(".", ",")}</b><small>при том же пороге</small></div>
        <div class="panel"><span>Проходят поправку</span><b class="${t.passed ? "pos" : "neg"}">${t.passed}</b><small>Беньямини-Хохберг, доля ложных 10%</small></div>
        <div class="panel"><span>Распределение p-значений</span><div style="display:flex;align-items:flex-end;gap:3px;height:42px;margin-top:6px">${t.hist.map((v, i) => `<i style="flex:1;height:${(100 * v) / mx}%;background:${i ? "var(--surface-2)" : "var(--accent)"};border-radius:2px" title="p ${i / 10}-${(i + 1) / 10}: ${v}"></i>`).join("")}</div><small>ровное распределение - сигнала нет</small></div>
      </div>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Рынок</th><th>Самый сильный сигнал</th><th class="num">Горизонт</th><th class="num">Случаев</th><th class="num">Превышение</th><th class="num">p</th><th class="num">q</th><th>Итог</th></tr></thead><tbody>
      ${t.markets.map((m) => `<tr><td><b>${esc(m.market)}</b></td><td>${esc(m.best.signal_name)}</td><td class="num">${m.best.h} нед.</td><td class="num">${m.best.n}</td>
        <td class="num ${cls(m.best.excess)}">${pctS(m.best.excess)}</td><td class="num">${String(m.best.p).replace(".", ",")}</td><td class="num">${String(m.best.q).replace(".", ",")}</td>
        <td>${m.passed.length ? `<span class="pill ok">прошёл: ${m.passed.length}</span>` : '<span class="pill wait">шум</span>'}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Превышение - средняя доходность после сигнала минус средняя доходность за всё время, по цене из вашего терминала. p считается по 200 случайным сдвигам дат сигналов. q - после поправки на все ${t.n_tests} тестов. Сигнал без поправки, который «выглядит значимым», чаще всего случайность.</p>
    </div>`;
}

function backtestTable(s, mk) {
  if (!s) return '<div class="empty">Нет данных</div>';
  const row = (name, x, dir) => `<tr><td>${name}</td><td class="num">${x.count}</td>
    <td class="num">${dir ? (x.ret_1w_hit === null ? "—" : String(x.ret_1w_hit).replace(".", ",") + "%") : "—"}</td><td class="num ${cls(x.ret_1w_avg)}">${pctS(x.ret_1w_avg)}</td>
    <td class="num">${dir ? (x.ret_4w_hit === null ? "—" : String(x.ret_4w_hit).replace(".", ",") + "%") : "—"}</td><td class="num ${cls(x.ret_4w_avg)}">${pctS(x.ret_4w_avg)}</td></tr>`;
  const noPrice = !s.long.ret_1w_n && !s.short.ret_1w_n && !s.neutral.ret_1w_n;
  return `<table class="t"><thead><tr><th>Вердикт</th><th class="num">Недель</th><th class="num">Верно 1 нед.</th><th class="num">Цена 1 нед.</th><th class="num">Верно 4 нед.</th><th class="num">Цена 4 нед.</th></tr></thead><tbody>
    ${row("Лонги", s.long, 1)}${row("Шорты", s.short, -1)}${row("Нейтрально", s.neutral, 0)}</tbody></table>
    ${noPrice ? `<p class="neg" style="font-size:12px">Нет дневных цен${mk.price_symbol ? ` по символу ${esc(mk.price_symbol)}` : ""}. ${esc(mk.price_error || "Нажмите «Обновить данные» при запущенном терминале.")} Название символа у брокера можно указать вручную внизу страницы (например XAUUSD.raw).</p>` : ""}`;
}
