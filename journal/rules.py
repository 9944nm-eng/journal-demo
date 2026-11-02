"""Правила торговой системы, которые журнал проверяет сам по каждой сделке.

Журнал работает только на чтение: он не может запретить вход, он отмечает нарушения после сделки.
"""
import json
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login INTEGER, kind TEXT NOT NULL, params TEXT, title TEXT,
    source TEXT, active INTEGER DEFAULT 1, created INTEGER
);
"""

KINDS = {
    "cooldown": "Пауза после убыточной сделки",
    "max_trades_day": "Не больше N сделок в день",
    "stop_after_losses": "Стоп на день после N убытков подряд",
    "max_risk": "Риск на сделку не выше лимита",
    "sessions_only": "Торговать только в выбранные сессии",
    "no_phone": "Не открывать сделки с телефона",
    "require_sl": "Стоп выставляется сразу",
    "min_rr": "Плановое соотношение прибыль/риск не ниже N",
    "symbols_only": "Торговать только выбранные инструменты",
    "daily_loss": "Не входить после дневного убытка N%",
    "no_news": "Не входить около важных новостей",
    "no_reversal": "Без переворота после стопа",
    "late_reduced": "Позднее окно: только A-сетап и меньший риск",
}


def _sym_ok(sym, allowed):
    """XAUUSD.raw считается XAUUSD, GER40 считается GER30: суффиксы и имена брокеров не мешают сравнению."""
    from .twins import base_symbol
    s = (sym or "").upper()
    b = base_symbol(sym)
    return any(s.startswith(a.upper()) or b == base_symbol(a) for a in allowed if a)


def planned_rr(t):
    sl, tp, e = t.get("sl_used"), t.get("tp_initial"), t.get("entry_price")
    if not (sl and tp and e) or abs(e - sl) <= 0:
        return None
    return abs(tp - e) / abs(e - sl)


def title_for(kind, p):
    if kind == "cooldown":
        return f"Пауза {p.get('minutes', 30)} мин после убыточной сделки"
    if kind == "max_trades_day":
        return f"Не больше {p.get('n', 2)} сделок в день"
    if kind == "stop_after_losses":
        return f"После {p.get('n', 2)} убытков подряд - стоп до конца дня"
    if kind == "max_risk":
        return f"Риск на сделку не выше {str(p.get('pct', 0.5)).replace('.', ',')}%"
    if kind == "sessions_only":
        return "Торговать только: " + ", ".join(p.get("sessions") or [])
    if kind == "min_rr":
        return f"Плановый RR не ниже {str(p.get('rr', 2)).replace('.', ',')}"
    if kind == "symbols_only":
        return "Только инструменты: " + ", ".join(p.get("symbols") or [])
    if kind == "daily_loss":
        return f"Не входить после дневного убытка {str(p.get('pct', 3)).replace('.', ',')}%"
    if kind == "no_news":
        return f"Не входить за {p.get('minutes', 30)} мин до и после важных новостей"
    if kind == "no_reversal":
        return f"После стопа - ничего в обратную сторону на том же инструменте {p.get('minutes', 60)} мин"
    if kind == "late_reduced":
        return f"После {p.get('hour', 16)}:00 только A-сетап и риск не выше {str(late_limit(p)).replace('.', ',')}%"
    return KINDS.get(kind, kind)


def late_limit(p):
    """Лимит риска в позднем окне: доля от обычного риска ТС."""
    return round(float(p.get("max_pct", 1)) * float(p.get("factor", 0.5)), 2)


def violated(rule, t):
    k, p = rule["kind"], rule["params"]
    if k == "cooldown":
        return t.get("mins_after_loss") is not None and t["mins_after_loss"] < float(p.get("minutes", 30))
    if k == "max_trades_day":
        return t.get("nth_today", 0) > int(p.get("n", 2))
    if k == "stop_after_losses":
        return t.get("loss_streak_today", 0) >= int(p.get("n", 2))
    if k == "max_risk":
        return t.get("risk_pct") is not None and t["risk_pct"] > float(p.get("pct", 0.5)) * 1.1
    if k == "sessions_only":
        return bool(p.get("sessions")) and t.get("session") not in p["sessions"]
    if k == "no_phone":
        return t.get("open_reason") == 1
    if k == "require_sl":
        return not t.get("sl_used")
    if k == "min_rr":
        rr = planned_rr(t)
        return rr is not None and rr < float(p.get("rr", 2)) - 0.05
    if k == "symbols_only":
        return bool(p.get("symbols")) and not _sym_ok(t.get("symbol"), p["symbols"])
    if k == "daily_loss":
        bal = t.get("balance_at_entry")
        return bool(bal) and t.get("day_pnl_at_entry", 0) <= -bal * float(p.get("pct", 3)) / 100
    if k == "no_news":
        return t.get("news_minutes") is not None and t["news_minutes"] <= int(p.get("minutes", 30))
    if k == "no_reversal":
        return t.get("reversal_min") is not None and t["reversal_min"] < int(p.get("minutes", 60))
    if k == "late_reduced":
        # час - по времени журнала (время сервера брокера), как в списке сделок
        from datetime import datetime, timezone
        if datetime.fromtimestamp(t["open_time"], tz=timezone.utc).hour < int(p.get("hour", 16)):
            return False
        return (t.get("risk_pct") is not None and t["risk_pct"] > late_limit(p) * 1.1) or (bool(t.get("setup_grade")) and t["setup_grade"] != "A")
    return False


def ensure_schema(con):
    con.executescript(SCHEMA)


def load(con, login, active_only=True):
    ensure_schema(con)
    rows = con.execute("SELECT * FROM rules WHERE (login IS NULL OR login=?)" + (" AND active=1" if active_only else "")
                       + " ORDER BY created", (login,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["params"] = json.loads(d["params"] or "{}")
        out.append(d)
    return out


def add(con, login, kind, params, source=None, all_accounts=True):
    ensure_schema(con)
    cur = con.execute("INSERT INTO rules(login, kind, params, title, source, active, created) VALUES (?,?,?,?,?,1,?)",
                      (None if all_accounts else login, kind, json.dumps(params, ensure_ascii=False),
                       title_for(kind, params), source, int(time.time())))
    con.commit()
    return cur.lastrowid


def evaluate(rules_list, trades):
    """Возвращает статистику по каждому правилу и список нарушений по сделкам."""
    by_trade = {}
    stats = []
    for r in rules_list:
        bad = [t for t in trades if violated(r, t)]
        since = [t for t in bad if t["open_time"] >= (r.get("created") or 0)]
        good = [t for t in trades if not violated(r, t)]
        # правила из месячного разбора действуют с момента создания: прошлые сделки ими не судим
        for t in (since if r.get("source") == "review" else bad):
            by_trade.setdefault(t["position_id"], []).append(r["title"])
        rs_bad = [t["r"] for t in bad if t.get("r") is not None]
        rs_good = [t["r"] for t in good if t.get("r") is not None]
        stats.append({
            "id": r["id"], "kind": r["kind"], "title": r["title"], "params": r["params"], "source": r.get("source"),
            "created": r.get("created"), "violations": len(bad), "violations_since": len(since),
            "bad_net": round(sum(t["net"] for t in bad), 2), "since_net": round(sum(t["net"] for t in since), 2),
            "bad_avg_r": round(sum(rs_bad) / len(rs_bad), 2) if rs_bad else None,
            "good_avg_r": round(sum(rs_good) / len(rs_good), 2) if rs_good else None,
            "total": len(trades),
            "recent": [{"position_id": t["position_id"], "symbol": t["symbol"], "open_time": t["open_time"], "net": t["net"]}
                       for t in sorted(bad, key=lambda x: -x["open_time"])[:5]],
        })
    return stats, by_trade
