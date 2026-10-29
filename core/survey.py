"""Survey due pool cards without changing them; validate an explicit revision order.
Large pools go in a file to avoid per-argument size limits."""
from __future__ import annotations

import fcntl
import json
import os
import time
from pathlib import Path

from . import config as C
from . import queue as Q
from . import signals as SIG
from . import stores as ST

ROOT = Q.ROOT
NAME = "auto_survey.jsonl"                         # each type's, beside its cards (core/stores.py)
MAX_REPORT = 6000
INLINE = 200                                       # pool cards listed in the brief itself; more go to the pool file


def _entry(type_: str) -> dict:
    return next((t for t in C.types() if t["type"] == type_), {})



def store_cards(type_: str, store: Path) -> list[dict]:
    """The type's cards as AUTO's rule reads them (core/auto.look), from the store: the runner has no API. card.json
    with its signals folded; archived, pools, the rating; and the held versions out of `versions`."""
    out = []
    for f in sorted(store.glob("*/card.json")):
        try:
            c = json.loads(f.read_text())
        except Exception:
            continue
        if c.get("type") != type_:
            continue
        s = SIG.fold(SIG.read(f.parent))
        held, votes = SIG.hidden(s), s["_versions"]
        vs = c.get("versions") or []
        out.append({**c, "archived": s["archived"], "pools": s["pools"], "vote": SIG.rating(s, [v.get("n") for v in vs]),
                    "versions": [{**v, "vote": votes.get(v.get("n"))} for v in vs if v.get("n") not in held]})
    return out


def _row(c: dict, store: Path, last_auto: float | None) -> dict:
    part = ((c["versions"][-1].get("parts") or [{}])[0]) or {}
    return {"card": c["id"], "label": c.get("label") or c["id"], "versions": len(c["versions"]), "part": part.get("id"),
            "node": part.get("mode"),
            "frag": str((store / c["id"] / part["src"]).resolve()) if part.get("src") else None,
            "vote": c.get("vote") or 0, "last_auto": last_auto}



def answer_path(job: dict, here: Path) -> Path:
    """In the runner's folder, inside the agent's working folder, where every CLI's sandbox lets it write."""
    return Path(here) / "logs" / f"survey_{job['id']}.json"


def pool_path(job: dict, here: Path) -> Path:
    return Path(here) / "logs" / f"survey_{job['id']}_pool.txt"


def brief(job: dict, entry: dict, cards: list[dict], *, cwd: Path, here: Path,
          now: float | None = None, store: Path | None = None) -> str:
    """The survey's brief. A pool of more than INLINE cards is written to the pool file, one card a line, and the
    brief points at it and at the cards' folders."""
    now = now or time.time()
    crit = (job.get("text") or "").strip()
    rel = lambda p: os.path.relpath(p, cwd) if p else None

    def row(c):
        what = (f"node {c['node']} (a C++ mode; see src/nodes/mode/)" if c["node"]
                else f"paint {rel(c['frag'])}" if c["frag"] else "no shader")
        ago = (f"auto-revised {int((now - c['last_auto']) / 3600)} h ago" if c["last_auto"]
               else "never auto-revised")
        return (f"  - {c['card']} «{c['label']}» — newest v{c['versions']} = {c['part']} — "
                f"{what} — rating {c['vote']:+d} — {ago}\n")
    tools = entry.get("survey_tools") or []
    rows = "".join(row(c) for c in cards)
    if len(cards) > INLINE:
        pf = pool_path(job, here)
        pf.parent.mkdir(parents=True, exist_ok=True)
        pf.write_text(rows)
        store = Path(store or ST.of_type(job["type"]))
        pool = (f"THE AUTO POOL ({len(cards)} cards; each is a stack, revised at its newest version) is too big "
                f"to list here: one card a line in\n  {rel(pf)}\nand each card's own file is "
                f"{rel(store)}/<card id>/card.json — read them with a script.\n")
    else:
        pool = (f"THE AUTO POOL ({len(cards)} cards; each is a stack, revised at its newest version):\n" + rows)
    return (
        f"You are the PICKING phase of auto revise for {entry.get('label', job['type'])} — "
        f"{entry.get('about', '')}. Auto revise works through the operator's AUTO POOL one "
        f"card at a time; you decide the ORDER, by the operator's criterion:\n\n"
        f"  «{crit}»\n\n"
        "This is a SURVEY. Measure and investigate as the criterion needs: run the tools, "
        "read shaders and node sources, compare. Do NOT change any card, shader, source or "
        "data file, do not build, and make no new mode. Start the app only through the tools "
        "listed below (they boot their own marked instance on a replay and wait for the "
        "operator's, never kill it). The only file you write is the answer below.\n\n"
        + pool
        + ("\nTOOLS (run from the working folder):\n"
           + "".join(f"  - {t}\n" for t in tools) if tools else "")
        + (f"\nFor the medium's vocabulary you may read {entry['program']} (path from the "
           f"repository root).\n" if entry.get("program") else "")
        + f"\nWrite ONLY this file, as JSON:\n  {answer_path(job, here)}\n"
        '  {"order": [{"card": "<card id as listed>", "why": "<one line: why it is here '
        'in the order, with the number that put it there, if any>"}, …],\n'
        '   "report": "<what you measured or found — plain text, at most ~40 lines>"}\n'
        "The order is the cards worth revising under the criterion, the first one first; "
        "leave out the cards the criterion says to leave alone. Then reply with one word: DONE"
    )



