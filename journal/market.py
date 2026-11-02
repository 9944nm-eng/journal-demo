"""Рыночные данные: позиции COT (CFTC) и макро-ряды (FRED).

Источники (без ключей):
- CFTC Public Reporting Environment, Socrata API:
  Legacy Futures Only      https://publicreporting.cftc.gov/resource/6dca-aqww.json
  Disaggregated Futures    https://publicreporting.cftc.gov/resource/72hh-3qpy.json  (managed money)
  Отчёт выходит по пятницам с данными на вторник.
- FRED (Federal Reserve Bank of St. Louis), CSV-выгрузка графика:
  https://fred.stlouisfed.org/graph/fredgraph.csv?id=<SERIES>
Цены инструментов берутся из терминала MT5 (дневные свечи).
"""
import csv
import io
import json
import math
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

CFTC = "https://publicreporting.cftc.gov/resource/"
LEGACY, DISAGG = "6dca-aqww", "72hh-3qpy"
FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv"
UA = "MT5-Journal/1.0 (personal trading journal)"

# Коды рынков CFTC. Название, которое вернёт CFTC, показывается в интерфейсе - по нему видно,
# что код соответствует нужному контракту.
KNOWN_MARKETS = [
    {"code": "088691", "name": "Золото (COMEX)", "symbol": "XAUUSD"},
    {"code": "084691", "name": "Серебро (COMEX)", "symbol": "XAGUSD"},
    {"code": "085692", "name": "Медь (COMEX)", "symbol": "COPPER"},
    {"code": "067651", "name": "Нефть WTI (NYMEX)", "symbol": "USOIL"},
    {"code": "073732", "name": "Какао (ICE)", "symbol": "COCOA"},
    {"code": "083731", "name": "Кофе (ICE)", "symbol": "COFFEE"},
    {"code": "099741", "name": "Евро (CME)", "symbol": "EURUSD"},
    {"code": "096742", "name": "Фунт (CME)", "symbol": "GBPUSD"},
    {"code": "097741", "name": "Иена (CME)", "symbol": "USDJPY", "invert": True},
    {"code": "13874A", "name": "S&P 500 E-mini (CME)", "symbol": "US500"},
]

MACRO = {
    "DFII10": {"name": "Реальная доходность 10 лет", "unit": "%"},
    "GVZCLS": {"name": "Волатильность золота GVZ", "unit": ""},
    "DTWEXBGS": {"name": "Индекс доллара (широкий, ФРС)", "unit": ""},
    "DGS10": {"name": "Доходность UST 10 лет", "unit": "%"},
    "T10YIE": {"name": "Инфляционные ожидания 10 лет", "unit": "%"},
}

