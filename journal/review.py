"""Ежемесячный разбор: обслуживание журнала, самопроверка и жёсткий разбор поведения трейдера.

Запускается сам при первом запуске журнала в новом месяце (за прошлый месяц), можно запустить вручную
за текущий месяц. Разбор не хвалит: ищет повторяющиеся ошибки поведения, считает их цену в R и
превращает самые дорогие в задания на следующий месяц. Задания проверяются каждый день по сделкам.

Удаление файлов - только в корзину Windows (восстановимо). Торговых функций и сетевых отправок нет.
"""
import json
import os
import re
import statistics
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS month_reviews (month TEXT PRIMARY KEY, created INTEGER, data TEXT, seen INTEGER DEFAULT 0);
"""
def _pl(n, one, few, many):
    m10, m100 = n % 10, n % 100
    return one if m10 == 1 and m100 != 11 else few if 2 <= m10 <= 4 and not 12 <= m100 <= 14 else many


def fr(x, sign=True):
    """Число R по-русски: +1,25R."""
    return (f"{x:+.2f}" if sign else f"{x:.2f}").replace(".", ",") + "R"


MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]


# ------------------------------------------------------------------ корзина Windows
def to_recycle_bin(paths):
    """Переместить файлы в корзину (SHFileOperation с FOF_ALLOWUNDO). Возвращает число перемещённых."""
    paths = [str(p) for p in paths if Path(p).exists()]
    if not paths:
        return 0
    try:
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                        ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                        ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]
        FO_DELETE, FOF_SILENT, FOF_NOCONFIRMATION, FOF_ALLOWUNDO, FOF_NOERRORUI = 3, 4, 16, 64, 1024
        op = SHFILEOPSTRUCTW(None, FO_DELETE, "\0".join(paths) + "\0\0", None,
                             FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, False, None, None)
        res = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        return 0 if res else sum(1 for p in paths if not Path(p).exists())
    except Exception:
        return 0


# ------------------------------------------------------------------ обслуживание
def maintenance(con, cfg, sleep_folder=None):
    """Чистка: старые записи журнала синхронизации, разобранные файлы сна, лишние копии «перед обновлением»,
    старый лог, неиспользуемая демо-база. Всё удаляемое с диска - в корзину."""
    done = []
    now = time.time()
    n = con.execute("DELETE FROM sync_log WHERE started < ? AND id NOT IN (SELECT id FROM sync_log ORDER BY id DESC LIMIT 200)",
                    (now - 90 * 86400,)).rowcount
    if n:
        done.append(f"Журнал синхронизации: удалено {n} записей старше 90 дней")
    data = Path(cfg["db_path"]).parent
    # копии «перед обновлением»: оставляем три последние
    pre = sorted(data.glob("backups/pre-update-*.db"), key=lambda p: p.stat().st_mtime)
    if len(pre) > 3:
        k = to_recycle_bin(pre[:-3])
        if k:
            done.append(f"Резервные копии «перед обновлением»: {k} старых в корзину, оставлены 3 последние")
    old_log = data / "journal.old.log"
    if old_log.exists() and now - old_log.stat().st_mtime > 30 * 86400 and to_recycle_bin([old_log]):
        done.append("Старый лог фоновой работы - в корзину")
    if cfg.get("mode") != "demo":
        demo = [p for p in data.glob("demo.*") if now - p.stat().st_mtime > 30 * 86400]
        if demo and to_recycle_bin(demo):
            done.append("Демо-база не используется больше месяца - в корзину")
    # файлы сна: всё уже в базе; разобранные без ошибок и старше 7 дней не нужны
    if sleep_folder and Path(sleep_folder).is_dir():
        olds = []
        for path, imported, err in con.execute("SELECT path, imported, error FROM sleep_files").fetchall():
            p = Path(path)
            if not p.exists():
                con.execute("DELETE FROM sleep_files WHERE path=?", (path,))
            elif not err and p.suffix.lower() in (".txt", ".csv") and now - p.stat().st_mtime > 7 * 86400:
                olds.append(p)
        if olds:
            k = to_recycle_bin(olds)
            for p in olds:
                if not p.exists():
                    con.execute("DELETE FROM sleep_files WHERE path=?", (str(p),))
            if k:
                done.append(f"Файлы сна: {k} разобранных файлов старше недели - в корзину (данные остались в журнале)")
    con.execute("PRAGMA optimize")
    con.commit()
    return done


# ------------------------------------------------------------------ самопроверка
def selfcheck(con, cfg, root, sleep_state=None):
    """Работает ли всё, как нужно. Каждый пункт: ok / warn / bad, что не так и что сделать."""
    out = []
    add = lambda st, title, text="": out.append({"status": st, "title": title, "text": text})
    now = time.time()
    r = con.execute("PRAGMA quick_check").fetchone()[0]
    add("ok" if r == "ok" else "bad", "Целостность базы", "" if r == "ok" else f"SQLite: {r}. Восстановите из data\\backups.")
    weekday = datetime.now().weekday() < 5
    for lg, last, off in con.execute("SELECT login, last_sync, server_offset FROM accounts").fetchall():
        age = (now - (last or 0)) / 3600
        st = "ok" if age < 30 or not weekday else "warn" if age < 72 else "bad"
        add(st, f"Синхронизация счёта {lg}", f"последняя {round(age)} ч назад" + ("" if st == "ok" else ": проверьте терминал и «Синхронизация»"))
        if off is not None and (off % 3600 or abs(off) > 14 * 3600):
            add("bad", f"Время сервера счёта {lg}", f"сдвиг {off} с не похож на часовой пояс брокера")
    offs = {o for (o,) in con.execute("SELECT server_offset FROM accounts WHERE server_offset IS NOT NULL")}
    if len(offs) > 1:
        add("warn", "Время серверов счетов различается", f"сдвиги {sorted(offs)}: если брокеры в одном поясе, один из сдвигов ошибочный")
    # проблема сейчас: последние три попытки счёта подряд с ошибкой; старый эпизод не должен висеть месяц
    for (lg,) in con.execute("SELECT DISTINCT login FROM sync_log WHERE started > ?", (now - 7 * 86400,)).fetchall():
        last = con.execute("SELECT status, message FROM sync_log WHERE " + ("login IS NULL" if lg is None else "login=?")
                           + " ORDER BY id DESC LIMIT 3", () if lg is None else (lg,)).fetchall()
        recent = con.execute("SELECT MAX(started) FROM sync_log WHERE " + ("login IS NULL" if lg is None else "login=?"),
                             () if lg is None else (lg,)).fetchone()[0] or 0
        if len(last) == 3 and all(s == "error" for s, _ in last) and now - recent < 86400:
            add("bad", f"Синхронизация {'счёта из config.json' if lg is None else 'счёта ' + str(lg)} не проходит", (last[0][1] or "")[:160])
    errs = con.execute("SELECT COUNT(*) FROM sync_log WHERE status='error' AND started > ?", (now - 7 * 86400,)).fetchone()[0]
    tot = con.execute("SELECT COUNT(*) FROM sync_log WHERE started > ?", (now - 7 * 86400,)).fetchone()[0]
    # закончившийся эпизод (ошибок нет сутки) не держит предупреждение всю неделю
    last_err = con.execute("SELECT MAX(started) FROM sync_log WHERE status='error' AND started > ?", (now - 7 * 86400,)).fetchone()[0]
    resolved = last_err and now - last_err > 86400
    add("ok" if errs <= max(3, tot * 0.05) or resolved else "warn", "Ошибки синхронизации за 7 дней",
        f"{errs} из {tot}" + (f", последняя {datetime.fromtimestamp(last_err):%d.%m %H:%M}, после неё без ошибок" if resolved and errs > max(3, tot * 0.05) else ""))
    try:
        nl = con.execute("SELECT MAX(time) FROM news").fetchone()[0] or 0
        add("ok" if nl > now - 2 * 86400 else "warn", "Календарь новостей", "актуален" if nl > now - 2 * 86400 else "не обновлялся: проверьте интернет")
    except Exception:
        pass
    try:
        cot = con.execute("SELECT MAX(date) FROM cot").fetchone()[0]
        fresh = cot and (datetime.now() - datetime.strptime(cot, "%Y-%m-%d")).days <= 14
        add("ok" if fresh else "warn", "Данные COT", f"последний отчёт {cot}" if cot else "нет данных")
    except Exception:
        pass
    from . import settings as appset
    from . import sync as sync_mod
    bcfg = appset.get(con, "backup")
    every = float(bcfg.get("every_hours") or 24) * 3600
    bks = sorted(Path(cfg["db_path"]).parent.glob("backups/journal-*.db"), key=lambda p: p.stat().st_mtime)
    if not bcfg.get("enabled"):
        add("warn", "Резервная копия", "автоматические копии выключены в настройках")
    else:
        add("ok" if bks and now - bks[-1].stat().st_mtime < every * 1.5 else "warn", "Резервная копия",
            (f"последняя {datetime.fromtimestamp(bks[-1].stat().st_mtime):%d.%m %H:%M}, по настройке раз в {round(every / 3600)} ч" if bks else "копий нет"))
    tick = sync_mod.PROGRESS.get("bg_tick")
    if tick is not None:
        age = now - tick
        add("ok" if age < 300 else "bad", "Фоновый цикл (копии, расписание, новости)",
            "работает" if age < 300 else f"не отвечает {round(age / 60)} мин, этап: {sync_mod.PROGRESS.get('bg_stage')}. Перезапустите журнал.")
    if sleep_state is not None:
        if sleep_state.get("enabled"):
            ns = sleep_state.get("nights") or []
            last = ns[-1]["date"] if ns else None
            ok = last and (datetime.now() - datetime.strptime(last, "%Y-%m-%d")).days <= 2
            add("ok" if ok else "warn", "Сон из Apple Watch", f"последняя ночь {last}" if last else "данных нет: проверьте автоматизацию на iPhone")
    # правила проп-фирм в коде: только чтение MT5, сервер на 127.0.0.1
    bad = []
    # шаблон собран из частей, чтобы этот файл сам не попадал под проверку
    forbidden = re.compile(r"\.(" + "|".join(["order_" + "send", "order_" + "check", "symbol_" + "select"]) + r")\(|TRADE_" + "ACTION_")
    for f in Path(root, "journal").glob("*.py"):
        if forbidden.search(f.read_text(encoding="utf-8", errors="ignore")):
            bad.append(f.name)
    host = cfg.get("server", {}).get("host")
    add("ok" if not bad and host == "127.0.0.1" else "bad", "Правила проп-фирм в коде",
        "только чтение MT5, сервер только на 127.0.0.1" if not bad and host == "127.0.0.1" else f"проверить: {', '.join(bad) or 'host ' + str(host)}")
    return out


# ------------------------------------------------------------------ разбор поведения
def _grp(ts):
    rs = [t["r"] for t in ts if t.get("r") is not None]
    return {"n": len(ts), "sum_r": round(sum(rs), 2), "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
            "net": round(sum(t["net"] for t in ts), 2), "win_rate": round(100 * sum(1 for t in ts if t["net"] > 0) / len(ts)) if ts else None}


def month_bounds(month):
    y, m = map(int, month.split("-"))
    a = datetime(y, m, 1).timestamp()
    b = datetime(y + (m == 12), m % 12 + 1, 1).timestamp()
    return int(a), int(b)


def prev_month(month):
    y, m = map(int, month.split("-"))
    return f"{y - (m == 1)}-{(m - 2) % 12 + 1:02d}"


def collect(con, shift_h, a, b, vio):
    """Закрытые сделки всех счетов за период с контекстом (номер в дне, после убытка, риск, сон) и нарушениями ТС."""
    from . import analysis
    out = []
    for (lg,) in con.execute("SELECT login FROM accounts").fetchall():
        ts = analysis.add_context(con, lg, analysis.closed_trades(con, {"login": lg, "date_from": a - 86400, "date_to": b}, shift_h), shift_h)
        for t in ts:
            if a <= t["open_time"] - int(t.get("server_offset") or 0) < b:
                t["violations"] = vio.get((lg, t["position_id"]), [])
                out.append(t)
    # пары одной идеи на разных счетах - чтобы видеть, где выход разошёлся
    from . import twins
    tw = twins.groups(con, out)
    for t in out:
        t["twin_keys"] = tw.get((t["login"], t["position_id"]), [])
    return out


# задания, которые можно поставить на месяц, даже если в прошлом месяце паттерн не встречался
EXIT_PLAN_SINCE = int(datetime(2026, 11, 2).timestamp())  # с этого дня журнал просит план выхода
TASK_TEXT = {
    "round_trip": ("Прибыль превращается в ноль или убыток", "План выхода записан до входа: на +1,5R - частичная фиксация, остаток по плану. Сделка, дававшая +1,25R, не закрывается в минус."),
    "reversal": ("Переворот после стопа", "После стопа на инструменте 60 минут ничего в обратную сторону на нём же."),
    "late_review": ("Разбор позже суток", "Каждая сделка разобрана в тот же день: сетап из плейбука и отметка «по плану»."),
    "no_exit_plan": ("Нет плана выхода", "У каждой сделки до или сразу после входа записаны частичная фиксация и условие ручного выхода."),
    "twin_split": ("Одна идея - разный выход", "Одна идея на двух счетах ведётся одинаково: те же уровни выхода."),
    "late_window": ("Позднее окно без A-сетапа", "После 16:00 - только A-сетап и половина риска."),
}


def patterns(trades, rules, prev_trades, min_all=None):
    """Повторяющиеся ошибки поведения. У каждой: цена в R, сравнение с прошлым месяцем, задание."""
    res = []
    rest = lambda fn: [t for t in trades if not fn(t)]

    def add(pid, title, bad, fn_text, task, metric, target, min_n=2, compare_rest=True):
        if len(bad) < (min_all if min_all is not None else min_n):
            return
        g = _grp(bad)
        other = _grp([t for t in trades if t not in bad]) if compare_rest else None
        cost = g["sum_r"] - (other["avg_r"] or 0) * g["n"] if other and other["avg_r"] is not None else g["sum_r"]
        prev_n = len([t for t in prev_trades if metric(t)]) if prev_trades else None
        res.append({"id": pid, "title": title, "n": g["n"], "share": round(100 * g["n"] / len(trades)), "sum_r": g["sum_r"],
                    "avg_r": g["avg_r"], "net": g["net"], "other_avg_r": other["avg_r"] if other else None,
                    "cost_r": round(min(0, cost), 2), "prev_n": prev_n, "text": fn_text(g, other), "task": task, "target": target,
                    "ids": [[t["login"], t["position_id"]] for t in bad]})

    f = lambda t: t.get("mins_after_loss") is not None and t["mins_after_loss"] <= 15
    add("revenge", "Отыгрыш после убытка", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'вход', 'входа', 'входов')} в первые 15 минут после убыточной сделки: итог {fr(g['sum_r'])}, в среднем {fr(g['avg_r'])} против {fr(o['avg_r'])} у остальных. " + ("Это не анализ, а попытка вернуть деньги." if (g['avg_r'] or 0) < (o['avg_r'] or 0) - 0.1 else "Пока это не стоило денег, но решение принято на эмоции, а не по плану."),
        "После убыточной сделки - пауза 30 минут. Ни одного входа раньше.", f, 0)
    f = lambda t: t.get("loss_streak_today", 0) >= 2
    add("tilt", "Торговля после двух убытков подряд", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка открыта', 'сделки открыты', 'сделок открыты')} после двух убытков подряд за день: {fr(g['sum_r'])}. После второго стопа ты продолжаешь, хотя решения уже хуже.",
        "Два убытка подряд - день закрыт. Терминал закрывается, разбор, никаких входов.", f, 0)
    # лимит сделок - из ТС того счёта, на котором сделка (rules: {login: [правила]} или общий список)
    def lim_of(t):
        rs = rules.get(t["login"], []) if isinstance(rules, dict) else rules
        mt = next((r for r in rs if r.get("kind") == "max_trades_day"), None)
        return mt["params"]["n"] if mt else 3
    lims = sorted({lim_of(t) for t in trades}) or [3]
    lim_txt = "/".join(map(str, lims))
    f = lambda t: t.get("nth_today", 0) > lim_of(t)
    add("overtrade", f"Сделки сверх лимита ТС ({lim_txt} в день)", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка', 'сделки', 'сделок')} сверх лимита ТС ({lim_txt} в день): {fr(g['sum_r'])}. Лимит записан, но ты его не держишь.",
        f"Не больше {lim_txt} сделок в день на счёт. Достиг лимита - терминал закрыт до завтра.", f, 0)
    f = lambda t: bool(t.get("violations"))
    add("violations", "Нарушения своей ТС", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} из {len(trades)} сделок ({round(100 * g['n'] / len(trades))}%) нарушают твою же ТС: итог {fr(g['sum_r'])}, в среднем {fr(g['avg_r'])} против {fr(o['avg_r'])} у сделок по правилам. Ты торгуешь не свою систему.",
        "Ноль нарушений ТС. Перед входом - чек-лист на «Сегодня», каждый пункт.", f, 0, min_n=1)
    f = lambda t: t.get("r") is not None and t["r"] < -1.15
    add("big_loss", "Убыток больше запланированного стопа", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка закрыта', 'сделки закрыты', 'сделок закрыты')} хуже −1R (в среднем {fr(g['avg_r'])}): стоп отодвигался, не стоял или исполнялся с проскальзыванием на новостях. Риск, который ты не планировал.",
        "Стоп ставится вместе с входом и никогда не отодвигается дальше.", f, 0, min_n=1, compare_rest=False)
    f = lambda t: t.get("r") is not None and 0 < t["r"] < 1 and (t.get("mfe_r") or 0) >= 1.5 and t.get("close_reason") not in (4, 5)
    add("cut_winners", "Срезаешь прибыль", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'прибыльная сделка закрыта', 'прибыльные сделки закрыты', 'прибыльных сделок закрыты')} вручную меньше чем на 1R, хотя рынок давал 1,5R и больше. Ты боишься отдать прибыль и сам её не берёшь.",
        "Прибыльную сделку закрывает тейк или трейлинг по плану, не рука. Ручной выход только по заранее записанному условию.", f, 0, compare_rest=False)
    # сделка была в плюсе на 1,25R и больше, а закрылась в ноль или в минус: плана выхода нет
    f = lambda t: t.get("r") is not None and t["r"] <= 0.1 and (t.get("mfe_r") or 0) >= 1.25
    add("round_trip", "Прибыль превращается в ноль или убыток", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка была', 'сделки были', 'сделок были')} в плюсе на 1,25R и больше, а закрылись в ноль или в минус: итог {fr(g['sum_r'])}. Рынок давал прибыль, плана, как её забрать, не было.",
        "План выхода записан до входа: на +1,5R - частичная фиксация, остаток по плану. Сделка, дававшая +1,25R, не закрывается в минус.", f, 0, compare_rest=False)
    wins =[t for t in trades if t["net"] > 0 and t.get("duration")]
    losses = [t for t in trades if t["net"] < 0 and t.get("duration")]
    if len(wins) >= 4 and len(losses) >= 4:
        mw, ml = statistics.median(t["duration"] for t in wins), statistics.median(t["duration"] for t in losses)
        if ml > mw * 1.5:
            f = lambda t: t["net"] < 0 and t.get("duration", 0) > mw
            add("hold_losers", "Держишь убытки дольше прибыли", [t for t in losses if t["duration"] > mw],
                lambda g, o, mw=mw, ml=ml: f"Убыточные сделки ты держишь в {ml / mw:.1f} раза дольше прибыльных (медиана {round(ml / 60)} мин против {round(mw / 60)} мин): ждёшь, что «развернётся».",
                "Если сделка не пошла в твою сторону за обычное время прибыльной - выход, не надежда.", f, 0, compare_rest=False)
    al = [t["risk_pct"] for t in trades if t.get("after") == "loss" and t.get("risk_pct")]
    aw = [t["risk_pct"] for t in trades if t.get("after") == "win" and t.get("risk_pct")]
    if len(al) >= 3 and len(aw) >= 3 and statistics.mean(al) > statistics.mean(aw) * 1.2:
        f = lambda t: t.get("after") == "loss" and (t.get("risk_pct") or 0) > statistics.mean(aw) * 1.2
        add("risk_up", "Поднимаешь риск после убытка", [t for t in trades if f(t)],
            lambda g, o, al=al, aw=aw: f"После убытка риск в среднем {statistics.mean(al):.2f}% против {statistics.mean(aw):.2f}% после прибыли. Это мартингейл: так челленджи и сливаются.",
            "Риск на сделку фиксированный и не зависит от прошлой сделки.", f, 0, min_n=1, compare_rest=False)
    f = lambda t: t.get("followed_plan") == 0
    add("off_plan", "Сделки вне плана", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделку', 'сделки', 'сделок')} ты сам отметил «не по плану»: {fr(g['sum_r'])}. Ты знал, что нарушаешь, и всё равно вошёл.",
        "Сделка вне плана не открывается. Нет плана на инструмент - нет сделки.", f, 0, min_n=1)
    f = lambda t: bool(t.get("sleep_short"))
    add("sleep", "Торговля после короткой ночи", [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка', 'сделки', 'сделок')} после ночи на час короче нормы: в среднем {fr(g['avg_r'])} против {fr(o['avg_r'])}.",
        "После короткой ночи - половина риска и не больше одной сделки.", f, 0)
    # день, когда отдал прибыль: пик дня в R и итог дня
    days = defaultdict(list)
    for t in sorted(trades, key=lambda t: t["close_time"]):
        days[(t["login"], t.get("day_key"))].append(t)
    gave, given, ndays = [], 0.0, 0
    for ts in days.values():
        eq = peak = 0.0
        after_peak = []
        for t in ts:
            eq += t.get("r") or 0
            if eq > peak:
                peak, after_peak = eq, []
            else:
                after_peak.append(t)
        if peak >= 1 and eq <= peak / 2:
            ndays += 1
            given += peak - eq
            gave += after_peak
    if ndays:
        res.append({"id": "give_back", "title": "Отдаёшь прибыль дня", "n": ndays, "share": round(100 * ndays / max(1, len(days))),
                    "sum_r": round(-given, 2), "avg_r": None, "net": round(sum(t["net"] for t in gave), 2), "other_avg_r": None,
                    "cost_r": round(-given, 2), "prev_n": None, "unit": "day",
                    "text": f"В {ndays} {_pl(ndays, 'день', 'дня', 'дней')} ты был в плюсе на 1R и больше, а закрыл день, отдав больше половины: всего {fr(given, False)} отдано рынку. Хороший день - не повод торговать дальше.",
                    "task": "День в плюсе на 2R - торговля закончена. Плюс на 1R - следующая сделка только A-сетап.", "target": 0,
                    "ids": [[t["login"], t["position_id"]] for t in gave]})
    # разбор позже суток: урок забывается, а журнал слепнет
    now = time.time()
    rev = lambda t: bool(t.get("setup") or t.get("grade") or (t.get("entry_reason") or "").strip() or t.get("followed_plan") is not None)
    f = lambda t: (t.get("close_time") or now) < now - 86400 - int(t.get("server_offset") or 0) and (
        not rev(t) or (t.get("note_updated") or 0) - (t["close_time"] - int(t.get("server_offset") or 0)) > 86400)
    add("late_review", TASK_TEXT["late_review"][0], [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка разобрана', 'сделки разобраны', 'сделок разобраны')} позже суток или не разобраны вовсе. Без сетапа и отметки «по плану» журнал не может сказать, какой сетап тебя кормит.",
        TASK_TEXT["late_review"][1], f, 0, min_n=1, compare_rest=False)
    f = lambda t: t.get("reversal_min") is not None and t["reversal_min"] < 60
    add("reversal", TASK_TEXT["reversal"][0], [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'раз', 'раза', 'раз')} ты развернулся на том же инструменте меньше чем через час после стопа: итог {fr(g['sum_r'])}. Это не новый сетап, а попытка вернуть стоп.",
        TASK_TEXT["reversal"][1], f, 0, min_n=1, compare_rest=False)
    f = lambda t: t["open_time"] - int(t.get("server_offset") or 0) >= EXIT_PLAN_SINCE and not (t.get("exit_partial") or t.get("exit_manual"))
    add("no_exit_plan", TASK_TEXT["no_exit_plan"][0], [t for t in trades if f(t)],
        lambda g, o: f"{g['n']} {_pl(g['n'], 'сделка открыта', 'сделки открыты', 'сделок открыты')} без записанного плана выхода: итог {fr(g['sum_r'])}. Выход решается по ходу, отсюда и сделки, где прибыль ушла в минус.",
        TASK_TEXT["no_exit_plan"][1], f, 0, min_n=1, compare_rest=False)
    by_key = {(t["login"], t["position_id"]): t for t in trades}
    split = []
    for t in trades:
        for k in t.get("twin_keys") or []:
            o2 = by_key.get(tuple(k))
            if o2 and t.get("r") is not None and o2.get("r") is not None and abs(t["r"] - o2["r"]) >= 1 and t not in split:
                split.append(t)
    if split:
        ideas = len(split) // 2 or 1
        res.append({"id": "twin_split", "title": TASK_TEXT["twin_split"][0], "n": ideas, "share": None, "sum_r": None, "avg_r": None,
                    "net": None, "other_avg_r": None, "cost_r": 0, "prev_n": None, "unit": "idea",
                    "text": f"В {ideas} {_pl(ideas, 'идее', 'идеях', 'идеях')} одна и та же сделка на двух счетах закрылась с разницей в 1R и больше. Значит, правила выхода нет: на одном счёте держишь, на другом выходишь по настроению.",
                    "task": TASK_TEXT["twin_split"][1], "target": 0, "ids": [[t["login"], t["position_id"]] for t in split]})
    res.sort(key=lambda p: (p["cost_r"], -p["n"]))
    return res


def build(con, cfg, shift_h, month, vio, rules, sleep_state=None, root=None, do_maintenance=False):
    a, b = month_bounds(month)
    pa, pb = month_bounds(prev_month(month))
    trades = collect(con, shift_h, a, b, vio)
    prev = collect(con, shift_h, pa, pb, vio)
    y, m = map(int, month.split("-"))
    rep = {"month": month, "title": f"{MONTHS[m - 1].capitalize()} {y}", "created": int(time.time()),
           "partial": time.time() < b, "trades": len(trades)}
    summ = lambda ts: dict(_grp(ts), vio=sum(1 for t in ts if t.get("violations")),
                           reviewed=sum(1 for t in ts if t.get("setup") or t.get("grade") or t.get("entry_reason") or t.get("followed_plan") is not None),
                           days=len({(t.get("day_key")) for t in ts}))
    rep["now"], rep["prev"] = summ(trades), summ(prev) if prev else None
    rep["patterns"] = patterns(trades, rules, prev) if len(trades) >= 5 else []
    # вердикт без комплиментов: что стоит денег и что изменилось
    s = rep["now"]
    lines = []
    if len(trades) < 5:
        lines.append(f"За месяц {len(trades)} {'сделка' if len(trades) == 1 else 'сделок'}: для выводов о поведении мало. Мало сделок - это не дисциплина, если в плане их было больше.")
    else:
        # цена ошибок по объединению сделок: одна сделка может попасть в несколько паттернов, считаем её один раз
        bad_ids = {tuple(i) for p in rep["patterns"] if p["cost_r"] < 0 for i in p["ids"]}
        bad = [t for t in trades if (t["login"], t["position_id"]) in bad_ids]
        good = [t for t in trades if (t["login"], t["position_id"]) not in bad_ids]
        gb, gg = _grp(bad), _grp(good)
        # с чем сравнивать: среднее по всем сделкам месяца (не по «хорошим» - их мало, и сравнение завышает цену)
        base_avg = max(0, s["avg_r"] or 0)
        cost = min(0, gb["sum_r"] - base_avg * gb["n"]) if bad else 0
        lines.append(f"Итог {fr(s['sum_r'])} за {s['n']} {_pl(s['n'], 'сделку', 'сделки', 'сделок')}. Сделки с ошибками поведения ({gb['n']} из {s['n']}) обошлись примерно в {fr(abs(cost), False)}: если бы они шли как средняя сделка месяца, итог был бы {fr(s['sum_r'] - cost)}." if cost < 0
                     else f"Итог {fr(s['sum_r'])} за {s['n']} {_pl(s['n'], 'сделку', 'сделки', 'сделок')}. Явных дорогих ошибок поведения не найдено - но выборка маленькая, держи планку.")
        if s["vio"]:
            lines.append(f"Нарушений ТС: {s['vio']} из {s['n']}. Пока это не ноль, у тебя нет системы - есть настроение.")
        if s["reviewed"] < s["n"]:
            lines.append(f"Разобрано {s['reviewed']} из {s['n']} сделок. Неразобранная сделка - потерянный урок.")
        if rep["prev"] and rep["prev"]["n"]:
            p = rep["prev"]
            if s["vio"] / s["n"] > p["vio"] / p["n"]:
                lines.append("Доля нарушений выросла по сравнению с прошлым месяцем.")
    rep["verdict"] = lines
    rep["tasks"] = [{"id": p["id"], "title": p["title"], "task": p["task"], "target": p["target"], "base": p["n"]} for p in rep["patterns"][:3]]
    if root:
        rep["health"] = selfcheck(con, cfg, root, sleep_state)
    if do_maintenance:
        rep["maintenance"] = maintenance(con, cfg, (sleep_state or {}).get("folder"))
    return rep


def task_progress(con, shift_h, tasks, vio, rules):
    """Сколько раз за текущий месяц нарушено каждое задание (по сделкам, без ручного ввода)."""
    month = datetime.now().strftime("%Y-%m")
    a, b = month_bounds(month)
    trades = collect(con, shift_h, a, b, vio)
    pats = {p["id"]: p for p in patterns(trades, rules, [], min_all=1)} if trades else {}
    return [dict(t, now=pats.get(t["id"], {}).get("n", 0)) for t in tasks]


def add_tasks(con, ids):
    """Добавить задания в текущий разбор (последний по месяцу): из паттернов или из TASK_TEXT."""
    row = con.execute("SELECT month, data FROM month_reviews ORDER BY month DESC LIMIT 1").fetchone()
    if not row:
        return None
    rep = json.loads(row[1])
    have = {t["id"] for t in rep.get("tasks") or []}
    pats = {p["id"]: p for p in rep.get("patterns") or []}
    for i in ids:
        if i in have:
            continue
        p = pats.get(i)
        title, task = (p["title"], p["task"]) if p else TASK_TEXT.get(i, (None, None))
        if not task:
            continue
        rep.setdefault("tasks", []).append({"id": i, "title": title, "task": task, "target": 0, "base": p["n"] if p else 0})
    con.execute("UPDATE month_reviews SET data=? WHERE month=?", (json.dumps(rep, ensure_ascii=False), row[0]))
    con.commit()
    return rep["tasks"]


def register(app, cfg, con, db_lock, shift_h, root, all_vio, rules_fn, sleep_fn):
    con.executescript(SCHEMA)

    def make(month, maint):
        vio = all_vio()
        with db_lock:
            rep = build(con, cfg, shift_h, month, vio, rules_fn(), sleep_fn(), root, maint)
            con.execute("INSERT OR REPLACE INTO month_reviews(month, created, data, seen) VALUES (?,?,?,0)",
                        (month, rep["created"], json.dumps(rep, ensure_ascii=False)))
            con.commit()
        return rep

    def auto():  # раз в 6 часов: если за прошлый месяц разбора нет - сделать вместе с обслуживанием
        import threading
        def loop():
            time.sleep(90)
            while True:
                try:
                    last = prev_month(datetime.now().strftime("%Y-%m"))
                    with db_lock:
                        have = con.execute("SELECT 1 FROM month_reviews WHERE month=?", (last,)).fetchone()
                    if not have:
                        make(last, cfg.get("auto_maintenance", True))
                except Exception as e:
                    print(f"Месячный разбор: {e}")
                time.sleep(6 * 3600)
        threading.Thread(target=loop, daemon=True).start()
    auto()

    from flask import jsonify, request

    @app.get("/api/review/month")
    def review_get():
        month = request.args.get("month")
        with db_lock:
            rows = con.execute("SELECT month, data, seen FROM month_reviews ORDER BY month DESC").fetchall()
        months = [r[0] for r in rows]
        row = next((r for r in rows if r[0] == month), rows[0] if rows else None)
        rep = json.loads(row[1]) if row else None
        if rep and rep.get("tasks"):
            try:
                rep["progress"] = task_progress(con, shift_h, rep["tasks"], all_vio(), rules_fn())
            except Exception:
                pass
        return jsonify({"months": months, "review": rep, "unseen": [r[0] for r in rows if not r[2]]})

    @app.post("/api/review/month")
    def review_run():
        """Пересчитать разбор: за текущий месяц (по сей день) или за указанный; обслуживание - по флагу."""
        b = request.get_json(force=True, silent=True) or {}
        month = b.get("month") or datetime.now().strftime("%Y-%m")
        return jsonify(make(month, bool(b.get("maintenance"))))

    @app.post("/api/review/month/seen")
    def review_seen():
        with db_lock:
            con.execute("UPDATE month_reviews SET seen=1 WHERE month=?", ((request.get_json(force=True) or {}).get("month"),))
            con.commit()
        return jsonify({"ok": True})

    @app.post("/api/review/tasks")
    def review_tasks_add():
        """Добавить задания месяца по id паттернов (например, из ежемесячной проверки): {"ids": [...]}."""
        ids = (request.get_json(force=True) or {}).get("ids") or []
        with db_lock:
            tasks = add_tasks(con, ids)
        return jsonify({"ok": tasks is not None, "tasks": tasks or []})

    @app.get("/api/review/tasks")
    def review_tasks():
        """Активные задания месяца (из последнего разбора за прошлый месяц) и их выполнение сейчас."""
        with db_lock:
            row = con.execute("SELECT data, seen FROM month_reviews ORDER BY month DESC LIMIT 1").fetchone()
        if not row:
            return jsonify({"tasks": []})
        rep = json.loads(row[0])
        try:
            prog = task_progress(con, shift_h, rep.get("tasks") or [], all_vio(), rules_fn())
        except Exception:
            prog = rep.get("tasks") or []
        return jsonify({"month": rep["month"], "title": rep["title"], "tasks": prog, "unseen": not row[1]})
