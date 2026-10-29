"""Shared lifecycle, context, sync and explicit result validation for type runners.
The store is a projection, not the authority for what work made."""
import contextlib
import fcntl
import functools
import json
import os
import re
import sys
import time
from pathlib import Path

from . import agents as A
from . import config as C
from . import queue as Q
from . import stores as ST
from . import trace as T
from . import worker as W

ROOT = Q.ROOT
PICKER = C.PICKER                              # the picker's code (runner.py)

def store_ids() -> set[str]:
    return {cid for cid, p in ST.cards() if (p / "card.json").is_file()}


def sync(type_: str) -> None:
    """Run the manifest projection; without a declared sync the type writes its own cards."""
    s = _type_entry(type_).get("sync")
    if not s:
        return
    _project(C.expand(s["argv"]), ROOT / s.get("cwd", "."), type_, type_)


@contextlib.contextmanager
def sync_lock(key: str):
    """Serialize sync and mutations of files it reads; the lock is not reentrant.
    Never call sync while holding it."""
    lock = C.get().state / f"sync_{key}.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, "w") as lf:
        # Bound lock waiting beyond the sync deadline so a stuck holder cannot block jobs forever.
        end = time.time() + SYNC_S + LOCK_GRACE
        while True:
            try:
                fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.time() > end:
                    raise RuntimeError(f"the sync of {key} waited {SYNC_S + LOCK_GRACE:.0f} s for another that holds "
                                       f"its lock")
                time.sleep(0.2)
        yield


SYNC_S = 900                      # Sync has a deadline; lock waiting gets only a bounded cleanup margin beyond it.
LOCK_GRACE = 60


def _project(argv: list, cwd: Path, key: str, name: str) -> None:
    """Run a sync, with the picker's tree on its path (its `from picker import sdk`, whichever interpreter runs it).
    Raises if it fails, so a bad sync fails the JOB loudly rather than reporting a card that is not there."""
    t0 = time.time()
    # Serialize per-type syncs across lanes and mid-job publication; state-local locks isolate separate configurations.
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(PICKER), os.environ.get("PYTHONPATH")]))}
    # Track sync groups for dead-runner cleanup; pause does not interrupt a projection, but its deadline still applies.
    from . import proc as P
    with sync_lock(key):
        try:
            r = P.run(argv, cwd=cwd, env=env, deadline=time.time() + SYNC_S, stop=lambda: False)
        except P.TimedOut:
            raise RuntimeError(f"sync timed out ({name}, {SYNC_S} s)") from None
    T.emit("researcher", "sync", script=name, exit=r.exit,
           seconds=round(time.time() - t0, 2),
           **({"output": r.text[-2000:]} if r.exit else {}))
    if r.exit:
        # The sync's own last words, not "returned non-zero exit status 1".
        tail = " / ".join(r.text.strip().splitlines()[-2:])
        raise RuntimeError(f"sync failed ({name}): {tail}"[:400])


def attachments(cid: str | None) -> list[Path]:
    """Glob accumulated image files directly; attach signals never retract and no API import is needed."""
    if not cid:
        return []
    d = ST.card_dir(cid) / "media"
    if not d.is_dir():
        return []
    return sorted((f for f in d.glob("attach_*") if f.is_file()),
                  key=lambda f: f.stat().st_mtime)


def request_images(job: dict | None) -> list[Path]:
    if not job or not job.get("attachments"):
        return []
    d = Q.media_dir(job["id"])
    return [d / n for n in job["attachments"] if (d / n).is_file()]


