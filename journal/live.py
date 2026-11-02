"""Живое отслеживание открытых позиций, пока запущен ваш торговый терминал.

Правила работы (соответствие правилам проп-фирм):
- журнал только ПОДКЛЮЧАЕТСЯ к уже запущенному terminal64.exe и читает позиции, средства и сделки;
- терминал не запускается, в счёт не выполняется вход, счёт не переключается, ничего не закрывается;
- торговых функций нет; предупреждения о лимитах только показываются.
"""
import os
import sys
import threading
import time

from . import prop
from . import settings as appset


def running_terminals():
    """Пути запущенных terminal64.exe (нужен psutil, есть только на Windows)."""
    try:
        import psutil
    except ImportError:
        return []
    out = []
    for p in psutil.process_iter(["name", "exe"]):
        try:
            if (p.info.get("name") or "").lower() == "terminal64.exe" and p.info.get("exe"):
                out.append(os.path.normcase(os.path.abspath(p.info["exe"])))
        except Exception:
            continue
    return out


class LiveMonitor:
    def __init__(self, cfg, con, db_lock, sync_lock):
        self.cfg, self.con, self.db_lock, self.lock = cfg, con, db_lock, sync_lock
        self.state = {"status": "off", "positions": [], "updated": None}
        self.track = {}          # position_id -> {"mfe": R, "mae": R, "series": [(t, r)], "sl0": price}
        self.last_snapshot = 0
        self.limits_cache = (0, None, None)
        self.deal_counts = {}
        self.need_sync = set()
        self.checked = set()     # позиции, уже проверенные по правилам ТС
        self.alerts = []         # последние предупреждения «сделка не по ТС»
        self.stop = False

    # ------------------------------------------------------------------ настройки
    def settings(self):
        with self.db_lock:
            return appset.get(self.con, "live")

    def watched_paths(self, st):
        paths = [p for p in (st.get("paths") or []) if p.strip()]
        if st.get("use_account_paths", True):
            with self.db_lock:
                paths += [r[0] for r in self.con.execute("SELECT terminal_path FROM account_configs WHERE terminal_path<>''")]
        return [os.path.normcase(os.path.abspath(p.strip().strip('"'))) for p in paths]

    # ------------------------------------------------------------------ цикл
    def run(self):
        while not self.stop:
            st = self.settings()
            interval = max(2, int(st.get("interval") or 5))
            if not st.get("enabled", True):
                self.state = {"status": "off", "positions": [], "updated": time.time(), "reason": "выключено в настройках"}
                time.sleep(5)
                continue
            try:
                self.poll(st)
            except Exception as e:
                self.state = {**self.state, "status": "error", "error": str(e), "updated": time.time()}
            time.sleep(interval)

    def poll(self, st):
        if self.cfg["mode"] == "demo":
            return self.poll_demo()
        watched = self.watched_paths(st)
        running = running_terminals()
        target = next((p for p in running if p in watched), None) if watched else None
        if not target:
            self.state = {"status": "waiting", "positions": [], "updated": time.time(),
                          "reason": "торговый терминал не запущен" if watched else "не указан терминал для отслеживания",
                          "running": len(running)}
            return
        # общий замок с синхронизацией: пакет MetaTrader5 работает с одним терминалом за раз
        if not self.lock._lock.acquire(timeout=2):
            return
        from .provider_mt5 import MT5Provider
        p = MT5Provider(self.cfg, {"terminal_path": target, "login": 0, "password": "", "server": ""})
        try:
            if target not in running_terminals():  # терминал закрыли за эту секунду - не запускаем его
                return
            p.connect()
            acc = p.account()
            positions = p.positions()
            now = int(time.time())
            deals = p.deals(now - 2 * 86400, now + 3 * 86400)
        finally:
            try:
                p.close()
            finally:
                self.lock._lock.release()
        self.update(target, acc, positions, deals)

    def poll_demo(self):
        from .provider_demo import DemoProvider
        login = None
        with self.db_lock:
            r = self.con.execute("SELECT login FROM accounts ORDER BY login LIMIT 1").fetchone()
            login = r[0] if r else DemoProvider.LOGIN
        dp = DemoProvider(self.cfg, {"login": login})
        now = time.time()
        pos = []
        for x in dp.positions():
            cur = dp._p(x["symbol"], int(now) // 15 * 15)
            d = 1 if x["type"] == 0 else -1
            pos.append(dict(x, price_current=cur, profit=dp._profit(x["symbol"], d, x["volume"], x["price_open"], cur)))
        acc = dp.account()
        acc["equity"] = round(acc["balance"] + sum(p["profit"] for p in pos), 2)
        self.update("demo", acc, pos, [])

    # ------------------------------------------------------------------ расчёт
    def update(self, terminal, acc, positions, deals):
        now = time.time()
        login = acc["login"]
        with self.db_lock:
            digits = {r[0]: r[1] for r in self.con.execute("SELECT symbol, digits FROM symbols")}
            sl0 = {r[0]: r[1] for r in self.con.execute("SELECT position_id, sl_initial FROM trades WHERE login=? AND status='open'", (login,))}
        live_ids = set()
        out = []
        for p in positions:
            pid = p["position_id"]
            live_ids.add(pid)
            d = 1 if p["type"] == 0 else -1
            tr = self.track.setdefault(pid, {"mfe": 0.0, "mae": 0.0, "series": [], "sl0": sl0.get(pid) or p["sl"] or None})
            if not tr["sl0"] and p["sl"]:
                tr["sl0"] = p["sl"]
            risk = abs(p["price_open"] - tr["sl0"]) if tr["sl0"] else None
            r = round((p["price_current"] - p["price_open"]) * d / risk, 2) if risk else None
            tr["sym"], tr["r"] = p["symbol"], r
            if r is not None:
                tr["mfe"], tr["mae"] = max(tr["mfe"], r), min(tr["mae"], r)
                if not tr["series"] or now - tr["series"][-1][0] >= 10:
                    tr["series"].append((int(now), r))
                    tr["series"] = tr["series"][-720:]
            to_sl = round((p["price_current"] - p["sl"]) * d / risk, 2) if risk and p["sl"] else None
            to_tp = round((p["tp"] - p["price_current"]) * d / risk, 2) if risk and p["tp"] else None
            out.append({"position_id": pid, "symbol": p["symbol"], "direction": d, "volume": p["volume"],
                        "price_open": p["price_open"], "price_current": p["price_current"], "sl": p["sl"] or None,
                        "tp": p["tp"] or None, "sl_initial": tr["sl0"], "profit": round(p["profit"] + p.get("swap", 0), 2),
                        "r": r, "mfe_r": round(tr["mfe"], 2), "mae_r": round(tr["mae"], 2), "to_sl_r": to_sl, "to_tp_r": to_tp,
                        "opened": p["time"], "digits": digits.get(p["symbol"], 5 if p["price_open"] < 50 else 2),
                        "series": tr["series"][-120:]})
        for pid in list(self.track):
            if pid not in live_ids:
                self.closed_notify(self.track.pop(pid))
        self.check_new(login, positions)
        # новые закрытые сделки - попросить синхронизацию этого счёта
        n = len(deals)
        if login in self.deal_counts and n > self.deal_counts[login]:
            self.need_sync.add(login)
        self.deal_counts[login] = n
        # снимок средств для дневных лимитов (раз в 30 секунд)
        if now - self.last_snapshot >= 30:
            with self.db_lock:
                self.con.execute("INSERT OR REPLACE INTO equity_snapshots(login, time, balance, equity) VALUES (?,?,?,?)",
                                 (login, int(now), acc["balance"], acc["equity"]))
                self.con.commit()
            self.last_snapshot = now
        limits = self.limits(login, acc)
        with self.db_lock:
            label = (self.con.execute("SELECT COALESCE(c.label, a.name) FROM accounts a LEFT JOIN account_configs c ON c.login=a.login "
                                      "WHERE a.login=?", (login,)).fetchone() or [acc.get("name")])[0]
        self.state = {"status": "live", "terminal": terminal, "login": login, "label": label or str(login),
                      "currency": acc.get("currency"), "balance": acc["balance"], "equity": acc["equity"],
                      "floating": round(acc["equity"] - acc["balance"], 2), "positions": out, "limits": limits,
                      "updated": now, "alerts": self.alerts[-10:]}

    def closed_notify(self, tr):
        """Позиция закрылась: напомнить о разборе, пока сделка свежая (разбор позже суток - задание месяца)."""
        from . import notify, settings as appset
        try:
            with self.db_lock:
                on = appset.get(self.con, "reminder").get("windows", True)
        except Exception:
            on = True
        if not on or not tr.get("sym"):
            return
        r = tr.get("r")
        res = f"{r:+.2f}R".replace(".", ",") if r is not None else "закрыта"
        notify.send(f"{tr['sym']}: {res}. Разбор за 20 секунд - на «Сегодня»: сетап, по плану, оценка.", "Сделка закрыта")

    def check_new(self, login, positions):
        """Новая позиция сверяется с правилами ТС; нарушения - предупреждение в журнале и уведомление Windows."""
        from . import notify, precheck
        for p in positions:
            pid = p["position_id"]
            if pid in self.checked:
                continue
            self.checked.add(pid)
            d = 1 if p["type"] == 0 else -1
            try:
                with self.db_lock:
                    off = (self.con.execute("SELECT server_offset FROM accounts WHERE login=?", (login,)).fetchone() or [0])[0] or 0
                    if time.time() + off - p["time"] > 900:
                        continue  # позиция открыта давно (например, до запуска журнала) - не тревожим
                    res = precheck.check(self.con, login, p["symbol"], d, p["price_open"], p["sl"] or None, p["tp"] or None,
                                         p["volume"], utc_now=p["time"] - off, pre=False)
            except Exception:
                continue
            bad = [c for c in res["checks"] if not c["ok"]]
            if not bad:
                continue
            a = {"time": int(time.time()), "position_id": pid, "symbol": p["symbol"], "direction": d, "volume": p["volume"],
                 "items": [f"{c['title']}: {c['detail']}" if c["detail"] else c["title"] for c in bad]}
            self.alerts.append(a)
            notify.send(f"{p['symbol']} {'Buy' if d > 0 else 'Sell'} {p['volume']}: " + "; ".join(c["title"] for c in bad),
                        "Сделка не по ТС")

    def limits(self, login, acc):
        """Запас до лимитов челленджа по текущим средствам (кэш расчёта цели - 60 секунд)."""
        ts, lg, base = self.limits_cache
        if lg != login or time.time() - ts > 60:
            try:
                with self.db_lock:
                    rules = prop.load_rules(self.con, login)
                    base = prop.progress(self.con, login) if rules.get("kind") == "prop" else None
            except Exception:
                base = None
            self.limits_cache = (time.time(), login, base)
        if not base:
            return None
        offset = (acc.get("balance") or 0) - base["balance"]   # пополнения вне торгового результата
        eq = acc["equity"] - offset
        out = {"equity_rel": round(eq, 2), "initial": base["initial"], "day_reset_at": base.get("day_reset_at")}
        if base.get("today_floor") is not None:
            out["daily_floor"] = base["today_floor"]
            out["daily_left"] = round(eq - base["today_floor"], 2)
        if base.get("floor_level") is not None:
            out["total_floor"] = base["floor_level"]
            out["total_left"] = round(eq - base["floor_level"], 2)
        if base.get("target_level") is not None:
            out["target_left"] = round(base["target_level"] - eq, 2)
        lim = (base.get("rules") or {}).get("max_daily_loss_pct")
        if lim and out.get("daily_left") is not None:
            out["daily_used_share"] = round(1 - out["daily_left"] / (base["initial"] * float(lim) / 100), 3)
        return out


def start(cfg, con, db_lock, sync_lock):
    m = LiveMonitor(cfg, con, db_lock, sync_lock)
    threading.Thread(target=m.run, daemon=True).start()
    return m
