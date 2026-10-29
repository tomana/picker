"""Replay frozen decisions; never archive or restore cards.
The bracket, not a separate completion flag, determines the winner."""
import fcntl
import json
import time
import uuid
from pathlib import Path

from . import stores as ST

NAME = "cup.jsonl"                                # each type's, beside its cards (core/stores.py)

GROUP = 5           # at most this many in a group; five tiles fit a phone
ADVANCE = 2         # how many leave each group


def _append(rec: dict, root: Path | None = None, *, type_: str | None = None) -> None:
    """A round's line: its `open` to its type's log, the rest where its `open` went."""
    rec = {**rec, "ts": time.time()}
    p = ST.log(NAME, type_=type_, id_=rec.get("id"), root=root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)


# Require already-folded cards; archive and vote are signal state, not raw card fields.


def judgeable_of(cards: list[dict]) -> list[str]:
    """Use folded visible cards with playable/visible content; never restore archives or archive losers.
    Only the decision log is written here."""
    out = []
    for c in cards:
        if c.get("archived"):
            continue
        # Recordings are source material, not pieces to judge.
        if (c.get("origin") or {}).get("kind") == "recording":
            continue
        has_media = bool(c.get("media") or {})
        has_audio = any(p.get("audio") for v in (c.get("versions") or [])
                        for p in (v.get("parts") or []))
        if has_media or has_audio:
            out.append(c["id"])
    return out


