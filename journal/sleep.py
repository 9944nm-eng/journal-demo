"""Сон из Apple Watch через папку OneDrive.

iPhone (приложение «Команды») каждое утро сохраняет в OneDrive текстовый файл с фазами сна, HRV и пульсом покоя;
OneDrive синхронизирует папку на ПК, журнал забирает новые файлы. История за прошлое - из экспорта «Здоровья»
(export.zip или export.xml в той же папке). Журнал ничего не отправляет: данные только приходят на этот ПК,
сервер по-прежнему слушает только 127.0.0.1.

Формат строки файла из «Команд» (разделитель ; | или табуляция, порядок полей важен):
    sleep;<начало ISO 8601>;<конец ISO 8601>;<фаза: В кровати / Базовый / Глубокий / Быстрый / Пробуждение / Сон>
    hrv;<время ISO 8601>;<мс>
    rhr;<время ISO 8601>;<уд/мин>
"""
import os
import re
import statistics
import threading
import time
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from flask import jsonify, request

SCHEMA = """
CREATE TABLE IF NOT EXISTS sleep_samples (start INTEGER, end INTEGER, stage TEXT, PRIMARY KEY (start, end, stage));
CREATE TABLE IF NOT EXISTS health_values (kind TEXT, time INTEGER, value REAL, PRIMARY KEY (kind, time));
CREATE TABLE IF NOT EXISTS sleep_files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER, rows INTEGER, error TEXT, imported INTEGER);
"""
ASLEEP = {"core", "deep", "rem", "asleep"}
SCAN_EVERY = 300  # папку смотрим не чаще раза в 5 минут (при открытии «Сегодня» и раз в час в фоне)

_state = {"busy": False, "last_scan": 0, "message": ""}
_lock = threading.Lock()


def default_folder():
    base = os.environ.get("OneDriveConsumer") or os.environ.get("OneDrive") or str(Path.home() / "OneDrive")
    return str(Path(base) / "Журнал" / "Сон")


def stage_of(text):
    s = (text or "").strip().lower()
    for keys, st in ((("кроват", "inbed", "in bed"), "inbed"), (("глуб", "deep"), "deep"), (("rem", "быстр", "бдг"), "rem"),
                     (("базов", "core", "основн"), "core"), (("бодр", "awake", "пробужд"), "awake"),
                     (("сон", "asleep", "sleep"), "asleep")):
        if any(k in s for k in keys):
            return st
    return None


