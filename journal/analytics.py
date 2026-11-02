"""Расчёт показателей журнала."""
import json
from collections import defaultdict
from datetime import datetime, timezone

SOURCE = {0: "ПК", 1: "Телефон", 2: "Веб", 3: "Советник"}
CLOSE = {0: "Вручную (ПК)", 1: "Вручную (телефон)", 2: "Вручную (веб)", 3: "Советник",
         4: "Stop Loss", 5: "Take Profit", 6: "Stop Out", 7: "Ролловер", 8: "Вариационная маржа",
         9: "Сплит"}
WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

TRADE_SQL = """
SELECT t.*, n.setup, n.entry_reason, n.exit_reason, n.emotion, n.grade, n.mistakes, n.tags,
       n.notes, n.followed_plan, n.sl_manual, n.checklist, n.entry_model, n.arguments, n.setup_grade, n.drawings, n.exit_partial, n.exit_manual, n.updated_at AS note_updated, s.digits, a.server_offset,
       (SELECT COUNT(*) FROM trade_shots x WHERE x.login=t.login AND x.position_id=t.position_id) AS shots
FROM trades t
LEFT JOIN trade_notes n ON n.login=t.login AND n.position_id=t.position_id
LEFT JOIN symbols s ON s.symbol=t.symbol
LEFT JOIN accounts a ON a.login=t.login
"""


def enrich(t, shift_h=0, sessions=None):
    from .settings import DEFAULTS, session_of
    t = dict(t)
    utc_open = t["open_time"] - int(t.get("server_offset") or 0)
    t["session"] = session_of(sessions or DEFAULTS["sessions"], utc_open)
    try:
        ck = json.loads(t.get("checklist") or "{}")
    except ValueError:
        ck = {}
    t["checklist"] = ck
    t["check_total"] = len(ck)
    t["check_done"] = sum(1 for v in ck.values() if v)
    t["check_pct"] = round(100 * t["check_done"] / t["check_total"]) if t["check_total"] else None
    sl = t.get("sl_manual") or t.get("sl_initial")
    t["sl_used"] = sl
    risk = abs(t["entry_price"] - sl) if sl else None
    exit_ = t["exit_price"] if t["status"] == "closed" else t.get("price_current")
    t["r"] = None
    t["mae_r"] = t["mfe_r"] = None
    if risk and risk > 0:
        if exit_:
            t["r"] = round((exit_ - t["entry_price"]) * t["direction"] / risk, 2)
        if t.get("mae") is not None:
            t["mae_r"] = round(t["mae"] / risk, 2)
            t["mfe_r"] = round(t["mfe"] / risk, 2)
    end = t["close_time"] or None
    t["duration"] = (end - t["open_time"]) if end else None
    t["source"] = SOURCE.get(t.get("open_reason"), "Другое")
    t["close_label"] = CLOSE.get(t.get("close_reason"), "") if t["status"] == "closed" else ""
    t["shift"] = int(shift_h * 3600)
    if t.get("digits") is None:
        t["digits"] = 5 if t["entry_price"] < 20 else 2
    return t


def where_clause(f):
    sql, args = ["t.login=?"], [f["login"]]
    if f.get("status"):
        sql.append("t.status=?"); args.append(f["status"])
    if f.get("symbol"):
        sql.append("t.symbol=?"); args.append(f["symbol"])
    if f.get("direction"):
        sql.append("t.direction=?"); args.append(int(f["direction"]))
    if f.get("setup"):
        sql.append("n.setup=?"); args.append(f["setup"])
    if f.get("source") not in (None, ""):
        sql.append("t.open_reason=?"); args.append(int(f["source"]))
    if f.get("date_from"):
        sql.append("t.open_time>=?"); args.append(int(f["date_from"]))
    if f.get("date_to"):
        sql.append("t.open_time<?"); args.append(int(f["date_to"]))
    if f.get("q"):
        sql.append("(t.symbol LIKE ? OR n.notes LIKE ? OR n.tags LIKE ? OR n.setup LIKE ? OR CAST(t.position_id AS TEXT) LIKE ?)")
        args += [f"%{f['q']}%"] * 5
    return " WHERE " + " AND ".join(sql), args


