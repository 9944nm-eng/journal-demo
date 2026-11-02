"""Проверка сделки по правилам ТС до входа (калькулятор лота) и в момент открытия (живое отслеживание).

Стоимость пункта берётся из ваших прошлых сделок по этому инструменту: прибыль / (движение цены × объём).
В ней уже учтены размер контракта и пересчёт валюты. Если сделок по инструменту ещё не было -
по размеру контракта из MT5 и последней известной цене валютной пары.
"""
import re
import statistics
import time
from datetime import datetime, timezone

from . import news as news_mod
from . import rules as rules_mod
from . import settings as appset


def _prefix(sym):
    return re.sub(r"[._-].*$", "", sym or "").upper()


def _last_close(con, a, b):
    """Последняя цена пары a/b из кэша котировок (или обратной пары)."""
    for pair, inv in ((a + b, False), (b + a, True)):
        r = con.execute("SELECT c FROM rates WHERE symbol LIKE ? ORDER BY time DESC LIMIT 1", (pair + "%",)).fetchone()
        if r and r[0]:
            return 1 / r[0] if inv else r[0]
    return None


def value_per_unit(con, login, symbol):
    """Деньги на 1,0 движения цены при объёме 1 лот. Возвращает (значение, откуда взято)."""
    p = _prefix(symbol)
    vals = []
    for r in con.execute("SELECT symbol, direction, entry_price, exit_price, volume, profit FROM trades "
                         "WHERE login=? AND status='closed' AND exit_price IS NOT NULL ORDER BY close_time DESC LIMIT 400", (login,)):
        if _prefix(r[0]) != p or not r[4] or abs(r[3] - r[2]) < 1e-9:
            continue
        v = r[5] / ((r[3] - r[2]) * r[1] * r[4])
        if v > 0:
            vals.append(v)
    if vals:
        return statistics.median(vals[:30]), f"по {len(vals[:30])} прошлым сделкам"
    s = con.execute("SELECT contract_size, currency_profit FROM symbols WHERE symbol LIKE ? ORDER BY LENGTH(symbol) LIMIT 1",
                    (p + "%",)).fetchone()
    if not s or not s[0]:
        return None, "нет данных об инструменте: добавьте его в обзор рынка MT5 и синхронизируйтесь"
    acc = con.execute("SELECT currency FROM accounts WHERE login=?", (login,)).fetchone()
    cur = (acc[0] if acc else "USD") or "USD"
    if not s[1] or s[1] == cur:
        return s[0], "по размеру контракта"
    k = _last_close(con, s[1], cur)
    if k:
        return s[0] * k, f"по размеру контракта и курсу {s[1]}/{cur}"
    return s[0], f"по размеру контракта, без пересчёта {s[1]} в {cur}"