def _ts(text):
    """ISO 8601 из «Команд» (2026-10-31T07:12:00+03:00), формат экспорта «Здоровья» (2026-10-31 07:12:00 +0300)
    или локальное время без пояса."""
    s = (text or "").strip().replace("\u202f", " ").replace("\xa0", " ")
    s = re.sub(r"^(\d{4}-\d\d-\d\d) (\d\d:\d\d(:\d\d)?) ?([+-]\d\d):?(\d\d)$", r"\1T\2\4:\5", s)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return int(datetime.fromisoformat(s).timestamp())
    except ValueError:
        pass
    # формат даты «Команд» по умолчанию: «31 окт. 2026 г., 7:12», «31 октября 2026 г. в 07:12:05»
    m = re.match(r"(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})(?:\s*г\.?)?,?\s*(?:в\s+)?(\d{1,2}):(\d\d)", s.lower())
    if m:
        mon = next((i for i, k in enumerate(("янв", "фев", "мар", "апр", "ма", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"), 1)
                    if m.group(2).startswith(k)), None)
        if mon:
            return int(datetime(int(m.group(3)), mon, int(m.group(1)), int(m.group(4)), int(m.group(5))).timestamp())
    # английская iOS: «Oct 31, 2026 at 7:12 AM»
    m = re.match(r"([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s*(?:at\s+)?(\d{1,2}):(\d\d)(?::\d\d)?\s*([ap]m)?", s.lower())
    if m:
        mons = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        if m.group(1) in mons:
            h = int(m.group(4)) % 12 + (12 if m.group(6) == "pm" else 0) if m.group(6) else int(m.group(4))
            return int(datetime(int(m.group(3)), mons.index(m.group(1)) + 1, int(m.group(2)), h, int(m.group(5))).timestamp())
    # числовые форматы региона iPhone: «29. 10. 2026, 00:54» (Словакия), «29.10.2026, 0:54», «10/29/2026, 12:54 AM»
    m = re.match(r"(\d{1,2})[./\-\s]+(\d{1,2})[./\-\s]+(\d{4})\D+(\d{1,2}):(\d\d)(?::\d\d)?\s*([ap]\.?\s?m\.?)?", s.lower())
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        day, mon = (b, a) if "/" in s and a <= 12 else (a, b)  # «/» - американский порядок месяц/день
        h = int(m.group(4))
        if m.group(6):
            h = h % 12 + (12 if m.group(6).startswith("p") else 0)
        try:
            return int(datetime(int(m.group(3)), mon, day, h, int(m.group(5))).timestamp())
        except ValueError:
            pass
    for fmt in ("%d.%m.%Y, %H:%M", "%d.%m.%Y %H:%M", "%d.%m.%Y, %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return int(datetime.strptime(s, fmt).timestamp())
        except ValueError:
            continue
    return None


def _num(text):
    m = re.search(r"-?\d+(?:[.,]\d+)?", text or "")
    return float(m.group(0).replace(",", ".")) if m else None


def _section(title):
    """Заголовок блока в простом файле: «#сон начало», «#сон конец», «#сон фаза», «#hrv время», «#hrv значение»,
    «#пульс время», «#пульс значение» (регистр и порядок слов не важны)."""
    t = title.lower()
    kind = "sleep" if ("сон" in t or "sleep" in t) else "hrv" if ("hrv" in t or "вариаб" in t) else "rhr" if ("пульс" in t or "rhr" in t) else None
    if not kind:
        return None
    if any(k in t for k in ("кон", "end", "оконч")):
        return kind, "end"
    if any(k in t for k in ("фаз", "знач", "value", "stage")):  # раньше «начала»: в «значении» тоже есть «нач»
        return kind, "value"
    if any(k in t for k in ("нач", "start", "время", "time", "дата")):
        return kind, "start"
    return None


def parse_sections(body):
    """Простой файл без циклов: в «Тексте» стоят свойства всего списка образцов, каждое - столбиком под своим
    заголовком. Строки разных блоков сопоставляются по порядку."""
    blocks, cur = defaultdict(list), None
    for line in body.splitlines():
        line = line.strip()
        if line.startswith("#"):
            cur = _section(line[1:])
            continue
        if cur and line:
            blocks[cur].append(line)
    samples, values = [], []
    st, en, va = blocks[("sleep", "start")], blocks[("sleep", "end")], blocks[("sleep", "value")]
    for a, b, v in zip(st, en, va):
        a, b, s = _ts(a), _ts(b), stage_of(v)
        if a and b and s and b > a:
            samples.append((a, b, s))
    for kind in ("hrv", "rhr"):
        for t, v in zip(blocks[(kind, "start")], blocks[(kind, "value")]):
            t, v = _ts(t), _num(v)
            if t and v:
                values.append((kind, t, v))
    if (st or en or va) and not samples:
        raise ValueError("не удалось разобрать даты или фазы сна - проверьте формат даты в команде")
    return samples, values


def parse_text(body):
    """Строки файла из «Команд» -> (сэмплы сна, значения здоровья)."""
    if any(l.strip().startswith("#") for l in body.splitlines()):
        return parse_sections(body)
    samples, values = [], []
    for line in body.splitlines():
        parts = [p.strip() for p in re.split(r"[;|\t]", line) if p.strip()]
        if len(parts) < 3:
            continue
        kind = parts[0].lower()
        if kind in ("sleep", "сон") and len(parts) >= 4:
            a, b, st = _ts(parts[1]), _ts(parts[2]), stage_of(parts[3])
            if a and b and st and b > a:
                samples.append((a, b, st))
        elif kind in ("hrv", "rhr"):
            t, v = _ts(parts[1]), _num(parts[2])
            if t and v:
                values.append((kind, t, v))
    return samples, values


_HK = {"HKCategoryValueSleepAnalysisInBed": "inbed", "HKCategoryValueSleepAnalysisAsleepCore": "core",
       "HKCategoryValueSleepAnalysisAsleepDeep": "deep", "HKCategoryValueSleepAnalysisAsleepREM": "rem",
       "HKCategoryValueSleepAnalysisAwake": "awake", "HKCategoryValueSleepAnalysisAsleepUnspecified": "asleep",
       "HKCategoryValueSleepAnalysisAsleep": "asleep"}


def parse_export(fh):
    """export.xml «Здоровья»: потоком, файл бывает в гигабайты. Берём только сон, HRV и пульс покоя."""
    import xml.etree.ElementTree as ET
    samples, values = [], []
    for _, el in ET.iterparse(fh, events=("end",)):
        if el.tag == "Record":
            ty = el.get("type")
            if ty == "HKCategoryTypeIdentifierSleepAnalysis":
                st = _HK.get(el.get("value"))
                a, b = _ts(el.get("startDate")), _ts(el.get("endDate"))
                if st and a and b and b > a:
                    samples.append((a, b, st))
            elif ty in ("HKQuantityTypeIdentifierHeartRateVariabilitySDNN", "HKQuantityTypeIdentifierRestingHeartRate"):
                t, v = _ts(el.get("startDate")), _num(el.get("value"))
                if t and v:
                    values.append(("hrv" if "Variability" in ty else "rhr", t, v))
        el.clear()
    return samples, values


def _store(con, samples, values):
    con.executemany("INSERT OR IGNORE INTO sleep_samples VALUES (?,?,?)", samples)
    con.executemany("INSERT OR REPLACE INTO health_values VALUES (?,?,?)", values)


def scan(con, db_lock, folder, force=False):
    """Забрать новые и изменившиеся файлы из папки. Большой экспорт «Здоровья» - в фоне."""
    if _state["busy"] or (not force and time.time() - _state["last_scan"] < SCAN_EVERY):
        return
    _state["last_scan"] = time.time()
    p = Path(folder)
    if not p.is_dir():
        _state["message"] = "Папка не найдена" if folder else "Папка не задана"
        return
    with db_lock:
        known = {r[0]: (r[1], r[2]) for r in con.execute("SELECT path, mtime, size FROM sleep_files")}
    todo = []
    for f in sorted(p.iterdir()):
        if not f.is_file() or f.suffix.lower() not in (".txt", ".csv", ".zip", ".xml") or f.name.startswith("~"):
            continue
        st = f.stat()
        if known.get(str(f)) == (st.st_mtime, st.st_size):
            continue
        todo.append((f, st))
    if not todo:
        _state["message"] = ""
        return

    def work():
        _state["busy"] = True
        try:
            for f, st in todo:
                rows, err = 0, None
                try:
                    if f.suffix.lower() in (".txt", ".csv"):
                        s, v = parse_text(f.read_text(encoding="utf-8-sig", errors="replace"))
                    elif f.suffix.lower() == ".zip":
                        with zipfile.ZipFile(f) as z:
                            name = next((n for n in z.namelist() if n.endswith("export.xml")), None)
                            if not name:
                                raise ValueError("в архиве нет export.xml")
                            _state["message"] = f"Импорт истории из {f.name}…"
                            with z.open(name) as fh:
                                s, v = parse_export(fh)
                    else:
                        _state["message"] = f"Импорт истории из {f.name}…"
                        with open(f, "rb") as fh:
                            s, v = parse_export(fh)
                    rows = len(s) + len(v)
                    with db_lock:
                        _store(con, s, v)
                except Exception as e:  # плохой файл не мешает остальным
                    err = str(e)[:200]
                with db_lock:
                    con.execute("INSERT OR REPLACE INTO sleep_files VALUES (?,?,?,?,?,?)",
                                (str(f), st.st_mtime, st.st_size, rows, err, int(time.time())))
                    con.commit()
            _state["message"] = ""
        finally:
            _state["busy"] = False

    big = any(f.suffix.lower() in (".zip", ".xml") for f, _ in todo)
    if big:
        threading.Thread(target=work, daemon=True).start()
    else:
        work()


def _union(intervals):
    """Суммарная длительность объединения отрезков: часы и телефон пишут сон параллельно, складывать нельзя."""
    total, cur_a, cur_b = 0, None, None
    for a, b in sorted(intervals):
        if cur_b is None or a > cur_b:
            if cur_b is not None:
                total += cur_b - cur_a
            cur_a, cur_b = a, b
        else:
            cur_b = max(cur_b, b)
    if cur_b is not None:
        total += cur_b - cur_a
    return total


def nights(con, since=None):
    """Ночи по дате пробуждения: отрезки сна, разделённые паузой больше 3 часов, - разные эпизоды;
    за дату берётся самый длинный эпизод, закончившийся до 15:00 (дневной сон в ночь не попадает)."""
    since = since or int(time.time()) - 400 * 86400
    rows = con.execute("SELECT start, end, stage FROM sleep_samples WHERE end>=? ORDER BY start", (since,)).fetchall()
    eps, cur = [], []
    end_max = None
    for a, b, st in rows:
        if cur and a - end_max > 3 * 3600:
            eps.append(cur); cur = []
        cur.append((a, b, st))
        end_max = b if not cur[:-1] else max(end_max, b)
    if cur:
        eps.append(cur)
    hv = defaultdict(lambda: defaultdict(list))
    for kind, t, v in con.execute("SELECT kind, time, value FROM health_values WHERE time>=?", (since,)):
        hv[datetime.fromtimestamp(t).strftime("%Y-%m-%d")][kind].append(v)
    best = {}
    for ep in eps:
        a = min(x[0] for x in ep); b = max(x[1] for x in ep)
        wake = datetime.fromtimestamp(b)
        asleep = _union([(x[0], x[1]) for x in ep if x[2] in ASLEEP])
        if wake.hour >= 15 or asleep < 2 * 3600:
            continue
        by = {s: _union([(x[0], x[1]) for x in ep if x[2] == s]) for s in ("deep", "rem", "core", "awake")}
        inbed = _union([(x[0], x[1]) for x in ep])
        d = wake.strftime("%Y-%m-%d")
        n = {"date": d, "bed": a, "wake": b, "asleep": asleep // 60, "inbed": inbed // 60,
             "deep": by["deep"] // 60, "rem": by["rem"] // 60, "core": by["core"] // 60, "awake": by["awake"] // 60,
             "stages": bool(by["deep"] or by["rem"] or by["core"]),
             "efficiency": round(100 * asleep / inbed) if inbed else None}
        if d not in best or n["asleep"] > best[d]["asleep"]:
            best[d] = n
    for d, n in best.items():
        h = hv.get(d, {})
        n["hrv"] = round(statistics.mean(h["hrv"])) if h.get("hrv") else None
        n["rhr"] = round(min(h["rhr"])) if h.get("rhr") else None
    return sorted(best.values(), key=lambda n: n["date"])


def bed_minutes(ts):
    """Время засыпания в минутах от 18:00: 23:30 -> 330, 01:15 -> 435 (переход через полночь не ломает сравнение)."""
    d = datetime.fromtimestamp(ts)
    return (d.hour * 60 + d.minute - 18 * 60) % 1440


def for_trades(con, trades):
    """Сон перед каждой сделкой: ночь той же даты (по локальному времени ПК), часы от пробуждения до входа,
    поздний отбой относительно своей медианы. Поля: sleep_min, sleep_short, bed_late, hours_awake."""
    try:
        ns = nights(con)
    except Exception:
        return
    if not ns:
        return
    by = {n["date"]: n for n in ns}
    nm = norm(ns)
    med_bed = statistics.median([bed_minutes(n["bed"]) for n in ns[-30:]]) if len(ns) >= 7 else None
    for t in trades:
        utc = int(t["open_time"]) - int(t.get("server_offset") or 0)
        n = by.get(datetime.fromtimestamp(utc).strftime("%Y-%m-%d"))
        if not n:
            continue
        t["sleep_min"] = n["asleep"]
        t["sleep_short"] = bool(nm and nm.get("asleep") and n["asleep"] < nm["asleep"] - 60)
        t["bed_late"] = med_bed is not None and bed_minutes(n["bed"]) > med_bed + 60
        t["hours_awake"] = round((utc - n["wake"]) / 3600, 1) if utc > n["wake"] else None


def norm(ns):
    """Личная норма: медиана последних 30 ночей (не среднее - одна бессонная ночь её не сдвигает)."""
    last = ns[-30:]
    if len(last) < 7:
        return None
    med = lambda k: (round(statistics.median([n[k] for n in last if n.get(k)])) if any(n.get(k) for n in last) else None)
    return {"asleep": med("asleep"), "deep": med("deep"), "rem": med("rem"), "hrv": med("hrv"), "rhr": med("rhr"), "nights": len(last)}


def impact(ns, trades, day_of, vio_keys):
    """Торговые дни по качеству предшествующей ночи: средний R на сделку, доля прибыльных, доля нарушений ТС.
    Выводы показываются, только когда в каждой группе есть хотя бы 5 дней."""
    nm = norm(ns)
    if not nm:
        return None
    by_date = {n["date"]: n for n in ns}
    groups = {"short": [], "normal": [], "low_hrv": [], "ok_hrv": []}
    days = defaultdict(list)
    for t in trades:
        if t["status"] == "closed":
            days[day_of(t)].append(t)
    for d, ts in days.items():
        n = by_date.get(d)
        if not n:
            continue
        groups["short" if n["asleep"] < nm["asleep"] - 60 else "normal"].append(ts)
        if n.get("hrv") and nm.get("hrv"):
            groups["low_hrv" if n["hrv"] < nm["hrv"] * 0.85 else "ok_hrv"].append(ts)

    def agg(ds):
        ts = [t for day in ds for t in day]
        rs = [t["r"] for t in ts if t.get("r") is not None]
        return {"days": len(ds), "trades": len(ts),
                "avg_r": round(sum(rs) / len(rs), 2) if rs else None,
                "win_rate": round(100 * sum(1 for t in ts if t["net"] > 0) / len(ts)) if ts else None,
                "vio_rate": round(100 * sum(1 for t in ts if (t["login"], t["position_id"]) in vio_keys) / len(ts)) if ts else None}
    out = {k: agg(v) for k, v in groups.items()}
    out["norm"] = nm
    out["enough"] = out["short"]["days"] >= 5 and out["normal"]["days"] >= 5
    out["enough_hrv"] = out["low_hrv"]["days"] >= 5 and out["ok_hrv"]["days"] >= 5
    return out


def register(app, con, db_lock, appset, all_trades, day_of, all_vio):
    con.executescript(SCHEMA)

    def cfg():
        st = appset.get(con, "sleep")
        return st, (st.get("folder") or default_folder())

    def hourly():  # фоновая проверка папки: файл с утра появится, даже если журнал не открывали
        while True:
            time.sleep(3600)
            try:
                st, folder = cfg()
                if st.get("enabled"):
                    scan(con, db_lock, folder)
            except Exception:
                pass
    threading.Thread(target=hourly, daemon=True).start()

    @app.get("/api/sleep")
    def sleep_get():
        st, folder = cfg()
        if st.get("enabled"):
            try:
                scan(con, db_lock, folder, force=bool(request.args.get("rescan")))
            except Exception as e:
                _state["message"] = str(e)[:200]
        with db_lock:
            ns = nights(con)
            files = [dict(zip(("path", "rows", "error", "imported"), r)) for r in con.execute(
                "SELECT path, rows, error, imported FROM sleep_files ORDER BY imported DESC LIMIT 5")]
        out = {"enabled": bool(st.get("enabled")), "folder": folder, "folder_ok": Path(folder).is_dir(),
               "default_folder": default_folder(), "busy": _state["busy"], "message": _state["message"],
               "files": [{**f, "name": Path(f["path"]).name} for f in files],
               "nights": ns[-60:], "norm": norm(ns), "total_nights": len(ns)}
        if request.args.get("impact") and ns:
            try:
                vio = set(all_vio().keys())
            except Exception:
                vio = set()
            out["impact"] = impact(ns, all_trades(), day_of, vio)
        return jsonify(out)

    @app.post("/api/sleep/folder")
    def sleep_folder():
        """Создать папку для файлов сна (по умолчанию OneDrive\\Журнал\\Сон)."""
        st, folder = cfg()
        Path(folder).mkdir(parents=True, exist_ok=True)
        return jsonify({"ok": True, "folder": folder})