def list_trades(con, f, shift_h=0):
    from . import settings
    sessions = settings.get(con, "sessions")
    w, a = where_clause(f)
    cur = con.execute(TRADE_SQL + w + " ORDER BY t.open_time DESC", a)
    out = [enrich(r, shift_h, sessions) for r in cur.fetchall()]
    if f.get("session"):
        out = [t for t in out if t["session"] == f["session"]]
    if f.get("plan") not in (None, ""):
        out = [t for t in out if str(t.get("followed_plan")) == str(f["plan"])
               or (f["plan"] == "none" and t.get("followed_plan") is None)]
    return out


def _group(trades, keyfn):
    g = defaultdict(lambda: {"count": 0, "net": 0.0, "wins": 0, "r": 0.0, "r_n": 0, "gp": 0.0, "gl": 0.0})
    for t in trades:
        k = keyfn(t)
        if k is None or k == "":
            continue
        x = g[k]
        x["count"] += 1
        x["net"] += t["net"]
        x["wins"] += t["net"] > 0
        if t["net"] > 0:
            x["gp"] += t["net"]
        else:
            x["gl"] += t["net"]
        if t["r"] is not None:
            x["r"] += t["r"]; x["r_n"] += 1
    out = []
    for k, x in g.items():
        out.append({"key": k, "count": x["count"], "net": round(x["net"], 2),
                    "win_rate": round(100 * x["wins"] / x["count"], 1),
                    "gross_profit": round(x["gp"], 2), "gross_loss": round(x["gl"], 2),
                    "avg_r": round(x["r"] / x["r_n"], 2) if x["r_n"] else None})
    return out


