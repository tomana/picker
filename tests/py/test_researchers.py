"""Patch all agent calls before runner work; real subprocess cases use fake CLI scripts only."""
import _cfg  # noqa: F401
import importlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = _cfg.RESEARCH                                  # the research the tests' config names
PICKER = _cfg.PICKER
sys.path.insert(0, str(PICKER))
from core import config as _C  # noqa: E402
# Redirect every test trace away from production state.
_TRACE = tempfile.mkdtemp()
import os                                              # noqa: E402
os.environ["PICKER_TRACE"] = str(Path(_TRACE) / "trace.jsonl")
from core import agents as A                          # noqa: E402
from core import researcher as RS                     # noqa: E402
from core import worker as W                          # noqa: E402
# Use an unknown, non-producing job kind when checking agent invocation only.
NOCARD = "nocard"









def agent_as(fake):
    """`fake` stands in for core/agents.run (one CLI run) while the block runs."""
    return mock.patch.object(A, "run", fake)

class ResultNaming(unittest.TestCase):
    """Resolve only explicitly reported results after sync; concurrent publications must not become this job result."""

    def setUp(self):
        self.store = Path(tempfile.mkdtemp())
        self.real = RS.sync
        RS.ST.use([self.store])
        RS.sync = lambda type_: None
        self.card("parent-1", versions=1)

    def tearDown(self):
        RS.ST.use(None)
        RS.sync = self.real
        shutil.rmtree(self.store, ignore_errors=True)

    def card(self, cid, versions=1, created=1, job=None, parts=None):
        d = self.store / cid
        d.mkdir(exist_ok=True)
        (d / "card.json").write_text(json.dumps({
            "id": cid, "created": created, "lineage": {"parent": None, "why": None},
            "versions": [{"n": n + 1, "id": f"v{n + 1}",
                          **({"parts": [{"id": parts[n]}]} if parts else {})} for n in range(versions)],
            **({"origin": {"job": job}} if job else {})}))

    def fulfil(self, job, work):
        job = {"id": "j1", "type": "t", **job}
        with mock.patch.object(RS, "sync", lambda t: None):
            return job, RS.fulfil_with("t", lambda j, r: work())(job, lambda s: None)

    def why(self, cid):
        return json.loads((self.store / cid / "card.json").read_text())["lineage"]

    def test_a_new_card_is_the_result_and_gets_its_lineage(self):
        job, got = self.fulfil({"kind": "inspire", "card": "parent-1", "text": "make it blue"},
                               lambda: (self.card("child-1", created=5), [{"card": "child-1"}])[1])
        self.assertEqual((got, job["_versions"]), ("child-1", [("child-1", "v1")]))
        self.assertEqual((self.why("child-1")["parent"], self.why("child-1")["why"]), ("parent-1", "make it blue"))

    def test_a_new_version_names_the_card_it_grew_unstamped(self):
        job, got = self.fulfil({"kind": "revise", "card": "parent-1", "text": "again"},
                               lambda: (self.card("parent-1", versions=2), [{"card": "parent-1", "version": "v2"}])[1])
        self.assertEqual((got, job["_versions"]), ("parent-1", [("parent-1", "v2")]))
        self.assertIsNone(self.why("parent-1")["why"])                      # a card is not based on itself

    def test_a_part_is_found_in_the_store(self):
        # One sync may publish both a stack version and an independent card.
        def work():
            self.card("parent-1", versions=2, parts=["parent-1", "cand-a"])
            self.card("cand-b", created=7, parts=["cand-b"])
            return [{"part": "cand-a"}, {"part": "cand-b"}]
        job, got = self.fulfil({"kind": "inspire", "card": "parent-1", "text": "x", "count": 2}, work)
        self.assertEqual(job["_versions"], [("parent-1", "v2"), ("cand-b", "v1")])
        self.assertEqual(got, "cand-b")

    def test_another_lanes_card_is_not_the_result_nor_stamped(self):
        # a revise in another lane grows a card while this job publishes its own: only this job's card is its result
        def work():
            self.card("other-lane", created=9, job="codexjob")
            self.card("parent-1", versions=2)
            return [{"card": "parent-1", "version": "v2"}]
        job, got = self.fulfil({"kind": "revise", "card": "parent-1", "text": "like h:x"}, work)
        self.assertEqual(got, "parent-1")
        self.assertIsNone(self.why("other-lane")["parent"])

    def test_the_newest_of_several_new_cards_is_the_result_and_each_is_stamped(self):
        def work():
            self.card("old-ish", created=5)
            self.card("newest", created=9)
            return [{"card": "old-ish"}, {"card": "newest"}]
        job, got = self.fulfil({"kind": "inspire", "card": "parent-1", "text": "two", "count": 2}, work)
        self.assertEqual(got, "newest")
        self.assertEqual({self.why(c)["why"] for c in ("old-ish", "newest")}, {"two"})

    def test_a_retry_names_its_card_again_and_makes_no_second(self):
        # the first attempt made and synced it, then failed; the retry finds it there and names it
        self.card("mine", created=5, job="j1")
        job, got = self.fulfil({"kind": "inspire", "card": "parent-1", "text": "again"}, lambda: [{"card": "mine"}])
        self.assertEqual(got, "mine")
        self.assertEqual(self.why("mine")["why"], "again")                  # its own job's: stamped
        self.assertEqual(len([d for d in self.store.iterdir()]), 2)

    def test_the_same_input_names_another_jobs_card_unstamped(self):
        # fx_music's transcribe: the same recording makes the same card, which an earlier job made
        self.card("made-before", created=5, job="j0")
        job, got = self.fulfil({"kind": "seed", "card": None, "text": "again"}, lambda: [{"card": "made-before"}])
        self.assertEqual(got, "made-before")
        self.assertIsNone(self.why("made-before")["why"])

    def test_what_the_store_lacks_after_the_sync_fails_the_job(self):
        for made in ([{"card": "nosuch"}], [{"card": "parent-1", "version": "v9"}], [{"part": "nowhere"}]):
            with self.subTest(made=made), self.assertRaises(RuntimeError):
                self.fulfil({"kind": "inspire", "card": "parent-1"}, lambda: made)

    def test_an_operators_archive_is_not_undone(self):
        (self.store / "parent-1/signals.jsonl").write_text(json.dumps(
            {"ts": 1, "kind": "archive", "value": True}) + "\n")
        self.fulfil({"id": "j2", "kind": "seed", "card": None}, lambda: [{"card": "parent-1"}])
        self.assertEqual(len((self.store / "parent-1/signals.jsonl").read_text().splitlines()), 1)

    def test_nothing_made_is_none(self):
        self.assertIsNone(self.fulfil({"kind": NOCARD, "card": "parent-1"}, lambda: None)[1])

    def test_a_card_job_that_makes_nothing_fails(self):
        # Producing no card is a failure for jobs that require one.
        for kind in ("seed", "inspire", "revise"):
            with self.assertRaises(RS.NothingMade):
                self.fulfil({"kind": kind, "card": "parent-1"}, lambda: [])


class RequestImages(unittest.TestCase):
    """Request images belong to the job and its output, not the parent card."""

    def setUp(self):
        from core import queue as Q
        self.Q = Q
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_images_are_written_before_the_job_exists(self):
        job = self.Q.enqueue(type="t", kind="seed", text="look",
                             attachments=[(b"\x89PNG-a", "png"), (b"GIF8-b", "gif")],
                             root=self.root)
        d = self.Q.media_dir(job["id"], self.root)
        self.assertEqual(job["attachments"], ["att_1.png", "att_2.gif"])
        self.assertEqual((d / "att_1.png").read_bytes(), b"\x89PNG-a")
        self.assertEqual(self.Q.fold(self.root)[job["id"]]["attachments"],
                         ["att_1.png", "att_2.gif"],
                         "the log does not remember the request's images")

    def test_the_log_holds_names_not_bytes(self):
        self.Q.enqueue(type="t", kind="seed", attachments=[(b"x" * 5000, "png")],
                       root=self.root)
        line = (self.root / "queue.jsonl").read_text()
        self.assertLess(len(line), 600, "image bytes leaked into queue.jsonl")

    def test_a_job_without_images_is_unchanged(self):
        job = self.Q.enqueue(type="t", kind="seed", text="plain", root=self.root)
        self.assertEqual(job["attachments"], [])
        self.assertFalse(self.Q.media_dir(job["id"], self.root).exists())

    def test_the_brief_names_the_request_images_first(self):
        job = self.Q.enqueue(type="t", kind="seed", attachments=[(b"img", "png")],
                             root=self.root)
        real = self.Q.media_dir
        self.Q.media_dir = lambda jid, root=None: real(jid, self.root)
        try:
            note = RS.attachment_note(job, self.root)
        finally:
            self.Q.media_dir = real
        self.assertIn("TO THIS REQUEST", note)
        self.assertIn("att_1.png", note)


