"""Анализ: «Что если» по реальным сделкам, инсайты о привычках, вероятность пройти челлендж."""
import math


def _pl(n, one, few, many):
    m10, m100 = n % 10, n % 100
    return one if m10 == 1 and m100 != 11 else few if 2 <= m10 <= 4 and not 12 <= m100 <= 14 else many

import random
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone

from . import analytics
from . import settings as appset
from .sync import cached_rates, store_rates, whatif_extension

WINDOW_MAX = 3 * 86400


# ---------------------------------------------------------------------------- общие данные
def closed_trades(con, f, shift_h):
    trades = [t for t in analytics.list_trades(con, dict(f, status="closed"), shift_h)]
    trades.sort(key=lambda t: t["open_time"])
    return trades


def add_context(con, login, trades, shift_h):
    """Риск в % счёта, номер сделки в дне, сделки после убытков, результат дня на момент входа."""
    deals = con.execute("SELECT time, profit, commission, swap, fee FROM deals WHERE login=? ORDER BY time_msc",
                        (login,)).fetchall()
    times = [d[0] for d in deals]
    cum, run = [], 0.0
    for d in deals:
        run += (d[1] or 0) + (d[2] or 0) + (d[3] or 0) + (d[4] or 0)
        cum.append(run)
    import bisect
    shift = int(shift_h * 3600)
    by_close = sorted([t for t in trades if t.get("close_time")], key=lambda t: t["close_time"])
    day_count = defaultdict(int)
    from . import news as news_mod
    try:
        high = news_mod.around(con, min(t["open_time"] for t in trades) - 2 * 86400, max(t["open_time"] for t in trades) + 2 * 86400) if trades else []
    except Exception:
        high = []
    from . import sleep as sleep_mod
    sleep_mod.for_trades(con, trades)  # сон перед сделкой, если данные Apple Watch подключены
    for t in trades:
        t["news_minutes"] = news_mod.nearest_minutes(high, t["symbol"], t["open_time"] - int(t.get("server_offset") or 0)) if high else None
        i = bisect.bisect_left(times, t["open_time"]) - 1
        bal = cum[i] if i >= 0 else None
        mpr = abs(t["profit"] / t["r"]) if t.get("r") and abs(t["r"]) >= 0.1 else None
        t["risk_money"] = mpr
        t["balance_at_entry"] = bal
        t["risk_pct"] = round(100 * mpr / bal, 3) if mpr and bal and bal > 0 else None
        dkey = datetime.fromtimestamp(t["open_time"] + shift, tz=timezone.utc).strftime("%Y-%m-%d")
        day_count[dkey] += 1
        t["nth_today"] = day_count[dkey]
        t["day_key"] = dkey
        # сделки, закрытые до этого входа
        prev = [x for x in by_close if x["close_time"] <= t["open_time"] and x is not t]
        last = prev[-1] if prev else None
        t["mins_after_loss"] = round((t["open_time"] - last["close_time"]) / 60) if last and last["net"] < 0 else None
        # переворот: тот же инструмент, обратное направление, после убыточной сделки на нём
        from .twins import base_symbol
        # (две сделки могут закрыться в одну минуту - ищем убыточную встречную среди всех закрытых до входа)
        stops = [x for x in prev if base_symbol(x["symbol"]) == base_symbol(t["symbol"]) and x["net"] < 0 and x["direction"] == -t["direction"]]
        ls = max(stops, key=lambda x: x["close_time"]) if stops else None
        t["reversal_min"] = round((t["open_time"] - ls["close_time"]) / 60) if ls else None
        t["after"] = None if not last else ("win" if last["net"] > 0 else "loss" if last["net"] < 0 else None)
        streak = 0
        for x in reversed(prev):
            if x["net"] < 0 and datetime.fromtimestamp(x["close_time"] + shift, tz=timezone.utc).strftime("%Y-%m-%d") == dkey:
                streak += 1
            else:
                break
        t["loss_streak_today"] = streak
        t["day_pnl_at_entry"] = round(sum(x["net"] for x in prev if datetime.fromtimestamp(
            x["close_time"] + shift, tz=timezone.utc).strftime("%Y-%m-%d") == dkey), 2)
    return trades


def m1_window(t):
    dur = (t["close_time"] or t["open_time"]) - t["open_time"]
    return t["open_time"] // 60 * 60, min(t["close_time"] + whatif_extension(dur), t["open_time"] + WINDOW_MAX + dur)