def _version_votes(cid: str | None, on_screen: int | None = None
                   ) -> tuple[list[dict], dict | None]:
    """Return folded votes and explicit on-screen base, else newest visible non-rejected version.
    Fall back to newest when all are rejected; retain rationale and part context."""
    if not cid:
        return [], None
    try:
        card = json.loads((ST.card_dir(cid) / "card.json").read_text())
    except Exception:
        return [], None
    from . import signals as SIG
    folded = SIG.fold(SIG.read(ST.card_dir(cid)))
    votes = folded.get("_versions", {})
    out = SIG.hidden(folded)            # Held tries are not visible stack versions.
    vs = []
    for i, v in enumerate(card.get("versions") or []):
        n = v.get("n", i + 1)
        vs.append({"n": n, "id": v.get("id"), "vote": votes.get(n, votes.get(str(n), 0)) or 0,
                   "agent": v.get("agent"), "rationale": v.get("rationale") or "",
                   "parts": [p.get("id") for p in v.get("parts") or [] if p.get("id")],
                   **({"hidden": True} if n in out else {})})
    if not vs:
        return [], None
    kept = [v for v in vs if not v.get("hidden")] or vs
    base = next((v for v in vs if on_screen and v["n"] == on_screen), None) \
        or next((v for v in reversed(kept) if v["vote"] >= 0), kept[-1])
    return vs, base


def context(job: dict) -> dict:
    """Resolve versions/base, absolute image paths and frozen kept-part files once at claim.
    Runners consume context rather than reimplementing store or signal rules."""
    cid = job.get("card")
    vs, base = _version_votes(cid, job.get("version"))
    src = job.get("source") or {}
    kept = [str(ST.card_dir(cid) / "media" / Path(str(f)).name) for f in src.get("keep") or []] \
        if cid and src.get("cut") else []
    return {"versions": vs, "base": base, "attachments": [str(f) for f in attachments(cid)],
            "requests": [str(f) for f in request_images(job)], "kept": kept}


def context_of(job: dict) -> dict:
    """The job's context: the one it was claimed with, else made now (a brief built by hand, a test)."""
    return job["context"] if job.get("context") is not None else context(job)


def version_votes(job: dict) -> tuple[list[dict], dict | None]:
    ctx = context_of(job)
    return ctx["versions"], ctx["base"]


def note_line(kind: str, text: str) -> str:
    """State when no note was supplied so a prior rationale cannot become the new instruction."""
    if text:
        return f'The operator wrote: "{text}"\n'
    old = ("The notes quoted in the versions' rationales asked for earlier versions and were answered there: they "
           "say what the operator wants from this card, but they are not this request.")
    if kind == "revise":
        return ("The operator wrote NO note with this press, so the request is: the same idea, taken further or "
                "fixed. Look at (or listen to) the version named below first. If something in it is weak or broken, "
                "make a FIX / QUALITY PASS: mend that, and change nothing else. If it is sound, make a TAKEN "
                "FURTHER / ARTISTIC ATTEMPT: take the idea one bold step further, keeping what makes it this card. "
                "If you make a second version, make it the other kind, so the operator can choose between them. "
                "Start each rationale with \"Fix / quality pass:\" or \"Taken further / artistic attempt:\". "
                + old + "\n")
    if kind == "inspire":
        return ("The operator wrote NO note with this press: work from the version named below on your own "
                "judgement. " + old + "\n")
    return ""


def _other_cards(own: set) -> "re.Pattern | None":
    """Remove other card/version ids from rationales; require digit, underscore or hyphen.
    Plain-word ids must not erase ordinary prose."""
    import re
    ids = set()
    for _, d in ST.cards():
        f = d / "card.json"
        try:
            c = json.loads(f.read_text())
        except Exception:
            continue
        ids.add(c.get("id") or f.parent.name)
        for v in c.get("versions") or []:
            ids.update(p.get("id") for p in v.get("parts") or [] if p.get("id"))
    ids = {i for i in ids if i and i not in own and re.search(r"[\d_-]", i)}
    if not ids:
        return None
    return re.compile(r"(?<![\w-])(?:" + "|".join(map(re.escape, sorted(ids, key=len, reverse=True))) + r")(?![\w-])")


