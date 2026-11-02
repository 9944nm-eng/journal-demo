"""Парные сделки: одна торговая идея, открытая на нескольких своих счетах.

Пара находится сама: тот же инструмент (с учётом суффиксов брокеров и имён вроде GER30/GER40),
то же направление и вход в пределах TWIN_WINDOW секунд по UTC. Разбор такой сделки пишется один раз
и сохраняется во все сделки пары. Журнал ничего не открывает и не копирует в терминале: это только
разметка уже совершённых сделок. Противоположные позиции парой не считаются (хедж между счетами
запрещён правилами фирм, журнал его не поощряет).
"""
import re

from flask import jsonify, request

TWIN_WINDOW = 300

# поля разбора, общие для пары; уровни, отметки на графике и скриншоты остаются у каждой сделки свои:
# цены у разных брокеров и инструментов (GER30 и GER40) отличаются
SHARED_FIELDS = ["setup", "entry_reason", "exit_reason", "emotion", "grade", "mistakes",
                 "tags", "notes", "followed_plan", "checklist", "entry_model", "arguments", "setup_grade"]

_SUFFIX = re.compile(r"(\.(raw|r|m|pro|a|i|ecn|std|c|x|cash|spot)|_i|-ecn|[m+#])$", re.I)
_ALIAS = {
    "GER30": "DE40", "GER40": "DE40", "DE30": "DE40", "DE40": "DE40", "DAX": "DE40", "DAX40": "DE40", "GERMANY40": "DE40",
    "GOLD": "XAUUSD", "XAUUSD": "XAUUSD", "SILVER": "XAGUSD",
    "US30": "US30", "DJ30": "US30", "DJI30": "US30", "WS30": "US30",
    "NAS100": "US100", "US100": "US100", "USTEC": "US100", "NDX100": "US100", "NQ100": "US100",
    "US500": "US500", "SPX500": "US500", "SP500": "US500",
    "UK100": "UK100", "FTSE100": "UK100",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS twin_off (
    login1 INTEGER, pid1 INTEGER, login2 INTEGER, pid2 INTEGER,
    PRIMARY KEY (login1, pid1, login2, pid2)
);
"""


def base_symbol(sym):
    s = (sym or "").upper().strip()
    for _ in range(2):
        s = _SUFFIX.sub("", s)
    return _ALIAS.get(s, s)


def _key(a, b):
    return (a, b) if a <= b else (b, a)


def _off_pairs(con):
    return {(_key((r[0], r[1]), (r[2], r[3]))) for r in con.execute("SELECT login1, pid1, login2, pid2 FROM twin_off")}


def _utc(t):
    return int(t["open_time"]) - int(t.get("server_offset") or 0)


def groups(con, trades):
    """{(login, pid): [(login, pid) парных сделок]} для переданного списка сделок."""
    off = _off_pairs(con)
    by_sym = {}
    for t in trades:
        by_sym.setdefault((base_symbol(t["symbol"]), t["direction"]), []).append(t)
    out = {}
    for items in by_sym.values():
        items.sort(key=_utc)
        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if _utc(b) - _utc(a) > TWIN_WINDOW:
                    break
                ka, kb = (a["login"], a["position_id"]), (b["login"], b["position_id"])
                if a["login"] == b["login"] or _key(ka, kb) in off:
                    continue
                out.setdefault(ka, []).append(kb)
                out.setdefault(kb, []).append(ka)
    return out


def find(con, login, pid):
    """Парные сделки для одной сделки: по одной на каждый другой счёт, ближайшая по времени входа."""
    cols = "t.login, t.position_id, t.symbol, t.direction, t.open_time, t.status, a.server_offset"
    me = con.execute(f"SELECT {cols} FROM trades t LEFT JOIN accounts a ON a.login=t.login "
                     "WHERE t.login=? AND t.position_id=?", (login, pid)).fetchone()
    if not me:
        return []
    names = ["login", "position_id", "symbol", "direction", "open_time", "status", "server_offset"]
    me = dict(zip(names, me))
    lo, hi = me["open_time"] - 2 * 86400, me["open_time"] + 2 * 86400  # запас на разницу часовых поясов серверов
    rows = [dict(zip(names, r)) for r in con.execute(
        f"SELECT {cols} FROM trades t LEFT JOIN accounts a ON a.login=t.login "
        "WHERE t.login<>? AND t.direction=? AND t.open_time BETWEEN ? AND ?", (login, me["direction"], lo, hi))]
    off = _off_pairs(con)
    best = {}
    for r in rows:
        if base_symbol(r["symbol"]) != base_symbol(me["symbol"]):
            continue
        d = abs(_utc(r) - _utc(me))
        if d > TWIN_WINDOW or _key((login, pid), (r["login"], r["position_id"])) in off:
            continue
        if r["login"] not in best or d < best[r["login"]][0]:
            best[r["login"]] = (d, r)
    return [(r["login"], r["position_id"]) for _, r in sorted(best.values(), key=lambda x: x[0])]


def copy_notes(con, src, dst_list):
    """Записать общие поля разбора src во все сделки dst_list (уровни и рисунки не трогаем)."""
    row = con.execute(f"SELECT {', '.join(SHARED_FIELDS)}, updated_at FROM trade_notes WHERE login=? AND position_id=?", src).fetchone()
    if not row:
        return
    vals = list(row)
    for lg, pid in dst_list:
        con.execute(
            f"INSERT INTO trade_notes (login, position_id, {', '.join(SHARED_FIELDS)}, updated_at) "
            f"VALUES (?, ?, {', '.join('?' * (len(SHARED_FIELDS) + 1))}) ON CONFLICT(login, position_id) DO UPDATE SET "
            + ", ".join(f"{c}=excluded.{c}" for c in SHARED_FIELDS + ["updated_at"]), [lg, pid] + vals)


def register(app, con, db_lock):
    con.executescript(SCHEMA)

    @app.post("/api/trade/<int:login>/<int:pid>/twins")
    def twins_toggle(login, pid):
        """Разъединить пару ({other_login, other_pid, linked: false}) или соединить обратно (linked: true)."""
        b = request.get_json(force=True) or {}
        k = _key((login, pid), (int(b["other_login"]), int(b["other_pid"])))
        with db_lock:
            if b.get("linked"):
                con.execute("DELETE FROM twin_off WHERE login1=? AND pid1=? AND login2=? AND pid2=?", (*k[0], *k[1]))
            else:
                con.execute("INSERT OR IGNORE INTO twin_off VALUES (?,?,?,?)", (*k[0], *k[1]))
            con.commit()
        return jsonify({"ok": True})
