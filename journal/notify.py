"""Уведомления Windows из любой части журнала. Значок в трее подключает сюда свою функцию показа."""
_handler = None


def set_handler(fn):
    global _handler
    _handler = fn


def send(text, title="Торговый журнал"):
    if _handler:
        try:
            _handler(text, title)
        except Exception:
            pass
