"""Cache file stamps and bounded deltas by generation.
Foreign-lifetime or expired tokens require a full read."""
import os
import secrets
import threading
import time

from core import stores as ST

LIFE = secrets.token_hex(3)
KEEP = 500                                  # generations logged; a token older than that starts over
_lock = threading.Lock()
_s = {"at": 0.0, "gen": 0, "roots": None, "fp": {}, "dirs": {}, "log": []}


def _fp(path: str) -> tuple:
    out = []
    for name in ("/card.json", "/signals.jsonl"):
        try:
            st = os.stat(path + name)
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def _bump(changed: set, removed: set) -> None:
    _s["gen"] += 1
    _s["log"].append((_s["gen"], changed, removed))
    del _s["log"][:-KEEP]


def scan(max_age: float = 2.0) -> int:
    """The generation now; the store looked at again when the last look is older than `max_age` seconds."""
    with _lock:
        now = time.monotonic()
        roots = tuple(str(r) for r in ST.every())
        if roots == _s["roots"] and _s["gen"] and now - _s["at"] < max_age:
            return _s["gen"]
        fp, dirs = {}, {}
        for s in roots:
            try:
                with os.scandir(s) as it:
                    for e in it:
                        if e.name[0] in "._" or not e.is_dir():
                            continue
                        fp[e.name] = _fp(e.path)
                        dirs[e.name] = e.path
            except FileNotFoundError:
                continue
        if roots != _s["roots"]:            # other stores (a test's): a new start, nothing to compare with
            _s.update(roots=roots, log=[])
            _bump(set(fp), set())
        else:
            old = _s["fp"]
            changed = {c for c, f in fp.items() if old.get(c) != f}
            removed = set(old) - set(fp)
            if changed or removed:
                _bump(changed, removed)
        _s.update(at=now, fp=fp, dirs=dirs)
        return _s["gen"]


def note(cid: str) -> None:
    """The picker wrote this card (a signal, a split, a merge): its new stamp now, not at the next scan."""
    with _lock:
        path = _s["dirs"].get(cid) or str(ST.card_dir(cid))
        f = _fp(path)
        if _s["fp"].get(cid) != f:
            _s["fp"][cid], _s["dirs"][cid] = f, path
            _bump({cid}, set())


def cards() -> list[tuple[str, str, int]]:
    """Return id/folder/stamp only for folders containing card.json; stamp is the newest card/signal mtime in ns."""
    scan()
    with _lock:
        return [(c, _s["dirs"][c], max(x[0] for x in f if x)) for c, f in _s["fp"].items() if f[0]]


def token(gen: int | None = None) -> str:
    return f"{LIFE}.{scan() if gen is None else gen}"


def last() -> str:
    """The token as the store was last seen (a scan, or the picker's own write: note), without looking again."""
    return f"{LIFE}.{_s['gen']}"


def gen_of(tok: str | None) -> int | None:
    """A token's generation, when it is this server life's; else None."""
    life, _, n = (tok or "").partition(".")
    return int(n) if life == LIFE and n.isdigit() else None


def since(tok: str) -> tuple[set, set] | None:
    """Return changed/removed ids, or None for expired or foreign-lifetime tokens requiring a full reload."""
    g = gen_of(tok)
    scan(max_age=0.5)                       # asked after a job ended or a stamp moved: a fresh look, nearly
    with _lock:
        if g is None or g > _s["gen"] or (_s["log"] and g < _s["log"][0][0] - 1):
            return None
        changed, removed = set(), set()
        for n, ch, rm in _s["log"]:         # in order: a card removed and made again is changed, not gone
            if n > g:
                changed = (changed - rm) | ch
                removed = (removed - ch) | rm
        return changed, removed


def reset() -> None:
    with _lock:
        _s.update(at=0.0, roots=None, fp={}, dirs={}, log=[])
