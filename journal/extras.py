"""Распорядок дня, лента дней, плейбуки, заметки, серии."""
import base64
import json
import time
from datetime import date, datetime, timedelta, timezone

from flask import jsonify, request

from . import analytics
from . import settings as appset

SCHEMA = """
CREATE TABLE IF NOT EXISTS day_journal (
    login INTEGER NOT NULL, date TEXT NOT NULL,
    premarket TEXT, wrap TEXT, signed_off INTEGER DEFAULT 0, updated INTEGER,
    PRIMARY KEY (login, date)
);
CREATE TABLE IF NOT EXISTS playbooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, description TEXT, rules TEXT, checklist TEXT,
    example TEXT, active INTEGER DEFAULT 1, created INTEGER
);
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login INTEGER, date TEXT, title TEXT, body TEXT, tags TEXT,
    pinned INTEGER DEFAULT 0, created INTEGER, updated INTEGER
);
"""


def ensure_schema(con):
    con.executescript(SCHEMA)


def reviewed(t):
    return bool(t.get("setup") or t.get("grade") or t.get("entry_reason") or t.get("exit_reason")
                or t.get("notes") or t.get("followed_plan") is not None or t.get("check_done"))


def day_of(t, shift):
    ts = t["close_time"] if t["status"] == "closed" and t.get("close_time") else t["open_time"]
    return datetime.fromtimestamp(ts + shift, tz=timezone.utc).strftime("%Y-%m-%d")


def _jl(s, default):
    try:
        return json.loads(s) if s else default
    except ValueError:
        return default


SHARED = 0  # план дня и недельный разбор общие для всех счетов


def _merge_val(a, b):
    empty = (None, "", [], {})
    if a in empty:
        return b
    if b in empty:
        return a
    if isinstance(a, dict) and isinstance(b, dict):
        return {k: _merge_val(a.get(k), b.get(k)) for k in set(a) | set(b)}
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a or b)
    if isinstance(a, str) and isinstance(b, str):
        return a if (a == b or b in a) else a + "\n" + b
    if isinstance(a, list) and isinstance(b, list):
        return a + [x for x in b if x not in a]
    return a


def merge_to_shared(con, table, key, json_cols, flag_col):
    """Переносит записи отдельных счетов в общую (login=0), объединяя тексты и отметки."""
    rows = [dict(r) for r in con.execute(f"SELECT * FROM {table} WHERE login<>?", (SHARED,))]
    for r in rows:
        cur = con.execute(f"SELECT * FROM {table} WHERE login=? AND {key}=?", (SHARED, r[key])).fetchone()
        cur = dict(cur) if cur else {}
        vals = {c: json.dumps(_merge_val(_jl(cur.get(c), None), _jl(r.get(c), None)), ensure_ascii=False) for c in json_cols}
        flag = max(int(cur.get(flag_col) or 0), int(r.get(flag_col) or 0))
        cols = [key] + json_cols + [flag_col, "updated"]
        con.execute(f"INSERT OR REPLACE INTO {table}(login, {', '.join(cols)}) VALUES (?, {', '.join('?' * len(cols))})",
                    [SHARED, r[key]] + [vals[c] for c in json_cols] + [flag, int(time.time())])
        con.execute(f"DELETE FROM {table} WHERE login=? AND {key}=?", (r["login"], r[key]))
    con.commit()


