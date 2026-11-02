"""Сводка по всем счетам и трекер привычек."""
import json
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from . import analytics, prop
from . import rules as rules_mod
from . import settings as appset


def _stats(trades):
    rs = [t["r"] for t in trades if t.get("r") is not None]
    nets = [t["net"] for t in trades]
    gp, gl = sum(n for n in nets if n > 0), -sum(n for n in nets if n < 0)
    return {"count": len(trades), "net": round(sum(nets), 2), "win_rate": round(100 * sum(1 for n in nets if n > 0) / len(nets)) if nets else None,
            "pf": round(gp / gl, 2) if gl else None, "avg_r": round(sum(rs) / len(rs), 2) if rs else None, "sum_r": round(sum(rs), 2)}


def portfolio(con, shift_h):
    accs = con.execute("SELECT a.login, a.balance, a.equity, a.currency, a.company, a.last_sync, COALESCE(c.label, a.name) AS label "
                       "FROM accounts a LEFT JOIN account_configs c ON c.login=a.login ORDER BY COALESCE(c.created, 0), a.login").fetchall()
    out, allt = [], []
    for a in accs:
        a = dict(a)
        trades = [t for t in analytics.list_trades(con, {"login": a["login"], "status": "closed"}, shift_h)]
        try:
            pg = prop.progress(con, a["login"])
            a.update(initial=pg["initial"], profit=pg["profit"], profit_pct=pg["profit_pct"], status=pg["status"])
        except Exception:
            pass
        a["rules"] = prop.load_rules(con, a["login"])
        a.update(_stats(trades))
        out.append(a)
        allt += [dict(t, login=a["login"]) for t in trades]
    allt.sort(key=lambda t: t["close_time"] or t["open_time"])
    curve, run_r, run_m = [], 0.0, 0.0
    for t in allt:
        run_r += t["r"] or 0
        run_m += t["net"]
        curve.append({"time": t["close_time"], "r": round(run_r, 2), "net": round(run_m, 2), "login": t["login"]})
    by_month = defaultdict(lambda: defaultdict(float))
    for t in allt:
        m = datetime.fromtimestamp(t["close_time"], tz=timezone.utc).strftime("%Y-%m")
        by_month[m][t["login"]] += t["net"]
    total = _stats(allt)
    total["balance"] = round(sum(a["balance"] or 0 for a in out), 2)
    total["profit"] = round(sum(a.get("profit") or 0 for a in out), 2)
    return {"accounts": out, "total": total, "curve": curve,
            "months": [{"month": m, **{str(k): round(v, 2) for k, v in d.items()}} for m, d in sorted(by_month.items())][-12:]}


def habits(con, login, shift_h, days=84):
    """Отметки по дням: план до рынка, итог дня, разбор сделок, без нарушений, плюс недельный разбор."""
    shift = int(shift_h * 3600)
    today = datetime.fromtimestamp(time.time() + shift, tz=timezone.utc).date()
    start = today - timedelta(days=days - 1)
    dj = {}
    try:
        for r in con.execute("SELECT date, premarket, wrap, signed_off FROM day_journal WHERE login IN (0, ?)", (login,)):
            dj[r[0]] = r
    except Exception:
        pass
    trades = analytics.list_trades(con, {"login": login, "date_from": int(datetime.combine(start, datetime.min.time(), timezone.utc).timestamp()) - shift}, shift_h)
    tday = defaultdict(list)
    for t in trades:
        tday[datetime.fromtimestamp(t["open_time"] + shift, tz=timezone.utc).date().isoformat()].append(t)
    try:
        from . import analysis
        ctx = analysis.add_context(con, login, [t for t in trades if t["status"] == "closed"], shift_h)
        _, vio = rules_mod.evaluate(rules_mod.load(con, login), ctx)
    except Exception:
        vio = {}
    reviewed = lambda t: bool(t.get("grade") or t.get("followed_plan") is not None or (t.get("entry_reason") or "").strip() or t.get("setup"))
    rows = []
    d = start
    while d <= today:
        k = d.isoformat()
        j = dj.get(k)
        ts = tday.get(k, [])
        rows.append({"date": k, "weekday": d.weekday(), "traded": bool(ts),
                     "premarket": bool(j and (j[1] or "").strip()), "wrap": bool(j and ((j[2] or "").strip() or j[3])),
                     "reviewed": (all(reviewed(t) for t in ts) if ts else None),
                     "clean": (not any(t["position_id"] in vio for t in ts) if ts else None)})
        d += timedelta(days=1)
    try:
        weeks = {r[0] for r in con.execute("SELECT week FROM week_journal WHERE done=1")}
    except Exception:
        weeks = set()

    def streaks(key, workdays_only=True):
        cur = best = run = 0
        for r in rows:
            if workdays_only and r["weekday"] >= 5:
                continue
            v = r[key]
            if v is None:  # без сделок - разбор и нарушения не считаются
                continue
            run = run + 1 if v else 0
            best = max(best, run)
        for r in reversed(rows):
            if (workdays_only and r["weekday"] >= 5) or r[key] is None:
                continue
            if r["date"] == today.isoformat() and not r[key]:
                continue  # сегодняшний день ещё идёт
            if r[key]:
                cur += 1
            else:
                break
        return cur, best

    out = {}
    for k, title in (("premarket", "План до рынка"), ("wrap", "Итог дня"), ("reviewed", "Все сделки дня разобраны"), ("clean", "День без нарушений ТС")):
        cur, best = streaks(k)
        vals = [r[k] for r in rows if r[k] is not None and r["weekday"] < 5]
        out[k] = {"title": title, "streak": cur, "best": best, "rate": round(100 * sum(vals) / len(vals)) if vals else None}
    week_list = []
    d = today - timedelta(days=today.weekday())
    for i in range(12):
        y, w, _ = (d - timedelta(weeks=i)).isocalendar()
        week_list.append({"week": f"{y}-W{w:02d}", "done": f"{y}-W{w:02d}" in weeks})
    return {"days": rows, "habits": out, "weeks": list(reversed(week_list))}


def register(app, con, db_lock, current_login, shift_h):
    from flask import jsonify

    @app.get("/api/portfolio")
    def portfolio_get():
        with db_lock:
            return jsonify(portfolio(con, shift_h))

    @app.get("/api/habits")
    def habits_get():
        with db_lock:
            return jsonify(habits(con, current_login(), shift_h))