class AgentLayer(unittest.TestCase):
    """Use one argv builder and isolate agent preferences from live state."""

    def setUp(self):
        # Isolate registry tests from live preferences; overlay tests pass preferences explicitly.
        self._chosen = A.chosen
        A.chosen = lambda prefs=None: (self._chosen(prefs) if prefs is not None else {})

    def tearDown(self):
        A.chosen = self._chosen

    def reg(self, **codex):
        r = A.load()
        r = json.loads(json.dumps(r))
        r["agents"]["codex"].update(codex)
        return r

    def test_every_cli_gets_model_and_effort_its_own_way(self):
        from dataclasses import replace
        cfg = replace(_C.get(), unrestricted_agents=True)
        self.enterContext(mock.patch.object(_C, "get", return_value=cfg))
        cwd = Path("/w")
        real = A.argv

        def argv(*a, **k):                    # argv[0] is a resolved path; compare names
            cmd = real(*a, **k)
            return [os.path.basename(cmd[0])] + cmd[1:]
        A.argv = argv
        self.addCleanup(setattr, A, "argv", real)
        self.assertEqual(A.argv("claude", "P", cwd, model="opus", effort="high"),
                         ["claude", "--output-format", "stream-json", "--verbose",
                          "--model", "opus", "--effort", "high", "-p", "P"])
        self.assertEqual(A.argv("codex", "P", cwd, model="gpt-5.5", effort="high"),
                         ["codex", "exec", "-m", "gpt-5.5",
                          "-c", "model_reasoning_effort=high", "-C", "/w",
                          "--dangerously-bypass-approvals-and-sandbox", "P"])
        self.assertEqual(A.argv("antigravity", "P", cwd, model="g-1", effort="low"),
                         ["agy", "--dangerously-skip-permissions", "--model", "g-1",
                          "--effort", "low", "--add-dir", "/w", "--print", "P"])

    def test_a_cli_is_found_even_off_the_inherited_path(self):
        # Resolve fake CLIs outside PATH without relying on installed agent binaries.
        where = Path(tempfile.mkdtemp(prefix="cli-"))
        (where / "codex").write_text("#!/bin/sh\n")
        (where / "codex").chmod(0o755)
        was, extra = os.environ["PATH"], A.EXTRA_PATH
        os.environ["PATH"], A.EXTRA_PATH = "/usr/bin:/bin", [str(where)]
        try:
            self.assertEqual(A.binary("codex"), str(where / "codex"), "codex not found off PATH")
            self.assertIn(str(where), A.agent_env()["PATH"])
        finally:
            os.environ["PATH"], A.EXTRA_PATH = was, extra
            shutil.rmtree(where, ignore_errors=True)

    def test_no_choice_means_the_clis_own_default(self):
        cmd = A.argv("codex", "P", Path("/w"), model=None, effort=None)
        self.assertNotIn("-m", cmd)
        self.assertFalse(any("model_reasoning_effort=" in x for x in cmd))

    def test_the_operators_choice_overlays_the_registry(self):
        prefs = {"agents": {"codex": {"model": "gpt-5.5", "effort": "high"}}}
        self.assertEqual(A.choice("codex", prefs=prefs),
                         {"model": "gpt-5.5", "effort": "high", "session_cap": 100, "set_by": "operator"})
        self.assertEqual(A.choice("codex", prefs={})["set_by"], "default")

    def test_a_model_changed_in_the_registry_changes_for_every_type(self):
        # SSOT: one line in agents.json, and all three types' argv follow.
        r = self.reg(model="gpt-test-1")
        c = A.choice("codex", reg=r, prefs={})
        cmd = A.argv("codex", "P", Path("/w"), model=c["model"], effort=None, reg=r)
        self.assertEqual(cmd[cmd.index("-m") + 1], "gpt-test-1")

    def test_no_model_name_is_written_in_python(self):
        # Model names belong in the registry, not Python logic.
        import re
        pat = re.compile(r"gpt-6-astra|gpt-5\.5|claude-opus|claude-fable|gemini-3\.")
        dirs = [PICKER / "core", PICKER / "api", *(m.parent for m in (PICKER / "examples").glob("*/picker-type.json"))]
        hits = [f"{f.relative_to(PICKER)}:{n}" for d in dirs for f in d.glob("*.py")
                for n, line in enumerate(f.read_text().splitlines(), 1)
                if pat.search(line) and not line.lstrip().startswith("#")]
        self.assertEqual(hits, [])

    def test_validation_uses_what_the_cli_offers(self):
        cat = {"cli": "codex", "efforts": [], "models": [
            {"id": "gpt-5.5", "label": "", "efforts": ["low", "high"]}]}
        self.assertIsNone(A.validate("codex", "gpt-5.5", "high", cat=cat))
        self.assertIn("no model", A.validate("codex", "gpt-9", None, cat=cat))
        self.assertIn("effort", A.validate("codex", "gpt-5.5", "ultra", cat=cat))
        self.assertIsNone(A.validate("codex", None, None, cat=cat))
        self.assertIn("effort", A.validate("claude", None, "ultra"))

    def _res(self, exit=0, text="ok", model="m"):
        return A.AgentResult(agent="codex", model=model, effort=None, exit=exit,
                             text=text, shown=[text])

    def test_only_a_rejected_rate_limit_event_is_a_limit(self):
        """Only rejected rate-limit events indicate exhaustion; allowed events do not turn crashes into usage waits."""
        from datetime import datetime, timedelta, timezone
        week = int((datetime.now(timezone.utc) + timedelta(days=5)).timestamp())
        routine = f'{{"type":"rate_limit_event","rate_limit_info":{{"status":"allowed_warning","resetsAt":{week}}}}}'
        self.assertIsNone(A.parse_rate_limit(routine + "\n" + '{"type":"result","is_error":true}'))
        crash = A.AgentResult(agent="claude", model="m", effort=None, exit=1,
                              text=routine + "\nError: unknown option --bad", shown=["Error: unknown option --bad"])
        self.assertIsInstance(A.failure(crash, "claude"), A.AgentFailed)
        self.assertNotIsInstance(A.failure(crash, "claude"), A.AgentLimited)
        rejected = routine.replace("allowed_warning", "rejected")
        got = A.parse_rate_limit(routine + "\n" + rejected)
        self.assertEqual(int(got.timestamp()), week)
        self.assertIsInstance(A.failure(A.AgentResult(agent="claude", model="m", effort=None, exit=1, text=rejected,
                                                      shown=[]), "claude"), A.AgentLimited)

    def test_a_quoted_limit_message_early_in_a_run_is_not_a_limit(self):
        """Recognize prose usage limits only in final output lines, not quoted file contents."""
        quoted = "# a comment: You've hit your usage limit. try again at 2:01 PM.\n" + "\n".join(f"line {i}" for i in range(60))
        self.assertIsNone(A.parse_rate_limit(quoted))
        self.assertIsNotNone(A.parse_rate_limit("\n".join(f"line {i}" for i in range(60))
                                                + "\nYou've hit your usage limit. try again at 2:01 PM."))

    def test_a_rate_limit_raises_with_its_reset(self):
        # never waited out in-process (that held the type's only runner for hours): the queue waits instead
        from datetime import datetime, timedelta, timezone
        soon = int((datetime.now(timezone.utc) + timedelta(minutes=5)).timestamp())
        said = f'{{"type":"rate_limit_event","rate_limit_info":{{"status":"rejected","resetsAt":{soon}}}}}'
        with agent_as(lambda *a, **k: self._res(1, said)), self.assertRaises(A.AgentLimited) as cm:
            A.run_job("claude", "P", Path("/w"), Path("/dev/null"))
        self.assertAlmostEqual(cm.exception.until.timestamp(), soon, delta=1)

    def test_out_of_credits_waits_on_its_own_model(self):
        seen = []

        def once(name, prompt, cwd, log, *, model, **k):
            seen.append(model)
            return self._res(1, "out of credits", model)
        with agent_as(once), self.assertRaises(A.AgentLimited):
            A.run_job("codex", "P", Path("/w"), Path("/dev/null"), reg=self.reg(model="tier-a"))
        self.assertEqual(seen, ["tier-a"], "one model, no other")

    def test_the_send_menu_is_the_newest_of_each_family(self):
        """New catalog entries must replace matching model slots without hardcoded model updates."""
        cat = lambda *ids: {"models": [{"id": i, "label": i} for i in ids]}
        ids = lambda name, c: [m["id"] for m in A.menu(name, cat=c)]
        self.assertEqual(ids("claude", cat("fable", "opus", "claude-fable-5-1", "claude-opus-5-5",
                                           "claude-opus-4-6", "claude-sonnet-5-5")),
                         ["claude-opus-5-5", "claude-fable-5-1"])
        self.assertEqual([m["label"] for m in A.menu("claude", cat=cat("claude-opus-5-5"))], ["opus 5.5"])
        self.assertEqual(ids("codex", cat("gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna",
                                          "gpt-5.6-sol")), ["gpt-6.1-sol", "gpt-6-astra"])
        self.assertEqual(ids("antigravity", cat(
            "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-3.8-flash-low",
            "gemini-3.8-flash-high", "gemini-3.5-flash-high", "claude-opus-5-5-high",
            "claude-sonnet-5-5-high", "gpt-oss-120b-medium")),
            ["gemini-3.8-flash-high", "gemini-4-argon-high", "claude-opus-5-5-high", "gpt-oss-120b-medium"])
        # Newly available models fill their matching slots without a code change.
        self.assertIn("gemini-4-pro-high", ids("antigravity", cat("gemini-4-pro-high", "gemini-4-pro-low")))
        self.assertEqual(ids("antigravity", cat("claude-opus-5-5-high", "claude-fable-5-1-high")),
                         ["claude-fable-5-1-high"])

    def test_a_job_can_name_its_model(self):
        """Run the job-selected model; inherit effort only if the stored catalog says the model supports it."""
        r = self.reg(model="tier-a")
        tmp = Path(tempfile.mkdtemp())
        saved = (A.MODELS_CACHE, A.chosen, A.catalogue)
        try:
            A.MODELS_CACHE = tmp / "agent_models.json"
            A.remember({"codex": {"cli": "codex", "efforts": [], "models": [
                {"id": "tier-x", "efforts": ["low"]}, {"id": "tier-y", "efforts": ["high"]}]}})
            A.chosen = lambda prefs=None: {"codex": {"model": "tier-a", "effort": "high"}}
            A.catalogue = lambda *a, **k: self.fail("asked the CLI")
            seen = []

            def once(name, prompt, cwd, log, *, model, effort, **k):
                seen.append((model, effort))
                return self._res(0, "ok", model)
            with agent_as(once):
                A.run_job("codex", "P", Path("/w"), Path("/dev/null"), reg=r, model="tier-x")
            self.assertEqual(seen, [("tier-x", None)])
            seen.clear()
            with agent_as(lambda *a, model, effort, **k: (seen.append((model, effort)), self._res(0))[1]):
                A.run_job("codex", "P", Path("/w"), Path("/dev/null"), reg=r, model="tier-y")
            self.assertEqual(seen, [("tier-y", "high")])
        finally:
            A.MODELS_CACHE, A.chosen, A.catalogue = saved
            shutil.rmtree(tmp, ignore_errors=True)

    def test_codex_reset_with_a_date_is_read(self):
        # Reset parsing must accept dates as well as bare times.
        from datetime import datetime
        got = A.parse_rate_limit("ERROR: You\u2019ve hit your usage limit. Upgrade to Pro (https://chatgpt.com"
                                 "/explore/pro), visit https://chatgpt.com/settings/usage to purchase more "
                                 "credits or try again at Oct 22nd, 2026 1:42 AM.")
        self.assertEqual(got, datetime(2026, 10, 22, 1, 42).astimezone())
        self.assertEqual(A.parse_rate_limit("hit your usage limit … try again at Nov 1st, 2026 12:05 PM.")
                         .replace(tzinfo=None), datetime(2026, 11, 1, 12, 5))

    def test_a_usage_window_waits(self):
        # a named reset time is a wait, on the job's own model
        r = self.reg(model="tier-a")
        seen = []

        def once(name, prompt, cwd, log, *, model, **k):
            seen.append(model)
            return self._res(1, "ERROR: You've hit your usage limit. Upgrade to Pro or "
                                "purchase more credits or try again at 4:19 AM.", model)
        with agent_as(once), self.assertRaises(A.AgentLimited):
            A.run_job("codex", "P", Path("/w"), Path("/dev/null"), reg=r)
        self.assertEqual(seen, ["tier-a"])

    def test_a_busy_model_waits_minutes_and_keeps_its_model(self):
        """Provider capacity is a short wait on the selected model, not a permanent failure."""
        from datetime import datetime
        r = self.reg(model="tier-a")
        seen = []

        def once(name, prompt, cwd, log, *, model, **k):
            seen.append(model)
            return self._res(1, "ERROR: Selected model is at capacity. Please try a different model.", model)
        with agent_as(once), self.assertRaises(A.AgentLimited) as cm:
            A.run_job("codex", "P", Path("/w"), Path("/dev/null"), reg=r)
        self.assertEqual(seen, ["tier-a"])
        left = (cm.exception.until - datetime.now().astimezone()).total_seconds()
        self.assertTrue(A.BUSY_WAIT - 30 < left <= A.BUSY_WAIT, left)
        self.assertTrue(str(cm.exception).startswith("codex's model is at capacity until "), str(cm.exception))
        claude = A.AgentResult(agent="claude", model="m", effort=None, exit=1, shown=[],
                               text='API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')
        self.assertIsInstance(A.failure(claude, "claude"), A.AgentLimited)
        self.assertNotIsInstance(A.failure(self._res(1, "ERROR: unexpected argument '--bad'"), "codex"), A.AgentLimited)

    def test_the_reason_is_the_error_line_not_the_stack(self):
        res = self._res(1, "")
        res.shown = ["Error authenticating: This client is no longer supported",
                     "at _doSetupUser (bundle.js:1)", "at process.tick (node:internal)"]
        self.assertIn("no longer supported", A.AgentFailed(res).args[0])

    def test_anything_else_fails_with_the_clis_words(self):
        with agent_as(lambda *a, **k: self._res(2, "boom: no such model")), self.assertRaises(A.AgentFailed) as cm:
            A.run_job("codex", "P", Path("/w"), Path("/dev/null"))
        self.assertIn("exited 2: boom: no such model", str(cm.exception))

    def test_a_failure_names_the_model_it_ran_with(self):
        res = A.AgentResult("antigravity", "gemini-3.8-flash-high", None, 3, text="AGY_ERROR: quota")
        self.assertTrue(str(A.AgentFailed(res)).startswith("antigravity (gemini-3.8-flash-high) exited 3"))

    def test_run_streams_logs_and_scrubs_the_nested_session(self):
    # A shell subprocess exercises the real pipe and process lifetime.
        tmp = Path(tempfile.mkdtemp())
        try:
            fake = tmp / "codex"
            fake.write_text('#!/bin/sh\necho "model=$3"\necho "nested=${CLAUDECODE:-no}"\n'
                            'echo READY\nexit 3\n')
            fake.chmod(0o755)
            r = self.reg()
            r["binaries"]["codex"] = str(fake)
            import os
            os.environ["CLAUDECODE"] = "1"
            try:
                res = A.run("codex", "P", tmp, tmp / "log.txt", model="gpt-x",
                            effort=None, reg=r)
            finally:
                os.environ.pop("CLAUDECODE", None)
            self.assertEqual(res.exit, 3)
            self.assertIn("model=gpt-x", res.text)
            self.assertIn("nested=no", res.text, "a nested-session var reached the agent")
            log = (tmp / "log.txt").read_text()
            self.assertIn("agent: codex  model: gpt-x", log)
            self.assertIn("READY", log)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class AgentLifetime(unittest.TestCase):
    """Deadlines must stop descendant processes too, or inherited pipes can keep drains blocked."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self._chosen = A.chosen                 # Keep live preferences out of argv tests.
        A.chosen = lambda prefs=None: (self._chosen(prefs) if prefs is not None else {})
        self.reg = json.loads(json.dumps(A.load()))

    def tearDown(self):
        A.chosen = self._chosen
        shutil.rmtree(self.tmp, ignore_errors=True)

    def cli(self, body):
        fake = self.tmp / "codex"
        fake.write_text("#!/bin/sh\n" + body)
        fake.chmod(0o755)
        self.reg["binaries"]["codex"] = str(fake)

    def test_a_child_that_keeps_the_pipe_does_not_hold_the_job(self):
        import time as _t
        self.cli('echo READY\n(sleep 20; echo late) &\nexit 0\n')
        old, A.DRAIN_S = A.DRAIN_S, 1
        try:
            t0 = _t.time()
            res = A.run("codex", "P", self.tmp, self.tmp / "log.txt", model=None, effort=None, reg=self.reg)
            self.assertLess(_t.time() - t0, 8, "it waited for the child's pipe")
            self.assertIn("READY", res.text)
        finally:
            A.DRAIN_S = old

    def test_the_deadline_stops_the_agent_and_what_it_started(self):
        import os
        import time as _t
        self.cli('(sleep 60) &\necho $! > child\necho READY\nsleep 60\n')
        t0 = _t.time()
        res = A.run("codex", "P", self.tmp, self.tmp / "log.txt", model=None, effort=None, reg=self.reg,
                    deadline=_t.time() + 1.5)
        self.assertTrue(res.timed_out)
        self.assertLess(_t.time() - t0, 20)
        pid = int((self.tmp / "child").read_text())
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            _t.sleep(0.1)
        else:
            self.fail("the agent's child outlived the deadline")


class Explain(unittest.TestCase):
    """Failure explanations must retain actionable short, detail and fix fields."""

    def case(self, why, stages=(), agent=None):
        return A.explain(why, list(stages), agent)

    def test_out_of_usage_says_until_when(self):
        e = self.case("AgentLimited: codex is out of usage until 14:01: ERROR: You've "
                      "hit your usage limit.", agent="codex")
        self.assertEqual(e["short"], "until 14:01")
        self.assertIn("14:01", e["fix"])

    def test_a_busy_model_is_yellow_not_out_of_usage(self):
        # Cover both pending waits and prior failures with the same cause.
        e = self.case("AgentLimited: codex's model is at capacity until 13:26: ERROR: Selected model is at capacity. "
                      "Please try a different model.", agent="codex")
        self.assertEqual(e["short"], "model busy · 13:26")
        self.assertIn("by itself", e["fix"])
        e = self.case("AgentFailed: codex exited 1: ERROR: Selected model is at capacity. Please try a different "
                      "model.", agent="codex")
        self.assertEqual(e["short"], "model busy")
        self.assertIn("send it again", e["fix"])

    def test_a_brief_over_one_argument_says_so(self):
        """Oversized CLI arguments must be reported as argument limits, not malformed briefs."""
        for why in ("OSError: [Errno 7] Argument list too long: 'codex'",
                    "OSError: [Errno 7] the brief is 1245 KiB and one argument holds 128 KiB — put the long part in a "
                    "file the brief points at"):
            self.assertEqual(self.case(why, ["runner up"], agent="codex")["short"], "brief too long", why)
        with mock.patch("subprocess.Popen", lambda *a, **k: self.fail("started a brief that can't be passed")), \
                self.assertRaises(OSError) as cm:
            A.run("codex", "x" * A.ONE_ARG, Path("/w"), Path("/dev/null"), model=None, effort=None)
        self.assertIn("one argument holds", str(cm.exception))

    def test_a_missing_cli_says_install(self):
        e = self.case("FileNotFoundError: [Errno 2] No such file or directory: 'codex'",
                      ["t runner up", "brief builds · 1k chars", "asking codex · gpt"], "codex")
        self.assertEqual(e["short"], "CLI missing")
        self.assertIn("install codex", e["fix"])

    def test_a_retired_login_says_log_in(self):
        e = self.case("AgentFailed: gemini exited 1: Error authenticating: This client "
                      "is no longer supported for Gemini Code Assist", agent="antigravity")
        self.assertEqual(e["short"], "not logged in")

    def test_a_sync_failure_names_the_sync(self):
        e = self.case("RuntimeError: sync failed (fx_music): links checked 1 broken")
        self.assertEqual(e["short"], "sync failed")
        self.assertIn("sync.py", e["fix"])

    def test_a_preflight_failure_is_named_by_what_is_missing(self):
        e = self.case("RuntimeError: preflight · sclang missing — not on PATH | fix: "
                      "sudo apt install supercollider")
        self.assertEqual((e["short"], e["fix"]), ("sclang missing",
                                                  "sudo apt install supercollider"))

    def test_a_blocked_write_is_cant_write(self):
        e = self.case("RuntimeError: claude answered READY but did not write "
                      "logs/wiring_x.txt in /w — it cannot write where its work goes")
        self.assertEqual(e["short"], "can't write")

    def test_the_unknown_keeps_the_clis_words(self):
        e = self.case("AgentFailed: codex exited 3: something new broke",
                      ["t runner up", "brief builds · 1k chars", "asking codex"], "codex")
        self.assertEqual(e["short"], "failed")
        self.assertIn("something new broke", e["detail"])

    def test_a_warning_stage_round_trips(self):
        said = []
        RS.warn(said.append, "render", "skipped: 9999 taken", "by render runner (pid 1)",
                "close render runner")
        self.assertEqual(A.parse_warn(said[0]), {"scope": "render",
                         "name": "skipped: 9999 taken", "detail": "by render runner (pid 1)",
                         "fix": "close render runner"})


class WiringCheck(unittest.TestCase):
    """The ping: a full round through a runner that proves it can reach its agent,
    and a queue that lets it through without touching real work."""

    def setUp(self):
        from core import queue as Q
        self.Q = Q
        self.root = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_ping_is_claimed_before_real_work(self):
        self.Q.enqueue(type="t", kind="seed", text="real", root=self.root)
        ping = self.Q.enqueue(type="t", kind="ping", backend="codex", root=self.root)
        got = self.Q.claim_next("t:x", types=["t"], root=self.root)
        self.assertEqual(got["id"], ping["id"])

    def test_a_pings_only_runner_never_takes_real_work(self):
        self.Q.enqueue(type="t", kind="seed", text="real", root=self.root)
        self.assertIsNone(self.Q.claim_next("t:x", types=["t"], kinds={"ping"},
                                            root=self.root))

    def ping_work(self, answer, brief=lambda job, agent: "b" * 3000, write=True,
                  preflight=None, exit=0, text=None):
        """A fake agent that, like a real one, writes the file it is asked to."""
        import re

        def once(name, prompt, cwd, log, **k):
            self.asked = (name, prompt)
            m = re.search(r"create the file (\S+)", prompt)
            if write and m:
                (Path(cwd) / m.group(1)).write_text("READY")
            return A.AgentResult(agent=name, model="m", effort=None, exit=exit,
                                 text=text or answer, shown=[text or answer])
        work = RS.ping_with("t", "claude", cwd=self.root, here=self.root, brief=brief, preflight=preflight)

        def patched(job, report):
            with agent_as(once), mock.patch.object(RS, "sync", lambda t: None):
                return work(job, report)
        return patched

    def test_the_agent_must_write_where_its_work_goes(self):
        with self.assertRaises(RuntimeError) as cm:
            self.ping_work("READY", write=False)({"id": "p4", "kind": "ping"},
                                                 lambda s: None)
        self.assertIn("did not write", str(cm.exception))
        self.assertFalse(list((self.root / "logs").glob("wiring_*")),
                         "the probe file was left behind")

    def test_out_of_usage_is_limited_not_broken(self):
        with self.assertRaises(A.AgentLimited) as cm:
            self.ping_work("x", exit=1, text="ERROR: You've hit your usage limit. "
                           "Upgrade… or try again at 2:01 PM.")({"id": "p5", "kind": "ping",
                                                                  "backend": "codex"},
                                                                 lambda s: None)
        self.assertTrue(str(cm.exception).startswith("codex is out of usage"))
        self.assertTrue(A.AgentLimited.__name__ == "AgentLimited")

    def test_a_preflight_warning_passes_and_a_failure_stops_it(self):
        said = []
        pf = lambda: [("ffmpeg", True, "/usr/bin/ffmpeg"),            # noqa: E731
                      ("render runner is running", None, "a render would kill it")]
        self.ping_work("READY", preflight=pf)({"id": "p6", "kind": "ping"}, said.append)
        self.assertIn("warn · preflight · render runner is running — a render would kill it", said)
        self.asked = None
        with self.assertRaises(RuntimeError) as cm:
            self.ping_work("READY", preflight=lambda: [("sclang", False, "not on PATH")])(
                {"id": "p7", "kind": "ping"}, lambda s: None)
        self.assertIn("preflight · sclang — not on PATH", str(cm.exception))
        self.assertIsNone(self.asked, "the agent was asked although the preflight failed")

    def test_ready_is_reported_through_every_step(self):
        said = []
        self.ping_work("READY")({"id": "p1", "kind": "ping", "backend": "codex"},
                                said.append)
        self.assertEqual(self.asked, ("codex", A.PING_WRITE.format(path="logs/wiring_p1.txt")))
        self.assertTrue(said[0].endswith("runner up"))
        self.assertIn("brief builds · 3k chars", said)
        self.assertTrue(said[-1].startswith("READY · codex"))
        self.assertIn("wrote a file", said[-1])

    def test_an_answer_that_is_not_ready_fails(self):
        with self.assertRaises(RuntimeError):
            self.ping_work("hello")({"id": "p2", "kind": "ping"}, lambda s: None)

    def test_a_brief_that_does_not_build_fails_before_the_agent(self):
        def broken(job, agent):
            raise FileNotFoundError("program.md")
        self.asked = None
        with self.assertRaises(FileNotFoundError):
            self.ping_work("READY", brief=broken)({"id": "p3", "kind": "ping"},
                                                  lambda s: None)
        self.assertIsNone(self.asked)


class Attempts(unittest.TestCase):
    """Usage waits retain jobs for retry or handover; failed jobs remain until retried or dismissed."""

    def setUp(self):
        from core import queue as Q, worker as W
        self.Q, self.W = Q, W
        self.root = Path(tempfile.mkdtemp())
        self.job = Q.enqueue(type="t", kind="seed", text="x", root=self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def get(self):
        return self.Q.get(self.job["id"], root=self.root)

    def claim(self):
        return self.Q.claim_next("t:r", types=["t"], root=self.root)

    def test_a_limit_makes_it_wait_not_fail(self):
        import time as _t

        def runs_out(job, report):
            raise self.W.Deferred("codex", _t.time() + 3600, "codex is out of usage until 14:01")
        self.W.run_once("t:r", ["t"], runs_out, root=self.root)
        j = self.get()
        self.assertEqual(j["status"], "waiting")
        self.assertEqual(j["waiting"]["agent"], "codex")
        self.assertTrue(self.Q.is_open(j), "a waiting job left the queue")
        self.assertIsNone(self.claim(), "a waiting job was claimed before its agent was back")

    def test_it_is_claimed_again_when_the_agent_is_back(self):
        import time as _t
        self.claim()
        self.Q.wait(self.job["id"], agent="codex", until=_t.time() - 1, attempt=1, root=self.root)
        again = self.claim()
        self.assertEqual(again["id"], self.job["id"])
        self.assertEqual(self.get()["attempts"], 2)

    def test_handing_it_on_sets_the_agent_and_frees_it_now(self):
        import time as _t
        self.claim()
        self.Q.wait(self.job["id"], agent="codex", until=_t.time() + 3600, attempt=1, root=self.root)
        self.Q.requeue(self.job["id"], backend="claude", root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["backend"]), ("queued", "claude"))
        self.assertEqual(self.claim()["id"], self.job["id"])

    def test_a_dead_runners_job_goes_back_and_is_claimed_again(self):
        # Requeue orphaned work, clear its phase and increment the next attempt.
        self.claim()
        self.Q.phase(self.job["id"], "antigravity working", root=self.root)
        self.Q.orphan(self.job["id"], attempt=1, root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["phase"]), ("queued", None))
        self.assertEqual(self.claim()["id"], self.job["id"])
        self.assertEqual(self.get()["attempts"], 2)

    def test_a_cancelled_job_whose_agent_was_stopped_is_not_failed(self):
        # Agent cancellation must leave the row cancelled, not failed.
        def stopped(job, report):
            self.Q.cancel(job["id"], root=self.root)
            raise A.AgentCancelled("claude stopped: the job was cancelled in the picker")
        self.W.run_once("t:r", ["t"], stopped, root=self.root)
        self.assertEqual(self.get()["status"], "cancelled")

    def test_a_paused_job_is_held_open_and_not_claimed(self):
        self.Q.pause(self.job["id"], root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["paused_from"]), ("paused", "queued"))
        self.assertTrue(self.Q.is_open(j), "a paused job left the queue strip")
        self.assertIsNone(self.claim(), "a paused job was claimed")
        self.Q.resume(self.job["id"], root=self.root)
        self.assertEqual(self.get()["status"], "queued")
        self.assertEqual(self.claim()["id"], self.job["id"])

    def test_pausing_a_running_job_stops_it_without_failing(self):
        # the agent is stopped by the cancel poll (AgentCancelled); the row stays
        # paused, not red, and resume makes it the next attempt
        def paused_under_it(job, report):
            self.Q.pause(job["id"], root=self.root)
            raise A.AgentCancelled("claude stopped")
        self.W.run_once("t:r", ["t"], paused_under_it, root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["paused_from"]), ("paused", "running"))
        self.Q.resume(self.job["id"], root=self.root)
        self.assertEqual(self.claim()["id"], self.job["id"])
        self.assertEqual(self.get()["attempts"], 2)

    def test_a_paused_job_resumes_with_another_agent(self):
        # Paused jobs may change agents before resuming.
        self.claim()
        self.Q.wait(self.job["id"], agent="claude", until=9e9, why="limit", attempt=1, root=self.root)
        self.Q.pause(self.job["id"], root=self.root)
        self.Q.resume(self.job["id"], backend="codex", root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["backend"], j["waiting"]), ("queued", "codex", None))
        self.assertEqual(self.claim()["id"], self.job["id"])
        # and a plain resume keeps the agent it had
        self.Q.pause(self.job["id"], root=self.root)
        self.Q.resume(self.job["id"], root=self.root)
        self.assertEqual(self.get()["backend"], "codex")

    def test_a_model_stays_with_its_agent(self):
        """Agent handover selects a model belonging to the new agent."""
        jid = self.Q.enqueue(type="t", kind="seed", text="x", backend="codex", model="gpt-x",
                             root=self.root)["id"]
        got = lambda: next(j for j in self.Q.jobs(root=self.root) if j["id"] == jid)
        self.assertEqual(got()["model"], "gpt-x")
        self.Q.pause(jid, root=self.root)
        self.Q.resume(jid, backend="codex", root=self.root)
        self.assertEqual(got()["model"], "gpt-x")
        self.Q.pause(jid, root=self.root)
        self.Q.resume(jid, backend="claude", root=self.root)
        self.assertNotIn("model", got())

    def test_an_auto_job_ending_wakes_auto_at_once(self):
        """An AUTO job's end asks the picker to look for the next one now; another job's doesn't."""
        auto = self.Q.enqueue(type="t", kind="seed", text="y", group="auto", root=self.root)
        with (mock.patch.dict(os.environ, {"PICKER_URL": "http://127.0.0.1:9"}),
              mock.patch.object(self.W.urllib.request, "urlopen") as called):
            self.W.run_once("t:r", ["t"], lambda job, report: "c1", root=self.root)
            called.assert_not_called()
            self.W.run_once("t:r", ["t"], lambda job, report: "c2", root=self.root)
        self.assertEqual(self.Q.get(auto["id"], root=self.root)["status"], "done")
        self.assertEqual(called.call_args.args[0].full_url, "http://127.0.0.1:9/api/auto/kick")
        with (mock.patch.dict(os.environ, {"PICKER_URL": "http://127.0.0.1:9"}),
              mock.patch.object(self.W.urllib.request, "urlopen", side_effect=OSError("down"))):
            again = self.Q.enqueue(type="t", kind="seed", text="z", group="auto", root=self.root)
            self.W.run_once("t:r", ["t"], lambda job, report: "c3", root=self.root)   # a picker that's down: no harm
        self.assertEqual(self.Q.get(again["id"], root=self.root)["status"], "done")

    def test_a_pause_that_lands_as_the_work_finishes_keeps_the_result(self):
        def finished(job, report):
            self.Q.pause(job["id"], root=self.root)
            return "c9"
        self.W.run_once("t:r", ["t"], finished, root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["result"]), ("done", "c9"))

    def test_the_agent_poll_treats_paused_as_stopped(self):
        self.assertIn("paused", self.Q.STOPPED)
        self.assertIn("cancelled", self.Q.STOPPED)

    def test_pause_does_not_touch_a_finished_job(self):
        self.claim()
        self.Q.done(self.job["id"], "c1", attempt=1, root=self.root)
        self.Q.pause(self.job["id"], root=self.root)
        self.assertEqual(self.get()["status"], "done")

    def test_run_job_raises_cancelled_not_failed(self):
        def once(*a, **k):
            return A.AgentResult(agent="claude", model="m", effort=None, exit=-15,
                                 cancelled=True)
        with agent_as(once), self.assertRaises(A.AgentCancelled):
            A.run_job("claude", "p", self.root, self.root / "l.log")

    def test_a_pause_between_polls_drops_the_agents_work(self):
        """Paused (and resumed on another model) after the last poll but before the agent exited: the attempt
        stops instead of publishing what the old run made."""
        from core import proc as P
        with (mock.patch.object(A, "argv", return_value=["true"]),
              mock.patch.object(P, "run", return_value=mock.Mock(exit=0)),
              mock.patch.object(P, "job_stop", return_value=True)):
            res = A.run("claude", "p", self.root, self.root / "l.log", model="m", effort=None)
        self.assertTrue(res.cancelled)
        with (mock.patch.object(A, "argv", return_value=["true"]),
              mock.patch.object(P, "run", return_value=mock.Mock(exit=0)),
              mock.patch.object(P, "job_stop", return_value=False)):
            self.assertFalse(A.run("claude", "p", self.root, self.root / "l.log", model="m", effort=None).cancelled)

    def test_orphan_only_touches_a_running_job(self):
        self.claim()
        self.Q.done(self.job["id"], "c1", attempt=1, root=self.root)
        self.Q.orphan(self.job["id"], attempt=1, root=self.root)
        self.assertEqual(self.get()["status"], "done", "a finished job was put back")

    def test_a_retry_forgets_the_last_attempts_phase(self):
        self.claim()
        self.Q.phase(self.job["id"], "gpt-5.5 is out of credits — stepping down", root=self.root)
        self.Q.failed(self.job["id"], why="AgentFailed: x", attempt=1, root=self.root)
        self.Q.requeue(self.job["id"], root=self.root)
        self.assertIsNone(self.get()["phase"])

    def test_failed_stays_open_until_retried_or_dismissed(self):
        self.claim()
        self.Q.failed(self.job["id"], why="RuntimeError: x", attempt=1, root=self.root)
        self.assertTrue(self.Q.is_open(self.get()), "failed is not finished")
        self.Q.dismiss(self.job["id"], root=self.root)
        self.assertFalse(self.Q.is_open(self.get()))
        self.Q.requeue(self.job["id"], root=self.root)
        self.assertEqual(self.get()["status"], "queued")

    def test_an_attempted_job_goes_before_new_work(self):
        import time as _t
        self.claim()
        self.Q.wait(self.job["id"], agent="codex", until=_t.time() - 1, attempt=1, root=self.root)
        self.Q.enqueue(type="t", kind="seed", text="newer", root=self.root)
        self.assertEqual(self.claim()["id"], self.job["id"])

    def test_the_runner_leaves_a_waiting_job_to_the_picker(self):
        # Runners exit on usage waits; the scheduler restarts them when due.
        import time as _t
        from core import auto as AU
        self.claim()
        until = _t.time() + 0.4
        self.Q.wait(self.job["id"], agent="codex", until=until, attempt=1, root=self.root)
        done = []
        n = self.W.drain("t:r", ["t"], lambda job, r: done.append(job["id"]), root=self.root)
        self.assertEqual((n, done), (0, []), "the runner claimed a job that is not due")
        started = []
        t = {"type": "t", "start": ["x"]}
        wake = lambda now: AU.wake([t], lambda t, lane: started.append(lane), now=now,
                                   root=self.root, alive=lambda t, lane: False)
        self.assertEqual(wake(until - 0.3), [], "woke a runner before the reset")
        _t.sleep(max(0, until - _t.time()) + 0.05)
        self.assertEqual(wake(_t.time()), [("t", None)])
        n = self.W.drain("t:r", ["t"], lambda job, r: done.append(job["id"]), root=self.root)
        self.assertEqual(done, [self.job["id"]], "the woken runner did not take it")

    def test_a_known_limit_waits_without_running_the_agent(self):
        """Known-exhausted agents must fail before their CLI starts."""
        ran = []
        real = A.limited_until
        A.limited_until = lambda agent, now=None, **kw: 9e9 if agent == "codex" else None
        self.addCleanup(setattr, A, "limited_until", real)
        with agent_as(lambda *a, **k: ran.append(1)), self.assertRaises(A.AgentLimited):
            A.run_job("codex", "p", self.root, self.root / "l.log")
        self.assertEqual(ran, [], "the agent was run although it is known to be out")

    def test_agent_limited_makes_the_job_wait_until_its_reset(self):
        from datetime import datetime, timedelta, timezone
        until = datetime.now(timezone.utc) + timedelta(hours=1)
        res = A.AgentResult(agent="codex", model="m", effort=None, exit=1, text="x")

        def work(job, report):
            raise A.AgentLimited(res, until)
        self.W.run_once("t:r", ["t"], work, root=self.root)
        j = self.get()
        self.assertEqual((j["status"], j["waiting"]["agent"]), ("waiting", "codex"))
        self.assertAlmostEqual(j["waiting"]["until"], until.timestamp() + 60, delta=1)

    def test_the_next_attempt_is_told_what_the_last_one_left(self):
        import time as _t
        out = self.root / "work"
        out.mkdir()
        job = {"id": "j1", "type": "t", "attempts": 1, "first_claim": _t.time() - 5}
        (out / "drman01.frag").write_text("//")
        files = RS.left_behind(job, outputs=["work"], root=self.root)
        self.assertEqual(files, ["work/drman01.frag"])
        here = self.root / "runner"
        self.assertEqual(RS.attempt_note(job, here), "", "no log: the claim ran nothing")
        (here / "logs").mkdir(parents=True)
        log = here / "logs" / "queue_j1.log"
        log.write_text("\n== bundle · transcribe ==\nGPU busy: 3185 MiB in use (> 3000)\n")
        self.assertEqual(RS.attempt_note(job, here), "", "only the runner's tools ran: no agent to continue")
        log.write_text("Timestamp: 2026-10-22T10:47:00\nagent: codex  model: gpt-6.1-sol  effort: xhigh\n\nran out\n")
        self.assertIn("TRIED BEFORE", RS.attempt_note(job, here))
        self.assertEqual(RS.attempt_note({**job, "attempts": 0}, here), "")

    def test_the_note_lists_only_this_jobs_work_when_lanes_run_side_by_side(self):
        # Resumed jobs must retain their own files, not another job context.
        import json as _j
        import time as _t
        out = self.root / "stacks"
        job = {"id": "jA", "type": "t", "attempts": 1, "first_claim": _t.time() - 5}
        for rel in ("_staging/jB/s2/v1/x.scd", "free01/v1/a.scd", "bund02/v1/b.scd"):
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_text("//")
        (out / "bund02" / "stack.json").write_text(_j.dumps({"job": "jB"}))
        self.assertEqual(RS.left_behind(job, outputs=["stacks"], root=self.root),
                         ["stacks/free01/v1/a.scd"], "another job's staging and finished stack")
        (out / "_staging" / "jA" / "s1").mkdir(parents=True)
        (out / "_staging" / "jA" / "s1" / "c.scd").write_text("//")
        self.assertEqual(RS.left_behind(job, outputs=["stacks"], root=self.root),
                         ["stacks/_staging/jA/s1/c.scd"], "its own staging, and only that")




