"""Wake due lanes and schedule eligible work through shared selection rules.
Quota waits belong to jobs, not the scheduler."""
from __future__ import annotations

import functools
import json
import random
import threading
import time
from pathlib import Path
from typing import Callable, NamedTuple

from . import autolog as AL
from . import config as C
from . import prefs as P
from . import queue as Q
from . import trace as T

DEFAULTS = {"on": False, "agent": "claude", "model": None, "types": [], "tabs": {}}   # model None: ⚙'s choice
# Kinds, keep, comment and criterion are per-tab; agent selection and quota limits remain shared.
TAB = {"kinds": ["revise"], "keep": False, "comment": "", "criterion": "", "since": 0}
# A pass restart makes every card due again from since.
KINDS = ("revise", "inspire")
MAX_CRITERION = 500
MAX_COMMENT = 2000
GROUP = "auto"
TICK = 60.0
TEXT = {
    "revise": ("Auto revise — the operator is not watching this one. Take the card further "
               "in the direction its votes point, and fix its weakest spot."),
    "inspire": ("Auto inspire — the operator is not watching this one. Make a new card from this one: its own "
                "step away, keeping what makes this one good."),
}

state: dict = {"why": "not started", "last": None, "ts": None, "of": {}}   # `of`: each tab's why


def settings(prefs: dict | None = None) -> dict:
    prefs = P.fold() if prefs is None else prefs
    got = prefs.get("auto") if isinstance(prefs.get("auto"), dict) else {}
    out = {**DEFAULTS, **{k: v for k, v in got.items() if k in DEFAULTS}}
    out["on"] = bool(out["on"])
    # Disabled AUTO retains no active tabs; stale saved selections must not restart unrelated work.
    out["types"] = [t for t in (out["types"] or []) if isinstance(t, str)] if out["on"] else []
    tabs = out["tabs"] if isinstance(out["tabs"], dict) else {}
    out["tabs"] = {t: clean_tab(v) for t, v in tabs.items() if isinstance(t, str)}
    return out


def tab(s: dict, type_: str) -> dict:
    return {**TAB, **((s.get("tabs") or {}).get(type_) or {})}


def clean_tab(v) -> dict:
    v = v if isinstance(v, dict) else {}
    kinds = v.get("kinds") if isinstance(v.get("kinds"), list) else TAB["kinds"]
    since = v.get("since")
    return {"kinds": [k for k in KINDS if k in kinds],
            "keep": bool(v.get("keep", TAB["keep"])),
            "comment": clean_comment(v.get("comment")),
            "criterion": clean_criterion(v.get("criterion")),
            "since": float(since) if isinstance(since, (int, float)) and not isinstance(since, bool) else 0}


def clean_criterion(v) -> str:
    return " ".join(str(v or "").split())[:MAX_CRITERION]


def clean_comment(v) -> str:
    """Kept as typed, line breaks and all (a list of steps reads as one), trimmed and capped."""
    lines = [" ".join(x.split()) for x in str(v or "").replace("\r", "").split("\n")]
    out = "\n".join(lines).strip()
    while "\n\n\n" in out:
        out = out.replace("\n\n\n", "\n\n")
    return out[:MAX_COMMENT]


def commented(text: str) -> str:
    if not text:
        return ""
    return ("\n\nTHE OPERATOR'S COMMENT — typed in the AUTO sheet, for every AUTO job on this tab: the direction "
            "to take this card. If it also says to do something, do it. Where it and the votes disagree, the "
            "comment wins:\n\n" + text)


def _say(why: str, type_: str | None = None, **fields) -> None:
    if state.get("why") != why:
        T.emit("auto", "auto.state", why=why, **({"type": type_} if type_ else {}), **fields)
    state.update(why=why, ts=time.time())
    if type_:
        state.setdefault("of", {})[type_] = why


POOL = "auto"


def eligible(type_: str, c: dict, kind: str) -> bool:
    """Use plugin eligibility; otherwise recordings only inspire.
    A wholly held card with no visible version is never selected."""
    if not c.get("versions"):
        return False
    from . import plugins as PG
    fn = PG.call(type_, "auto_eligible")
    if fn is not None:
        return bool(fn(c, kind))
    return kind == "inspire" or (c.get("origin") or {}).get("kind") != "recording"


