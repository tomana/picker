"""Resolve cards and logs through configured stores; later events stay with their opening event.
Test overrides redirect both stores and logs."""
from __future__ import annotations

import os
import time
from pathlib import Path

from . import config as C

_USE: list | None = None            # a test's stores (use)
_EVERY: dict = {"cfg": None, "at": 0.0, "v": None}     # every()'s answer, for a second (read_card asks per card)
_LOGS: Path | None = None           # a test's folder for the project logs (use_logs)


def use(paths) -> None:
    global _USE
    _USE = [Path(p) for p in paths] if paths is not None else None


def default() -> Path:
    return C.get().data / "cards"


def of_type(type_: str | None) -> Path:
    """Where the type's cards are: its manifest's `cards`, else the config's data/cards."""
    if _USE is not None:
        return _USE[0]
    rel = C.manifest(type_).get("cards") if type_ else None
    return C.get().research / rel if rel else default()


def every() -> list[Path]:
    """Every store, once each, in the config's order of types (the default store last, when a type uses it). The
    same list for a second: read it, don't change it."""
    if _USE is not None:
        return list(_USE)
    cfg, now = C.get(), time.monotonic()
    if _EVERY["cfg"] is cfg and now - _EVERY["at"] < 1.0:
        return _EVERY["v"]
    out = _named(cfg, cfg.data / "cards")
    _EVERY.update(cfg=cfg, at=now, v=out)
    return out


def _named(cfg, plain_home: Path) -> list[Path]:
    """The stores the manifests name, once each, in their order; `plain_home` last when a type names none."""
    out, plain = [], False
    for m in C.manifests(cfg):
        if m.get("cards"):
            p = cfg.research / m["cards"]
            if p not in out:
                out.append(p)
        else:
            plain = True
    if plain or not out:
        out.append(plain_home)
    return out


def card_dir(cid: str) -> Path:
    """The card's folder, in whichever store holds it; where a new one of an unknown type would go, when none does."""
    stores = every()
    if len(stores) == 1:
        return stores[0] / cid
    for s in stores:
        d = s / cid
        if d.is_dir():
            return d
    return stores[0] / cid


def cards():
    """Every card folder in every store, as (id, folder); the store's own order, one store after another."""
    for s in every():
        try:
            with os.scandir(s) as it:
                for e in it:
                    if e.is_dir() and not e.name.startswith((".", "_")):
                        yield e.name, Path(e.path)
        except FileNotFoundError:
            continue


def use_logs(path) -> None:
    global _LOGS
    _LOGS = Path(path) if path is not None else None


def home(type_: str | None) -> Path:
    """Where the type's project logs are: its store, when its manifest names one; else the config's data."""
    if _LOGS is not None:
        return _LOGS
    rel = C.manifest(type_).get("cards") if type_ else None
    return C.get().research / rel if rel else C.get().data


def homes() -> list[Path]:
    if _LOGS is not None:
        return [_LOGS]
    cfg = C.get()
    return _named(cfg, cfg.data)


def logs(name: str, root: Path | None = None) -> list[Path]:
    return [Path(root) / name] if root else [h / name for h in homes()]


def log(name: str, *, type_: str | None = None, id_: str | None = None, root: Path | None = None) -> Path:
    """The `name` log a line goes to: a test's `root`; the type's home (a round or a timeline opened); or the log that
    already names `id_` (its later lines)."""
    if root:
        return Path(root) / name
    if type_ is not None:
        return home(type_) / name
    every_ = logs(name)
    if len(every_) > 1 and id_:
        needle = f'"id": "{id_}"'
        for p in every_:
            try:
                if needle in p.read_text():
                    return p
            except OSError:
                continue
    return every_[-1]
