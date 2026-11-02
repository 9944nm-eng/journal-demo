"""Мастер «Моя ТС»: подсказки по сделкам и заметкам, сохранение ответов и правила проверки сделок.

Вопросы и варианты ответов живут в интерфейсе (web/ts.js). Здесь - то, что нужно знать о ваших данных,
чтобы предложить ответы, и превращение ответов в правила, которые журнал проверяет по каждой сделке.
"""
import json
import re
import statistics
import time
from collections import Counter, defaultdict

from . import analysis
from . import rules as rules_mod
from . import settings as appset

# окно торговли из мастера -> сессия журнала (только если такая сессия есть в настройках)
WINDOW_SESSION = {
    "Азия": "Азия", "Франкфурт open": "Азия", "London open": "Лондон", "Лондон": "Лондон",
    "NY open": "Нью-Йорк", "NYSE open": "Нью-Йорк", "Нью-Йорк": "Нью-Йорк", "London close": "Нью-Йорк",
}

MODELS = [
    ("BOS", r"\bbos\b|слом структур"), ("CHoCH", r"\bchoch\b|смена характер"), ("FVG", r"\bfvg\b|имбаланс|imbalance"),
    ("Inversion FVG", r"\bifvg\b|inversion|инверс"), ("Order block", r"\bob\b|order ?block|ордер ?блок"),
    ("Breaker", r"breaker|брейкер"), ("Снятие ликвидности", r"sweep|снят\w* ликвид|свип|liquidity grab"),
    ("SMT", r"\bsmt\b"), ("Ретест уровня", r"ретест|retest"), ("Откат к зоне", r"откат|pullback"),
]
STOPS = [("за тень свечи", r"тен[ьи]|фитил|wick"), ("за свинг / структуру", r"свинг|swing|структур"),
         ("за order block", r"за ob|за ордер"), ("фиксированный в пунктах", r"пункт|pips|пипс")]
TARGETS = [("ближайший имбаланс", r"имбаланс|fvg|imbalance"), ("противоположная ликвидность", r"ликвидност|liquidity"),
           ("фиксированный RR", r"\brr\b|1:\d"), ("следующий уровень", r"уровень|level")]
TF_RE = re.compile(r"(?<![\w])(?:(\d{1,2})\s?(m|м|мин|h|ч|d|д)|(m|h|d)(\d{1,2}))(?![\w])", re.I)


def _tf(m):
    n, u = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
    u = u.lower()
    u = "M" if u in ("m", "м", "мин") else "H" if u in ("h", "ч") else "D"
    if u == "M" and n == "60":
        return "1H"
    return f"{int(n)}{u}"


def _texts(con, login):
    out = []
    for r in con.execute("SELECT setup, entry_model, arguments, entry_reason, exit_reason, notes, tags "
                         "FROM trade_notes WHERE login=?", (login,)):
        out.append(" ".join(x for x in r if x))
    for tbl, cols in (("notes", "title, body, tags"), ("playbooks", "name, description, rules")):
        try:
            for r in con.execute(f"SELECT {cols} FROM {tbl}"):
                out.append(" ".join(x for x in r if x))
        except Exception:
            pass
    return [t for t in out if t.strip()]


