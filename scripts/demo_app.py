"""Демо-версия журнала для показа: одна программа, только синтетические данные.

Не читает config.json, не трогает MetaTrader 5 и папки владельца: база создаётся заново при каждом
запуске в %LOCALAPPDATA%\\JournalDemo, сделки и котировки генерирует journal/provider_demo.py,
сон - синтетический. Сервер слушает только 127.0.0.1. Сборка в exe: scripts\\build_demo.ps1.
"""
import math
import os
import random
import socket
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

os.environ["MT5J_MODE"] = "demo"
os.environ.pop("MT5J_PASSWORD", None)

if not getattr(sys, "frozen", False):  # запуск из исходников: python scripts\demo_app.py
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def free_port(start=8770):
    for port in range(start, start + 30):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start


def seed_sleep(con, nights=45):
    """Синтетический сон Apple Watch: фазы как у часов, иногда короткие ночи и поздний отбой."""
    from journal import sleep as sl
    con.executescript(sl.SCHEMA)
    rnd = random.Random(7)
    samples = []
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    for k in range(nights, 0, -1):
        day = today - timedelta(days=k - 1)
        short = rnd.random() < 0.18
        dur = rnd.randint(300, 350) if short else rnd.randint(400, 480)
        bed = day - timedelta(minutes=rnd.randint(30, 150) + (90 if rnd.random() < 0.15 else 0))
        t = bed
        end = bed + timedelta(minutes=dur)
        while t < end:
            for stage, m in (("core", rnd.randint(25, 45)), ("deep", rnd.randint(8, 25)), ("core", rnd.randint(10, 25)),
                             ("rem", rnd.randint(10, 30)), ("awake", rnd.randint(1, 4))):
                e = min(end, t + timedelta(minutes=m))
                if e > t:
                    samples.append((int(t.timestamp()), int(e.timestamp()), stage))
                t = e
    sl._store(con, samples, [("hrv", int((today - timedelta(days=k - 1, hours=-7)).timestamp()), rnd.randint(38, 62)) for k in range(nights, 0, -1)])
    con.commit()


def demo_cfg(base, host="127.0.0.1", port=None):
    """Настройки сервера для демо-базы в папке base (без config.json владельца и MetaTrader 5)."""
    from journal.config import load_config
    cfg = load_config()
    cfg["mode"] = "demo"
    cfg["db_path"] = str(Path(base) / "demo.db")
    cfg["mt5"] = {"terminal_path": "", "login": 0, "password": "", "server": ""}
    cfg["server"].update(host=host, port=port or free_port(), sync_on_start=False)
    cfg["auto_maintenance"] = False
    return cfg


def prepare(base, host="127.0.0.1", port=None):
    """Создаёт заново демо-базу в папке base и возвращает настройки сервера для неё."""
    from journal.db import connect
    from journal import settings as appset

    base = Path(base)
    base.mkdir(parents=True, exist_ok=True)
    db = base / "demo.db"
    for ext in ("", "-wal", "-shm"):
        p = Path(str(db) + ext)
        if p.exists():
            p.unlink()
    cfg = demo_cfg(base, host, port)

    print("Журнал трейдера - демо. Готовлю синтетические данные (около минуты)...", flush=True)
    con = connect(str(db))
    sleep_dir = base / "sleep"
    sleep_dir.mkdir(exist_ok=True)
    appset.put(con, "sleep", {"enabled": True, "folder": str(sleep_dir)})
    appset.put(con, "live", {"enabled": True, "interval": 5, "paths": [], "use_account_paths": False})
    seed_sleep(con)
    con.close()

    from journal.sync import run_sync
    run_sync(cfg, full=True, log=lambda *a: None)  # демо-счета и сделки из встроенного генератора
    return cfg


def main():
    cfg = prepare(Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "JournalDemo")
    from journal.server import serve
    print(f"Откройте http://127.0.0.1:{cfg['server']['port']}/ (браузер откроется сам).", flush=True)
    print("Чтобы закрыть демо, закройте это окно.", flush=True)
    serve(cfg, open_browser=True)


if __name__ == "__main__":
    main()
