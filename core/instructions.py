"""Distinguish CLI-loaded instructions from brief-referenced files."""
from __future__ import annotations

import re
from pathlib import Path

from . import config as CONFIG

ROOT = CONFIG.get().research
HOME = Path.home()


def _file(p: Path, why: str) -> dict:
    try:
        st = p.stat()
        lines = p.read_text(errors="replace").count("\n")
    except OSError:
        return {"path": _show(p), "why": why, "missing": True, "abs": str(p)}
    return {"path": _show(p), "why": why, "bytes": st.st_size, "lines": lines,
            "tokens": st.st_size // 4, "abs": str(p)}


def _show(p: Path) -> str:
    p = Path(p)
    try:
        return str(p.relative_to(ROOT))
    except ValueError:
        return "~/" + str(p.relative_to(HOME)) if p.is_relative_to(HOME) else str(p)


def _chain(cwd: Path, top: Path) -> list[Path]:
    out, d = [], cwd.resolve()
    while True:
        out.append(d)
        if d == top or d == d.parent:
            return out
        d = d.parent


# Mark unverified instruction-loading conventions as such; do not present assumed CLI behavior as observed.
def instruction_files(cli: str, cwd: Path) -> dict:
    files, note = [], None
    if cli == "claude":
        for d in reversed(_chain(cwd, Path("/"))):
            for n in ("CLAUDE.md", "CLAUDE.local.md"):
                if (d / n).is_file():
                    files.append(_file(d / n, f"{n} in a parent of the agent's cwd"))
        if (HOME / ".claude/CLAUDE.md").is_file():
            files.insert(0, _file(HOME / ".claude/CLAUDE.md", "user memory, every session"))
    elif cli == "codex":
        if (HOME / ".codex/AGENTS.md").is_file():
            files.append(_file(HOME / ".codex/AGENTS.md", "user instructions"))
        for d in reversed(_chain(cwd, ROOT)):
            if (d / "AGENTS.md").is_file():
                files.append(_file(d / "AGENTS.md", "AGENTS.md from the git root down to cwd"))
    else:
        note = f"{cli}'s loading convention is assumed, not verified"
        for d in reversed(_chain(cwd, ROOT)):
            for n in ("GEMINI.md", "AGENTS.md"):
                if (d / n).is_file():
                    files.append(_file(d / n, f"{n} (assumed)"))
        if (HOME / ".gemini/GEMINI.md").is_file():
            files.insert(0, _file(HOME / ".gemini/GEMINI.md", "user instructions (assumed)"))
    return {"files": files, **({"note": note} if note else {})}


def referenced(brief: str, cwd: Path) -> list[dict]:
    """Files the brief tells the agent to read, that exist; the instructions it is
    SENT to, as opposed to the ones its CLI loads by itself."""
    out, seen = [], set()
    for m in re.finditer(r"[\w./-]+\.(?:md|jsonl?)\b", brief):
        p = (cwd / m.group(0)).resolve()
        if p in seen or not p.is_file():
            continue
        seen.add(p)
        out.append(_file(p, "named in the brief"))
    return out
