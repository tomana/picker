"""One signal fold shared by HTTP readers and runners, without an HTTP dependency."""
import bisect
import json
from pathlib import Path


def read(card_dir: Path) -> list[dict]:
    """A card's signals, oldest first; malformed lines skipped."""
    p = Path(card_dir) / "signals.jsonl"
    out = []
    if p.is_file():
        for line in p.read_text(errors="replace").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def fold(signals: list[dict]) -> dict:
    """Votes/archives overwrite by scope; item voices use version/item/voice, unscoped voices span versions.
    Other signals accumulate; part archives remove playback without deleting files."""
    out = {"vote": 0, "archived": False, "comments": 0, "attachments": [],
           "_versions": {}, "_voices": {}, "_scoped": {}, "_held": {}, "_up": set(), "face": None,
           "trim": None, "_vote_ts": 0, "_versions_ts": {}}
    pools: dict = {}
    for s in signals:
        k = s.get("kind")
        voice = s.get("voice")
        if voice is not None and s.get("item") is not None and k in ("vote", "archive"):
            at = out["_scoped"].setdefault(scope_key(s.get("version"), s["item"], voice), {})
            if k == "vote":
                at["vote"] = s.get("value", 0)
            else:
                at["archived"] = bool(s.get("value", True))
            continue
        if k == "vote":
            if voice is not None:
                out["_voices"].setdefault(voice, {})["vote"] = s.get("value", 0)
            elif s.get("version") is not None:
                out["_versions"][s["version"]] = s.get("value", 0)
                out["_versions_ts"][s["version"]] = s.get("ts") or 0
                if (s.get("value") or 0) > 0:     # ever voted up: a held version is IN
                    out["_up"].add(str(s["version"]))
            else:
                out["vote"] = s.get("value", 0)
                out["_vote_ts"] = s.get("ts") or 0
        elif k == "archive":
            if voice is not None:
                out["_voices"].setdefault(voice, {})["archived"] = bool(s.get("value", True))
            else:
                out["archived"] = bool(s.get("value", True))
        elif k == "comment":
            out["comments"] += 1
        elif k == "attach":
            out["attachments"].append(s.get("value"))
        elif k == "face":
            # The selected render slug is last-write-wins.
            out["face"] = s.get("value") or None
        elif k == "trim":
            # Trim is last-write-wins; null selects the whole recording.
            out["trim"] = s.get("value") or None
        elif k == "pool":
            # Pool membership is last-write-wins per pool; false removes membership.
            pools[s.get("pool") or "auto"] = bool(s.get("value", True))
        elif k == "held" and s.get("version") is not None:
            # Hold published versions out of the stack until their first upvote.
            out["_held"][s["version"]] = s.get("ts")
    out["pools"] = sorted(k for k, v in pools.items() if v)
    return out


def scope_key(version, item, voice) -> str:
    return f"{version}|{item}|{voice}"


def voice_state(folded: dict, version, item, voice) -> dict:
    """Overlay this version/item's voice state on the card-wide state, never another item's state."""
    return {**((folded.get("_voices") or {}).get(voice) or {}),
            **((folded.get("_scoped") or {}).get(scope_key(version, item, voice)) or {})}


def hidden(folded: dict) -> set:
    """Hold versions out until their first upvote; once admitted, later downvotes never hide them again."""
    up = folded.get("_up") or set()
    out = set()
    for n in (folded.get("_held") or {}):
        if str(n) not in up:
            try:
                out.add(int(n))
            except (TypeError, ValueError):
                pass
    return out


def one_vote(folded: dict, n) -> int:
    """For a single visible version, the newer card/version vote wins.
    Admission after an upvote is permanent even if its score later changes."""
    vv, vts = folded.get("_versions") or {}, folded.get("_versions_ts") or {}
    if n not in vv and str(n) not in vv:
        return int(folded.get("vote") or 0)
    v = int(vv.get(n, vv.get(str(n))) or 0)
    return v if (vts.get(n, vts.get(str(n), 0)) or 0) >= (folded.get("_vote_ts") or 0) else int(folded.get("vote") or 0)


def rating(folded: dict, version_ns: list) -> int:
    """Use the best visible version, ignoring held tries; unvoted versions count zero.
    Preserve card-level votes when no versions were voted or only one is visible."""
    votes = folded.get("_versions") or {}
    out = hidden(folded)
    ns = [n for n in version_ns if n is not None and str(n) not in {str(x) for x in out}]
    if len(ns) == 1:
        return one_vote(folded, ns[0])
    if len(ns) > 1 and votes:
        return max(int(votes.get(n, votes.get(str(n), 0)) or 0) for n in ns)
    return int(folded.get("vote") or 0)


