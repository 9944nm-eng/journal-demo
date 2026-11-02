"""Цели счёта в стиле проп-фирм: баланс, цель по прибыли, дневной и общий лимит убытка, торговые дни.

Ограничения расчёта:
- История эквити внутри дня в MT5 не хранится. Дневной минимум считается по балансу после каждой
  закрытой сделки; для текущего дня дополнительно учитывается плавающий результат на момент последней
  синхронизации. Проп-фирмы обычно считают лимиты по эквити в реальном времени, поэтому фактическая
  просадка внутри дня могла быть глубже, чем показывает журнал.
- Пополнения, снятия, кредит и бонусы (balance/credit/bonus) в результат не входят: кривая показывает
  стартовый размер счёта плюс торговый результат.
"""
import json
import time
from datetime import datetime, timezone

NON_TRADING = (2, 3, 6)  # balance, credit, bonus

DEFAULT_RULES = {
    "kind": "none", "phase": "", "account_size": 0, "start_date": "",
    "profit_target_pct": 10, "max_daily_loss_pct": 5, "daily_basis": "initial",
    "max_loss_pct": 10, "max_loss_type": "static", "trailing_lock": True,
    "min_trading_days": 4, "max_days": 0, "consistency_pct": 0, "day_shift_hours": 0,
}


def load_rules(con, login):
    r = con.execute("SELECT rules FROM account_rules WHERE login=?", (login,)).fetchone()
    rules = dict(DEFAULT_RULES)
    if r and r[0]:
        rules.update(json.loads(r[0]))
    return rules


def _m(x, signed=False):
    """Число в русском формате: 10 000,00."""
    s = f"{abs(x):,.2f}".replace(",", " ").replace(".", ",")
    sign = ("+" if x > 0 else "−" if x < 0 else "") if signed else ("−" if x < 0 else "")
    return sign + s


def _day(ts, shift):
    return datetime.fromtimestamp(ts + shift, tz=timezone.utc).strftime("%Y-%m-%d")


