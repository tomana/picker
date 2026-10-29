"""Run mock failure modes only on a scratch store; stamp published versions with the producing job."""
import argparse
import datetime
import json
import os
import re
import signal
import threading
import time
from pathlib import Path

from picker import sdk

HERE = Path(os.environ["MOCK_HOME"])
RUNS = HERE / "runs"
TYPE = "mock"


def write_version(card: str) -> dict:
    d = RUNS / card
    d.mkdir(parents=True, exist_ok=True)
    n = len(list(d.glob("v*.json"))) + 1
    (d / f"v{n}.json").write_text(json.dumps({"n": n, "id": f"v{n}", "job": os.environ.get("PICKER_JOB"),
                                              "created": time.time()}))
    return {"card": card, "version": f"v{n}"}


def publish(card: str) -> dict:
    """In the store at once, as the real runners publish (before the job's done)."""
    ref = write_version(card)
    sdk.sync(TYPE)
    return ref


def work(job: dict, report):
    mode = (re.search(r"\[mock ([\w-]+)\]", job.get("text") or "") or [None, "ok"])[1]
    with open(HERE / "calls.jsonl", "a") as f:
        f.write(json.dumps({"job": job["id"], "mode": mode, "pid": os.getpid(), "ts": time.time()}) + "\n")
    card = job.get("card") or "c1"
    if mode in ("ok", "no-agent"):
        return [publish(card)]
    if mode == "slow-ok":
        time.sleep(1.5)
        return [publish(card)]
    if mode == "unchanged":
        raise sdk.Unchanged("mock: nothing beats the current one")
    if mode == "nothing":
        return []
    if mode == "raise":
        raise RuntimeError("mock: it broke")
    if mode == "limited":
        from core import agents as A
        until = datetime.datetime.now().astimezone() + datetime.timedelta(hours=1)
        raise A.AgentLimited(A.AgentResult(agent=sdk.agent_for(job, "claude"), model=None, effort=None, exit=1),
                             until=until)
    if mode == "slow-tool":
        report("tool")
        sdk.run(["sleep", "20"], log=HERE / "logs" / f"tool_{job['id']}.log")
        return [publish(card)]
    if mode == "hang":
        report("tool")
        sdk.run(["sleep", "600"], log=HERE / "logs" / f"tool_{job['id']}.log", deadline=time.time() + 2)
        return [publish(card)]
    if mode == "die-first-try":
        if job.get("attempt") == 1:
            os.kill(os.getpid(), signal.SIGKILL)
        return [publish(card)]
    if mode == "die-before":
        os.kill(os.getpid(), signal.SIGKILL)
    if mode == "die-after-publish":
        publish(card)
        os.kill(os.getpid(), signal.SIGKILL)
    if mode == "die-two-tools":
        report("tools")
        threading.Thread(target=sdk.run, args=(["sleep", "31.4159"],), kwargs={"log": HERE / "logs" / "bg.log"},
                         daemon=True).start()
        time.sleep(1)
        sdk.run(["sh", "-c", f"sleep 1; kill -9 {os.getpid()}"], log=HERE / "logs" / "fg.log")
    if mode == "die-in-sync":
        ref = write_version(card)
        (HERE / "die_in_sync").touch()
        return [ref]
    if mode == "sync-fails-once":
        ref = write_version(card)
        (HERE / "sync_fail").touch()
        return [ref]
    if mode == "bad-ref":
        return [{"card": "nosuch"}]
    raise RuntimeError(f"mock: no mode {mode!r}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="claude")
    ap.add_argument("--dry-run", action="store_true")          # as every runner has it (the harness's)
    a = ap.parse_args()
    sdk.drain(TYPE, a.agent, work, HERE, cwd=HERE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