def version_note(job: dict) -> str:
    """Include version votes and the claimed on-screen base; do not treat old notes as the current request."""
    cid, on_screen = job.get("card"), job.get("version")
    vs, base = version_votes(job)
    tries = any(v.get("hidden") for v in vs)
    voted = any(v["vote"] for v in vs)
    if len(vs) < 2 or not (voted or on_screen or tries):
        return ""
    def mark(v):
        if v.get("hidden"):              # Exclude held tries; no vote means no preference, not rejection.
            return ("a try AUTO made that the operator voted DOWN — not kept; move away from it"
                    if v["vote"] < 0 else
                    "a try AUTO made, with no vote yet — no preference either way; not in the stack")
        return (f"▲{v['vote']} (right direction)" if v["vote"] > 0 else
                f"▽{-v['vote']} (a detail in it didn't work, not the whole version)" if v["vote"] < 0 else
                "no vote (no judgement)")
    # Show both public version numbers and source folder names; gaps can make those numbers differ.
    def name(v):
        return (f"v{v['n']} (folder {v['id']}/)" if v.get("id") and v["id"] != f"v{v['n']}"
                else f"v{v['n']}")
    others = _other_cards({cid, *(p for v in vs for p in v["parts"])})
    def told(v):                         # the rationale, other cards' names taken out
        r = others.sub("another card", v["rationale"]) if others else v["rationale"]
        return r[:160]
    lines = "".join(
        f"  {name(v)}" + (f" ({', '.join(v['parts'][:2])}" + (f", {v['agent']}" if v["agent"] else "") + ")"
                          if v["parts"] else "")
        + (f" — {mark(v)}" if voted or tries else "") + f" — {told(v)}\n" for v in vs)
    newest = vs[-1]
    parts = ", ".join(base["parts"][:2]) or "its parts"
    if on_screen and base["n"] == on_screen:
        steer = (f"The operator pressed this while looking at {name(base)} ({parts}): "
                 f"build from THAT version.\n")
    elif base is not newest and newest.get("hidden"):
        steer = (f"The newest version, {name(newest)}, is a try AUTO made that was not kept: "
                 f"build from {name(base)} ({parts}), the newest version in the stack.\n")
    elif base is not newest:
        steer = (f"The newest version, {name(newest)}, was voted DOWN: build from "
                 f"{name(base)} ({parts}), the newest one not voted down.\n")
    else:
        steer = ""
    if not (voted or tries):
        return ("\nTHIS CARD'S VERSIONS SO FAR:\n" + lines + steer
                + "Say in your rationale which versions you built on.\n")
    return ("\nTHE OPERATOR'S VOTES ON THIS CARD'S VERSIONS — which way it should go:\n"
            + lines + steer
            + "Take further what the up-voted versions did. A down vote means one detail of that version really "
              "didn't work, not all of it: find the likely detail (what it changed from the version before) and "
              "don't carry it on; keep the rest. No vote is no judgement: the operator leaves much they like "
              "unvoted. Say in your rationale which versions you built on.\n")


def attachment_note(job: dict, base: Path) -> str:
    """Separate request illustrations from standing card context; paths are relative to the actual agent cwd."""
    ctx = context_of(job)
    asked = [os.path.relpath(f, base) for f in ctx["requests"]]
    shots = [os.path.relpath(f, base) for f in ctx["attachments"]]
    if not asked and not shots:
        return ""
    out = ""
    if asked:
        out += (f"\nThe operator ATTACHED {len(asked)} image(s) TO THIS REQUEST:\n"
                + "".join(f"  {r}\n" for r in asked)
                + "READ THEM — actually open each one and look at it. They illustrate "
                  "what is being asked for: a reference to match, a screenshot of "
                  "something wrong, or the look being asked for. Say in what you write "
                  "what you took from them, so the operator can tell you looked.\n")
    if shots:
        out += (f"\nThe card you are working from has {len(shots)} image(s) attached "
                f"to it:\n" + "".join(f"  {r}\n" for r in shots)
                + "Open them too: they are what the operator has said about this card "
                  "before.\n")
    return out


