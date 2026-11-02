"""Онлайн-демо журнала для хостинга (Hugging Face Spaces, Render и т. п.), чтобы показать журнал по ссылке.

Только синтетические данные: база создаётся заново при каждом запуске контейнера, config.json, data\\ и
MetaTrader 5 не используются. Данные общие для всех посетителей и сбрасываются при перезапуске.
Функции, которые на чужом сервере опасны или бессмысленны (выключение, пути к папкам, бэкапы,
загрузка файлов, подключение счетов), отключены. Настоящий журнал по-прежнему работает только на 127.0.0.1.
Запуск: python scripts/demo_server.py (порт берётся из переменной PORT, по умолчанию 7860).
"""
import os
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

# (метод, путь): что в онлайн-демо отключено
BLOCKED = [
    ("POST", r"/api/shutdown"),
    ("POST", r"/api/backups"),
    ("POST", r"/api/accounts(/test)?"),
    ("DELETE", r"/api/accounts/\d+"),
    ("POST", r"/api/sleep/folder"),
    ("PUT", r"/api/settings/(backup|sleep|live|sync|reminder)"),
    ("POST", r"/api/trade/\d+/\d+/shots"),
    ("PUT", r"/api/sync/overrides"),
]
BANNER = ('<div style="position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:9999;'
          'background:#1f2937;color:#e5e7eb;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:10px;'
          'box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:calc(100% - 32px);text-align:center" id="demoBanner">'
          'Онлайн-демо: счета и сделки вымышленные, изменения видят все посетители и они сбрасываются при перезапуске. '
          '<a href="#" onclick="this.parentNode.remove();return false" style="color:#93c5fd">Скрыть</a></div>')


def main():
    from flask import jsonify, request
    from demo_app import demo_cfg, prepare
    from journal.server import create_app

    port = int(os.environ.get("PORT", "7860"))
    host = os.environ.get("DEMO_HOST", "0.0.0.0")  # для проверки на своём ПК: DEMO_HOST=127.0.0.1
    base = Path(os.environ.get("DEMO_DATA", "/tmp/journal-demo"))
    if "--seed-only" in sys.argv:  # при сборке образа: на бесплатном сервере генерация заняла бы минуты
        prepare(base, host=host, port=port)
        return
    # база, подготовленная при сборке, - запуск за секунды; иначе генерируем на месте
    cfg = demo_cfg(base, host, port) if (base / "demo.db").exists() else prepare(base, host=host, port=port)
    app = create_app(cfg)
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
    rules = [(m, re.compile(p + r"$")) for m, p in BLOCKED]

    @app.before_request
    def guard():
        if any(request.method == m and rx.match(request.path) for m, rx in rules):
            return jsonify({"message": "В онлайн-демо это отключено. В настоящем журнале работает."}), 403

    @app.after_request
    def banner(resp):
        if request.path == "/" and resp.status_code == 200 and resp.mimetype == "text/html":
            resp.direct_passthrough = False
            resp.set_data(resp.get_data(as_text=True).replace("</body>", BANNER + "</body>"))
        return resp

    print(f"Онлайн-демо журнала: порт {port}", flush=True)
    app.run(host=host, port=port, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