def read_answer(job: dict, here: Path, cards: list[dict]) -> tuple[list[dict], str]:
    """Validate order/report, accepting listed card ids or a version's part id.
    Drop unknowns and repeats; malformed answers raise so failure is visible."""
    p = answer_path(job, here)
    if not p.is_file():
        raise RuntimeError(f"the agent wrote no survey file ({p.name})")
    try:
        data = json.loads(p.read_text())
    except Exception as e:
        raise RuntimeError(f"{p.name} is not JSON: {e}") from e
    items = data.get("order") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise RuntimeError(f'{p.name} has no "order" list')
    by = {c["card"]: c["card"] for c in cards}
    by.update({c["part"]: c["card"] for c in cards if c.get("part")})
    order, seen = [], set()
    for it in items:
        cid = by.get(str((it or {}).get("card") if isinstance(it, dict) else it))
        if cid and cid not in seen:
            seen.add(cid)
            order.append({"card": cid,
                          "why": str((it.get("why") if isinstance(it, dict) else "") or "")[:300]})
    report = str(data.get("report") or "")[:MAX_REPORT]
    return order, report



def _append(rec: dict, root: Path | None = None) -> None:
    p = ST.log(NAME, type_=rec["type"], root=root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"ts": time.time(), **rec}, ensure_ascii=False) + "\n")
        fcntl.flock(f, fcntl.LOCK_UN)


def record(job: dict, order: list[dict], report: str, root: Path | None = None, *, pool=None) -> None:
    _append({"event": "survey", "job": job["id"], "type": job["type"],
             "criterion": (job.get("text") or "").strip(), "order": order,
             "report": report, "agent": job.get("backend"), "pool": pool, "asked": job.get("created")}, root)


def latest(type_: str, root: Path | None = None) -> dict | None:
    p = ST.log(NAME, type_=type_, root=root)
    if not p.is_file():
        return None
    out = None
    for line in p.read_text().splitlines():
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if rec.get("type") != type_:
            continue
        if rec.get("event") == "survey":
            out = rec
    return out



def fulfil(job: dict, who: str, cwd: Path, here: Path, report, *, prefix=(), root: Path | None = None,
           store: Path | None = None) -> None:
    """Work one `survey` job: the due cards (core/auto.look), the brief, the agent, the check, the record.
    Nothing is made; auto revise reads the order."""
    from . import agents as A
    from . import auto as AU
    type_ = job["type"]
    entry = _entry(type_)
    report("reading the auto pool")
    jobs = list(Q.fold(root).values())
    store = Path(store or ST.of_type(type_))
    t = AU.tab(AU.settings(), type_)
    lk = AU.look(type_, store_cards(type_, store), jobs, kind=AU.kind_for(type_, t["kinds"], jobs), since=t["since"],
                 card_dir=lambda cid: store / cid)
    if not lk.due:
        raise RuntimeError("no card in the auto pool that AUTO may take now — nothing to put in order")
    had = AU.had(type_, jobs)
    cards = [_row(c, store, had.get(c["id"])) for c in lk.due]
    answer_path(job, here).parent.mkdir(parents=True, exist_ok=True)
    report(f"{who} surveying {len(cards)} cards")
    A.run_job(who, brief(job, entry, cards, cwd=Path(cwd), here=here, store=store), cwd,
              here / "logs" / f"queue_{job['id']}.log", prefix=prefix, model=job.get("model"))
    order, rep = read_answer(job, here, cards)
    # Validate the order against the whole pool scope, not only the due subset sent to the agent.
    record(job, order, rep, root, pool=lk.scope)
    report(f"{len(order)} of {len(cards)} cards in order")