def stamp_lineage(cid: str, job: dict) -> None:
    """Stamp the job's authoritative parent and prompt after sync; a projection alone cannot infer why work was requested.
    This is researcher-owned publication, not a picker signal write."""
    f = ST.card_dir(cid) / "card.json"
    try:
        card = json.loads(f.read_text())
    except Exception:
        return
    lin = card.setdefault("lineage", {})
    # The job's parent is authoritative, regardless of lineage written by the agent.
    if job.get("card"):
        lin["parent"] = job["card"]
    if (job.get("text") or "").strip():
        lin["why"] = job["text"].strip()
    card["created_from"] = f"queue:{job['kind']}"
    f.write_text(json.dumps(card, indent=1, ensure_ascii=False) + "\n")


def fulfil_with(type_: str, work):
    """Work returns explicit card/version, card-only or part refs; sync and resolve each in the type's store.
    Missing refs fail; record all pairs and prefer newest new card, then parent, then first named result."""
    def fulfil(job, report):
        before = store_ids()
        made = again(job, report)
        if made is None:
            made = work(job, report) or []
            if made:                               # named before the sync: a retry after a failed sync syncs again
                Q.made(job["id"], made, attempt=job.get("attempt"))
        report("syncing the store")
        sync(type_)
        pairs = located(job["type"], made)
        job["_versions"] = pairs
        # Hold immediately after publication; a failed hold fails the job rather than exposing an unadmitted try.
        from . import auto as AU
        AU.hold(job, pairs)
        cards = list(dict.fromkeys(c for c, _ in pairs))
        T.emit("researcher", "made", made=[list(p) for p in pairs])
        if not cards:
            # Missing required output is failure; only survey and ping legitimately produce no card.
            if job.get("kind") in MUST_MAKE:
                raise NothingMade("no card came out — the agent's answer is in its log "
                                  f"(logs/queue_{job['id']}.log)")
            return None
        # Stamp newly made cards and this job's retry results, not grown parents or another job's preexisting result.
        new = [c for c in cards if c != job.get("card") and (c not in before or _job_of(c) == job.get("id"))]
        if new:
            cid = max(new, key=lambda c: _created(c))
            for c in new:
                stamp_lineage(c, job)
            how = "new card"
        else:
            cid = job.get("card") if job.get("card") in cards else cards[0]
            how = "grew" if cid == job.get("card") else "named"
        n = len(pairs)
        report(f"{cid}" + (f" and {len(cards) - 1} more" if len(cards) > 1 else "")
               + f" ({n} version{'s' if n != 1 else ''})")
        T.emit("researcher", "result", card=cid, how=how, parent=job.get("card") if new else None)
        return cid
    return fulfil


def again(job: dict, report) -> list | None:
    """Retry sync from refs recorded before it, without rerunning completed work.
    Publication job stamps prove origin, not completion; partial work resumes through its runner."""
    if (job.get("attempts") or 0) < 2 or not job.get("refs"):
        return None
    report("made by an earlier attempt — syncing again, not making it again")
    return job["refs"]


def _job_of(cid: str) -> str | None:
    try:
        return (json.loads((ST.card_dir(cid) / "card.json").read_text()).get("origin") or {}).get("job")
    except (OSError, ValueError, AttributeError):
        return None


def _created(cid: str) -> float:
    try:
        return float(json.loads((ST.card_dir(cid) / "card.json").read_text()).get("created") or 0)
    except (OSError, ValueError, TypeError):
        return 0.0


