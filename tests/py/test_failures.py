"""Exercise runner failures on scratch stores with mock agents; retries must not duplicate published work."""
import _cfg  # noqa: F401
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

PICKER = _cfg.PICKER
os.environ.setdefault("PICKER_TRACE", str(Path(tempfile.mkdtemp()) / "trace.jsonl"))
from core import queue as Q  # noqa: E402

MOCK = PICKER / "tests" / "fixture" / "mock_researcher.py"


class Bench(unittest.TestCase):
    """A store, a queue and a config of their own, for the mock type `mock`, with one card, c1 v1."""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="picker-bench-"))
        self.home = self.d / "runner"
        (self.home / "runs" / "c1").mkdir(parents=True)
        (self.home / "program.md").write_text("a mock\n")
        v1 = {"n": 1, "id": "v1", "job": None, "created": 1.0}
        (self.home / "runs" / "c1" / "v1.json").write_text(json.dumps(v1))
        (self.d / "store" / "c1").mkdir(parents=True)                    # as mock_sync.py projects it
        (self.d / "store" / "c1" / "card.json").write_text(json.dumps(
            {"id": "c1", "type": "mock", "label": "c1", "created": 1.0, "versions": [v1], "media": {}}))
        (self.d / "mock.json").write_text(json.dumps({
            "type": "mock", "label": "mock", "kind": "picked", "researcher": str(self.home / "queue_runner.py"),
            "start": [sys.executable, str(MOCK)], "agents": ["claude", "codex"],
            "program": str(self.home / "program.md"), "outputs": [str(self.home / "runs")], "cards": str(self.d / "store"),
            "sync": {"argv": ["{python}", str(PICKER / "tests" / "fixture" / "mock_sync.py")], "cwd": "."}}))
        (self.d / "picker.toml").write_text(
            f'data = "data"\nstate = "state"\ncache = "cache"\ndownloads = "downloads"\n'
            f'agents = "{PICKER / "agents.json"}"\ntypes = ["{self.d / "mock.json"}"]\nresearch = "{self.d}"\n')
        self.data = self.d / "data"
        self.env = {**os.environ, "PICKER_CONFIG": str(self.d / "picker.toml"), "MOCK_HOME": str(self.home),
                    "MOCK_STORE": str(self.d / "store"), "PYTHONPATH": str(PICKER),
                    "PICKER_URL": "http://127.0.0.1:9", "PICKER_TRACE": str(self.d / "trace.jsonl")}
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                self.kill(p)
        shutil.rmtree(self.d, ignore_errors=True)

    def py(self, code: str) -> str:
        r = subprocess.run([sys.executable, "-c", code], env=self.env, capture_output=True, text=True, timeout=30)
        if r.returncode:
            raise AssertionError(f"{code}\n{r.stderr[-1500:]}")
        return r.stdout.strip()

    def enqueue(self, mode: str, *, kind="revise", card="c1", backend=None) -> str:
        return Q.enqueue(type="mock", kind=kind, card=card, text=f"[mock {mode}]", backend=backend, root=self.data)["id"]

    def start(self) -> subprocess.Popen:
        with open(self.d / "runner.log", "a") as log:
            p = subprocess.Popen([sys.executable, str(MOCK)], env=self.env, cwd=str(self.home), stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        self.procs.append(p)
        return p

    def drain(self, timeout=20.0) -> int:
        p = self.start()
        try:
            return p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill(p)
            raise AssertionError(f"the runner was still at work after {timeout} s:\n{self.log()}") from None

    def kill(self, p):
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        p.wait()

    def log(self) -> str:
        f = self.d / "runner.log"
        return f.read_text()[-3000:] if f.is_file() else ""

    def job(self, jid: str) -> dict:
        return Q.fold(root=self.data)[jid]

    def until(self, test, timeout=10.0, what="it"):
        end = time.time() + timeout
        while time.time() < end:
            got = test()
            if got:
                return got
            time.sleep(0.1)
        raise AssertionError(f"{what} didn't happen in {timeout} s\n{self.log()}")

    def versions(self, card="c1") -> list:
        f = self.d / "store" / card / "card.json"
        return json.loads(f.read_text())["versions"] if f.is_file() else []

    def calls(self, jid: str) -> int:
        f = self.home / "calls.jsonl"
        return sum(1 for ln in f.read_text().splitlines() if json.loads(ln)["job"] == jid) if f.is_file() else 0

    def recover(self) -> list:
        """The scheduler's minute, on this store: a dead lane's attempts released."""
        return json.loads(self.py("import json; from core import lanes; print(json.dumps(lanes.recover()))"))

    def test_ok_is_done_with_one_version_stamped_with_its_job(self):
        jid = self.enqueue("ok")
        self.drain()
        j = self.job(jid)
        self.assertEqual((j["status"], j["result"], j["attempts"]), ("done", "c1", 1), self.log())
        self.assertEqual([v["id"] for v in self.versions()], ["v1", "v2"])
        self.assertEqual(self.versions()[-1]["job"], jid, "PICKER_JOB, from the runner to what it publishes")

    def test_unchanged_is_done_and_says_why_without_a_red_row(self):
        jid = self.enqueue("unchanged")
        self.drain()
        j = self.job(jid)
        self.assertEqual((j["status"], j["result"]), ("done", None), self.log())
        self.assertIn("nothing beats", j["why"] or "")
        self.assertFalse(Q.is_open(j), "no row: nothing to retry or dismiss")
        self.assertEqual(len(self.versions()), 1)

    def test_nothing_named_fails(self):
        jid = self.enqueue("nothing")
        self.drain()
        j = self.job(jid)
        self.assertEqual(j["status"], "failed")
        self.assertIn("NothingMade", j["why"])

    def test_a_raise_fails_with_its_words(self):
        jid = self.enqueue("raise")
        self.drain()
        self.assertIn("mock: it broke", self.job(jid)["why"])

    def test_a_card_the_store_lacks_fails_saying_which(self):
        jid = self.enqueue("bad-ref")
        self.drain()
        j = self.job(jid)
        self.assertEqual(j["status"], "failed")
        self.assertIn("nosuch", j["why"])

    def test_out_of_usage_waits_and_work_with_no_agent_runs_meanwhile(self):
        a = self.enqueue("limited", backend="codex")
        b = self.enqueue("no-agent", backend="codex")
        self.drain()
        ja, jb = self.job(a), self.job(b)
        self.assertEqual(ja["status"], "waiting", self.log())
        self.assertGreater(ja["waiting"]["until"], time.time() + 3000)
        self.assertEqual(jb["status"], "done", "a job that asks no agent doesn't wait for one (R7)")

    def test_a_tool_past_its_deadline_is_stopped_with_what_it_started(self):
        jid = self.enqueue("hang")
        self.drain(timeout=15)
        j = self.job(jid)
        self.assertEqual(j["status"], "failed")
        self.assertIn("time", j["why"])
        self.assertEqual(self.versions()[-1]["id"], "v1")

    def test_a_pause_stops_a_long_tool_and_resume_waits_for_the_stop(self):
        jid = self.enqueue("slow-tool")
        p = self.start()
        self.until(lambda: self.job(jid)["phase"] == "tool", what="the tool started")
        t0 = time.time()
        Q.pause(jid, root=self.data)
        Q.resume(jid, root=self.data)                    # at once: its first attempt is still at work
        self.assertIsNone(Q.claim_next("bench", types=["mock"], root=self.data),
                          "claimed again while its first attempt still ran")
        # the tool (20 s) is stopped within a poll, the attempt ends `stopped`, and only then the runner claims it again
        self.until(lambda: self.job(jid)["attempts"] == 2, timeout=8, what="the stop and the second claim")
        self.assertLess(time.time() - t0, 8)
        Q.cancel(jid, root=self.data)
        self.assertEqual(p.wait(timeout=10), 0)
        self.assertEqual(self.job(jid)["live"], None, "the cancelled attempt didn't end")
        self.assertEqual(self.versions()[-1]["id"], "v1", "a stopped tool published")

    def test_a_runner_killed_before_it_publishes_is_recovered_and_made_once(self):
        jid = self.enqueue("die-before")
        self.drain()
        self.assertEqual(self.job(jid)["status"], "running")
        self.assertEqual(self.recover(), [jid])
        self.assertEqual(self.job(jid)["status"], "queued")
        Q.edit(jid, "[mock ok]", root=self.data)       # the second attempt goes well
        self.drain()
        self.assertEqual((self.job(jid)["status"], self.job(jid)["attempts"]), ("done", 2))
        self.assertEqual(len(self.versions()), 2)

    def test_a_runner_killed_after_its_work_returned_syncs_again_without_the_work(self):
        """The work's receipt (`made`, written before the sync): the retry syncs, the work isn't run again."""
        jid = self.enqueue("die-in-sync")
        self.drain()
        self.assertEqual(self.recover(), [jid])
        self.drain()
        j = self.job(jid)
        self.assertEqual((j["status"], j["attempts"]), ("done", 2), self.log())
        self.assertEqual([v["id"] for v in self.versions()], ["v1", "v2"])
        self.assertEqual(self.calls(jid), 1, "the work ran again")

    def test_a_runner_killed_inside_its_work_does_it_again(self):
        """A publication stamp identifies the producer but does not prove work finished; only a receipt permits skipping work."""
        jid = self.enqueue("die-after-publish")
        self.drain()
        self.assertEqual(self.recover(), [jid])
        Q.edit(jid, "[mock ok]", root=self.data)
        self.drain()
        self.assertEqual((self.job(jid)["status"], self.calls(jid)), ("done", 2))

    def test_a_runner_starting_in_a_dead_runners_lane_hands_it_over_first(self):
        """SDK starts must finish dead-runner handover before reclaiming its job."""
        jid = self.enqueue("die-first-try")
        self.drain()
        self.assertEqual(self.job(jid)["status"], "running")
        self.drain()                                   # no recover(): the new runner's own handover
        j = self.job(jid)
        self.assertEqual((j["status"], j["attempts"]), ("done", 2), self.log())

    def test_a_lane_being_cleaned_up_takes_no_runner_and_a_stale_orphan_changes_nothing(self):
        import runner as R
        jid = self.enqueue("ok")
        with R.taken(self.home) as groups:              # the picker's look, cleaning up
            self.assertIsNotNone(groups)
            self.assertEqual(self.drain(), 0)
            self.assertEqual(self.job(jid)["status"], "queued", "a runner started while the lane was cleaned up")
        first = Q.claim_next("r1", types=["mock"], root=self.data)
        Q.orphan(jid, attempt=first["attempt"], root=self.data)
        second = Q.claim_next("r2", types=["mock"], root=self.data)
        self.assertFalse(Q.orphan(jid, attempt=first["attempt"], root=self.data))
        self.assertEqual(self.job(jid)["live"], second["attempt"], "a stale orphan ended the new attempt")

    def test_a_dry_run_outside_the_harness_takes_no_job(self):
        """Dry runs may claim only when the fixture harness explicitly enables them."""
        jid = self.enqueue("ok")
        r = subprocess.run([sys.executable, str(MOCK), "--dry-run"], env=self.env, cwd=str(self.home),
                           capture_output=True, text=True, timeout=30)
        self.assertIn("test harness", r.stdout)
        self.assertEqual(self.job(jid)["status"], "queued")

    def test_what_a_dead_runner_left_running_in_two_threads_is_stopped(self):
        """Track every tool process group so a killed runner leaves no child writing during a retry."""
        jid = self.enqueue("die-two-tools")
        self.drain()
        def alive():                               # a `sleep 31.4159` still running (by its own cmdline, not a shell's)
            pids = subprocess.run(["pgrep", "-x", "sleep"], capture_output=True, text=True).stdout.split()
            for p in pids:
                try:
                    if b"31.4159" in Path(f"/proc/{p}/cmdline").read_bytes():
                        return True
                except OSError:
                    pass
            return False
        self.assertTrue(alive(), "the tool in the thread should outlive its runner until the recovery")
        self.assertEqual(self.recover(), [jid])
        self.until(lambda: not alive(), timeout=15, what="the thread's tool stopped")

    def test_a_failed_sync_is_tried_again_without_the_work(self):
        jid = self.enqueue("sync-fails-once")
        self.drain()
        self.assertEqual(self.job(jid)["status"], "failed")
        Q.requeue(jid, root=self.data)
        self.drain()
        self.assertEqual(self.job(jid)["status"], "done", self.log())
        self.assertEqual(len(self.versions()), 2)
        self.assertEqual(self.calls(jid), 1, "the work ran again for a sync that failed")

    def test_a_second_runner_for_a_lane_leaves_it_to_the_first(self):
        a = self.enqueue("slow-tool")
        b = self.enqueue("ok")
        p1 = self.start()
        self.until(lambda: self.job(a)["status"] == "running", what="the first claimed")
        p2 = self.start()
        self.assertEqual(p2.wait(timeout=10), 0)
        self.assertEqual(self.job(b)["status"], "queued", "two runners in one lane")
        self.kill(p1)

    def test_a_cancel_racing_a_finish_stands_and_the_output_stays(self):
        jid = self.enqueue("slow-ok")
        p = self.start()
        self.until(lambda: self.calls(jid), what="the work started")
        Q.cancel(jid, root=self.data)
        p.wait(timeout=15)
        self.assertEqual(self.job(jid)["status"], "cancelled")
        self.assertEqual(len(self.versions()), 2, "what it made stays")


class Journal(unittest.TestCase):
    """The queue's own rules, on a temp root: no runner, no store."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def enqueue(self) -> str:
        return Q.enqueue(type="mock", kind="revise", card="c1", text="", root=self.root)["id"]

    def job(self, jid: str) -> dict:
        return Q.fold(root=self.root)[jid]

    def test_a_resumed_job_waits_for_its_stopped_attempt(self):
        """A pause stops the attempt it lands on; resumed at once, the job is claimed again only after that stop."""
        jid = self.enqueue()
        first = Q.claim_next("r1", types=["mock"], root=self.root)
        Q.pause(jid, root=self.root)
        Q.resume(jid, root=self.root)
        self.assertIsNone(Q.claim_next("r2", types=["mock"], root=self.root), "claimed beside its live attempt")
        Q.stopped(jid, attempt=first["attempt"], root=self.root)
        self.assertEqual(Q.claim_next("r2", types=["mock"], root=self.root)["attempt"], 2)

    def test_a_torn_last_line_does_not_hide_the_next_record(self):
        with open(self.root / "queue.jsonl", "a") as f:
            f.write('{"event": "enqueue", "id": "torn", "ty')
        self.assertIn(self.enqueue(), Q.fold(root=self.root))

    def test_a_stale_attempts_late_finish_is_ignored(self):
        jid = self.enqueue()
        first = Q.claim_next("r1", types=["mock"], root=self.root)
        Q.orphan(jid, attempt=1, root=self.root)
        second = Q.claim_next("r2", types=["mock"], root=self.root)
        self.assertEqual((first["attempt"], second["attempt"]), (1, 2))
        Q.failed(jid, "the first, late", attempt=1, root=self.root)
        self.assertEqual(self.job(jid)["status"], "running", "an old attempt's word ended the new one")
        Q.done(jid, "c1", attempt=2, root=self.root)
        self.assertEqual(self.job(jid)["status"], "done")


    def test_an_unnumbered_word_does_not_end_a_numbered_attempt(self):
        """A stale runner must not finish a newer attempt."""
        jid = self.enqueue()
        Q.claim_next("r1", types=["mock"], root=self.root)
        Q._append({"event": "done", "id": jid, "result": "c1"}, self.root)
        self.assertEqual(self.job(jid)["status"], "running")

    def test_what_a_tool_leaves_running_ends_with_it(self):
        """Stop the whole process group even after its leader exits."""
        from core import proc as P
        mark = self.root / "late"
        P.run(["sh", "-c", f"(sleep 2; touch {mark}) & exit 0"], stop=lambda: False)
        time.sleep(3)
        self.assertFalse(mark.exists(), "a leftover child wrote after its job's tool had ended")

    def test_a_sync_waits_for_another_only_as_long_as_one_can_last(self):
        """A sync deadline must release the type lock and report the timeout."""
        from core import researcher as RS
        old = RS.SYNC_S, RS.LOCK_GRACE
        RS.SYNC_S, RS.LOCK_GRACE = 0.3, 0.2
        try:
            with RS.sync_lock("bench"):
                t0 = time.time()
                th = []
                import threading
                def other():
                    try:
                        with RS.sync_lock("bench"):
                            th.append("got it")
                    except RuntimeError as e:
                        th.append(str(e))
                x = threading.Thread(target=other)
                x.start()
                x.join(5)
            self.assertIn("waited", th[0])
            self.assertLess(time.time() - t0, 3)
        finally:
            RS.SYNC_S, RS.LOCK_GRACE = old



class AutoOnce(unittest.TestCase):
    """AUTO repeats a card only after a relevant signal, job or new pass."""

    def setUp(self):
        from core import auto as AU, prefs as P
        self.AU, self.P = AU, P
        self.root = Path(tempfile.mkdtemp())
        self.cards = [{"id": i, "type": "t", "versions": [{"n": 1, "id": "v1"}]} for i in ("a", "b", "c")]
        self.started = []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def on(self, **tab):
        self.P.set("auto", {**self.AU.DEFAULTS, "on": True, "types": ["t"], "tabs": {"t": tab}}, root=self.root)

    def tick(self, now=None, cards=None):
        return self.AU.tick(cards=cards or (lambda: self.cards), start=lambda t, j: self.started.append(j["id"]),
                            root=self.root, now=now)

    def finish(self, jid, how="done"):
        n = Q.claim_next("t:r", types=["t"], root=self.root)["attempt"]
        (Q.done if how == "done" else Q.failed)(jid, *(["x"] if how == "done" else ["broke"]), attempt=n,
                                                 root=self.root)

    def taken(self) -> list:
        return [j["card"] for j in sorted(Q.fold(root=self.root).values(), key=lambda j: j["created"])
                if j["kind"] == "revise"]

    def test_each_card_once_then_only_a_change_makes_one_due(self):
        self.on()
        for _ in range(3):
            self.finish(self.tick()[0])
        self.assertEqual(sorted(self.taken()), ["a", "b", "c"])
        self.assertEqual(self.tick(), [], "a fourth while nothing changed")
        self.assertEqual(self.tick(now=time.time() + 30 * 3600), [], "a day later, nothing changed")
        d = self.root / "cards" / "b"
        d.mkdir(parents=True)
        (d / "signals.jsonl").write_text(json.dumps({"ts": time.time() + 1, "kind": "vote", "value": 1}) + "\n")
        self.assertEqual(Q.get(self.tick(now=time.time() + 2)[0], root=self.root)["card"], "b")

    def test_a_failed_job_holds_the_tab_until_retried_or_dismissed(self):
        self.on()
        jid = self.tick()[0]
        self.finish(jid, "failed")
        self.assertEqual(self.tick(now=time.time() + 3600), [], "a new job while the last one failed")
        Q.dismiss(jid, root=self.root)
        self.assertEqual(len(self.tick()), 1)

    def test_switched_off_while_it_looks_queues_nothing(self):
        self.on()

        def cards():
            self.P.set("auto", {**self.AU.DEFAULTS, "on": False, "types": ["t"]}, root=self.root)
            return self.cards
        self.assertEqual(self.tick(cards=cards), [])
        self.assertEqual(Q.fold(root=self.root), {})

    def test_a_survey_of_part_of_a_marked_pool_is_used_not_bought_again(self):
        """Survey only due cards, but record the resulting order against the whole pool."""
        from core import agents as A, survey as SV
        store = self.root / "cards"
        for cid in ("a", "b"):
            (store / cid).mkdir(parents=True)
            (store / cid / "card.json").write_text(json.dumps({"id": cid, "type": "t", "versions": [{"n": 1, "id": "v1"}]}))
            (store / cid / "signals.jsonl").write_text(json.dumps({"ts": 1, "kind": "pool", "pool": "auto",
                                                                    "value": True}) + "\n")
        self.cards = [{"id": c, "type": "t", "versions": [{"n": 1, "id": "v1"}], "pools": ["auto"]} for c in ("a", "b")]
        self.on(criterion="the due one")
        had = Q.enqueue(type="t", kind="revise", card="a", text="", group="auto", root=self.root)["id"]
        self.finish(had)
        sid = self.tick()[0]
        self.assertEqual(Q.get(sid, root=self.root)["kind"], "survey")
        job = Q.claim_next("t:r", types=["t"], root=self.root)
        here = self.root / "runner"

        ran = []

        def once(name, prompt, cwd, log, **k):
            ran.append(k.get("model"))
            SV.answer_path(job, here).write_text(json.dumps({"order": [{"card": "b", "why": "due"}], "report": "r"}))
            return A.AgentResult(agent=name, model=None, effort=None, exit=0, text="ok")
        job = {**job, "model": A.cached_catalogue("claude")["models"][0]["id"]}    # the model picked for it
        with mock.patch.object(A, "run", once):
            SV.fulfil(job, "claude", here, here, lambda t: None, root=self.root, store=store)
        self.assertEqual(ran, [job["model"]], "the survey ran its job's model, not ⚙'s")
        Q.done(sid, None, attempt=job["attempt"], root=self.root)
        j = Q.get(self.tick()[0], root=self.root)
        self.assertEqual((j["kind"], j["card"]), ("revise", "b"), "surveyed again instead of making from the order")

    def test_a_vote_given_while_its_job_ran_makes_the_card_due(self):
        """Votes after claim time were not visible to that job and must remain due."""
        self.cards = self.cards[:1]
        self.on()
        jid = self.tick()[0]
        Q.claim_next("t:r", types=["t"], root=self.root)
        d = self.root / "cards" / "a"
        d.mkdir(parents=True)
        time.sleep(0.01)
        (d / "signals.jsonl").write_text(json.dumps({"ts": time.time(), "kind": "vote", "value": 1}) + "\n")
        Q.done(jid, "x", attempt=1, root=self.root)
        self.assertEqual(Q.get(self.tick()[0], root=self.root)["card"], "a", "the vote it never saw was swallowed")

    def test_an_auto_job_is_settled_from_the_queue(self):
        """Jobs without an AUTO log entry must still settle through queue state."""
        from core import autolog as AL
        AL.append("t", {"event": "nothing", "job": "older", "card": "z"}, self.root)    # the log's start
        jid = Q.enqueue(type="t", kind="revise", card="a", text="", group="auto", root=self.root)["id"]
        self.finish(jid)
        self.AU.reconcile("t", root=self.root)
        self.assertIn(jid, [e.get("job") for e in AL.read("t", self.root) if e.get("event") == "nothing"])

    def test_keep_is_on_the_job(self):
        self.on(keep=True)
        j = Q.get(self.tick()[0], root=self.root)
        self.assertIs(j.get("keep"), True, "keep lives on the job, not in a second log")


if __name__ == "__main__":
    unittest.main()
