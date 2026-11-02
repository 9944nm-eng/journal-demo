"""MT5 Journal - локальный торговый журнал для MetaTrader 5."""
from pathlib import Path

try:
    __version__ = (Path(__file__).resolve().parent.parent / "VERSION").read_text(encoding="utf-8").strip()
except OSError:
    __version__ = "dev"
