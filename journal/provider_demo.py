"""Демо-источник: детерминированные синтетические сделки и котировки.

Нужен, чтобы проверить интерфейс и всю цепочку без счёта. Цены сделок берутся из той же
ценовой функции, что и свечи, поэтому отметки на графике лежат точно на свечах.
"""
import math
import random
import time as _time

TF_SEC = {"M1": 60, "M5": 300, "M15": 900, "M30": 1800, "H1": 3600, "H4": 14400, "D1": 86400}

SYMBOLS = {
    #          base    amp    digits contract  profit_ccy  description
    "XAUUSD": (4050.0, 0.030, 2, 100.0, "USD", "Gold vs US Dollar"),
    "EURUSD": (1.1600, 0.012, 5, 100000.0, "USD", "Euro vs US Dollar"),
    "GBPUSD": (1.3400, 0.012, 5, 100000.0, "USD", "Pound vs US Dollar"),
    "USDJPY": (150.00, 0.015, 3, 100000.0, "JPY", "US Dollar vs Yen"),
    "US500":  (6600.0, 0.025, 1, 1.0, "USD", "S&P 500 Index"),
}


def _noise(x, seed):
    h = (int(x) * 2654435761 + seed * 40503) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 1274126177) & 0xFFFFFFFF
    return (h % 10000) / 10000.0 - 0.5