def tearDownModule():
    shutil.rmtree(_TRACE, ignore_errors=True)


class Trace(unittest.TestCase):
    """core/trace.py — the system's own log, keyed by job/card/type."""

    def test_lines_inherit_the_bound_job(self):
        from core import trace as T
        root = Path(tempfile.mkdtemp())
        try:
            with T.bound(job="j9", type="t"):
                T.emit("x", "one", root=root)
                T.emit("x", "two", card="c1", root=root)
            T.emit("x", "outside", root=root)
            got = T.read(root=root, job="j9")
            self.assertEqual([r["ev"] for r in got], ["one", "two"])
            self.assertEqual(got[1]["card"], "c1")
            self.assertNotIn("job", T.read(root=root)[-1])
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_a_failed_job_leaves_its_traceback(self):
        from core import queue as Q, trace as T, worker as W
        root = Path(tempfile.mkdtemp())
        os.environ["PICKER_TRACE"], was = str(root / "trace.jsonl"), os.environ["PICKER_TRACE"]
        try:
            job = Q.enqueue(type="t", kind="seed", text="x", root=root)

            def boom(job, report):
                raise ValueError("deep inside")
            W.run_once("t:r", ["t"], boom, root=root)
            fail = [r for r in T.read(root=root, job=job["id"]) if r["ev"] == "job.failed"]
            self.assertEqual(len(fail), 1)
            self.assertIn("deep inside", fail[0]["traceback"])
            self.assertIn("boom", fail[0]["traceback"], "the traceback lost where")
        finally:
            os.environ["PICKER_TRACE"] = was
            shutil.rmtree(root, ignore_errors=True)








