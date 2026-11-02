"""Фоновый запуск без окна консоли: веб-сервер + значок в трее (рядом с часами)."""
import os
import socket
import sys
import threading
import time
import webbrowser
from datetime import datetime

from .config import ROOT


def _port_busy(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


def _icon_image():
    from PIL import Image, ImageDraw
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, 60, 60), radius=14, fill=(34, 35, 47, 255))
    for x, top, col in ((14, 26, (61, 190, 139)), (28, 14, (142, 155, 255)), (42, 32, (239, 106, 95))):
        d.rounded_rectangle((x, top, x + 9, 50), radius=2, fill=col + (255,))
    return img


def run_tray(cfg, open_browser=True):
    host, port = cfg["server"]["host"], cfg["server"]["port"]
    url = f"http://{host}:{port}/"
    if _port_busy(host, port):  # журнал уже запущен - просто открыть его
        webbrowser.open(url)
        return

    # без консоли print и логи Flask пишутся в файл
    log_path = ROOT / "data" / ("demo.log" if cfg["mode"] == "demo" else "journal.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists() and log_path.stat().st_size > 2_000_000:
        log_path.replace(log_path.with_suffix(".old.log"))
    logf = open(log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = logf

    from werkzeug.serving import make_server
    from .server import create_app
    from .sync import run_sync

    app = create_app(cfg)
    srv = make_server(host, port, app, threaded=True)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    print(f"Журнал запущен в фоне: {url}")
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    def quit_all(icon=None, _=None):
        print("Журнал остановлен")
        try:
            if icon:
                icon.stop()
            srv.shutdown()
        finally:
            os._exit(0)

    try:
        import pystray
    except ImportError:
        print("pystray не установлен: значка в трее не будет, остановка - кнопкой в разделе «Синхронизация»")
        th.join()
        return

    def do_sync(icon, _):
        def job():
            res = run_sync(cfg)
            try:
                icon.notify(res.get("message") or res.get("status"), "Синхронизация журнала")
            except Exception:
                pass
        threading.Thread(target=job, daemon=True).start()

    def reminders(icon):
        """Уведомления Windows: недельный разбор (раз в день, если не сделан) и утренняя сводка
        за 15 минут до окна ТС (что не готово к сессии)."""
        import json as _j
        import urllib.request as _u
        from . import brief
        from .sync import market_closed
        get = lambda path: _j.loads(_u.urlopen(url + path, timeout=30).read())
        shown, briefed, last_week_check = None, None, 0
        while True:
            time.sleep(60)
            try:
                st = get("api/settings")
                if not st["reminder"].get("windows"):
                    continue
                today = time.strftime("%Y-%m-%d")
                now = time.time()
                if briefed != today and datetime.now().weekday() < 5 and not market_closed():
                    start = brief.window_start(get("api/state"), get("api/rules").get("rules") or [], now)
                    if start and start - 15 * 60 <= now < start:
                        lines = brief.build(get, now)
                        icon.notify(("До окна ТС 15 минут. Не готово: " + "; ".join(lines) + ".") if lines
                                    else "До окна ТС 15 минут. План, чек-лист и разбор в порядке.", "Перед сессией")
                        briefed = today
                if now - last_week_check >= 600:
                    last_week_check = now
                    td = get("api/todo")
                    if td.get("week_due") and shown != today:
                        icon.notify("Пора сделать недельный разбор: три вопроса на «Сегодня».", "Торговый журнал")
                        shown = today
            except Exception:
                pass

    menu = pystray.Menu(
        pystray.MenuItem("Открыть журнал", lambda i, _: webbrowser.open(url), default=True),
        pystray.MenuItem("Синхронизировать", do_sync),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", quit_all),
    )
    icon = pystray.Icon("mt5journal", _icon_image(), "Торговый журнал", menu)
    from . import notify
    notify.set_handler(lambda text, title: icon.notify(text, title))
    threading.Thread(target=reminders, args=(icon,), daemon=True).start()
    icon.run()