def located(type_: str, made: list) -> list[tuple[str, str]]:
    """The work's refs (fulfil_with) as (card id, version id) pairs, each found in the store after the sync; a ref
    it doesn't hold fails the job, saying which. A part is looked for in the type's store."""
    by_part: dict = {}
    if any("part" in r for r in made):
        for cid, d in ST.cards():
            if ST.of_type(type_) not in d.parents:
                continue
            try:
                c = json.loads((d / "card.json").read_text())
            except (OSError, ValueError):
                continue
            for v in c.get("versions") or []:
                for p in v.get("parts") or []:
                    if p.get("id"):
                        by_part.setdefault(p["id"], (cid, v.get("id")))
    out = []
    for r in made:
        if "part" in r:
            if r["part"] not in by_part:
                raise RuntimeError(f"the work made {r['part']}, and no card in the store holds it after the sync")
            pair = by_part[r["part"]]
        else:
            f = ST.card_dir(str(r["card"])) / "card.json"
            try:
                vs = [v.get("id") for v in json.loads(f.read_text()).get("versions") or []]
            except (OSError, ValueError):
                raise RuntimeError(f"the work made {r['card']}, and the store has no such card after the sync") from None
            v = r.get("version") or (vs[-1] if vs else None)
            if v not in vs:
                raise RuntimeError(f"the work made {r['card']} {v}, and the card has no such version after the sync")
            pair = (str(r["card"]), v)
        if pair not in out:
            out.append(pair)
    return out

MUST_MAKE = ("seed", "inspire", "revise")


class NothingMade(RuntimeError):
    """A card-making job whose agent finished without making one."""


def agent_for(job: dict, agent: str) -> str:
    """Which agent runs THIS job: the one the job names (`backend`; a wiring check
    names one per ping), else the one the runner was started with."""
    return job.get("backend") or agent


# Preflight returns name/ok/detail: False blocks work, None warns of a temporary obstacle, True passes.

def need_exe(name: str, install: str | None = None) -> tuple:
    import shutil
    got = shutil.which(name)
    return (name if got else f"{name} missing", bool(got), got or "not on PATH",
            None if got else (install or f"install {name}"))


def need_path(label: str, p: Path, hint: str = "") -> tuple:
    ok = Path(p).exists()
    try:
        shown = str(Path(p).relative_to(ROOT))
    except ValueError:
        shown = str(p)
    return (f"{label} missing" if not ok else label, ok,
            shown if ok else f"{shown} does not exist", hint or None)


def need_writable(label: str, d: Path) -> tuple:
    ok = Path(d).is_dir() and os.access(d, os.W_OK)
    return (label if ok else f"{label} not writable", ok, "" if ok else f"cannot write {d}",
            None if ok else f"check the permissions of {d}")



def _type_entry(type_: str) -> dict:
    try:
        return next(t for t in C.types() if t["type"] == type_)
    except Exception:
        return {}


def left_behind(job: dict, limit: int = 40, *, outputs: list[str] | None = None,
                root: Path | None = None) -> list[str]:
    """Find declared-output changes since first claim, excluding other jobs' staging and owned stacks.
    If this job has its own staging folder, restrict continuation to that folder."""
    since = job.get("first_claim")
    if not since:
        return []
    out = []
    root = Path(root or ROOT)
    bases = [root / rel for rel in (outputs if outputs is not None
                                    else _type_entry(job["type"]).get("outputs", []))]
    own = [b / "_staging" / job["id"] for b in bases if (b / "_staging" / job["id"]).is_dir()]
    for base in own or bases:
        if not base.is_dir():
            continue
        for f in base.rglob("*"):
            top = f.relative_to(base).parts
            if not own and top[0] == "_staging" and len(top) > 1 and top[1] != job["id"]:
                continue
            if not own and _other_job(base / top[0], job["id"]):
                continue
            try:
                if f.is_file() and f.stat().st_mtime >= since:
                    out.append((f.stat().st_mtime, str(f.relative_to(root))))
            except OSError:
                continue
    return [p for _, p in sorted(out)][-limit:]


@functools.lru_cache(maxsize=4096)
def _other_job(d: Path, jid: str) -> bool:
    """A different job recorded in stack.json marks another job's output."""
    try:
        made_by = json.loads((d / "stack.json").read_text()).get("job")
    except (OSError, ValueError, AttributeError):
        return False
    return bool(made_by) and made_by != jid


