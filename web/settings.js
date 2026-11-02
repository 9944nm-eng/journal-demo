/* Настройки: сессии, чек-лист, резервные копии, правило вердикта COT */
"use strict";

const VERDICT_FIELDS = [
  ["w_funds_1w", "Вес: изменение позиции фондов за неделю"], ["w_funds_4w", "Вес: изменение позиции фондов за 4 недели"],
  ["w_mm_4w", "Вес: managed money за 4 недели"], ["w_extreme", "Вес: экстремум позиции фондов (против толпы)"],
  ["w_commercials", "Вес: экстремум позиции коммерсантов"], ["w_macro", "Вес: макро (реальная доходность, доллар)"],
  ["threshold", "Порог вердикта (сумма баллов)"], ["extreme_hi", "Экстремум лонгов: индекс от"], ["extreme_lo", "Экстремум шортов: индекс до"],
];

async function renderSettings() {
  const st = await api("/api/settings");
  view.innerHTML = `
    <div class="td-head"><h1>Настройки</h1></div>
    <div class="set-layout">
      <nav class="set-nav" aria-label="Разделы настроек"><a href="#set-trade" data-jump="set-trade">Торговля</a><a href="#set-view" data-jump="set-view">Журнал</a><a href="#set-data" data-jump="set-data">Данные и MT5</a><a href="#set-market" data-jump="set-market">Рынок</a><a href="#set-about" data-jump="set-about">Запуск и обновление</a></nav>
      <div class="set-main">
      <h2 class="set-group" id="set-trade">Торговля</h2>
      <div class="set-grid">
      <section class="panel"><div class="panel-h"><h2>Чек-лист перед входом</h2></div>
        <div class="panel-b"><p class="muted" style="font-size:12px;margin:0 0 10px">Пункты показываются в карточке каждой сделки. Как пункты связаны с результатом - в «Аналитика → Преимущество → Исполнение».</p>
        <div class="list-edit" id="ckList"></div>
        <div class="form-foot" style="margin-top:10px"><button class="btn sm" id="ckAdd">Добавить пункт</button><button class="btn primary sm" id="ckSave">Сохранить</button></div></div></section>
      <section class="panel"><div class="panel-h"><h2>План до рынка</h2></div>
        <div class="panel-b"><p class="muted" style="font-size:12px;margin:0 0 10px">Пункты, которые отмечаются на «Сегодня» перед сессией, до первой сделки.</p>
        <div class="list-edit" id="dckList"></div>
        <div class="form-foot" style="margin-top:10px"><button class="btn sm" id="dckAdd">Добавить пункт</button><button class="btn primary sm" id="dckSave">Сохранить</button></div></div></section>
      <section class="panel"><div class="panel-h"><h2>Торговые сессии</h2></div>
        <div class="panel-b"><p class="muted" style="font-size:12px;margin:0 0 10px">Часы по UTC. Сделка относится к сессии по времени входа. Время сервера брокера пересчитывается в UTC автоматически.</p>
        <div class="list-edit" id="sesList"></div>
        <div class="form-foot" style="margin-top:10px"><button class="btn sm" id="sesAdd">Добавить сессию</button><button class="btn primary sm" id="sesSave">Сохранить</button></div></div></section>
      <section class="panel"><div class="panel-h"><h2>Риск</h2></div>
        <div class="panel-b"><label class="f"><span>Максимальный риск на сделку, % счёта</span><input type="number" step="0.05" id="riskMax" value="${st.risk.max_risk_pct}" style="max-width:160px"></label>
        <p class="muted" style="font-size:12px">Используется в «Инсайтах» и в «Что если»: сделки с риском выше этого значения отмечаются отдельно.</p>
        <div class="form-foot"><span></span><button class="btn primary sm" id="riskSave">Сохранить</button></div></div></section>
      </div>
      <h2 class="set-group" id="set-view">Журнал</h2>
      <div class="set-grid">
      <section class="panel"><div class="panel-h"><h2>Оформление</h2></div>
        <div class="panel-b">
          <div class="f"><span>Тема</span>
            <div class="seg" id="setTheme" style="align-self:flex-start">${[["system", "Как в Windows"], ["dark", "Тёмная"], ["light", "Светлая"]].map(([k, l]) => `<button type="button" data-t="${k}" class="${(localStorage.getItem("theme") || "system") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:14px"><input type="checkbox" id="motionChk" ${localStorage.getItem("motion") !== "off" ? "checked" : ""}> Анимации: переходы между разделами, бегунок вкладок, прорисовка графиков</label>
          <p class="muted" style="font-size:12px;margin-bottom:0">Если в Windows включено «Уменьшить анимацию», журнал её не показывает.</p></div></section>
      <section class="panel"><div class="panel-h"><h2>Недельный разбор</h2></div>
        <div class="panel-b">
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rmOn" ${st.reminder.enabled ? "checked" : ""}> Напоминать о недельном разборе</label>
          <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
            <label class="f"><span>С какого дня</span><select id="rmDay"><option value="5" ${st.reminder.day == 5 ? "selected" : ""}>суббота</option><option value="6" ${st.reminder.day == 6 ? "selected" : ""}>воскресенье</option></select></label>
            <label class="f"><span>С какого времени</span><input type="time" id="rmTime" value="${esc(st.reminder.time)}"></label></div>
          <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="rmWin" ${st.reminder.windows ? "checked" : ""}> Уведомление Windows из значка в трее (раз в день, пока разбор не сделан)</label>
          <p class="muted" style="font-size:12px">В выходные в журнале появляется баннер, в понедельник и вторник - если разбор прошлой недели не сделан.</p>
          <div class="form-foot"><span></span><button class="btn primary sm" id="rmSave">Сохранить</button></div></div></section>
      </div>
      <h2 class="set-group" id="set-data">Данные и MT5</h2>
      <div class="set-grid">
      <section class="panel"><div class="panel-h"><h2>Синхронизация ${hb("sync")}</h2></div>
        <div class="panel-b">
          <label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="syAuto" ${st.sync.auto ? "checked" : ""}> Автоматическая синхронизация</label>
          <label class="f"><span>Общий интервал</span><select id="syMin" style="max-width:240px">${[5, 15, 30, 60, 240].map((m) => `<option value="${m}" ${st.sync.minutes === m ? "selected" : ""}>${m < 60 ? `каждые ${m} минут` : m === 60 ? "каждый час" : "каждые 4 часа"}</option>`).join("")}</select></label>
          <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="syStart" ${st.sync.on_start !== false ? "checked" : ""}> Синхронизировать при запуске журнала</label>
          <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="syWeekend" ${st.sync.weekend_pause !== false ? "checked" : ""}> Не синхронизировать самому в выходные (рынок закрыт с вечера пятницы до вечера воскресенья)</label>
          <p class="muted" style="font-size:12px">Свой интервал для отдельного счёта задаётся в «Счета» → «Изменить». Работает, пока запущен журнал, и через задачу планировщика (install_task.bat запускает проверку каждые 5 минут, журнал сам решает, каким счетам пора).</p>
          <div class="form-foot"><span></span><button class="btn primary sm" id="sySave">Сохранить</button></div></div></section>
      <section class="panel"><div class="panel-h"><h2>Живое отслеживание ${hb("live")}</h2></div>
        <div class="panel-b">
          <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="lvOn" ${st.live.enabled ? "checked" : ""}> Следить за позициями, пока запущен торговый терминал</label>
          <label class="f" style="margin-top:10px"><span>Как часто обновлять</span><select id="lvInt" style="max-width:200px">${[3, 5, 10, 30].map((v) => `<option value="${v}" ${st.live.interval == v ? "selected" : ""}>каждые ${v} секунд</option>`).join("")}</select></label>
          <label class="f" style="margin-top:10px"><span>Путь к торговому терминалу (terminal64.exe), по одному на строку</span><textarea id="lvPaths" rows="2" placeholder="C:\\Program Files\\Alpha Capital MT5\\terminal64.exe">${esc((st.live.paths || []).join("\n"))}</textarea></label>
          <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="lvAcc" ${st.live.use_account_paths !== false ? "checked" : ""}> Также следить за терминалами, указанными у счетов</label>
          <p class="muted" style="font-size:12px">Журнал подключается только к уже запущенному терминалу и сам его не запускает. Если открыто несколько, берётся первый по списку: сначала пути отсюда, затем пути счетов. Пакет MetaTrader5 работает с одним терминалом за раз, поэтому плановая синхронизация ненадолго прерывает отслеживание.</p>
          <div class="form-foot"><span></span><button class="btn primary sm" id="lvSave">Сохранить</button></div></div></section>
      <section class="panel"><div class="panel-h"><h2>Резервные копии базы</h2></div>
        <div class="panel-b">
          <div class="row2" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;align-items:end">
            <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bkOn" ${st.backup.enabled ? "checked" : ""}> Делать копии</label>
            <label class="f"><span>Раз в, часов</span><input type="number" id="bkEvery" value="${st.backup.every_hours}" min="1"></label>
            <label class="f"><span>Хранить копий</span><input type="number" id="bkKeep" value="${st.backup.keep}" min="1" max="100"></label>
          </div>
          <div class="tbl-wrap"><table class="t" style="margin-top:12px"><thead><tr><th>Файл</th><th>Создан</th><th class="num">Размер</th></tr></thead><tbody>
            ${st.backups.length ? st.backups.map((b) => `<tr><td>${esc(b.name)}</td><td>${localTime(b.time)}</td><td class="num">${(b.size / 1048576).toFixed(1).replace(".", ",")} МБ</td></tr>`).join("") : '<tr><td colspan="3" class="muted">Копий пока нет</td></tr>'}
          </tbody></table></div>
          <p class="muted" style="font-size:12px">Папка: ${esc(st.backup_dir)}. Скриншоты лежат отдельно в data\\shots. Для восстановления закройте журнал и скопируйте нужный файл вместо data\\journal.db.</p>
          <div class="form-foot"><button class="btn sm" id="bkNow">Сделать копию сейчас</button><button class="btn primary sm" id="bkSave">Сохранить</button></div>
        </div></section>
      ${sleepSettingsHTML(st)}
      </div>
      <h2 class="set-group" id="set-market">Рынок</h2>
      <div class="set-grid">
      <section class="panel"><div class="panel-h"><h2>Правило вердикта COT</h2></div>
        <div class="panel-b"><p class="muted" style="font-size:12px;margin:0 0 10px">Каждый фактор даёт +1 (за лонги), −1 (за шорты) или 0 и умножается на вес. Если сумма не меньше порога - вердикт «лонги», не больше минус порога - «шорты». Вес 0 выключает фактор. Результат правила на истории видно во вкладке COT.</p>
        <div style="display:grid;grid-template-columns:1fr 110px;gap:6px 10px;align-items:center">
          ${VERDICT_FIELDS.map(([k, l]) => `<label for="v_${k}" style="font-size:13px">${l}</label><input type="number" step="0.5" id="v_${k}" value="${st.verdict[k]}">`).join("")}
        </div>
        <div class="form-foot" style="margin-top:10px"><button class="btn sm" id="vReset">По умолчанию</button><button class="btn primary sm" id="vSave">Сохранить</button></div></div></section>
      </div>
      <h2 class="set-group" id="set-about">Запуск и обновление</h2>
      <div class="set-grid">
      <section class="panel"><div class="panel-h"><h2>Запуск</h2></div>
        <div class="panel-b prose">
          <p><b>run.bat</b> запускает журнал в фоне без окна консоли. Значок появляется в трее рядом с часами: открыть журнал, синхронизировать, выйти.</p>
          <p><b>install_autostart.bat</b> включает запуск журнала при входе в Windows, <b>remove_autostart.bat</b> выключает.</p>
          <p><b>update.bat</b> обновляет журнал: берёт свежий архив mt5-journal*.zip из папки «Загрузки» (или архив, перетащенный на update.bat), заменяет файлы программы, не трогая данные и config.json, делает копию базы и запускает журнал. Текущая версия: <b>${esc(S.st.version || "")}</b>.</p>
          <p><b>run_console.bat</b> запускает журнал с окном консоли, если нужно посмотреть ошибки. Журнал фоновой работы: data\\journal.log.</p>
        </div></section>
      </div>
      </div>
    </div>`;

  // навигация по группам: hash занят роутером, поэтому прокручиваем сами
  view.querySelectorAll("[data-jump]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); document.getElementById(a.dataset.jump)?.scrollIntoView({ behavior: motionOn() ? "smooth" : "auto", block: "start" }); }));
  bindSleepSettings();
  $("#lvSave").onclick = () => saveSetting("live", { enabled: $("#lvOn").checked, interval: +$("#lvInt").value,
    paths: $("#lvPaths").value.split("\n").map((x) => x.trim()).filter(Boolean), use_account_paths: $("#lvAcc").checked });
  $("#setTheme").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; applyTheme(b.dataset.t); $("#setTheme").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); };
  $("#motionChk").onchange = (e) => { localStorage.setItem("motion", e.target.checked ? "on" : "off"); applyMotion(); };
  $("#rmSave").onclick = () => saveSetting("reminder", { enabled: $("#rmOn").checked, day: +$("#rmDay").value, time: $("#rmTime").value || "11:00", windows: $("#rmWin").checked });
  $("#sySave").onclick = () => saveSetting("sync", { ...st.sync, auto: $("#syAuto").checked, minutes: +$("#syMin").value, on_start: $("#syStart").checked, weekend_pause: $("#syWeekend").checked });

  // сессии
  let ses = st.sessions.map((x) => ({ ...x }));
  const drawSes = () => {
    $("#sesList").innerHTML = ses.map((x, i) => `<div class="row"><input type="text" data-i="${i}" data-k="name" value="${esc(x.name)}" aria-label="Название">
      <input type="number" data-i="${i}" data-k="start" value="${x.start}" min="0" max="24" step="0.5" style="width:90px" aria-label="Начало, ч UTC">
      <span class="muted">-</span><input type="number" data-i="${i}" data-k="end" value="${x.end}" min="0" max="24" step="0.5" style="width:90px" aria-label="Конец, ч UTC">
      <button class="btn sm" data-del="${i}" aria-label="Удалить">✕</button></div>`).join("");
    $("#sesList").querySelectorAll("input").forEach((inp) => (inp.oninput = () => { ses[+inp.dataset.i][inp.dataset.k] = inp.type === "number" ? +inp.value : inp.value; }));
    $("#sesList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { ses.splice(+b.dataset.del, 1); drawSes(); }));
  };
  drawSes();
  $("#sesAdd").onclick = () => { ses.push({ name: "Новая", start: 0, end: 1 }); drawSes(); };
  $("#sesSave").onclick = () => saveSetting("sessions", ses.filter((x) => x.name.trim()));

  // чек-лист
  let ck = [...st.checklist];
  const drawCk = () => {
    $("#ckList").innerHTML = ck.map((x, i) => `<div class="row"><input type="text" data-i="${i}" value="${esc(x)}" aria-label="Пункт ${i + 1}">
      <button class="btn sm" data-up="${i}" aria-label="Выше">↑</button><button class="btn sm" data-del="${i}" aria-label="Удалить">✕</button></div>`).join("");
    $("#ckList").querySelectorAll("input").forEach((inp) => (inp.oninput = () => { ck[+inp.dataset.i] = inp.value; }));
    $("#ckList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { ck.splice(+b.dataset.del, 1); drawCk(); }));
    $("#ckList").querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { const i = +b.dataset.up; if (i > 0) { [ck[i - 1], ck[i]] = [ck[i], ck[i - 1]]; drawCk(); } }));
  };
  drawCk();
  $("#ckAdd").onclick = () => { ck.push(""); drawCk(); $("#ckList").querySelector(`input[data-i="${ck.length - 1}"]`).focus(); };
  $("#ckSave").onclick = () => saveSetting("checklist", ck.map((x) => x.trim()).filter(Boolean));

  // план до рынка
  let dck = [...st.day_checklist];
  const drawDck = () => {
    $("#dckList").innerHTML = dck.map((x, i) => `<div class="row"><input type="text" data-i="${i}" value="${esc(x)}" aria-label="Пункт ${i + 1}"><button class="btn sm" data-del="${i}" aria-label="Удалить">✕</button></div>`).join("");
    $("#dckList").querySelectorAll("input").forEach((inp) => (inp.oninput = () => { dck[+inp.dataset.i] = inp.value; }));
    $("#dckList").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { dck.splice(+b.dataset.del, 1); drawDck(); }));
  };
  drawDck();
  $("#dckAdd").onclick = () => { dck.push(""); drawDck(); };
  $("#dckSave").onclick = () => saveSetting("day_checklist", dck.map((x) => x.trim()).filter(Boolean));

  $("#riskSave").onclick = () => saveSetting("risk", { max_risk_pct: Math.max(0.01, +$("#riskMax").value || 0.5) });

  // копии
  $("#bkSave").onclick = () => saveSetting("backup", { enabled: $("#bkOn").checked, every_hours: +$("#bkEvery").value || 24, keep: Math.max(1, +$("#bkKeep").value || 5) });
  $("#bkNow").onclick = async () => { try { const r = await api("/api/backups", { method: "POST" }); toast(`Копия создана: ${r.name}`); renderSettings(); } catch (e) { toast(e.message, true); } };

  // вердикт
  $("#vSave").onclick = () => saveSetting("verdict", Object.fromEntries(VERDICT_FIELDS.map(([k]) => [k, +$("#v_" + k).value])));
  $("#vReset").onclick = () => { for (const [k] of VERDICT_FIELDS) $("#v_" + k).value = st.defaults.verdict[k]; };
}

async function saveSetting(key, value) {
  try {
    await api(`/api/settings/${key}`, { method: "PUT", body: JSON.stringify(value) });
    toast("Сохранено");
    await loadState();
  } catch (e) { toast(e.message, true); }
}
