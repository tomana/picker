"""Public runner/sync boundary; resolve helpers at call time so replacements remain visible."""
import importlib

_EXPORTS = {
    "drain": ("core.researcher", "drain"), "NothingMade": ("core.researcher", "NothingMade"),
    "Unchanged": ("core.worker", "Unchanged"), "run": ("core.proc", "run"), "TimedOut": ("core.proc", "TimedOut"),
    "agent_for": ("core.researcher", "agent_for"),
    "note_line": ("core.researcher", "note_line"), "count_note": ("core.researcher", "count_note"),
    "attempt_note": ("core.researcher", "attempt_note"), "version_note": ("core.researcher", "version_note"),
    "attachment_note": ("core.researcher", "attachment_note"),
    "version_votes": ("core.researcher", "version_votes"), "context": ("core.researcher", "context_of"),
    "need_exe": ("core.researcher", "need_exe"), "need_path": ("core.researcher", "need_path"),
    "need_writable": ("core.researcher", "need_writable"),
    "run_job": ("core.agents", "run_job"), "names": ("core.agents", "names"), "choice": ("core.agents", "choice"),
    "AgentFailed": ("core.agents", "AgentFailed"), "AgentLimited": ("core.agents", "AgentLimited"),
    "AgentCancelled": ("core.agents", "AgentCancelled"),
    "Deferred": ("core.worker", "Deferred"),
    "emit": ("core.trace", "emit"), "receipt": ("core.receipts", "tool"),
}


def published(job: dict, made: list) -> list:
    """Hold mid-job publications through the same AUTO path as final fulfil, immediately after sync.
    Use explicit result refs; return the held card/version pairs."""
    from core import auto as AU
    from core import researcher as RS
    return AU.hold(job, RS.located(job["type"], made))


def __getattr__(name):
    if name in _EXPORTS:
        mod, attr = _EXPORTS[name]
        return getattr(importlib.import_module(mod), attr)
    if name == "runner":
        return importlib.import_module("runner")
    raise AttributeError(f"picker.sdk has no {name!r}")


def config():
    from core import config as C
    return C.get()


def sync(type_: str) -> None:
    from core import researcher as RS
    RS.sync(type_)


def sync_lock(type_: str):
    from core import researcher as RS
    return RS.sync_lock(type_)


def store(type_: str):
    from core import stores as ST
    return ST.of_type(type_)


def card_dir(cid: str):
    from core import stores as ST
    return ST.card_dir(cid)


def jobs() -> dict:
    from core import queue as Q
    return Q.fold()
