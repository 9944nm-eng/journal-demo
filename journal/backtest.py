"""Бэктест по ручным уровням: актив, время, вход, стоп, тейк -> что было бы по минуткам из MT5.

Время сделки вводится как на графиках журнала (время сервера брокера плюс сдвиг отображения).
Котировки берутся из кэша базы, при нехватке - из терминала MT5 и сохраняются.
Если стоп и тейк задеты одной минутной свечой, порядок внутри свечи неизвестен: считаем, что первым
сработал стоп (консервативно), и помечаем сделку как неоднозначную.
"""
import json
import statistics
import time
from datetime import datetime, timezone

from .sync import TF_SEC, auto_tf, chart_window, fetch_chart_rates, list_accounts

SCHEMA = """
CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL, direction INTEGER NOT NULL, entry_type TEXT DEFAULT 'market',
    entry_time INTEGER NOT NULL, entry REAL NOT NULL, sl REAL NOT NULL, tp REAL,
    setup TEXT, notes TEXT, tags TEXT, result TEXT, created INTEGER, updated INTEGER
);
"""
HORIZON = 5 * 86400  # сколько ждать исполнения стопа или тейка


def ensure_schema(con):
    con.executescript(SCHEMA)
    if "grade" not in {r[1] for r in con.execute("PRAGMA table_info(backtests)")}:
        con.execute("ALTER TABLE backtests ADD COLUMN grade TEXT")
    con.commit()


def simulate(bars, direction, entry_type, entry, sl, tp, t0):
    """bars: [(time, o, h, l, c, v)] M1 по возрастанию. Возвращает итог сделки в R."""
    risk = abs(entry - sl)
    if risk <= 0:
        return {"outcome": "invalid", "message": "Стоп совпадает с входом"}
    if (sl - entry) * direction >= 0:
        return {"outcome": "invalid", "message": "Стоп должен быть " + ("ниже" if direction > 0 else "выше") + " входа"}
    if tp and (tp - entry) * direction <= 0:
        return {"outcome": "invalid", "message": "Тейк должен быть " + ("выше" if direction > 0 else "ниже") + " входа"}
    i = next((k for k, b in enumerate(bars) if b[0] + 60 > t0), None)
    if i is None:
        return {"outcome": "nodata", "message": "Нет котировок после времени входа"}
    fill_t = None
    if entry_type == "market":
        fill_t = max(t0, bars[i][0])
    else:
        while i < len(bars):
            b = bars[i]
            if b[3] <= entry <= b[2]:
                fill_t = b[0]
                break
            if tp and ((direction > 0 and b[2] >= tp) or (direction < 0 and b[3] <= tp)):
                return {"outcome": "missed", "message": "Цена дошла до тейка, не исполнив лимитный вход", "time": b[0]}
            i += 1
        if fill_t is None:
            return {"outcome": "missed", "message": "Лимитный вход не исполнился"}
    fav = adv = entry
    exit_p = exit_t = None
    outcome, ambiguous = "open", False
    for b in bars[i:]:
        hit_sl = b[3] <= sl if direction > 0 else b[2] >= sl
        hit_tp = bool(tp) and (b[2] >= tp if direction > 0 else b[3] <= tp)
        if hit_sl or hit_tp:
            ambiguous = hit_sl and hit_tp
            outcome = "sl" if hit_sl else "tp"
            exit_p, exit_t = (sl, b[0]) if hit_sl else (tp, b[0])
            if hit_sl:
                adv = sl
            else:
                fav = tp
                adv = min(adv, b[3]) if direction > 0 else max(adv, b[2])
            break
        fav = max(fav, b[2]) if direction > 0 else min(fav, b[3])
        adv = min(adv, b[3]) if direction > 0 else max(adv, b[2])
    message = ""
    if outcome == "open":
        exit_p, exit_t = bars[-1][4], bars[-1][0]
        message = ("Котировки есть только до " + datetime.fromtimestamp(exit_t, timezone.utc).strftime("%d.%m %H:%M")
                   if exit_t < t0 + HORIZON - 3 * 3600 else "За 5 дней не задет ни стоп, ни тейк") + ": итог по последней цене"
    r = (exit_p - entry) * direction / risk
    return {
        "outcome": outcome, "ambiguous": ambiguous, "fill_time": int(fill_t), "exit_time": int(exit_t + 60 if outcome == "open" else exit_t),
        "exit_price": exit_p, "r": round(r, 2), "planned_rr": round(abs(tp - entry) / risk, 2) if tp else None,
        "mfe_r": round(abs(fav - entry) / risk, 2), "mae_r": round(abs(adv - entry) / risk, 2),
        "duration": int(exit_t - fill_t), "message": message,
    }


