"""Steering a job (picker plan 80): words for an open job come with its brief when its agent starts, and while it runs
they are delivered between two steps: the agent stops and goes on with its session (claude --resume, codex exec
resume), the words its next message; with no session seen it starts again with them. Fake CLIs record their argv."""
import _cfg  # noqa: F401
import json
import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from core import agents as A
from core import queue as Q
from core import trace as T

CLAUDE = r'''#!/usr/bin/env python3
import json, sys, time
args = sys.argv[1:]
open(LOG, "a").write(json.dumps({"t": time.time(), "argv": args}) + "\n")
def out(o):
    if SID: o["session_id"] = SID
    print(json.dumps(o), flush=True)
if "--resume" in args:
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": "resumed with: " + args[-1][:300]}]}})
    out({"type": "result", "subtype": "success"})
    sys.exit(0)
out({"type": "system", "subtype": "init"})
out({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "sleep 2"}}]}})
time.sleep(2)                                            # a tool runs
open(LOG, "a").write(json.dumps({"t": time.time(), "tool_done": True}) + "\n")
out({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1"}]}})
for i in range(12):                                      # then it thinks, step after step
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": f"working {i}"}]}})
    time.sleep(0.25)
out({"type": "result", "subtype": "success"})
'''

CODEX = r'''#!/usr/bin/env python3
import json, sys, time
args = sys.argv[1:]
open(LOG, "a").write(json.dumps({"t": time.time(), "argv": args}) + "\n")
if "resume" in args:
    print("resumed with: " + args[-1][:300], flush=True)
    sys.exit(0)
print("session id: 0123abcd-0000-1111-2222-333344445555", flush=True)
for i in range(16):
    print(f"working {i}", flush=True)
    time.sleep(0.25)
'''


