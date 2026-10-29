"""Snapshot supplied text by hash, not mutable path contents; tools retain input hashes.
Receipt failures must never fail the work."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from . import config as C


def _root(root: Path | None = None) -> Path:
    return Path(root) if root else C.get().data / "receipts"


def keep(text: str, root: Path | None = None) -> str:
    """The text, kept once by its hash; returns the hash."""
    b = text.encode("utf-8", "replace")
    h = hashlib.sha256(b).hexdigest()
    p = _root(root) / "text" / h
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{h}.{uuid.uuid4().hex}.tmp")      # its own name: two jobs may keep the same text at once
        tmp.write_bytes(b)
        os.replace(tmp, p)
    return h


def text(h: str, root: Path | None = None) -> str | None:
    if not h or not all(c in "0123456789abcdef" for c in h):
        return None
    p = _root(root) / "text" / h
    return p.read_text(errors="replace") if p.is_file() else None


def _files(entries: list[dict], root: Path | None) -> list[dict]:
    """The supplied files, each with its text kept by hash (a file that can't be read is said to be missing)."""
    out = []
    for e in entries:
        p = e.get("abs")
        row = {k: v for k, v in e.items() if k != "abs"}
        if p and not e.get("missing"):
            try:
                row["sha256"] = keep(Path(p).read_text(errors="replace"), root)
            except OSError:
                row["missing"] = True
        out.append(row)
    return out


def start(*, job: str | None, attempt: int | None, type_: str | None, agent: str, cli: str, model, effort,
          argv: list, cwd: Path, prompt: str, files: list[dict], manifest: Path | None = None,
          root: Path | None = None) -> dict:
    """A receipt for an invocation about to run; returns it (its `id` is the invocation id). `files` are the supplied
    instruction files ({path, why, abs}); `argv` the command as run, the prompt replaced by its hash."""
    rid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    rec = {"id": rid, "job": job, "attempt": attempt, "type": type_, "started": time.time(),
           "agent": agent, "cli": cli, "model": model, "effort": effort,
           "cwd": str(cwd), "prompt": {"sha256": keep(prompt, root), "chars": len(prompt)},
           "argv": argv, "files": _files(files, root)}
    if manifest is not None:
        try:
            rec["manifest"] = {"path": str(manifest), "sha256": keep(Path(manifest).read_text(), root)}
        except OSError:
            rec["manifest"] = {"path": str(manifest), "missing": True}
    _write(rec, root)
    return rec


@contextlib.contextmanager
def tool(name: str, *, inputs: dict | None = None, argv: list | None = None, cwd: Path | None = None,
         files: list | None = None, root: Path | None = None):
    """Capture inputs with bound job/attempt/type context; receipt failures never fail the tool."""
    from . import queue as Q
    from . import trace as T
    rec = None
    try:
        job = T.token("job")
        rid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        hashed = []
        for f in files or []:
            try:
                hashed.append({"path": str(f), "sha256": hashlib.sha256(Path(f).read_bytes()).hexdigest()})
            except OSError:
                hashed.append({"path": str(f), "missing": True})
        rec = {"id": rid, "job": job, "attempt": (Q.get(job) or {}).get("attempts") if job else None,
               "type": T.token("type"), "started": time.time(), "tool": name,
               "argv": [str(a) for a in argv] if argv else None, "cwd": str(cwd) if cwd else None,
               "inputs": json.loads(json.dumps(inputs or {}, default=str)), "input_files": hashed}
        _write(rec, root)
    except Exception as e:                       # noqa: BLE001  a receipt must never fail the work
        with contextlib.suppress(Exception):     # nor its report (trace.emit never raises; this says so here too)
            T.emit("receipts", "receipt.failed", tool=name, error=f"{type(e).__name__}: {e}"[:200])
        rec = None
    try:
        yield rec
    except BaseException as e:
        if rec is not None:
            with contextlib.suppress(Exception):
                finish(rec, ok=False, why=f"{type(e).__name__}: {e}", root=root)
        raise
    if rec is not None:
        with contextlib.suppress(Exception):
            finish(rec, ok=True, root=root)


def finish(rec: dict, *, ok: bool, exit_code=None, why: str | None = None, root: Path | None = None) -> None:
    rec.update(ended=time.time(), ok=bool(ok), exit=exit_code, **({"why": why[:400]} if why else {}))
    _write(rec, root)


def _write(rec: dict, root: Path | None) -> None:
    d = _root(root) / (rec.get("job") or "_nojob")
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{rec['id']}.json"
    tmp = p.with_name(f".{p.name}.tmp")
    tmp.write_text(json.dumps(rec, indent=1, ensure_ascii=False) + "\n")
    os.replace(tmp, p)


def of_job(job: str, root: Path | None = None) -> list[dict]:
    d = _root(root) / job
    if not job or "/" in job or not d.is_dir():
        return []
    out = []
    for p in sorted(d.glob("*.json")):
        try:
            out.append(json.loads(p.read_text()))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda r: r.get("started") or 0)