def count_note(job: dict) -> str:
    """Request multiple results in one shared session so later results can vary from earlier ones."""
    n = int(job.get("count") or 1)
    if n < 2:
        return ""
    kind = job.get("kind")
    if kind == "revise":
        what = (f"{n} new VERSIONS of this card, each built from the same starting "
                f"version — {n} different ways forward, not one way {n} times")
    elif kind in ("inspire", "seed"):
        what = (f"{n} new CARDS, each its own idea — {n} different directions from the same "
                f"starting point, each a candidate of its own with NO revision_of between "
                f"them (a further pass on one of them may name THAT one as its "
                f"revision_of)")
    else:
        what = f"{n} results"
    return (f"\nTHIS JOB ASKS FOR {n}. The operator pressed {kind} ×{n}: make {what}, all "
            f"in this one session. The point is VARIETY: once one is made and rendered, "
            f"look at it, and make the next deliberately different (another approach, "
            f"structure, palette, motion). Wherever the instructions below say to make "
            f"ONE, make each of the {n} that way — its own id, files and render — and say "
            f"in each rationale how it differs from its siblings.\n\n")


def attempt_note(job: dict, here: Path) -> str:
    """Combine the result-count request with prior-attempt files and log context for continuation."""
    return count_note(job) + _tried_note(job, here)


_AGENT_RAN = re.compile(r"^agent: \S+  model: ", re.M)


def _tried_note(job: dict, here: Path) -> str:
    if not job.get("attempts"):
        return ""
    log = here / "logs" / f"queue_{job['id']}.log"
    # A claim that immediately deferred ran no agent and has no continuation log.
    if not log.exists():
        return ""
    # Only an attempt with an agent-run header left agent context to continue; tool-only attempts did not.
    if not _AGENT_RAN.search(log.read_text(errors="replace")):
        return ""
    files = left_behind(job)
    return ("\nTHIS JOB HAS BEEN TRIED BEFORE — continue it, do not restart. "
            f"{job['attempts']} earlier attempt(s) stopped before finishing "
            "(usually an agent running out of usage). "
            + ("They left these files (paths from the repository root):\n"
               + "".join(f"  {f}\n" for f in files)
               if files else "They left no files. ")
            + f"What they said is in {log.relative_to(ROOT) if log.is_relative_to(ROOT) else log}"
              " — read its end first. "
              "Keep what is good, finish what is missing, and say in what you write "
              "that you continued earlier work.\n\n")


def warn(report, scope: str, name: str, detail: str, fix: str | None = None) -> None:
    """Emit the shared scope/name/detail/fix shape used by check readers.
    Type-wide preflight conditions must not be attributed to every agent cell."""
    report(f"warn · {scope} · {name} — {detail}" + (f" | fix: {fix}" if fix else ""))


def ping_with(type_: str, agent: str, *, cwd: Path, here: Path, brief=None,
              prefix=(), preflight=None, render=None):
    """Exercise real context, preflight, sync and agent write access or a tool-only render.
    Report steps and scoped warnings; this checks wiring, not output quality."""
    def common(job, who, report):
        report(f"{type_} runner up")
        if brief is not None:
            text = brief({"id": job["id"], "type": type_, "kind": "seed",
                          "card": None, "text": ""}, who if who in A.names() else agent)
            report(f"brief builds · {len(text) // 1000}k chars")
        if preflight is not None:
            bad = []
            for item in preflight():
                name, ok, detail = item[:3]
                fix = item[3] if len(item) > 3 else None
                if ok is False:
                    bad.append((name, detail, fix))
                elif ok is None:
                    warn(report, "preflight", name, detail, fix)
                else:
                    report(f"✓ {name}" + (f" · {detail}" if detail else ""))
            if bad:
                name, detail, fix = bad[0]
                raise RuntimeError(f"preflight · {name} — {detail}"
                                   + (f" (+{len(bad) - 1} more: "
                                      + ", ".join(b[0] for b in bad[1:]) + ")"
                                      if len(bad) > 1 else "")
                                   + (f" | fix: {fix}" if fix else ""))
        sync(type_)
        report("✓ store sync")

    def work(job, report):
        who = agent_for(job, agent)
        common(job, who, report)
        if who == "render":
            if render is None:
                warn(report, "render", "no render check", f"{type_} has no render_check()")
            else:
                render(report)
            return None
        if who not in A.names():
            report(f"{who} is not an agent — nothing to ask")
            return None
        c = A.choice(who)
        report(f"asking {who} · {c['model'] or 'default model'}"
               + (f" · {c['effort']}" if c["effort"] else ""))
        res = A.ping(who, cwd, here / "logs" / f"queue_{job['id']}.log",
                     prefix=prefix,
                     probe=here / "logs" / f"wiring_{job['id']}.txt")
        report(f"READY · {who} · {res.model or 'default model'} · wrote a file · "
               f"{res.seconds:.0f}s")
        return None
    return work