def register(app, cfg, con, db_lock, q, current_login, shift_h, shots_dir):
    with db_lock:
        ensure_schema(con)
        merge_to_shared(con, "day_journal", "date", ["premarket", "wrap"], "signed_off")
    shift = int(shift_h * 3600)

    def account_labels():
        return {r["login"]: (r.get("label") or r.get("name") or str(r["login"])) for r in q(
            "SELECT a.login, a.name, c.label FROM accounts a LEFT JOIN account_configs c ON c.login=a.login")}

    def all_trades(login=None):
        """Сделки одного счёта или, если login=None, всех счетов (с полем login)."""
        with db_lock:
            if login:
                return analytics.list_trades(con, {"login": login}, shift_h)
            out = []
            for (lg,) in con.execute("SELECT login FROM accounts").fetchall():
                out += analytics.list_trades(con, {"login": lg}, shift_h)
            return out

    def journals(login=None):
        return {r["date"]: r for r in q("SELECT * FROM day_journal WHERE login=?", (SHARED,))}

    def day_curve(trades):
        pts, eq = [], 0.0
        for t in sorted([t for t in trades if t["status"] == "closed"], key=lambda t: t["close_time"]):
            eq += t["net"]
            pts.append({"time": t["close_time"] + shift, "value": round(eq, 2)})
        return pts

    # ------------------------------------------------------------------ день
    @app.get("/api/day")
    def day_get():
        d = request.args.get("date") or datetime.now().strftime("%Y-%m-%d")
        trades = [t for t in all_trades() if day_of(t, shift) == d]
        trades.sort(key=lambda t: t["open_time"])
        j = journals().get(d) or {}
        closed = [t for t in trades if t["status"] == "closed"]
        labels = account_labels()
        try:
            vio = all_vio()
        except Exception:
            vio = {}
        from . import twins
        with db_lock:
            tw = twins.groups(con, trades)
        for t in trades:
            t["account"] = labels.get(t["login"], str(t["login"]))
            t["violations"] = vio.get((t["login"], t["position_id"]), [])
            t["twins"] = [f"{lg}:{p}" for lg, p in tw.get((t["login"], t["position_id"]), [])]
        per = {}
        for t in closed:
            x = per.setdefault(t["login"], {"login": t["login"], "label": labels.get(t["login"]), "net": 0.0, "r": 0.0, "count": 0})
            x["net"] = round(x["net"] + t["net"], 2); x["r"] = round(x["r"] + (t["r"] or 0), 2); x["count"] += 1
        with db_lock:
            items = appset.get(con, "day_checklist")
        return jsonify({
            "date": d, "checklist_items": items,
            "premarket": _jl(j.get("premarket"), {}), "wrap": _jl(j.get("wrap"), {}),
            "signed_off": bool(j.get("signed_off")),
            "trades": trades, "curve": day_curve(trades),
            "net": round(sum(t["net"] for t in closed), 2), "count": len(trades),
            "wins": sum(1 for t in closed if t["net"] > 0), "closed": len(closed),
            "reviewed": sum(1 for t in trades if reviewed(t)), "r": round(sum(t["r"] or 0 for t in closed), 2),
            "accounts": list(per.values()),
        })

    @app.put("/api/day/<d>")
    def day_put(d):
        login = SHARED
        b = request.get_json(force=True)
        with db_lock:
            old = con.execute("SELECT premarket, wrap, signed_off FROM day_journal WHERE login=? AND date=?",
                              (login, d)).fetchone()
            pre = json.dumps(b["premarket"], ensure_ascii=False) if "premarket" in b else (old["premarket"] if old else None)
            wrap = json.dumps(b["wrap"], ensure_ascii=False) if "wrap" in b else (old["wrap"] if old else None)
            so = int(bool(b["signed_off"])) if "signed_off" in b else (old["signed_off"] if old else 0)
            con.execute("INSERT OR REPLACE INTO day_journal(login, date, premarket, wrap, signed_off, updated) "
                        "VALUES (?,?,?,?,?,?)", (login, d, pre, wrap, so, int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ лента дней и серии
    def build_days(login=None):
        trades = all_trades()
        js = journals()
        days = {}
        for t in trades:
            days.setdefault(day_of(t, shift), []).append(t)
        out = []
        for d in sorted(set(days) | {k for k, v in js.items() if v.get("premarket") or v.get("wrap")}, reverse=True):
            ts = days.get(d, [])
            closed = [t for t in ts if t["status"] == "closed"]
            j = js.get(d) or {}
            out.append({
                "date": d, "count": len(ts), "closed": len(closed), "net": round(sum(t["net"] for t in closed), 2),
                "r": round(sum(t["r"] or 0 for t in closed), 2),
                "wins": sum(1 for t in closed if t["net"] > 0), "reviewed": sum(1 for t in ts if reviewed(t)),
                "plan": sum(1 for t in ts if t.get("followed_plan") == 1),
                "off_plan": sum(1 for t in ts if t.get("followed_plan") == 0),
                "signed_off": bool(j.get("signed_off")), "has_plan": bool(_jl(j.get("premarket"), {})),
                "curve": day_curve(ts), "symbols": sorted({t["symbol"] for t in ts}),
            })
        return out

    @app.get("/api/days")
    def days_get():
        days = build_days()
        a, b = request.args.get("from"), request.args.get("to")
        if a:
            days = [x for x in days if x["date"] >= a]
        if b:
            days = [x for x in days if x["date"] <= b]
        return jsonify(days)

    @app.get("/api/streaks")
    def streaks():
        days = [x for x in build_days() if x["count"]]  # торговые дни, от новых к старым
        journal = 0
        for x in days:
            if x["signed_off"] or (x["count"] and x["reviewed"] == x["count"]):
                journal += 1
            else:
                break
        discipline = 0
        for x in days:
            if x["off_plan"] == 0 and x["plan"] == x["count"] and x["count"]:
                discipline += 1
            else:
                break
        return jsonify({"journal": journal, "discipline": discipline, "trading_days": len(days)})

    # ------------------------------------------------------------------ плейбуки
    @app.get("/api/playbooks")
    def pb_list():
        login = current_login()
        rows = q("SELECT * FROM playbooks ORDER BY active DESC, name")
        trades = [t for t in all_trades() if t["status"] == "closed"]  # плейбуки общие: статистика по всем счетам
        for p in rows:
            p["checklist"] = _jl(p["checklist"], [])
            ts = [t for t in trades if (t.get("setup") or "").strip().lower() == p["name"].strip().lower()]
            rs = [t["r"] for t in ts if t["r"] is not None]
            wins = sum(1 for t in ts if t["net"] > 0)
            p["stats"] = {"count": len(ts), "net": round(sum(t["net"] for t in ts), 2),
                          "win_rate": round(100 * wins / len(ts), 1) if ts else None,
                          "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
                          "plan_rate": round(100 * sum(1 for t in ts if t.get("followed_plan") == 1) / len(ts)) if ts else None,
                          "last": max((t["close_time"] for t in ts), default=None),
                          "ids": [t["position_id"] for t in sorted(ts, key=lambda t: -t["open_time"])[:8]],
                          "trades": [{"login": t["login"], "position_id": t["position_id"]} for t in sorted(ts, key=lambda t: -t["open_time"])[:8]]}
        known = {p["name"].strip().lower() for p in rows}
        free = sorted({(t.get("setup") or "").strip() for t in trades if t.get("setup")
                       and t["setup"].strip().lower() not in known})
        return jsonify({"playbooks": rows, "unlinked_setups": free})

    @app.post("/api/playbooks")
    def pb_save():
        b = request.get_json(force=True)
        name = (b.get("name") or "").strip()
        if not name:
            return jsonify({"message": "Укажите название"}), 400
        example = b.get("example")
        if b.get("example_data"):
            head, _, data = b["example_data"].partition(",")
            ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(head[5:].replace(";base64", ""), "png")
            rel = f"playbooks/{int(time.time() * 1000)}.{ext}"
            (shots_dir / rel).parent.mkdir(parents=True, exist_ok=True)
            (shots_dir / rel).write_bytes(base64.b64decode(data))
            example = rel
        vals = (name, b.get("description") or "", b.get("rules") or "",
                json.dumps([x for x in (b.get("checklist") or []) if x.strip()], ensure_ascii=False),
                example, 1 if b.get("active", True) else 0)
        with db_lock:
            try:
                if b.get("id"):
                    old = con.execute("SELECT name FROM playbooks WHERE id=?", (b["id"],)).fetchone()
                    con.execute("UPDATE playbooks SET name=?, description=?, rules=?, checklist=?, example=?, active=? "
                                "WHERE id=?", vals + (b["id"],))
                    if old and old["name"] != name:  # переименование - переносим сетап в сделках
                        con.execute("UPDATE trade_notes SET setup=? WHERE setup=?", (name, old["name"]))
                else:
                    con.execute("INSERT INTO playbooks(name, description, rules, checklist, example, active, created) "
                                "VALUES (?,?,?,?,?,?,?)", vals + (int(time.time()),))
                con.commit()
            except Exception as e:
                return jsonify({"message": "Плейбук с таким названием уже есть" if "UNIQUE" in str(e) else str(e)}), 400
        return jsonify({"ok": True})

    @app.delete("/api/playbooks/<int:pid>")
    def pb_del(pid):
        with db_lock:
            con.execute("DELETE FROM playbooks WHERE id=?", (pid,))
            con.commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ заметки
    @app.get("/api/notes")
    def notes_list():
        login = current_login()
        qs = request.args.get("q")
        sql = "SELECT * FROM notes WHERE (login IS NULL OR login=?)"
        args = [login]
        if qs:
            sql += " AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)"
            args += [f"%{qs}%"] * 3
        if request.args.get("pinned"):
            sql += " AND pinned=1"
        return jsonify(q(sql + " ORDER BY pinned DESC, COALESCE(updated, created) DESC", args))

    @app.post("/api/notes")
    def notes_save():
        b = request.get_json(force=True)
        now = int(time.time())
        login = None if b.get("all_accounts") else current_login()
        with db_lock:
            if b.get("id"):
                con.execute("UPDATE notes SET title=?, body=?, tags=?, pinned=?, date=?, login=?, updated=? WHERE id=?",
                            (b.get("title") or "", b.get("body") or "", b.get("tags") or "", 1 if b.get("pinned") else 0,
                             b.get("date") or None, login, now, b["id"]))
                nid = b["id"]
            else:
                cur = con.execute("INSERT INTO notes(login, date, title, body, tags, pinned, created, updated) "
                                  "VALUES (?,?,?,?,?,?,?,?)",
                                  (login, b.get("date") or None, b.get("title") or "", b.get("body") or "",
                                   b.get("tags") or "", 1 if b.get("pinned") else 0, now, now))
                nid = cur.lastrowid
            con.commit()
        return jsonify({"ok": True, "id": nid})

    @app.delete("/api/notes/<int:nid>")
    def notes_del(nid):
        with db_lock:
            con.execute("DELETE FROM notes WHERE id=?", (nid,))
            con.commit()
        return jsonify({"ok": True})


# ---------------------------------------------------------------------------- неделя, цели процесса, что сделать
GOAL_KINDS = {
    "max_trades_day": "Не больше {n} сделок в день",
    "max_trades_week": "Не больше {n} сделок за неделю",
    "review_all": "Разобрать все сделки недели",
    "no_violations": "Ни одного нарушения правил системы",
    "plan_every_day": "План до рынка в каждый торговый день",
    "close_days": "Закрывать каждый торговый день",
    "max_risk": "Риск не выше {pct}% в каждой сделке",
}


def week_bounds(week, shift):
    """'2026-W43' -> (start_ts, end_ts) по времени сервера брокера с учётом сдвига отображения."""
    y, w = week.split("-W")
    monday = date.fromisocalendar(int(y), int(w), 1)
    start = int(datetime(monday.year, monday.month, monday.day, tzinfo=timezone.utc).timestamp()) - shift
    return start, start + 7 * 86400


def iso_week(ts, shift):
    d = datetime.fromtimestamp(ts + shift, tz=timezone.utc).date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def goal_title(g):
    return GOAL_KINDS.get(g["kind"], g["kind"]).format(**({"n": 2, "pct": 0.5} | (g.get("params") or {})))


def eval_goal(g, trades, days, violations):
    k, p = g["kind"], g.get("params") or {}
    trading_days = sorted({t["day_key"] for t in trades})
    if k == "max_trades_day":
        worst = max((sum(1 for t in trades if t["day_key"] == d) for d in trading_days), default=0)
        return worst <= int(p.get("n", 2)), f"максимум {worst} в день"
    if k == "max_trades_week":
        return len(trades) <= int(p.get("n", 10)), f"{len(trades)} сделок"
    if k == "review_all":
        n = sum(1 for t in trades if reviewed(t))
        return n == len(trades), f"разобрано {n} из {len(trades)}"
    if k == "no_violations":
        v = sum(1 for t in trades if (t["login"], t["position_id"]) in violations)
        return v == 0, f"нарушений {v}"
    if k == "plan_every_day":
        n = sum(1 for d in trading_days if _jl((days.get(d) or {}).get("premarket"), {}))
        return n == len(trading_days), f"план в {n} из {len(trading_days)} дней"
    if k == "close_days":
        n = sum(1 for d in trading_days if (days.get(d) or {}).get("signed_off"))
        return n == len(trading_days), f"закрыто {n} из {len(trading_days)} дней"
    if k == "max_risk":
        over = sum(1 for t in trades if t.get("risk_pct") and t["risk_pct"] > float(p.get("pct", 0.5)) * 1.1)
        return over == 0, f"выше лимита {over}"
    return False, ""


def register_week(app, cfg, con, db_lock, q, current_login, shift_h, exclude_fn):
    from . import analysis, market
    shift = int(shift_h * 3600)
    with db_lock:
        con.execute("CREATE TABLE IF NOT EXISTS week_journal (login INTEGER NOT NULL, week TEXT NOT NULL, answers TEXT, "
                    "goals TEXT, done INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (login, week))")
        # общий для всех счетов план рынка на неделю
        con.execute("CREATE TABLE IF NOT EXISTS week_plan (week TEXT PRIMARY KEY, plan TEXT, updated INTEGER)")
        merge_to_shared(con, "week_journal", "week", ["answers", "goals"], "done")
        con.commit()

    def week_rec(login, week):
        r = q("SELECT * FROM week_journal WHERE login=? AND week=?", (SHARED, week))  # разбор общий для всех счетов
        r = r[0] if r else {}
        return {"answers": _jl(r.get("answers"), {}), "goals": _jl(r.get("goals"), []), "done": bool(r.get("done"))}

    def logins():
        return [r["login"] for r in q("SELECT login FROM accounts ORDER BY login")]

    def all_vio():
        out = {}
        for lg in logins():
            for pid, rules in exclude_fn(lg).items():
                out[(lg, pid)] = rules
        return out

    def week_trades(login, a, b):
        if login is None:
            res = []
            for lg in logins():
                res += week_trades(lg, a, b)
            return res
        with db_lock:
            ts = analysis.add_context(con, login, analytics.list_trades(con, {"login": login, "date_from": a, "date_to": b}, shift_h), shift_h)
        return [t for t in ts if t["status"] == "closed"] + [t for t in ts if t["status"] == "open"]

    def evaluate_goals(login, week, goals):
        a, b = week_bounds(week, shift)
        ts = [t for t in week_trades(None, a, b) if t["status"] == "closed"]  # цели проверяются по всем счетам
        days = {r["date"]: r for r in q("SELECT * FROM day_journal WHERE login=?", (SHARED,))}
        vio = all_vio()
        out = []
        for g in goals:
            ok, txt = eval_goal(g, ts, days, vio)
            out.append({**g, "title": goal_title(g), "ok": ok, "text": txt})
        return out

    def streak(login):
        weeks = {r["week"] for r in q("SELECT week FROM week_journal WHERE login=? AND done=1", (SHARED,))}
        cur = iso_week(int(time.time()), shift)
        y, w = map(int, cur.split("-W"))
        d = date.fromisocalendar(y, w, 1)
        n = 0
        # текущая неделя засчитывается, если уже сделана; иначе считаем с прошлой
        if cur not in weeks:
            d -= timedelta(days=7)
        while True:
            yy, ww, _ = d.isocalendar()
            if f"{yy}-W{ww:02d}" in weeks:
                n += 1
                d -= timedelta(days=7)
            else:
                return n

    def plan_of(week):
        r = q("SELECT plan FROM week_plan WHERE week=?", (week,))
        return _jl(r[0]["plan"], {}) if r else {}

    @app.get("/api/plan")
    def plan_get():
        week = request.args.get("week") or iso_week(int(time.time()), shift)
        return jsonify({"week": week, "plan": plan_of(week)})

    @app.put("/api/plan/<week>")
    def plan_put(week):
        b = request.get_json(force=True) or {}
        plan = {"focus": (b.get("focus") or "").strip(), "notes": b.get("notes") or "",
                "instruments": [{"symbol": (x.get("symbol") or "").strip(), "bias": x.get("bias") or "neutral",
                                 "levels": x.get("levels") or "", "scenario": x.get("scenario") or ""}
                                for x in (b.get("instruments") or []) if (x.get("symbol") or "").strip()]}
        with db_lock:
            con.execute("INSERT OR REPLACE INTO week_plan(week, plan, updated) VALUES (?,?,?)",
                        (week, json.dumps(plan, ensure_ascii=False), int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    @app.get("/api/week/all")
    def week_all():
        week = request.args.get("week") or iso_week(int(time.time()), shift)
        a, b = week_bounds(week, shift)
        out = []
        for acc in q("SELECT a.login, a.name, a.currency, c.label FROM accounts a LEFT JOIN account_configs c ON c.login=a.login "
                     "ORDER BY COALESCE(c.created, 0), a.login"):
            lg = acc["login"]
            ts = [t for t in week_trades(lg, a, b) if t["status"] == "closed"]
            vio = exclude_fn(lg)
            rs = [t["r"] for t in ts if t.get("r") is not None]
            out.append({"login": lg, "label": acc.get("label") or acc.get("name") or str(lg), "currency": acc.get("currency"),
                        "trades": len(ts), "net": round(sum(t["net"] for t in ts), 2),
                        "sum_r": round(sum(rs), 2) if rs else None,
                        "win_rate": round(100 * sum(1 for t in ts if t["net"] > 0) / len(ts), 1) if ts else None,
                        "reviewed": sum(1 for t in ts if reviewed(t)),
                        "violations": sum(1 for t in ts if t["position_id"] in vio), "done": week_rec(lg, week)["done"]})
        return jsonify({"week": week, "accounts": out})

    @app.get("/api/week")
    def week_get():
        login = current_login()
        week = request.args.get("week") or iso_week(int(time.time()), shift)
        a, b = week_bounds(week, shift)
        ts = week_trades(None, a, b)  # все счета
        closed = [t for t in ts if t["status"] == "closed"]
        with db_lock:
            ins = analysis.insights(con, login, {"login": login, "date_from": a - 23 * 86400, "date_to": b}, shift_h)
            mk = market.overview(cfg, con)
        vio = all_vio()
        rs = [t["r"] for t in closed if t.get("r") is not None]
        summary = {"trades": len(closed), "net": round(sum(t["net"] for t in closed), 2),
                   "sum_r": round(sum(rs), 2) if rs else None, "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
                   "win_rate": round(100 * sum(1 for t in closed if t["net"] > 0) / len(closed), 1) if closed else None}
        labels = {r["login"]: (r.get("label") or r.get("name") or str(r["login"])) for r in q(
            "SELECT a.login, a.name, c.label FROM accounts a LEFT JOIN account_configs c ON c.login=a.login")}
        per = []
        for lg in logins():
            c2 = [t for t in closed if t["login"] == lg]
            r2 = [t["r"] for t in c2 if t.get("r") is not None]
            per.append({"login": lg, "label": labels.get(lg, str(lg)), "trades": len(c2), "net": round(sum(t["net"] for t in c2), 2),
                        "sum_r": round(sum(r2), 2) if r2 else None, "reviewed": sum(1 for t in c2 if reviewed(t)),
                        "violations": sum(1 for t in c2 if (lg, t["position_id"]) in vio)})
        rec = week_rec(login, week)
        y, w = map(int, week.split("-W"))
        nxt = date.fromisocalendar(y, w, 1) + timedelta(days=7)
        ny, nw, _ = nxt.isocalendar()
        next_week = f"{ny}-W{nw:02d}"
        return jsonify({
            "week": week, "next_week": next_week, "start": a, "end": b, "record": rec,
            "summary": summary, "accounts": per,
            "best": sorted(closed, key=lambda t: -t["net"])[:3], "worst": sorted(closed, key=lambda t: t["net"])[:3],
            "violations": [{"login": t["login"], "position_id": t["position_id"], "symbol": t["symbol"], "net": t["net"],
                            "rules": vio[(t["login"], t["position_id"])]} for t in closed if (t["login"], t["position_id"]) in vio],
            "reviewed": sum(1 for t in closed if reviewed(t)), "closed": len(closed),
            "insights": ins["items"][:3],
            "goals_eval": evaluate_goals(login, week, rec["goals"]),
            "next_goals": week_rec(login, next_week)["goals"],
            "cot": [{"name": m["name"], "net": m["cot"]["net_nc"], "chg": m["cot"]["net_nc_chg"], "index": m["cot"]["index_nc"],
                     "date": m["cot"]["date"]} for m in mk["markets"] if m.get("cot")],
            "macro": [{"name": x["name"], "value": x["value"], "unit": x["unit"], "chg_w": x["chg_w"]} for x in mk["macro"]],
            "goal_kinds": GOAL_KINDS, "streak": streak(login),
            "plan_this": plan_of(week), "plan_next": plan_of(next_week), "cot_brief": cot_brief(),
        })

    def cot_brief():
        from . import settings as appset
        try:
            with db_lock:
                return market.cot_briefs(cfg, con, appset.get(con, "verdict"))
        except Exception:
            return {}

    @app.put("/api/week/<week>")
    def week_put(week):
        login = current_login()
        b = request.get_json(force=True)
        with db_lock:
            old = week_rec(login, week)
            ans = b.get("answers", old["answers"])
            goals = b.get("goals", old["goals"])
            done = int(b.get("done", old["done"]))
            con.execute("INSERT OR REPLACE INTO week_journal(login, week, answers, goals, done, updated) VALUES (?,?,?,?,?,?)",
                        (login, week, json.dumps(ans, ensure_ascii=False), json.dumps(goals, ensure_ascii=False), done, int(time.time())))
            if "next_goals" in b and b.get("next_week"):
                nr = week_rec(login, b["next_week"])
                con.execute("INSERT OR REPLACE INTO week_journal(login, week, answers, goals, done, updated) VALUES (?,?,?,?,?,?)",
                            (login, b["next_week"], json.dumps(nr["answers"], ensure_ascii=False),
                             json.dumps(b["next_goals"], ensure_ascii=False), int(nr["done"]), int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    def reminder_state(login):
        with db_lock:
            rm = appset.get(con, "reminder")
        now = datetime.fromtimestamp(time.time() + shift, tz=timezone.utc)
        cur = iso_week(int(time.time()), shift)
        prev = iso_week(int(time.time()) - 7 * 86400, shift)
        due = None
        if rm.get("enabled"):
            hh, mm = (rm.get("time") or "11:00").split(":")
            wd = now.weekday()
            after = wd > int(rm["day"]) or (wd == int(rm["day"]) and (now.hour, now.minute) >= (int(hh), int(mm)))
            if wd >= 5 and after and not week_rec(login, cur)["done"]:
                due = cur
            elif wd <= 1 and not week_rec(login, prev)["done"]:
                due = prev
        return due

    @app.get("/api/todo")
    def todo():
        login = current_login()
        items = []
        now = time.time()
        today = datetime.fromtimestamp(now + shift, tz=timezone.utc).strftime("%Y-%m-%d")
        weekday = datetime.fromtimestamp(now + shift, tz=timezone.utc).weekday()
        ts = []
        with db_lock:
            for lg in [r[0] for r in con.execute("SELECT login FROM accounts").fetchall()]:
                ts += analytics.list_trades(con, {"login": lg, "date_from": int(now) - 21 * 86400}, shift_h)
        # пара сделок одной идеи на разных счетах разбирается один раз:
        # если одна половина уже разобрана, её разбор переходит во вторую; иначе в очереди остаётся первая
        from . import twins
        with db_lock:
            tw = twins.groups(con, ts)
            byk = {(t["login"], t["position_id"]): t for t in ts}
            filled = False
            for k, others in tw.items():
                t = byk.get(k)
                if t and t["status"] == "closed" and not reviewed(t):
                    src = next((o for o in others if byk.get(o) and reviewed(byk[o])), None)
                    if src:
                        twins.copy_notes(con, src, [k])
                        filled = True
            if filled:
                con.commit()
                ts = []
                for lg in [r[0] for r in con.execute("SELECT login FROM accounts").fetchall()]:
                    ts += analytics.list_trades(con, {"login": lg, "date_from": int(now) - 21 * 86400}, shift_h)
        unrev = sorted([t for t in ts if t["status"] == "closed" and not reviewed(t)], key=lambda t: t["close_time"])
        seen, dedup = set(), []
        for t in unrev:
            k = (t["login"], t["position_id"])
            if k in seen:
                continue
            seen.add(k)
            seen.update(tw.get(k, []))
            dedup.append(t)
        unrev = dedup
        jr = (q("SELECT * FROM day_journal WHERE login=? AND date=?", (SHARED, today)) or [{}])[0]
        today_trades = [t for t in ts if day_of(t, shift) == today]
        if weekday < 5 and not _jl(jr.get("premarket"), {}):
            items.append({"kind": "plan", "text": "Заполнить план до рынка", "link": "#/day"})
        if unrev:
            items.append({"kind": "review", "text": f"Разобрать сделки: {len(unrev)}", "link": "#/review", "count": len(unrev)})
        if today_trades and not jr.get("signed_off"):
            items.append({"kind": "close", "text": "Закрыть день: итог и выводы", "link": "#/day"})
        due = reminder_state(login)
        if due:
            items.append({"kind": "week", "text": "Сделать недельный разбор" + (" прошлой недели" if due != iso_week(int(now), shift) else ""),
                          "link": f"#/week/{due}"})
        vio = all_vio()
        recent_v = [t for t in ts if (t["login"], t["position_id"]) in vio and t["open_time"] >= now - 7 * 86400]
        if recent_v:
            items.append({"kind": "violations", "text": f"Нарушения правил за 7 дней: {len(recent_v)}", "link": "#/analysis/rules"})
        last = q("SELECT status, message FROM sync_log WHERE login=? ORDER BY id DESC LIMIT 1", (login,))
        if last and last[0]["status"] == "error":
            items.append({"kind": "sync", "text": "Последняя синхронизация с ошибкой", "link": "#/sync"})
        return jsonify({"items": items, "unreviewed": [f"{t['login']}:{t['position_id']}" for t in unrev], "week_due": due})

    @app.get("/api/week/focus")
    def week_focus():
        login = current_login()
        cur = iso_week(int(time.time()), shift)
        prev = iso_week(int(time.time()) - 7 * 86400, shift)
        plan = plan_of(cur)
        return jsonify({"focus": plan.get("focus") or week_rec(login, prev)["answers"].get("focus", ""),
                        "plan": plan, "goals": evaluate_goals(login, cur, week_rec(login, cur)["goals"]), "week": cur,
                        "cot_brief": cot_brief()})

    return reminder_state
