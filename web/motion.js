/* Движение в интерфейсе: переходы между разделами с направлением, «бегунок» у вкладок и переключателей,
   подсветка карточек под курсором, прорисовка графиков. Всё короткое, на transform/opacity, без счёта чисел.
   Выключается в «Настройки» и системной настройкой «уменьшить движение» (тогда всё появляется сразу). */
"use strict";

const motionOn = () => localStorage.getItem("motion") !== "off" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
function applyMotion() { document.documentElement.classList.toggle("motion-off", !motionOn()); }
applyMotion();

/* ---------- переход между разделами ---------- */
let prevGroup = null, prevTab = null;

// старая страница чуть уходит в размытие, пока грузится новая
function leaveView(root) {
  if (!motionOn() || S.quiet) return;
  root.classList.remove("view-in", "dir-l", "dir-r");
  root.classList.add("view-out");
}

// новая страница: блоки поднимаются по очереди; внутри одного раздела - сдвиг в сторону вкладки
function enterView(root) {
  root.classList.remove("view-in", "view-out", "dir-l", "dir-r");
  initThumbs(document);
  if (!motionOn() || S.quiet) { S.modeDir = null; return; }
  const g = document.querySelector(".rail nav a.active, .rail-foot a.active")?.dataset.view ?? null;
  const tabs = [...root.querySelectorAll(".subtabs > a")];
  const tab = tabs.findIndex((a) => a.classList.contains("on"));
  let dir = S.modeDir || "";
  if (!dir && g === prevGroup && prevTab !== null && tab >= 0 && tab !== prevTab) dir = tab > prevTab ? "dir-r" : "dir-l";
  prevGroup = g; prevTab = tab >= 0 ? tab : null; S.modeDir = null;
  let i = 0;
  root.querySelectorAll(":scope > :not(.subtabs), .tg > .c12, .tg > .col > *, .wgrid > *, .today-grid:not(.tg) > *").forEach((el) => {
    if (el.classList.contains("col") || el.classList.contains("today-grid") || el.classList.contains("wgrid") || el.classList.contains("tg")) return;
    el.style.setProperty("--i", Math.min(i++, 9));
  });
  void root.offsetWidth;
  root.classList.add("view-in");
  if (dir) root.classList.add(dir);
  drawLines(root);
}

// линии SVG (мини-кривые) прорисовываются от начала к концу
function drawLines(root) {
  if (!motionOn() || S.quiet) return;
  root.querySelectorAll("svg path.draw, svg.acc-curve path, svg.ps-path path, svg.day-curve polyline").forEach((p) => {
    if (p.getAttribute("stroke-dasharray")) return;
    p.setAttribute("pathLength", "1");
    p.classList.add("m-draw");
    p.addEventListener("animationend", () => { p.classList.remove("m-draw"); p.removeAttribute("pathLength"); }, { once: true });
  });
}

// график Lightweight Charts раскрывается слева направо при первом показе
function wipeChart(el) {
  if (!el.isConnected) return;
  requestAnimationFrame(() => {
    const row = el.querySelector("table tr");
    if (!row) return;
    const pane = [...row.children].sort((a, b) => b.clientWidth - a.clientWidth)[0];
    [pane, ...el.querySelectorAll(":scope > canvas")].forEach((x) => {
      x.classList.add("m-wipe");
      x.addEventListener("animationend", () => x.classList.remove("m-wipe"), { once: true });
    });
  });
}

/* ---------- бегунок: подложка выбранного пункта переезжает к новому, а не перескакивает ---------- */
const THUMB_POS = new Map();  // последнее положение по виду переключателя: после перерисовки едем оттуда
const THUMB_SEL = ".seg, .periods, .subtabs, .rail nav, .tabs";
function thumbKey(box) {
  if (box.id) return "#" + box.id;
  if (box.classList.contains("subtabs")) return "sub:" + (box.querySelector("a")?.getAttribute("href") || "");
  if (box.classList.contains("mode-seg")) return "mode";
  return null;
}
function activeOf(box) {
  return box.querySelector(":scope > .on, :scope > .active, :scope > [aria-pressed='true']");
}
function moveThumb(box, instant = false) {
  const th = box._thumb, on = activeOf(box);
  if (!th) return;
  if (!on || !on.offsetWidth) { th.style.opacity = "0"; return; }
  const under = box.classList.contains("subtabs");
  const x = on.offsetLeft, w = on.offsetWidth, h = under ? 2 : on.offsetHeight, y = under ? on.offsetTop + on.offsetHeight - 2 : on.offsetTop;
  if (instant || !motionOn()) th.classList.add("no-tr");
  Object.assign(th.style, { transform: `translate(${x}px, ${y}px)`, width: w + "px", height: h + "px", opacity: "1" });
  if (th.classList.contains("no-tr")) { void th.offsetWidth; th.classList.remove("no-tr"); }
  const k = thumbKey(box);
  if (k) THUMB_POS.set(k, { x, y, w, h });
}
function attachThumb(box) {
  if (box._thumb) { moveThumb(box); return; }
  const th = document.createElement("span");
  th.className = "thumb";
  th.setAttribute("aria-hidden", "true");
  box.prepend(th);
  box._thumb = th;
  box.classList.add("has-thumb");
  new MutationObserver((ms) => { if (ms.some((m) => m.target !== th)) moveThumb(box); })
    .observe(box, { subtree: true, attributes: true, attributeFilter: ["class", "aria-pressed"] });
  new ResizeObserver(() => moveThumb(box, true)).observe(box);
  const old = THUMB_POS.get(thumbKey(box));
  if (old && motionOn()) {
    th.classList.add("no-tr");
    Object.assign(th.style, { transform: `translate(${old.x}px, ${old.y}px)`, width: old.w + "px", height: old.h + "px", opacity: "1" });
    void th.offsetWidth;
    th.classList.remove("no-tr");
    requestAnimationFrame(() => moveThumb(box));
  } else moveThumb(box, true);
}
function initThumbs(root) { root.querySelectorAll(THUMB_SEL).forEach(attachThumb); }

/* ---------- подсветка под курсором: светлая кромка и мягкий свет на карточке ---------- */
(() => {
  let card = null, ev = null, raf = 0;
  const apply = () => {
    raf = 0;
    if (!card || !ev) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
    card.style.setProperty("--my", `${ev.clientY - r.top}px`);
  };
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    card = e.target.closest?.(".tile, .panel") || null;
    ev = e;
    if (card && !raf) raf = requestAnimationFrame(apply);
  }, { passive: true });
})();
