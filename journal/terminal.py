"""Закрытие терминала MT5, который журнал сам запустил для синхронизации.

Пакет MetaTrader5 работает только через запущенный терминал: если терминал закрыт, initialize()
запускает его, а shutdown() отключается, оставляя терминал открытым. Этот модуль запоминает процессы
terminal64.exe до подключения и после работы закрывает только новые - те, что запустил журнал.
Терминал, который вы открыли сами, не трогается.
"""
import os
import subprocess
import sys
import threading
import time

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _run(args):
    return subprocess.run(args, capture_output=True, text=True, creationflags=_NO_WINDOW, timeout=30)


def terminal_pids():
    if sys.platform != "win32":
        return set()
    try:
        out = _run(["tasklist", "/FI", "IMAGENAME eq terminal64.exe", "/FO", "CSV", "/NH"]).stdout
    except Exception:
        return set()
    pids = set()
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) > 1 and parts[0].lower().startswith("terminal64") and parts[1].isdigit():
            pids.add(int(parts[1]))
    return pids


def installed_terminals():
    """Пути terminal64.exe всех установленных MT5: по папкам данных терминалов и Program Files."""
    found = []

    def add(folder):
        exe = os.path.join(folder, "terminal64.exe")
        if os.path.isfile(exe) and os.path.normcase(exe) not in map(os.path.normcase, found):
            found.append(exe)

    data = os.path.join(os.environ.get("APPDATA", ""), "MetaQuotes", "Terminal")
    if os.path.isdir(data):
        for d in os.listdir(data):
            try:
                with open(os.path.join(data, d, "origin.txt"), encoding="utf-16") as f:
                    add(f.read().strip())
            except Exception:
                pass
    for root in filter(None, (os.environ.get("ProgramFiles"), os.environ.get("ProgramW6432"))):
        try:
            for d in os.listdir(root):
                add(os.path.join(root, d))
        except Exception:
            pass
    return found


def default_terminal(exclude=()):
    """Терминал по умолчанию для счёта без своего пути: установленный MT5, который не закреплён
    за другим счётом. Без явного пути пакет MetaTrader5 запускает последний открытый терминал,
    и это может оказаться терминал другой фирмы."""
    taken = {os.path.normcase(os.path.abspath(p)) for p in exclude if p}
    free = [p for p in installed_terminals() if os.path.normcase(os.path.abspath(p)) not in taken]
    std = [p for p in free if os.path.basename(os.path.dirname(p)).lower() == "metatrader 5"]
    return (std or free or [""])[0]


def close_pids(pids, log=print):
    for pid in pids:
        try:
            _run(["taskkill", "/PID", str(pid)])  # обычное закрытие, как кнопкой окна
        except Exception:
            pass
    deadline = time.time() + 20
    while time.time() < deadline and pids & terminal_pids():
        time.sleep(1)
    left = pids & terminal_pids()
    for pid in left:
        try:
            _run(["taskkill", "/F", "/PID", str(pid)])
        except Exception:
            pass
    if pids:
        log(f"Терминал MT5 закрыт после синхронизации ({len(pids)})")


class TerminalLock:
    """Блокировка доступа к терминалу. При освобождении закрывает терминалы, запущенные журналом."""

    def __init__(self):
        self._lock = threading.Lock()
        self.snapshot = None
        self.enabled = False

    def acquire(self, blocking=True, timeout=-1):
        ok = self._lock.acquire(blocking, timeout) if blocking else self._lock.acquire(False)
        if ok:
            self.snapshot = None
        return ok

    def before_connect(self, cfg):
        """Вызывается перед первым подключением к терминалу в пределах блокировки."""
        self.enabled = cfg["mode"] == "mt5" and bool(cfg["mt5"].get("close_terminal_after_sync", True))
        if self.enabled and self.snapshot is None:
            self.snapshot = terminal_pids()

    def release(self):
        try:
            if self.enabled and self.snapshot is not None:
                close_pids(terminal_pids() - self.snapshot)
        finally:
            self.snapshot = None
            self._lock.release()
