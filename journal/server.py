"""Локальный веб-сервер журнала: API + статический интерфейс."""
import base64
import csv
import io
import json
import os
import threading
import time
from datetime import datetime, timezone

from flask import Flask, Response, jsonify, request, send_from_directory

from . import analytics
from .config import ROOT, load_config
from .db import connect, rows
from . import backtest, export, market, news as news_mod, portfolio, precheck, prop
from . import settings as appset
from . import sync as sync_mod
from . import ts as ts_mod
from . import twins as twins_mod
from .secret import encrypt
from .sync import (PROP_PRESETS, TF_SEC, account_by_login, auto_tf, chart_window, fetch_chart_rates,
                   list_accounts, run_sync, test_connection)

WEB = ROOT / "web"
NOTE_FIELDS = ["setup", "entry_reason", "exit_reason", "emotion", "grade", "mistakes",
               "tags", "notes", "followed_plan", "sl_manual", "checklist", "entry_model", "arguments", "setup_grade",
               "exit_partial", "exit_manual"]


def create_app(cfg):
    app = Flask(__name__, static_folder=None)
    con = connect(cfg["db_path"])
    db_lock = threading.RLock()
    shift_h = cfg.get("display_shift_hours", 0)

    def q(sql, args=()):
        with db_lock:
            return rows(con.execute(sql, args))

    def current_login():
        lg = request.args.get("login", type=int)
        if lg:
            return lg
        r = q("SELECT a.login FROM accounts a LEFT JOIN account_configs c ON c.login=a.login "
              "ORDER BY COALESCE(c.created, 0), a.login LIMIT 1")
        return r[0]["login"] if r else 0

    def filters():
        a = request.args
        return {"login": current_login(), "symbol": a.get("symbol"), "direction": a.get("direction"),
                "setup": a.get("setup"), "source": a.get("source"), "status": a.get("status"),
                "date_from": a.get("from", type=int), "date_to": a.get("to", type=int),
                "q": a.get("q"), "session": a.get("session"), "plan": a.get("plan")}

    # ------------------------------------------------------------------ static
    @app.get("/")
    def index():
        return send_from_directory(WEB, "index.html", max_age=0)

    # max_age=0: браузер сверяет файлы при каждой загрузке (ответ 304, если не менялись).
    # Иначе после обновления журнала он мог взять старый скрипт рядом с новыми, и страница ломалась
    @app.get("/<path:p>")
    def static_files(p):
        return send_from_directory(WEB, p, max_age=0)

    # ------------------------------------------------------------------ api
    @app.get("/api/state")
    def state():
        login = current_login()
        acc = q("SELECT a.*, c.label, (r.rules IS NOT NULL AND r.rules LIKE '%\"kind\": \"prop\"%') AS is_prop "
                "FROM accounts a LEFT JOIN account_configs c ON c.login=a.login "
                "LEFT JOIN account_rules r ON r.login=a.login ORDER BY COALESCE(c.created, 0), a.login")
        start = q("SELECT SUM(profit) AS s FROM deals WHERE login=? AND type=2", (login,))
        opts = {
            "symbols": [r["symbol"] for r in q("SELECT DISTINCT symbol FROM trades WHERE login=? ORDER BY symbol", (login,))],
            # подсказки общие для всех счетов
            "setups": [r["setup"] for r in q("SELECT DISTINCT setup FROM trade_notes WHERE setup<>'' ORDER BY setup")],
            "emotions": [r["emotion"] for r in q("SELECT DISTINCT emotion FROM trade_notes WHERE emotion<>'' ORDER BY emotion")],
            "mistakes": sorted({m.strip() for r in q("SELECT mistakes FROM trade_notes")
                                for m in (r["mistakes"] or "").split(",") if m.strip()}),
            "models": [r["entry_model"] for r in q("SELECT DISTINCT entry_model FROM trade_notes WHERE entry_model<>'' ORDER BY entry_model")],
            "arguments": sorted({m.strip() for r in q("SELECT arguments FROM trade_notes") for m in (r["arguments"] or "").split(",") if m.strip()}),
        }
        return jsonify({
            "mode": cfg["mode"], "login": login, "accounts": acc,
            "deposits": start[0]["s"] if start else None,
            "log": q("SELECT * FROM sync_log ORDER BY id DESC LIMIT 15"),
            "options": opts, "shift": int(shift_h * 3600), "now": int(time.time()),
            "sessions": appset.get(con, "sessions"), "checklist": appset.get(con, "checklist"),
            "base": (prop.load_rules(con, login).get("account_size") or None) if prop.load_rules(con, login).get("kind") == "prop" else None,
            "version": __import__("journal").__version__,
            "ts_saved": appset.get(con, "ts").get("saved"),
            "sync_paused": sync_mod.weekend_paused(con),
            "playbooks": [{"name": r["name"], "checklist": json.loads(r["checklist"] or "[]")} for r in
                          q("SELECT name, checklist FROM playbooks WHERE active=1 ORDER BY name")],
        })

    @app.post("/api/sync")
    def sync():
        body = request.get_json(silent=True) or {}
        res = run_sync(cfg, full=bool(body.get("full")), login=body.get("account") or None)
        return jsonify(res), (200 if res["status"] != "error" else 502)

    # ------------------------------------------------------------------ счета
    def _rules_of(login):
        with db_lock:
            return prop.load_rules(con, login)

    @app.get("/api/accounts")
    def accounts_list():
        with db_lock:
            accs = list_accounts(cfg, con, only_enabled=False)
        stats = {r["login"]: r for r in q("SELECT * FROM accounts")}
        out = []
        for a in accs:
            st = stats.get(a["login"], {})
            out.append({"login": a["login"], "label": a.get("label") or st.get("name") or "",
                        "server": a.get("server") or st.get("server") or "",
                        "terminal_path": a.get("terminal_path") or "", "enabled": a.get("enabled", 1),
                        "has_password": bool(a.get("password")), "legacy": bool(a.get("legacy")),
                        "balance": st.get("balance"), "equity": st.get("equity"),
                        "currency": st.get("currency"), "company": st.get("company"), "holder": st.get("name") or "",
                        "last_sync": st.get("last_sync"), "rules": _rules_of(a["login"])})
        # счета, которые уже синхронизировались (например, из терминала через config.json),
        # но не добавлены в «Счета»: для них можно задать цели без пароля
        configured = {a["login"] for a in accs}
        auto = [st for lg, st in stats.items() if lg not in configured]
        if auto:
            out = [x for x in out if not x["legacy"]]
        for st in auto:
            lg = st["login"]
            out.append({"login": lg, "label": st.get("name") or "", "server": st.get("server") or "",
                        "terminal_path": "", "enabled": 1, "has_password": False, "legacy": False, "auto": True,
                        "sync_note": "Синхронизируется, только пока этот счёт открыт в терминале по умолчанию. "
                                     "Чтобы журнал обновлял его всегда, укажите данные подключения и путь к его терминалу.",
                        "balance": st.get("balance"), "equity": st.get("equity"), "currency": st.get("currency"),
                        "company": st.get("company"), "holder": st.get("name") or "",
                        "last_sync": st.get("last_sync"), "rules": _rules_of(lg)})
        # карточки: мини-кривая баланса, статус, этап, фирма
        with db_lock:
            ov = appset.get(con, "sync").get("overrides") or {}
            for x in out:
                lg = x["login"]
                if not lg:
                    continue
                r = x["rules"]
                st = r.get("status_override") or "auto"
                pg = None
                if x.get("balance") is not None:
                    try:
                        pg = prop.progress(con, lg)
                    except Exception:
                        pg = None
                if pg:
                    # результат и кривая - от стартового баланса (размер счёта или первый депозит), без пополнений
                    vals = [p["value"] for p in pg["points"][1:]]
                    step = max(1, len(vals) // 120)
                    x["spark"] = [pg["initial"]] + vals[::step][:-1] + vals[-1:] if vals else [pg["initial"]]
                    x["initial"], x["pnl"], x["pnl_pct"] = pg["initial"], pg["profit"], pg["profit_pct"]
                if r.get("kind") == "prop" and pg:
                    ob = {o["key"]: o for o in pg["objectives"]}
                    dl, tl = ob.get("daily"), ob.get("total")
                    x["progress"] = {
                        "target_pct": r.get("profit_target_pct"), "loss_pct": r.get("max_loss_pct"),
                        "target_level": pg["target_level"], "floor_level": pg["floor_level"],
                        "trailing": r.get("max_loss_type") == "trailing",
                        "daily": dl and {"pct": dl["progress"], "used": dl["value"], "limit": dl["limit"],
                                         "left": max(0.0, dl["limit"] - dl["value"]), "fail": dl["status"] == "fail"},
                        # общий лимит: максимальная просадка от старта за весь челлендж, остаток - до уровня провала сейчас
                        "total": tl and {"pct": tl["progress"], "used": tl["value"], "limit": tl["limit"],
                                         "left": max(0.0, min(pg["balance"], pg["equity"]) - pg["floor_level"]),
                                         "fail": tl["status"] == "fail"},
                        "days": pg["trading_days"], "min_days": r.get("min_trading_days")}
                if st == "auto":
                    st = {"failed": "failed", "passed": "passed"}.get(pg["status"], "active") \
                        if r.get("kind") == "prop" and pg else "active"
                x["status"] = st
                x["phase"] = r.get("phase") or ""
                x["firm"] = r.get("firm") or x.get("company") or ""
                x["sync_minutes"] = ov.get(str(lg))
        shared = [a["login"] for a in accs if not a.get("terminal_path")]
        return jsonify({"accounts": out, "mode": cfg["mode"], "presets": PROP_PRESETS,
                        "defaults": prop.DEFAULT_RULES, "shared_terminal": len(shared) > 1})

    def _acct_from_body(b):
        return {"login": int(b.get("login") or 0), "server": (b.get("server") or "").strip(),
                "password": b.get("password") or "", "terminal_path": (b.get("terminal_path") or "").strip(),
                "label": (b.get("label") or "").strip()}

    @app.post("/api/accounts/test")
    def accounts_test():
        b = request.get_json(force=True)
        acct = _acct_from_body(b)
        if not acct["password"] and acct["login"]:
            old = next((a for a in list_accounts(cfg, con, only_enabled=False) if a["login"] == acct["login"]), None)
            acct["password"] = (old or {}).get("password", "")
        try:
            info = test_connection(cfg, acct)
        except Exception as e:
            return jsonify({"ok": False, "message": str(e)}), 400
        return jsonify({"ok": True, "account": info})

    @app.post("/api/accounts")
    def accounts_save():
        b = request.get_json(force=True)
        a = _acct_from_body(b)
        if not a["login"]:
            return jsonify({"message": "Укажите номер счёта"}), 400
        with db_lock:
            old = con.execute("SELECT password_enc, created FROM account_configs WHERE login=?",
                              (a["login"],)).fetchone()
            pw = encrypt(a["password"]) if a["password"] else (old["password_enc"] if old else "")
            if not pw and cfg["mode"] != "demo":
                return jsonify({"message": "Укажите пароль (лучше инвесторский)"}), 400
            con.execute(
                "INSERT INTO account_configs(login, label, server, password_enc, terminal_path, enabled, created) "
                "VALUES (?,?,?,?,?,?,?) ON CONFLICT(login) DO UPDATE SET label=excluded.label, "
                "server=excluded.server, password_enc=excluded.password_enc, "
                "terminal_path=excluded.terminal_path, enabled=excluded.enabled",
                (a["login"], a["label"], a["server"], pw, a["terminal_path"],
                 1 if b.get("enabled", True) else 0, old["created"] if old else int(time.time())))
            rules = dict(prop.DEFAULT_RULES)
            rules.update(b.get("rules") or {})
            con.execute("INSERT OR REPLACE INTO account_rules(login, rules, updated_at) VALUES (?,?,?)",
                        (a["login"], json.dumps(rules, ensure_ascii=False), int(time.time())))
            con.commit()
        res = run_sync(cfg, login=a["login"]) if b.get("sync_now") else None
        return jsonify({"ok": True, "sync": res})

    @app.put("/api/accounts/<int:login>/rules")
    def rules_save(login):
        rules = dict(prop.DEFAULT_RULES)
        rules.update(request.get_json(force=True) or {})
        with db_lock:
            con.execute("INSERT OR REPLACE INTO account_rules(login, rules, updated_at) VALUES (?,?,?)",
                        (login, json.dumps(rules, ensure_ascii=False), int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    @app.delete("/api/accounts/<int:login>")
    def accounts_delete(login):
        with db_lock:
            for t in ("account_configs", "account_rules", "accounts", "deals", "orders", "trades",
                      "trade_notes", "sync_log"):
                con.execute(f"DELETE FROM {t} WHERE login=?", (login,))
            con.commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ настройки и копии
    @app.get("/api/settings")
    def settings_get():
        with db_lock:
            data = appset.get_all(con)
        data["backups"] = appset.list_backups(cfg["db_path"])
        data["defaults"] = appset.DEFAULTS
        data["backup_dir"] = str(appset.backup_dir(cfg["db_path"]))
        return jsonify(data)

    @app.put("/api/settings/<key>")
    def settings_put(key):
        try:
            with db_lock:
                appset.put(con, key, request.get_json(force=True))
        except KeyError:
            return jsonify({"message": "Неизвестная настройка"}), 400
        return jsonify({"ok": True})

    @app.post("/api/backups")
    def backup_now():
        with db_lock:
            name = appset.make_backup(con, cfg["db_path"], int(appset.get(con, "backup")["keep"]))
        return jsonify({"ok": True, "name": name})

    # ------------------------------------------------------------------ скриншоты
    shots_dir = ROOT / "data" / "shots" if "demo.db" not in cfg["db_path"] else ROOT / "data" / "shots-demo"

    from . import extras
    extras.register(app, cfg, con, db_lock, q, current_login, shift_h, shots_dir)

    @app.post("/api/trade/<int:login>/<int:pid>/shots")
    def shot_add(login, pid):
        b = request.get_json(force=True)
        head, _, data = (b.get("data") or "").partition(",")
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(
            head.replace("data:", "").replace(";base64", ""))
        if not ext or not data:
            return jsonify({"message": "Нужна картинка PNG, JPG, WEBP или GIF"}), 400
        raw = base64.b64decode(data)
        if len(raw) > 15 * 1024 * 1024:
            return jsonify({"message": "Картинка больше 15 МБ"}), 400
        rel = f"{login}/{pid}/{int(time.time() * 1000)}.{ext}"
        path = shots_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        with db_lock:
            con.execute("INSERT INTO trade_shots(login, position_id, file, caption, created) VALUES (?,?,?,?,?)",
                        (login, pid, rel, b.get("caption") or "", int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    @app.delete("/api/shots/<int:sid>")
    def shot_del(sid):
        r = q("SELECT file FROM trade_shots WHERE id=?", (sid,))
        if r:
            try:
                (shots_dir / r[0]["file"]).unlink()
            except OSError:
                pass
            with db_lock:
                con.execute("DELETE FROM trade_shots WHERE id=?", (sid,))
                con.commit()
        return jsonify({"ok": True})

    @app.get("/shots/<path:rel>")
    def shot_file(rel):
        return send_from_directory(shots_dir, rel)

    # ------------------------------------------------------------------ экспорт
    def _export_data():
        f = filters()
        with db_lock:
            data = analytics.list_trades(con, f, shift_h)
            dep = con.execute("SELECT SUM(profit) FROM deals WHERE login=? AND type=2", (f["login"],)).fetchone()[0]
            st = analytics.stats(con, f, shift_h, dep)
            for t in data:
                t["_shots"] = [r[0] for r in con.execute(
                    "SELECT file FROM trade_shots WHERE login=? AND position_id=? ORDER BY id", (t["login"], t["position_id"]))]
        acc = (q("SELECT a.*, c.label FROM accounts a LEFT JOIN account_configs c ON c.login=a.login WHERE a.login=?",
                 (f["login"],)) or [{"login": f["login"]}])[0]
        return data, st, acc

    @app.get("/api/export.xlsx")
    def export_xlsx():
        data, st, acc = _export_data()
        body = export.to_xlsx(data, st, acc, int(shift_h * 3600))
        return Response(body, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": f"attachment; filename=journal-{acc['login']}.xlsx"})

    @app.get("/api/export.html")
    def export_html():
        data, st, acc = _export_data()
        body = export.to_html(data, st, acc, int(shift_h * 3600), shots_dir, request.args.get("shots") != "0")
        return Response(body, mimetype="text/html", headers={
            "Content-Disposition": f"attachment; filename=journal-report-{acc['login']}.html"})

    # ------------------------------------------------------------------ анализ
    from . import analysis

    def _max_risk():
        with db_lock:
            return float(appset.get(con, "risk")["max_risk_pct"])

    @app.get("/api/analysis/insights")
    def an_insights():
        f = filters()
        with db_lock:
            return jsonify(analysis.insights(con, f["login"], f, shift_h, _max_risk()))

    @app.get("/api/analysis/whatif")
    def an_whatif():
        f = filters()
        parse = lambda key, dflt: [float(x) for x in (request.args.get(key) or "").split(",") if x.strip()] or dflt
        tps = parse("tp", [1, 1.5, 2, 3])
        hours = parse("hours", [2, 4, 8])
        with db_lock:
            return jsonify(analysis.whatif(con, f["login"], f, shift_h, tps, hours, _max_risk()))

    @app.post("/api/analysis/prepare")
    def an_prepare():
        from .sync import _lock, account_by_login, make_provider
        f = filters()
        if not _lock.acquire(timeout=60):
            return jsonify({"message": "Идёт синхронизация, повторите позже"}), 409
        try:
            with db_lock:
                trades = analysis.closed_trades(con, f, shift_h)
                acct = account_by_login(cfg, con, f["login"]) or {}
            p = make_provider(cfg, {"terminal_path": acct.get("terminal_path", ""), "login": 0} if cfg["mode"] != "demo" else acct)
            try:
                p.connect()
                with db_lock:
                    n = analysis.prepare(p, con, trades)
            finally:
                p.close()
        except Exception as e:
            return jsonify({"message": f"Не удалось получить котировки из терминала: {e}"}), 502
        finally:
            _lock.release()
        return jsonify({"ok": True, "loaded": n})

    @app.get("/api/analysis/market")
    def an_market():
        login = current_login()
        with db_lock:
            syms = [r["symbol"] for r in q("SELECT symbol, COUNT(*) c FROM trades WHERE login=? GROUP BY symbol ORDER BY c DESC", (login,))]
            sym = request.args.get("symbol") or (syms[0] if syms else "XAUUSD")
            off = (q("SELECT server_offset FROM accounts WHERE login=?", (login,)) or [{}])[0].get("server_offset") or 0
            res = analysis.market_stats(con, sym, off, appset.get(con, "sessions"))
        res["symbols"] = syms
        return jsonify(res)

    @app.post("/api/analysis/market/load")
    def an_market_load():
        from .sync import _lock, account_by_login, make_provider
        login = current_login()
        sym = request.args.get("symbol")
        if not sym:
            return jsonify({"message": "Не указан инструмент"}), 400
        if not _lock.acquire(timeout=60):
            return jsonify({"message": "Идёт синхронизация, повторите позже"}), 409
        try:
            with db_lock:
                acct = account_by_login(cfg, con, login) or {}
            p = make_provider(cfg, {"terminal_path": acct.get("terminal_path", ""), "login": 0} if cfg["mode"] != "demo" else acct)
            try:
                p.connect()
                now = int(time.time())
                bars = p.rates(sym, "H1", now - 2 * 365 * 86400, now + 86400)
                with db_lock:
                    from .sync import store_rates
                    store_rates(con, sym, "H1", bars)
                    con.commit()
            finally:
                p.close()
        except Exception as e:
            return jsonify({"message": f"Не удалось получить историю из терминала: {e}"}), 502
        finally:
            _lock.release()
        return jsonify({"ok": True, "bars": len(bars)})

    @app.get("/api/cot-test")
    def cot_test():
        with db_lock:
            return jsonify(market.cot_signal_test(cfg, con))

    @app.get("/api/analysis/mc")
    def an_mc():
        f = filters()
        a = request.args
        with db_lock:
            rs, tpd, cur_risk = analysis.montecarlo_input(con, f["login"], f, shift_h)
            rules = prop.load_rules(con, f["login"])
        if len(rs) < 10:
            return jsonify({"message": f"Нужно хотя бы 10 закрытых сделок со стопом, сейчас {len(rs)}"}), 400
        if rules.get("kind") != "prop":
            rules = dict(prop.DEFAULT_RULES)
        for k in ("profit_target_pct", "max_daily_loss_pct", "max_loss_pct", "min_trading_days", "max_days"):
            if a.get(k) not in (None, ""):
                rules[k] = float(a.get(k))
        if a.get("max_loss_type"):
            rules["max_loss_type"] = a.get("max_loss_type")
        risk = float(a.get("risk") or cur_risk or 0.5)
        main = analysis.montecarlo(rs, tpd, rules, risk, paths=4000)
        sweep = []
        for rk in (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0):
            r = analysis.montecarlo(rs, tpd, rules, rk, paths=1200, seed=11)
            sweep.append({"risk": rk, **{k: r[k] for k in ("pass", "fail_daily", "fail_total", "timeout", "median_days", "maxdd_p90")}})
        rr = sorted(rs)
        return jsonify({"rules": rules, "risk": risk, "current_risk": cur_risk, "n": len(rs),
                        "avg_r": round(sum(rs) / len(rs), 3), "win_rate": round(100 * sum(1 for x in rs if x > 0) / len(rs), 1),
                        "tpd_avg": round(sum(tpd) / len(tpd), 2), "r_p10": rr[len(rr) // 10], "r_p90": rr[(len(rr) * 9) // 10],
                        "main": main, "sweep": sweep})

    # ------------------------------------------------------------------ пакет всех данных
    def _pack():
        f = filters()
        login = f["login"]
        with db_lock:
            trades = analysis.add_context(con, login, analytics.list_trades(con, {"login": login}, shift_h), shift_h)
            dep = con.execute("SELECT SUM(profit) FROM deals WHERE login=? AND type=2", (login,)).fetchone()[0]
            st = analytics.stats(con, {"login": login}, shift_h, dep)
            ins = analysis.insights(con, login, {"login": login}, shift_h, _max_risk())
            try:
                wi = analysis.whatif(con, login, {"login": login}, shift_h, max_risk=_max_risk())
                for sc in wi["scenarios"]:
                    sc.pop("series", None)
            except Exception as e:
                wi = {"error": str(e)}
            pr = prop.progress(con, login, display_shift=shift_h)
            for k in ("points", "floor_series", "daily_floor"):
                pr.pop(k, None)
            data = {
                "about": ("Экспорт торгового журнала MT5 для разбора. Время сделок - время сервера брокера "
                          f"(сдвиг отображения {shift_h} ч). R = (выход - вход) x направление / |вход - начальный стоп|, "
                          "без комиссий. risk_pct - риск сделки в % баланса на момент входа (оценка). "
                          "session - сессия по UTC. checklist - отметки чек-листа. Скриншоты не входят, указаны только файлы."),
                "generated": datetime.now().isoformat(timespec="seconds"),
                "account": (q("SELECT a.login, a.server, a.name, a.company, a.currency, a.leverage, a.balance, a.equity, "
                              "a.last_sync, c.label FROM accounts a LEFT JOIN account_configs c ON c.login=a.login WHERE a.login=?",
                              (login,)) or [{}])[0],
                "rules": prop.load_rules(con, login), "settings": {k: v for k, v in appset.get_all(con).items() if k != "backup"},
                "summary": st["summary"], "breakdowns": {k: v for k, v in st.items() if k.startswith("by_")},
                "daily": st["daily"], "prop_progress": pr, "insights": ins["items"], "whatif": wi,
                "trades": [{k: v for k, v in t.items() if k not in ("login",)} for t in trades],
                "deals": q("SELECT * FROM deals WHERE login=? ORDER BY time_msc", (login,)),
                "day_journal": q("SELECT date, premarket, wrap, signed_off FROM day_journal WHERE login=0 ORDER BY date"),
                "playbooks": q("SELECT name, description, rules, checklist, active FROM playbooks"),
                "notes": q("SELECT date, title, body, tags, pinned, created FROM notes WHERE login IS NULL OR login=?", (login,)),
                "week_plans": q("SELECT week, plan FROM week_plan ORDER BY week"),
                "week_reviews": q("SELECT week, answers, goals, done FROM week_journal WHERE login=0 ORDER BY week"),
                "shots": q("SELECT position_id, file, created FROM trade_shots WHERE login=?", (login,)),
                "cot_latest": [{"market": m["name"], "code": m["code"], "cot": {k: v for k, v in (m["cot"] or {}).items()
                                                                                 if k not in ("series", "table")}}
                               for m in market.overview(cfg, con)["markets"]],
            }
        return data, login

    @app.get("/api/export/pack.json")
    def pack_json():
        data, login = _pack()
        body = json.dumps(data, ensure_ascii=False, indent=1, default=str)
        return Response(body, mimetype="application/json",
                        headers={"Content-Disposition": f"attachment; filename=journal-pack-{login}.json"})

    @app.get("/api/export/pack.zip")
    def pack_zip():
        import zipfile
        data, login = _pack()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"journal-pack-{login}.json", json.dumps(data, ensure_ascii=False, indent=1, default=str))
            for sh in data["shots"]:
                p = shots_dir / sh["file"]
                if p.exists():
                    z.write(p, "shots/" + sh["file"])
        return Response(buf.getvalue(), mimetype="application/zip",
                        headers={"Content-Disposition": f"attachment; filename=journal-pack-{login}.zip"})

    # ------------------------------------------------------------------ правила системы
    from . import rules as rules_mod

    def _rules_eval(login, f=None):
        with db_lock:
            trades = analysis.add_context(con, login, analysis.closed_trades(con, f or {"login": login}, shift_h), shift_h)
            rl = rules_mod.load(con, login)
        return rules_mod.evaluate(rl, trades)

    @app.get("/api/rules")
    def rules_get():
        f = filters()
        stats, _ = _rules_eval(f["login"], f)
        return jsonify({"rules": stats, "kinds": rules_mod.KINDS})

    @app.post("/api/rules")
    def rules_add():
        b = request.get_json(force=True)
        login = current_login()
        with db_lock:
            if b.get("type") == "checklist":
                items = appset.get(con, "checklist")
                if b["text"] not in items:
                    items.append(b["text"])
                    appset.put(con, "checklist", items)
                return jsonify({"ok": True, "added": "checklist"})
            if b.get("kind") not in rules_mod.KINDS:
                return jsonify({"message": "Неизвестный тип правила"}), 400
            exists = [r for r in rules_mod.load(con, login) if r["kind"] == b["kind"]]
            if exists:
                con.execute("UPDATE rules SET params=?, title=? WHERE id=?",
                            (json.dumps(b.get("params") or {}, ensure_ascii=False),
                             rules_mod.title_for(b["kind"], b.get("params") or {}), exists[0]["id"]))
                con.commit()
                return jsonify({"ok": True, "added": "updated"})
            rules_mod.add(con, login, b["kind"], b.get("params") or {}, b.get("source"), b.get("all_accounts", True))
        return jsonify({"ok": True, "added": "rule"})

    @app.delete("/api/rules/<int:rid>")
    def rules_del(rid):
        with db_lock:
            con.execute("DELETE FROM rules WHERE id=?", (rid,))
            con.commit()
        return jsonify({"ok": True})

    def _vio(login):
        try:
            return _rules_eval(login)[1]
        except Exception:
            return {}

    @app.get("/api/backtests/vs-real")
    def bt_vs_real():
        """Где реальные сделки хуже бэктеста: средний R без нарушений ТС, с нарушениями, по каждому правилу."""
        login = current_login()
        with db_lock:
            trades = analysis.add_context(con, login, analysis.closed_trades(con, {"login": login}, shift_h), shift_h)
            stats, vio = rules_mod.evaluate(rules_mod.load(con, login), trades)
            bt = [json.loads(r[0] or "{}").get("r") for r in con.execute("SELECT result FROM backtests")]
        avg = lambda xs: round(sum(xs) / len(xs), 2) if xs else None
        clean = [t["r"] for t in trades if t.get("r") is not None and t["position_id"] not in vio]
        bad = [t["r"] for t in trades if t.get("r") is not None and t["position_id"] in vio]
        bt = [r for r in bt if r is not None]
        rows = sorted([{"title": s["title"], "violations": s["violations"], "bad_avg_r": s["bad_avg_r"],
                        "lost_r": round(sum(t["r"] for t in trades if t["position_id"] in vio and s["title"] in vio[t["position_id"]]
                                            and t.get("r") is not None), 2)}
                       for s in stats if s["violations"]], key=lambda x: x["lost_r"])
        return jsonify({"backtest": {"count": len(bt), "avg_r": avg(bt)}, "clean": {"count": len(clean), "avg_r": avg(clean)},
                        "violated": {"count": len(bad), "avg_r": avg(bad)}, "rules": rows})

    extras.register_week(app, cfg, con, db_lock, q, current_login, shift_h, _vio)
    ts_mod.register(app, con, db_lock, current_login, shift_h)
    twins_mod.register(app, con, db_lock)

    # сон из Apple Watch (через папку OneDrive): все сделки всех счетов, торговый день и нарушения ТС для сравнения
    from . import sleep as sleep_mod
    from .extras import day_of as _day_of

    def _all_trades():
        with db_lock:
            return [t for (lg,) in con.execute("SELECT login FROM accounts").fetchall()
                    for t in analytics.list_trades(con, {"login": lg}, shift_h)]

    def _all_vio():
        return {(lg, pid): r for (lg,) in q_rows("SELECT login FROM accounts") for pid, r in _vio(lg).items()}

    def q_rows(sql):
        with db_lock:
            return con.execute(sql).fetchall()
    sleep_mod.register(app, con, db_lock, appset, _all_trades, lambda t: _day_of(t, int(shift_h * 3600)), _all_vio)

    # ежемесячный разбор: обслуживание, самопроверка, разбор поведения и задания месяца
    from . import review as review_mod
    from . import rules as _rules

    def _rules_any():  # правила ТС по счетам: у каждого счёта свой лимит сделок
        with db_lock:
            return {lg: _rules.load(con, lg) for (lg,) in con.execute("SELECT login FROM accounts").fetchall()}

    def _sleep_state():
        with db_lock:
            st = appset.get(con, "sleep")
            try:
                ns = sleep_mod.nights(con)
            except Exception:
                ns = []
        return {"enabled": bool(st.get("enabled")), "folder": st.get("folder") or sleep_mod.default_folder(), "nights": ns}
    review_mod.register(app, cfg, con, db_lock, shift_h, str(ROOT), _all_vio, _rules_any, _sleep_state)
    backtest.register(app, cfg, con, db_lock, current_login, shift_h)
    precheck.register(app, con, db_lock, current_login)
    portfolio.register(app, con, db_lock, current_login, shift_h)

    @app.get("/api/sync/status")
    def sync_status():
        return jsonify(dict(sync_mod.PROGRESS, now=time.time()))

    @app.get("/api/analysis/execution")
    def an_execution():
        f = filters()
        with db_lock:
            items = appset.get(con, "checklist")
            return jsonify(analysis.execution(con, f["login"], f, shift_h, items))

    @app.post("/api/shutdown")
    def shutdown():
        threading.Timer(0.5, lambda: os._exit(0)).start()
        return jsonify({"ok": True})

    # COT: сделки всех счетов нужны, чтобы показать, как вы торгуете по фону и против него
    @app.get("/api/cot/<code>")
    def cot_detail(code):
        trades = _all_trades()
        with db_lock:
            return jsonify(market.cot_detail(cfg, con, code, appset.get(con, "verdict"), trades))

    @app.get("/api/cot-board")
    def cot_board():
        trades = _all_trades()
        with db_lock:
            return jsonify(market.cot_board(cfg, con, appset.get(con, "verdict"), trades))

    # ------------------------------------------------------------------ рынок
    @app.get("/api/market")
    def market_get():
        with db_lock:
            return jsonify(market.overview(cfg, con))

    @app.post("/api/market/update")
    def market_update():
        from .sync import _lock, list_accounts, make_provider
        with db_lock:
            res = market.update(cfg, con, force=True)
        if _lock.acquire(timeout=60):
            try:
                with db_lock:
                    accs = list_accounts(cfg, con)
                p = make_provider(cfg, ({"login": 0, "terminal_path": accs[0].get("terminal_path", "")} if accs else None)
                                  if cfg["mode"] != "demo" else (accs[0] if accs else None))
                try:
                    p.connect()
                    with db_lock:
                        market.update_prices(cfg, con, p)
                finally:
                    p.close()
            except Exception as e:
                res.setdefault("errors", []).append(f"Цены из терминала: {e}")
            finally:
                _lock.release()
        return jsonify(res)

    @app.put("/api/market/config")
    def market_config():
        b = request.get_json(force=True)
        mk = [{"code": str(x.get("code", "")).strip().upper(), "name": (x.get("name") or "").strip(),
               "symbol": (x.get("symbol") or "").strip()} for x in b.get("cot_markets", []) if x.get("code")]
        with db_lock:
            market.set_meta(con, "cot_markets", mk)
            market.set_meta(con, "updated", 0)
            con.commit()
        return jsonify({"ok": True})

    # ------------------------------------------------------------------ архив челленджей
    with db_lock:
        con.executescript("""CREATE TABLE IF NOT EXISTS archive_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, firm TEXT, number TEXT, size REAL, phase TEXT, platform TEXT,
            status TEXT, result REAL, start TEXT, finish TEXT, reason TEXT, notes TEXT, created INTEGER)""")

    @app.get("/api/archive")
    def archive_list():
        return jsonify(q("SELECT * FROM archive_accounts ORDER BY COALESCE(finish, start) DESC, id DESC"))

    @app.post("/api/archive")
    def archive_save():
        b = request.get_json(force=True)
        cols = ["firm", "number", "size", "phase", "platform", "status", "result", "start", "finish", "reason", "notes"]
        vals = [b.get(c) if b.get(c) not in ("",) else None for c in cols]
        with db_lock:
            if b.get("id"):
                con.execute("UPDATE archive_accounts SET " + ", ".join(f"{c}=?" for c in cols) + " WHERE id=?", vals + [b["id"]])
            else:
                con.execute(f"INSERT INTO archive_accounts({','.join(cols)}, created) VALUES ({','.join('?' * len(cols))}, ?)",
                            vals + [int(time.time())])
            con.commit()
        return jsonify({"ok": True})

    @app.delete("/api/archive/<int:aid>")
    def archive_del(aid):
        with db_lock:
            con.execute("DELETE FROM archive_accounts WHERE id=?", (aid,))
            con.commit()
        return jsonify({"ok": True})

    @app.put("/api/sync/overrides")
    def sync_overrides():
        b = request.get_json(force=True)
        with db_lock:
            st = appset.get(con, "sync")
            ov = st.get("overrides") or {}
            key = str(int(b["login"]))
            if b.get("minutes") is None:
                ov.pop(key, None)
            else:
                ov[key] = max(0, int(b["minutes"]))
            st["overrides"] = ov
            appset.put(con, "sync", st)
        return jsonify({"ok": True})

    @app.get("/api/progress")
    def progress():
        login = current_login()
        ex = set(_vio(login)) if request.args.get("nv") else None
        with db_lock:
            out = prop.progress(con, login, display_shift=shift_h, exclude=ex)
        out["excluded"] = len(ex) if ex else 0
        return jsonify(out)

    @app.get("/api/trades")
    def trades():
        with db_lock:
            return jsonify(analytics.list_trades(con, filters(), shift_h))

    @app.get("/api/stats")
    def stats():
        login = current_login()
        dep = q("SELECT SUM(profit) AS s FROM deals WHERE login=? AND type=2", (login,))
        ex = set(_vio(login)) if request.args.get("nv") else None
        with db_lock:
            return jsonify(analytics.stats(con, filters(), shift_h, dep[0]["s"] if dep else None, ex))

    @app.get("/api/trade/<int:login>/<int:pid>")
    def trade(login, pid):
        t = q(analytics.TRADE_SQL + " WHERE t.login=? AND t.position_id=?", (login, pid))
        if not t:
            return jsonify({"error": "Позиция не найдена"}), 404
        # та же идея на других счетах: разбор у пары общий; пустой разбор берётся у разобранной половины
        from .extras import reviewed
        with db_lock:
            tw = twins_mod.find(con, login, pid)
            if tw and not reviewed(analytics.enrich(t[0], shift_h)):
                for k in tw:
                    o = q(analytics.TRADE_SQL + " WHERE t.login=? AND t.position_id=?", k)
                    if o and reviewed(analytics.enrich(o[0], shift_h)):
                        twins_mod.copy_notes(con, k, [(login, pid)])
                        con.commit()
                        t = q(analytics.TRADE_SQL + " WHERE t.login=? AND t.position_id=?", (login, pid))
                        break
        with db_lock:
            tr = analytics.enrich(t[0], shift_h, appset.get(con, "sessions"))
        tr["shot_list"] = q("SELECT id, file, caption, created FROM trade_shots WHERE login=? AND position_id=? ORDER BY id",
                            (login, pid))
        tr["deals"] = q("SELECT * FROM deals WHERE login=? AND position_id=? AND type IN (0,1) ORDER BY time_msc, ticket",
                        (login, pid))
        ids = [r["position_id"] for r in q(
            "SELECT position_id FROM trades WHERE login=? ORDER BY open_time DESC", (login,))]
        i = ids.index(pid) if pid in ids else -1
        try:
            with db_lock:
                tr["cot"] = market.cot_at(cfg, con, tr["symbol"], tr["open_time"])
        except Exception:
            tr["cot"] = None
        try:
            _, vio = _rules_eval(login)
            tr["violations"] = vio.get(pid, [])
        except Exception:
            tr["violations"] = []
        try:
            with db_lock:
                tr["week_plan"] = analysis.plan_bias(analysis.load_plans(con), tr["symbol"], tr["open_time"], int(shift_h * 3600))
        except Exception:
            tr["week_plan"] = None
        try:
            with db_lock:
                tr["context"] = market.context_at(cfg, con, tr["symbol"], tr["open_time"])
        except Exception:
            tr["context"] = None
        try:  # сон перед сделкой (Apple Watch): длительность ночи и сколько прошло от пробуждения
            from . import sleep as sleep_mod
            with db_lock:
                sleep_mod.for_trades(con, [tr])
        except Exception:
            pass
        tr["twins"] = []
        for lg, p in tw:
            o = q(analytics.TRADE_SQL + " WHERE t.login=? AND t.position_id=?", (lg, p))
            if o:
                with db_lock:
                    o = analytics.enrich(o[0], shift_h, appset.get(con, "sessions"))
                tr["twins"].append({"login": lg, "position_id": p, "symbol": o["symbol"], "open_time": o["open_time"],
                                    "r": o.get("r"), "net": o.get("net"), "status": o.get("status")})
        tr["prev_id"] = ids[i + 1] if 0 <= i < len(ids) - 1 else None
        tr["next_id"] = ids[i - 1] if i > 0 else None
        return jsonify(tr)

    @app.put("/api/trade/<int:login>/<int:pid>/notes")
    def save_notes(login, pid):
        body = request.get_json(force=True)
        vals = {k: body.get(k) for k in NOTE_FIELDS}
        for k in ("grade", "followed_plan"):
            vals[k] = int(vals[k]) if vals[k] not in (None, "") else None
        vals["sl_manual"] = float(vals["sl_manual"]) if vals["sl_manual"] not in (None, "") else None
        vals["checklist"] = json.dumps(vals["checklist"] or {}, ensure_ascii=False)
        cols = ["login", "position_id"] + NOTE_FIELDS + ["updated_at"]
        args = [login, pid] + [vals[k] for k in NOTE_FIELDS] + [int(time.time())]
        with db_lock:
            con.execute(
                f"INSERT INTO trade_notes ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
                f"ON CONFLICT(login, position_id) DO UPDATE SET "
                + ", ".join(f"{c}=excluded.{c}" for c in NOTE_FIELDS + ["updated_at"]), args)
            tw = twins_mod.find(con, login, pid) if body.get("apply_twins", True) else []
            twins_mod.copy_notes(con, (login, pid), tw)
            con.commit()
        return jsonify({"ok": True, "twins": len(tw)})

    @app.get("/api/trade/<int:login>/<int:pid>/plan")
    def get_exit_plan(login, pid):
        """План выхода открытой позиции (её может ещё не быть в истории сделок)."""
        r = q("SELECT exit_partial, exit_manual FROM trade_notes WHERE login=? AND position_id=?", (login, pid))
        return jsonify(r[0] if r else {"exit_partial": None, "exit_manual": None})

    @app.put("/api/trade/<int:login>/<int:pid>/quick")
    def save_quick(login, pid):
        """Быстрый разбор и план выхода: меняются только переданные поля, остальной разбор не трогается.
        Работает и для открытой позиции, которой ещё нет в истории (запись по номеру позиции)."""
        body = request.get_json(force=True) or {}
        vals = {k: body[k] for k in NOTE_FIELDS if k in body}
        if not vals:
            return jsonify({"error": "нет полей"}), 400
        for k in ("grade", "followed_plan"):
            if k in vals:
                vals[k] = int(vals[k]) if vals[k] not in (None, "") else None
        if "checklist" in vals:
            vals["checklist"] = json.dumps(vals["checklist"] or {}, ensure_ascii=False)
        cols = list(vals) + ["updated_at"]
        args = [login, pid] + [vals[k] for k in vals] + [int(time.time())]
        with db_lock:
            con.execute(
                f"INSERT INTO trade_notes (login, position_id, {','.join(cols)}) VALUES ({','.join('?' * (len(cols) + 2))}) "
                f"ON CONFLICT(login, position_id) DO UPDATE SET " + ", ".join(f"{c}=excluded.{c}" for c in cols), args)
            tw = twins_mod.find(con, login, pid)
            twins_mod.copy_notes(con, (login, pid), tw)
            con.commit()
        return jsonify({"ok": True, "twins": len(tw)})

    @app.put("/api/trade/<int:login>/<int:pid>/drawings")
    def save_drawings(login, pid):
        """Свои отметки на графике сделки: уровни, зоны, подписи (цена и время, как у свечей)."""
        items = (request.get_json(force=True) or {}).get("items") or []
        with db_lock:
            con.execute("INSERT INTO trade_notes(login, position_id, drawings, updated_at) VALUES (?,?,?,?) "
                        "ON CONFLICT(login, position_id) DO UPDATE SET drawings=excluded.drawings, updated_at=excluded.updated_at",
                        (login, pid, json.dumps(items[:200], ensure_ascii=False), int(time.time())))
            con.commit()
        return jsonify({"ok": True})

    @app.get("/api/grades")
    def grades():
        """Результат по оценке сетапа A/B/C: реальные сделки счёта и бэктест."""
        def group(rows):
            g = {}
            for grade, r in rows:
                if not grade or r is None:
                    continue
                x = g.setdefault(grade, [])
                x.append(r)
            return {k: {"count": len(v), "avg_r": round(sum(v) / len(v), 2), "win_rate": round(100 * sum(1 for r in v if r > 0) / len(v)),
                        "sum_r": round(sum(v), 2)} for k, v in sorted(g.items())}
        with db_lock:
            trades = analytics.list_trades(con, {"login": current_login(), "status": "closed"}, shift_h)
            bt = [(r[0], json.loads(r[1] or "{}").get("r")) for r in con.execute("SELECT grade, result FROM backtests")]
        return jsonify({"real": group([(t.get("setup_grade"), t.get("r")) for t in trades]), "backtest": group(bt)})

    def _chart_news(symbol, a, b, off):
        """Важные новости по валютам инструмента в окне графика, время - как у свечей (сервер брокера)."""
        try:
            with db_lock:
                items = news_mod.around(con, a - off, b - off, news_mod.currencies(symbol))
        except Exception:
            return []
        return [{"time": n["time"] + off, "currency": n["currency"], "title": n["title"]} for n in items]

    @app.get("/api/chart/<int:login>/<int:pid>")
    def chart(login, pid):
        t = q("SELECT * FROM trades WHERE login=? AND position_id=?", (login, pid))
        if not t:
            return jsonify({"error": "Позиция не найдена"}), 404
        t = t[0]
        end = t["close_time"] or int(time.time()) + 86400
        tf = request.args.get("tf") or auto_tf(end - t["open_time"])
        if tf not in TF_SEC:
            tf = "H1"
        a, b = chart_window(t["open_time"], end, tf)
        if not t["close_time"]:
            b = int(time.time()) + 3 * 86400
        with db_lock:
            acct = account_by_login(cfg, con, login) or {}
            # для котировок вход в счёт не нужен: подключаемся к терминалу как есть
            bars, src = fetch_chart_rates(cfg, con, t["symbol"], tf, a, b,
                                          {"terminal_path": acct.get("terminal_path", ""), "login": 0})
        deals = q("SELECT ticket, time, type, entry, reason, volume, price, profit, commission, swap "
                  "FROM deals WHERE login=? AND position_id=? AND type IN (0,1) ORDER BY time_msc, ticket",
                  (login, pid))
        dg = q("SELECT digits FROM symbols WHERE symbol=?", (t["symbol"],))
        t = dict(t, digits=(dg[0]["digits"] if dg and dg[0]["digits"] is not None else (5 if t["entry_price"] < 20 else 2)))
        off = (q("SELECT server_offset FROM accounts WHERE login=?", (login,)) or [{}])[0].get("server_offset") or 0
        return jsonify({"tf": tf, "source": src, "shift": int(shift_h * 3600), "news": _chart_news(t["symbol"], a, b, off),
                        "bars": [{"time": b_[0], "open": b_[1], "high": b_[2], "low": b_[3], "close": b_[4]}
                                 for b_ in bars],
                        "deals": deals, "trade": t})

    @app.get("/api/export.csv")
    def export_csv():
        with db_lock:
            data = analytics.list_trades(con, filters(), shift_h)
        cols = ["position_id", "symbol", "direction", "status", "open_time", "close_time", "volume",
                "entry_price", "exit_price", "sl_used", "tp_initial", "net", "profit", "commission", "swap",
                "r", "mae_r", "mfe_r", "source", "close_label", "setup", "emotion", "grade", "mistakes",
                "tags", "entry_reason", "exit_reason", "notes"]
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(cols)
        fmt = lambda ts: datetime.fromtimestamp(ts + int(shift_h * 3600), tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if ts else ""
        for t in data:
            r = dict(t, direction="buy" if t["direction"] == 1 else "sell",
                     open_time=fmt(t["open_time"]), close_time=fmt(t["close_time"]))
            w.writerow([r.get(c, "") if r.get(c) is not None else "" for c in cols])
        return Response("\ufeff" + buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition": "attachment; filename=journal.csv"})

    # ------------------------------------------------------------------ background sync
    from . import live as live_mod
    from .sync import _lock as sync_lock
    monitor = live_mod.start(cfg, con, db_lock, sync_lock)

    @app.get("/api/live")
    def live_get():
        st = dict(monitor.state)
        st["now"] = time.time()
        return jsonify(st)

    def background():
        from .sync import due_accounts, weekend_paused
        sync_mod.PROGRESS["bg_stage"] = "запуск"
        try:
            with db_lock:
                st = appset.get(con, "sync")
                paused = weekend_paused(con)
            if st.get("on_start", True) and cfg["server"].get("sync_on_start", True) and not paused:
                sync_mod.PROGRESS["bg_stage"] = "синхронизация при запуске"
                run_sync(cfg)
        except Exception as e:
            print(f"Фоновая синхронизация при запуске: {e}", flush=True)
        while True:
            # «пульс» фонового цикла: самопроверка видит, если он встал (копии, расписание, новости)
            sync_mod.PROGRESS["bg_tick"] = time.time()
            try:
                sync_mod.PROGRESS["bg_stage"] = "резервная копия"
                with db_lock:
                    appset.backup_if_due(con, cfg["db_path"])
                    due = due_accounts(cfg, con)
                if cfg.get("market", {}).get("enabled", True):
                    sync_mod.PROGRESS["bg_stage"] = "календарь новостей"
                    with db_lock:
                        news_mod.update(con)
                sync_mod.PROGRESS["bg_stage"] = "синхронизация по расписанию"
                for lg in due:
                    run_sync(cfg, login=lg)
                # живое отслеживание увидело новую закрытую сделку - подтянуть её сразу
                while monitor.need_sync:
                    run_sync(cfg, login=monitor.need_sync.pop())
            except Exception as e:
                print(f"Фоновая синхронизация: {e}", flush=True)
            sync_mod.PROGRESS["bg_stage"] = "ожидание"
            time.sleep(20)

    threading.Thread(target=background, daemon=True).start()
    return app


def serve(cfg=None, open_browser=True):
    cfg = cfg or load_config()
    app = create_app(cfg)
    host, port = cfg["server"]["host"], cfg["server"]["port"]
    url = f"http://{host}:{port}/"
    print(f"Журнал: {url}  (режим: {cfg['mode']})")
    if open_browser:
        import webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    app.run(host=host, port=port, debug=False, use_reloader=False)