def had(type_: str, jobs: list[dict]) -> dict:
    """Measure changes from the last claim, when context was read, not completion; open jobs hold the card.
    A cancel before claim uses enqueue time; failures and cancels still count as selections."""
    out: dict = {}
    for j in jobs:
        if j.get("group") == GROUP and j.get("type") == type_ and j.get("kind") in KINDS and j.get("card"):
            t = ((j.get("started") or j.get("created") or 0) if j["status"] in ("done", "failed", "cancelled")
                 else float("inf"))
            out[j["card"]] = max(out.get(j["card"], 0), t)
    return out


def signalled(d: Path) -> float:
    """Ignore AUTO's own held marks when finding the latest external signal."""
    try:
        lines = (d / "signals.jsonl").read_text().splitlines()
    except OSError:
        return 0.0
    for ln in reversed(lines):
        try:
            r = json.loads(ln)
        except ValueError:
            continue
        if r.get("kind") != "held":
            return float(r.get("ts") or 0)
    return 0.0


class Look(NamedTuple):
    pool: list          # the cards it may make the kind from
    scope: list | None  # what an order is checked against: the marked ids, sorted; None: every active card
    due: list           # the pool's cards it hasn't had since something changed (busy ones too)
    busy: set           # ids with a job open on them, any group: they wait their turn
    changed: Callable   # Card id maps to the latest external signal or completed manual job.


def look(type_: str, cards: list[dict], jobs: list[dict], *, kind: str = "revise", since: float = 0,
         card_dir=None) -> Look:
    """Share pool/due rules across random picks, ordered picks and surveys; marked cards override downvotes.
    Changes after the last read or pass restart make a card due; AUTO publication alone does not."""
    from . import stores as ST
    card_dir = card_dir or ST.card_dir
    active = [c for c in cards if c.get("type") == type_ and not c.get("archived")]
    marked = [c for c in active if POOL in (c.get("pools") or [])]
    pool = [c for c in marked or [c for c in active if (c.get("vote") or 0) >= 0 and not (
        c.get("versions") and all((v.get("vote") or 0) < 0 for v in c["versions"]))] if eligible(type_, c, kind)]
    theirs: dict = {}
    for j in jobs:
        if j.get("group") != GROUP and j.get("card") and j["status"] == "done":
            theirs[j["card"]] = max(theirs.get(j["card"], 0), j.get("ended") or 0)

    @functools.cache
    def changed(cid: str) -> float:          # a signal by when it was given, a job of theirs by when it ended
        return max(theirs.get(cid, 0), signalled(card_dir(cid)))
    h = had(type_, jobs)
    due = [c for c in pool if c["id"] not in h
           or (h[c["id"]] != float("inf") and max(since, changed(c["id"])) > h[c["id"]])]
    return Look(pool=pool, scope=sorted(c["id"] for c in marked) or None, due=due, changed=changed,
                busy={j.get("card") for j in jobs if j.get("status") in (*Q.LIVE, "paused")})


def pick(lk: Look, rng=random) -> dict | None:
    ok = [c for c in lk.due if c["id"] not in lk.busy]
    return rng.choice(ok) if ok else None


def kind_for(type_: str, kinds: list, jobs: list[dict]) -> str:
    """Alternate when both kinds are selected; with neither, default to revise."""
    kinds = [k for k in KINDS if k in (kinds or [])]
    if len(kinds) < 2:
        return kinds[0] if kinds else "revise"
    last = max((j for j in jobs if j.get("group") == GROUP and j.get("type") == type_ and j.get("kind") in KINDS),
               key=lambda j: j.get("created") or 0, default=None)
    return "inspire" if (last or {}).get("kind") == "revise" else "revise"


def from_order(type_: str, crit: str, lk: Look, *, since: float = 0, root=None) -> tuple:
    """Accept only orders matching criterion, pool scope and current pass.
    Resurvey exhausted orders immediately; retry an empty order only after a pool card changes."""
    from . import survey as SV
    sv = SV.latest(type_, root)
    ok = {c["id"]: c for c in lk.due}
    asked = (sv or {}).get("asked") or (sv or {}).get("ts") or 0
    if sv and sv.get("criterion") == crit and sv.get("pool") == lk.scope and asked >= since:
        order = sv.get("order") or []
        left = [o for o in order if o["card"] in ok]
        nxt = next((o for o in left if o["card"] not in lk.busy), None)
        if nxt:
            return "card", ok[nxt["card"]], nxt.get("why") or ""
        if left:
            return "wait", None, f"{type_}: the order's next cards are busy"
        if not order and not any(max(c.get("created") or 0, lk.changed(c["id"])) > asked for c in lk.pool):
            return "wait", None, (f"{type_}: the survey for «{crit[:48]}» found no card — it surveys again when "
                                  f"something changes (a vote, a new card, survey again)")
    if all(cid in lk.busy for cid in ok):
        return "wait", None, f"{type_}: nothing changed since AUTO last had each card — vote, or start a new pass"
    return "survey", None, None