def progress(con, login, rules=None, display_shift=0, exclude=None):
    rules = rules or load_rules(con, login)
    orig_rules = rules
    if rules.get("kind") != "prop":  # обычный счёт: без цели и лимитов
        rules = dict(rules, profit_target_pct=0, max_daily_loss_pct=0, max_loss_pct=0,
                     min_trading_days=0, max_days=0, consistency_pct=0)
    acc = con.execute("SELECT * FROM accounts WHERE login=?", (login,)).fetchone()
    acc = dict(acc) if acc else {}
    deals = [dict(r) for r in con.execute(
        "SELECT time, time_msc, ticket, type, entry, profit, commission, swap, fee, position_id FROM deals "
        "WHERE login=? ORDER BY time_msc, ticket", (login,))]
    shift = int(float(rules.get("day_shift_hours") or 0) * 3600)

    start_ts = None
    if rules.get("start_date"):
        start_ts = int(datetime.strptime(rules["start_date"], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()) - shift
    trading = [d for d in deals if d["type"] not in NON_TRADING and not (exclude and d["position_id"] in exclude)]
    if start_ts is None:
        start_ts = trading[0]["time"] if trading else (deals[0]["time"] if deals else int(time.time()))

    deposits_before = sum(d["profit"] for d in deals if d["type"] == 2 and d["time"] <= start_ts + 86400)
    initial = float(rules.get("account_size") or 0) or deposits_before or float(acc.get("balance") or 0)

    # кривая баланса и дни
    bal, peak = initial, initial
    points = [{"time": start_ts - 60, "value": round(initial, 2)}]
    days, order = {}, []
    floor_static = initial * (1 - float(rules["max_loss_pct"] or 0) / 100)
    loss_amt = initial * float(rules["max_loss_pct"] or 0) / 100
    floor_series = []
    last_t = points[0]["time"]
    for d in trading:
        if d["time"] < start_ts:
            continue
        key = _day(d["time"], shift)
        if key not in days:
            days[key] = {"date": key, "start": bal, "min": bal, "end": bal, "pnl": 0.0, "entries": 0, "t0": d["time"]}
            order.append(key)
        delta = (d["profit"] or 0) + (d["commission"] or 0) + (d["swap"] or 0) + (d["fee"] or 0)
        if d["entry"] == 0 and d["type"] in (0, 1):
            days[key]["entries"] += 1
        if not delta:
            continue
        bal += delta
        x = days[key]
        x["pnl"] += delta
        x["end"] = bal
        x["min"] = min(x["min"], bal)
        t = d["time"]
        if t <= last_t:
            t = last_t + 1
        last_t = t
        points.append({"time": t, "value": round(bal, 2)})
        if rules["max_loss_type"] == "trailing":
            peak = max(peak, bal)
            fl = peak - loss_amt
            if rules.get("trailing_lock", True):
                fl = min(fl, initial)
            floor_series.append({"time": t, "value": round(fl, 2)})

    # текущий день: плавающий результат на момент последней синхронизации
    floating = float(acc.get("equity") or 0) - float(acc.get("balance") or 0) if acc else 0.0
    server_now = int(time.time()) + int(acc.get("server_offset") or 0)
    today = _day(server_now, shift)
    if today not in days:
        days[today] = {"date": today, "start": bal, "min": bal, "end": bal, "pnl": 0.0, "entries": 0, "t0": server_now}
        order.append(today)
    days[today]["min"] = min(days[today]["min"], bal + min(0.0, floating))
    equity_now = bal + floating

    # снимки средств, сделанные при синхронизациях: уточняют минимум дня
    offset = float(acc.get("balance") or bal) - bal  # пополнения/снятия вне торгового результата
    snaps = 0
    for t, eq in con.execute("SELECT time, equity FROM equity_snapshots WHERE login=? AND time>=?",
                             (login, start_ts - int(acc.get("server_offset") or 0))):
        key = _day(t + int(acc.get("server_offset") or 0), shift)
        if key in days and eq is not None:
            days[key]["min"] = min(days[key]["min"], eq - offset)
            snaps += 1

    dl_pct = float(rules["max_daily_loss_pct"] or 0)
    worst_daily, breach_day, daily_floor = 0.0, None, []
    for k in order:
        x = days[k]
        limit = (initial if rules["daily_basis"] == "initial" else x["start"]) * dl_pct / 100
        x["limit"] = round(limit, 2)
        x["floor"] = round(x["start"] - limit, 2)
        x["used"] = round(max(0.0, x["start"] - x["min"]), 2)
        x["breach"] = bool(dl_pct) and x["used"] > limit + 1e-6
        if x["used"] > worst_daily:
            worst_daily = x["used"]
        if x["breach"] and not breach_day:
            breach_day = k
        daily_floor.append({"time": x["t0"], "value": x["floor"]})

    # общий лимит
    min_bal = min([initial] + [days[k]["min"] for k in order])
    if rules["max_loss_type"] == "trailing":
        floor_now = floor_series[-1]["value"] if floor_series else initial - loss_amt
        # нарушение: баланс опускался ниже плавающего уровня в момент своего минимума
        breached_total = any(p["value"] < f["value"] - 1e-6 for p, f in zip(points[1:], floor_series))
        breached_total = breached_total or equity_now < floor_now - 1e-6
    else:
        floor_now = floor_static
        breached_total = bool(rules["max_loss_pct"]) and min_bal < floor_static - 1e-6
    loss_used = max(0.0, initial - min(min_bal, equity_now)) if rules["max_loss_type"] == "static" \
        else max(0.0, (floor_now + loss_amt) - min(bal, equity_now))

    profit = bal - initial
    target_pct = float(rules["profit_target_pct"] or 0)
    target_amt = initial * target_pct / 100
    trading_days = sum(1 for k in order if days[k]["entries"] > 0)
    first_day = datetime.strptime(order[0], "%Y-%m-%d") if order else datetime.utcnow()
    elapsed = (datetime.strptime(today, "%Y-%m-%d") - first_day).days + 1
    pos_days = [days[k]["pnl"] for k in order if days[k]["pnl"] > 0]
    best_day = max([days[k]["pnl"] for k in order], default=0.0)

    objectives = []
    if target_pct:
        objectives.append({
            "key": "target", "title": f"Цель по прибыли {target_pct:g}%",
            "value": round(profit, 2), "limit": round(target_amt, 2),
            "progress": max(0.0, min(1.0, profit / target_amt)) if target_amt else 0,
            "status": "passed" if profit >= target_amt else "pending",
            "text": f"{_m(profit, True)} из {_m(target_amt)}",
        })
    if dl_pct:
        lim_today = days[today]["limit"]
        objectives.append({
            "key": "daily", "title": f"Дневной лимит убытка {dl_pct:g}%",
            "value": days[today]["used"], "limit": lim_today,
            "progress": min(1.0, days[today]["used"] / lim_today) if lim_today else 0,
            "status": "fail" if breach_day else "ok",
            "text": (f"нарушен {breach_day}" if breach_day else
                     f"сегодня использовано {_m(days[today]['used'])} из {_m(lim_today)}, "
                     f"худший день {_m(worst_daily)}"),
        })
    if rules["max_loss_pct"]:
        objectives.append({
            "key": "total", "title": f"Общий лимит убытка {float(rules['max_loss_pct']):g}%"
                                     + (" (трейлинг)" if rules["max_loss_type"] == "trailing" else ""),
            "value": round(loss_used, 2), "limit": round(loss_amt, 2),
            "progress": min(1.0, loss_used / loss_amt) if loss_amt else 0,
            "status": "fail" if breached_total else "ok",
            "text": f"уровень {_m(floor_now)}, запас {_m(max(0.0, min(bal, equity_now) - floor_now))}",
        })
    if rules["min_trading_days"]:
        need = int(rules["min_trading_days"])
        objectives.append({
            "key": "days", "title": f"Минимум торговых дней: {need}",
            "value": trading_days, "limit": need, "progress": min(1.0, trading_days / need),
            "status": "passed" if trading_days >= need else "pending",
            "text": f"{trading_days} из {need}",
        })
    if float(rules.get("consistency_pct") or 0):
        cp = float(rules["consistency_pct"])
        share = (best_day / profit * 100) if profit > 0 else 0
        objectives.append({
            "key": "consistency", "title": f"Лучший день не больше {cp:g}% прибыли",
            "value": round(share, 1), "limit": cp, "progress": min(1.0, share / cp) if cp else 0,
            "status": ("pending" if profit <= 0 else "passed" if share <= cp else "fail_soft"),
            "text": f"лучший день {_m(best_day)} = {share:.1f}% прибыли" if profit > 0 else "прибыли пока нет",
        })
    if int(rules.get("max_days") or 0):
        md = int(rules["max_days"])
        objectives.append({
            "key": "deadline", "title": f"Срок: {md} календарных дней",
            "value": elapsed, "limit": md, "progress": min(1.0, elapsed / md),
            "status": "ok" if elapsed <= md else "fail", "text": f"идёт {elapsed}-й день",
        })

    hard_fail = any(o["status"] == "fail" for o in objectives)
    target_ok = all(o["status"] == "passed" for o in objectives if o["key"] in ("target", "days", "consistency"))
    if hard_fail:
        overall = "failed"
    elif target_pct and target_ok:
        overall = "passed"
    else:
        overall = "active"

    ds = int(display_shift * 3600)
    for p in points:
        p["time"] += ds
    for f in floor_series:
        f["time"] += ds
    for f in daily_floor:
        f["time"] += ds
    return {
        "rules": orig_rules, "initial": round(initial, 2), "balance": round(bal, 2),
        "equity": round(equity_now, 2), "floating": round(floating, 2), "profit": round(profit, 2),
        "profit_pct": round(100 * profit / initial, 2) if initial else None,
        "target_level": round(initial + target_amt, 2) if target_pct else None,
        "floor_level": round(floor_now, 2) if rules["max_loss_pct"] else None,
        "today_floor": days[today]["floor"] if dl_pct else None,
        "trading_days": trading_days, "elapsed_days": elapsed,
        "best_day": round(best_day, 2), "worst_day": round(min([days[k]["pnl"] for k in order], default=0.0), 2),
        "win_days": len(pos_days), "status": overall, "objectives": objectives,
        "points": points, "floor_series": floor_series, "daily_floor": daily_floor,
        "days": [{k2: (round(v, 2) if isinstance(v, float) else v) for k2, v in days[k].items() if k2 != "t0"}
                 for k in reversed(order)],
        "last_sync": acc.get("last_sync"), "snapshots": snaps,
        # следующий сброс дневного лимита (реальное время) и средства на начало дня
        "day_reset_at": int(((server_now + shift) // 86400 + 1) * 86400 - shift - int(acc.get("server_offset") or 0)),
        "day_start": round(days[today]["start"], 2), "today_used": days[today].get("used"),
        "today_limit": days[today].get("limit"),
    }
