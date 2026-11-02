"""SQLite: схема и вспомогательные функции."""
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    login INTEGER PRIMARY KEY,
    server TEXT, name TEXT, company TEXT, currency TEXT,
    leverage INTEGER, balance REAL, equity REAL,
    last_sync INTEGER, last_deal_time INTEGER
);

CREATE TABLE IF NOT EXISTS symbols (
    symbol TEXT PRIMARY KEY,
    digits INTEGER, point REAL, contract_size REAL,
    currency_profit TEXT, description TEXT
);

-- сырые сделки (deals) из истории MT5
CREATE TABLE IF NOT EXISTS deals (
    ticket INTEGER NOT NULL,
    login INTEGER NOT NULL,
    order_ticket INTEGER, position_id INTEGER,
    time INTEGER, time_msc INTEGER,
    type INTEGER, entry INTEGER, reason INTEGER,
    volume REAL, price REAL,
    commission REAL, swap REAL, fee REAL, profit REAL,
    symbol TEXT, comment TEXT, magic INTEGER,
    sl REAL, tp REAL,
    PRIMARY KEY (login, ticket)
);
CREATE INDEX IF NOT EXISTS ix_deals_pos ON deals(login, position_id);
CREATE INDEX IF NOT EXISTS ix_deals_time ON deals(login, time);

-- исторические ордера (нужны для начального SL/TP)
CREATE TABLE IF NOT EXISTS orders (
    ticket INTEGER NOT NULL,
    login INTEGER NOT NULL,
    position_id INTEGER, time_setup INTEGER, time_done INTEGER,
    type INTEGER, state INTEGER, reason INTEGER,
    volume_initial REAL, price_open REAL, sl REAL, tp REAL,
    symbol TEXT, comment TEXT,
    PRIMARY KEY (login, ticket)
);
CREATE INDEX IF NOT EXISTS ix_orders_pos ON orders(login, position_id);

-- позиции, собранные из сделок
CREATE TABLE IF NOT EXISTS trades (
    login INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    symbol TEXT, direction INTEGER,            -- 1 = buy, -1 = sell
    status TEXT,                               -- open | closed
    open_time INTEGER, close_time INTEGER,
    volume REAL, entry_price REAL, exit_price REAL,
    sl_initial REAL, tp_initial REAL,
    sl_current REAL, tp_current REAL, price_current REAL,
    commission REAL, swap REAL, fee REAL, profit REAL, net REAL,
    open_reason INTEGER, close_reason INTEGER,
    deals_count INTEGER, reversed INTEGER DEFAULT 0,
    mae REAL, mfe REAL,                        -- в единицах цены
    updated_at INTEGER,
    PRIMARY KEY (login, position_id)
);
CREATE INDEX IF NOT EXISTS ix_trades_time ON trades(login, open_time);

-- ручные поля журнала; не перезаписываются синхронизацией
CREATE TABLE IF NOT EXISTS trade_notes (
    login INTEGER NOT NULL,
    position_id INTEGER NOT NULL,
    setup TEXT, entry_reason TEXT, exit_reason TEXT,
    emotion TEXT, grade INTEGER, mistakes TEXT, tags TEXT, notes TEXT,
    followed_plan INTEGER, sl_manual REAL,
    updated_at INTEGER,
    PRIMARY KEY (login, position_id)
);

-- кэш котировок для графиков (время = время сервера брокера)
CREATE TABLE IF NOT EXISTS rates (
    symbol TEXT NOT NULL, tf TEXT NOT NULL, time INTEGER NOT NULL,
    o REAL, h REAL, l REAL, c REAL, v REAL,
    PRIMARY KEY (symbol, tf, time)
) WITHOUT ROWID;

-- счета, добавленные из интерфейса
CREATE TABLE IF NOT EXISTS account_configs (
    login INTEGER PRIMARY KEY,
    label TEXT, server TEXT, password_enc TEXT, terminal_path TEXT,
    enabled INTEGER DEFAULT 1, created INTEGER
);

-- цели и правила счёта (проп-челлендж), JSON
CREATE TABLE IF NOT EXISTS account_rules (
    login INTEGER PRIMARY KEY,
    rules TEXT, updated_at INTEGER
);

-- снимки баланса и средств при каждой синхронизации (для внутридневной просадки)
CREATE TABLE IF NOT EXISTS equity_snapshots (
    login INTEGER NOT NULL, time INTEGER NOT NULL, balance REAL, equity REAL,
    PRIMARY KEY (login, time)
);

-- скриншоты к сделкам (файлы лежат в data/shots)
CREATE TABLE IF NOT EXISTS trade_shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login INTEGER NOT NULL, position_id INTEGER NOT NULL,
    file TEXT NOT NULL, caption TEXT, created INTEGER
);
CREATE INDEX IF NOT EXISTS ix_shots ON trade_shots(login, position_id);

CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started INTEGER, finished INTEGER, login INTEGER,
    status TEXT, new_deals INTEGER, trades_updated INTEGER, message TEXT
);
"""


def connect(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=30, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    _migrate_pk(con)
    con.executescript(SCHEMA)
    from .market import ensure_schema
    ensure_schema(con)
    cols = {r[1] for r in con.execute("PRAGMA table_info(accounts)")}
    if "server_offset" not in cols:
        con.execute("ALTER TABLE accounts ADD COLUMN server_offset INTEGER")
    ncols = {r[1] for r in con.execute("PRAGMA table_info(trade_notes)")}
    if "checklist" not in ncols:
        con.execute("ALTER TABLE trade_notes ADD COLUMN checklist TEXT")
    # exit_partial / exit_manual - план выхода, записанный до или сразу после входа
    for col in ("entry_model", "arguments", "setup_grade", "drawings", "exit_partial", "exit_manual"):
        if col not in ncols:
            con.execute(f"ALTER TABLE trade_notes ADD COLUMN {col} TEXT")
    from .settings import SCHEMA as SETTINGS_SCHEMA
    con.execute(SETTINGS_SCHEMA)
    con.commit()
    return con


def _migrate_pk(con):
    """Версия 1 хранила тикет как единственный ключ; теперь ключ (login, ticket)."""
    for table in ("deals", "orders"):
        info = list(con.execute(f"PRAGMA table_info({table})"))
        if not info:
            continue
        pk = [r[1] for r in info if r[5]]
        if pk == ["ticket"]:
            con.execute(f"ALTER TABLE {table} RENAME TO {table}_v1")
            con.executescript(SCHEMA)
            cols = ",".join(r[1] for r in info)
            con.execute(f"INSERT OR IGNORE INTO {table} ({cols}) SELECT {cols} FROM {table}_v1")
            con.execute(f"DROP TABLE {table}_v1")
            con.executescript(SCHEMA)
    con.commit()


def rows(cur):
    return [dict(r) for r in cur.fetchall()]
