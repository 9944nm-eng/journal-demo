"""Экономический календарь: важные новости по валютам, отметки на графиках и правило «не торгую около новостей».

Источник - открытый недельный календарь ForexFactory (faireconomy.media). Он отдаёт только текущую неделю,
поэтому журнал сохраняет каждую загруженную неделю в базу: история новостей копится с момента включения.
Время хранится в UTC.
"""
import json
import time
from datetime import datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS news (
    time INTEGER NOT NULL, currency TEXT NOT NULL, impact TEXT, title TEXT NOT NULL,
    forecast TEXT, previous TEXT,
    PRIMARY KEY (time, currency, title)
);
"""
URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
UPDATE_HOURS = 6

# валюты, от новостей которых зависит инструмент
INDEX_CCY = {"GER": "EUR", "DE": "EUR", "DAX": "EUR", "EU50": "EUR", "STOXX": "EUR", "FRA": "EUR", "UK100": "GBP", "FTSE": "GBP",
             "NAS": "USD", "US": "USD", "SPX": "USD", "SP500": "USD", "DJ": "USD", "USTEC": "USD", "JP225": "JPY", "NIKKEI": "JPY",
             "AUS200": "AUD", "HK50": "CNY", "XAU": "USD", "XAG": "USD", "GOLD": "USD", "OIL": "USD", "WTI": "USD", "BRENT": "USD",
             "BTC": "USD", "ETH": "USD"}
FX = {"USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "CNY"}


def ensure_schema(con):
    con.executescript(SCHEMA)


def currencies(symbol):
    s = (symbol or "").upper()
    base = "".join(ch for ch in s.split(".")[0] if ch.isalpha())
    if len(base) >= 6 and base[:3] in FX and base[3:6] in FX:
        return {base[:3], base[3:6]}
    for k, v in INDEX_CCY.items():
        if s.startswith(k):
            return {v}
    return {"USD"}


def update(con, force=False, log=print):
    """Загрузить неделю из календаря, не чаще раза в UPDATE_HOURS часов."""
    from .market import _get, get_meta, set_meta
    ensure_schema(con)
    last = get_meta(con, "news_updated") or 0
    if not force and time.time() - last < UPDATE_HOURS * 3600:
        return 0
    try:
        items = json.loads(_get(URL, timeout=20))
    except Exception as e:
        log(f"Календарь новостей: {e}")
        set_meta(con, "news_updated", time.time() - (UPDATE_HOURS - 1) * 3600)  # повторить через час
        return 0
    n = 0
    for it in items:
        try:
            t = int(datetime.fromisoformat(it["date"]).timestamp())
        except Exception:
            continue
        con.execute("INSERT OR REPLACE INTO news(time, currency, impact, title, forecast, previous) VALUES (?,?,?,?,?,?)",
                    (t, it.get("country", ""), it.get("impact", ""), it.get("title", ""), it.get("forecast", ""), it.get("previous", "")))
        n += 1
    set_meta(con, "news_updated", time.time())
    con.commit()
    return n


def around(con, utc_from, utc_to, ccys=None, impact=("High",)):
    ensure_schema(con)
    rows = con.execute("SELECT * FROM news WHERE time BETWEEN ? AND ? ORDER BY time", (int(utc_from), int(utc_to))).fetchall()
    return [dict(r) for r in rows if (not impact or r["impact"] in impact) and (not ccys or r["currency"] in ccys)]


def nearest_minutes(high_news, symbol, utc_ts):
    """Минуты до ближайшей важной новости по валютам инструмента (None - новостей рядом нет)."""
    cc = currencies(symbol)
    best = None
    for n in high_news:
        if n["currency"] in cc:
            m = abs(n["time"] - utc_ts) / 60
            if m <= 240 and (best is None or m < best):
                best = m
    return round(best) if best is not None else None