def stats(con, f, shift_h=0, balance_start=None, exclude=None):
    trades = [t for t in list_trades(con, dict(f, status="closed"), shift_h)
              if not (exclude and t["position_id"] in exclude)]
    trades.sort(key=lambda t: t["close_time"])
    shift = int(shift_h * 3600)
    n = len(trades)
    wins = [t for t in trades if t["net"] > 0]
    losses = [t for t in trades if t["net"] < 0]
    gp = sum(t["net"] for t in wins)
    gl = -sum(t["net"] for t in losses)
    net = gp - gl
    rs = [t["r"] for t in trades if t["r"] is not None]

    # кривая и просадка (в деньгах и параллельно в R: сделки без стопа в R-кривую не входят)
    equity, eq, peak, max_dd, last_t = [], 0.0, 0.0, 0.0, None
    eq_r, peak_r, max_dd_r = 0.0, 0.0, 0.0
    for t in trades:
        eq += t["net"]
        eq_r += t["r"] or 0
        tt = t["close_time"] + shift
        if last_t is not None and tt <= last_t:
            tt = last_t + 1
        last_t = tt
        equity.append({"time": tt, "value": round(eq, 2), "r": round(eq_r, 2), "id": t["position_id"]})
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
        peak_r = max(peak_r, eq_r)
        max_dd_r = max(max_dd_r, peak_r - eq_r)

    # серии
    best_w = best_l = cw = cl = 0
    for t in trades:
        if t["net"] > 0:
            cw += 1; cl = 0
        elif t["net"] < 0:
            cl += 1; cw = 0
        best_w, best_l = max(best_w, cw), max(best_l, cl)

    def day(ts):
        return datetime.fromtimestamp(ts + shift, tz=timezone.utc)

    daily = defaultdict(lambda: {"net": 0.0, "count": 0, "r": 0.0, "w": 0, "l": 0})
    for t in trades:
        d = day(t["close_time"]).strftime("%Y-%m-%d")
        daily[d]["net"] = round(daily[d]["net"] + t["net"], 2)
        daily[d]["count"] += 1
        daily[d]["r"] = round(daily[d]["r"] + (t["r"] or 0), 2)
        daily[d]["w"] += t["net"] > 0
        daily[d]["l"] += t["net"] < 0

    durs = [t["duration"] for t in trades if t["duration"]]
    summary = {
        "trades": n, "wins": len(wins), "losses": len(losses),
        "win_rate": round(100 * len(wins) / n, 1) if n else None,
        "net": round(net, 2), "gross_profit": round(gp, 2), "gross_loss": round(gl, 2),
        "profit_factor": round(gp / gl, 2) if gl else None,
        "avg_win": round(gp / len(wins), 2) if wins else None,
        "avg_loss": round(-gl / len(losses), 2) if losses else None,
        "expectancy": round(net / n, 2) if n else None,
        "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
        "sum_r": round(sum(rs), 2) if rs else None, "r_count": len(rs),
        "max_dd": round(max_dd, 2),
        "max_dd_pct": round(100 * max_dd / (balance_start + peak), 1) if balance_start and max_dd else None,
        "best": max((t["net"] for t in trades), default=None),
        "worst": min((t["net"] for t in trades), default=None),
        "best_r": max(rs, default=None), "worst_r": min(rs, default=None),
        "max_dd_r": round(max_dd_r, 2) if rs else None,
        "avg_win_r": round(sum(r for r in rs if r > 0) / len([r for r in rs if r > 0]), 2) if any(r > 0 for r in rs) else None,
        "avg_loss_r": round(sum(r for r in rs if r < 0) / len([r for r in rs if r < 0]), 2) if any(r < 0 for r in rs) else None,
        "avg_duration": int(sum(durs) / len(durs)) if durs else None,
        "streak_win": best_w, "streak_loss": best_l,
        "costs": round(sum(t["commission"] + t["swap"] + t["fee"] for t in trades), 2),
    }
    # результат после прибыльной и после убыточной сделки (по порядку открытия)
    seq = sorted(trades, key=lambda t: t["open_time"])
    after = {"win": [0, 0], "loss": [0, 0]}
    for prev, cur in zip(seq, seq[1:]):
        k = "win" if prev["net"] > 0 else "loss" if prev["net"] < 0 else None
        if k:
            after[k][0] += 1
            after[k][1] += cur["net"] > 0
    summary["after_win"] = {"count": after["win"][0], "win_rate": round(100 * after["win"][1] / after["win"][0], 1) if after["win"][0] else None}
    summary["after_loss"] = {"count": after["loss"][0], "win_rate": round(100 * after["loss"][1] / after["loss"][0], 1) if after["loss"][0] else None}
    # эффективность MFE: какая доля максимального движения в пользу забрана
    eff = []
    for t in trades:
        if t.get("mfe") and t["mfe"] > 0 and t.get("exit_price"):
            eff.append(max(-1.0, min(1.0, (t["exit_price"] - t["entry_price"]) * t["direction"] / t["mfe"])))
    summary["mfe_eff"] = round(100 * sum(eff) / len(eff), 1) if eff else None
    effw = [x for x, t in zip(eff, [t for t in trades if t.get("mfe") and t["mfe"] > 0 and t.get("exit_price")]) if t["net"] > 0]
    summary["mfe_eff_win"] = round(100 * sum(effw) / len(effw), 1) if effw else None
    summary["mfe_eff_n"] = len(eff)
    maes = [t["mae_r"] for t in trades if t.get("mae_r") is not None]
    summary["avg_mae_r"] = round(sum(maes) / len(maes), 2) if maes else None
    # тепловая карта день недели x час входа
    heat = defaultdict(lambda: [0, 0.0, 0])
    for t in trades:
        dd = day(t["open_time"])
        h = heat[(dd.weekday(), dd.hour)]
        h[0] += 1; h[1] += t["net"]; h[2] += t["net"] > 0
    heat_list = [{"wd": k[0], "h": k[1], "count": v[0], "net": round(v[1], 2), "wins": v[2]} for k, v in heat.items()]

    # метрики системы
    import math, statistics as _st
    if len(rs) >= 10:
        sd = _st.pstdev(rs)
        summary["sqn"] = round(math.sqrt(min(len(rs), 100)) * (sum(rs) / len(rs)) / sd, 2) if sd else None
    else:
        summary["sqn"] = None
    base = balance_start or 0
    drets = [v["net"] / base * 100 for _, v in sorted(daily.items())] if base else []
    if len(drets) >= 10:
        m, sd = _st.mean(drets), _st.pstdev(drets)
        down = [x for x in drets if x < 0]
        dsd = math.sqrt(sum(x * x for x in down) / len(drets)) if down else 0
        summary["sharpe"] = round(m / sd * math.sqrt(252), 2) if sd else None
        summary["sortino"] = round(m / dsd * math.sqrt(252), 2) if dsd else None
        dd_pct = 100 * max_dd / base if base else None
        summary["calmar"] = round(m * 252 / dd_pct, 2) if dd_pct else None
    else:
        summary["sharpe"] = summary["sortino"] = summary["calmar"] = None
    summary["recovery"] = round(net / max_dd, 2) if max_dd else None
    if wins and losses:
        wr, pay = len(wins) / n, (gp / len(wins)) / (gl / len(losses))
        summary["kelly"] = round(100 * (wr - (1 - wr) / pay), 1)
    else:
        summary["kelly"] = None
    be = [t for t in trades if (t["r"] is not None and abs(t["r"]) < 0.1) or (t["r"] is None and base and abs(t["net"]) < base * 0.0005)]
    summary["breakeven_pct"] = round(100 * len(be) / n, 1) if n else None
    summary["pct_base"] = base or None
    r_hist = defaultdict(int)
    for x in rs:
        r_hist[max(-4, min(6, round(x)))] += 1
    roll, win = [], 20
    seq_r = [t for t in trades if t["r"] is not None]
    for i in range(win - 1, len(seq_r)):
        chunk = seq_r[i - win + 1:i + 1]
        roll.append({"time": chunk[-1]["close_time"] + shift, "value": round(sum(x["r"] for x in chunk) / win, 3)})

    by_weekday = _group(trades, lambda t: day(t["open_time"]).weekday())
    for x in by_weekday:
        x["label"] = WEEKDAYS[x["key"]]
    by_weekday.sort(key=lambda x: x["key"])
    by_hour = sorted(_group(trades, lambda t: day(t["open_time"]).hour), key=lambda x: x["key"])
    pick = lambda arr: max((x for x in arr if x["count"] >= 3), key=lambda x: x["net"], default=None)
    bh = pick(by_hour)
    summary["best_hour"] = {"hour": bh["key"], "net": bh["net"], "count": bh["count"]} if bh else None
    bs = pick(_group(trades, lambda t: t["session"]))
    summary["best_session"] = {"name": bs["key"], "net": bs["net"], "count": bs["count"]} if bs else None
    return {
        "summary": summary, "equity": equity, "heat": heat_list,
        "r_hist": [{"r": k, "count": r_hist.get(k, 0)} for k in range(-4, 7)], "rolling": roll,
        "dur_points": [{"d": t["duration"], "net": t["net"], "r": t["r"], "id": t["position_id"], "symbol": t["symbol"],
                        "open": t["open_time"] + shift, "close": t["close_time"] + shift} for t in trades if t.get("duration")],
        "seq": [1 if t["net"] > 0 else -1 if t["net"] < 0 else 0 for t in trades][-60:],
        "by_model": sorted(_group(trades, lambda t: (t.get("entry_model") or "").strip()), key=lambda x: -x["count"]),
        "by_argument": sorted(_group([dict(t, _a=a.strip()) for t in trades for a in (t.get("arguments") or "").split(",") if a.strip()],
                                     lambda t: t["_a"]), key=lambda x: -x["count"]),
        "daily": dict(daily),
        "by_symbol": sorted(_group(trades, lambda t: t["symbol"]), key=lambda x: -x["count"]),
        "by_setup": sorted(_group(trades, lambda t: t.get("setup")), key=lambda x: -x["count"]),
        "by_source": sorted(_group(trades, lambda t: t["source"]), key=lambda x: -x["count"]),
        "by_close": sorted(_group(trades, lambda t: t["close_label"]), key=lambda x: -x["count"]),
        "by_direction": _group(trades, lambda t: "Buy" if t["direction"] == 1 else "Sell"),
        "by_weekday": by_weekday, "by_hour": by_hour,
        "by_session": _group(trades, lambda t: t["session"]),
        "by_plan": sorted(_group(trades, lambda t: {1: "По плану", 0: "Вне плана"}.get(t.get("followed_plan"), "Не отмечено")),
                          key=lambda x: x["key"]),
        "by_checklist": sorted(_group(trades, lambda t: None if t["check_pct"] is None else
                                      ("Чек-лист 100%" if t["check_pct"] == 100 else
                                       "Чек-лист 70-99%" if t["check_pct"] >= 70 else "Чек-лист меньше 70%")),
                               key=lambda x: x["key"]),
        "by_mistake": sorted(_group(
            [dict(t, _m=m.strip()) for t in trades for m in (t.get("mistakes") or "").split(",") if m.strip()],
            lambda t: t["_m"]), key=lambda x: -x["count"]),
    }
