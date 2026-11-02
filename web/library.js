/* Плейбуки и заметки */
"use strict";

/* ---------- плейбуки ---------- */
async function renderPlaybooks(editId) {
  const d = await api("/api/playbooks");
  if (editId) return renderPlaybookForm(d, editId === "new" ? null : d.playbooks.find((p) => String(p.id) === editId));
  // в «Сетап» иногда пишут целую заметку: плейбук из такого текста не предлагаем
  const setups = d.unlinked_setups.filter((s) => s.length <= 40);
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><h1>Плейбуки</h1><span class="muted">сетапы со своими правилами и статистикой</span></div><a class="btn primary" href="#/playbooks/new">Новый плейбук</a></div>
    ${d.playbooks.length ? "" : `<section class="panel panel-b" style="margin-bottom:16px"><h2 style="margin:0 0 6px;font-size:16px">Плейбуков пока нет</h2>
      <p class="muted" style="margin:0;max-width:72ch;font-size:14px">Плейбук описывает один сетап: идею, правила входа, стопа и выхода, чек-лист и пример идеальной сделки. Сделка привязывается к плейбуку, если в её поле «Сетап» стоит название плейбука, и сразу попадает в его статистику.</p>
      <a class="btn primary sm" href="#/playbooks/new" style="margin-top:14px">Создать первый плейбук</a></section>`}
    <div class="pb-grid">${d.playbooks.map((p) => `<section class="panel pb-card ${p.active ? "" : "muted"}" data-id="${p.id}" tabindex="0" role="button">
      ${p.example ? `<img src="/shots/${esc(p.example)}" alt="Пример сделки по плейбуку">` : ""}
      <div class="panel-b"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:16px">${esc(p.name)}</b>${p.active ? "" : '<span class="tag">архив</span>'}</div>
        <p class="muted" style="font-size:13px;margin:6px 0 10px">${esc((p.description || "").slice(0, 160))}</p>
        <div class="mini-list">
          <div class="row"><span class="muted">Сделок</span><b>${p.stats.count}</b></div>
          <div class="row"><span class="muted">Итог</span><b class="${cls(p.stats.net)}">${money(p.stats.net)}</b></div>
          <div class="row"><span class="muted">Прибыльных / средний R</span><b>${p.stats.win_rate === null ? "—" : p.stats.win_rate + "%"} / ${rfmt(p.stats.avg_r)}</b></div>
          <div class="row"><span class="muted">По плану</span><b>${p.stats.plan_rate === null ? "—" : p.stats.plan_rate + "%"}</b></div></div></div></section>`).join("")}</div>
    ${setups.length ? `<section class="panel panel-b" style="margin-top:16px"><b>Сетапы из сделок без плейбука</b>
      <div class="chips" style="margin-top:8px">${setups.map((s) => `<button class="btn sm" data-mk="${esc(s)}">+ ${esc(s)}</button>`).join("")}</div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Нажмите, чтобы создать плейбук с этим названием: прошлые сделки с этим сетапом сразу попадут в его статистику.</p></section>` : ""}`;
  view.querySelectorAll(".pb-card").forEach((c) => (c.onclick = () => (location.hash = `#/playbooks/${c.dataset.id}`)));
  view.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = async () => {
    await api("/api/playbooks", { method: "POST", body: JSON.stringify({ name: b.dataset.mk }) });
    await loadState(); renderPlaybooks();
  }));
}