def _method(type_: str) -> str | None:
    """Use the manifest's default method for unattended work as for direct sends."""
    return next((t.get("default_method") for t in C.types() if t.get("type") == type_), None)


def _base(cid: str) -> int | None:
    """The version a job on this card builds from: core/researcher's rule (the newest in the stack not voted down)."""
    from . import researcher as RS
    try:
        _, base = RS._version_votes(cid, None)
    except Exception:                              # noqa: BLE001  no card.json, a store being written: no version
        return None
    return (base or {}).get("n")


def _hears(type_: str, cid: str, job: dict):
    """What a job on the card would hear; the type's `hears`, as POST /api/queue freezes it (api/queue._hears)."""
    from api.queue import _hears as hears
    return hears(type_, cid, job)


def _lead(type_: str, kind: str) -> str:
    """The job's first words: the type's plugin's (`auto_text(kind)`), else core's."""
    from . import plugins as PG
    fn = PG.call(type_, "auto_text")
    got = fn(kind) if fn is not None else None
    return got or TEXT[kind]


_ticking = threading.Lock()
_hooks: dict = {}               # the scheduler's cards / start, for kick()


def tick(**kw) -> list[str]:
    """Serialize looks so timer and immediate kicks cannot enqueue duplicate work.
    Return queued ids; cards supplies the fold and start wakes the job's runner."""
    if not _ticking.acquire(blocking=False):
        return []
    try:
        return _tick(**kw)
    finally:
        _ticking.release()


def kick() -> None:
    """Look now rather than at the scheduler's next minute: AUTO was just turned on, or a tab was added."""
    if not _hooks:
        return

    def go():
        try:
            tick(**_hooks)
        except Exception as e:                      # noqa: BLE001  a bad look must not take the route down
            _say(f"error: {type(e).__name__}: {e}"[:200])
    threading.Thread(target=go, name="auto-kick", daemon=True).start()


settings_lock = threading.Lock()   # AUTO's settings written (api/auto.py) and a decision landed (_tick): one at a time


def _still(s: dict, type_: str, root=None) -> bool:
    """Under settings_lock, discard decisions prepared with settings that have since changed."""
    now = settings(P.fold(root))
    return (now["on"] and type_ in now["types"] and now["agent"] == s["agent"] and now["model"] == s["model"]
            and tab(now, type_) == tab(s, type_))


