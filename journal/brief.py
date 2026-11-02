"""Утренняя сводка за 15 минут до окна ТС: что не готово к сессии.

Только чтение своих же данных журнала через его API (get(path) -> dict). Не торговый сигнал:
напоминание о собственном плане, чек-листе, заданиях месяца и сне.
"""
import time
from datetime import datetime, timezone


def window_start(state, rules, now=None):
    """Начало окна ТС сегодня (UTC-время в секундах): ранняя из сессий правила «Торговать только» или всех сессий."""
    sessions = state.get("sessions") or []
    names = next((r["params"].get("sessions") for r in rules if r.get("kind") == "sessions_only"), None) or []
    ses = [s for s in sessions if s.get("name") in names] or sessions
    if not ses:
        return None
    d = datetime.fromtimestamp(now or time.time(), tz=timezone.utc)
    base = datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()
    return int(base + min(s["start"] for s in ses) * 3600)


def build(get, now=None):
    """Строки сводки. Пусто - всё готово, уведомлять не о чем."""
    now = now or time.time()
    lines = []
    today = datetime.now().strftime("%Y-%m-%d")
    try:
        day = get(f"api/day?date={today}")
        pre = day.get("premarket") or {}
        if not (pre.get("plan") or pre.get("levels")):
            lines.append("план дня не заполнен")
        items = day.get("checklist_items") or []
        done = sum(1 for x in items if (pre.get("checks") or {}).get(x))
        if items and done < len(items):
            lines.append(f"чек-лист {done} из {len(items)}")
    except Exception:
        pass
    try:
        n = len(get("api/todo").get("unreviewed") or [])
        if n:
            lines.append(f"не разобрано сделок: {n}")
    except Exception:
        pass
    try:
        bad = [t for t in get("api/review/tasks").get("tasks") or [] if t.get("now", 0) > t.get("target", 0)]
        if bad:
            lines.append("нарушены задания месяца: " + ", ".join(t["title"].lower() for t in bad[:2]))
    except Exception:
        pass
    try:
        s = get("api/sleep")
        n = next((x for x in s.get("nights") or [] if x["date"] == today), None)
        nm = s.get("norm") or {}
        if n and nm.get("asleep") and n["asleep"] < nm["asleep"] - 60:
            lines.append(f"сон {n['asleep'] // 60} ч {n['asleep'] % 60:02d} мин - ниже нормы, половина риска")
    except Exception:
        pass
    return lines