def coverage(con, t):
    a, b = m1_window(t)
    b = min(b, int(time.time()))
    n = con.execute("SELECT COUNT(*) FROM rates WHERE symbol=? AND tf='M1' AND time BETWEEN ? AND ?",
                    (t["symbol"], a, b)).fetchone()[0]
    return n, max(1, (b - a) // 60)


def prepare(provider, con, trades, log=print):
    """Догружает минутки для сделок, у которых их нет (нужен терминал)."""
    done = 0
    for t in trades:
        if not t.get("sl_used") or (t["close_time"] - t["open_time"]) > 5 * 86400:
            continue
        n, exp = coverage(con, t)
        if n >= exp * 0.35:
            continue
        a, b = m1_window(t)
        try:
            store_rates(con, t["symbol"], "M1", provider.rates(t["symbol"], "M1", a, min(b, int(time.time()) + 86400)))
            done += 1
        except Exception as e:
            log(f"Минутки {t['position_id']}: {e}")
    con.commit()
    return done


# ---------------------------------------------------------------------------- «Что если»
def _sim(t, bars, kind, k):
    e, d, s0 = t["entry_price"], t["direction"], t["sl_used"]
    r1 = abs(e - s0)
    if not r1:
        return None
    actual = t["r"]
    after = [b for b in bars if b[0] > t["open_time"] // 60 * 60]
    fav = lambda b: (b[2] - e) if d > 0 else (e - b[3])
    adv = lambda b: (e - b[3]) if d > 0 else (b[2] - e)
    if kind == "actual":
        return actual
    if kind == "tp":
        for b in after:
            if adv(b) >= r1:
                return -1.0  # стоп и тейк в одной свече - считаем худший случай
            if fav(b) >= k * r1:
                return float(k)
        return round((after[-1][4] - e) * d / r1, 3) if after else None
    if kind in ("be", "partial", "partial_be"):
        reached = False
        for b in after:
            if b[0] >= t["close_time"]:
                break
            if not reached:
                if adv(b) >= r1:
                    return actual
                if fav(b) >= r1:
                    reached = True
                continue
            if kind in ("be", "partial_be") and adv(b) >= 0:
                return 0.0 if kind == "be" else 0.5
        if not reached:
            return actual
        return actual if kind == "be" else round(0.5 + 0.5 * actual, 3)
    if kind == "time":
        limit = t["open_time"] + k * 3600
        if t["close_time"] <= limit:
            return actual
        last = None
        for b in after:
            if b[0] > limit:
                break
            if adv(b) >= r1:
                return -1.0
            last = b
        return round((last[4] - e) * d / r1, 3) if last else None
    return None


def _summary(rs, nets=None):
    rs = [x for x in rs if x is not None]
    if not rs:
        return {"n": 0}
    wins = [x for x in rs if x > 0]
    losses = [x for x in rs if x < 0]
    eq = peak = dd = 0.0
    for x in rs:
        eq += x
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    out = {"n": len(rs), "sum_r": round(sum(rs), 2), "avg_r": round(sum(rs) / len(rs), 3),
           "win_rate": round(100 * len(wins) / len(rs), 1),
           "pf": round(sum(wins) / -sum(losses), 2) if losses else None, "max_dd_r": round(dd, 2)}
    if nets is not None:
        out["net"] = round(sum(nets), 2)
    return out


def whatif(con, login, f, shift_h, tps=(1, 1.5, 2, 3), hours=(2, 4, 8), max_risk=0.5):
    trades = add_context(con, login, closed_trades(con, dict(f, login=login), shift_h), shift_h)
    with_sl = [t for t in trades if t.get("sl_used") and t.get("r") is not None]
    usable, bars_of, missing = [], {}, 0
    for t in with_sl:
        if t["close_time"] - t["open_time"] > 5 * 86400:
            continue
        a, b = m1_window(t)
        bars = cached_rates(con, t["symbol"], "M1", a, b)
        n, exp = len(bars), max(1, (min(b, int(time.time())) - a) // 60)
        if n < exp * 0.35:
            missing += 1
            continue
        bars_of[t["position_id"]] = bars
        usable.append(t)

    num = lambda k: (f"{k:g}").replace(".", ",")
    scen = [("actual", "Как было", 0)]
    scen += [("tp", f"Тейк {num(k)}R, стоп исходный", k) for k in tps]
    scen += [("be", "Безубыток после 1R, выход как был", 1), ("partial", "Половина на 1R, остаток как был", 1),
             ("partial_be", "Половина на 1R, остаток в безубыток", 1)]
    scen += [("time", f"Выход через {num(k)} ч, если не стоп раньше", k) for k in hours]
    results = []
    for kind, name, k in scen:
        rs = [_sim(t, bars_of[t["position_id"]], kind, k) for t in usable]
        series, eq = [], 0.0
        for t, r in zip(usable, rs):
            if r is None:
                continue
            eq += r
            series.append({"time": t["close_time"] + int(shift_h * 3600), "value": round(eq, 2)})
        results.append({"id": f"{kind}_{k}", "name": name, **_summary(rs), "series": series})

    # исключение групп сделок (по фактическому результату)
    groups = [
        ("off_plan", "Сделки вне плана", lambda t: t.get("followed_plan") == 0),
        ("no_session", "Вне торговых сессий", lambda t: t.get("session") == "Вне сессий"),
        ("revenge", "Вход в течение 15 минут после убытка", lambda t: t["mins_after_loss"] is not None and t["mins_after_loss"] <= 15),
        ("after2", "После двух убытков подряд за день", lambda t: t["loss_streak_today"] >= 2),
        ("nth4", "Четвёртая и следующие сделки дня", lambda t: t["nth_today"] >= 4),
        ("phone", "Открытые с телефона", lambda t: t.get("open_reason") == 1),
        ("no_setup", "Без сетапа", lambda t: not t.get("setup")),
        ("low_check", "Чек-лист выполнен меньше чем на 70%", lambda t: t.get("check_pct") is not None and t["check_pct"] < 70),
        ("risk_over", f"Риск выше {str(max_risk).replace('.', ',')}% счёта", lambda t: t.get("risk_pct") is not None and t["risk_pct"] > max_risk * 1.1),
        ("sleep_short", "После короткой ночи (на час меньше нормы)", lambda t: bool(t.get("sleep_short"))),
    ]
    base_r = [t["r"] for t in trades if t.get("r") is not None]
    base = _summary(base_r, [t["net"] for t in trades])
    excl = []
    for gid, name, fn in groups:
        g = [t for t in trades if fn(t)]
        if not g or len(g) == len(trades):
            continue
        rest = [t for t in trades if not fn(t)]
        excl.append({"id": gid, "name": name, "excluded": len(g),
                     "excluded_net": round(sum(t["net"] for t in g), 2),
                     "excluded_r": round(sum(t["r"] for t in g if t.get("r") is not None), 2),
                     "without": _summary([t["r"] for t in rest if t.get("r") is not None], [t["net"] for t in rest])})
    return {"total": len(trades), "with_sl": len(with_sl), "usable": len(usable), "missing": missing,
            "scenarios": results, "base": base, "exclusions": excl}


# ---------------------------------------------------------------------------- инсайты
def _grp(ts):
    rs = [t["r"] for t in ts if t.get("r") is not None]
    return {"n": len(ts), "win_rate": round(100 * sum(1 for t in ts if t["net"] > 0) / len(ts), 1) if ts else None,
            "avg_r": round(sum(rs) / len(rs), 2) if rs else None, "net": round(sum(t["net"] for t in ts), 2)}


def insights(con, login, f, shift_h, max_risk=0.5):
    trades = add_context(con, login, closed_trades(con, dict(f, login=login), shift_h), shift_h)
    out = []
    if len(trades) < 8:
        return {"items": [], "total": len(trades)}

    def compare(iid, title, a, b, text_bad, text_good, link=None, min_n=5):
        if len(a) < min_n or len(b) < min_n:
            return
        A, B = _grp(a), _grp(b)
        dr = (A["avg_r"] - B["avg_r"]) if A["avg_r"] is not None and B["avg_r"] is not None else None
        dw = A["win_rate"] - B["win_rate"]
        if (dr is None or abs(dr) < 0.25) and abs(dw) < 10:
            return
        bad = (dr if dr is not None else dw / 40) < 0
        score = (abs(dr) if dr is not None else abs(dw) / 40) * math.sqrt(min(len(a), len(b)))
        out.append({"id": iid, "title": title, "kind": "neg" if bad else "pos",
                    "text": (text_bad if bad else text_good).format(A=A, B=B, dw=abs(dw), dr=abs(dr or 0)),
                    "a": A, "b": B, "weak": min(len(a), len(b)) < 15, "score": round(score, 3), "link": link})

    rest = lambda fn: [t for t in trades if not fn(t)]
    sel = lambda fn: [t for t in trades if fn(t)]

    fn = lambda t: t["mins_after_loss"] is not None and t["mins_after_loss"] <= 15
    compare("revenge", "Быстрый вход после убытка", sel(fn), rest(fn),
            "Сделки, открытые в течение 15 минут после убыточной, хуже остальных на {dr:.2f}R в среднем (прибыльных {A[win_rate]}% против {B[win_rate]}%). Похоже на попытку отыграться.",
            "Сделки сразу после убытка у вас не хуже остальных: признаков отыгрыша нет.")
    fn = lambda t: t["loss_streak_today"] >= 2
    compare("after2", "После двух убытков подряд", sel(fn), rest(fn),
            "После двух убыточных сделок подряд за день результат падает: в среднем на {dr:.2f}R хуже. Правило «два убытка - стоп на день» сэкономило бы {A[net]:.0f}.",
            "После двух убытков подряд вы торгуете не хуже обычного.")
    fn = lambda t: t["nth_today"] >= 3
    compare("overtrade", "Третья и следующие сделки дня", sel(fn), rest(fn),
            "Третья и последующие сделки дня в среднем хуже первых двух на {dr:.2f}R. Возможна перегрузка или торговля от скуки.",
            "Поздние сделки дня у вас лучше первых двух на {dr:.2f}R: первые входы стоит проверить на поспешность.")
    fn = lambda t: t["day_pnl_at_entry"] > 0
    compare("green_day", "Торговля после плюса за день", sel(fn), rest(fn),
            "Сделки, открытые когда день уже в плюсе, хуже остальных на {dr:.2f}R. Часть прибыли дня возвращается рынку.",
            "Сделки после плюса за день у вас лучше остальных: уверенность помогает, а не мешает.")
    fn = lambda t: t.get("open_reason") == 1
    compare("phone", "Сделки с телефона", sel(fn), rest(fn),
            "Сделки, открытые с телефона, хуже открытых с ПК на {dr:.2f}R (прибыльных {A[win_rate]}% против {B[win_rate]}%).",
            "Сделки с телефона у вас лучше, чем с ПК, на {dr:.2f}R.", link={"source": "1"})
    fn = lambda t: t.get("followed_plan") == 0
    compare("plan", "Вне плана", sel(fn), [t for t in trades if t.get("followed_plan") == 1],
            "Сделки вне плана хуже сделок по плану на {dr:.2f}R. Отклонения от плана стоят вам {A[net]:.0f}.",
            "Сделки вне плана пока не хуже плановых: стоит проверить, не устарел ли сам план.", link={"plan": "0"}, min_n=3)
    fn = lambda t: t.get("check_pct") is not None and t["check_pct"] < 100
    compare("check", "Неполный чек-лист", sel(fn), [t for t in trades if t.get("check_pct") == 100],
            "Сделки с неполным чек-листом хуже сделок с выполненным полностью на {dr:.2f}R.",
            "Полнота чек-листа пока не влияет на результат: возможно, в нём есть лишние пункты.", min_n=3)
    fn = lambda t: not t.get("setup")
    compare("setup", "Сделки без сетапа", sel(fn), rest(fn),
            "Сделки без указанного сетапа хуже остальных на {dr:.2f}R.",
            "Сделки без сетапа не хуже остальных: возможно, вы не записываете сетап у удачных входов.")
    for d, name in ((1, "Лонги"), (-1, "Шорты")):
        fn = lambda t, d=d: t["direction"] == d
        compare(f"dir{d}", name, sel(fn), rest(fn), name + " хуже противоположного направления на {dr:.2f}R.",
                name + " лучше противоположного направления на {dr:.2f}R.", link={"direction": str(d)})
        break  # одного сравнения достаточно
    # худшая сессия, день недели, инструмент
    for key, label, lk, worst_w in (("session", "Сессия", "session", "худшая"), ("symbol", "Инструмент", "symbol", "худший")):
        groups = defaultdict(list)
        for t in trades:
            groups[t.get(key) or "—"].append(t)
        cand = [(k, v) for k, v in groups.items() if len(v) >= 5]
        if len(cand) >= 2:
            worst = min(cand, key=lambda kv: _grp(kv[1])["avg_r"] if _grp(kv[1])["avg_r"] is not None else 0)
            compare(f"worst_{key}", f"{label}: {worst[0]}", worst[1], [t for t in trades if (t.get(key) or "—") != worst[0]],
                    f"{label} «{worst[0]}» - {worst_w}: в среднем на {{dr:.2f}}R хуже остальных ({len(worst[1])} {_pl(len(worst[1]), 'сделка', 'сделки', 'сделок')}, итог {{A[net]:.0f}}).",
                    f"{label} «{worst[0]}» не хуже остальных.", link={lk: worst[0]})
    wd = defaultdict(list)
    names = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
    for t in trades:
        wd[datetime.fromtimestamp(t["open_time"] + int(shift_h * 3600), tz=timezone.utc).weekday()].append(t)
    cand = [(k, v) for k, v in wd.items() if len(v) >= 5]
    if len(cand) >= 2:
        worst = min(cand, key=lambda kv: _grp(kv[1])["avg_r"] or 0)
        compare("weekday", f"День недели: {names[worst[0]]}", worst[1], [t for k, v in wd.items() if k != worst[0] for t in v],
                f"Хуже всего у вас {names[worst[0]]}: в среднем на {{dr:.2f}}R хуже остальных дней.", "")
    # сон (Apple Watch): сравниваем только сделки, у которых есть ночь перед ними
    slept = [t for t in trades if t.get("sleep_min") is not None]
    if slept:
        fn = lambda t: t["sleep_short"]
        compare("sleep_short", "После короткой ночи", [t for t in slept if fn(t)], [t for t in slept if not fn(t)],
                "Сделки после ночи на час короче вашей нормы хуже остальных на {dr:.2f}R (прибыльных {A[win_rate]}% против {B[win_rate]}%). В такие дни стоит снижать риск.",
                "Короткая ночь пока не ухудшает ваши сделки.", min_n=4)
        fn = lambda t: t["bed_late"]
        compare("bed_late", "Поздний отбой", [t for t in slept if fn(t)], [t for t in slept if not fn(t)],
                "Если вы легли на час позже обычного, сделки следующего дня хуже на {dr:.2f}R.",
                "Поздний отбой пока не сказывается на результате.", min_n=4)
        woke = [t for t in slept if t.get("hours_awake") is not None]
        fn = lambda t: t["hours_awake"] < 2
        compare("fresh_wake", "Вход в первые 2 часа после пробуждения", [t for t in woke if fn(t)], [t for t in woke if not fn(t)],
                "Сделки в первые 2 часа после пробуждения хуже остальных на {dr:.2f}R: голова ещё не включилась.",
                "Ранние после пробуждения входы у вас не хуже остальных.", min_n=4)
    # оценка исполнения
    hi, lo =[t for t in trades if (t.get("grade") or 0) >= 4], [t for t in trades if t.get("grade") and t["grade"] <= 2]
    compare("grade", "Оценка исполнения", lo, hi,
            "Сделки, которые вы оценили на 1-2, хуже оценённых на 4-5 на {dr:.2f}R: ваша самооценка исполнения работает.",
            "Сделки с низкой оценкой не хуже высоко оценённых: оценка, возможно, ставится по результату, а не по исполнению.", min_n=3)
    # состояние
    em = defaultdict(list)
    for t in trades:
        if t.get("emotion"):
            em[t["emotion"].strip()].append(t)
    for k, v in em.items():
        compare(f"emo_{k}", f"Состояние: {k}", v, [t for t in trades if (t.get("emotion") or "").strip() != k],
                f"В состоянии «{k}» сделки хуже остальных на {{dr:.2f}}R.", f"В состоянии «{k}» сделки лучше остальных на {{dr:.2f}}R.", min_n=3)

    # отдельные правила без сравнения двух групп
    after_loss = [t["risk_pct"] for t in trades if t["after"] == "loss" and t.get("risk_pct")]
    after_win = [t["risk_pct"] for t in trades if t["after"] == "win" and t.get("risk_pct")]
    if len(after_loss) >= 5 and len(after_win) >= 5:
        ratio = statistics.mean(after_loss) / statistics.mean(after_win)
        if ratio >= 1.2 or ratio <= 0.8:
            out.append({"id": "risk_after_loss", "title": "Риск после убытка", "kind": "neg" if ratio >= 1.2 else "info",
                        "text": (f"После убытка вы рискуете в среднем на {round((ratio - 1) * 100)}% больше, чем после прибыли "
                                 f"({statistics.mean(after_loss):.2f}% против {statistics.mean(after_win):.2f}% счёта)."
                                 if ratio >= 1.2 else
                                 f"После убытка вы снижаете риск на {round((1 - ratio) * 100)}%: это защищает счёт, но проверьте, не пропускаете ли хорошие входы."),
                        "weak": min(len(after_loss), len(after_win)) < 15, "score": abs(ratio - 1) * 3 * math.sqrt(min(len(after_loss), len(after_win)))})
    over = [t for t in trades if t.get("risk_pct") and t["risk_pct"] > max_risk * 1.1]
    known = [t for t in trades if t.get("risk_pct")]
    if over and known:
        share = 100 * len(over) / len(known)
        out.append({"id": "risk_over", "title": "Риск выше лимита", "kind": "neg",
                    "text": f"В {len(over)} из {len(known)} сделок ({share:.0f}%) риск был выше {str(max_risk).replace('.', ',')}% счёта, максимум {max(t['risk_pct'] for t in over):.2f}%. Итог этих сделок {sum(t['net'] for t in over):.0f}.",
                    "weak": len(known) < 15, "score": share / 10})
    wins = [t for t in trades if t["net"] > 0 and t.get("duration")]
    losses = [t for t in trades if t["net"] < 0 and t.get("duration")]
    if len(wins) >= 5 and len(losses) >= 5:
        mw, ml = statistics.median(t["duration"] for t in wins), statistics.median(t["duration"] for t in losses)
        if mw and ml / mw >= 1.5:
            out.append({"id": "hold_losers", "title": "Убыточные сделки держите дольше", "kind": "neg",
                        "text": f"Медианная длительность убыточной сделки {round(ml / 60)} мин, прибыльной {round(mw / 60)} мин. Обычно это значит, что прибыль фиксируется рано, а убыток пересиживается в надежде на разворот.",
                        "weak": min(len(wins), len(losses)) < 15, "score": (ml / mw - 1) * math.sqrt(min(len(wins), len(losses)))})
        elif ml and mw / ml >= 1.5:
            out.append({"id": "hold_winners", "title": "Прибыльные сделки держите дольше", "kind": "pos",
                        "text": f"Медианная длительность прибыльной сделки {round(mw / 60)} мин, убыточной {round(ml / 60)} мин: убытки режете быстро, прибыли даёте идти.",
                        "weak": min(len(wins), len(losses)) < 15, "score": 0.5})
    eff = [max(-1, min(1, (t["exit_price"] - t["entry_price"]) * t["direction"] / t["mfe"])) for t in trades
           if t["net"] > 0 and t.get("mfe")]
    if len(eff) >= 5:
        m = 100 * statistics.mean(eff)
        if m < 55:
            out.append({"id": "mfe", "title": "Прибыль забираете не полностью", "kind": "neg",
                        "text": f"В прибыльных сделках вы забираете в среднем {m:.0f}% движения в вашу пользу. Сравните варианты выхода в «Что если».",
                        "weak": len(eff) < 15, "score": (55 - m) / 15 * math.sqrt(len(eff)) / 3})
    no_sl = [t for t in trades if not t.get("sl_used")]
    if no_sl:
        out.append({"id": "no_sl", "title": "Сделки без стопа", "kind": "neg",
                    "text": f"У {len(no_sl)} сделок не найден стоп (итог {sum(t['net'] for t in no_sl):.0f}). Для них не считаются R и сценарии «Что если». Если стоп был, укажите его вручную в карточке сделки.",
                    "weak": False, "score": len(no_sl) / max(1, len(trades)) * 5})
    import re
    sessions_all = [x["name"] for x in appset.get(con, "sessions")]
    sugg = {
        "revenge": [{"type": "rule", "kind": "cooldown", "params": {"minutes": 30}}],
        "after2": [{"type": "rule", "kind": "stop_after_losses", "params": {"n": 2}}],
        "overtrade": [{"type": "rule", "kind": "max_trades_day", "params": {"n": 2}}],
        "risk_over": [{"type": "rule", "kind": "max_risk", "params": {"pct": max_risk}}],
        "risk_after_loss": [{"type": "rule", "kind": "max_risk", "params": {"pct": max_risk}},
                            {"type": "checklist", "text": "Риск не выше обычного, даже после убытка"}],
        "phone": [{"type": "rule", "kind": "no_phone", "params": {}}],
        "no_sl": [{"type": "rule", "kind": "require_sl", "params": {}}],
        "plan": [{"type": "checklist", "text": "Сделка есть в плане дня"}],
        "setup": [{"type": "checklist", "text": "Сетап назван до входа"}],
        "green_day": [{"type": "checklist", "text": "День в плюсе: вход только по лучшему сетапу"}],
        "hold_losers": [{"type": "checklist", "text": "Стоп не сдвигаю дальше от входа"}],
        "mfe": [{"type": "checklist", "text": "Выход по плану, а не из страха отдать прибыль"}],
    }
    for i in out:
        i["text"] = re.sub(r"(\d)\.(\d)", r"\1,\2", i["text"])
        if i["kind"] != "neg":
            continue
        if i["id"] in sugg:
            i["suggest"] = sugg[i["id"]]
        elif i["id"] == "worst_session":
            bad = i["title"].split(": ", 1)[-1]
            i["suggest"] = [{"type": "rule", "kind": "sessions_only",
                             "params": {"sessions": [x for x in sessions_all if x != bad]}}]
        elif i["id"].startswith("emo_"):
            i["suggest"] = [{"type": "checklist", "text": f"Состояние не «{i['title'].split(': ', 1)[-1]}» - иначе пропускаю"}]
    from . import rules as rules_mod
    for i in out:
        for sg in i.get("suggest", []):
            sg["title"] = rules_mod.title_for(sg["kind"], sg["params"]) if sg["type"] == "rule" else sg["text"]
    out.sort(key=lambda x: -x["score"])
    return {"items": out, "total": len(trades)}


# ---------------------------------------------------------------------------- Монте-Карло
def montecarlo(rs, tpd, rules, risk_pct, paths=4000, horizon=None, seed=7):
    """rs - выборка R, tpd - выборка числа сделок в торговый день. Риск - % от стартового размера."""
    rnd = random.Random(seed)
    target = float(rules.get("profit_target_pct") or 0)
    daily = float(rules.get("max_daily_loss_pct") or 0)
    total = float(rules.get("max_loss_pct") or 0)
    min_days = int(rules.get("min_trading_days") or 0)
    trailing = rules.get("max_loss_type") == "trailing"
    lock = rules.get("trailing_lock", True)
    basis_initial = rules.get("daily_basis", "initial") == "initial"
    horizon = horizon or int(rules.get("max_days") or 0) or 60
    res = {"pass": 0, "fail_daily": 0, "fail_total": 0, "timeout": 0}
    days_to_pass, final, maxdd = [], [], []
    curves = [[] for _ in range(horizon + 1)]
    for _ in range(paths):
        bal, peak, floor = 0.0, 0.0, -total
        status, day = None, 0
        curves[0].append(0.0)
        worst = 0.0
        for day in range(1, horizon + 1):
            start = bal
            lim = daily if basis_initial else daily * (1 + start / 100)
            for _k in range(rnd.choice(tpd)):
                bal += rnd.choice(rs) * risk_pct
                worst = max(worst, peak - bal)
                if daily and start - bal >= lim - 1e-9:
                    status = "fail_daily"
                    break
                if total and bal <= floor + 1e-9:
                    status = "fail_total"
                    break
                if trailing:
                    peak = max(peak, bal)
                    floor = max(floor, peak - total)
                    if lock:
                        floor = min(floor, 0.0)
                else:
                    peak = max(peak, bal)
            curves[day].append(bal)
            if status:
                break
            if target and bal >= target and day >= min_days:
                status = "pass"
                days_to_pass.append(day)
                break
        for d2 in range(day + 1, horizon + 1):
            curves[d2].append(bal)
        res[status or "timeout"] += 1
        final.append(bal)
        maxdd.append(worst)
    pct = lambda arr, p: sorted(arr)[min(len(arr) - 1, int(p * len(arr)))] if arr else None
    return {
        "paths": paths, "horizon": horizon,
        **{k: round(100 * v / paths, 1) for k, v in res.items()},
        "median_days": statistics.median(days_to_pass) if days_to_pass else None,
        "final_p50": round(pct(final, .5), 2), "maxdd_p50": round(pct(maxdd, .5), 2), "maxdd_p90": round(pct(maxdd, .9), 2),
        "bands": [{"day": i, "p10": round(pct(c, .1), 2), "p50": round(pct(c, .5), 2), "p90": round(pct(c, .9), 2)}
                  for i, c in enumerate(curves) if c],
    }


def montecarlo_input(con, login, f, shift_h):
    trades = closed_trades(con, dict(f, login=login), shift_h)
    rs = [t["r"] for t in trades if t.get("r") is not None]
    shift = int(shift_h * 3600)
    per = defaultdict(int)
    for t in trades:
        per[datetime.fromtimestamp(t["open_time"] + shift, tz=timezone.utc).strftime("%Y-%m-%d")] += 1
    tpd = list(per.values()) or [1]
    trades = add_context(con, login, trades, shift_h)
    risks = [t["risk_pct"] for t in trades if t.get("risk_pct")]
    return rs, tpd, (round(statistics.median(risks), 2) if risks else None)


# ---------------------------------------------------------------------------- статистика рынка по сессиям
def market_stats(con, symbol, offset, sessions):
    """Диапазон Азии и его пробой в Лондоне, диапазоны по дням недели, гэпы понедельника. По часовым свечам MT5."""
    bars = con.execute("SELECT time, o, h, l, c FROM rates WHERE symbol=? AND tf='H1' ORDER BY time", (symbol,)).fetchall()
    if len(bars) < 24 * 40:
        return {"symbol": symbol, "bars": len(bars), "ready": False}
    sess = {s["name"]: s for s in sessions}
    asia, lon = sess.get("Азия") or sessions[0], sess.get("Лондон") or (sessions[1] if len(sessions) > 1 else sessions[0])
    days = defaultdict(list)
    for t, o, h, l, c in bars:
        u = t - (offset or 0)
        d = datetime.fromtimestamp(u, tz=timezone.utc)
        days[d.strftime("%Y-%m-%d")].append((d.hour, o, h, l, c, d.weekday()))
    inwin = lambda hr, s: (s["start"] <= hr < s["end"]) if s["start"] <= s["end"] else (hr >= s["start"] or hr < s["end"])
    res = {"n": 0, "hi": 0, "lo": 0, "both": 0, "none": 0, "hi_hold": 0, "lo_hold": 0, "ranges": []}
    wd = defaultdict(list)
    for d, bs in sorted(days.items()):
        if len(bs) < 18:
            continue
        wd[bs[0][5]].append(max(b[2] for b in bs) - min(b[3] for b in bs))
        a = [b for b in bs if inwin(b[0], asia)]
        ln = [b for b in bs if inwin(b[0], lon)]
        if len(a) < 4 or len(ln) < 3:
            continue
        ah, al = max(b[2] for b in a), min(b[3] for b in a)
        res["n"] += 1
        res["ranges"].append(ah - al)
        bh, bl = max(b[2] for b in ln) > ah, min(b[3] for b in ln) < al
        close = bs[-1][4]
        if bh and bl:
            res["both"] += 1
        elif bh:
            res["hi"] += 1
            res["hi_hold"] += close > ah
        elif bl:
            res["lo"] += 1
            res["lo_hold"] += close < al
        else:
            res["none"] += 1
    n = res["n"] or 1
    pct = lambda x, d=None: round(100 * x / (d or n), 1)
    names = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    # гэпы понедельника
    order = sorted(days.items())
    gaps, filled = [], 0
    for i in range(1, len(order)):
        d, bs = order[i]
        if bs[0][5] != 0:
            continue
        prev = order[i - 1][1]
        if prev[0][5] not in (4, 5, 6):
            continue
        fc, mo = prev[-1][4], bs[0][1]
        g = mo - fc
        if abs(g) <= 0:
            continue
        gaps.append(abs(g))
        if (g > 0 and min(b[3] for b in bs) <= fc) or (g < 0 and max(b[2] for b in bs) >= fc):
            filled += 1
    return {
        "symbol": symbol, "bars": len(bars), "ready": True, "days": res["n"],
        "first": order[0][0], "last": order[-1][0], "asia": asia, "london": lon,
        "asia_range_avg": round(statistics.mean(res["ranges"]), 5) if res["ranges"] else None,
        "asia_range_med": round(statistics.median(res["ranges"]), 5) if res["ranges"] else None,
        "break_hi": pct(res["hi"]), "break_lo": pct(res["lo"]), "break_both": pct(res["both"]), "break_none": pct(res["none"]),
        "hold_hi": pct(res["hi_hold"], res["hi"]) if res["hi"] else None, "hold_lo": pct(res["lo_hold"], res["lo"]) if res["lo"] else None,
        "n_hi": res["hi"], "n_lo": res["lo"],
        "weekday": [{"day": names[k], "n": len(v), "avg": round(statistics.mean(v), 5)} for k, v in sorted(wd.items()) if len(v) >= 5],
        "gaps": {"n": len(gaps), "avg": round(statistics.mean(gaps), 5) if gaps else None,
                 "filled": pct(filled, len(gaps)) if gaps else None},
    }


# ---------------------------------------------------------------------------- исполнение
def execution(con, login, f, shift_h, checklist_items):
    trades = add_context(con, login, closed_trades(con, dict(f, login=login), shift_h), shift_h)
    out = {"total": len(trades)}

    def cmp(a, b):
        A, B = _grp(a), _grp(b)
        verdict = "мало данных"
        if len(a) >= 5 and len(b) >= 5 and A["avg_r"] is not None and B["avg_r"] is not None:
            d = A["avg_r"] - B["avg_r"]
            verdict = "работает" if d >= 0.25 else "против" if d <= -0.25 else "не влияет"
        return A, B, verdict

    # пункты чек-листа: выполнен против не выполнен
    keys = list(checklist_items)
    for t in trades:
        for k in (t.get("checklist") or {}):
            if k not in keys:
                keys.append(k)
    items = []
    for k in keys:
        marked = [t for t in trades if k in (t.get("checklist") or {})]
        if not marked:
            continue
        yes = [t for t in marked if t["checklist"][k]]
        no = [t for t in marked if not t["checklist"][k]]
        A, B, v = cmp(yes, no)
        items.append({"item": k, "done": A, "not_done": B, "verdict": v,
                      "done_share": round(100 * len(yes) / len(marked), 1)})
    out["checklist"] = items

    # сон и энергия из плана до рынка
    rows = con.execute("SELECT date, premarket FROM day_journal WHERE login=0").fetchall()  # план дня общий
    import json as _json
    state = {}
    for d, pre in rows:
        try:
            pm = _json.loads(pre or "{}")
        except ValueError:
            pm = {}
        state[d] = pm
    for key in ("sleep", "energy", "mood"):
        groups = defaultdict(list)
        for t in trades:
            v = (state.get(t["day_key"]) or {}).get(key)
            if v:
                groups[int(v)].append(t)
        out[key] = [{"level": k, **_grp(v)} for k, v in sorted(groups.items())]
        out[key + "_n"] = sum(len(v) for v in groups.values())

    # сделки и общий план недели
    plans = load_plans(con)
    shift = int(shift_h * 3600)
    with_plan, against, neutral = [], [], []
    for t in trades:
        pb = plan_bias(plans, t["symbol"], t["open_time"], shift)
        if not pb or pb["bias"] is None:
            continue
        if pb["bias"] == 0:
            neutral.append(t)
        elif pb["bias"] == t["direction"]:
            with_plan.append(t)
        else:
            against.append(t)
    out["plan_align"] = {"with": _grp(with_plan) if with_plan else {"n": 0}, "against": _grp(against) if against else {"n": 0},
                         "neutral": _grp(neutral) if neutral else {"n": 0}}

    # стоп по MAE: насколько далеко уходили против прибыльных сделок
    win_mae = sorted(t["mae_r"] for t in trades if t["net"] > 0 and t.get("mae_r") is not None)
    los_mfe = [t["mfe_r"] for t in trades if t["net"] < 0 and t.get("mfe_r") is not None]
    if len(win_mae) >= 8:
        q = lambda p: win_mae[min(len(win_mae) - 1, int(p * len(win_mae)))]
        out["mae"] = {"n": len(win_mae), "p50": round(q(.5), 2), "p80": round(q(.8), 2), "p90": round(q(.9), 2),
                      "p95": round(q(.95), 2),
                      "kept": [{"stop": s, "share": round(100 * sum(1 for x in win_mae if x < s) / len(win_mae), 1)}
                               for s in (0.25, 0.5, 0.6, 0.75, 0.9, 1.0)]}
    else:
        out["mae"] = {"n": len(win_mae)}
    if len(los_mfe) >= 8:
        out["losers_mfe"] = {"n": len(los_mfe),
                             "reached": [{"r": s, "share": round(100 * sum(1 for x in los_mfe if x >= s) / len(los_mfe), 1)}
                                         for s in (0.5, 1.0, 1.5, 2.0)]}
    else:
        out["losers_mfe"] = {"n": len(los_mfe)}
    return out



# ---------------------------------------------------------------------------- общий план рынка на неделю
def _iso_week(ts, shift):
    d = datetime.fromtimestamp(ts + shift, tz=timezone.utc).date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def load_plans(con):
    import json as _json
    try:
        rows = con.execute("SELECT week, plan FROM week_plan").fetchall()
    except Exception:
        return {}
    out = {}
    for w, p in rows:
        try:
            out[w] = _json.loads(p or "{}")
        except ValueError:
            pass
    return out


def plan_bias(plans, symbol, ts, shift):
    """Направление из общего плана недели для инструмента сделки: 1 лонги, -1 шорты, 0 нейтрально, None - плана нет."""
    p = plans.get(_iso_week(ts, shift)) or {}
    sym = (symbol or "").upper()
    for it in p.get("instruments") or []:
        key = (it.get("symbol") or "").strip().upper()
        if key and (sym.startswith(key) or key.startswith(sym)):
            return {"bias": {"long": 1, "short": -1, "neutral": 0}.get(it.get("bias")), "symbol": it.get("symbol"),
                    "levels": it.get("levels") or "", "scenario": it.get("scenario") or ""}
    return None