def suggest(con, login, shift_h=0):
    """Что журнал знает о вашей торговле: частые инструменты, окна, риск, RR, модели из заметок."""
    trades = analysis.add_context(con, login, analysis.closed_trades(con, {"login": login}, shift_h), shift_h)
    res = {"count": len(trades)}
    res["symbols"] = Counter(re.sub(r"[._-].*$", "", t["symbol"]).upper() for t in trades).most_common(8)
    res["sessions"] = Counter(t["session"] for t in trades if t.get("session")).most_common()
    rrs = [x for x in (rules_mod.planned_rr(t) for t in trades) if x]
    res["rr"] = round(statistics.median(rrs), 1) if rrs else None
    risks = [t["risk_pct"] for t in trades if t.get("risk_pct")]
    res["risk"] = round(statistics.median(risks), 2) if risks else None
    per_day = Counter(t["day_key"] for t in trades)
    res["per_day"] = int(round(statistics.quantiles(per_day.values(), n=4)[2])) if len(per_day) >= 4 else \
        (max(per_day.values()) if per_day else None)
    # безубыток: закрыта около цены входа при начальном стопе в стороне
    be = [t for t in trades if t.get("sl_used") and t.get("exit_price") and
          abs(t["exit_price"] - t["entry_price"]) <= 0.1 * abs(t["entry_price"] - t["sl_used"])]
    res["be_share"] = round(len(be) / len(trades), 2) if trades else None
    res["partial_share"] = round(sum(1 for t in trades if (t.get("deals_count") or 0) > 2) / len(trades), 2) if trades else None
    day_loss, day_bal = defaultdict(float), {}
    for t in trades:
        day_loss[t["day_key"]] += t["net"]
        day_bal.setdefault(t["day_key"], t.get("balance_at_entry"))
    worst = [-v / day_bal[k] * 100 for k, v in day_loss.items() if v < 0 and day_bal.get(k)]
    res["worst_day_pct"] = round(max(worst), 1) if worst else None

    texts = _texts(con, login)
    blob = "\n".join(texts).lower()
    res["notes_count"] = len(texts)
    res["models"] = [name for name, rx in MODELS if re.search(rx, blob)]
    res["stops"] = [name for name, rx in STOPS if re.search(rx, blob)]
    res["targets"] = [name for name, rx in TARGETS if re.search(rx, blob)]
    res["tfs"] = Counter(_tf(m) for m in TF_RE.finditer("\n".join(texts))).most_common()
    res["setups"] = [r[0] for r in con.execute(
        "SELECT setup, COUNT(*) c FROM trade_notes WHERE login=? AND setup<>'' AND LENGTH(setup)<=40 "
        "GROUP BY setup ORDER BY c DESC LIMIT 6", (login,))]
    res["entry_models"] = [r[0] for r in con.execute(
        "SELECT entry_model, COUNT(*) c FROM trade_notes WHERE login=? AND entry_model<>'' AND LENGTH(entry_model)<=40 "
        "GROUP BY entry_model ORDER BY c DESC LIMIT 6", (login,))]
    res["journal_sessions"] = [s["name"] for s in appset.get(con, "sessions")]
    return res


def _num(v):
    m = re.search(r"\d+(?:[.,]\d+)?", str(v or ""))
    return float(m.group(0).replace(",", ".")) if m else None


def rules_from(answers, journal_sessions):
    """Ответы мастера -> правила проверки сделок (kind, params)."""
    out = []
    a = answers
    if a.get("symbols"):
        out.append(("symbols_only", {"symbols": a["symbols"]}))
    sess = sorted({WINDOW_SESSION.get(w) for w in a.get("windows") or []} & set(journal_sessions))
    if sess:
        out.append(("sessions_only", {"sessions": sess}))
    if _num(a.get("risk")):
        out.append(("max_risk", {"pct": _num(a["risk"])}))
    if _num(a.get("rr")):
        out.append(("min_rr", {"rr": _num(a["rr"])}))
    if _num(a.get("day_limit")):
        out.append(("daily_loss", {"pct": _num(a["day_limit"])}))
    if _num(a.get("per_day")):
        out.append(("max_trades_day", {"n": int(_num(a["per_day"]))}))
    al = str(a.get("after_loss") or "")
    if "мин" in al and _num(al):
        out.append(("cooldown", {"minutes": int(_num(al))}))
    if "до конца дня" in al:
        out.append(("stop_after_losses", {"n": 1}))
    for x in a.get("no_trade") or []:
        if "убыт" in x and _num(x):
            out.append(("stop_after_losses", {"n": int(_num(x))}))
        if "новост" in x:
            out.append(("no_news", {"minutes": int(_num(x) or 30)}))
    if a.get("stop"):
        out.append(("require_sl", {}))
    return out


def save(con, login, answers, apply_rules=True):
    appset.put(con, "ts", {"answers": answers, "saved": int(time.time())})
    created = []
    if apply_rules:
        rules_mod.ensure_schema(con)
        sessions = [s["name"] for s in appset.get(con, "sessions")]
        existing = {r["kind"]: r for r in rules_mod.load(con, login, active_only=False)}
        for kind, params in rules_from(answers, sessions):
            title = rules_mod.title_for(kind, params)
            if kind in existing:
                con.execute("UPDATE rules SET params=?, title=?, active=1, source='ts' WHERE id=?",
                            (json.dumps(params, ensure_ascii=False), title, existing[kind]["id"]))
            else:
                rules_mod.add(con, login, kind, params, "ts")
            created.append(title)
        con.commit()
    return created


def register(app, con, db_lock, current_login, shift_h):
    from flask import jsonify, request

    @app.get("/api/ts")
    def ts_get():
        login = current_login()
        with db_lock:
            data = appset.get(con, "ts")
            try:
                data["suggest"] = suggest(con, login, shift_h)
            except Exception as e:  # подсказки не критичны: мастер работает и без них
                data["suggest"] = {"count": 0, "error": str(e), "journal_sessions": [s["name"] for s in appset.get(con, "sessions")]}
        return jsonify(data)

    @app.put("/api/ts")
    def ts_put():
        b = request.get_json(force=True)
        with db_lock:
            rules = save(con, current_login(), b.get("answers") or {}, b.get("apply_rules", True))
        return jsonify({"ok": True, "rules": rules})