class DemoProvider:
    name = "demo"
    LOGIN = 90001234

    _cache = {}  # история строится один раз на процесс для каждого счёта

    def __init__(self, cfg=None, acct=None):
        self.login = int((acct or {}).get("login") or self.LOGIN)
        self.label = (acct or {}).get("label") or ""
        if self.login not in DemoProvider._cache:
            self.now = int(_time.time()) // 60 * 60
            self._build()
            DemoProvider._cache[self.login] = (self.now, self._deals, self._orders, self._positions)
        self.now, self._deals, self._orders, self._positions = DemoProvider._cache[self.login]

    @property
    def is_prop(self):
        return self.login != self.LOGIN

    # ------------------------------------------------------------------ price model
    def _p(self, sym, t):
        base, amp, digits, *_ = SYMBOLS[sym]
        seed = sum(map(ord, sym))
        x = t / 60.0
        w = (0.55 * math.sin(x / 5100 + seed) + 0.28 * math.sin(x / 1300 + seed * 1.7)
             + 0.14 * math.sin(x / 260 + seed * 0.3) + 0.06 * math.sin(x / 41 + seed * 2.1)
             + 0.03 * _noise(x, seed))
        return round(base * (1 + amp * w), digits)

    def _minute(self, sym, m):
        base, amp, digits, *_ = SYMBOLS[sym]
        o, c = self._p(sym, m), self._p(sym, m + 60)
        wig = base * amp * 0.004 * (0.5 + _noise(m / 60 + 7, 3))
        return o, max(o, c) + abs(wig), min(o, c) - abs(wig), c

    # ------------------------------------------------------------------ interface
    def connect(self):
        pass

    def close(self):
        pass

    def find_symbols(self, prefix):
        return [k for k in SYMBOLS if k.lower().startswith(prefix.lower())]

    def active_login(self):
        return self.login

    def server_offset(self, extra=()):
        return 0

    def account(self):
        bal = sum(d["profit"] + d["commission"] + d["swap"] for d in self._deals)
        flo = sum(p["profit"] for p in self._positions)
        return dict(login=self.login, server="Demo-Server",
                    name=self.label or ("Демо-челлендж" if self.is_prop else "Демо-счёт"),
                    company="Demo Broker", currency="USD", leverage=100,
                    balance=round(bal, 2), equity=round(bal + flo, 2))

    def deals(self, t_from, t_to):
        return [d for d in self._deals if t_from <= d["time"] <= t_to]

    def orders(self, t_from, t_to):
        return [o for o in self._orders if t_from <= o["time_setup"] <= t_to]

    def positions(self):
        return list(self._positions)

    def symbol(self, sym):
        if sym not in SYMBOLS:
            return None
        base, amp, digits, cs, ccy, desc = SYMBOLS[sym]
        return dict(symbol=sym, digits=digits, point=10 ** -digits, contract_size=cs,
                    currency_profit=ccy, description=desc)

    def rates(self, sym, tf, t_from, t_to):
        step = TF_SEC[tf]
        t = t_from // step * step
        end = min(t_to, self.now)
        stride = 60 if step <= 3600 else 300
        out = []
        daily = step >= 86400
        avg = lambda x: sum(self._p(sym, x - k * 3600) for k in range(24)) / 24  # без внутридневного шума
        while t <= end:
            o = avg(t) if daily else self._p(sym, t)
            c = avg(min(t + step, self.now)) if daily else self._p(sym, min(t + step, self.now))
            hi, lo = max(o, c), min(o, c)
            m = t
            while m < t + step and m <= self.now:
                _, mh, ml, _ = self._minute(sym, m)
                hi, lo = max(hi, mh), min(lo, ml)
                m += stride
            if daily:
                hi, lo = max(o, c) * 1.002, min(o, c) * 0.998
            out.append((t, o, round(hi, 6), round(lo, 6), c, float(50 + int(abs(_noise(t, 9)) * 900))))
            t += step
        return out

    # ------------------------------------------------------------------ synthetic history
    def _profit(self, sym, direction, vol, entry, exit_):
        base, amp, digits, cs, ccy, _ = SYMBOLS[sym]
        p = (exit_ - entry) * direction * vol * cs
        if ccy == "JPY":
            p /= exit_
        return round(p, 2)

    def _build(self):
        rnd = random.Random(self.login)
        self._deals, self._orders, self._positions = [], [], []
        tk = [5000000 + (self.login % 1000) * 100000]
        deposit = 100000.0 if self.is_prop else 10000.0
        vmul = 4 if self.is_prop else 1

        def nid():
            tk[0] += 1
            return tk[0]

        start = (self.now // 86400 - (24 if self.is_prop else 120)) * 86400
        self._deals.append(dict(ticket=nid(), order_ticket=0, position_id=0, time=start - 3600,
                                time_msc=(start - 3600) * 1000, type=2, entry=0, reason=0,
                                volume=0, price=0, commission=0, swap=0, fee=0, profit=deposit,
                                symbol="", comment="Deposit", magic=0, sl=0, tp=0))
        syms = list(SYMBOLS)
        weights = [5, 3, 2, 1, 1]
        t = start
        n_open = 0
        while t < self.now - 3600:
            t += rnd.randint(3, 30) * 3600 + rnd.randint(0, 59) * 60
            t = t // 60 * 60
            if t >= self.now - 3600:
                break
            if _time.gmtime(t).tm_wday >= 5:
                continue
            is_open = t > self.now - 2 * 86400 and n_open < 2
            if t > self.now - 2 * 86400 and not is_open:
                continue
            sym = rnd.choices(syms, weights)[0]
            base, amp, digits, cs, ccy, _ = SYMBOLS[sym]
            trend = self._p(sym, t) - self._p(sym, t - 6 * 3600)
            with_trend = 1 if trend >= 0 else -1
            direction = with_trend if rnd.random() < (0.72 if self.is_prop else 0.64) else -with_trend
            vol = {"XAUUSD": rnd.choice([0.1, 0.2, 0.3, 0.5]), "US500": rnd.choice([1.0, 2.0, 5.0])}.get(
                sym, rnd.choice([0.2, 0.5, 1.0]))
            vol = round(vol * vmul, 2)
            entry = self._p(sym, t)
            risk = base * amp * rnd.uniform(0.03, 0.12)
            rr = rnd.choice([1.5, 2.0, 2.5, 3.0, 3.0])
            sl = round(entry - direction * risk, digits)
            tp = round(entry + direction * risk * rr, digits)
            pos = nid()
            open_reason = rnd.choice([0, 0, 1, 1, 1, 2])
            comm = -round(3.5 * vol * (1 if sym != "US500" else 0.1), 2)
            self._orders.append(dict(ticket=pos, position_id=pos, time_setup=t, time_done=t,
                                     type=0 if direction == 1 else 1, state=4, reason=open_reason,
                                     volume_initial=vol, price_open=0, sl=sl, tp=tp,
                                     symbol=sym, comment=""))
            self._deals.append(dict(ticket=nid(), order_ticket=pos, position_id=pos, time=t,
                                    time_msc=t * 1000 + rnd.randint(0, 999),
                                    type=0 if direction == 1 else 1, entry=0, reason=open_reason,
                                    volume=vol, price=entry, commission=comm, swap=0, fee=0,
                                    profit=0, symbol=sym, comment="", magic=0, sl=0, tp=0))
            if is_open:
                n_open += 1
                cur = self._p(sym, self.now)
                self._positions.append(dict(position_id=pos, ticket=pos, symbol=sym,
                                            type=0 if direction == 1 else 1, volume=vol,
                                            price_open=entry, sl=sl, tp=tp, price_current=cur,
                                            profit=self._profit(sym, direction, vol, entry, cur),
                                            swap=0, time=t, reason=open_reason))
                continue

            # прогон по минутам до SL / TP / ручного закрытия
            remaining = vol
            partial_done = False
            want_partial = rnd.random() < 0.25
            manual_at = t + rnd.randint(20, 60 * 36) * 60 if rnd.random() < 0.35 else None
            m = t + 60
            limit = t + 4 * 86400
            exit_price, close_reason = None, None
            while m < min(limit, self.now - 3600):
                o, h, l, c = self._minute(sym, m)
                hit_sl = (l <= sl) if direction == 1 else (h >= sl)
                hit_tp = (h >= tp) if direction == 1 else (l <= tp)
                one_r = entry + direction * risk
                if want_partial and not partial_done and ((h >= one_r) if direction == 1 else (l <= one_r)):
                    pv = round(remaining / 2, 2)
                    if pv >= 0.01:
                        remaining = round(remaining - pv, 2)
                        price = round(one_r, digits)
                        self._deals.append(dict(
                            ticket=nid(), order_ticket=nid(), position_id=pos, time=m,
                            time_msc=m * 1000, type=1 if direction == 1 else 0, entry=1,
                            reason=rnd.choice([0, 1]), volume=pv, price=price,
                            commission=round(comm * pv / vol, 2), swap=0, fee=0,
                            profit=self._profit(sym, direction, pv, entry, price),
                            symbol=sym, comment="partial", magic=0, sl=0, tp=0))
                    partial_done = True
                if hit_sl:
                    exit_price, close_reason = sl, 4
                elif hit_tp:
                    exit_price, close_reason = tp, 5
                elif manual_at and m >= manual_at:
                    exit_price, close_reason = c, rnd.choice([0, 1, 1])
                if exit_price is not None:
                    break
                m += 60
            if exit_price is None:
                exit_price, close_reason = self._p(sym, m), 0
            days = max(0, (m - t) // 86400)
            swap = -round(days * vol * rnd.uniform(0.5, 4), 2)
            self._deals.append(dict(
                ticket=nid(), order_ticket=nid(), position_id=pos, time=m, time_msc=m * 1000,
                type=1 if direction == 1 else 0, entry=1, reason=close_reason,
                volume=remaining, price=exit_price,
                commission=round(comm * remaining / vol, 2), swap=swap, fee=0,
                profit=self._profit(sym, direction, remaining, entry, exit_price),
                symbol=sym, comment="[sl]" if close_reason == 4 else "[tp]" if close_reason == 5 else "",
                magic=0, sl=0, tp=0))
        self._deals.sort(key=lambda d: d["time_msc"])