def _acct(cfg, con):
    accs = list_accounts(cfg, con)
    a = next((x for x in accs if x.get("terminal_path")), accs[0] if accs else {})
    return {"terminal_path": a.get("terminal_path", ""), "login": 0} if cfg["mode"] != "demo" else a


def _symbol_names(con, sym):
    """Все известные журналу имена инструмента: XAUUSD, XAUUSD.raw... Точное имя - первым."""
    sym = sym.strip()
    have = [r[0] for r in con.execute("SELECT DISTINCT symbol FROM rates WHERE symbol LIKE ?", (sym + "%",))]
    have += [r[0] for r in con.execute("SELECT symbol FROM symbols WHERE symbol LIKE ?", (sym + "%",))]
    have += [r[0] for r in con.execute("SELECT DISTINCT symbol FROM trades WHERE symbol LIKE ?", (sym + "%",))]
    names = sorted(set(have), key=lambda s: (s.upper() != sym.upper(), len(s)))
    return names or [sym]


def _resolve_symbol(con, sym):
    return _symbol_names(con, sym)[0]


def fetch_any(cfg, con, sym, tf, a, b):
    """Котировки по первому имени инструмента, для которого они есть: в базе или в терминале.
    У разных брокеров суффиксы разные (XAUUSD у одного, XAUUSD.raw у другого)."""
    names = _symbol_names(con, sym)
    for name in names:
        bars, src = fetch_chart_rates(cfg, con, name, tf, a, b, _acct(cfg, con))
        if bars:
            return name, bars, src
    return names[0], [], "cache"


def compute(cfg, con, bt):
    t0 = int(bt["entry_time"])
    sym, bars, src = fetch_any(cfg, con, bt["symbol"], "M1", t0 - 120, t0 + HORIZON)
    res = simulate(bars, int(bt["direction"]), bt.get("entry_type") or "market", float(bt["entry"]), float(bt["sl"]),
                   float(bt["tp"]) if bt.get("tp") else None, t0)
    res["symbol_used"], res["source"] = sym, src
    return res


def _digits(con, sym, price):
    r = con.execute("SELECT digits FROM symbols WHERE symbol=?", (sym,)).fetchone()
    return r[0] if r and r[0] is not None else (5 if price < 20 else 2)


def row_out(r):
    d = dict(r)
    d["result"] = json.loads(d["result"] or "{}")
    return d


def stats(items, real=None):
    done = [x for x in items if x["result"].get("outcome") in ("tp", "sl", "open")]
    rs = [x["result"]["r"] for x in done]
    out = {"total": len(items), "count": len(done), "wins": sum(1 for r in rs if r > 0),
           "sum_r": round(sum(rs), 2), "avg_r": round(statistics.mean(rs), 2) if rs else None}
    out["win_rate"] = round(100 * out["wins"] / len(rs)) if rs else None
    gp, gl = sum(r for r in rs if r > 0), -sum(r for r in rs if r < 0)
    out["pf"] = round(gp / gl, 2) if gl else None
    curve, run, peak, dd = [], 0.0, 0.0, 0.0
    for x in sorted(done, key=lambda x: x["entry_time"]):
        run += x["result"]["r"]
        peak = max(peak, run)
        dd = max(dd, peak - run)
        curve.append({"time": x["result"].get("exit_time") or x["entry_time"], "value": round(run, 2)})
    out["max_dd_r"], out["curve"] = round(dd, 2), curve
    streak = worst = 0
    for r in rs:
        streak = streak + 1 if r <= 0 else 0
        worst = max(worst, streak)
    out["loss_streak"] = worst
    by = {}
    for x in done:
        k = x.get("setup") or "Без сетапа"
        g = by.setdefault(k, {"setup": k, "count": 0, "wins": 0, "sum_r": 0.0})
        g["count"] += 1
        g["wins"] += x["result"]["r"] > 0
        g["sum_r"] += x["result"]["r"]
    for g in by.values():
        g["avg_r"], g["win_rate"] = round(g["sum_r"] / g["count"], 2), round(100 * g["wins"] / g["count"])
        g["sum_r"] = round(g["sum_r"], 2)
        rr = (real or {}).get(g["setup"])
        g["real"] = rr
    out["by_setup"] = sorted(by.values(), key=lambda g: -g["count"])
    return out


