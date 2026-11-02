"""Экспорт журнала: Excel-файл и HTML-отчёт, который открывается в любом браузере."""
import base64
import html
import io
import mimetypes
from datetime import datetime, timezone
from pathlib import Path

DIR = {1: "Buy", -1: "Sell"}


def _dt(ts, shift):
    return datetime.fromtimestamp(ts + shift, tz=timezone.utc).strftime("%d.%m.%Y %H:%M") if ts else ""


def _m(x):
    if x is None:
        return "—"
    return ("−" if x < 0 else "+" if x > 0 else "") + f"{abs(x):,.2f}".replace(",", " ").replace(".", ",")


def trade_row(t, shift):
    ck = t.get("checklist") or {}
    return {
        "Тикет": t["position_id"], "Инструмент": t["symbol"], "Направление": DIR.get(t["direction"]),
        "Статус": "открыта" if t["status"] == "open" else "закрыта",
        "Открыта": _dt(t["open_time"], shift), "Закрыта": _dt(t["close_time"], shift),
        "Сессия": t.get("session"), "Объём": t["volume"], "Вход": t["entry_price"], "Выход": t["exit_price"],
        "Стоп": t.get("sl_used"), "Тейк": t.get("tp_initial"), "R": t.get("r"),
        "MAE, R": t.get("mae_r"), "MFE, R": t.get("mfe_r"), "Длительность, мин": round(t["duration"] / 60) if t.get("duration") else None,
        "Прибыль": t["profit"], "Комиссия": t["commission"], "Своп": t["swap"], "Итог": t["net"],
        "Источник": t.get("source"), "Как закрыта": t.get("close_label"), "Сетап": t.get("setup"),
        "Оценка": t.get("grade"), "По плану": {1: "да", 0: "нет"}.get(t.get("followed_plan"), ""),
        "Чек-лист, %": t.get("check_pct"), "Пункты чек-листа": "; ".join(f"{'✓' if v else '✗'} {k}" for k, v in ck.items()),
        "Состояние": t.get("emotion"), "Ошибки": t.get("mistakes"), "Теги": t.get("tags"),
        "Причина входа": t.get("entry_reason"), "Причина выхода": t.get("exit_reason"), "Заметки": t.get("notes"),
        "Скриншотов": t.get("shots"),
    }


def to_xlsx(trades, st, account, shift):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    head = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="2B2C3B")

    def sheet(ws, rows):
        if not rows:
            ws.append(["Нет данных"])
            return
        cols = list(rows[0])
        ws.append(cols)
        for c in ws[1]:
            c.font, c.fill = head, fill
        for r in rows:
            ws.append([r.get(c) for c in cols])
        for i, c in enumerate(cols, 1):
            width = max(len(str(c)), *(len(str(r.get(c) or "")) for r in rows[:300]))
            ws.column_dimensions[get_column_letter(i)].width = min(60, max(9, width + 2))
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = ws.dimensions

    s = st["summary"]
    ws = wb.active
    ws.title = "Сводка"
    lines = [("Счёт", f"{account.get('label') or account.get('name') or ''} ({account.get('login')})"),
             ("Сервер", account.get("server")), ("Валюта", account.get("currency")),
             ("Сформировано", datetime.now().strftime("%d.%m.%Y %H:%M")),
             ("Закрытых сделок", s["trades"]), ("Итог", s["net"]), ("Прибыльных, %", s["win_rate"]),
             ("Profit factor", s["profit_factor"]), ("Ожидание на сделку", s["expectancy"]),
             ("Средний R", s["avg_r"]), ("Итог в R", s["sum_r"]), ("Средняя прибыль", s["avg_win"]),
             ("Средний убыток", s["avg_loss"]), ("Макс. просадка", s["max_dd"]), ("Издержки", s["costs"]),
             ("Лучшая сделка", s["best"]), ("Худшая сделка", s["worst"]),
             ("Серия в плюс / в минус", f"{s['streak_win']} / {s['streak_loss']}")]
    for k, v in lines:
        ws.append([k, v])
    ws["A1"].font = Font(bold=True)
    ws.column_dimensions["A"].width, ws.column_dimensions["B"].width = 28, 40

    sheet(wb.create_sheet("Сделки"), [trade_row(t, shift) for t in trades])
    for c in wb["Сделки"]["AH"] if wb["Сделки"].max_column >= 34 else []:
        c.alignment = Alignment(wrap_text=True, vertical="top")
    sheet(wb.create_sheet("По дням"), [{"Дата": d, "Сделок": v["count"], "Итог": v["net"]} for d, v in sorted(st["daily"].items())])
    for name, key in (("По инструментам", "by_symbol"), ("По сессиям", "by_session"), ("По сетапам", "by_setup"),
                      ("По плану", "by_plan"), ("По дням недели", "by_weekday"), ("Ошибки", "by_mistake")):
        rows = [{"Группа": x.get("label") or x["key"], "Сделок": x["count"], "Итог": x["net"], "Прибыльных, %": x["win_rate"],
                 "Сумма прибыльных": x.get("gross_profit"), "Сумма убыточных": x.get("gross_loss"), "Средний R": x["avg_r"]}
                for x in st.get(key, [])]
        sheet(wb.create_sheet(name), rows)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _svg_curve(points, w=900, h=220):
    if len(points) < 2:
        return ""
    xs = [p["time"] for p in points]
    ys = [0.0] + [p["value"] for p in points]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if y1 == y0:
        y1 = y0 + 1
    sx = lambda x: 10 + (w - 20) * (x - x0) / ((x1 - x0) or 1)
    sy = lambda y: 10 + (h - 20) * (1 - (y - y0) / (y1 - y0))
    pts = " ".join(f"{sx(p['time']):.1f},{sy(p['value']):.1f}" for p in points)
    zero = sy(0)
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" role="img" aria-label="Кривая доходности">'
            f'<line x1="10" x2="{w-10}" y1="{zero:.1f}" y2="{zero:.1f}" stroke="#9c9ab3" stroke-dasharray="4 4"/>'
            f'<polyline fill="none" stroke="#6f7cf0" stroke-width="2" points="{pts}"/></svg>')