function renderPlaybookForm(d, p) {
  let checklist = [...(p?.checklist || [])], exampleData = null;
  view.innerHTML = `
    <div class="td-head"><div class="td-title"><a class="btn sm" href="#/playbooks">‹ Плейбуки</a><h1>${p ? esc(p.name) : "Новый плейбук"}</h1></div></div>
    <div class="acc-grid">
      <section class="panel"><div class="form">
        <label class="f"><span>Название (так же пишется в поле «Сетап» сделки)</span><input type="text" id="pbName" value="${esc(p?.name || "")}"></label>
        <label class="f"><span>Описание: идея и контекст</span><textarea id="pbDesc" rows="3">${esc(p?.description || "")}</textarea></label>
        <label class="f"><span>Правила входа, стопа и выхода</span><textarea id="pbRules" rows="7" placeholder="Вход: ...&#10;Стоп: ...&#10;Тейк: ...&#10;Не торгую, если: ...">${esc(p?.rules || "")}</textarea></label>
        <div class="f"><span class="muted" style="font-size:13px">Чек-лист плейбука</span><div class="list-edit" id="pbCk"></div><button type="button" class="btn sm" id="pbCkAdd" style="align-self:flex-start;margin-top:6px">Добавить пункт</button></div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pbActive" ${p?.active === 0 ? "" : "checked"}> Активный (в архиве не предлагается в карточке сделки)</label>
        <div class="form-foot">${p ? '<button class="btn" id="pbDel" style="color:var(--loss)">Удалить</button>' : "<span></span>"}<button class="btn primary" id="pbSave">Сохранить</button></div>
      </div></section>
      <div>
        <section class="panel"><div class="panel-h"><h2>Пример идеальной сделки</h2></div>
          <div class="panel-b"><div id="pbImg">${p?.example ? `<img src="/shots/${esc(p.example)}" alt="Пример" style="width:100%;border-radius:8px">` : ""}</div>
          <div class="dropzone" id="pbDrop" style="margin-top:8px">Ctrl+V или перетащите скриншот сюда</div></div></section>
        ${p ? `<section class="panel" style="margin-top:16px"><div class="panel-h"><h2>Последние сделки по сетапу</h2><span class="muted" style="font-size:12px">все счета</span></div><div class="panel-b"><div class="pb-mini" id="pbTrades"></div></div></section>` : ""}
      </div>
    </div>`;
  const drawCk = () => {
    $("#pbCk").innerHTML = checklist.map((c, i) => `<div class="row"><input type="text" data-i="${i}" value="${esc(c)}"><button class="btn sm" data-del="${i}" aria-label="Удалить">✕</button></div>`).join("");
    $("#pbCk").querySelectorAll("input").forEach((inp) => (inp.oninput = () => (checklist[+inp.dataset.i] = inp.value)));
    $("#pbCk").querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => { checklist.splice(+b.dataset.del, 1); drawCk(); }));
  };
  drawCk();
  $("#pbCkAdd").onclick = () => { checklist.push(""); drawCk(); };
  const setImg = (file) => {
    if (!file?.type.startsWith("image/")) return;
    const r = new FileReader();
    r.onload = () => { exampleData = r.result; $("#pbImg").innerHTML = `<img src="${r.result}" alt="Пример" style="width:100%;border-radius:8px">`; };
    r.readAsDataURL(file);
  };
  document.onpaste = (e) => {
    if (!location.hash.startsWith("#/playbooks/")) { document.onpaste = null; return; }
    const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (it) { e.preventDefault(); setImg(it.getAsFile()); }
  };
  const drop = $("#pbDrop");
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); setImg(e.dataTransfer.files[0]); };
  $("#pbSave").onclick = async () => {
    try {
      await api("/api/playbooks", { method: "POST", body: JSON.stringify({ id: p?.id, name: $("#pbName").value, description: $("#pbDesc").value,
        rules: $("#pbRules").value, checklist, example: p?.example, example_data: exampleData, active: $("#pbActive").checked }) });
      toast("Плейбук сохранён"); await loadState(); location.hash = "#/playbooks";
    } catch (e) { toast(e.message, true); }
  };
  $("#pbDel")?.addEventListener("click", async () => {
    if (!confirm("Удалить плейбук? Сделки останутся, сетап в них не изменится.")) return;
    await api(`/api/playbooks/${p.id}`, { method: "DELETE" }); await loadState(); location.hash = "#/playbooks";
  });
  // сравнение сделок сетапа: мини-графики с блоком позиции
  if (p) {
    const box = $("#pbTrades");
    const items = (p.stats.trades || []).slice(0, 8);
    if (!items.length) box.innerHTML = '<div class="empty">Сделок с этим сетапом пока нет.</div>';
    items.forEach(async (it) => {
      const card = document.createElement("div");
      card.className = "mc";
      card.innerHTML = '<div class="ch"></div><div class="cap muted">загружаю…</div>';
      card.onclick = () => (location.hash = `#/trade/${it.login}/${it.position_id}`);
      box.appendChild(card);
      try {
        const c = await api(`/api/chart/${it.login}/${it.position_id}`);
        const tr = { ...c.trade, r: null };
        if (c.trade.sl_initial && c.trade.exit_price) tr.r = Math.round(((c.trade.exit_price - c.trade.entry_price) * c.trade.direction / Math.abs(c.trade.entry_price - c.trade.sl_initial)) * 100) / 100;
        if (c.bars.length) renderTradeChart(card.querySelector(".ch"), c, tr, { compact: true, levels: false });
        card.querySelector(".cap").innerHTML = `<span>${esc(tr.symbol)} ${tr.direction === 1 ? "Buy" : "Sell"} · ${dt(tr.open_time, false)}</span><b class="${cls(tr.net)}">${tr.r !== null ? rfmt(tr.r) : money(tr.net)}</b>`;
      } catch (e) { card.querySelector(".cap").textContent = "нет котировок"; }
    });
  }
}