def _tick(*, cards, start, now: float | None = None, root=None) -> list[str]:
    s = settings(P.fold(root))
    if not s["on"]:
        _say("off")
        return []
    from . import gate
    if gate.closed(root):                  # a switch under way (core/gate.py): nothing new starts
        _say("the gate is closed — maintenance; nothing new starts")
        return []
    now = now or time.time()
    jobs = list(Q.fold(root).values())
    card_dir = (lambda cid: Path(root) / "cards" / cid) if root else None
    made, busy = [], []
    all_cards = None
    types = list(s["types"])
    for type_ in types:
        reconcile(type_, root=root)
        mine = [j for j in jobs if j.get("group") == GROUP and j.get("type") == type_]
        if any(Q.is_open(j) and j["status"] != "failed" for j in mine):
            busy.append(type_)
            continue
        # A failed job blocks its tab until retry or dismissal; a converged fit is successful, not a failure.
        last = max(mine, key=lambda j: j.get("created") or 0, default=None)
        if last and last["status"] == "failed" and not last.get("dismissed"):
            _say(f"{type_}: the last AUTO job failed — retry or dismiss it in the queue "
                 f"({(last.get('why') or '')[:80]})", type_)
            continue
        t = tab(s, type_)
        kind = kind_for(type_, t["kinds"], jobs)
        all_cards = all_cards if all_cards is not None else cards()
        lk = look(type_, all_cards, jobs, kind=kind, since=t["since"], card_dir=card_dir)
        why = None
        if t["criterion"]:
            what, card, why = from_order(type_, t["criterion"], lk, since=t["since"], root=root)
            if what == "wait":
                _say(why, type_)
                continue
            if what == "survey":
                from . import budget as B
                admission = B.check(s["agent"], model=s["model"], prefs=P.fold(root), root=root)
                if not admission["allowed"]:
                    _say(admission["why"], type_)
                    continue
                with settings_lock:
                    if not _still(s, type_, root):
                        continue
                    job = Q.enqueue(type=type_, kind="survey", text=t["criterion"],
                                    backend=s["agent"], model=s["model"], group=GROUP, root=root)
                T.emit("auto", "auto.survey", job=job["id"], type=type_,
                       criterion=t["criterion"][:120])
                start(type_, job)
                state["last"] = {"job": job["id"], "card": None, "label": "the survey",
                                 "type": type_, "ts": time.time(), "survey": True}
                made.append(job["id"])
                continue
        else:
            card = pick(lk)
        if card is None:
            _say(f"{type_}: " + ("nothing changed since AUTO last had each card — vote, or start a new pass"
                                 if any(c["id"] not in lk.busy for c in lk.pool)
                                 else f"nothing in the auto pool to {kind} (empty, voted down, or with a job open)"),
                 type_)
            continue
        picked = (f"\n\nWHY THIS CARD: the picking phase put it next in its order for the "
                  f"operator's criterion «{t['criterion']}»: {why}" if why else "")
        # Freeze the visible base and plugin source at enqueue, including cuts/keeps and recording trim.
        # Never build from a held version outside the visible stack.
        version, trim = _base(card["id"]), (card.get("trim") if (card.get("origin") or {}).get("kind") == "recording"
                                             else None)
        try:
            source = _hears(type_, card["id"], {"card": card["id"], "kind": kind, "version": version,
                                                "item": None, "trim": trim})
        except LookupError as e:
            _say(f"{type_}: {card.get('name') or card['id']} hears nothing ({e}) — passed over", type_)
            continue
        from . import budget as B
        admission = B.check(s["agent"], model=s["model"], prefs=P.fold(root), root=root)
        if not admission["allowed"]:
            _say(admission["why"], type_)
            continue
        with settings_lock:                        # Drop decisions if the settings changed while they were prepared.
            if not _still(s, type_, root):
                _say(f"{type_}: its settings changed while AUTO looked — looking again", type_)
                continue
            job = Q.enqueue(type=type_, kind=kind, card=card["id"],
                            text=_lead(type_, kind) + commented(t["comment"]) + picked,
                            backend=s["agent"], model=s["model"], group=GROUP, method=_method(type_), version=version,
                            source=source, trim=trim, keep=t["keep"], root=root)
        T.emit("auto", "auto.queued", job=job["id"], card=card["id"], type=type_, kind=kind,
               agent=s["agent"])
        start(type_, job)
        state["last"] = {"job": job["id"], "card": card["id"], "label": card.get("label"), "name": card.get("name"),
                         "type": type_, "kind": kind, "ts": time.time(), "comment": bool(t["comment"])}
        _say(f"{type_}: queued a {kind} of {card.get('name') or card['id']}", type_)
        made.append(job["id"])
    if made:
        _say(f"queued {len(made)} — {s['agent']}")
    elif busy and len(busy) == len(types):
        _say(f"working — one AUTO job in flight ({', '.join(busy)})")
    return made



_settling = threading.Lock()
_holding = threading.Lock()


def hold(job: dict, pairs, *, root=None) -> list:
    """Hold each made version once after sync, using keep frozen on the job, for final and mid-job publication.
    Return the card/version pairs held; later setting changes do not affect admission."""
    from . import jsonl as J
    from . import signals as SIG
    from . import stores as ST
    if job.get("group") != GROUP or not pairs:
        return []
    if not job.get("keep"):                       # Admission policy was frozen on the job at enqueue.
        return []
    out = []
    with _holding:
        for card, vid in pairs:
            d = (Path(root) / "cards" / card) if root else ST.card_dir(card)
            # A missing version cannot be admitted unheld; fail publication or leave settlement retryable.
            try:
                vs = json.loads((d / "card.json").read_text()).get("versions") or []
            except (OSError, ValueError) as e:
                raise LookupError(f"can't hold {card} {vid}: its card can't be read ({e})") from None
            n = next((v.get("n") for v in vs if v.get("id") == vid or str(v.get("n")) == str(vid)), None)
            if not isinstance(n, int):
                raise LookupError(f"can't hold {card} {vid}: the card has no such version")
            held = SIG.fold(SIG.read(d)).get("_held") or {}
            if n in held or str(n) in held:
                continue
            J.append_jsonl(d / "signals.jsonl", {"kind": "held", "version": n, "job": job["id"]})
            out.append([card, n])
    if out:
        T.emit("auto", "auto.held", job=job["id"], type=job.get("type"), held=out)
    return out


