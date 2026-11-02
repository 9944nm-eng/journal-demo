"""Хранение паролей счетов.

На Windows пароль шифруется DPAPI (CryptProtectData): расшифровать его может только та же учётная
запись Windows на этом же ПК. Копия базы на другом компьютере пароля не раскроет.
На других системах (демо-режим) используется base64 - это не шифрование.
"""
import base64
import sys


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    buf = ctypes.create_string_buffer(data, len(data))
    src = BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    dst = BLOB()
    crypt32, kernel32 = ctypes.windll.crypt32, ctypes.windll.kernel32
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(src), None, None, None, None, 0x01, ctypes.byref(dst))  # UI_FORBIDDEN
    if not ok:
        raise OSError("DPAPI: не удалось обработать пароль")
    try:
        return ctypes.string_at(dst.pbData, dst.cbData)
    finally:
        kernel32.LocalFree(dst.pbData)


def encrypt(plain: str) -> str:
    if not plain:
        return ""
    raw = plain.encode("utf-8")
    if sys.platform == "win32":
        return "dpapi:" + base64.b64encode(_dpapi(raw, True)).decode()
    return "b64:" + base64.b64encode(raw).decode()


def decrypt(stored: str) -> str:
    if not stored:
        return ""
    kind, _, body = stored.partition(":")
    raw = base64.b64decode(body)
    if kind == "dpapi":
        return _dpapi(raw, False).decode("utf-8")
    return raw.decode("utf-8")
