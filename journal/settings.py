"""Настройки, которые меняются из интерфейса (хранятся в базе), и резервные копии базы."""
import json
import sqlite3
import time
from datetime import datetime
from pathlib import Path

DEFAULTS = {
    # часы UTC, начало включительно, конец не включительно
    "sessions": [
        {"name": "Азия", "start": 0, "end": 8},
        {"name": "Лондон", "start": 8, "end": 13},
        {"name": "Нью-Йорк", "start": 13, "end": 21},
    ],
    "checklist": [
        "Направление совпадает с позиционированием COT",
        "Вход от зоны институционального интереса",
        "Есть подтверждение в ордерфлоу",
        "Риск не больше 0,5% счёта",
        "Соотношение риск/прибыль от 1:3",
        "Стоп выставлен вместе с входом",
        "Нет важных новостей в ближайшие 30 минут",
    ],
    "day_checklist": [
        "Проверил новости и экономический календарь",
        "Отметил ключевые уровни по инструментам",
        "Сверился с позиционированием COT",
        "Определил максимальный риск на день",
        "Состояние спокойное, торгую без спешки",
    ],
    "risk": {"max_risk_pct": 0.5},
    # карточка «Поделиться»
    "share": {"watermark": "100110101", "title": "Закрытая сделка", "unit": "R", "format": "square", "theme": "dark", "caption": "",
              "template": "chart", "tag": "",
              "fields": {"chart": True, "prices": True, "date": True, "duration": True, "rr": True, "setup": False,
                         "volume": False, "second": True, "caption": False}},
    # живое отслеживание: подключение к уже запущенному торговому терминалу (только чтение)
    "live": {"enabled": True, "interval": 5, "paths": [], "use_account_paths": True},
    # напоминание о недельном разборе: день недели (0 - пн, 5 - сб), время, уведомление Windows
    "reminder": {"enabled": True, "day": 5, "time": "11:00", "windows": True},
    # авто-синхронизация: общий интервал и свой интервал для отдельных счетов (0 - выключено)
    # weekend_pause: с вечера пятницы до вечера воскресенья (UTC) не синхронизировать сами - рынок закрыт
    "sync": {"auto": True, "minutes": 15, "on_start": True, "weekend_pause": True, "overrides": {}},
    "backup": {"enabled": True, "every_hours": 24, "keep": 5},
    # торговая система из мастера «Моя ТС»: ответы на вопросы и время сохранения
    "ts": {"answers": {}, "saved": None},
    # сон из Apple Watch: файлы из «Команд» iPhone в папке OneDrive (пусто - OneDrive\Журнал\Сон)
    "sleep": {"enabled": True, "folder": ""},
    "verdict": {
        "w_funds_1w": 1.0, "w_funds_4w": 1.5, "w_mm_4w": 1.0, "w_extreme": 1.5,
        "w_commercials": 1.0, "w_macro": 1.0, "threshold": 2.0,
        "extreme_hi": 90, "extreme_lo": 10,
    },
}

SCHEMA = "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)"


def get(con, key):
    con.execute(SCHEMA)
    r = con.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    if not r:
        return json.loads(json.dumps(DEFAULTS[key]))
    v = json.loads(r[0])
    if isinstance(DEFAULTS[key], dict):
        return {**DEFAULTS[key], **v}
    return v


def get_all(con):
    return {k: get(con, k) for k in DEFAULTS}


def put(con, key, value):
    if key not in DEFAULTS:
        raise KeyError(key)
    con.execute(SCHEMA)
    con.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?,?)", (key, json.dumps(value, ensure_ascii=False)))
    con.commit()


def session_of(sessions, utc_ts):
    if utc_ts is None:
        return None
    h = datetime.utcfromtimestamp(utc_ts).hour + datetime.utcfromtimestamp(utc_ts).minute / 60
    for s in sessions:
        a, b = float(s["start"]), float(s["end"])
        if (a <= h < b) if a <= b else (h >= a or h < b):
            return s["name"]
    return "Вне сессий"


# ---------------------------------------------------------------------------- backups
def backup_dir(db_path):
    return Path(db_path).parent / "backups"


def list_backups(db_path):
    d = backup_dir(db_path)
    if not d.exists():
        return []
    files = sorted(d.glob("journal-*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"name": p.name, "size": p.stat().st_size, "time": int(p.stat().st_mtime)} for p in files]


def make_backup(con, db_path, keep=5):
    d = backup_dir(db_path)
    d.mkdir(parents=True, exist_ok=True)
    name = d / f"journal-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    dst = sqlite3.connect(str(name))
    try:
        con.backup(dst)  # согласованная копия даже во время работы
        # пароли счетов в копию не попадают (правила проп-фирм): после восстановления их вводят заново
        try:
            dst.execute("UPDATE account_configs SET password_enc=NULL")
            dst.commit()
            dst.execute("VACUUM")
        except sqlite3.Error:
            pass
    finally:
        dst.close()
    for old in list_backups(db_path)[keep:]:
        try:
            (d / old["name"]).unlink()
        except OSError:
            pass
    return name.name


def backup_if_due(con, db_path, log=print):
    cfg = get(con, "backup")
    if not cfg.get("enabled"):
        return None
    items = list_backups(db_path)
    if items and time.time() - items[0]["time"] < float(cfg["every_hours"]) * 3600:
        return None
    name = make_backup(con, db_path, int(cfg["keep"]))
    log(f"Резервная копия: {name}")
    return name