def reconcile(type_: str, *, root=None) -> list[dict]:
    """Settle completed work using explicit made refs and frozen keep; cancelled/empty work logs a nothing event.
    Failed work remains retryable, not settled."""
    from . import stores as ST
    with _settling:
        ev = AL.read(type_, root)
        settled = {e.get("job") for e in ev if e.get("event") in ("made", "nothing")}
        # the queue says what AUTO queued: its AUTO jobs of this tab, from when this log began. A job its `queued` line
        # names counts too: that line is written just after the job, so the log's first one is later than its job
        since = min((e.get("ts") or 0 for e in ev), default=0)
        named = {e.get("job") for e in ev if e.get("event") == "queued"}
        jobs = Q.fold(root)
        out = []
        for jid, j in jobs.items():
            if (j.get("group") != GROUP or j.get("type") != type_ or j.get("kind") not in KINDS or jid in settled
                    or ((j.get("created") or 0) < since and jid not in named)
                    or j.get("status") not in ("done", "cancelled")):
                continue
            pairs = []
            for card, vid in (j.get("made") or []) if j.get("status") == "done" else []:
                d = (Path(root) / "cards" / card) if root else ST.card_dir(card)
                try:
                    vs = json.loads((d / "card.json").read_text()).get("versions") or []
                except (OSError, ValueError):
                    continue
                n = next((v.get("n") for v in vs if v.get("id") == vid), None)
                if isinstance(n, int):
                    pairs.append((card, n, d))
            if not pairs:
                out.append(AL.append(type_, {"event": "nothing", "job": jid, "card": j.get("card"),
                                             "why": j.get("why") or j.get("status")}, root))
                continue
            try:
                hold(j, [(card, str(n)) for card, n, _ in pairs], root=root)     # what publication didn't, once
            except LookupError as e:                   # not settled until it is held: the next look tries again
                T.emit("auto", "hold.pending", job=jid, error=str(e)[:200])
                continue
            for card, n, d in pairs:
                out.append(AL.append(type_, {"event": "made", "job": jid, "card": card, "version": n,
                                             "held": bool(j.get("keep"))}, root))
            T.emit("auto", "auto.made", job=jid, type=type_, made=[[c, n] for c, n, _ in pairs])
        return out


def wake(types: list[dict], start_lane, *, now: float | None = None, root=None,
         alive=None) -> list[tuple]:
    """Recover dead lanes first, then start lanes with claimable work and no runner.
    Waiting jobs wake only when due; the runner enforces exclusive ownership."""
    from . import gate
    from . import lanes as L
    alive = alive or L.alive
    L.recover([t for t in types if t.get("start")], root=root)     # also while the gate is closed: it can't be idle
    if gate.closed(root):                  # a switch under way (core/gate.py): no runner is started
        return []
    now = now or time.time()
    jobs = list(Q.fold(root).values())
    asked = []
    for t in types:
        if not t.get("start"):
            continue
        lanes = {Q.lane_for(j) for j in jobs if j.get("type") == t["type"] and j.get("live") is None
                 and (j["status"] == "queued" or Q.due(j, now))}
        for lane in sorted(lanes, key=lambda x: x or ""):
            if alive(t, lane):
                continue                  # it will claim the job itself
            start_lane(t, lane)
            asked.append((t["type"], lane))
    return asked


def run_forever(*, wake_hooks: dict | None = None, **hooks) -> threading.Thread:
    def loop():
        while True:
            from . import budget as B
            try:
                B.poll()
            except Exception as e:
                T.emit("auto", "budget.error", error=str(e)[:200])
            if wake_hooks:
                try:
                    wake(**wake_hooks)
                except Exception as e:
                    T.emit("auto", "wake.error", error=f"{type(e).__name__}: {e}"[:200])
            try:
                tick(**hooks)
            except Exception as e:                  # the loop must outlive a bad tick
                _say(f"error: {type(e).__name__}: {e}"[:200])
            time.sleep(min(TICK, B.delay()))
    from . import plugins as PG
    PG.provide(**hooks)                             # the scheduler's cards and start, for the plugins' services
    _hooks.update(hooks)
    PG.start()
    th = threading.Thread(target=loop, name="auto-revise", daemon=True)
    th.start()
    return th
