"""Claim once and record an attempt outcome; recover dead runners without stranding work.
Type-specific fulfil callbacks own the actual work."""
import os
import time
import traceback
import urllib.request
from pathlib import Path

from . import queue as Q
from . import trace as T


class Deferred(Exception):
    """Wait until the epoch deadline and retry the same job instead of failing it."""
    def __init__(self, agent: str, until: float, why: str = "", quota_group: str | None = None):
        super().__init__(why)
        self.agent, self.until, self.why = agent, until, why
        self.quota_group = quota_group


class Unchanged(Exception):
    """Finish successful work that found nothing better, without output or retry.
    Required output that is absent must raise NothingMade instead."""


class Stopped(Exception):
    """End the attempt after a requested pause or cancel stops its work; do not mark it failed."""


def run_once(researcher: str, types: list[str], fulfil, *, root: Path | None = None, kinds=None) -> dict | None:
    """Claim once; fulfil returns a result id or None, and report updates phase.
    Each attempt ends with an outcome or remains recoverable after runner death."""
    job = Q.claim_next(researcher, types=types, kinds=kinds, root=root)
    if job is None:
        return None

    def report(text):
        Q.phase(job["id"], text, root=root)

    # Bind trace tokens and inherited PICKER_JOB so every descendant can stamp its publications with the job.
    os.environ["PICKER_JOB"] = job["id"]
    try:
        with T.bound(job=job["id"], type=job["type"], card=job.get("card"), attempt=job.get("attempt")):
            _work(job, researcher, fulfil, report, root)
    finally:
        os.environ.pop("PICKER_JOB", None)
    if job.get("group") == "auto":
        _wake_auto()
    return job


def _wake_auto() -> None:
    """An AUTO job ended: the picker looks for AUTO's next one now, not at its next minute. A picker that can't be
    reached loses nothing; its minute still comes."""
    url = os.environ.get("PICKER_URL")
    if not url:
        return
    try:
        req = urllib.request.Request(f"{url}/api/auto/kick", data=b"{}", method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=3).close()
    except Exception:                               # noqa: BLE001  a missed wake waits for the minute
        pass


def _work(job, researcher, fulfil, report, root):
    """Write attempt-numbered outcomes without a check-then-write race.
    The fold preserves intervening pause/cancel even if publication already occurred."""
    from . import agents as A
    n = job["attempt"]
    report("claimed")                      # baseline, before any work happens
    try:
        from . import budget as B, prefs as P
        name = job.get("backend") or researcher.split(":")[-1].split("@")[0]
        admission = B.check(name, model=job.get("model"), prefs=P.fold(root), permissions=False, root=root)
        if not admission["allowed"]:
            report(admission["why"])
            raise Deferred(name, admission["until"], admission["why"], admission.get("quota_group"))
        cid = fulfil(job, report)
        Q.done(job["id"], result=cid, made=[list(p) for p in job.get("_versions") or []] or None, attempt=n,
               root=root)
    except Unchanged as u:
        report(f"unchanged — {u}"[:300])
        Q.done(job["id"], why=f"Unchanged: {u}", attempt=n, root=root)
        T.emit("worker", "job.unchanged", researcher=researcher, why=str(u)[:300])
    except (Stopped, A.AgentCancelled) as e:
        # A requested stop is not a failure.
        Q.stopped(job["id"], attempt=n, root=root)
        T.emit("worker", "job.stopped", researcher=researcher, error=f"{type(e).__name__}: {e}"[:200])
        print(f"[worker] {job['id']} stopped — paused or cancelled", flush=True)
    except (Deferred, A.AgentLimited) as d:
        # Agent exhaustion defers the same job rather than failing it.
        quota_group = getattr(d, "quota_group", None)
        if isinstance(d, A.AgentLimited):
            d = Deferred(d.result.agent, d.until.timestamp() + 60 if d.until else time.time() + 15 * 60, str(d))
        Q.wait(job["id"], agent=d.agent, until=d.until, why=d.why, attempt=n, root=root, quota_group=quota_group)
        T.emit("worker", "job.waiting", researcher=researcher, agent=d.agent,
               until=d.until, why=d.why)
    except Exception as e:
        Q.failed(job["id"], why=f"{type(e).__name__}: {e}"[:400], attempt=n, root=root)
        # The whole traceback, keyed by the job; the queue row can hold 400
        # characters of why; this holds where.
        T.emit("worker", "job.failed", researcher=researcher,
               error=f"{type(e).__name__}: {e}", traceback=traceback.format_exc())
        traceback.print_exc()


def drain(researcher: str, types: list[str], fulfil, *, root: Path | None = None,
          limit: int = 0, kinds=None) -> int:
    """Exit when nothing is claimable; usage waits must not keep runners polling.
    The scheduler starts runners again when waiting work becomes due."""
    n = 0
    while not limit or n < limit:
        if run_once(researcher, types, fulfil, root=root, kinds=kinds) is None:
            break
        n += 1
    return n