class Steer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="steer-"))
        self.log = self.tmp / "argv.jsonl"
        self.reg = json.loads(json.dumps(A.load()))
        self.enterContext(mock.patch.object(A, "CANCEL_POLL", 0.3))
        for j in Q.jobs(type="steer_t", live_only=True):  # each test claims its own job: none left from another
            Q.cancel(j["id"])

    def tearDown(self):
        # nothing of these left open or live: move_check runs this suite on the queue its picker's checks use (its
        # gate waits for no live attempt). A runner would end the attempt; here the test does
        for j in Q.jobs(type="steer_t"):
            if j.get("live") is not None:
                Q.stopped(j["id"], attempt=j["live"])
            if j["status"] in (*Q.LIVE, "paused"):
                Q.cancel(j["id"])
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, name, body, sid="sess-1"):
        f = self.tmp / name
        f.write_text(body.replace("open(LOG,", f"open({str(self.log)!r},").replace("if SID:", f"if {sid!r}:")
                     .replace('o["session_id"] = SID', f'o["session_id"] = {sid!r}'))
        f.chmod(0o755)
        self.reg["binaries"][name] = str(f)

    def job(self):
        j = Q.enqueue(type="steer_t", kind="revise", card="c1", text="the job")
        return j["id"]

    def run_agent(self, name, jid, steer_at=None, words="warmer, please"):
        c = Q.claim_next("steer_t", types=["steer_t"])
        self.assertEqual(c["id"], jid)
        if steer_at is not None:
            threading.Timer(steer_at, lambda: Q.steer(jid, words)).start()
        with T.bound(job=jid, attempt=c["attempt"]):
            return A.run(name, "THE BRIEF", self.tmp, self.tmp / "agent.log", model=None, effort=None, reg=self.reg)

    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()]

    def test_a_steer_waits_for_the_running_tool_then_claude_goes_on_with_its_session(self):
        self.cli("claude", CLAUDE)
        jid = self.job()
        res = self.run_agent("claude", jid, steer_at=0.6)
        calls = self.calls()
        runs = [c for c in calls if "argv" in c]
        self.assertEqual(len(runs), 2, calls)
        again = runs[1]["argv"]
        self.assertEqual(again[again.index("--resume") + 1], "sess-1")
        self.assertIn("warmer, please", again[-1])
        self.assertIn("THE OPERATOR STEERS THIS JOB", again[-1])
        tool_done = next(c["t"] for c in calls if c.get("tool_done"))
        self.assertGreaterEqual(runs[1]["t"], tool_done, "it was stopped in the middle of the tool")
        self.assertTrue(res.ok, res.tail())
        self.assertIn("resumed with:", res.text)
        self.assertIn("[the operator steers", (self.tmp / "agent.log").read_text())
        self.assertEqual([s["text"] for s in Q.get(jid)["steers"]], ["warmer, please"])

    def test_codex_goes_on_with_exec_resume(self):
        self.cli("codex", CODEX)
        jid = self.job()
        res = self.run_agent("codex", jid, steer_at=0.6)
        runs = [c["argv"] for c in self.calls() if "argv" in c]
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[1][:2], ["exec", "resume"])
        self.assertEqual(runs[1][-2], "0123abcd-0000-1111-2222-333344445555")
        self.assertIn("warmer, please", runs[1][-1])
        self.assertNotIn("-C", runs[1])
        self.assertTrue(res.ok, res.tail())

    def test_with_no_session_seen_it_starts_again_with_the_words(self):
        self.cli("claude", CLAUDE, sid="")
        jid = self.job()
        self.run_agent("claude", jid, steer_at=0.6)
        runs = [c["argv"] for c in self.calls() if "argv" in c]
        self.assertGreaterEqual(len(runs), 2)
        self.assertNotIn("--resume", runs[1])
        self.assertTrue(runs[1][-1].startswith("THE BRIEF"))
        self.assertIn("THE OPERATOR STEERED THIS JOB", runs[1][-1])
        self.assertIn("warmer, please", runs[1][-1])

    def test_steers_given_before_the_agent_starts_come_with_its_brief(self):
        self.cli("codex", CODEX)
        jid = self.job()
        self.assertTrue(Q.steer(jid, "keep the kick"))
        self.run_agent("codex", jid)
        first = [c["argv"] for c in self.calls() if "argv" in c][0]
        self.assertIn("THE OPERATOR STEERED THIS JOB", first[-1])
        self.assertIn("- keep the kick", first[-1])

    def test_a_runner_reads_the_steers_as_they_are_now(self):
        from picker import sdk
        jid = self.job()
        Q.steer(jid, "one")
        Q.steer(jid, "two")
        self.assertEqual([x["text"] for x in sdk.steers({"id": jid})], ["one", "two"])
        self.assertTrue(all(isinstance(x["ts"], float) for x in sdk.steers({"id": jid})))

    def test_a_pause_still_stops_it_and_a_finished_job_takes_no_steer(self):
        self.cli("codex", CODEX)
        jid = self.job()
        threading.Timer(0.5, lambda: Q.pause(jid)).start()
        res = self.run_agent("codex", jid)
        self.assertTrue(res.cancelled)
        self.assertEqual(len([c for c in self.calls() if "argv" in c]), 1, "a pause resumed nothing")
        Q.cancel(jid)
        self.assertFalse(Q.steer(jid, "too late"))


class SteerRoute(unittest.TestCase):
    def setUp(self):
        from flask import Flask
        from api import queue as AQ
        app = Flask(__name__)
        app.register_blueprint(AQ.bp)
        self.c = app.test_client()

    def test_the_route(self):
        jid = Q.enqueue(type="steer_t", kind="revise", card="c1", text="t")["id"]
        self.assertEqual(self.c.post(f"/api/queue/{jid}/steer", json={"text": "  "}).status_code, 400)
        r = self.c.post(f"/api/queue/{jid}/steer", json={"text": "softer"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual([s["text"] for s in r.get_json()["job"]["steers"]], ["softer"])
        Q.cancel(jid)
        self.assertEqual(self.c.post(f"/api/queue/{jid}/steer", json={"text": "late"}).status_code, 409)
        self.assertEqual(self.c.post("/api/queue/nosuchjob/steer", json={"text": "x"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