def seed(cards: list[dict], *, group: int = GROUP) -> list[list[str]]:
    """Snake strongest-first seeds across groups so the strongest cards do not eliminate each other immediately."""
    order = sorted(cards, key=lambda c: (-(c.get("vote") or 0),
                                         c.get("created") or 0, c["id"]))
    n = max(1, -(-len(order) // group))          # ceil
    groups: list[list[str]] = [[] for _ in range(n)]
    i, fwd = 0, True
    for c in order:
        groups[i].append(c["id"])
        if fwd:
            i += 1
            if i == n:
                i, fwd = n - 1, False
        else:
            i -= 1
            if i < 0:
                i, fwd = 0, True
    return [g for g in groups if g]



def bracket(advancers: list[str], ko_log: list[dict]) -> dict:
    """Replay decisions to derive current duel and winner; never store a second position pointer.
    An odd round gives the bye to its top seed."""
    rounds, cur, duel = [], list(advancers), None
    decided = {}
    for d in ko_log:
        a, b, w = d.get("a"), d.get("b"), d.get("winner")
        if a and b and w:
            decided[frozenset((a, b))] = w
    guard = 0
    while len(cur) > 1 and guard < 64:
        guard += 1
        pairs, nxt = [], []
        rest = cur
        if len(rest) % 2:
            nxt.append(rest[0])                  # the bye, to the top seed
            rest = rest[1:]
        for i in range(0, len(rest), 2):
            a, b = rest[i], rest[i + 1]
            w = decided.get(frozenset((a, b)))
            pairs.append({"a": a, "b": b, "winner": w})
            if w is None and duel is None:
                duel = {"a": a, "b": b}
            if w:
                nxt.append(w)
        rounds.append(pairs)
        if any(p["winner"] is None for p in pairs):
            # This round is unfinished, so there is no next one to draw yet.
            return {"rounds": rounds, "duel": duel, "winner": None}
        cur = nxt
    return {"rounds": rounds, "duel": None,
            "winner": cur[0] if len(cur) == 1 else None}


def ranking(groups: list[list[str]], advancers: list[str],
            rounds: list[list[dict]]) -> list[tuple[int, str]]:
    """Return shared elimination places only after the final; no third-place match.
    Each losing round ranks after all advancing cards, including a bye."""
    if not rounds or len(rounds[-1]) != 1 or not rounds[-1][0].get("winner"):
        return []
    through, e = [], len(advancers)
    for r in rounds:
        e = len(r) + e % 2                   # its winners, and the bye of an odd round
        through.append(e)
    out = [(1, rounds[-1][0]["winner"])]
    for k in range(len(rounds) - 1, -1, -1):
        for p in rounds[k]:
            out.append((through[k] + 1, p["b"] if p["winner"] == p["a"] else p["a"]))
    ko = set(advancers)
    out += [(len(advancers) + 1, cid) for g in groups for cid in g if cid not in ko]
    return out



def open_cup(*, type: str, groups: list[list[str]],
             advance: int = ADVANCE, root: Path | None = None) -> str:
    cid = uuid.uuid4().hex[:12]
    _append({"event": "open", "id": cid, "type": type,
             "groups": groups, "advance": advance}, root, type_=type)
    return cid


def pick(cup_id: str, group: int, picks: list[str], *,
         root: Path | None = None) -> None:
    _append({"event": "pick", "id": cup_id, "group": int(group),
             "picks": list(picks)}, root)


def duel(cup_id: str, a: str, b: str, winner: str, *,
         root: Path | None = None) -> None:
    _append({"event": "duel", "id": cup_id, "a": a, "b": b,
             "winner": winner}, root)



def fold(root: Path | None = None) -> dict:
    out: dict[str, dict] = {}
    for line in _lines(root):
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        cid, ev = rec.get("id"), rec.get("event")
        if not cid:
            continue
        if ev == "open":
            out[cid] = {"id": cid, "ts": rec.get("ts"), "type": rec.get("type"),
                        "groups": rec.get("groups") or [],
                        "advance": rec.get("advance", ADVANCE),
                        "picks": {}, "ko_log": []}
            continue
        c = out.get(cid)
        if c is None:
            continue
        if ev == "pick":
            c["picks"][str(rec.get("group"))] = rec.get("picks") or []
        elif ev == "duel":
            c["ko_log"].append({"a": rec.get("a"), "b": rec.get("b"),
                                "winner": rec.get("winner"),
                                "ts": rec.get("ts")})
        elif ev == "abandon":
            out.pop(cid, None)
    return out


def _lines(root: Path | None):
    """Every type's log, one after another: a round's lines are all in one."""
    for p in ST.logs(NAME, root):
        if p.exists():
            for line in p.read_text().splitlines():
                if line.strip():
                    yield line


def state(cup_id: str, *, root: Path | None = None) -> dict | None:
    """Return the next undecided group or knockout pair; no decision remains after a winner exists."""
    c = fold(root).get(cup_id)
    if c is None:
        return None
    groups = c["groups"]
    adv = c.get("advance", ADVANCE)
    # A group of one or two has nothing to decide: everyone advances. Without
    # this the cup would stop and ask you to pick 2 of 2.
    auto = {str(i): list(g) for i, g in enumerate(groups) if len(g) <= adv}
    picks = {**auto, **c["picks"]}
    pending = next((i for i in range(len(groups)) if str(i) not in picks), None)
    if pending is not None:
        return {**c, "stage": "group", "winner": None,
                "next": {"group": pending, "cards": groups[pending],
                         "advance": min(adv, len(groups[pending]))},
                "done_groups": len(picks), "total_groups": len(groups)}
    advancers = [cid for i in range(len(groups)) for cid in picks[str(i)]]
    br = bracket(advancers, c["ko_log"])
    if br["winner"]:
        return {**c, "stage": "done", "winner": br["winner"], "next": None,
                "advancers": advancers, "rounds": br["rounds"],
                "done_groups": len(groups), "total_groups": len(groups)}
    return {**c, "stage": "ko", "winner": None,
            "next": {"duel": br["duel"]} if br["duel"] else None,
            "advancers": advancers, "rounds": br["rounds"],
            "done_groups": len(groups), "total_groups": len(groups)}


def cups(*, type: str | None = None, root: Path | None = None) -> list[dict]:
    rows = [state(c["id"], root=root) for c in fold(root).values()]
    rows = [r for r in rows if r and (type is None or r["type"] == type)]
    return sorted(rows, key=lambda r: r.get("ts") or 0, reverse=True)
