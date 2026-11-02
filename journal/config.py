"""Загрузка настроек из config.json (рядом с корнем проекта)."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
EXAMPLE_PATH = ROOT / "config.example.json"

DEFAULTS = {
    # "mt5" - реальный терминал, "demo" - синтетические данные для проверки интерфейса
    "mode": "demo",
    "mt5": {
        "terminal_path": "",      # путь к terminal64.exe; пусто = терминал по умолчанию
        "login": 0,               # 0 = использовать счёт, уже открытый в терминале
        "password": "",           # рекомендуется инвесторский (только чтение)
        "server": "",
        "timeout_ms": 60000,
        # закрывать терминал после синхронизации, если журнал сам его запустил
        "close_terminal_after_sync": True,
    },
    "sync": {
        "history_start": "2020-01-01",   # с какой даты брать историю при первой синхронизации
        "overlap_days": 3,               # перекрытие при инкрементальной синхронизации
        "compute_mae_mfe": True,
        "prefetch_charts": True,         # кэшировать котировки для графиков во время синхронизации
    },
    "server": {
        "host": "127.0.0.1",
        "port": 8765,
        "sync_on_start": True,
        "auto_sync_minutes": 0,          # >0 - фоновая синхронизация, пока открыт интерфейс
    },
    # Время в MT5 - это время сервера брокера. Сдвиг (в часах) применяется только к отображению,
    # например -1, если сервер брокера на UTC+3, а вы смотрите по Братиславе летом (UTC+2).
    "display_shift_hours": 0,
    "db_path": "data/journal.db",
}


def _merge(base, override):
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config():
    data = {}
    if CONFIG_PATH.exists():
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    cfg = _merge(DEFAULTS, data)
    # переменные окружения перекрывают файл (удобно, чтобы не хранить пароль в файле)
    if os.environ.get("MT5J_PASSWORD"):
        cfg["mt5"]["password"] = os.environ["MT5J_PASSWORD"]
    if os.environ.get("MT5J_MODE"):
        cfg["mode"] = os.environ["MT5J_MODE"]
    db_path = Path(cfg["db_path"])
    if not db_path.is_absolute():
        db_path = ROOT / db_path
    cfg["db_path"] = str(db_path)
    return cfg
