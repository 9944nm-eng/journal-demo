"""Синхронизация: история сделок MT5 -> база -> позиции журнала.

История сделок хранится на сервере брокера, поэтому позиции, открытые с телефона или из веб-терминала,
попадают в базу при следующем запуске синхронизации на ПК - неважно, сколько времени прошло.
"""
import json
import threading
import time
from datetime import datetime

from .db import connect
from .provider_demo import DemoProvider
from .provider_mt5 import MT5Provider
from .secret import decrypt
from . import market
from .terminal import TerminalLock, default_terminal

TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}
EPS = 1e-9
_lock = TerminalLock()
# ход текущей синхронизации для индикатора в интерфейсе
PROGRESS = {"running": False, "done": 0, "total": 0, "label": "", "step": "", "started": None}


def make_provider(cfg, acct=None):
    if _lock._lock.locked():
        _lock.before_connect(cfg)
    return DemoProvider(cfg, acct) if cfg["mode"] == "demo" else MT5Provider(cfg, acct)


def auto_tf(duration):
    for limit, tf in ((1800, "M1"), (3 * 3600, "M5"), (12 * 3600, "M15"),
                      (3 * 86400, "H1"), (15 * 86400, "H4")):
        if duration <= limit:
            return tf
    return "D1"


def chart_window(open_time, close_time, tf):
    """Окно графика вокруг сделки: сама сделка + контекст по бокам."""
    step = TF_SEC[tf]
    dur = max(close_time - open_time, step)
    pad = max(int(dur * 1.2), 80 * step)
    return open_time - pad, close_time + max(pad // 2, 40 * step)


# ---------------------------------------------------------------------------- upserts
def _upsert(con, table, row, keys):
    cols = list(row)
    upd = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in keys)
    con.execute(
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))}) "
        f"ON CONFLICT({','.join(keys)}) DO UPDATE SET {upd}",
        [row[c] for c in cols])


def store_rates(con, sym, tf, bars):
    con.executemany(
        "INSERT OR REPLACE INTO rates(symbol, tf, time, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?)",
        [(sym, tf) + tuple(b) for b in bars])


