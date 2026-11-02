"""Точка входа: python -m journal [sync|serve] [опции]."""
import argparse
import sys

from .config import load_config


def main():
    ap = argparse.ArgumentParser(prog="journal", description="Торговый журнал для MetaTrader 5")
    sub = ap.add_subparsers(dest="cmd")
    s = sub.add_parser("sync", help="подтянуть сделки из терминала и выйти")
    s.add_argument("--full", action="store_true", help="перечитать всю историю с history_start")
    s.add_argument("--demo", action="store_true", help="использовать демо-данные")
    s.add_argument("--due", action="store_true", help="только счета, которым пора по расписанию")
    t = sub.add_parser("tray", help="запустить в фоне со значком в трее")
    t.add_argument("--no-browser", action="store_true")
    t.add_argument("--demo", action="store_true")
    t.add_argument("--port", type=int)
    v = sub.add_parser("serve", help="запустить интерфейс в окне консоли")
    v.add_argument("--no-browser", action="store_true")
    v.add_argument("--demo", action="store_true", help="использовать демо-данные")
    v.add_argument("--port", type=int)
    args = ap.parse_args()

    cfg = load_config()
    if getattr(args, "demo", False):
        cfg["mode"] = "demo"
        cfg["db_path"] = cfg["db_path"].replace("journal.db", "demo.db")
        if args.cmd in ("serve", "tray"):  # демо-база пересоздаётся при каждом запуске интерфейса
            import os
            for ext in ("", "-wal", "-shm"):
                if os.path.exists(cfg["db_path"] + ext):
                    os.remove(cfg["db_path"] + ext)
        if args.cmd == "serve":  # демо-база пересоздаётся при каждом запуске
            import os
            for ext in ("", "-wal", "-shm"):
                if os.path.exists(cfg["db_path"] + ext):
                    os.remove(cfg["db_path"] + ext)
    if args.cmd == "sync":
        from .sync import run_sync
        if args.due:
            from .db import connect as _c
            from .sync import due_accounts
            _con = _c(cfg["db_path"])
            due = due_accounts(cfg, _con)
            _con.close()
            res = {"status": "ok"}
            for lg in due:
                res = run_sync(cfg, full=args.full, login=lg)
        else:
            res = run_sync(cfg, full=args.full)
        try:
            from .db import connect
            from .settings import backup_if_due
            con = connect(cfg["db_path"])
            backup_if_due(con, cfg["db_path"])
            con.close()
        except Exception as e:
            print(f"Резервная копия: {e}")
        sys.exit(0 if res["status"] != "error" else 1)
    elif args.cmd == "tray":
        from .tray import run_tray
        if args.port:
            cfg["server"]["port"] = args.port
        run_tray(cfg, open_browser=not args.no_browser)
    else:
        from .server import serve
        if getattr(args, "port", None):
            cfg["server"]["port"] = args.port
        serve(cfg, open_browser=not getattr(args, "no_browser", False))


if __name__ == "__main__":
    main()