def register(app, cfg, con, db_lock, current_login, shift_h):
    from flask import jsonify, request
    from . import analysis

    with db_lock:
        ensure_schema(con)
    shift = int(shift_h * 3600)

    def real_by_setup():
        """Реальные сделки по сетапам текущего счёта - для сравнения с бэктестом."""
        try:
            trades = analysis.closed_trades(con, {"login": current_login()}, shift_h)
        except Exception:
            return {}
        out = {}
        for t in trades:
            if t.get("r") is None or not t.get("setup"):
                continue
            g = out.setdefault(t["setup"], [])
            g.append(t["r"])
        return {k: {"count": len(v), "avg_r": round(sum(v) / len(v), 2), "win_rate": round(100 * sum(1 for r in v if r > 0) / len(v))}
                for k, v in out.items()}

    @app.get("/api/backtests")
    def bt_list():
        with db_lock:
            items = [row_out(r) for r in con.execute("SELECT * FROM backtests ORDER BY entry_time DESC")]
            # скриншоты бэктеста лежат вместе со скриншотами сделок под служебным счётом 0
            shots = {}
            for r in con.execute("SELECT id, position_id, file FROM trade_shots WHERE login=0 ORDER BY id"):
                shots.setdefault(r[1], []).append({"id": r[0], "file": r[2]})
            for x in items:
                x["shots"] = shots.get(x["id"], [])
            syms = sorted({r[0] for r in con.execute("SELECT symbol FROM symbols")} |
                          {r[0] for r in con.execute("SELECT DISTINCT symbol FROM trades")})
            setups = [r[0] for r in con.execute("SELECT name FROM playbooks WHERE active=1")] if \
                con.execute("SELECT name FROM sqlite_master WHERE name='playbooks'").fetchone() else []
            real = real_by_setup()
        return jsonify({"items": items, "stats": stats(items, real), "symbols": syms, "setups": setups, "shift": shift})

    @app.post("/api/backtests")
    def bt_save():
        b = request.get_json(force=True)
        try:
            when = datetime.strptime(b["time"], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp()
            bt = {"symbol": (b.get("symbol") or "").strip().upper(), "direction": 1 if int(b.get("direction") or 1) > 0 else -1,
                  "entry_type": "limit" if b.get("entry_type") == "limit" else "market",
                  "entry_time": int(when) - shift, "entry": float(b["entry"]), "sl": float(b["sl"]),
                  "tp": float(b["tp"]) if b.get("tp") not in (None, "") else None,
                  "setup": (b.get("setup") or "").strip(), "notes": b.get("notes") or "", "tags": (b.get("tags") or "").strip(),
                  "grade": b.get("grade") if b.get("grade") in ("A", "B", "C") else None}
        except (KeyError, ValueError, TypeError):
            return jsonify({"message": "Заполните актив, время, вход и стоп"}), 400
        if not bt["symbol"]:
            return jsonify({"message": "Укажите актив"}), 400
        with db_lock:
            res = compute(cfg, con, bt)
            now = int(time.time())
            if b.get("id"):
                con.execute("UPDATE backtests SET symbol=?, direction=?, entry_type=?, entry_time=?, entry=?, sl=?, tp=?, setup=?, notes=?, "
                            "tags=?, grade=?, result=?, updated=? WHERE id=?",
                            (bt["symbol"], bt["direction"], bt["entry_type"], bt["entry_time"], bt["entry"], bt["sl"], bt["tp"],
                             bt["setup"], bt["notes"], bt["tags"], bt["grade"], json.dumps(res), now, int(b["id"])))
                bid = int(b["id"])
            else:
                bid = con.execute("INSERT INTO backtests(symbol, direction, entry_type, entry_time, entry, sl, tp, setup, notes, tags, grade, "
                                  "result, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                  (bt["symbol"], bt["direction"], bt["entry_type"], bt["entry_time"], bt["entry"], bt["sl"], bt["tp"],
                                   bt["setup"], bt["notes"], bt["tags"], bt["grade"], json.dumps(res), now, now)).lastrowid
            con.commit()
        return jsonify({"ok": True, "id": bid, "result": res})

    @app.put("/api/backtests/<int:bid>/meta")
    def bt_meta(bid):
        """Оценка, теги и заметка без пересчёта по котировкам."""
        b = request.get_json(force=True)
        with db_lock:
            con.execute("UPDATE backtests SET grade=?, tags=?, notes=?, setup=?, updated=? WHERE id=?",
                        (b.get("grade") if b.get("grade") in ("A", "B", "C") else None, (b.get("tags") or "").strip(),
                         b.get("notes") or "", (b.get("setup") or "").strip(), int(time.time()), bid))
            con.commit()
        return jsonify({"ok": True})

    @app.delete("/api/backtests/<int:bid>")
    def bt_del(bid):
        with db_lock:
            con.execute("DELETE FROM trade_shots WHERE login=0 AND position_id=?", (bid,))
            con.execute("DELETE FROM backtests WHERE id=?", (bid,))
            con.commit()
        return jsonify({"ok": True})

    @app.get("/api/backtests/<int:bid>/chart")
    def bt_chart(bid):
        with db_lock:
            r = con.execute("SELECT * FROM backtests WHERE id=?", (bid,)).fetchone()
        if not r:
            return jsonify({"error": "Сделка бэктеста не найдена"}), 404
        x = row_out(r)
        res = x["result"]
        sym = res.get("symbol_used") or x["symbol"]
        t_in = res.get("fill_time") or x["entry_time"]
        t_out = res.get("exit_time") or t_in + 3600
        tf = request.args.get("tf") or auto_tf(t_out - t_in)
        if tf not in TF_SEC:
            tf = "M15"
        a, b_ = chart_window(t_in, t_out, tf)
        with db_lock:
            bars, src = fetch_chart_rates(cfg, con, sym, tf, a, b_, _acct(cfg, con))
            digits = _digits(con, sym, x["entry"])
        closed = res.get("outcome") in ("tp", "sl")
        trade = {"symbol": sym, "direction": x["direction"], "status": "closed" if closed else "open",
                 "open_time": t_in, "close_time": t_out if closed else None, "entry_price": x["entry"],
                 "exit_price": res.get("exit_price"), "sl_initial": x["sl"], "tp_initial": x["tp"],
                 "sl_current": x["sl"], "tp_current": x["tp"], "net": res.get("r") or 0, "r": res.get("r"), "digits": digits}
        deals = [{"time": t_in, "entry": 0, "price": x["entry"], "volume": "", "profit": 0}]
        if res.get("exit_price") is not None and res.get("outcome") in ("tp", "sl", "open"):
            deals.append({"time": t_out, "entry": 1, "price": res["exit_price"], "volume": "", "profit": res.get("r") or 0})
        return jsonify({"tf": tf, "source": src, "shift": shift, "trade": trade, "deals": deals, "news": chart_news(sym, a, b_),
                        "bars": [{"time": q[0], "open": q[1], "high": q[2], "low": q[3], "close": q[4]} for q in bars]})

    def chart_news(sym, a, b):
        from . import news as news_mod
        with db_lock:
            r = con.execute("SELECT server_offset FROM accounts WHERE server_offset IS NOT NULL LIMIT 1").fetchone()
            off = r[0] if r else 0
            try:
                items = news_mod.around(con, a - off, b - off, news_mod.currencies(sym))
            except Exception:
                items = []
        return [{"time": n["time"] + off, "currency": n["currency"], "title": n["title"]} for n in items]

    @app.get("/api/bars")
    def bars_get():
        """Свечи для пошагового воспроизведения: время - сервер брокера."""
        sym_in = (request.args.get("symbol") or "").strip().upper()
        tf = request.args.get("tf") or "M15"
        a, b = request.args.get("from", type=int), request.args.get("to", type=int)
        if not sym_in or tf not in TF_SEC or not a or not b:
            return jsonify({"message": "Укажите актив, таймфрейм и период"}), 400
        with db_lock:
            sym, bars, src = fetch_any(cfg, con, sym_in, tf, a - shift, b - shift)
            digits = _digits(con, sym, bars[0][4] if bars else 100)
        return jsonify({"symbol": sym, "tf": tf, "source": src, "digits": digits, "shift": shift, "news": chart_news(sym, a - shift, b - shift),
                        "bars": [{"time": q[0], "open": q[1], "high": q[2], "low": q[3], "close": q[4]} for q in bars]})