def cached_rates(con, sym, tf, t_from, t_to):
    cur = con.execute("SELECT time,o,h,l,c,v FROM rates WHERE symbol=? AND tf=? AND time BETWEEN ? AND ? "
                      "ORDER BY time", (sym, tf, t_from, t_to))
    return [tuple(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------- trade building
def build_trade(login, pid, deals, orders, open_pos):
    deals = sorted(deals, key=lambda d: (d["time_msc"] or d["time"] * 1000, d["ticket"]))
    ins = [d for d in deals if d["entry"] in (0, 2)]
    outs = [d for d in deals if d["entry"] in (1, 2, 3)]
    if not ins:
        return None
    first = ins[0]
    direction = 1 if first["type"] == 0 else -1
    vin = sum(d["volume"] for d in ins)
    vout = sum(d["volume"] for d in outs)
    entry_price = sum(d["price"] * d["volume"] for d in ins) / vin if vin else first["price"]
    exit_price = sum(d["price"] * d["volume"] for d in outs) / vout if vout else None

    sl_i = first.get("sl") or 0
    tp_i = first.get("tp") or 0
    for o in sorted(orders, key=lambda o: o["time_setup"] or 0):
        if not sl_i and o["sl"]:
            sl_i = o["sl"]
        if not tp_i and o["tp"]:
            tp_i = o["tp"]
    if open_pos:
        sl_i = sl_i or open_pos["sl"]
        tp_i = tp_i or open_pos["tp"]

    status = "open" if open_pos or vout + EPS < vin else "closed"
    profit = sum(d["profit"] for d in deals)
    commission = sum(d["commission"] for d in deals)
    swap = sum(d["swap"] for d in deals)
    fee = sum(d["fee"] or 0 for d in deals)
    if open_pos:
        profit += open_pos["profit"]
        swap += open_pos["swap"]
    return dict(
        login=login, position_id=pid, symbol=first["symbol"], direction=direction,
        status=status, open_time=first["time"],
        close_time=outs[-1]["time"] if outs and status == "closed" else None,
        volume=round(vin, 4), entry_price=entry_price, exit_price=exit_price,
        sl_initial=sl_i or None, tp_initial=tp_i or None,
        sl_current=open_pos["sl"] if open_pos else None,
        tp_current=open_pos["tp"] if open_pos else None,
        price_current=open_pos["price_current"] if open_pos else None,
        commission=round(commission, 2), swap=round(swap, 2), fee=round(fee, 2),
        profit=round(profit, 2), net=round(profit + commission + swap + fee, 2),
        open_reason=first["reason"],
        close_reason=outs[-1]["reason"] if outs and status == "closed" else None,
        deals_count=len(deals), reversed=1 if any(d["entry"] == 2 for d in deals) else 0,
        updated_at=int(time.time()),
    )


def whatif_extension(dur):
    """Сколько минуток держать после выхода: от 8 часов до 3 суток."""
    return int(min(max(dur, 8 * 3600), 3 * 86400))


def mae_mfe(provider, con, trade):
    """Максимальное движение против и в пользу позиции за время её жизни (по минуткам)."""
    t0, t1 = trade["open_time"], trade["close_time"]
    dur = t1 - t0
    tf = "M1" if dur <= 5 * 86400 else ("M15" if dur <= 40 * 86400 else "H1")
    if tf == "M1":
        # минутки с запасом после выхода сохраняются для раздела «Что если»
        end = min(t1 + whatif_extension(dur), int(time.time()) + 3 * 86400)
        allbars = provider.rates(trade["symbol"], "M1", t0 // 60 * 60, end)
        store_rates(con, trade["symbol"], "M1", allbars)
        bars = [b for b in allbars if b[0] <= t1]
    else:
        bars = provider.rates(trade["symbol"], tf, t0 // 60 * 60, t1)
    if not bars:
        return None, None
    hi = max(b[2] for b in bars)
    lo = min(b[3] for b in bars)
    e = trade["entry_price"]
    if trade["direction"] == 1:
        return max(0.0, e - lo), max(0.0, hi - e)
    return max(0.0, hi - e), max(0.0, e - lo)


# ---------------------------------------------------------------------------- accounts
DEMO_PROP_LOGIN = 90100100
PROP_PRESETS = {
    "phase1": {"kind": "prop", "phase": "Фаза 1", "profit_target_pct": 10, "max_daily_loss_pct": 5,
               "daily_basis": "initial", "max_loss_pct": 10, "max_loss_type": "static",
               "min_trading_days": 4, "max_days": 0, "consistency_pct": 0},
    "phase2": {"kind": "prop", "phase": "Фаза 2", "profit_target_pct": 5, "max_daily_loss_pct": 5,
               "daily_basis": "initial", "max_loss_pct": 10, "max_loss_type": "static",
               "min_trading_days": 4, "max_days": 0, "consistency_pct": 0},
    "funded": {"kind": "prop", "phase": "Funded", "profit_target_pct": 0, "max_daily_loss_pct": 5,
               "daily_basis": "initial", "max_loss_pct": 10, "max_loss_type": "static",
               "min_trading_days": 0, "max_days": 0, "consistency_pct": 0},
}


def ensure_demo_accounts(con):
    if con.execute("SELECT COUNT(*) FROM account_configs").fetchone()[0]:
        return
    now = int(time.time())
    con.execute("INSERT INTO account_configs(login, label, server, enabled, created) VALUES (?,?,?,?,?)",
                (DemoProvider.LOGIN, "Демо-счёт", "Demo-Server", 1, now))
    con.execute("INSERT INTO account_configs(login, label, server, enabled, created) VALUES (?,?,?,?,?)",
                (DEMO_PROP_LOGIN, "Демо-челлендж 100k", "Demo-Server", 1, now))
    rules = dict(PROP_PRESETS["phase1"], account_size=100000)
    con.execute("INSERT OR REPLACE INTO account_rules(login, rules, updated_at) VALUES (?,?,?)",
                (DEMO_PROP_LOGIN, json.dumps(rules), now))
    con.commit()


def list_accounts(cfg, con, only_enabled=True):
    """Счета для синхронизации: из раздела «Счета», иначе - один счёт из config.json."""
    if cfg["mode"] == "demo":
        ensure_demo_accounts(con)
    q = "SELECT * FROM account_configs" + (" WHERE enabled=1" if only_enabled else "") + " ORDER BY created"
    out = []
    for r in con.execute(q):
        a = dict(r)
        a["password"] = decrypt(a.pop("password_enc") or "")
        out.append(a)
    m = cfg["mt5"]
    # счёт, открытый в терминале по умолчанию (или из config.json), синхронизируется всегда,
    # даже если в «Счета» добавлены другие счета. Он идёт первым, пока журнал не переключал терминал.
    # счёт терминала по умолчанию нужен, пока есть счета, которые журнал видит только через него
    auto_left = con.execute("SELECT COUNT(*) FROM accounts WHERE login NOT IN (SELECT login FROM account_configs)").fetchone()[0]
    if cfg["mode"] != "demo" and (not out or (not int(m.get("login") or 0) and auto_left)):
        legacy_login = int(m.get("login") or 0)
        if not any(a["login"] == legacy_login for a in out if legacy_login):
            path = m.get("terminal_path") or default_terminal([a.get("terminal_path") for a in out])
            out.insert(0, {"login": legacy_login, "password": m.get("password", ""),
                           "server": m.get("server", ""), "terminal_path": path,
                           "label": "", "legacy": True,
                           "other_logins": [a["login"] for a in out]})
    return out


def account_by_login(cfg, con, login):
    accs = list_accounts(cfg, con, only_enabled=False)
    for a in accs:
        if a["login"] == login and not a.get("legacy"):
            return a
    return next((a for a in accs if a.get("legacy")), None)


def market_closed(now=None):
    """Форекс закрыт: с пятницы 22:00 UTC до воскресенья 21:00 UTC (у брокеров плюс-минус час).
    Новых сделок нет, а синхронизация открывает терминалы и только мешает."""
    from datetime import datetime, timezone
    d = datetime.fromtimestamp(now or time.time(), tz=timezone.utc)
    return (d.weekday() == 4 and d.hour >= 22) or d.weekday() == 5 or (d.weekday() == 6 and d.hour < 21)


def weekend_paused(con):
    """Пауза автоматической синхронизации на выходных (ручная кнопка работает всегда)."""
    from . import settings as appset
    return appset.get(con, "sync").get("weekend_pause", True) and market_closed()


def due_accounts(cfg, con):
    """Счета, которым пора синхронизироваться по расписанию. None в списке = счёт из config.json."""
    from . import settings as appset
    st = appset.get(con, "sync")
    if st.get("weekend_pause", True) and market_closed():
        return []
    overrides = st.get("overrides") or {}
    now = time.time()
    out = []
    for a in list_accounts(cfg, con):
        lg = a.get("login") or 0
        mins = overrides.get(str(lg))
        if mins is None:
            mins = st["minutes"] if st.get("auto") else 0
        mins = float(mins or 0)
        if mins <= 0:
            continue
        if a.get("legacy") and not lg:
            # счёт терминала по умолчанию: смотрим на счета, которые не добавлены в «Счета»
            row = con.execute("SELECT MIN(last_sync) FROM accounts WHERE login NOT IN (SELECT login FROM account_configs)").fetchone()
            if row[0] is None:
                row = (0,)
        else:
            row = con.execute("SELECT MAX(last_sync) FROM accounts WHERE login=?", (lg,)).fetchone()
        last = row[0] or 0
        key = None if a.get("legacy") and not lg else lg
        if now - last >= mins * 60 - 30 and not _backing_off(con, key, now):
            out.append(key)
    return out


def _backing_off(con, login, now):
    """Пауза после ошибок подряд: 5, 10, 20, 40, 80 минут, дальше раз в 2 часа. Без неё счёт с ошибкой
    (например, терминал открыт на другом счёте) повторялся каждые 20 секунд: 356 ошибок за сутки 28.10."""
    rows = con.execute("SELECT started, status FROM sync_log WHERE " + ("login IS NULL" if login is None else "login=?")
                       + " ORDER BY id DESC LIMIT 8", () if login is None else (login,)).fetchall()
    k = 0
    for _, st in rows:
        if st not in ("error", "skip"):
            break
        k += 1
    if not k:
        return False
    wait = min(120, 5 * 2 ** (k - 1)) * 60
    return now - rows[0][0] < wait


def test_connection(cfg, acct):
    """Проверка входа без сохранения. Возвращает данные счёта или бросает исключение."""
    if not _lock.acquire(timeout=60):
        raise RuntimeError("Идёт синхронизация, повторите через минуту")
    p = make_provider(cfg, acct)
    try:
        p.connect()
        return p.account()
    finally:
        try:
            p.close()
        except Exception:
            pass
        _lock.release()


# ---------------------------------------------------------------------------- main
def _sync_account(cfg, con, provider, acct, full, log):
    res = {"new_deals": 0, "trades_updated": 0}
    provider.connect()
    acc = provider.account()
    login = acc["login"]
    if acct.get("login") and acct["login"] != login:
        raise RuntimeError(f"Терминал вошёл в счёт {login}, а ожидался {acct['login']}")
    if login in (acct.get("other_logins") or ()):
        # терминал по умолчанию открыл счёт, у которого свой терминал в «Счета»: он синхронизируется отдельно
        # это не сбой: чужой счёт в терминале не трогаем и ждём, пока там снова будет нужный
        raise SkipSync(f"Пропущено: стандартный терминал сейчас открыт на счёте {login}, который синхронизируется "
                       "через свой терминал. Счёт из стандартного терминала обновится, когда в нём снова будет открыт он.")
    res["login"] = login
    con.execute("INSERT OR REPLACE INTO equity_snapshots(login, time, balance, equity) VALUES (?,?,?,?)",
                (login, int(time.time()), acc["balance"], acc["equity"]))
    row = con.execute("SELECT last_deal_time FROM accounts WHERE login=?", (login,)).fetchone()
    last = row["last_deal_time"] if row else None
    if last and not full:
        t_from = last - cfg["sync"]["overlap_days"] * 86400
    else:
        t_from = int(datetime.strptime(cfg["sync"]["history_start"], "%Y-%m-%d").timestamp())
    t_to = int(time.time()) + 3 * 86400  # время сервера может опережать UTC

    deals = provider.deals(t_from, t_to)
    orders = provider.orders(t_from, t_to)
    positions = provider.positions()
    log(f"Счёт {login}: сделок в окне {len(deals)}, открытых позиций {len(positions)}")

    known = {r[0] for r in con.execute("SELECT ticket FROM deals WHERE login=?", (login,))}
    for d in deals:
        if d["ticket"] not in known:
            res["new_deals"] += 1
        _upsert(con, "deals", dict(d, login=login), ["login", "ticket"])
    for o in orders:
        _upsert(con, "orders", dict(o, login=login), ["login", "ticket"])

    # какие позиции пересобрать: затронутые новыми сделками, открытые сейчас и бывшие открытыми
    affected = {d["position_id"] for d in deals if d["position_id"] and d["type"] in (0, 1)}
    open_map = {p["position_id"]: p for p in positions}
    affected |= set(open_map)
    affected |= {r[0] for r in con.execute(
        "SELECT position_id FROM trades WHERE login=? AND status='open'", (login,))}

    symbols_seen = set()
    PROGRESS["step"] = f"позиции и котировки ({len(affected)})"
    for pid in affected:
        pdeals = [dict(r) for r in con.execute(
            "SELECT * FROM deals WHERE login=? AND position_id=? AND type IN (0,1)", (login, pid))]
        porders = [dict(r) for r in con.execute(
            "SELECT * FROM orders WHERE login=? AND position_id=?", (login, pid))]
        tr = build_trade(login, pid, pdeals, porders, open_map.get(pid))
        if not tr:
            continue
        old = con.execute("SELECT mae, mfe, close_time FROM trades WHERE login=? AND position_id=?",
                          (login, pid)).fetchone()
        if old and old["close_time"] == tr["close_time"]:
            tr["mae"], tr["mfe"] = old["mae"], old["mfe"]
        if tr["status"] == "closed" and cfg["sync"]["compute_mae_mfe"] and tr.get("mae") is None:
            try:
                tr["mae"], tr["mfe"] = mae_mfe(provider, con, tr)
            except Exception as e:  # нет истории котировок - не критично
                log(f"MAE/MFE {pid}: {e}")
        _upsert(con, "trades", tr, ["login", "position_id"])
        symbols_seen.add(tr["symbol"])
        res["trades_updated"] += 1

        if cfg["sync"]["prefetch_charts"] and tr["status"] == "closed":
            tf = auto_tf(tr["close_time"] - tr["open_time"])
            a, b = chart_window(tr["open_time"], tr["close_time"], tf)
            have = con.execute("SELECT COUNT(*) FROM rates WHERE symbol=? AND tf=? AND time BETWEEN ? AND ?",
                               (tr["symbol"], tf, a, b)).fetchone()[0]
            if have < 20:
                try:
                    store_rates(con, tr["symbol"], tf, provider.rates(tr["symbol"], tf, a, b))
                except Exception as e:
                    log(f"Котировки {pid}: {e}")

    for sym in symbols_seen:
        info = provider.symbol(sym)
        if info:
            _upsert(con, "symbols", info, ["symbol"])

    try:
        offset = provider.server_offset(sorted({d["symbol"] for d in deals if d.get("symbol")})[:8])
    except Exception:
        offset = None
    last_deal = max((d["time"] for d in deals), default=last)
    row = dict(acc, last_sync=int(time.time()),
               last_deal_time=max(filter(None, [last_deal, last]), default=None))
    if offset is not None:
        row["server_offset"] = offset
    _upsert(con, "accounts", row, ["login"])
    con.commit()
    return res


class SkipSync(Exception):
    """Счёт пропущен не по ошибке (терминал занят другим своим счётом): в журнале - «пропущено», не «ошибка»."""


def run_sync(cfg, full=False, login=None, log=print):
    """Синхронизирует все включённые счета (или один, если указан login)."""
    if not _lock.acquire(timeout=20):  # живое отслеживание держит замок не дольше пары секунд
        return {"status": "busy", "message": "Синхронизация уже выполняется"}
    con = connect(cfg["db_path"])
    total = {"status": "ok", "new_deals": 0, "trades_updated": 0, "message": "", "accounts": []}
    try:
        allacc = list_accounts(cfg, con)
        if login:
            accounts = [a for a in allacc if a["login"] == login and not a.get("legacy")] or [a for a in allacc if a.get("legacy")]
        else:
            accounts = allacc
        if not accounts:
            total.update(status="error", message="Нет включённых счетов. Добавьте счёт в разделе «Счета».")
        PROGRESS.update(running=True, done=0, total=len(accounts), label="", step="подключение к терминалу", started=time.time())
        restore = _active_before(cfg, accounts)
        msgs = []
        prev_path = None
        for n, acct in enumerate(accounts):
            started = int(time.time())
            PROGRESS.update(done=n, label=acct.get("label") or str(acct.get("login") or "счёт терминала"), step="сделки и позиции")
            path = acct.get("terminal_path") or ""
            if prev_path is not None and path != prev_path and cfg["mode"] != "demo":
                time.sleep(2)  # пауза между разными терминалами: пакет MetaTrader5 работает с одним за раз
            prev_path = path
            provider = make_provider(cfg, acct)
            res = {"login": acct.get("login") or None, "new_deals": 0, "trades_updated": 0}
            status, msg = "ok", ""
            try:
                res.update(_sync_account(cfg, con, provider, acct, full, log))
                msg = f"Новых сделок: {res['new_deals']}, обновлено позиций: {res['trades_updated']}"
            except SkipSync as e:
                con.rollback()
                status, msg = "skip", str(e)
            except Exception as e:
                con.rollback()
                status, msg = "error", str(e)
                total["status"] = "error"
            finally:
                try:
                    provider.close()
                except Exception:
                    pass
            name = acct.get("label") or res["login"] or "счёт из config.json"
            msgs.append(f"{name}: {msg}")
            total["new_deals"] += res["new_deals"]
            total["trades_updated"] += res["trades_updated"]
            total["accounts"].append({"login": res["login"], "status": status, "message": msg})
            if res["login"] and not total.get("login"):
                total["login"] = res["login"]
            con.execute("INSERT INTO sync_log(started, finished, login, status, new_deals, trades_updated, message) "
                        "VALUES (?,?,?,?,?,?,?)",
                        (started, int(time.time()), res["login"], status, res["new_deals"],
                         res["trades_updated"], msg))
            con.commit()
        PROGRESS.update(done=len(accounts), label="", step="рыночные данные")
        _restore_active(cfg, restore, log)
        _update_market(cfg, con, accounts, full, log)
        if msgs:
            total["message"] = "; ".join(msgs)
    finally:
        PROGRESS.update(running=False, step="", label="")
        con.close()
        _lock.release()
    log(f"[{total['status']}] {total['message']}")
    return total


def _update_market(cfg, con, accounts, force, log):
    """COT и макро из интернета, дневные цены по рынкам COT из терминала. Ошибки не критичны."""
    try:
        res = market.update(cfg, con, force=force, log=log)
        # цены нужны при каждой синхронизации: загрузка инкрементальная и быстрая
        if res.get("status") != "off":
            p = make_provider(cfg, {"login": 0, "terminal_path": (accounts[0].get("terminal_path") if accounts else "")}
                              if cfg["mode"] != "demo" else (accounts[0] if accounts else None))
            try:
                p.connect()
                market.update_prices(cfg, con, p, log)
            finally:
                p.close()
        for e in res.get("errors") or []:
            log(e)
    except Exception as e:
        log(f"Рыночные данные: {e}")


def _active_before(cfg, accounts):
    """Если несколько счетов делят один терминал, запоминаем, в каком счёте он был до синхронизации."""
    if cfg["mode"] == "demo" or len(accounts) < 2:
        return None
    paths = [a.get("terminal_path") or "" for a in accounts]
    if len(set(paths)) == len(paths):
        return None
    try:
        p = make_provider(cfg, {"terminal_path": paths[0]})
        p.cfg["login"] = 0
        p.connect()
        active = p.active_login()
        p.close()
    except Exception:
        return None
    return next((a for a in accounts if a.get("login") == active), None)


def _restore_active(cfg, acct, log):
    if not acct:
        return
    try:
        p = make_provider(cfg, acct)
        p.connect()
        p.close()
        log(f"Терминал возвращён на счёт {acct['login']}")
    except Exception as e:
        log(f"Не удалось вернуть терминал на счёт {acct.get('login')}: {e}")


def fetch_chart_rates(cfg, con, sym, tf, a, b, acct=None):
    """Котировки для графика: из кэша, при нехватке - из терминала (если он доступен)."""
    bars = cached_rates(con, sym, tf, a, b)
    expected = (b - a) / TF_SEC[tf]
    if len(bars) >= min(expected * 0.4, 30):
        return bars, "cache"
    if not _lock.acquire(timeout=90):
        return bars, "cache"
    provider = make_provider(cfg, acct)
    try:
        provider.connect()
        fresh = provider.rates(sym, tf, a, b)
        if fresh:
            store_rates(con, sym, tf, fresh)
            con.commit()
            return fresh, "terminal"
    except Exception:
        pass
    finally:
        try:
            provider.close()
        except Exception:
            pass
        _lock.release()
    return bars, "cache"