def to_html(trades, st, account, shift, shots_dir=None, with_shots=True):
    e = html.escape
    s = st["summary"]
    ccy = account.get("currency") or ""
    rows = []
    for t in trades:
        imgs = ""
        if with_shots and shots_dir and t.get("_shots"):
            for f in t["_shots"]:
                p = Path(shots_dir) / f
                if p.exists():
                    mime = mimetypes.guess_type(p.name)[0] or "image/png"
                    imgs += f'<img src="data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}" alt="Скриншот сделки">'
        notes = " ".join(x for x in [t.get("entry_reason"), t.get("exit_reason"), t.get("notes")] if x)
        rows.append(f"""<tr class="{'w' if t['net'] > 0 else 'l' if t['net'] < 0 else ''}">
          <td>{e(_dt(t['open_time'], shift))}</td><td><b>{e(t['symbol'])}</b> {DIR.get(t['direction'])}</td>
          <td>{e(t.get('session') or '')}</td><td class="n">{t['volume']}</td>
          <td class="n">{'' if t.get('r') is None else f"{t['r']:+.2f}R"}</td><td class="n"><b>{_m(t['net'])}</b></td>
          <td>{e(t.get('setup') or '')}</td><td>{ {1: 'да', 0: 'нет'}.get(t.get('followed_plan'), '')}</td>
          <td>{'' if t.get('check_pct') is None else str(t['check_pct']) + '%'}</td>
          <td>{e(t.get('mistakes') or '')}</td></tr>""" + (f'<tr class="det"><td colspan="10">{e(notes)}{imgs and "<div class=shots>" + imgs + "</div>"}</td></tr>' if notes or imgs else ""))

    def table(title, key):
        items = st.get(key) or []
        if not items:
            return ""
        body = "".join(f"<tr><td>{e(str(x.get('label') or x['key']))}</td><td class=n>{x['count']}</td>"
                       f"<td class=n>{x['win_rate']}%</td><td class=n><b>{_m(x['net'])}</b></td></tr>" for x in items)
        return f"<section><h3>{title}</h3><table><tr><th>Группа</th><th class=n>Сделок</th><th class=n>Прибыльных</th><th class=n>Итог</th></tr>{body}</table></section>"

    kpi = [("Итог", f"{_m(s['net'])} {ccy}"), ("Сделок", s["trades"]), ("Прибыльных", f"{s['win_rate']}%"),
           ("Profit factor", s["profit_factor"] or "—"), ("Ожидание", _m(s["expectancy"])),
           ("Средний R", "—" if s["avg_r"] is None else f"{s['avg_r']:+.2f}"), ("Макс. просадка", _m(-s["max_dd"])),
           ("Издержки", _m(s["costs"]))]
    return f"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Торговый журнал {e(str(account.get('login', '')))}</title>
<style>
body{{font:14px/1.5 "Segoe UI",system-ui,sans-serif;margin:0;background:#f4f4f8;color:#1c1b2a}}
main{{max-width:1200px;margin:0 auto;padding:28px 20px}} h1{{font-size:24px;margin:0}} h3{{font-size:14px;margin:0 0 8px;text-transform:uppercase;letter-spacing:.06em;color:#625f79}}
.sub{{color:#625f79;margin:4px 0 20px}} .kpi{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px}}
.kpi div,section{{background:#fff;border-radius:12px;padding:12px 14px}} .kpi span{{display:block;color:#625f79;font-size:12px}} .kpi b{{font-size:18px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin:12px 0}}
table{{width:100%;border-collapse:collapse;font-size:13px}} th,td{{text-align:left;padding:6px 8px;border-bottom:1px solid #ecebf3}} .n{{text-align:right}}
tr.w td:first-child{{box-shadow:inset 3px 0 #138a5e}} tr.l td:first-child{{box-shadow:inset 3px 0 #c8433a}} tr.det td{{color:#625f79;font-size:12px;background:#fafafd}}
.shots img{{max-width:320px;max-height:200px;border-radius:8px;margin:6px 6px 0 0}} .wrap{{overflow-x:auto}}
</style></head><body><main>
<h1>Торговый журнал: {e(account.get('label') or account.get('name') or '')}</h1>
<p class="sub">Счёт {e(str(account.get('login', '')))}, {e(account.get('server') or '')}. Сформировано {datetime.now().strftime('%d.%m.%Y %H:%M')}. Время сделок - время сервера брокера{f' со сдвигом {shift // 3600:+d} ч' if shift else ''}.</p>
<div class="kpi">{''.join(f'<div><span>{k}</span><b>{v}</b></div>' for k, v in kpi)}</div>
<section><h3>Кривая доходности</h3>{_svg_curve(st['equity'])}</section>
<div class="grid">{table('Инструменты', 'by_symbol')}{table('Сессии', 'by_session')}{table('Сетапы', 'by_setup')}{table('По плану', 'by_plan')}{table('Дни недели', 'by_weekday')}{table('Ошибки', 'by_mistake')}</div>
<section class="wrap"><h3>Сделки</h3><table><tr><th>Открыта</th><th>Инструмент</th><th>Сессия</th><th class=n>Объём</th><th class=n>R</th><th class=n>Итог</th><th>Сетап</th><th>По плану</th><th>Чек-лист</th><th>Ошибки</th></tr>
{''.join(rows)}</table></section></main></body></html>"""
