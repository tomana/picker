"""Install the guard before SDK imports; fake agent output exercises real queue and sync handling."""
import argparse
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

HERE = Path(os.environ["FAKE_HOME"])
sys.path.insert(0, str(Path(__file__).resolve().parent))

import guard  # noqa: E402

guard.install(Path(os.environ["FIXTURE_LEAKS"]))

from picker import sdk  # noqa: E402
from core import agents as A  # noqa: E402
from core import researcher as RS  # noqa: E402

ME = json.loads((HERE / "fake.json").read_text())    # {"type", "kind": "visual" | "music" | "fit" | "code", "seed_from"}
TYPE = ME["type"]
RUNS = HERE / "runs"


def _card(cid: str) -> dict:
    return json.loads((sdk.card_dir(cid) / "card.json").read_text())


def work(job: dict, report) -> None:
    """Revisions extend the selected card; slow markers delay work so gate behavior can be checked."""
    slow = re.search(r"\[slow (\d+)\]", job.get("text") or "")
    if slow:
        report(f"slow, {slow.group(1)} s")
        time.sleep(int(slow.group(1)))
    kind = job["kind"]
    src = _card(job.get("card") or ME["seed_from"])
    last = src["versions"][-1]
    if kind == "revise":
        cid, label = job["card"], src["label"]
    else:
        cid, label = f"fk{job['id'][:10]}", f"made up by a fake {kind}"
    out = RUNS / cid
    if not (out / "meta.json").is_file():
        out.mkdir(parents=True, exist_ok=True)
        (out / "meta.json").write_text(json.dumps({
            "type": ME["type"], "label": label, "created": time.time(), "job": job["id"],
            "parent": job.get("card") if kind == "inspire" else None}))
    stored = len(_card(cid)["versions"]) if (sdk.card_dir(cid) / "card.json").is_file() else 0
    n = max(stored, len(list(out.glob("v*/version.json")))) + 1
    vdir = out / f"v{n}"
    vdir.mkdir()

    def take(rel: str) -> str:              # a fixture file copied into the research version
        name = Path(rel).name
        shutil.copyfile(sdk.card_dir(src["id"]) / rel, vdir / name)
        return name

    v = {"n": n, "id": f"v{n}", "created": time.time(), "rationale": job.get("text") or f"a fake {kind}",
         "agent": "fake", "model": "none"}
    if ME["kind"] == "code":
        # a scored code loop's next try (code_scored, the made-up picker's own): the last change run again, 2 % faster,
        # kept — made up, nothing runs
        sc = last["score"]
        v.update(media={"still": "still.png"}, parts=[], score={**sc, "value": round(sc["value"] * 0.98)}, kept=True,
                 measures=last.get("measures") or {})
        # its picture: the loop's staircase so far, this try last (only this tab's runner has Pillow)
        import staircase
        made = sorted((c["versions"][-1].get("created", 0), {"value": c["versions"][-1]["score"]["value"],
                                                             "kept": c["versions"][-1].get("kept"), "label": c["label"]})
                      for p in sdk.card_dir(cid).parent.glob("*/card.json") for c in [json.loads(p.read_text())]
                      if (c.get("versions") or [{}])[-1].get("score"))
        tries = [t for _, t in made] + [{"value": v["score"]["value"], "kept": True, "label": label}]
        staircase.draw(vdir / "still.png", tries, len(tries) - 1)
    elif ME["kind"] == "fit":
        # the fit loop's next try (fits_hybrid, the made-up picker's own): the last try's clip again, its loss a tenth
        # lower — made up, no sound is fitted
        v["media"] = {k: take(rel) for k, rel in last["media"].items()}
        v.update(duration=last.get("duration"), ab_at=last.get("ab_at"), ab_dur=last.get("ab_dur"),
                 params=last.get("params") or {},
                 score={**last["score"], "value": round(last["score"]["value"] * 0.9, 3)},
                 measures=last.get("measures") or {}, doubts=[], parts=[])
    elif ME["kind"] == "music":
        v["parts"] = [{**p, "audio": take(p["audio"]), "src": take(p["src"])} for p in last["parts"]]
        v["media"] = {"audio": take(last["media"]["audio"])}
        v["duration"] = last.get("duration")
    else:
        # named as fixture/build.py names a version (fxgrd1's v3 is fxgrd3), not after the files it copies: a v3 that
        # showed "fxgrd2" would look like v2 to a check
        stem = cid if n == 1 else f"{cid[:-1]}{n}"

        def as_stem(rel: str) -> str:
            name = f"{stem}{Path(rel).suffix}"
            shutil.copyfile(sdk.card_dir(src["id"]) / rel, vdir / name)
            return name
        v["media"] = {k: as_stem(rel) for k, rel in last["media"].items() if isinstance(rel, str)}
        v["parts"] = [{**p, "id": stem, "label": stem, "mode": stem, "src": as_stem(p["src"])}
                      for p in last.get("parts") or [] if p.get("src")][:1]
    (vdir / "version.json").write_text(json.dumps(v))
    report(f"made up {cid} v{n}")
    return [{"card": cid, "version": f"v{n}"}]


def cwd() -> Path:
    """Where this type's agent would run (a real runner's cwd()): here."""
    return HERE


def brief(job: dict, agent: str) -> str:
    """Name the program file in the fake brief, matching the runner contract."""
    return (f"A made-up brief for a {job['kind']} of {TYPE}, for {agent}. Read program.md first; then make one "
            f"{ME['kind']} card{' from ' + job['card'] if job.get('card') else ''}.\n{job.get('text') or ''}")


def fake_agent(name, prompt, cwd, logfile, **_):
    """Write the requested survey order file; other briefs receive a plain fake answer."""
    m = re.search(r"Write ONLY this file, as JSON:\n\s*(\S+)", prompt)
    if m:
        out = Path(m.group(1))
        cards = re.findall(r"^  - (\S+) «", prompt, re.M)
        body = {"order": [{"card": c, "why": "the fake agent's order"} for c in cards],
                "report": "made up by the fake agent"}
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(body))
    Path(logfile).parent.mkdir(parents=True, exist_ok=True)
    with open(logfile, "a") as f:
        f.write(f"[fake agent] {name}: answered without running anything\n")
    return A.AgentResult(agent=name, model="none", effort=None, exit=0, text="done")


A.run_job = fake_agent


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="claude")
    ap.add_argument("--kinds")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    kinds = set(a.kinds.split(",")) if a.kinds else None
    RS.drain(TYPE, a.agent, work, HERE, kinds=kinds)    # the store follows through sdk.sync: the fixture's types
    #                                                     declare each fake's sync.py (fixture/build.py)
    return 0


if __name__ == "__main__":
    sys.exit(main())