class PauseRouteTest(unittest.TestCase):
    """POST /api/queue/<id>/pause and /resume, and cancel of a paused job — on a
    throw-away queue file, the runner start stubbed (no quota, no live queue)."""

    def setUp(self):
        from flask import Flask
        from api import queue as QA, researchers
        from core import queue as Q
        self.Q, self.R = Q, researchers
        self.tmp = Path(tempfile.mkdtemp())
        self._q, Q.QUEUE = Q.QUEUE, self.tmp / "queue.jsonl"
        self.started = []
        self._start, researchers.start_for = researchers.start_for, \
            lambda t, job: (self.started.append(job["id"]), ({}, 202))[1]
        app = Flask(__name__)
        app.register_blueprint(QA.bp)
        self.c = app.test_client()

    def tearDown(self):
        self.Q.QUEUE = self._q
        self.R.start_for = self._start
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_job_without_an_agent_is_labelled_with_its_tabs_first(self):
        """A runner started without --agent works with the tab's first agent (the examples' fake): so does the row."""
        from api import queue as AQ
        with mock.patch.object(AQ, "_registry", return_value=[
                {"type": "ex", "start": ["uv", "run", "queue_runner.py"], "agents": ["fake", "claude"]},
                {"type": "own", "start": ["uv", "run", "queue_runner.py", "--agent", "codex"], "agents": ["claude", "codex"]}]):
            self.assertEqual((AQ._default_agent("ex"), AQ._default_agent("own")), ("fake", "codex"))

    def test_a_send_names_its_agent_and_model(self):
        """Validate submitted agent and model choices against the registry and stored catalog."""
        from core import agents as A
        saved = A.MODELS_CACHE
        try:
            A.MODELS_CACHE = self.tmp / "agent_models.json"
            A.remember({"codex": {"cli": "codex", "efforts": [], "models": [{"id": "gpt-x"}]}})
            post = lambda **b: self.c.post("/api/queue", json={"type": "fx_music", "kind": "seed",
                                                                "text": "x", **b})
            r = post(backend="codex", model="gpt-x")
            self.assertEqual(r.status_code, 201, r.get_json())
            self.assertEqual((r.get_json()["backend"], r.get_json()["model"]), ("codex", "gpt-x"))
            self.assertEqual(r.get_json()["run"]["model"], "gpt-x")
            self.assertEqual(post(backend="nobody").status_code, 400)
            self.assertEqual(post(backend="codex", model="gpt-nope").status_code, 400)
            self.assertEqual(post(backend="codex", model="a b").status_code, 400)
        finally:
            A.MODELS_CACHE = saved

    def test_the_model_list_is_kept_on_a_fresh_install(self):
        """The first listing comes before anything made the data folder."""
        from core import agents as A
        where = self.tmp / "fresh" / "data" / "agent_models.json"
        A.remember({"codex": {"cli": "codex", "efforts": [], "models": [{"id": "gpt-x"}]}}, path=where)
        self.assertEqual(A.cached_catalogue("codex", path=where)["models"], [{"id": "gpt-x"}])

    def test_pause_resume_cancel(self):
        j = self.Q.enqueue(type="fx_music", kind="seed", text="x")
        r = self.c.post(f"/api/queue/{j['id']}/pause")
        self.assertEqual((r.status_code, r.get_json()["job"]["status"]), (200, "paused"))
        self.assertEqual(self.c.post(f"/api/queue/{j['id']}/pause").status_code, 409)
        r = self.c.post(f"/api/queue/{j['id']}/resume")
        self.assertEqual((r.status_code, r.get_json()["job"]["status"]), (200, "queued"))
        self.assertEqual(self.started, [j["id"]], "resume did not start the researcher")
        self.c.post(f"/api/queue/{j['id']}/pause")
        self.assertEqual(self.c.delete(f"/api/queue/{j['id']}").status_code, 200,
                         "a paused job could not be cancelled")
        self.assertEqual(self.Q.get(j["id"])["status"], "cancelled")