/* ---------- заметки ---------- */
async function renderNotes(openId) {
  let list = await api("/api/notes");
  let cur = openId === "new" ? {} : list.find((n) => String(n.id) === openId) || null;
  view.innerHTML = `
    <div class="td-head"><h1>Заметки</h1><a class="btn primary" href="#/notes/new">Новая заметка</a></div>
    <div class="notes-grid">
      <section class="panel"><div class="panel-b"><input type="search" id="nQ" placeholder="Поиск по заметкам" aria-label="Поиск"></div><div id="nList" class="note-list"></div></section>
      <section class="panel" id="nEdit"></section>
    </div>`;
  const drawList = () => {
    const qv = $("#nQ").value.toLowerCase();
    const items = list.filter((n) => !qv || [n.title, n.body, n.tags].join(" ").toLowerCase().includes(qv));
    $("#nList").innerHTML = items.map((n) => `<div class="note-item ${cur && cur.id === n.id ? "on" : ""}" data-id="${n.id}" tabindex="0" role="button">
      <div style="display:flex;justify-content:space-between;gap:6px"><b>${n.pinned ? "★ " : ""}${esc(n.title || "Без названия")}</b><span class="muted" style="font-size:11px">${localTime(n.updated || n.created).slice(0, 8)}</span></div>
      <div class="muted" style="font-size:12px">${esc((n.body || "").slice(0, 90))}</div>
      ${n.tags ? `<div class="chips" style="margin-top:4px">${n.tags.split(",").filter(Boolean).map((t) => `<span class="tag">${esc(t.trim())}</span>`).join("")}</div>` : ""}</div>`).join("") || '<div class="empty">Заметок нет</div>';
    $("#nList").querySelectorAll("[data-id]").forEach((el) => (el.onclick = () => (location.hash = `#/notes/${el.dataset.id}`)));
  };
  const drawEdit = () => {
    if (!cur) { $("#nEdit").innerHTML = '<div class="panel-b empty">Выберите заметку или создайте новую. Закреплённые заметки видны на «Сегодня» перед сессией.</div>'; return; }
    $("#nEdit").innerHTML = `<div class="form">
      <input type="text" id="nTitle" value="${esc(cur.title || "")}" placeholder="Заголовок" style="font-size:18px;font-weight:600">
      <textarea id="nBody" rows="16" placeholder="Наблюдения, выводы недели, идеи">${esc(cur.body || "")}</textarea>
      <div class="row2"><label class="f"><span>Теги</span><input type="text" id="nTags" value="${esc(cur.tags || "")}" placeholder="золото, психология"></label>
        <label class="f"><span>Дата</span><input type="date" id="nDate" value="${esc(cur.date || "")}"></label></div>
      <div style="display:flex;gap:16px;flex-wrap:wrap"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="nPin" ${cur.pinned ? "checked" : ""}> Показывать на «Сегодня»</label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="nAll" ${cur.id && cur.login === null ? "checked" : ""}> Показывать для всех счетов</label></div>
      <div class="form-foot">${cur.id ? '<button class="btn" id="nDel" style="color:var(--loss)">Удалить</button>' : "<span></span>"}<button class="btn primary" id="nSave">Сохранить</button></div></div>`;
    $("#nSave").onclick = async () => {
      const r = await api("/api/notes", { method: "POST", body: JSON.stringify({ id: cur.id, title: $("#nTitle").value, body: $("#nBody").value,
        tags: $("#nTags").value, date: $("#nDate").value, pinned: $("#nPin").checked, all_accounts: $("#nAll").checked }) });
      toast("Заметка сохранена"); location.hash = `#/notes/${r.id}`; if (String(r.id) === openId) renderNotes(String(r.id));
    };
    $("#nDel")?.addEventListener("click", async () => { if (!confirm("Удалить заметку?")) return; await api(`/api/notes/${cur.id}`, { method: "DELETE" }); location.hash = "#/notes"; });
  };
  $("#nQ").oninput = drawList;
  drawList(); drawEdit();
}