def check(con, login, symbol, direction, entry, sl, tp, volume, utc_now=None, pre=True):
    """Список проверок по активным правилам: [{title, ok, detail}] и ближайшие новости."""
    utc_now = int(utc_now or time.time())
    acc = con.execute("SELECT * FROM accounts WHERE login=?", (login,)).fetchone()
    acc = dict(acc) if acc else {}
    off = int(acc.get("server_offset") or 0)
    bal = float(acc.get("balance") or 0)
    floating = float(acc.get("equity") or bal) - bal
    srv_now = utc_now + off
    day0 = srv_now // 86400 * 86400
    opened_today = con.execute("SELECT COUNT(*) FROM trades WHERE login=? AND open_time>=?", (login, day0)).fetchone()[0]
    closed = con.execute("SELECT net, close_time FROM trades WHERE login=? AND status='closed' AND close_time>=? ORDER BY close_time",
                         (login, day0)).fetchall()
    day_net = sum(r[0] for r in closed)
    last = con.execute("SELECT net, close_time FROM trades WHERE login=? AND status='closed' ORDER BY close_time DESC LIMIT 1",
                       (login,)).fetchone()
    streak = 0
    for r in reversed(closed):
        if r[0] < 0:
            streak += 1
        else:
            break
    vpu, _ = value_per_unit(con, login, symbol)
    risk_pct = abs(entry - sl) * volume * vpu / bal * 100 if (sl and volume and vpu and bal) else None
    sessions = appset.get(con, "sessions")
    session = appset.session_of(sessions, utc_now)
    high = news_mod.around(con, utc_now - 6 * 3600, utc_now + 6 * 3600, news_mod.currencies(symbol))
    out = []
    for r in rules_mod.load(con, login):
        k, p = r["kind"], r["params"]
        ok, detail = True, ""
        if k == "symbols_only":
            ok = rules_mod._sym_ok(symbol, p.get("symbols") or [])
            detail = "" if ok else f"{symbol} нет в списке инструментов ТС"
        elif k == "sessions_only":
            ok = session in (p.get("sessions") or [])
            detail = f"сейчас: {session}"
        elif k == "max_risk":
            ok = risk_pct is None or risk_pct <= float(p.get("pct", 1)) * 1.1
            detail = f"риск {risk_pct:.2f}%".replace(".", ",") if risk_pct is not None else "риск не посчитан: нет стопа или стоимости пункта"
        elif k == "min_rr":
            rr = abs(tp - entry) / abs(entry - sl) if (tp and sl and abs(entry - sl) > 0) else None
            ok = rr is None or rr >= float(p.get("rr", 2)) - 0.05
            detail = f"RR {rr:.2f}".replace(".", ",") if rr else "тейк не указан"
        elif k == "max_trades_day":
            n = opened_today + (1 if pre else 0)
            ok = n <= int(p.get("n", 3))
            detail = f"это {n}-я сделка за день"
        elif k == "daily_loss":
            lim = bal * float(p.get("pct", 3)) / 100
            ok = not bal or day_net + floating > -lim
            detail = f"за день {day_net + floating:+.2f} из −{lim:.2f}".replace(".", ",")
        elif k == "cooldown":
            mins = (utc_now + off - last[1]) / 60 if last and last[0] < 0 else None
            ok = mins is None or mins >= float(p.get("minutes", 30))
            detail = f"после убытка прошло {int(mins)} мин" if mins is not None else "последняя сделка не убыточная"
        elif k == "stop_after_losses":
            ok = streak < int(p.get("n", 2))
            detail = f"убытков подряд сегодня: {streak}"
        elif k == "require_sl":
            ok = bool(sl)
            detail = "" if ok else "стоп не указан"
        elif k == "no_news":
            m = news_mod.nearest_minutes(high, symbol, utc_now)
            ok = m is None or m > int(p.get("minutes", 30))
            near = min(high, key=lambda x: abs(x["time"] - utc_now)) if high else None
            detail = f"{near['currency']} {near['title']} через {round((near['time'] - utc_now) / 60)} мин" if near and not ok else "важных новостей рядом нет"
        elif k == "no_reversal":
            from .twins import base_symbol
            ls = [r2 for r2 in con.execute("SELECT symbol, direction, net, close_time FROM trades WHERE login=? AND status='closed' ORDER BY close_time DESC LIMIT 20", (login,))
                  if base_symbol(r2[0]) == base_symbol(symbol)][:1]
            mins = (srv_now - ls[0][3]) / 60 if ls and ls[0][2] < 0 and ls[0][1] == -direction else None
            ok = mins is None or mins >= float(p.get("minutes", 60))
            detail = f"стоп на {symbol} был {int(mins)} мин назад, это вход в обратную сторону" if not ok else ""
        elif k == "late_reduced":
            hour = (srv_now % 86400) // 3600
            if hour < int(p.get("hour", 16)):
                continue
            lim = rules_mod.late_limit(p)
            ok = risk_pct is None or risk_pct <= lim * 1.1
            detail = f"позднее окно: риск {risk_pct:.2f}% при лимите {lim}%".replace(".", ",") if risk_pct is not None else "позднее окно: только A-сетап"
        elif k == "no_phone":
            continue
        out.append({"title": r["title"], "ok": ok, "detail": detail})
    # хедж между счетами запрещён правилами фирм: встречная позиция по тому же инструменту на другом счёте
    hedge = [r for r in con.execute("SELECT login, symbol, direction FROM trades WHERE status='open' AND login<>?", (login,))
             if _prefix(r[1]) == _prefix(symbol) and r[2] == -direction]
    out.append({"title": "Нет встречной позиции на другом счёте", "ok": not hedge,
                "detail": f"на счёте {hedge[0][0]} открыт {'Buy' if hedge[0][2] > 0 else 'Sell'} {hedge[0][1]}: хедж между счетами запрещён фирмами" if hedge else ""})
    upcoming = [{"time": n["time"], "currency": n["currency"], "title": n["title"]} for n in high if n["time"] >= utc_now - 1800][:5]
    return {"checks": out, "news": upcoming, "risk_pct": round(risk_pct, 3) if risk_pct is not None else None, "session": session}


def ts_risk(con):
    ts = appset.get(con, "ts").get("answers") or {}
    m = re.search(r"\d+(?:[.,]\d+)?", str(ts.get("risk") or ""))
    return float(m.group(0).replace(",", ".")) if m else None


def register(app, con, db_lock, current_login):
    from flask import jsonify, request

    @app.post("/api/calc")
    def calc():
        b = request.get_json(force=True)
        login = current_login()
        try:
            sym = (b.get("symbol") or "").strip().upper()
            entry, sl = float(b["entry"]), float(b["sl"])
            tp = float(b["tp"]) if b.get("tp") not in (None, "") else None
            direction = 1 if (entry > sl) else -1
        except (KeyError, ValueError, TypeError):
            return jsonify({"message": "Укажите инструмент, вход и стоп"}), 400
        with db_lock:
            acc = con.execute("SELECT balance, currency FROM accounts WHERE login=?", (login,)).fetchone()
            bal = float(acc[0]) if acc and acc[0] else 0
            risk = float(b.get("risk_pct") or 0) or ts_risk(con) or 1.0
            vpu, src = value_per_unit(con, login, sym)
            risk_money = bal * risk / 100
            dist = abs(entry - sl)
            lot = int(risk_money / (dist * vpu) / 0.01) * 0.01 if (vpu and dist) else None
            res = check(con, login, sym, direction, entry, sl, tp, lot or 0)
        return jsonify({"balance": bal, "currency": acc[1] if acc else "", "risk_pct": risk, "risk_money": round(risk_money, 2),
                        "lot": round(lot, 2) if lot is not None else None, "vpu": vpu, "vpu_source": src, "direction": direction,
                        "rr": round(abs(tp - entry) / dist, 2) if tp and dist else None,
                        "reward_money": round(abs(tp - entry) * vpu * lot, 2) if tp and vpu and lot else None, **res})

    @app.get("/api/news")
    def news_get():
        a = request.args.get("from", type=int) or int(time.time()) - 86400
        b = request.args.get("to", type=int) or int(time.time()) + 7 * 86400
        with db_lock:
            items = news_mod.around(con, a, b, None, impact=("High", "Medium") if request.args.get("all") else ("High",))
        return jsonify({"items": items})
