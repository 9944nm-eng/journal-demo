/* Рынок: макро-ряды; настройка отслеживаемых рынков COT (рисуется на странице COT) */
"use strict";

async function renderMarket() {
  const m = await api("/api/market");
  view.innerHTML = `
    <div class="td-head"><h1>Макро ${hb("mk_macro")}</h1>
      <div style="display:flex;gap:10px;align-items:center"><span class="muted">${m.updated ? ago(m.updated) : "данные ещё не загружались"}</span>
      <button class="btn primary" id="mkUpd">Обновить данные</button></div></div>
    ${m.errors.length ? `<section class="panel panel-b" style="margin-bottom:16px"><b class="neg">Часть данных не загрузилась</b>
      <ul class="muted" style="margin:6px 0 0;padding-left:18px">${m.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
      <p class="muted" style="font-size:12px;margin:6px 0 0">Нужен доступ в интернет к publicreporting.cftc.gov и fred.stlouisfed.org. Повтор будет при следующей синхронизации.</p></section>` : ""}
    <div class="macro-grid" id="mkMacro">${m.macro.length ? "" : emptyState("Макро-данных пока нет", "Нажмите «Обновить данные»: ряды загрузятся с FRED.")}</div>
    <p class="muted" style="font-size:12px;max-width:90ch;margin-top:12px">Источник: FRED (Федрезерв Сент-Луиса). Это данные для анализа, а не сигналы.</p>`;

  $("#mkUpd").onclick = async () => {
    const b = $("#mkUpd"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Загружаю';
    try {
      const r = await api("/api/market/update", { method: "POST" });
      toast(r.errors?.length ? `Загружено с ошибками: ${r.errors.length}` : "Данные обновлены", !!r.errors?.length);
    } catch (e) { toast(e.message, true); }
    renderMarket();
  };


  const mEl = $("#mkMacro");
  for (const v of m.macro) {
    const card = document.createElement("section");
    card.className = "panel macro-card";
    card.innerHTML = `<div class="muted" style="font-size:13px">${esc(v.name)} <span style="font-size:11px">${esc(v.id)}</span></div>
      <div><span class="v">${fmtVal(v.value, v.unit)}</span>
      <span class="${cls(v.chg_w)}" style="font-size:12px;margin-left:6px">${fmtChg(v.chg_w)} нед.</span>
      <span class="${cls(v.chg_m)}" style="font-size:12px;margin-left:6px">${fmtChg(v.chg_m)} мес.</span></div>
      <div class="macro-chart"></div><div class="muted" style="font-size:11px">на ${v.date.split("-").reverse().join(".")}</div>`;
    mEl.appendChild(card);
    const ch = chartBase(card.querySelector(".macro-chart"), {
      rightPriceScale: { visible: false }, timeScale: { visible: false }, grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      handleScroll: false, handleScale: false, crosshair: { mode: 0, vertLine: { visible: false }, horzLine: { visible: false } },
    });
    const acc = css("--accent");
    const s = ch.addAreaSeries({ lineColor: acc, topColor: acc + "33", bottomColor: acc + "00", lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false });
    s.setData(v.series.slice(-260));
    setTimeout(() => { try { ch.timeScale().fitContent(); } catch (e) {} }, 60);
  }
}

function drawMarketCfg(m) {
  const box = $("#mkCfg");
  let list = m.markets.map((k) => ({ code: k.code, name: k.name, symbol: k.symbol || "" }));
  const draw = () => {
    box.innerHTML = `
      <table class="t"><thead><tr><th>Код CFTC</th><th>Название</th><th>Символ в MT5</th><th></th></tr></thead><tbody>
      ${list.map((x, i) => `<tr><td><input type="text" data-i="${i}" data-k="code" value="${esc(x.code)}" style="width:110px"></td>
        <td><input type="text" data-i="${i}" data-k="name" value="${esc(x.name)}"></td>
        <td><input type="text" data-i="${i}" data-k="symbol" value="${esc(x.symbol)}" placeholder="XAUUSD" style="width:140px"></td>
        <td class="num"><button class="btn sm" data-del="${i}">Убрать</button></td></tr>`).join("")}</tbody></table>
      <div class="filters" style="margin:12px 0 0">
        <select id="mkAdd" style="width:auto"><option value="">Добавить рынок…</option>
          ${m.known.filter((k) => !list.some((x) => x.code === k.code)).map((k) => `<option value="${k.code}">${esc(k.name)} (${k.code})</option>`).join("")}
          <option value="custom">Свой код CFTC</option></select>
        <span class="spacer"></span><button class="btn primary" id="mkSave">Сохранить и загрузить</button>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Символ нужен для графика цены и для показа COT в карточке сделки. Укажите его так, как он называется у вашего брокера (например XAUUSD, GOLD, XAUUSD.r). Название рынка, которое вернёт CFTC, видно над графиком: по нему можно проверить, что код верный.</p>`;
    box.querySelectorAll("input[data-i]").forEach((inp) => (inp.oninput = () => { list[+inp.dataset.i][inp.dataset.k] = inp.value; }));
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { list.splice(+b.dataset.del, 1); draw(); }));
    $("#mkAdd").onchange = (e) => {
      const v = e.target.value;
      if (v === "custom") list.push({ code: "", name: "", symbol: "" });
      else if (v) list.push({ ...m.known.find((k) => k.code === v) });
      draw();
    };
    $("#mkSave").onclick = async () => {
      const b = $("#mkSave"); b.disabled = true; b.innerHTML = '<span class="spin"></span> Сохраняю';
      try {
        await api("/api/market/config", { method: "PUT", body: JSON.stringify({ cot_markets: list.filter((x) => x.code) }) });
        await api("/api/market/update", { method: "POST" });
        toast("Рынки сохранены");
      } catch (e) { toast(e.message, true); }
      route();
    };
  };
  draw();
}