class VersionNumberTest(PauseRouteTest):
    """Validate actual version numbers rather than assuming versions are contiguous."""

    def setUp(self):
        super().setUp()
        from api import queue as QA
        self.QA, self._data = QA, QA.DATA
        QA.DATA = self.tmp / "data"
        from api import cards as C                  # Read the source from the same temporary store.
        self.C = C
        C.ST.use([QA.DATA / "cards"])
        cd = QA.DATA / "cards" / "zzsparse001"
        cd.mkdir(parents=True)
        (cd / "card.json").write_text(json.dumps({"id": "zzsparse001", "type": "fx_music", "versions": [
            {"n": 1, "id": "v1"}, {"n": 4, "id": "v4"}, {"n": 7, "id": "v7"}]}))

    def tearDown(self):
        self.QA.DATA = self._data
        self.C.ST.use(None)
        super().tearDown()

    def test_the_versions_own_numbers(self):
        post = lambda v: self.c.post("/api/queue", json={"type": "fx_music", "kind": "revise", "card": "zzsparse001",
                                                         "text": "x", "version": v})
        for good in (1, 4, 7):
            r = post(good)
            self.assertEqual(r.status_code, 201, (good, r.get_json()))
            self.assertEqual(self.Q.get(r.get_json()["id"])["version"], good)
        for bad in (2, 3, 8, 0):
            self.assertEqual(post(bad).status_code, 400, bad)

    def test_the_item_on_screen_goes_with_its_version(self):
        """Bundle jobs retain the selected item and reject items absent from the source."""
        post = lambda **b: self.c.post("/api/queue", json={"type": "fx_music", "kind": "inspire", "card": "zzsparse001",
                                                           "text": "x", **b})
        r = post(version=4, item="comp1")
        self.assertEqual(r.status_code, 201, r.get_json())
        self.assertEqual((self.Q.get(r.get_json()["id"])["version"], self.Q.get(r.get_json()["id"])["item"]), (4, "comp1"))
        self.assertEqual(post(item="comp1").status_code, 400, "an item without its version")
        self.assertEqual(post(version=4, item="../x").status_code, 400, "not an id")
        self.assertIsNone(self.Q.get(post(version=4).get_json()["id"])["item"], "no item: none stored (the fold's None)")




