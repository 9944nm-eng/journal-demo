"""Источник данных: терминал MetaTrader 5 через официальный пакет MetaTrader5 (только Windows).

Все времена, которые отдаёт MT5, - это время сервера брокера, упакованное в unix-timestamp.
Сделки и котировки используют одну и ту же шкалу, поэтому отметки на графике совпадают со свечами
без пересчёта часовых поясов.
"""
from datetime import datetime, timezone

TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"]


class MT5Error(RuntimeError):
    pass


def _dt(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc)


class MT5Provider:
    name = "mt5"

    def __init__(self, cfg, acct=None):
        # acct - счёт из раздела «Счета»; без него берутся настройки mt5 из config.json
        base = dict(cfg.get("mt5") or {})
        if acct:
            base.update({k: v for k, v in acct.items() if v not in (None, "")})
        self.cfg = base
        self.mt5 = None

    # ------------------------------------------------------------------ connection
    def connect(self):
        try:
            import MetaTrader5 as mt5
        except ImportError as e:
            raise MT5Error(
                "Пакет MetaTrader5 не установлен. Выполните setup.bat "
                "(пакет работает только на Windows)."
            ) from e
        self.mt5 = mt5
        kwargs = {"timeout": int(self.cfg.get("timeout_ms") or 60000)}
        if self.cfg.get("terminal_path"):
            kwargs["path"] = self.cfg["terminal_path"]
        login = int(self.cfg.get("login") or 0)
        if login:
            kwargs.update(login=login, password=self.cfg.get("password", ""),
                          server=self.cfg.get("server", ""))
        if not mt5.initialize(**kwargs):
            err = mt5.last_error()
            mt5.shutdown()
            where = self.cfg.get("terminal_path") or "терминал по умолчанию"
            hint = ("" if self.cfg.get("terminal_path") else
                    " Укажите для этого счёта путь к его terminal64.exe в «Счета» → «Изменить».")
            raise MT5Error(f"Не удалось подключиться к MT5 ({where}): {err}.{hint}")
        info = mt5.account_info()
        if info is None:
            raise MT5Error(f"Терминал запущен, но счёт не авторизован: {mt5.last_error()}")
        if login and info.login != login:
            if not mt5.login(login, password=self.cfg.get("password", ""),
                             server=self.cfg.get("server", "")):
                raise MT5Error(f"Не удалось войти в счёт {login}: {mt5.last_error()}")

    def active_login(self):
        a = self.mt5.account_info()
        return a.login if a else None

    def server_offset(self, extra=()):
        """Сдвиг времени сервера брокера относительно UTC (по последней минутной свече), в секундах.
        Только разрешённые вызовы: positions_get и copy_rates_from_pos (правила проп-фирм)."""
        import time as _t
        from datetime import datetime, timezone
        now = _t.time()
        wd = datetime.fromtimestamp(now, tz=timezone.utc)
        # в выходные свежих минут нет: последняя свеча пятницы может случайно сойтись с целым часом
        # (так однажды записался сдвиг −4 ч вместо +3 ч) - сдвиг в это время не меняем
        if wd.weekday() == 5 or (wd.weekday() == 6 and wd.hour < 21) or (wd.weekday() == 4 and wd.hour >= 21):
            return None
        cands = list(dict.fromkeys([p.symbol for p in (self.mt5.positions_get() or ())] + list(extra) + ["EURUSD", "XAUUSD"]))
        votes = {}
        for sym in cands[:12]:
            res = self.mt5.copy_rates_from_pos(sym, self.mt5.TIMEFRAME_M1, 0, 1)
            if res is None or not len(res):
                continue
            # сдвиг брокеров - целые часы; учитываем только идущую сейчас минуту (не старше 2 минут),
            # устаревшая свеча закрытого рынка остатком с целым часом не сходится
            t = int(res[0]["time"]) + 30
            off = round((t - now) / 3600) * 3600
            if abs(off) <= 14 * 3600 and abs(t - off - now) < 120:
                votes[int(off)] = votes.get(int(off), 0) + 1
        return max(votes, key=votes.get) if votes else None

    def close(self):
        if self.mt5:
            self.mt5.shutdown()  # отключает скрипт; сам терминал не закрывается

    # ------------------------------------------------------------------ data
    def account(self):
        a = self.mt5.account_info()
        return dict(login=a.login, server=a.server, name=a.name, company=a.company,
                    currency=a.currency, leverage=a.leverage, balance=a.balance,
                    equity=a.equity)

    def deals(self, t_from, t_to):
        res = self.mt5.history_deals_get(_dt(t_from), _dt(t_to))
        if res is None:
            raise MT5Error(f"history_deals_get: {self.mt5.last_error()}")
        out = []
        for d in res:
            out.append(dict(
                ticket=d.ticket, order_ticket=d.order, position_id=d.position_id,
                time=d.time, time_msc=d.time_msc, type=d.type, entry=d.entry,
                reason=d.reason, volume=d.volume, price=d.price,
                commission=d.commission, swap=d.swap, fee=getattr(d, "fee", 0.0),
                profit=d.profit, symbol=d.symbol, comment=d.comment, magic=d.magic,
                # DEAL_SL / DEAL_TP есть не во всех сборках пакета
                sl=getattr(d, "sl", 0.0), tp=getattr(d, "tp", 0.0),
            ))
        return out

    def orders(self, t_from, t_to):
        res = self.mt5.history_orders_get(_dt(t_from), _dt(t_to))
        if res is None:
            return []
        return [dict(ticket=o.ticket, position_id=o.position_id, time_setup=o.time_setup,
                     time_done=o.time_done, type=o.type, state=o.state, reason=o.reason,
                     volume_initial=o.volume_initial, price_open=o.price_open,
                     sl=o.sl, tp=o.tp, symbol=o.symbol, comment=o.comment) for o in res]

    def positions(self):
        res = self.mt5.positions_get() or ()
        return [dict(position_id=p.identifier, ticket=p.ticket, symbol=p.symbol,
                     type=p.type, volume=p.volume, price_open=p.price_open, sl=p.sl,
                     tp=p.tp, price_current=p.price_current, profit=p.profit,
                     swap=p.swap, time=p.time, reason=p.reason) for p in res]

    # symbol_select не вызывается: журнал не меняет «Обзор рынка» терминала (только чтение, правила проп-фирм).
    # Свечи по инструменту, которого нет в «Обзоре рынка», терминал может не отдать - тогда его нужно добавить вручную.
    def symbol(self, sym):
        s = self.mt5.symbol_info(sym)
        if s is None:
            return None
        return dict(symbol=sym, digits=s.digits, point=s.point,
                    contract_size=s.trade_contract_size,
                    currency_profit=s.currency_profit, description=s.description)

    SUFFIXES = ("", ".raw", ".r", ".m", "m", ".pro", "+", ".a", ".i", "_i", ".ecn", "-ecn", ".std", ".c", ".x", "#")

    def find_symbols(self, prefix):
        """Символ у брокера с его суффиксом (XAUUSD -> XAUUSD.raw): перебор через symbol_info.
        symbols_get не используется: в списке разрешённых вызовов MT5 его нет (правила проп-фирм)."""
        out = []
        for suf in self.SUFFIXES:
            for name in (prefix + suf, prefix + suf.upper()):
                if name not in out and self.mt5.symbol_info(name) is not None:
                    out.append(name)
        return out

    def rates(self, sym, tf, t_from, t_to):
        frame = getattr(self.mt5, "TIMEFRAME_" + tf)
        res = self.mt5.copy_rates_range(sym, frame, _dt(t_from), _dt(t_to))
        if (res is None or len(res) == 0) and tf in ("D1", "H4", "H1"):
            # история в терминале может быть ещё не скачана: запрос по номеру бара надёжнее
            step = {"D1": 86400, "H4": 14400, "H1": 3600}[tf]
            n = min(100000, int((t_to - t_from) / step) + 10)
            res = self.mt5.copy_rates_from_pos(sym, frame, 0, n)
            if res is not None:
                res = [r for r in res if t_from <= int(r["time"]) <= t_to]
        if res is None:
            return []
        return [(int(r["time"]), float(r["open"]), float(r["high"]), float(r["low"]),
                 float(r["close"]), float(r["tick_volume"])) for r in res]
