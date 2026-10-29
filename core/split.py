"""Plugins move/copy versions; core syncs and carries votes and pools.
Append corrected votes after renumbering and clear vacated numbers; v1 cannot move."""
import json

from . import config as C
from . import jsonl as J
from . import plugins as P
from . import researcher as RS
from . import signals as SIG
from . import stores as ST
from .plugins import Refused


def _plugin(card: dict, what: str):
    """The type's `what` (split, duplicate, merge): its manifest's capability and its plugin's function."""
    fn = P.call(card.get("type"), what) if C.capability(card.get("type"), what) else None
    if fn is None:
        word = {"split": "split", "duplicate": "duplicated", "merge": "merged"}[what]
        raise Refused(f"a {card.get('type')} card cannot be {word} here")
    return fn


def _no_held(cid: str) -> None:
    """Refuse renumbering with held tries; number-keyed holds could otherwise expose an unadmitted try."""
    h = SIG.hidden(SIG.fold(SIG.read(ST.card_dir(cid))))
    if h:
        raise Refused(f"{cid} has tries AUTO is holding until you vote on them "
                      f"(v{', v'.join(str(n) for n in sorted(h))}) — vote them in or down first")


def _carry_pools(cid: str, new: str, why: str) -> None:
    """Carry source pools to splits and duplicates through ordinary removable signals."""
    if (ST.card_dir(new)).is_dir():
        for pool in SIG.fold(SIG.read(ST.card_dir(cid))).get("pools") or []:
            J.append_jsonl(ST.card_dir(new) / "signals.jsonl",
                           {"kind": "pool", "pool": pool, "value": True, "by": f"{why}, in the {pool} pool"})


def split(cid: str, version: int, *, busy: bool = False) -> str:
    """Move version `version` of stack `cid` into a new stack. Returns its card id.
    `busy`: a job is working on this stack right now; refused, it is writing here."""
    f = ST.card_dir(cid) / "card.json"
    if not f.is_file():
        raise Refused(f"no card {cid!r}")
    card = json.loads(f.read_text())
    vs = card.get("versions") or []
    n = len(vs)
    fn = _plugin(card, "split")
    if busy:
        raise Refused("an agent is working on this stack right now — try when it is done")
    _no_held(cid)
    if n < 2:
        raise Refused("one version is already a stack of its own")
    if not 2 <= version <= n:
        raise Refused(f"v{version}: only v2…v{n} can be taken out — v1 is the stack")
    # the votes before anything moves, by number
    folded = SIG.fold(SIG.read(ST.card_dir(cid)))
    votes = folded.get("_versions") or {}
    vote_of = lambda m: int(votes.get(m, votes.get(str(m), 0)) or 0)

    new = fn(card, version, P.services())
    RS.sync(card["type"])

    sig_old = ST.card_dir(cid) / "signals.jsonl"
    for m in range(version + 1, n + 1):                  # v(m) is v(m-1) now
        if vote_of(m) != vote_of(m - 1) or m - 1 == version:
            J.append_jsonl(sig_old, {"kind": "vote", "version": m - 1, "value": vote_of(m),
                                     "by": f"split: v{version} out"})
    if vote_of(n):
        J.append_jsonl(sig_old, {"kind": "vote", "version": n, "value": 0,
                                 "by": f"split: v{version} out"})
    if vote_of(version) and (ST.card_dir(new)).is_dir():
        J.append_jsonl(ST.card_dir(new) / "signals.jsonl",
                       {"kind": "vote", "value": vote_of(version),
                        "by": f"split from {cid} v{version}"})
    _carry_pools(cid, new, f"split from {cid} v{version}")
    return new


# Copy renders with the selected version so the new stack appears immediately.
# Start with no votes/comments; preserve the source as parent and leave it untouched.

def duplicate(cid: str, version: int) -> str:
    """Copy version `version` of card `cid` into a new stack. Returns its card id."""
    f = ST.card_dir(cid) / "card.json"
    if not f.is_file():
        raise Refused(f"no card {cid!r}")
    card = json.loads(f.read_text())
    n = len(card.get("versions") or [])
    fn = _plugin(card, "duplicate")
    _no_held(cid)
    if not 1 <= version <= n:
        raise Refused(f"{cid} has no v{version}")
    new = fn(card, version, P.services())
    RS.sync(card["type"])
    _carry_pools(cid, new, f"copied from {cid} v{version}")
    return new


# The first stack keeps its id; plugin code appends versions in order.
# Votes follow renumbered versions; pools follow if any input belonged.

def merge(cids: list[str], *, busy=lambda cid: False) -> str:
    """Merge stacks `cids` (in order) into the first. Returns its id."""
    cids = list(dict.fromkeys(cids))
    if len(cids) < 2:
        raise Refused("name two stacks or more")
    cards = []
    for cid in cids:
        f = ST.card_dir(cid) / "card.json"
        if not f.is_file():
            raise Refused(f"no card {cid!r}")
        c = json.loads(f.read_text())
        if busy(cid):
            raise Refused(f"an agent is working on {cid} right now — try when it is done")
        _no_held(cid)
        cards.append(c)
    if len({c.get("type") for c in cards}) != 1:
        raise Refused("the stacks are of different types")
    fn = _plugin(cards[0], "merge")
    # the votes and the pools, before anything moves: by (stack, version number)
    old = []
    pools = set()
    for c in cards:
        folded = SIG.fold(SIG.read(ST.card_dir(c["id"])))
        pools |= set(folded.get("pools") or [])
        vv = folded.get("_versions") or {}
        for v in c.get("versions") or []:
            old.append(int(vv.get(v["n"], vv.get(str(v["n"]), 0)) or 0))
    root = fn(cards, P.services())
    RS.sync(cards[0]["type"])
    sig = ST.card_dir(root) / "signals.jsonl"
    for n, vote in enumerate(old, start=1):
        if vote:
            J.append_jsonl(sig, {"kind": "vote", "version": n, "value": vote,
                                 "by": f"merged {'+'.join(cids)}"})
    for pool in sorted(pools - set(SIG.fold(SIG.read(ST.card_dir(root))).get("pools") or [])):
        J.append_jsonl(sig, {"kind": "pool", "pool": pool, "value": True, "by": f"merged {'+'.join(cids)}"})
    return root