class CountTest(PauseRouteTest):
    """Count requests share one job and agent context; paused jobs may resume under another agent."""

    def test_count_is_one_job_carrying_n(self):
        r = self.c.post("/api/queue", json={"type": "fx_music", "kind": "seed",
                                             "text": "a drone", "count": 3})
        self.assertEqual(r.status_code, 201)
        j = self.Q.get(r.get_json()["id"])
        self.assertEqual((j["count"], j["text"]), (3, "a drone"))
        self.assertEqual(len(self.Q.fold()), 1, "one job, not three")

    def test_one_is_as_before_and_out_of_range_is_refused(self):
        r = self.c.post("/api/queue", json={"type": "fx_music", "kind": "seed", "text": "x"})
        self.assertIsNone(self.Q.get(r.get_json()["id"])["count"])
        for bad in (0, 9, "lots"):
            self.assertEqual(self.c.post("/api/queue", json={"type": "fx_music", "kind": "seed",
                             "count": bad}).status_code, 400, bad)

    def test_the_brief_asks_one_session_for_n_different(self):
        self.assertEqual(RS.count_note({"kind": "revise"}), "")
        rev = RS.count_note({"kind": "revise", "count": 3})
        self.assertIn("THIS JOB ASKS FOR 3", rev)
        self.assertIn("3 new VERSIONS", rev)
        self.assertIn("VARIETY", rev)
        ins = RS.count_note({"kind": "inspire", "count": 2})
        self.assertIn("2 new CARDS", ins)
        self.assertIn("NO revision_of between", ins)
        # every runner gets it through attempt_note, tried before or not
        self.assertTrue(RS.attempt_note({"kind": "revise", "count": 3, "attempts": 0}, ROOT)
                        .startswith("\nTHIS JOB ASKS FOR 3"))

    def test_resume_with_another_agent(self):
        j = self.Q.enqueue(type="fx_music", kind="seed", text="x", backend="claude")
        self.c.post(f"/api/queue/{j['id']}/pause")
        self.assertEqual(self.c.post(f"/api/queue/{j['id']}/resume",
                                     json={"agent": "nobody"}).status_code, 400)
        r = self.c.post(f"/api/queue/{j['id']}/resume", json={"agent": "codex"})
        self.assertEqual((r.status_code, self.Q.get(j["id"])["backend"]), (200, "codex"))

    def test_resume_and_retry_take_a_model(self):
        import time
        from core import agents as A
        mid = A.cached_catalogue("claude")["models"][0]["id"]
        j = self.Q.enqueue(type="fx_music", kind="seed", text="x", backend="claude")
        self.c.post(f"/api/queue/{j['id']}/pause")
        self.assertEqual(self.c.post(f"/api/queue/{j['id']}/resume",
                                     json={"agent": "claude", "model": "no-such-model"}).status_code, 400)
        self.assertEqual(self.c.post(f"/api/queue/{j['id']}/resume", json={"agent": "claude", "model": mid}).status_code, 200)
        self.assertEqual(self.Q.get(j["id"])["model"], mid)
        k = self.Q.enqueue(type="fx_music", kind="seed", text="y", backend="claude", model=mid)
        self.Q.defer(k["id"], agent="claude", until=time.time() + 600, why="held")
        self.c.post(f"/api/queue/{k['id']}/retry", json={"agent": "claude"})
        self.assertEqual(self.Q.get(k["id"]).get("model"), mid, "no model named: the job's kept")
        self.Q.defer(k["id"], agent="claude", until=time.time() + 600, why="held")
        self.c.post(f"/api/queue/{k['id']}/retry", json={"agent": "claude", "model": None})
        self.assertIsNone(self.Q.get(k["id"]).get("model"), "null: the agent's own")


class TrimTest(unittest.TestCase):
    """Selected-part trims use the latest signal and must survive queueing into runner cuts."""

    def test_fold_and_clean(self):
        from core import signals as SIG, queue as Q
        self.assertIsNone(SIG.fold([])["trim"])
        got = SIG.fold([{"kind": "trim", "value": {"start": 1, "end": 2}},
                        {"kind": "trim", "value": None}])
        self.assertIsNone(got["trim"], "null = all of it again")
        self.assertEqual(Q.clean_trim({"start": "1.23456", "end": 4}), {"start": 1.235, "end": 4.0})
        self.assertIsNone(Q.clean_trim(None))
        for bad in ({"start": 3, "end": 2}, {"start": -1, "end": 2}, {"start": 1, "end": 1.05},
                    {"start": 1}, "x"):
            with self.assertRaises(ValueError):
                Q.clean_trim(bad)

    def test_enqueue_keeps_it(self):
        from core import queue as Q
        root = Path(tempfile.mkdtemp())
        try:
            j = Q.enqueue(type="fx_music", kind="inspire", card="c1",
                          trim={"start": 1.0, "end": 2.5}, root=root)
            self.assertEqual(Q.fold(root)[j["id"]]["trim"], {"start": 1.0, "end": 2.5})
        finally:
            shutil.rmtree(root, ignore_errors=True)




