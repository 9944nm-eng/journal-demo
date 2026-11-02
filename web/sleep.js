/* Сон из Apple Watch: плитка на «Сегодня», предупреждение после плохой ночи, раздел в «Дисциплине», настройки.
   Данные приходят файлом из «Команд» iPhone через папку OneDrive (journal/sleep.py). */
"use strict";

const durHM = (m) => (m === null || m === undefined ? "—" : m < 60 ? `${Math.round(m)} мин` : `${Math.floor(m / 60)} ч ${String(Math.round(m % 60)).padStart(2, "0")} мин`);
const durDelta = (m) => (m > 0 ? "+" : m < 0 ? "−" : "±") + (Math.abs(m) >= 60 ? `${Math.floor(Math.abs(m) / 60)} ч ${String(Math.abs(m) % 60).padStart(2, "0")} мин` : `${Math.abs(m)} мин`);
const clockOf = (ts) => new Date(ts * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

// ночь, после которой торгуем сегодня (дата пробуждения = сегодня)
const lastNight = (s) => (s?.nights || []).find((n) => n.date === todayStr()) || null;

// насколько ночь хуже нормы: null - нормально или данных мало
function sleepIssue(s) {
  const n = lastNight(s), nm = s?.norm;
  if (!n || !nm) return null;
  const short = nm.asleep && n.asleep < nm.asleep - 60, lowHrv = nm.hrv && n.hrv && n.hrv < nm.hrv * 0.85;
  if (!short && !lowHrv) return null;
  const parts = [];
  if (short) parts.push(`сон ${durHM(n.asleep)} при норме ${durHM(nm.asleep)}`);
  if (lowHrv) parts.push(`HRV ${n.hrv} мс при норме ${nm.hrv}`);
  const im = s.impact;
  let tip = "Снизь риск или сократи число входов.";
  const g = short ? (im?.enough ? [im.short, im.normal] : null) : (im?.enough_hrv ? [im.low_hrv, im.ok_hrv] : null);
  if (g && g[0].avg_r !== null && g[1].avg_r !== null) tip = `После таких ночей твой средний результат ${rfmt(g[0].avg_r)} на сделку против ${rfmt(g[1].avg_r)}, нарушений ТС ${g[0].vio_rate}% против ${g[1].vio_rate}%.`;
  return { text: parts.join(", ").replace(/^./, (x) => x.toUpperCase()) + ".", tip };
}

function stageBar(n) {
  if (!n.stages) return "";
  const tot = n.deep + n.rem + n.core + n.awake || 1, w = (v) => (100 * v) / tot;
  return `<div class="sleep-bar" role="img" aria-label="Глубокий ${durHM(n.deep)}, быстрый ${durHM(n.rem)}, базовый ${durHM(n.core)}, пробуждения ${n.awake} мин">
      <i class="deep" style="width:${w(n.deep)}%"></i><i class="rem" style="width:${w(n.rem)}%"></i><i class="core" style="width:${w(n.core)}%"></i><i class="awake" style="width:${w(n.awake)}%"></i></div>
    <div class="sleep-legend"><span><i class="deep"></i>глубокий ${durHM(n.deep)}</span><span><i class="rem"></i>быстрый ${durHM(n.rem)}</span><span><i class="core"></i>базовый ${durHM(n.core)}</span>${n.awake ? `<span><i class="awake"></i>пробуждения ${n.awake} мин</span>` : ""}</div>`;
}

function sleepTile(c) {
  const s = c.sleep;
  if (!s || !s.enabled) return "";
  const head = `<div class="tile-h"><h2 id="tsl">Сон</h2><a href="#/discipline">Подробнее</a></div>`;
  if (!s.total_nights) return `<section class="tile" aria-labelledby="tsl">${head}
      <p class="muted" style="margin:0;font-size:14px">${s.busy ? esc(s.message || "Импортирую…") : s.folder_ok ? "Журнал ждёт файл из «Команд» iPhone в папке OneDrive." : "Данные о сне не подключены: создайте папку и команду на iPhone."}</p>
      ${s.folder_ok ? "" : '<a class="btn sm" href="#/settings" style="margin-top:12px">Настроить</a>'}</section>`;
  const n = lastNight(s), nm = s.norm;
  if (!n) {
    const prev = s.nights.at(-1);
    return `<section class="tile" aria-labelledby="tsl">${head}<p class="muted" style="margin:0;font-size:14px">За эту ночь данных пока нет${prev ? ` (последняя - ${prev.date.split("-").reverse().join(".")})` : ""}. Файл приходит утром, когда iPhone выполнит команду.</p></section>`;
  }
  const d = nm?.asleep ? n.asleep - nm.asleep : null;
  return `<section class="tile" aria-labelledby="tsl">${head}
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="t-mid ${d !== null && d < -60 ? "neg" : ""}" style="font-size:30px">${durHM(n.asleep)}</span>
      <span class="muted" style="font-size:13px">${clockOf(n.bed)} – ${clockOf(n.wake)}${d !== null ? ` · ${durDelta(d)} к норме` : ""}</span></div>
    ${stageBar(n)}
    <div class="sleep-kv">${n.hrv ? `<span>HRV <b class="${nm?.hrv && n.hrv < nm.hrv * 0.85 ? "neg" : ""}">${n.hrv} мс</b>${nm?.hrv ? ` <small>норма ${nm.hrv}</small>` : ""}</span>` : ""}
      ${n.rhr ? `<span>Пульс покоя <b>${n.rhr}</b>${nm?.rhr ? ` <small>норма ${nm.rhr}</small>` : ""}</span>` : ""}
      ${n.efficiency ? `<span>Эффективность <b>${n.efficiency}%</b></span>` : ""}</div>
    ${debtLine(s, c)}
    ${nm ? "" : `<p class="muted" style="margin:10px 0 0;font-size:12px">Норма появится через ${7 - s.total_nights} ${plural(7 - s.total_nights, "ночь", "ночи", "ночей")}.</p>`}
  </section>`;
}

// долг сна за 3 ночи и сколько вы будете на ногах к началу окна ТС
function debtLine(s, c) {
  const nm = s.norm, last3 = (s.nights || []).slice(-3), n = lastNight(s);
  const parts = [];
  if (nm?.asleep && last3.length === 3) {
    const debt = last3.reduce((a, x) => a + x.asleep - nm.asleep, 0);
    if (Math.abs(debt) >= 30) parts.push(`за 3 ночи <b class="${debt < -90 ? "neg" : ""}">${durDelta(debt)}</b> к норме`);
  }
  if (n && c?.win && c.now < c.win.end && !c.weekend) {
    const h = (Math.max(c.now, c.win.start) - n.wake) / 3600;
    if (h > 0) parts.push(`к ${c.now < c.win.start ? "началу окна ТС" : "этому моменту"} на ногах <b>${String(Math.round(h * 10) / 10).replace(".", ",")} ч</b>`);
  }
  return parts.length ? `<p class="muted" style="margin:12px 0 0;font-size:13px">${parts.join(" · ").replace(/^./, (x) => x.toUpperCase())}</p>` : "";
}

// выходные: сон за неделю и регулярность отбоя (разброс времени засыпания)
function sleepWeekTile(c) {
  const s = c.sleep;
  if (!s?.enabled || !s.total_nights) return "";
  const wk = s.nights.slice(-7);
  const avg = Math.round(wk.reduce((a, x) => a + x.asleep, 0) / wk.length);
  const bm = wk.map((x) => { const d = new Date(x.bed * 1000); return (d.getHours() * 60 + d.getMinutes() - 18 * 60 + 1440) % 1440; });
  const mean = bm.reduce((a, x) => a + x, 0) / bm.length;
  const spread = Math.round(Math.sqrt(bm.reduce((a, x) => a + (x - mean) ** 2, 0) / bm.length));
  const avgBed = (() => { const m = Math.round(mean + 18 * 60) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; })();
  return `<section class="tile" aria-labelledby="tsw"><div class="tile-h"><h2 id="tsw">Сон за неделю</h2><a href="#/discipline">Подробнее</a></div>
    <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap"><span class="t-mid" style="font-size:30px">${durHM(avg)}</span><span class="muted" style="font-size:13px">в среднем за ${wk.length} ${plural(wk.length, "ночь", "ночи", "ночей")}${s.norm?.asleep ? ` · ${durDelta(avg - s.norm.asleep)} к норме` : ""}</span></div>
    <div class="sleep-kv"><span>Отбой в среднем <b>${avgBed}</b></span><span>Разброс <b class="${spread > 60 ? "neg" : ""}">±${durHM(spread)}</b></span></div>
    <p class="muted" style="margin:10px 0 0;font-size:12px">${spread > 60 ? "Отбой гуляет больше чем на час: ровный режим перед новой неделей помогает держать дисциплину." : "Режим ровный."}</p></section>`;
}

/* Аналитика → Дисциплина: последние ночи и связь сна с результатом */
async function sleepSection(box) {
  let s;
  try { s = await api("/api/sleep?impact=1"); } catch (e) { box.innerHTML = ""; return; }
  if (!s.enabled) { box.innerHTML = ""; return; }
  if (!s.total_nights) {
    box.innerHTML = `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сон и торговля</h2></div>
      <div class="panel-b muted" style="font-size:14px">Данных о сне пока нет. Подключение Apple Watch через «Команды» и OneDrive - в «Настройки» → «Сон».</div></section>`;
    return;
  }
  const ns = s.nights.slice(-30), mx = Math.max(...ns.map((n) => n.asleep), s.norm?.asleep || 0, 480);
  const im = s.impact;
  const row = (title, a, b, la, lb) => `<tr><td>${title}</td>
      <td class="num">${a.days}</td><td class="num ${cls(a.avg_r)}">${a.avg_r !== null ? rfmt(a.avg_r) : "—"}</td><td class="num">${a.win_rate ?? "—"}%</td><td class="num ${a.vio_rate > (b.vio_rate ?? 0) ? "neg" : ""}">${a.vio_rate ?? "—"}%</td><td class="muted">${la}</td></tr>
    <tr><td></td><td class="num">${b.days}</td><td class="num ${cls(b.avg_r)}">${b.avg_r !== null ? rfmt(b.avg_r) : "—"}</td><td class="num">${b.win_rate ?? "—"}%</td><td class="num">${b.vio_rate ?? "—"}%</td><td class="muted">${lb}</td></tr>`;
  box.innerHTML = `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Сон и торговля</h2><span class="muted" style="font-size:12px">${s.total_nights} ${plural(s.total_nights, "ночь", "ночи", "ночей")}${s.norm ? ` · норма ${durHM(s.norm.asleep)}${s.norm.hrv ? `, HRV ${s.norm.hrv} мс` : ""}` : ""}</span></div>
    <div class="panel-b">
      <div class="sleep-nights" role="img" aria-label="Длительность сна за последние ${ns.length} ночей">${ns.map((n) => `<div title="${n.date.split("-").reverse().join(".")}: ${durHM(n.asleep)}${n.hrv ? `, HRV ${n.hrv}` : ""}">
        <i style="height:${(100 * n.asleep) / mx}%" class="${s.norm && n.asleep < s.norm.asleep - 60 ? "short" : ""}"></i></div>`).join("")}
        ${s.norm ? `<span class="sleep-norm" style="bottom:${(100 * s.norm.asleep) / mx}%"></span>` : ""}</div>
      ${im ? `<div class="tbl-wrap" style="margin-top:16px"><table class="t"><thead><tr><th>Ночь перед торговым днём</th><th class="num">Дней</th><th class="num">Средний R</th><th class="num">Прибыльных</th><th class="num">Нарушений ТС</th><th></th></tr></thead><tbody>
        ${row("Сон", im.short, im.normal, "меньше нормы на час и больше", "в пределах нормы")}
        ${im.low_hrv.days + im.ok_hrv.days ? row("HRV", im.low_hrv, im.ok_hrv, "ниже нормы на 15%+", "в пределах нормы") : ""}
      </tbody></table></div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">${im.enough ? "Сравнение по всем счетам: сделки дня относятся к ночи перед ним." : "Выводы появятся, когда в каждой группе наберётся хотя бы 5 торговых дней."} Это наблюдение, а не причина: проверяй на следующих неделях.</p>` : '<p class="muted" style="margin:12px 0 0;font-size:13px">Сравнение с торговлей появится, когда наберётся 7 ночей для нормы.</p>'}
    </div></section>`;
}

/* Настройки → Сон */
function sleepSettingsHTML(st) {
  return `<section class="panel"><div class="panel-h"><h2>Сон (Apple Watch)</h2></div>
    <div class="panel-b" id="slBox">
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="slOn" ${st.sleep?.enabled !== false ? "checked" : ""}> Брать данные о сне из папки OneDrive</label>
      <label class="f" style="margin-top:10px"><span>Папка с файлами из «Команд»</span><input type="text" id="slFolder" value="${esc(st.sleep?.folder || "")}" placeholder="по умолчанию OneDrive\\Журнал\\Сон"></label>
      <div id="slStatus" class="muted" style="font-size:13px;margin-top:10px"><span class="spin"></span></div>
      <p class="muted" style="font-size:12px">iPhone каждое утро сохраняет файл в эту папку, OneDrive переносит его на ПК, журнал забирает новые файлы сам. Историю за прошлое можно добавить разом: «Здоровье» → профиль → «Экспортировать все медданные», файл export.zip положить в ту же папку. Журнал ничего не отправляет, данные только приходят на этот ПК. Пошаговая инструкция - в README, раздел «Сон из Apple Watch».</p>
      <div class="form-foot"><button class="btn sm" id="slMk">Создать папку</button><button class="btn sm" id="slScan">Проверить сейчас</button><button class="btn primary sm" id="slSave">Сохранить</button></div>
    </div></section>`;
}
async function bindSleepSettings() {
  const draw = async (rescan) => {
    try {
      const s = await api("/api/sleep" + (rescan ? "?rescan=1" : ""));
      const f = s.files[0];
      $("#slStatus").innerHTML = `${s.folder_ok ? `Папка: <b>${esc(s.folder)}</b>` : `<span class="neg">Папки нет:</span> ${esc(s.folder)}`}<br>
        ${s.busy ? `<span class="spin"></span> ${esc(s.message)}` : `Ночей в журнале: <b>${s.total_nights}</b>${f ? ` · последний файл ${esc(f.name)}${f.error ? ` <span class="neg">ошибка: ${esc(f.error)}</span>` : `, записей ${f.rows}`}` : " · файлов ещё не было"}`}`;
      if (s.busy) setTimeout(() => $("#slStatus") && draw(false), 3000);
    } catch (e) { $("#slStatus").textContent = e.message; }
  };
  draw(false);
  const save = () => saveSetting("sleep", { enabled: $("#slOn").checked, folder: $("#slFolder").value.trim() });
  $("#slSave").onclick = async () => { await save(); draw(true); };
  $("#slMk").onclick = async () => { try { await save(); const r = await api("/api/sleep/folder", { method: "POST" }); toast("Папка готова: " + r.folder); draw(true); } catch (e) { toast(e.message, true); } };
  $("#slScan").onclick = () => draw(true);
}