EAR = 0.75          # from here the page marks a card "ear" (parts/ab.js): a reason beyond "not heard yet"


def need(cards: list[dict]) -> dict[str, dict]:
    """Calibrate newest scores per score/group using all votes, including archives; write nothing.
    Heard cards need none; doubts raise need, absent scores are neutral, material-only cards wait last."""
    def oriented(sc):
        v = sc.get("value")
        return None if v is None else (float(v) if sc.get("lower_is_better", True) else -float(v))

    def key(sc):
        return (sc.get("name"), sc.get("group"))

    def heard_vote(c, v):
        if len(c.get("versions") or []) == 1:
            return int(v.get("vote") if v.get("vote") is not None else c.get("vote") or 0)
        return int(v.get("vote") or 0)

    ups, downs, pending = {}, {}, {}
    for c in cards:
        for v in c.get("versions") or []:
            sc = v.get("score") or {}
            s = oriented(sc)
            if s is None:
                continue
            vote = heard_vote(c, v)
            if vote > 0:
                ups.setdefault(key(sc), []).append(s)
            elif vote < 0:
                downs.setdefault(key(sc), []).append(s)
    faces = {c["id"]: (c.get("versions") or [{}])[-1] for c in cards if c.get("id")}
    for c in cards:
        v = faces.get(c.get("id")) or {}
        sc = v.get("score") or {}
        if not c.get("archived") and not heard_vote(c, v) and oriented(sc) is not None:
            pending.setdefault(key(sc), []).append(oriented(sc))
    # Sort calibration bars and unheard scores once per group to avoid near-quadratic per-card work.
    acc_of = {k: max(x) for k, x in ups.items() if x}
    rej_of = {k: min(x) for k, x in downs.items() if x}
    ranked = {k: sorted(x) for k, x in pending.items()}
    out = {}
    for c in cards:
        cid, v = c.get("id"), faces.get(c.get("id")) or {}
        if c.get("archived"):
            out[cid] = {"value": 0.0, "why": ["archived"]}
            continue
        if heard_vote(c, v):
            out[cid] = {"value": 0.0, "why": ["heard: voted"]}
            continue
        sc = v.get("score") or {}
        s, name = oriented(sc), sc.get("name") or "score"
        low = sc.get("lower_is_better", True)
        # Restore the research score's original orientation and sign.
        show = lambda x: f"{(x if low else -x):g}"           # noqa: E731
        if s is None and not v.get("parts"):
            # Material-only versions have nothing to judge and sort after cards with a generated try.
            val, why = 0.05, ["nothing made yet"]
        elif s is None:
            val, why = 0.5, ["not heard yet"]
        else:
            k = key(sc)
            acc, rej = acc_of.get(k), rej_of.get(k)
            peers = ranked.get(k) or [s]
            pct = bisect.bisect_left(peers, s) / (len(peers) - 1) if len(peers) > 1 else 0.5
            if acc is not None and rej is not None and rej <= s <= acc:
                val, why = 0.8, [f"your votes and the {name} disagree here ({show(rej)}–{show(acc)})"]
            elif acc is not None and s <= acc:
                val, why = 0.15, [f"as good as what you've voted up ({name} {show(s)}, up to {show(acc)})"]
            elif rej is not None and s >= rej:
                val, why = 0.5, [f"as far off as one you voted down ({name} {show(s)}, from {show(rej)})"]
            elif acc is not None and rej is not None:
                val, why = 0.8, [f"between what you've voted up ({show(acc)}) and down ({show(rej)})"]
            elif acc is not None:
                val, why = 0.5 + 0.3 * pct, [f"worse than any you've voted up ({name} {show(s)} "
                                             f"{'>' if low else '<'} {show(acc)})"]
            else:
                val, why = 0.3 + 0.4 * pct, [f"not heard yet ({name} {show(s)})"]
        doubts = [d for d in v.get("doubts") or [] if isinstance(d, str)]
        if doubts:                                          # a doubt is a reason to listen: at least the ear's mark
            val = max(val + 0.2 * len(doubts), EAR)
        out[cid] = {"value": round(min(1.0, val), 2), "why": why + doubts}
    return out