DEFAULT_MARKET_CFG = {
    "enabled": True,
    "update_hours": 6,
    "cot_years": 5,
    "cot_markets": [KNOWN_MARKETS[0], KNOWN_MARKETS[6]],
    "fred_series": ["DFII10", "GVZCLS", "DTWEXBGS", "DGS10", "T10YIE"],
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS cot (
    code TEXT NOT NULL, date TEXT NOT NULL, market TEXT,
    oi REAL, nc_long REAL, nc_short REAL, nc_spread REAL,
    c_long REAL, c_short REAL, nr_long REAL, nr_short REAL,
    mm_long REAL, mm_short REAL,
    PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS macro (
    series TEXT NOT NULL, date TEXT NOT NULL, value REAL,
    PRIMARY KEY (series, date)
);
CREATE TABLE IF NOT EXISTS market_meta (key TEXT PRIMARY KEY, value TEXT);
"""


def ensure_schema(con):
    con.executescript(SCHEMA)


def get_meta(con, key, default=None):
    r = con.execute("SELECT value FROM market_meta WHERE key=?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def set_meta(con, key, value):
    con.execute("INSERT OR REPLACE INTO market_meta(key, value) VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))


def market_cfg(cfg, con):
    m = dict(DEFAULT_MARKET_CFG)
    m.update(cfg.get("market") or {})
    saved = get_meta(con, "cot_markets")
    if saved is not None:
        # признак обратной пары берём из справочника: при сохранении настроек он терялся, и вердикт по USDJPY считался с обратным знаком
        inv = {k["code"] for k in KNOWN_MARKETS if k.get("invert")}
        m["cot_markets"] = [dict(x, invert=True) if x.get("code") in inv else x for x in saved]
    return m


# ---------------------------------------------------------------------------- http
def _get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def fetch_cot(code, since):
    code = re.sub(r"[^0-9A-Za-z]", "", code)
    q = {"$where": f"cftc_contract_market_code='{code}' AND report_date_as_yyyy_mm_dd >= '{since}T00:00:00'",
         "$order": "report_date_as_yyyy_mm_dd", "$limit": "5000"}
    rows = json.loads(_get(CFTC + LEGACY + ".json?" + urllib.parse.urlencode(q)))
    out = {}
    for r in rows:
        d = (r.get("report_date_as_yyyy_mm_dd") or "")[:10]
        if not d:
            continue
        out[d] = {"date": d, "market": r.get("market_and_exchange_names"),
                  "oi": _num(r.get("open_interest_all")),
                  "nc_long": _num(r.get("noncomm_positions_long_all")),
                  "nc_short": _num(r.get("noncomm_positions_short_all")),
                  "nc_spread": _num(r.get("noncomm_postions_spread_all") or r.get("noncomm_positions_spread_all")),
                  "c_long": _num(r.get("comm_positions_long_all")),
                  "c_short": _num(r.get("comm_positions_short_all")),
                  "nr_long": _num(r.get("nonrept_positions_long_all")),
                  "nr_short": _num(r.get("nonrept_positions_short_all")),
                  "mm_long": None, "mm_short": None}
    # managed money есть только в Disaggregated (товарные рынки); для валют и индексов его нет
    try:
        rows = json.loads(_get(CFTC + DISAGG + ".json?" + urllib.parse.urlencode(q)))
        for r in rows:
            d = (r.get("report_date_as_yyyy_mm_dd") or "")[:10]
            if d in out:
                out[d]["mm_long"] = _num(r.get("m_money_positions_long_all"))
                out[d]["mm_short"] = _num(r.get("m_money_positions_short_all"))
    except Exception:
        pass
    return list(out.values())


def fetch_fred(series, since):
    text = _get(FRED + "?" + urllib.parse.urlencode({"id": series, "cosd": since}))
    rd = csv.reader(io.StringIO(text))
    next(rd, None)
    out = []
    for row in rd:
        if len(row) >= 2 and row[1] not in ("", "."):
            v = _num(row[1])
            if v is not None:
                out.append((row[0][:10], v))
    return out


# ---------------------------------------------------------------------------- demo
def _demo_cot(code, since):
    seed = sum(map(ord, code))
    d = date.fromisoformat(since)
    d += timedelta(days=(1 - d.weekday()) % 7)  # вторник
    out, base = [], 250000 + seed * 300
    while d <= date.today():
        x = (d - date(2000, 1, 1)).days / 7
        trend = math.sin(x / 26 + seed) * 0.55 + math.sin(x / 7 + seed * 0.3) * 0.2
        oi = base * (1 + 0.15 * math.sin(x / 40 + seed))
        ncl = oi * (0.42 + 0.18 * trend)
        ncs = oi * (0.18 - 0.08 * trend)
        cl = oi * (0.30 - 0.12 * trend)
        cs = oi * (0.62 + 0.10 * trend)
        out.append({"date": d.isoformat(), "market": f"DEMO MARKET {code}", "oi": round(oi),
                    "nc_long": round(ncl), "nc_short": round(ncs), "nc_spread": round(oi * 0.08),
                    "c_long": round(cl), "c_short": round(cs), "nr_long": round(oi * 0.1),
                    "nr_short": round(oi * 0.12), "mm_long": round(ncl * 0.7), "mm_short": round(ncs * 0.8)})
        d += timedelta(days=7)
    return out


def _demo_fred(series, since):
    base = {"DFII10": 1.9, "GVZCLS": 18, "DTWEXBGS": 121, "DGS10": 4.2, "T10YIE": 2.3}.get(series, 1)
    seed = sum(map(ord, series))
    d, out = date.fromisoformat(since), []
    while d <= date.today():
        if d.weekday() < 5:
            x = (d - date(2000, 1, 1)).days
            v = base * (1 + 0.08 * math.sin(x / 90 + seed) + 0.03 * math.sin(x / 17 + seed * 2))
            out.append((d.isoformat(), round(v, 3)))
        d += timedelta(days=1)
    return out


# ---------------------------------------------------------------------------- update
def update(cfg, con, force=False, log=print):
    ensure_schema(con)
    m = market_cfg(cfg, con)
    if not m.get("enabled"):
        return {"status": "off"}
    last = get_meta(con, "updated", 0)
    if not force and time.time() - last < float(m["update_hours"]) * 3600:
        return {"status": "fresh", "updated": last}
    demo = cfg["mode"] == "demo"
    errors = []
    start = (date.today() - timedelta(days=int(m["cot_years"]) * 365)).isoformat()
    for mk in m["cot_markets"]:
        code = mk["code"]
        r = con.execute("SELECT MAX(date) FROM cot WHERE code=?", (code,)).fetchone()[0]
        since = (date.fromisoformat(r) - timedelta(days=21)).isoformat() if r else start
        try:
            rows = _demo_cot(code, since) if demo else fetch_cot(code, since)
            for x in rows:
                con.execute("INSERT OR REPLACE INTO cot(code, date, market, oi, nc_long, nc_short, nc_spread, c_long, "
                            "c_short, nr_long, nr_short, mm_long, mm_short) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (code, x["date"], x["market"], x["oi"], x["nc_long"], x["nc_short"], x["nc_spread"],
                             x["c_long"], x["c_short"], x["nr_long"], x["nr_short"], x["mm_long"], x["mm_short"]))
            log(f"COT {code}: {len(rows)} отчётов")
        except Exception as e:
            errors.append(f"COT {mk.get('name') or code}: {e}")
    for s in m["fred_series"]:
        r = con.execute("SELECT MAX(date) FROM macro WHERE series=?", (s,)).fetchone()[0]
        since = (date.fromisoformat(r) - timedelta(days=14)).isoformat() if r else start
        try:
            rows = _demo_fred(s, since) if demo else fetch_fred(s, since)
            con.executemany("INSERT OR REPLACE INTO macro(series, date, value) VALUES (?,?,?)",
                            [(s, d, v) for d, v in rows])
            log(f"FRED {s}: {len(rows)} значений")
        except Exception as e:
            errors.append(f"FRED {s}: {e}")
    set_meta(con, "updated", int(time.time()))
    set_meta(con, "errors", errors)
    con.commit()
    return {"status": "error" if errors else "ok", "errors": errors}


def price_symbol(con, sym):
    """Название символа у брокера (например XAUUSD.raw), найденное при загрузке цен."""
    if not sym:
        return sym
    return (get_meta(con, "symbol_map", {}) or {}).get(sym, sym)


def _resolve_symbol(con, provider, sym):
    """Ищет символ у брокера: точное имя, затем имена из ваших сделок с тем же началом, затем список терминала."""
    try:
        if provider.symbol(sym):
            return sym
    except Exception:
        pass
    low = sym.lower()
    rows = con.execute("SELECT symbol, COUNT(*) c FROM trades GROUP BY symbol ORDER BY c DESC").fetchall()
    for r in rows:
        if r[0] and r[0].lower().startswith(low):
            return r[0]
    try:
        found = provider.find_symbols(sym)
    except Exception:
        found = []
    return found[0] if found else None


def update_prices(cfg, con, provider, log=print):
    """Дневные свечи по инструментам рынков COT - для графика «цена и позиции» и проверки сигналов."""
    m = market_cfg(cfg, con)
    t_from = int(time.time()) - int(m["cot_years"]) * 365 * 86400
    smap = get_meta(con, "symbol_map", {}) or {}
    errors = {}
    for mk in m["cot_markets"]:
        sym = mk.get("symbol")
        if not sym:
            continue
        # раз найденное название с историей не меняем: иначе цены «прыгают» между терминалами разных брокеров
        prev = smap.get(sym)
        prev_n = con.execute("SELECT COUNT(*) FROM rates WHERE symbol=? AND tf='D1'", (prev,)).fetchone()[0] if prev else 0
        real = prev if prev_n >= 100 else _resolve_symbol(con, provider, sym)
        if real == prev and prev_n >= 100:
            try:
                if not provider.symbol(real):
                    continue  # в этом терминале такого символа нет - обновим через терминал, где он есть
            except Exception:
                continue
        if not real:
            errors[sym] = f"символ {sym} не найден у брокера: укажите точное название, как в «Обзоре рынка» терминала"
            log(f"Цены {sym}: {errors[sym]}")
            continue
        smap[sym] = real
        have = con.execute("SELECT MAX(time) FROM rates WHERE symbol=? AND tf='D1'", (real,)).fetchone()[0]
        a = (have - 5 * 86400) if have else t_from
        try:
            bars = provider.rates(real, "D1", a, int(time.time()) + 86400)
            con.executemany("INSERT OR REPLACE INTO rates(symbol, tf, time, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?)",
                            [(real, "D1") + tuple(b) for b in bars])
            total = con.execute("SELECT COUNT(*) FROM rates WHERE symbol=? AND tf='D1'", (real,)).fetchone()[0]
            if not total:
                errors[sym] = f"терминал не вернул дневные свечи по {real}: откройте график {real} D1 в терминале, чтобы он скачал историю, и синхронизируйте снова"
            log(f"Цены {sym} -> {real}: +{len(bars)} свечей, всего {total}")
        except Exception as e:
            errors[sym] = str(e)
            log(f"Цены {real}: {e}")
    set_meta(con, "symbol_map", smap)
    set_meta(con, "price_errors", errors)
    con.commit()


# ---------------------------------------------------------------------------- read
def _ts(d):
    return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def _index(values, x):
    lo, hi = min(values), max(values)
    return round(100 * (x - lo) / (hi - lo), 1) if hi > lo else None


def cot_summary(con, code, weeks=156):
    rows = [dict(r) for r in con.execute("SELECT * FROM cot WHERE code=? ORDER BY date", (code,))]
    if not rows:
        return None
    for r in rows:
        r["net_nc"] = (r["nc_long"] or 0) - (r["nc_short"] or 0)
        r["net_c"] = (r["c_long"] or 0) - (r["c_short"] or 0)
        r["net_mm"] = (r["mm_long"] - r["mm_short"]) if r["mm_long"] is not None and r["mm_short"] is not None else None
    last, prev = rows[-1], rows[-2] if len(rows) > 1 else None
    window = rows[-weeks:]

    def idx(key):
        vals = [r[key] for r in window if r[key] is not None]
        return _index(vals, last[key]) if vals and last[key] is not None else None

    return {
        "market_name": last["market"], "date": last["date"],
        "oi": last["oi"], "oi_chg": (last["oi"] - prev["oi"]) if prev and last["oi"] and prev["oi"] else None,
        "net_nc": last["net_nc"], "net_nc_chg": last["net_nc"] - prev["net_nc"] if prev else None,
        "net_c": last["net_c"], "net_mm": last["net_mm"],
        "net_mm_chg": (last["net_mm"] - prev["net_mm"]) if prev and last["net_mm"] is not None and prev["net_mm"] is not None else None,
        "pct_oi_nc": round(100 * last["net_nc"] / last["oi"], 1) if last["oi"] else None,
        "index_nc": idx("net_nc"), "index_c": idx("net_c"), "index_mm": idx("net_mm"),
        "weeks": len(window),
        "series": [{"time": _ts(r["date"]), "net_nc": r["net_nc"], "net_c": r["net_c"], "net_mm": r["net_mm"],
                    "oi": r["oi"]} for r in rows],
        "table": [{"date": r["date"], "net_nc": r["net_nc"], "net_c": r["net_c"], "net_mm": r["net_mm"], "oi": r["oi"]}
                  for r in reversed(rows[-10:])],
    }


def macro_summary(con, series):
    rows = con.execute("SELECT date, value FROM macro WHERE series=? ORDER BY date", (series,)).fetchall()
    if not rows:
        return None
    last = rows[-1]
    week = next((r for r in reversed(rows) if r[0] <= (date.fromisoformat(last[0]) - timedelta(days=7)).isoformat()), None)
    month = next((r for r in reversed(rows) if r[0] <= (date.fromisoformat(last[0]) - timedelta(days=30)).isoformat()), None)
    return {"id": series, **MACRO.get(series, {"name": series, "unit": ""}),
            "date": last[0], "value": last[1],
            "chg_w": round(last[1] - week[1], 3) if week else None,
            "chg_m": round(last[1] - month[1], 3) if month else None,
            "series": [{"time": _ts(d), "value": v} for d, v in rows[-800:]]}


def overview(cfg, con):
    ensure_schema(con)
    m = market_cfg(cfg, con)
    markets = []
    for mk in m["cot_markets"]:
        s = cot_summary(con, mk["code"])
        price = []
        if mk.get("symbol"):
            price = [{"time": r[0], "value": r[1]} for r in con.execute(
                "SELECT time, c FROM rates WHERE symbol=? AND tf='D1' ORDER BY time", (price_symbol(con, mk["symbol"]),))]
        markets.append({**mk, "cot": s, "price": price})
    macro = [x for x in (macro_summary(con, s) for s in m["fred_series"]) if x]
    return {"markets": markets, "macro": macro, "updated": get_meta(con, "updated", 0),
            "errors": get_meta(con, "errors", []), "known": KNOWN_MARKETS, "enabled": m.get("enabled", True)}


def cot_at(cfg, con, symbol, ts):
    """Позиции COT на дату сделки для инструмента (по совпадению символа)."""
    ensure_schema(con)
    m = market_cfg(cfg, con)
    sym = (symbol or "").upper()
    mk = next((x for x in m["cot_markets"] if x.get("symbol") and
               (sym.startswith(x["symbol"].upper()) or x["symbol"].upper() in sym)), None)
    if not mk:
        return None
    d = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    rows = [dict(r) for r in con.execute("SELECT * FROM cot WHERE code=? AND date<=? ORDER BY date DESC LIMIT 157",
                                         (mk["code"], d))]
    if not rows:
        return None
    nets = [(r["nc_long"] or 0) - (r["nc_short"] or 0) for r in rows]
    return {"name": mk.get("name"), "date": rows[0]["date"], "net_nc": nets[0],
            "net_nc_chg": nets[0] - nets[1] if len(nets) > 1 else None,
            "index_nc": _index(nets, nets[0]) if len(nets) > 10 else None}


# ---------------------------------------------------------------------------- вердикт
GOLD, FX = {"088691"}, {"099741", "096742", "097741"}
DIR_TEXT = {1: "Предпочтительно лонги", -1: "Предпочтительно шорты", 0: "Нет явного перевеса"}
FACTOR_WHY = {
    "Фонды за неделю": "Свежий поток денег: что фонды делали последнюю неделю. Шумный фактор, одна неделя мало значит.",
    "Фонды за 4 недели": "Устойчивый поток: если фонды месяц набирают позицию в одну сторону, это фон для движения цены.",
    "Managed money за 4 недели": "То же для хедж-фондов и CTA (только товары): самые «спекулятивные» деньги.",
    "Экстремум позиции фондов": "Когда все уже в позиции, новых покупателей (продавцов) мало: рост риска резкого разворота.",
    "Коммерсанты": "Хеджеры продают на росте и покупают на падении. Их крайняя позиция бывает у разворотов.",
    "Реальная доходность 10 лет": "Золото не платит процентов: рост реальной доходности обычно давит на золото.",
    "Доллар (индекс ФРС)": "Золото и валюты котируются к доллару: крепкий доллар давит на них.",
}


def _cot_rows(con, code):
    rows = [dict(r) for r in con.execute("SELECT * FROM cot WHERE code=? ORDER BY date", (code,))]
    for r in rows:
        r["net_nc"] = (r["nc_long"] or 0) - (r["nc_short"] or 0)
        r["net_c"] = (r["c_long"] or 0) - (r["c_short"] or 0)
        r["net_nr"] = (r["nr_long"] or 0) - (r["nr_short"] or 0)
        r["net_mm"] = (r["mm_long"] - r["mm_short"]) if r["mm_long"] is not None and r["mm_short"] is not None else None
    return rows


def _macro_at(con, series, d):
    r = con.execute("SELECT value FROM macro WHERE series=? AND date<=? ORDER BY date DESC LIMIT 1", (series, d)).fetchone()
    return r[0] if r else None


def _sig(x, eps=0.0):
    return 1 if x > eps else -1 if x < -eps else 0


def _fmt(n):
    return f"{n:+,.0f}".replace(",", " ")


def verdict(con, code, weights, rows=None, upto=None):
    rows = rows if rows is not None else _cot_rows(con, code)
    if upto:
        rows = [r for r in rows if r["date"] <= upto]
    if len(rows) < 14:
        return None
    w = weights
    last, d = rows[-1], rows[-1]["date"]
    release = (date.fromisoformat(d) + timedelta(days=3)).isoformat()
    window = rows[-156:]
    factors = []

    def add(name, text, sig, weight):
        factors.append({"name": name, "text": text, "signal": sig, "weight": weight, "contrib": round(sig * weight, 2),
                        "why": FACTOR_WHY.get(name, "")})

    c1 = last["net_nc"] - rows[-2]["net_nc"]
    add("Фонды за неделю", f"нетто {_fmt(c1)} контрактов", _sig(c1), w["w_funds_1w"])
    c4 = last["net_nc"] - rows[-5]["net_nc"]
    add("Фонды за 4 недели", f"нетто {_fmt(c4)} контрактов", _sig(c4), w["w_funds_4w"])
    if last["net_mm"] is not None and rows[-5]["net_mm"] is not None:
        m4 = last["net_mm"] - rows[-5]["net_mm"]
        add("Managed money за 4 недели", f"нетто {_fmt(m4)}", _sig(m4), w["w_mm_4w"])
    vals = [r["net_nc"] for r in window]
    idx = _index(vals, last["net_nc"])
    if idx is not None:
        hi, lo = float(w["extreme_hi"]), float(w["extreme_lo"])
        sig = -1 if idx >= hi else 1 if idx <= lo else 0
        txt = f"индекс {idx:.0f} из 100" + (" - экстремум лонгов, риск разворота" if sig < 0 else
                                            " - экстремум шортов, риск разворота" if sig > 0 else "")
        add("Экстремум позиции фондов", txt, sig, w["w_extreme"])
    cidx = _index([r["net_c"] for r in window], last["net_c"])
    if cidx is not None:
        sig = 1 if cidx >= 80 else -1 if cidx <= 20 else 0
        add("Коммерсанты", f"индекс {cidx:.0f}" + (" - хеджеры редко так мало шортят" if sig > 0 else
                                                    " - хеджеры активно продают" if sig < 0 else ""), sig, w["w_commercials"])
    d4 = (date.fromisoformat(release) - timedelta(days=28)).isoformat()
    if code in GOLD:
        a, b = _macro_at(con, "DFII10", d4), _macro_at(con, "DFII10", release)
        if a is not None and b is not None:
            ch = b - a
            add("Реальная доходность 10 лет", f"{ch:+.2f} п.п. за 4 недели", -_sig(ch, 0.02), w["w_macro"])
    if code in GOLD or code in FX:
        a, b = _macro_at(con, "DTWEXBGS", d4), _macro_at(con, "DTWEXBGS", release)
        if a is not None and b is not None and a:
            ch = 100 * (b / a - 1)
            add("Доллар (индекс ФРС)", f"{ch:+.2f}% за 4 недели", -_sig(ch, 0.1), w["w_macro"])
    score = round(sum(f["contrib"] for f in factors), 2)
    maxs = sum(f["weight"] for f in factors) or 1
    th = float(w["threshold"])
    direction = 1 if score >= th else -1 if score <= -th else 0
    return {"date": d, "release": release, "score": score, "max": round(maxs, 2), "direction": direction,
            "text": DIR_TEXT[direction], "strength": round(abs(score) / maxs, 2), "factors": factors, "threshold": th}


def _closes(con, symbol):
    from datetime import datetime as _dt
    rows = con.execute("SELECT time, c FROM rates WHERE symbol=? AND tf='D1' ORDER BY time", (symbol,)).fetchall()
    return [(_dt.utcfromtimestamp(t).strftime("%Y-%m-%d"), c) for t, c in rows]


def _close_on_or_before(closes, d):
    import bisect
    i = bisect.bisect_right([x[0] for x in closes], d) - 1
    return closes[i][1] if i >= 0 else None


def cot_detail(cfg, con, code, weights, trades=None):
    m = market_cfg(cfg, con)
    mk = next((x for x in m["cot_markets"] if x["code"] == code), {"code": code, "name": code})
    rows = _cot_rows(con, code)
    if not rows:
        return {"market": mk, "rows": [], "verdict": None, "history": [], "summary": None, "next_release": next_release()}
    hist_rows = []
    for i, r in enumerate(rows):
        win = rows[max(0, i - 155):i + 1]
        prev = rows[i - 1] if i else None
        hist_rows.append({
            "date": r["date"], "oi": r["oi"], "oi_chg": (r["oi"] - prev["oi"]) if prev and r["oi"] and prev["oi"] else None,
            "nc_long": r["nc_long"], "nc_short": r["nc_short"], "net_nc": r["net_nc"],
            "net_nc_chg": r["net_nc"] - prev["net_nc"] if prev else None,
            "net_c": r["net_c"], "net_c_chg": r["net_c"] - prev["net_c"] if prev else None,
            "net_mm": r["net_mm"], "net_nr": r["net_nr"],
            "pct_oi": round(100 * r["net_nc"] / r["oi"], 1) if r["oi"] else None,
            "index_nc": _index([x["net_nc"] for x in win], r["net_nc"]) if len(win) > 10 else None,
            "index_c": _index([x["net_c"] for x in win], r["net_c"]) if len(win) > 10 else None,
        })
    now = verdict(con, code, weights, rows)
    # проверка правила на истории: вердикт на каждую неделю по данным, известным на день публикации
    sym, inv = mk.get("symbol"), -1 if mk.get("invert") else 1
    psym = price_symbol(con, sym) if sym else None
    closes = _closes(con, psym) if psym else []
    history = []
    for i in range(max(14, len(rows) - 104), len(rows)):
        v = verdict(con, code, weights, rows[:i + 1])
        if not v:
            continue
        item = {"date": v["date"], "release": v["release"], "direction": v["direction"], "score": v["score"],
                "ret_1w": None, "ret_4w": None}
        if closes:
            p0 = _close_on_or_before(closes, v["release"])
            for key, days in (("ret_1w", 7), ("ret_4w", 28)):
                end = (date.fromisoformat(v["release"]) + timedelta(days=days)).isoformat()
                if end <= closes[-1][0] and p0:
                    p1 = _close_on_or_before(closes, end)
                    item[key] = round(100 * (p1 / p0 - 1) * inv, 2) if p1 else None
        history.append(item)
    summary = {}
    for dname, dv in (("long", 1), ("short", -1), ("neutral", 0)):
        hs = [h for h in history if h["direction"] == dv]
        out = {"count": len(hs)}
        for key in ("ret_1w", "ret_4w"):
            rs = [h[key] for h in hs if h[key] is not None]
            out[key + "_n"] = len(rs)
            out[key + "_avg"] = round(sum(rs) / len(rs), 2) if rs else None
            if dv:
                out[key + "_hit"] = round(100 * sum(1 for x in rs if x * dv > 0) / len(rs), 1) if rs else None
        summary[dname] = out
    read = cot_read(mk, rows, closes, now, summary) if now and len(rows) >= 5 else None
    mine = cot_mine(con, mk, rows, weights, trades or []) if now else None
    return {"market": mk, "rows": list(reversed(hist_rows)), "verdict": now, "read": read, "mine": mine,
            "next_release": next_release(),
            "history": list(reversed(history)), "summary": summary,
            "series": [{"time": _ts(r["date"]), "net_nc": r["net_nc"], "net_c": r["net_c"], "net_mm": r["net_mm"],
                        "net_nr": r["net_nr"]} for r in rows],
            "price": [{"time": r[0], "value": r[1]} for r in con.execute(
                "SELECT time, c FROM rates WHERE symbol=? AND tf='D1' ORDER BY time", (psym or "",))],
            "price_symbol": psym, "price_error": (get_meta(con, "price_errors", {}) or {}).get(sym)}


# ---------------------------------------------------------------------------- COT простым языком
ACC = {"088691": "золото", "084691": "серебро", "085692": "медь", "067651": "нефть", "073732": "какао",
       "083731": "кофе", "099741": "евро", "096742": "фунт", "097741": "иену", "13874A": "S&P 500"}


DAT = {"088691": "золоту", "084691": "серебру", "085692": "меди", "067651": "нефти", "073732": "какао",
       "083731": "кофе", "099741": "евро", "096742": "фунту", "097741": "иене", "13874A": "S&P 500"}


def _acc(mk):
    return ACC.get(mk.get("code")) or (mk.get("name") or mk.get("code") or "").split(" (")[0].lower()


def _dat(mk):
    return DAT.get(mk.get("code")) or _acc(mk)


def _dot(s):
    return s if s.endswith(".") else s + "."


def _k(n):
    """13414 -> «13,4 тыс.»: в объяснениях точность до контракта только мешает."""
    n = abs(n or 0)
    if n < 1000:
        return f"{n:.0f}"
    s = f"{n / 1000:.0f}" if n >= 100000 else f"{n / 1000:.1f}".replace(".", ",")
    return s.replace(",0", "") + " тыс."


def _times(x):
    """«в 6 раз», «в 1,5 раза», «в 3 раза»."""
    if x >= 2:
        n = round(x)
        return f"в {n} " + ("раза" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "раз")
    return f"в {x:.1f} раза".replace(".", ",")


def _pct(x):
    return ("+" if x > 0 else "−" if x < 0 else "") + f"{abs(x):.1f}".replace(".", ",") + "%"


def _r(x):
    return f"{x:.1f}".replace(".", ",") + "R"


def _weeks(n):
    return f"{n} " + ("неделю" if n % 10 == 1 and n % 100 != 11 else
                      "недели" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "недель")


def _streak(rows, key="net_nc"):
    """Сколько последних недель подряд нетто менялось в одну сторону: (число, знак)."""
    n, d = 0, 0
    for i in range(len(rows) - 1, 0, -1):
        a, b = rows[i].get(key), rows[i - 1].get(key)
        if a is None or b is None:
            break
        s = _sig(a - b)
        if not s or (d and s != d):
            break
        d, n = s, n + 1
    return n, d


def _us_dst(day):
    mar = date(day.year, 3, 8)
    nov = date(day.year, 11, 1)
    return mar + timedelta(days=(6 - mar.weekday()) % 7) <= day < nov + timedelta(days=(6 - nov.weekday()) % 7)


def next_release(now=None):
    """Отчёт CFTC выходит по пятницам в 15:30 по Нью-Йорку (в праздничные недели позже)."""
    now = now or datetime.now(timezone.utc)
    for i in range(8):
        day = now.date() + timedelta(days=i)
        if day.weekday() != 4:
            continue
        ts = datetime(day.year, day.month, day.day, 19 if _us_dst(day) else 20, 30, tzinfo=timezone.utc)
        if ts > now:
            return int(ts.timestamp())
    return None


def _idx_text(idx, net):
    if idx is None:
        return "мало истории для сравнения"
    side = "лонгах" if net >= 0 else "шортах"
    if idx >= 90:
        return "у верхней границы диапазона за 3 года: фонды почти никогда не были настолько «за рост»"
    if idx >= 70:
        return "в верхней части диапазона за 3 года: настрой фондов выше обычного"
    if idx > 30:
        return f"в середине диапазона за 3 года: позиция в {side} обычная, не переполнена"
    if idx > 10:
        return "в нижней части диапазона за 3 года: настрой фондов ниже обычного"
    return "у нижней границы диапазона за 3 года: фонды почти никогда не были настолько «за падение»"


def _bg(v, mk):
    """Фон вердикта в терминах инструмента терминала: для иены фьючерс и USDJPY ходят в разные стороны."""
    return (v["direction"] if v else 0) * (-1 if mk.get("invert") else 1)


def cot_read(mk, rows, closes, v, summary):
    """Разбор последнего отчёта простыми словами: кто в рынке, что делает, насколько переполнено, что это значит."""
    last, prev, p4 = rows[-1], rows[-2], rows[-5]
    win = rows[-156:]
    acc, sym = _acc(mk), mk.get("symbol") or ""
    net = last["net_nc"]
    L, Sh = last["nc_long"] or 0, last["nc_short"] or 0
    c1, c4 = net - prev["net_nc"], net - p4["net_nc"]
    dl, ds = L - (prev["nc_long"] or 0), Sh - (prev["nc_short"] or 0)
    n_st, d_st = _streak(rows)
    idx = _index([r["net_nc"] for r in win], net)
    cidx = _index([r["net_c"] for r in win], last["net_c"])
    items = []

    # кто в рынке
    big, small = (L, Sh) if net >= 0 else (Sh, L)
    t = (f"Фонды в {'лонгах' if net >= 0 else 'шортах'} по {_dat(mk)}: "
         f"{_k(L)} контрактов на покупку против {_k(Sh)} на продажу")
    if small and big / small >= 1.2:
        t += f", {'покупок' if net >= 0 else 'продаж'} {_times(big / small)} больше"
    if last["oi"]:
        t += f". Их нетто - {abs(100 * net / last['oi']):.0f}% всех открытых контрактов."
    items.append({"k": "Кто в рынке", "t": t, "tone": "pos" if net > 0 else "neg" if net < 0 else ""})

    # что делают
    verb = lambda c: "купили" if c > 0 else "продали"
    t = (_dot(f"За неделю фонды {verb(c1)} нетто {_k(c1)} контрактов, за 4 недели {verb(c4)} {_k(c4)}")
         if c1 and c4 else "Позиция фондов почти не изменилась.")
    if n_st >= 2:
        t += f" {'Покупают' if d_st > 0 else 'Продают'} {_weeks(n_st)} подряд."
    how = ("закрывают покупки и открывают продажи: настрой разворачивается вниз" if dl < 0 < ds else
           "закрывают продажи и открывают покупки: настрой разворачивается вверх" if ds < 0 < dl else
           "в основном закрывают покупки: фиксируют прибыль, новых продавцов немного" if dl < 0 and ds <= 0 and abs(dl) >= abs(ds) else
           "в основном закрывают продажи: шорты выходят, новых покупателей немного" if ds < 0 and dl <= 0 else
           "наращивают и покупки, и продажи: в рынок приходят деньги с разными взглядами" if dl > 0 and ds > 0 else "")
    chg = lambda x: "почти без изменений" if abs(x) < 1000 else ("+" if x > 0 else "−") + _k(x)
    if how:
        t += f" За неделю покупки {chg(dl)}, продажи {chg(ds)}. Значит, фонды {how}."
    items.append({"k": "Что делают сейчас", "t": t, "tone": "pos" if c4 > 0 else "neg" if c4 < 0 else ""})

    # переполненность
    lo, hi = min(r["net_nc"] for r in win), max(r["net_nc"] for r in win)
    t = (_dot(f"Индекс {idx:.0f} из 100 - позиция {_idx_text(idx, net)}. За 3 года нетто фондов было от "
              f"{'+' if lo >= 0 else '−'}{_k(lo)} до {'+' if hi >= 0 else '−'}{_k(hi)}") if idx is not None else _idx_text(None, net))
    if idx is not None and (idx >= 90 or idx <= 10):
        t += " Почти все, кто хотел, уже в позиции: продолжение требует новых денег, а резкий разворот становится вероятнее."
    items.append({"k": "Насколько переполнено", "t": t, "tone": "warn" if idx is not None and (idx >= 90 or idx <= 10) else ""})

    # хеджеры
    if cidx is not None:
        t = f"Коммерсанты (производители, банки, экспортёры) страхуют реальный бизнес и почти всегда стоят против фондов. Индекс {cidx:.0f}: "
        t += ("хеджеры продают меньше, чем обычно за 3 года. Так бывает у дна, когда цена уже «дешёвая» для бизнеса." if cidx >= 80 else
              "хеджеры продают больше обычного. Так бывает у вершин: бизнес фиксирует высокую цену." if cidx <= 20 else
              "ничего необычного, на фон не влияет.")
        items.append({"k": "Хеджеры", "t": t, "tone": "pos" if cidx >= 80 else "neg" if cidx <= 20 else ""})

    # цена и открытый интерес за отчётную неделю (вторник - вторник)
    p1, p0 = _close_on_or_before(closes, last["date"]) if closes else None, _close_on_or_before(closes, prev["date"]) if closes else None
    if p0 and p1 and last["oi"] and prev["oi"]:
        pch, och = 100 * (p1 / p0 - 1), 100 * (last["oi"] / prev["oi"] - 1)
        if mk.get("invert"):  # фьючерс на иену растёт, когда USDJPY падает
            pch, sym_l = -pch, f"Иена (то есть {sym} наоборот)"
        else:
            sym_l = sym
        up = pch > 0
        what = ("цена выросла, а открытый интерес почти не изменился: рост без притока новых денег" if abs(och) < 1 and up else
                "цена снизилась, а открытый интерес почти не изменился: движение без притока новых денег" if abs(och) < 1 else
                "цена и открытый интерес выросли: входят новые покупатели, рост подкреплён деньгами" if up and och > 0 else
                "цена выросла, а открытый интерес упал: рост за счёт закрытия продаж, такой рост слабее" if up else
                "цена упала, а открытый интерес вырос: входят новые продавцы, падение подкреплено деньгами" if och > 0 else
                "цена упала вместе с открытым интересом: выходят покупатели, падение может выдыхаться")
        items.append({"k": "Цена и открытый интерес",
                      "t": f"{sym_l} за отчётную неделю {_pct(pch)}, открытый интерес {_pct(och)}: {what}.", "tone": ""})

    # заголовок
    who = "иену" if mk.get("code") == "097741" else acc
    if idx is not None and idx >= 90:
        head = f"Фонды сильнее всего за 3 года ставят на рост: {who} - переполненная покупка"
    elif idx is not None and idx <= 10:
        head = f"Фонды сильнее всего за 3 года ставят на падение: {who} - переполненная продажа"
    elif n_st >= 2:
        head = f"Фонды {_weeks(n_st)} подряд {'покупают' if d_st > 0 else 'продают'} {who}"
        if d_st < 0 and net > 0:
            head += ", но всё ещё в лонгах"
        elif d_st > 0 and net < 0:
            head += ", но всё ещё в шортах"
    elif c4:
        head = f"За месяц фонды {verb(c4)} {who}" + (", но за неделю развернулись" if c1 and _sig(c1) != _sig(c4) else "")
    else:
        head = f"Фонды почти не меняют позицию по {who}"

    # что это значит для торговли
    bg = _bg(v, mk)
    if mk.get("invert"):
        items.append({"k": f"Как перевести на {sym}", "t": f"Фьючерс на иену - это обратная {sym}: покупка иены фондами давит на {sym} вниз, продажа - толкает вверх.", "tone": ""})
    if bg > 0:
        bg_text = f"Фон по COT для {sym}: за рост. Лонги идут по потоку фондов, шорты - против."
    elif bg < 0:
        bg_text = f"Фон по COT для {sym}: за снижение. Шорты идут по потоку фондов, лонги - против."
    else:
        bg_text = f"Явного фона для {sym} нет: факторы COT тянут в разные стороны. Направление берите из своего анализа."

    trust, trust_tone = None, ""
    if v and v["direction"] and summary:
        s = summary["long" if v["direction"] > 0 else "short"]
        alls = [summary[k]["ret_4w_avg"] * summary[k]["ret_4w_n"] for k in summary if summary[k].get("ret_4w_avg") is not None]
        alln = sum(summary[k]["ret_4w_n"] for k in summary if summary[k].get("ret_4w_avg") is not None)
        base = sum(alls) / alln if alln else 0
        hit, n, avg = s.get("ret_4w_hit"), s.get("ret_4w_n") or 0, s.get("ret_4w_avg")
        if n < 12 or hit is None:
            trust = f"Таких вердиктов за 2 года было {n}: слишком мало, чтобы проверить, работает ли он."
        elif hit < 55 or (avg - base) * v["direction"] <= 0:
            trust = (f"Этот вердикт по рынку не помогал: за 2 года цена через 4 недели шла в его сторону в {hit:.0f}% случаев из {n}. "
                     "Это уровень монетки. Не выбирайте по нему направление сделок, используйте разбор выше, чтобы понимать, кто в рынке.")
            trust_tone = "bad"
        else:
            trust = (f"За 2 года после такого вердикта цена через 4 недели шла в его сторону в {hit:.0f}% случаев из {n}. "
                     "Это немного лучше монетки, но строгую проверку на случайность ни один сигнал COT не прошёл: это фон, а не сигнал входа.")
            trust_tone = "warn"
    return {"headline": head, "items": items, "bg": bg, "bg_text": bg_text, "trust": trust, "trust_tone": trust_tone,
            "index": idx, "index_c": cidx, "pct_oi": round(100 * net / last["oi"], 1) if last["oi"] else None,
            "range": [lo, hi], "net": net, "chg_1w": c1, "chg_4w": c4, "streak": n_st * d_st}


def _report_before(rows, ts):
    """Индекс последнего отчёта, опубликованного до начала дня сделки (вторник + 4 дня = суббота после выхода)."""
    d = datetime.fromtimestamp(ts, tz=timezone.utc).date()
    i = len(rows) - 1
    while i >= 0 and date.fromisoformat(rows[i]["date"]) + timedelta(days=4) > d:
        i -= 1
    return i


def cot_mine(con, mk, rows, weights, trades):
    """Ваши сделки по этому рынку: по фону COT, против и без фона. Отвечает на вопрос, помогает ли вам COT."""
    from .twins import base_symbol
    base = base_symbol(mk.get("symbol") or "")
    mine = [t for t in trades if base and t.get("status") == "closed" and base_symbol(t["symbol"]) == base]
    cache, out = {}, []
    for t in sorted(mine, key=lambda x: x["open_time"]):
        i = _report_before(rows, t["open_time"])
        if i < 13:
            continue
        if i not in cache:
            cache[i] = verdict(con, mk["code"], weights, rows[:i + 1])
        bg = _bg(cache[i], mk)
        rel = "neutral" if not bg else "with" if bg == t["direction"] else "against"
        out.append({"login": t["login"], "position_id": t["position_id"], "symbol": t["symbol"], "direction": t["direction"],
                    "open_time": t["open_time"], "r": t.get("r"), "net": t.get("net"), "rel": rel, "report": rows[i]["date"]})
    groups = {}
    for g in ("with", "against", "neutral"):
        xs = [x for x in out if x["rel"] == g]
        rs = [x["r"] for x in xs if x["r"] is not None]
        groups[g] = {"n": len(xs), "avg_r": round(sum(rs) / len(rs), 2) if rs else None, "sum_r": round(sum(rs), 2),
                     "win": round(100 * sum(1 for r in rs if r > 0) / len(rs)) if rs else None,
                     "net": round(sum(x["net"] or 0 for x in xs), 2)}
    w, a = groups["with"], groups["against"]
    sym = mk.get("symbol") or ""
    if len(out) < 5:
        text = f"Сделок по {sym} с известным фоном COT пока {len(out)}: для выводов нужно хотя бы 10."
    elif not w["n"] and not a["n"]:
        text = f"Все {len(out)} сделок по {sym} пришлись на недели без явного фона COT: сравнивать пока не с чем."
    elif w["n"] < 5 or a["n"] < 5:
        few = "против фона" if a["n"] < 5 else "по фону"
        text = (f"Сделок {few} только {min(w['n'], a['n'])}: для сравнения нужно хотя бы 5 в каждой группе. "
                "Пока видно, в какую сторону вы обычно торгуете относительно фона, но не то, помогает ли он.")
    else:
        diff = (w["avg_r"] or 0) - (a["avg_r"] or 0)
        if diff >= 0.3:
            text = f"По фону вы зарабатываете в среднем на {_r(diff)} за сделку больше, чем против него. COT для вас работает как фильтр: сделки против фона обходятся дороже."
        elif diff <= -0.3:
            text = f"Против фона вы торгуете лучше, на {_r(-diff)} за сделку. COT не ваш фильтр: не давайте ему влиять на выбор направления."
        else:
            text = "Разницы между сделками по фону и против почти нет: на ваш результат COT не влияет. Причина ошибок не в фоне, ищите её в исполнении."
    return {"groups": groups, "text": text, "trades": list(reversed(out))[:12], "total": len(out)}


def cot_briefs(cfg, con, weights):
    """Одна строка фона COT на инструмент - для плана недели и плана дня. Ключ - базовый символ (XAUUSD.raw -> XAUUSD)."""
    from .twins import base_symbol
    out = {}
    for mk in market_cfg(cfg, con)["cot_markets"]:
        if not mk.get("symbol"):
            continue
        rows = _cot_rows(con, mk["code"])
        v = verdict(con, mk["code"], weights, rows) if len(rows) >= 14 else None
        if not v:
            continue
        r = cot_read(mk, rows, _closes(con, price_symbol(con, mk["symbol"])), v, None)
        out[base_symbol(mk["symbol"])] = {"code": mk["code"], "symbol": mk["symbol"], "date": rows[-1]["date"],
                                          "headline": r["headline"], "bg": r["bg"], "index": r["index"]}
    return out


def cot_board(cfg, con, weights, trades):
    """Все рынки на одном экране: настрой фондов, переполненность, фон и ваши сделки по каждому."""
    from .twins import base_symbol
    m = market_cfg(cfg, con)
    out, covered = [], set()
    for mk in m["cot_markets"]:
        rows = _cot_rows(con, mk["code"])
        covered.add(base_symbol(mk.get("symbol") or ""))
        if len(rows) < 14:
            out.append({"code": mk["code"], "name": mk["name"], "symbol": mk.get("symbol"), "empty": True})
            continue
        v = verdict(con, mk["code"], weights, rows)
        last, p4 = rows[-1], rows[-5]
        n_st, d_st = _streak(rows)
        idx = _index([r["net_nc"] for r in rows[-156:]], last["net_nc"])
        base = base_symbol(mk.get("symbol") or "")
        out.append({"code": mk["code"], "name": mk["name"], "symbol": mk.get("symbol"), "invert": bool(mk.get("invert")),
                    "date": last["date"], "net": last["net_nc"], "chg_4w": last["net_nc"] - p4["net_nc"],
                    "streak": n_st * d_st, "index": idx, "bg": _bg(v, mk), "score": v["score"] if v else None,
                    "mine": sum(1 for t in trades if base and base_symbol(t["symbol"]) == base)})
    uncovered = {}
    for t in trades:
        b = base_symbol(t["symbol"])
        if b and b not in covered:
            uncovered[b] = uncovered.get(b, 0) + 1
    return {"markets": out, "uncovered": sorted(uncovered.items(), key=lambda x: -x[1]),
            "next_release": next_release(), "updated": get_meta(con, "updated", 0)}


# ---------------------------------------------------------------------------- контекст сделки
def context_at(cfg, con, symbol, ts):
    """Данные рынка, известные на дату входа (без заглядывания в будущее)."""
    ensure_schema(con)
    d = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
    w = (date.fromisoformat(d) - timedelta(days=7)).isoformat()
    m = market_cfg(cfg, con)
    macro = []
    for s in m["fred_series"]:
        # ряды FRED публикуются с задержкой: берём значение не позже дня до входа
        prev_day = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        a, b = _macro_at(con, s, w), _macro_at(con, s, prev_day)
        if b is not None:
            macro.append({"id": s, **MACRO.get(s, {"name": s, "unit": ""}), "value": b,
                          "chg_w": round(b - a, 3) if a is not None else None})
    bars = con.execute("SELECT time, o, h, l, c FROM rates WHERE symbol=? AND tf='D1' AND time < ? ORDER BY time DESC LIMIT 15",
                       (symbol, ts - ts % 86400)).fetchall()
    atr = None
    if len(bars) >= 15:
        trs = [max(bars[i][2], bars[i + 1][4]) - min(bars[i][3], bars[i + 1][4]) for i in range(14)]
        atr = {"atr14": round(sum(trs) / 14, 5), "prev_range": round(bars[0][2] - bars[0][3], 5),
               "prev_close": bars[0][4]}
    return {"date": d, "cot": cot_at(cfg, con, symbol, ts), "macro": macro, "atr": atr}


# ---------------------------------------------------------------------------- проверка сигналов COT
SIGNALS = {
    "ext_hi": "Экстремум позиции фондов, верхний (индекс от 90)",
    "ext_lo": "Экстремум позиции фондов, нижний (индекс до 10)",
    "long_up_short_down": "Лонги набраны, шорты срезаны",
    "long_down_short_up": "Лонги срезаны, шорты набраны",
    "both_up": "Обе стороны набраны",
    "both_down": "Обе стороны срезаны",
    "div_bull": "Бычья дивергенция: цена за 4 недели вниз, нетто фондов вверх",
    "div_bear": "Медвежья дивергенция: цена за 4 недели вверх, нетто фондов вниз",
}
HORIZONS = (1, 4, 12)


def _bh(pvals, alpha=0.10):
    """Поправка Беньямини-Хохберга: q-значения."""
    n = len(pvals)
    order = sorted(range(n), key=lambda i: pvals[i])
    q = [0.0] * n
    prev = 1.0
    for rank in range(n, 0, -1):
        i = order[rank - 1]
        prev = min(prev, pvals[i] * n / rank)
        q[i] = prev
    return q


def cot_signal_test(cfg, con, years=None, shifts=200, seed=5):
    """Для каждого рынка и сигнала: доходность после сигнала против тех же расчётов на сдвинутых датах."""
    import random
    rnd = random.Random(seed)
    m = market_cfg(cfg, con)
    tests = []
    for mk in m["cot_markets"]:
        sym = mk.get("symbol")
        if not sym:
            continue
        closes = _closes(con, price_symbol(con, sym))
        rows = _cot_rows(con, mk["code"])
        if len(closes) < 200 or len(rows) < 60:
            continue
        inv = -1 if mk.get("invert") else 1
        weeks = []
        for i, r in enumerate(rows):
            rel = (date.fromisoformat(r["date"]) + timedelta(days=3)).isoformat()
            p0 = _close_on_or_before(closes, rel)
            fw = {}
            for h in HORIZONS:
                end = (date.fromisoformat(rel) + timedelta(days=7 * h)).isoformat()
                if end <= closes[-1][0] and p0:
                    p1 = _close_on_or_before(closes, end)
                    fw[h] = 100 * (p1 / p0 - 1) * inv if p1 else None
            past = _close_on_or_before(closes, (date.fromisoformat(rel) - timedelta(days=28)).isoformat())
            win = rows[max(0, i - 155):i + 1]
            idx = _index([x["net_nc"] for x in win], r["net_nc"]) if len(win) > 52 else None
            prev = rows[i - 1] if i else None
            prev4 = rows[i - 4] if i >= 4 else None
            sig = set()
            if idx is not None:
                if idx >= 90: sig.add("ext_hi")
                if idx <= 10: sig.add("ext_lo")
            if prev:
                dl, ds = (r["nc_long"] or 0) - (prev["nc_long"] or 0), (r["nc_short"] or 0) - (prev["nc_short"] or 0)
                if dl > 0 and ds < 0: sig.add("long_up_short_down")
                if dl < 0 and ds > 0: sig.add("long_down_short_up")
                if dl > 0 and ds > 0: sig.add("both_up")
                if dl < 0 and ds < 0: sig.add("both_down")
            if prev4 and past and p0:
                pch, nch = p0 - past, r["net_nc"] - prev4["net_nc"]
                if pch < 0 < nch: sig.add("div_bull")
                if pch > 0 > nch: sig.add("div_bear")
            weeks.append({"fw": fw, "sig": sig})
        n = len(weeks)
        for s in SIGNALS:
            for h in HORIZONS:
                mask = [s in w["sig"] for w in weeks]
                vals = [w["fw"].get(h) for w in weeks]
                hit = [v for v, mk_ in zip(vals, mask) if mk_ and v is not None]
                allv = [v for v in vals if v is not None]
                if len(hit) < 8 or len(allv) < 60:
                    continue
                base = sum(allv) / len(allv)
                obs = sum(hit) / len(hit) - base
                # нулевая гипотеза: тот же набор сигналов, сдвинутый по времени по кругу
                ge, done = 0, 0
                for _ in range(shifts):
                    k = rnd.randint(h + 4, n - h - 4)
                    sm = mask[k:] + mask[:k]
                    sh = [v for v, mk_ in zip(vals, sm) if mk_ and v is not None]
                    if len(sh) < 3:
                        continue
                    done += 1
                    if abs(sum(sh) / len(sh) - base) >= abs(obs):
                        ge += 1
                p = (ge + 1) / (done + 1) if done else 1.0
                tests.append({"market": mk["name"], "code": mk["code"], "symbol": sym, "signal": s,
                              "signal_name": SIGNALS[s], "h": h, "n": len(hit), "excess": round(obs, 2),
                              "hit_up": round(100 * sum(1 for v in hit if v > 0) / len(hit), 1), "p": round(p, 4)})
    if not tests:
        return {"tests": [], "markets": [], "n_tests": 0}
    q = _bh([t["p"] for t in tests])
    for t, qq in zip(tests, q):
        t["q"] = round(qq, 4)
        t["passed"] = qq <= 0.10
    markets = {}
    for t in tests:
        cur = markets.get(t["code"])
        if not cur or t["p"] < cur["best"]["p"]:
            markets[t["code"]] = {"market": t["market"], "code": t["code"], "symbol": t["symbol"], "best": t,
                                  "passed": [x for x in tests if x["code"] == t["code"] and x["passed"]]}
    sig_p = sum(1 for t in tests if t["p"] < 0.05)
    return {"n_tests": len(tests), "significant_raw": sig_p, "expected_random": round(len(tests) * 0.05, 1),
            "passed": sum(1 for t in tests if t["passed"]), "markets": list(markets.values()),
            "hist": [sum(1 for t in tests if i / 10 <= t["p"] < (i + 1) / 10 or (i == 9 and t["p"] == 1)) for i in range(10)],
            "tests": sorted(tests, key=lambda t: t["p"])[:60]}