class RatingTest(unittest.TestCase):
    """Once versions have votes, rank a stack by its best version."""

    def test_rating(self):
        from core import signals as SIG
        f = lambda sig: SIG.fold(sig)
        v = lambda n, x: {"kind": "vote", "version": n, "value": x}
        self.assertEqual(SIG.rating(f([v(1, -2), v(3, 2)]), [1, 2, 3]), 2)
        self.assertEqual(SIG.rating(f([v(1, -2)]), [1, 2]), 0, "an unvoted version counts 0")
        self.assertEqual(SIG.rating(f([v(1, -2), v(2, -1)]), [1, 2]), -1)
        # never voted per version: the card-level vote it had stands
        self.assertEqual(SIG.rating(f([{"kind": "vote", "value": 2}]), [1, 2, 3]), 2)
        # once a version is voted, the versions decide
        self.assertEqual(SIG.rating(f([{"kind": "vote", "value": 2}, v(2, 1)]), [1, 2]), 1)
        # one version: its vote is the card's
        self.assertEqual(SIG.rating(f([{"kind": "vote", "value": -1}]), [1]), -1)


class FaceSignalTest(unittest.TestCase):
    """A long-pressed render becomes the card's picture: a `face` signal, last wins."""

    def test_fold(self):
        from core import signals as SIG
        self.assertIsNone(SIG.fold([])["face"])
        got = SIG.fold([{"kind": "face", "value": "wholebody"}, {"kind": "vote", "value": 1},
                        {"kind": "face", "value": "newshort"}])
        self.assertEqual(got["face"], "newshort")


class AgentRunsTest(unittest.TestCase):
    """Read model and effort incrementally from agent-start trace events."""

    def test_latest_start_per_job_and_only_new_bytes(self):
        from core import trace as T
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        f = root / "trace.jsonl"
        f.write_text(json.dumps({"ts": 1, "ev": "agent.start", "job": "j1", "agent": "codex",
                                 "model": "gpt-5.5", "effort": None}) + "\n")
        self.assertEqual(T.agent_runs(root)["j1"]["model"], "gpt-5.5")
        with open(f, "a") as fh:
            fh.write(json.dumps({"ts": 2, "ev": "agent.end", "job": "j1"}) + "\n")
            fh.write(json.dumps({"ts": 3, "ev": "agent.start", "job": "j1", "agent": "claude",
                                 "model": "claude-fable-5-1", "effort": "xhigh"}) + "\n")
        got = T.agent_runs(root)["j1"]
        self.assertEqual((got["agent"], got["model"], got["effort"]),
                         ("claude", "claude-fable-5-1", "xhigh"))
        f.write_text("")                        # truncated (the browser tests restore)
        self.assertEqual(T.agent_runs(root), {})


class AutoReviseTest(unittest.TestCase):
    """AUTO excludes archived and downvoted cards, respects marked pools and repeats only after relevant changes."""

    def setUp(self):
        from core import auto as AU, queue as Q, prefs as P
        self.AU, self.Q, self.P = AU, Q, P
        self.root = Path(tempfile.mkdtemp())
        self.started = []
        self.cards = [
            {"id": "ok1", "type": "t", "vote": 1, "versions": [{"n": 1, "vote": 0}], "pools": ["auto"]},
            {"id": "notpooled", "type": "t", "vote": 2, "versions": [{"n": 1, "vote": 1}]},
            {"id": "arch", "type": "t", "archived": True, "versions": [{"n": 1}], "pools": ["auto"]},
            {"id": "down", "type": "t", "vote": -1, "versions": [{"n": 1, "vote": -1}]},
            {"id": "alldown", "type": "t", "versions": [{"n": 1, "vote": -1}, {"n": 2, "vote": -2}]},
            {"id": "other", "type": "u", "versions": [{"n": 1}], "pools": ["auto"]},
        ]

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def on(self, **kw):
        tab = {k: kw.pop(k) for k in list(kw) if k in self.AU.TAB}          # Tab settings must not leak across types.
        self.P.set("auto", {**self.AU.DEFAULTS, "on": True, "types": ["t"], "tabs": {"t": tab}, **kw},
                   root=self.root)

    def tick(self):
        return self.AU.tick(cards=lambda: self.cards,
                            start=lambda t, j: self.started.append(j["id"]), root=self.root)

    def test_off_does_nothing(self):
        self.assertEqual(self.tick(), [])

    def test_it_picks_only_a_pooled_card_that_is_active(self):
        self.on()
        made = self.tick()
        self.assertEqual(len(made), 1)
        j = self.Q.get(made[0], root=self.root)
        self.assertEqual((j["card"], j["kind"], j["group"], j["backend"]),
                         ("ok1", "revise", "auto", "claude"))
        self.assertEqual(self.started, made)

    def test_one_in_flight_per_type_and_not_the_same_card_again(self):
        self.on()
        self.tick()
        self.assertEqual(self.tick(), [], "a second auto revise while one is open")
        j = next(iter(self.Q.fold(self.root)))
        self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.Q.done(j, "ok1", attempt=1, root=self.root)
        self.assertEqual(self.tick(), [], "the pool's only card, unchanged since AUTO had it, taken again")
        self.cards[0]["pools"] = []
        self.cards[1]["pools"] = []
        self.assertEqual(self.Q.get(self.tick()[0], root=self.root)["card"], "notpooled",
                         "none marked: every active card, and the one AUTO hasn't had")

    def test_none_marked_every_active_card_not_voted_down(self):
        for c in self.cards:
            c.pop("pools", None)
        got = {c["id"] for c in self.AU.look("t", self.cards, []).due}
        self.assertEqual(got, {"ok1", "notpooled"})

    def test_a_marked_card_is_taken_even_rated_down(self):
        self.cards[3]["pools"] = ["auto"]                  # "down", marked by hand
        self.assertEqual({c["id"] for c in self.AU.look("t", self.cards, []).due}, {"ok1", "down"})

    def test_the_tabs_comment_rides_along_and_empty_is_the_plain_revise(self):
        # AUTO revision instructions are scoped to the tab.
        self.on(comment="  make it  slower\r\n\n\n\nand calmer  ")
        j = self.Q.get(self.tick()[0], root=self.root)
        self.assertTrue(j["text"].startswith(self.AU.TEXT["revise"]))
        self.assertIn("THE OPERATOR'S COMMENT", j["text"])
        self.assertTrue(j["text"].endswith("make it slower\n\nand calmer"), j["text"])
        self.assertTrue(self.AU.state["last"]["comment"])
        self.Q.cancel(j["id"], root=self.root)
        self.on(comment="   ")
        self.cards.append({"id": "ok2", "type": "t", "versions": [{"n": 1}], "pools": ["auto"]})
        self.assertEqual(self.Q.get(self.tick()[0], root=self.root)["text"], self.AU.TEXT["revise"])
        self.assertEqual(len(self.AU.clean_comment("x" * 5000)), self.AU.MAX_COMMENT)

    def test_a_tabs_settings_are_its_own(self):
        """Keep AUTO comments and enabled kinds isolated by tab."""
        self.P.set("auto", {**self.AU.DEFAULTS, "on": True, "types": ["t", "u"],
                            "tabs": {"t": {"comment": "for t", "kinds": ["inspire"]}}}, root=self.root)
        s = self.AU.settings(self.P.fold(root=self.root))
        self.assertEqual((self.AU.tab(s, "t")["comment"], self.AU.tab(s, "t")["kinds"]), ("for t", ["inspire"]))
        self.assertEqual((self.AU.tab(s, "u")["comment"], self.AU.tab(s, "u")["kinds"]), ("", ["revise"]))


    def ptick(self, now=None):
        return self.AU.tick(cards=lambda: self.cards,
                            start=lambda t, j: self.started.append(j["id"]), root=self.root, now=now)

    def surveyed(self, order, criterion="slowest first"):
        from core import survey as SV
        SV.record({"id": "svjob", "type": "t", "text": criterion}, order, "the report",
                  root=self.root, pool=self.AU.look("t", self.cards, []).scope)

    def test_a_changed_pool_makes_the_order_stale(self):
        """Survey orders belong to their pool; changing pool membership invalidates the order."""
        self.on(criterion="slowest first")
        self.surveyed([{"card": "ok1", "why": "x"}])
        self.cards[1]["pools"] = ["auto"]                 # "notpooled" marked now
        j = self.Q.get(self.ptick()[0], root=self.root)
        self.assertEqual(j["kind"], "survey")

    def test_a_criterion_without_an_order_surveys_first(self):
        self.on(criterion="slowest first")
        made = self.ptick()
        self.assertEqual(len(made), 1)
        j = self.Q.get(made[0], root=self.root)
        self.assertEqual((j["kind"], j["text"], j["group"]), ("survey", "slowest first", "auto"))
        self.assertEqual(self.ptick(), [], "nothing else while the survey is open")

    def test_the_order_is_followed_with_its_reason(self):
        self.on(criterion="slowest first")
        self.surveyed([{"card": "down", "why": "voted down — skipped"},
                       {"card": "ok1", "why": "slowest: 5.8 ms over empty"}])
        j = self.Q.get(self.ptick()[0], root=self.root)
        self.assertEqual((j["kind"], j["card"]), ("revise", "ok1"))
        self.assertIn("WHY THIS CARD", j["text"])
        self.assertIn("slowest: 5.8 ms over empty", j["text"])

    def test_a_worked_through_order_waits_until_a_new_pass(self):
        """A completed unchanged pool waits; updating its criterion begins a new survey pass."""
        self.on(criterion="slowest first")
        self.surveyed([{"card": "ok1", "why": "x"}])
        jid = self.ptick()[0]
        self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.Q.done(jid, "ok1", attempt=1, root=self.root)
        self.assertEqual(self.ptick(), [])
        self.assertEqual(self.ptick(now=time.time() + 30 * 3600), [])
        self.assertIn("nothing changed", self.AU.state["why"])
        self.on(criterion="the ones with the skeleton loop", since=time.time() + 1)
        j = self.Q.get(self.ptick()[0], root=self.root)
        self.assertEqual(j["kind"], "survey")

    def test_a_worked_through_order_is_one_pass_then_the_due_cards_are_surveyed(self):
        """When an order finishes, survey due cards rather than replaying its completed cards."""
        self.cards.append({"id": "ok2", "type": "t", "versions": [{"n": 1}], "pools": ["auto"]})
        self.on(criterion="slowest first")
        self.surveyed([{"card": "ok1", "why": "x"}])
        jid = self.ptick()[0]
        self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.Q.done(jid, "ok1", attempt=1, root=self.root)
        made = self.ptick()
        self.assertEqual(self.Q.get(made[0], root=self.root)["kind"], "survey", "not a second round of ok1")

    def test_survey_again_is_a_new_pass(self):
        """'survey again' begins a pass (api/auto.py sets the tab's `since`): the order asked for before it no longer
        counts, every card is due again."""
        self.on(criterion="slowest first")
        self.surveyed([{"card": "ok1", "why": "x"}])
        self.on(criterion="slowest first", since=time.time() + 1)
        self.assertEqual(self.Q.get(self.ptick()[0], root=self.root)["kind"], "survey")

    def test_a_failed_survey_holds_the_tab_until_dismissed(self):
        """Keep one failed survey row instead of repeatedly queueing another."""
        self.on(criterion="slowest first")
        jid = self.ptick()[0]
        self.Q.claim_next("t:r", types=["t"], root=self.root)
        self.Q.failed(jid, "agent wrote nothing", attempt=1, root=self.root)
        self.assertEqual(self.ptick(now=time.time() + 3 * 3600), [])
        self.assertIn("last AUTO job failed", self.AU.state["why"])
        self.Q.dismiss(jid, root=self.root)
        self.assertEqual(self.Q.get(self.ptick()[0], root=self.root)["kind"], "survey")

    def test_the_answer_is_checked(self):
        from core import survey as SV
        here = self.root / "runner"
        (here / "logs").mkdir(parents=True)
        job = {"id": "sv1", "type": "t", "text": "slowest"}
        cards = [{"card": "ok1", "part": "ok3"}, {"card": "b", "part": "b1"}]
        with self.assertRaises(RuntimeError):
            SV.read_answer(job, here, cards)                       # no file
        SV.answer_path(job, here).write_text(json.dumps({"order": [
            {"card": "ok3", "why": "by its part id"}, {"card": "nope"}, {"card": "ok1"},
            {"card": "b", "why": "w" * 900}], "report": "r"}))
        order, report = SV.read_answer(job, here, cards)
        self.assertEqual([o["card"] for o in order], ["ok1", "b"])  # mapped, unknown dropped, once
        self.assertEqual(len(order[1]["why"]), 300)
        self.assertEqual(report, "r")

    def test_it_reads_no_usage_and_runs_until_it_cant(self):
        """Usage percentages alone must not prevent AUTO from queueing the next revision."""
        self.on()
        self.assertTrue(self.tick(), "AUTO queued nothing")
        self.assertNotIn("session_max", self.AU.settings())