def drain(type_: str, agent: str, work, here: Path, *, cwd: Path | None = None, brief=None, prefix=(), kinds=None,
          preflight=None, render=None) -> int:
    """Acquire the lane before claiming and write runner-owned observational status.
    Restrict kinds for checks; sync/ping use the same cwd/brief/wrapper as real work."""
    sys.path.insert(0, str(PICKER))
    import runner as R                           # noqa: E402  picker's runner.json writer

    # Dry runs require an isolated harness queue; claiming live work without making output would fail real jobs.
    if "--dry-run" in sys.argv and not os.environ.get("PICKER_DRY_RUN"):
        print("[queue_runner] --dry-run is the test harness's (tests/fixture/dry_runs.py, a made-up store): "
              "it would take a real job and make nothing — not run", flush=True)
        return 0
    # Take the lifetime lane lock before recovering abandoned processes and attempts.
    left = R.hold(here)
    if left is None:
        print(f"[queue_runner] another runner works this lane of {type_} — leaving it to that one", flush=True)
        return 0
    if left or any(j.get("live") is not None for j in Q.jobs(type=type_)):
        from . import lanes as L
        mine = list(left)
        L.handover(type_, os.environ.get(R.LANE_ENV) or None, mine)
        for g in set(left) - set(mine):
            R.child(g[0], False)
    (here / "logs").mkdir(exist_ok=True)
    log = here / "logs" / "queue_runner.log"     # a runner outside the research (the made-up picker's own types): whole
    R.write(here, agent=agent, phase="working the queue",
            log=str(log.relative_to(ROOT) if log.is_relative_to(ROOT) else log))

    waiting = len(Q.jobs(type=type_, live_only=True))
    print(f"[queue_runner] {waiting} job(s) waiting for {type_}", flush=True)
    T.emit("runner", "runner.up", type=type_, agent=agent, pid=os.getpid(),
           waiting=waiting, kinds=sorted(kinds) if kinds else None)
    real = fulfil_with(type_, work)
    ping = ping_with(type_, agent, cwd=cwd or here, here=here, brief=brief,
                     prefix=prefix, preflight=preflight, render=render)

    def fulfil(job, report):
        if job["kind"] == "ping":
            return ping(job, report)           # a ping reports a limit; it never waits
        who = agent_for(job, agent)
        if job["kind"] == "survey":
            from . import survey as SV
            return SV.fulfil(job, who, cwd or here, here, report, prefix=prefix)
        # Check quota only when invoking an agent so tool-only jobs can run while that agent is depleted.
        job["context"] = context(job)
        return real(job, report)

    # A lane runner (an agent's lane) signs its claims `type:agent@lane`, so the picker
    # can tell which runner holds a job when it looks for orphans.
    lane = os.environ.get(R.LANE_ENV)
    n = W.drain(f"{type_}:{agent}" + (f"@{lane}" if lane else ""), [type_], fulfil, kinds=kinds)
    # Nothing claimable now. Jobs waiting for usage are the PICKER's to wake
    # (core/auto.py), not this process's to sit and poll for.
    print(f"[queue_runner] worked {n} job(s); nothing claimable — exiting", flush=True)
    T.emit("runner", "runner.done", type=type_, agent=agent, worked=n)
    return n
