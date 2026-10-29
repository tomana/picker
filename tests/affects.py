"""Unknown paths and shared helpers require all checks; Python changes require the full Python suite."""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PY = sorted(p for p in (HERE / "py").glob("test_*.py"))
WEB = sorted(p for p in HERE.glob("*.mjs") if re.match(r"(fx|t)\d", p.name))

NAMED = {                       # a page file → the checks that are about it
    "static/app/parts/walk.js": ["t32"],
    "static/app/parts/cup.js": ["t08", "t27"],
    "static/app/parts/timeline.js": ["t02", "t07"],
    "static/app/parts/settings.js": ["t13", "fx07", "t32"],
    "static/app/parts/voice.js": ["t03", "t28"],
    "static/app/page.js": ["fx05", "t01", "t30", "t31"],
    "static/app/dom.js": ["fx05", "t01", "t33"],
    "static/app/style.css": ["fx05", "t01", "t26"],
    "static/app/data.js": ["fx01", "fx06", "t01", "t30"],
    "static/band.js": ["t01"],
}
SKIP = re.compile(r"^(docs/|README|LICENSE|\.gitignore)")
PY_ALL = "PY"                   # the whole Python suite


def changed() -> list[str]:
    git = lambda *a: subprocess.run(["git", "-C", str(REPO), *a], capture_output=True, text=True).stdout.split()
    return sorted(set(git("diff", "--name-only", "HEAD")) | set(git("ls-files", "--others", "--exclude-standard")))


def diff_lines(path: str) -> str:
    r = subprocess.run(["git", "-C", str(REPO), "diff", "-U0", "HEAD", "--", path], capture_output=True, text=True)
    return "\n".join(l[1:] for l in r.stdout.splitlines() if l[:1] in "+-" and not l.startswith(("+++", "---")))


def by_import(mod: str) -> set[str]:
    """The test modules that import `mod` (core.signals → "signals"; a plugin file by its file name)."""
    name = mod.rsplit(".", 1)[-1]
    pat = re.compile(rf"(\bimport {name}\b|\bfrom \S+ import [^\n]*\b{name}\b|\b{re.escape(mod)}\b|{name}\.py)")
    return {p.stem for p in PY if pat.search(p.read_text(errors="replace"))}


def by_names(text: str) -> set[str]:
    """The browser checks that mention a class, a route or a function from these lines."""
    names = set(re.findall(r"(?:\.|el\(\"[a-z]*\.)([a-z][a-z0-9_-]{2,})", text))
    names |= set(re.findall(r"/api/[a-z_/]+", text))
    names |= set(re.findall(r"function ([A-Za-z_]\w{3,})", text))
    out = set()
    for n in names:
        hits = {p.name.split("-")[0] for p in WEB if n in p.read_text(errors="replace")}
        if 0 < len(hits) <= 6:
            out |= hits
    return out


def affects(paths: list[str]) -> tuple[set[str], set[str], list[str]]:
    py, web, unknown = set(), set(), []
    for f in paths:
        if SKIP.match(f):
            continue
        p = Path(f)
        if re.match(r"tests/(fx|t)\d.*\.mjs$", f):
            web.add(p.name.split("-")[0])
        elif f.startswith("tests/py/") and f.endswith(".py"):
            py.add(PY_ALL)
        elif f.endswith(".py") and (f.startswith(("core/", "api/")) or f == "server.py"):
            py.add(PY_ALL)
            if f.startswith("api/"):
                web |= by_names(diff_lines(f))
        elif f in NAMED:
            web |= set(NAMED[f])
            web |= by_names(diff_lines(f))
        else:
            unknown.append(f)          # Unclassified shared helpers require all checks.
    return py, web, unknown


def main() -> int:
    paths = sys.argv[1:] or changed()
    py, web, unknown = affects(paths)
    if unknown:
        print("ALL")
        print("ALL")
        print(f"(can't place: {', '.join(unknown)})", file=sys.stderr)
        return 0
    print(PY_ALL if py else "")
    print(" ".join(sorted(web)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