class VersionVotesTest(unittest.TestCase):
    """Revision briefs must retain votes along the revision lineage."""

    def setUp(self):
        self.store = Path(tempfile.mkdtemp())
        RS.ST.use([self.store])
        d = self.store / "zzcard"
        d.mkdir()
        (d / "card.json").write_text(json.dumps({"id": "zzcard", "versions": [
            {"n": i, "agent": "claude", "rationale": f"try {i}",
             "parts": [{"kind": "shader", "id": f"zz{i}"}]} for i in (1, 2, 3)]}))
        self.sig = d / "signals.jsonl"

    def tearDown(self):
        RS.ST.use(None)
        shutil.rmtree(self.store, ignore_errors=True)

    def vote(self, n, v):
        with open(self.sig, "a") as f:
            f.write(json.dumps({"kind": "vote", "value": v, "version": n}) + "\n")

    def test_no_votes_says_nothing(self):
        self.assertEqual(RS.version_note({"card": "zzcard"}), "")
        self.assertEqual(RS.version_votes({"card": "zzcard"})[1]["n"], 3)

    def test_votes_are_listed_and_a_downvoted_newest_moves_the_base(self):
        self.vote(2, 2)
        self.vote(3, -1)
        vs, base = RS.version_votes({"card": "zzcard"})
        self.assertEqual([v["vote"] for v in vs], [0, 2, -1])
        self.assertEqual(base["n"], 2, "a revise builds from the newest not voted down")
        note = RS.version_note({"card": "zzcard"})
        self.assertIn("v2 (zz2, claude) — ▲2 (right direction)", note)
        self.assertIn("v3 (zz3, claude) — ▽1 (a detail in it didn't work", note)
        self.assertIn("v1 (zz1, claude) — no vote (no judgement)", note)
        self.assertIn("build from v2", note)

    def test_an_unjudged_version_counts_as_not_down(self):
        # v1 up, v2 not voted, v3 down → v2: the newest NOT voted down, even
        # though it was never voted up.
        self.vote(1, 2)
        self.vote(3, -1)
        self.assertEqual(RS.version_votes({"card": "zzcard"})[1]["n"], 2)

    def test_the_version_on_screen_is_the_base(self):
        # The job names the version that was on screen: that one, even unvoted and
        # even though a newer one is up — and the note says so.
        self.vote(3, 1)
        vs, base = RS.version_votes({"card": "zzcard", "version": 1})
        self.assertEqual(base["n"], 1)
        note = RS.version_note({"card": "zzcard", "version": 1})
        self.assertIn("looking at v1 (zz1)", note)
        self.assertIn("v3 (zz3, claude) — ▲1", note)

    def test_an_upvoted_newest_stays_the_base(self):
        self.vote(1, -1)
        self.vote(3, 1)
        self.assertEqual(RS.version_votes({"card": "zzcard"})[1]["n"], 3)
        self.assertNotIn("build from", RS.version_note({"card": "zzcard"}))

    def test_no_votes_on_screen_is_the_history_not_a_vote_board(self):
        # Unvoted cards list their versions without implying a preferred direction.
        note = RS.version_note({"card": "zzcard", "version": 2})
        self.assertIn("THIS CARD'S VERSIONS SO FAR", note)
        self.assertIn("v2 (zz2, claude) — try 2", note)
        self.assertNotIn("vote", note.lower())
        self.assertIn("looking at v2 (zz2)", note)

    def test_other_cards_names_are_taken_out_of_the_history(self):
        # Suppress other-card names in rationales, but retain this card versions and ordinary words.
        for other in ("glsx5", "tide"):
            (self.store / other).mkdir()
            (self.store / other / "card.json").write_text(json.dumps({"id": other, "versions": []}))
        c = json.loads((self.store / "zzcard" / "card.json").read_text())
        c["versions"][1]["rationale"] = "more like glsx5, built on zz1, low tide"
        (self.store / "zzcard" / "card.json").write_text(json.dumps(c))
        note = RS.version_note({"card": "zzcard", "version": 2})
        self.assertNotIn("glsx5", note)
        self.assertIn("more like another card, built on zz1, low tide", note)

    def test_an_empty_note_is_said(self):
        # Empty revision instructions must not inherit notes quoted in rationales.
        self.assertEqual(RS.note_line("revise", "more red"), 'The operator wrote: "more red"\n')
        r = RS.note_line("revise", "")
        self.assertIn("NO note", r)
        self.assertIn("taken further or fixed", r)
        self.assertIn("second version, make it the other kind", r)
        self.assertIn('"Fix / quality pass:"', r)
        self.assertIn('"Taken further / artistic attempt:"', r)
        self.assertIn("not this request", r)
        self.assertIn("NO note", RS.note_line("inspire", ""))
        self.assertEqual(RS.note_line("seed", ""), "")


try:
    import flask  # noqa: F401
    _FLASK = True
except ImportError:
    _FLASK = False


@unittest.skipUnless(_FLASK, "api/researchers imports flask — run with the server's env")
class RunnerStartTest(unittest.TestCase):
    """A runner holds its lane lock for life; competing starts must exit without claiming work."""

    def setUp(self):
        from api import researchers as RR
        from core import lanes as L
        self.RR, self.L = RR, L
        # In the config's cache: the one place besides the store this run may write (tests/py/_cfg.py, move_check.sh)
        _C.get().cache.mkdir(parents=True, exist_ok=True)
        self.home = Path(tempfile.mkdtemp(prefix=".zz_runner_", dir=_C.get().cache))
        # a runner that takes its lane's lock, as core/researcher.drain does, and works for 5 s
        holds = (f"import sys, time; sys.path.insert(0, {str(PICKER)!r}); import runner; "
                 f"time.sleep(5) if runner.hold('.') is not None else None")
        self.t = {"type": "zz_selftest", "researcher": str(self.home / "q.py"),
                  "start": [sys.executable, "-c", holds]}
        self.pids = []
        # These tests are about WHO starts, so there is always work to claim.
        self._claimable = RR._claimable
        self._admitted = RR._admitted
        RR._admitted = lambda *a: True
        RR._claimable = lambda t, kinds: {"claimable": 1, "message": None,
                                          "counts": {"queued": 1}}

    def tearDown(self):
        self.RR._claimable = self._claimable
        self.RR._admitted = self._admitted
        for pid in self.pids:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
        shutil.rmtree(self.home, ignore_errors=True)

    def start(self, **kw):
        body, code = self.RR.start_runner(self.t, **kw)
        if body.get("pid"):
            self.pids.append(body["pid"])
        return body, code

    def held(self, lane=None):
        for _ in range(100):
            if self.L.alive(self.t, lane):
                return True
            time.sleep(0.05)
        return False

    def test_an_agent_lane_starts_beside_a_busy_main_runner(self):
        # Agent lanes must not wait behind the main runner.
        self.assertEqual(self.start()[1], 202)
        self.assertTrue(self.held())
        body, code = self.start(lane="codex")
        self.assertEqual(code, 202, body)
        self.assertTrue(self.held("codex"))
        self.assertEqual(self.start(lane="codex")[1], 409, "a second codex runner started")
        self.assertTrue((self.home / "logs" / "queue_runner.codex.log").exists())

    def test_orphans_are_released_per_lane(self):
        held = {"researcher": "zz:codex@codex"}
        self.assertTrue(self.L.held_by(held, "codex"))
        self.assertFalse(self.L.held_by(held, None), "main lane took a codex job")
        self.assertTrue(self.L.held_by({"researcher": "zz:claude"}, None))

    def test_nothing_to_claim_starts_nothing_and_says_so(self):
        # Empty-queue runners exit quickly and must not remain marked working.
        self.RR._claimable = self._claimable
        body, code = self.start()
        self.assertEqual((code, body.get("idle")), (200, True), body)
        self.assertIn("nothing queued", body["message"])
        self.assertNotIn("pid", body, "a runner was spawned")

    def test_three_starts_at_once_leave_one_runner(self):
        import threading
        th = [threading.Thread(target=self.start) for _ in range(3)]
        for x in th:
            x.start()
        for x in th:
            x.join()
        self.assertTrue(self.held())
        time.sleep(1.5)                            # the ones that found the lane taken have left
        alive = []
        for pid in self.pids:
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if not done:
                    alive.append(pid)
            except ChildProcessError:
                pass
        self.assertEqual(len(alive), 1, f"{len(self.pids)} started, {len(alive)} still at work")
