"""Load optional routes, page/start hooks and type operations once per resolved module path.
Plugins receive shared services through S instead of importing backend internals."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

from . import config as C

_MODULES: dict = {}             # resolved path -> the loaded module


def _load(path: Path):
    path = path.resolve()
    if path not in _MODULES:
        name = f"picker_plugin_{len(_MODULES)}_{path.parent.name}"
        spec = importlib.util.spec_from_file_location(name, path)
        mod = sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _MODULES[path] = mod
    return _MODULES[path]


def of(type_: str):
    """The type's plugin module, or None when its manifest names none."""
    rel = C.manifest(type_).get("plugin")
    return _load(C.get().research / rel) if rel else None


def every() -> list:
    """Every plugin this picker runs: its types' (in the config's order), then the config's own `plugins`, each once."""
    out = []
    for t in C.types():
        m = of(t["type"])
        if m is not None and m not in out:
            out.append(m)
    for p in C.get().plugins:
        m = _load(p)
        if m not in out:
            out.append(m)
    return out


class Refused(ValueError):
    """A plugin's no, with the reason the user reads (a split it can't make, ...)."""


_S: SimpleNamespace | None = None


def provide(**fns) -> None:
    s = services()
    for k, v in fns.items():
        setattr(s, k, v)


def services(**over) -> SimpleNamespace:
    """Share one services object; over makes a copy with replacements.
    Resolve sync helpers at call time so replacements remain effective."""
    global _S
    if _S is None:
        from . import arrange, auto, autolog, gate, jsonl, prefs, queue, researcher, signals, trace
        cfg = C.get()
        from . import stores
        _S = SimpleNamespace(config=cfg, stores=stores, research=cfg.research, state=cfg.state,
                             queue=queue, prefs=prefs, signals=signals, trace=trace, jsonl=jsonl, arrange=arrange,
                             auto=auto, autolog=autolog, gate=gate, Refused=Refused,
                             sync=lambda type_: researcher.sync(type_),
                             sync_lock=lambda type_: researcher.sync_lock(type_))
    if not over:
        return _S
    s = SimpleNamespace(**vars(_S))
    for k, v in over.items():
        setattr(s, k, v)
    return s


def call(type_: str, what: str):
    """The type's plugin's `what` (split, duplicate, merge, ...), or None when it has none."""
    m = of(type_)
    return getattr(m, what, None) if m is not None else None


def start() -> None:
    S = services()
    for m in every():
        fn = getattr(m, "start", None)
        if fn is not None:
            fn(S)
