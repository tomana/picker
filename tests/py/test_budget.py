import _cfg  # noqa: F401
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from core import agents as A, budget as B, config as C, prefs as P, queue as Q, worker as W


class Admission(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.prefs = {"agents": {"claude": {"session_cap": 80}}}
        self.enterContext(mock.patch.object(P, "fold", side_effect=lambda *a: self.prefs))
        self.enterContext(mock.patch.dict(B._samples, {}, clear=True))
        self.reader = mock.Mock(side_effect=self.read)
        self.enterContext(mock.patch.object(B, "_reader", self.reader))
        self.source = {"available": True, "windows": [
            {"key": "session", "used_pct": 79, "resets_at": "2030-01-01T00:00:00Z"}]}

    def read(self, name):
        if name != "antigravity" or "groups" in self.source:
            return self.source
        groups = {}
        for family in ("gemini", "claude_gpt"):
            keys = {w["key"] for w in self.source.get("windows") or []}
            periods = {p: key for p, key in (("5h", family), ("weekly", family + "_week")) if key in keys}
            if periods:
                groups[family] = {"name": family, "family": family, "windows": periods}
        return {**self.source, "groups": groups}

    def test_off_makes_no_usage_read_or_request(self):
        self.prefs = {}
        with mock.patch.object(B.urllib.request, "urlopen", side_effect=AssertionError("must not read")):
            self.assertTrue(B.check("claude")["allowed"])
            self.reader.assert_not_called()

    def test_below_allows_and_at_or_above_holds(self):
        for pct, allowed in [(79, True), (80, False), (81, False)]:
            B._samples.clear()
            self.source["windows"][0]["used_pct"] = pct
            d = B.check("claude", now=1000)
            self.assertEqual(d["allowed"], allowed)
            if not allowed:
                self.assertIn(f"claude at {pct}% of its session, cap 80%", d["why"])

    def test_unknown_or_failed_reader_holds_even_with_last_good_numbers(self):
        for source in ({"available": False}, {"available": True, "windows": []},
                       {**self.source, "error": "CLI failed"}, {**self.source, "stale": True}):
            B._samples.clear()
            self.source = source
            d = B.check("claude", now=1000)
            self.assertFalse(d["allowed"])
            self.assertIn("usage unknown", d["why"])

    def test_rate_drives_poll_interval_and_cached_checks_do_not_read(self):
        B.check("claude", now=1000)
        self.assertEqual(B._samples["claude"]["next"], 1060)
        B.check("claude", now=1030)
        self.assertEqual(self.reader.call_count, 1)
        self.source = {"available": True, "windows": [
            {"key": "session", "used_pct": 81, "resets_at": "2030-01-01T00:00:00Z"}]}
        B.check("claude", now=1060)
        self.assertEqual(B._samples["claude"]["next"], 1090)
        self.assertEqual(B.interval(1 / 300), 300)
        self.assertEqual(B.interval(0), 600)
        self.assertEqual(B.interval(1), 30)

    def test_no_jobs_means_no_background_reads(self):
        B.poll(root=self.root)
        self.reader.assert_not_called()

    def test_unclaimed_job_waits_and_a_running_job_cannot_be_parked(self):
        self.source["windows"][0]["used_pct"] = 81
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        B.park(j, B.check("claude"), root=self.root)
        held = Q.get(j["id"], root=self.root)
        self.assertEqual((held["status"], held["attempts"]), ("waiting", 0))
        self.assertIn("cap 80%", held["phase"])
        self.prefs = {}
        B.poll(root=self.root)
        claimed = Q.claim_next("t:claude", types=["t"], root=self.root)
        self.assertIsNotNone(claimed)
        self.assertFalse(Q.defer(j["id"], agent="claude", until=9999999999, why="cap", root=self.root))
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "running")

    def test_worker_checks_before_work_but_does_not_stop_admitted_work(self):
        self.source["windows"][0]["used_pct"] = 81
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        work = mock.Mock(return_value=None)
        W.run_once("t:claude", ["t"], work, root=self.root)
        work.assert_not_called()
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "waiting")
        self.source["windows"][0]["used_pct"] = 10
        B._samples.clear()
        Q.requeue(j["id"], root=self.root)
        def finish(job, report):
            self.source["windows"][0]["used_pct"] = 95
        W.run_once("t:claude", ["t"], finish, root=self.root)
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "done")

    def test_capped_idle_bar_uses_cache_without_reading(self):
        with mock.patch.object(A, "names", return_value=["claude"]):
            source = B.bar_source("claude")
        self.assertIn("unknown", source["cap_note"])
        self.reader.assert_not_called()

    def test_park_respects_cancel_and_provider_waits_do_not_get_released(self):
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        Q.cancel(j["id"], root=self.root)
        self.assertFalse(Q.defer(j["id"], agent="claude", until=9999999999, why="cap", root=self.root))
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        claimed = Q.claim_next("t:claude", types=["t"], root=self.root)
        Q.wait(j["id"], agent="claude", until=9999999999, why="provider limit", attempt=claimed["attempt"], root=self.root)
        B.release("claude", root=self.root)
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "waiting")

    def test_family_selection_uses_the_requested_model(self):
        self.prefs = {"agents": {"antigravity": {"session_cap": 80}}}
        for gemini, claude_gpt in ((10, 90), (90, 10)):
            B._samples.clear()
            self.reader.reset_mock()
            self.source = {"available": True, "windows": [
                {"key": "gemini_week", "used_pct": 100 - gemini},
                {"key": "claude_gpt_week", "used_pct": 100 - claude_gpt},
                {"key": "session", "used_pct": 100},
                {"key": "gemini", "used_pct": gemini},
                {"key": "claude_gpt", "used_pct": claude_gpt}]}
            for model, pool, used in (("gemini-test", "gemini", gemini),
                                      ("claude-test", "claude_gpt", claude_gpt),
                                      ("gpt-test", "claude_gpt", claude_gpt)):
                with self.subTest(model=model, used=used):
                    d = B.check("antigravity", model=model, now=1000, permissions=False)
                    self.assertEqual(d["window"], pool)
                    self.assertEqual(d["used_pct"], used)
                    self.assertEqual(d["allowed"], used < 80)
            self.assertEqual(self.reader.call_count, 1)

    def test_family_selection_uses_saved_model_unless_job_overrides_it(self):
        self.source = {"available": True, "windows": [
            {"key": "gemini", "used_pct": 10}, {"key": "gemini_week", "used_pct": 100},
            {"key": "claude_gpt", "used_pct": 90}, {"key": "claude_gpt_week", "used_pct": 0}]}
        for model, pool in (("gemini-test", "gemini"), ("claude-test", "claude_gpt"), ("gpt-test", "claude_gpt")):
            with self.subTest(model=model):
                self.prefs = {"agents": {"antigravity": {"model": model, "session_cap": 80}}}
                saved = B.check("antigravity", now=1000, permissions=False)
                self.assertEqual(saved["window"], pool)
                self.assertEqual(saved["allowed"], pool == "gemini")
                override = "claude-test" if pool == "gemini" else "gemini-test"
                d = B.check("antigravity", model=override, now=1000, permissions=False)
                self.assertNotEqual(d["window"], pool)
                self.assertNotEqual(d["allowed"], saved["allowed"])

    def test_model_fallback_uses_the_supplied_settings_snapshot(self):
        self.source = {"available": True, "windows": [
            {"key": "gemini", "used_pct": 0}, {"key": "claude_gpt", "used_pct": 90}]}
        self.prefs = {"agents": {"antigravity": {"model": "gemini-test", "session_cap": 80}}}
        snapshot = {"agents": {"antigravity": {"model": "claude-opus-5-5-high", "session_cap": 80}}}
        d = B.check("antigravity", prefs=snapshot, now=1000, permissions=False)
        self.assertEqual(d["window"], "claude_gpt")
        self.assertFalse(d["allowed"])

    def test_worker_admission_uses_the_job_model_before_the_saved_model(self):
        self.prefs = {"agents": {"antigravity": {"model": "gemini-test", "session_cap": 80}}}
        for gemini, claude_gpt, allowed in ((0, 90, False), (90, 10, True)):
            with self.subTest(gemini=gemini, claude_gpt=claude_gpt):
                B._samples.clear()
                self.source = {"available": True, "windows": [
                    {"key": "gemini", "used_pct": gemini}, {"key": "claude_gpt", "used_pct": claude_gpt}]}
                j = Q.enqueue(type="t", kind="seed", backend="antigravity", model="claude-opus-5-5-high", root=self.root)
                work = mock.Mock(return_value=None)
                W.run_once("t:antigravity", ["t"], work, root=self.root)
                self.assertEqual(work.call_count, int(allowed))
                self.assertEqual(Q.get(j["id"], root=self.root)["status"], "done" if allowed else "waiting")

    def test_runner_admission_uses_the_job_model_before_the_saved_model(self):
        from api import researchers as R
        self.prefs = {"agents": {"antigravity": {"model": "gemini-test", "session_cap": 80}}}
        self.source = {"available": True, "windows": [
            {"key": "gemini", "used_pct": 0}, {"key": "claude_gpt", "used_pct": 90}]}
        j = Q.enqueue(type="t", kind="seed", backend="antigravity", model="claude-opus-5-5-high", root=self.root)
        with (mock.patch.object(Q, "DATA", self.root), mock.patch.object(Q, "QUEUE", self.root / "queue.jsonl"),
              mock.patch.object(A, "execution", return_value={"allowed": True})):
            self.assertFalse(R._admitted({"type": "t"}, None, None))
        held = Q.get(j["id"], root=self.root)
        self.assertEqual(held["status"], "waiting")
        self.assertIn("90%", held["waiting"]["why"])

    def test_unknown_five_hour_reading_does_not_fall_back_to_weekly_or_other_pool(self):
        self.prefs = {"agents": {"antigravity": {"session_cap": 80}}}
        self.source = {"available": True, "windows": [
            {"key": "gemini", "used_pct": None},
            {"key": "gemini_week", "used_pct": 0}, {"key": "claude_gpt", "used_pct": 0},
            {"key": "claude_gpt_week", "used_pct": 0}, {"key": "session", "used_pct": 0}]}
        d = B.check("antigravity", model="gemini-test", now=1000, permissions=False)
        self.assertFalse(d["allowed"])
        self.assertEqual(d["window"], "gemini")
        self.assertIsNone(d["used_pct"])
        self.assertIn("usage unknown", d["why"])

    def test_claude_and_codex_caps_use_session_not_weekly(self):
        self.prefs = {"agents": {"claude": {"session_cap": 80}, "codex": {"session_cap": 80}}}
        for session, weekly in ((10, 100), (90, 0)):
            B._samples.clear()
            self.source = {"available": True, "windows": [
                {"key": "weekly", "used_pct": weekly}, {"key": "gemini", "used_pct": weekly},
                {"key": "claude_gpt", "used_pct": weekly}, {"key": "session", "used_pct": session}]}
            for agent in ("claude", "codex"):
                with self.subTest(agent=agent, session=session):
                    d = B.check(agent, now=1000)
                    self.assertEqual(d["window"], "session")
                    self.assertEqual(d["used_pct"], session)
                    self.assertEqual(d["allowed"], session < 80)

    def test_turning_off_ignores_old_cap_deadlines_without_reading(self):
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        Q.defer(j["id"], agent="claude", until=9999999999, why=B.PREFIX + "held", root=self.root)
        self.prefs = {}
        B.poll(root=self.root)
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "queued")
        self.reader.assert_not_called()

    def test_reset_window_discards_the_old_rate(self):
        B.check("claude", now=1000)
        self.source = {"available": True, "windows": [
            {"key": "session", "used_pct": 0, "resets_at": "2030-01-02T00:00:00Z"}]}
        self.assertTrue(B.check("claude", now=1060)["allowed"])
        self.assertEqual(B._samples["claude"]["rates"], {})

    def test_auto_skips_a_capped_agent_without_enqueuing(self):
        from core import auto as AU
        self.prefs["auto"] = {"on": True, "agent": "claude", "types": ["fx_visual"]}
        self.source["windows"][0]["used_pct"] = 81
        card = {"id": "x", "type": "fx_visual", "versions": [{"n": 1}]}
        start = mock.Mock()
        with mock.patch.object(AU, "_hears", return_value=None), mock.patch.object(AU, "_base", return_value=1):
            self.assertEqual(AU.tick(cards=lambda: [card], start=start, root=self.root), [])
        self.assertEqual(Q.jobs(root=self.root), [])
        start.assert_not_called()
        self.assertIn("cap 80%", AU.state["why"])

    def test_cap_api_saves_and_validates_without_changing_model(self):
        from flask import Flask
        from api import agents as api
        app = Flask(__name__)
        app.register_blueprint(api.bp)
        original = A.choice("claude")
        with mock.patch.object(P, "set", side_effect=lambda k, v: self.prefs.update({k: v})):
            client = app.test_client()
            for value in (True, 79, "80", None):
                self.assertEqual(client.put("/api/agents/claude", json={"session_cap": value}).status_code, 400)
            r = client.put("/api/agents/claude", json={"session_cap": 70})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.json["agent"]["choice"]["session_cap"], 70)
            self.assertEqual(r.json["agent"]["choice"]["model"], original["model"])
            r = client.put("/api/agents/claude", json={"session_cap": 100})
            self.assertEqual(r.json["agent"]["choice"]["session_cap"], 100)
        self.reader.assert_not_called()

    def test_cancel_wins_over_an_automatic_wait_release(self):
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        why = B.PREFIX + "held"
        Q.defer(j["id"], agent="claude", until=9999999999, why=why, root=self.root)
        Q.cancel(j["id"], root=self.root)
        self.assertFalse(Q.requeue(j["id"], root=self.root, waiting_for=why))
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "cancelled")

    def test_server_holds_before_starting_a_runner(self):
        from api import researchers as R
        self.source["windows"][0]["used_pct"] = 81
        j = Q.enqueue(type="t", kind="seed", backend="claude", root=self.root)
        t = {"type": "t", "start": ["unused"], "researcher": "unused"}
        with (mock.patch.object(Q, "DATA", self.root), mock.patch.object(Q, "QUEUE", self.root / "queue.jsonl"),
              mock.patch.object(R, "_home", return_value=self.root),
              mock.patch.object(R.L, "alive", return_value=False), mock.patch.object(R.L, "release"),
              mock.patch("core.gate.closed", return_value=False),
              mock.patch.object(R.subprocess, "Popen", side_effect=AssertionError("must not start"))):
            body, code = R.start_runner(t)
            self.assertEqual((body.get("waiting"), code), (True, 200))
        self.assertEqual(Q.get(j["id"], root=self.root)["status"], "waiting")


class UsageReaders(unittest.TestCase):
    def test_failed_codex_refresh_retains_the_bar_but_blocks_admission(self):
        import server
        data = {"rateLimits": {"primary": {"usedPercent": 20}, "secondary": {"usedPercent": 40}}}
        with (mock.patch.dict(server._CODEX_LIVE, {"ts": 999, "data": data, "busy": False, "err": None}, clear=True),
              mock.patch.object(server, "_codex_rate_limits", return_value=None),
              mock.patch.object(server.time, "time", return_value=1000)):
            source = server._usage_all_codex(1000, True)
        self.assertEqual(source["windows"][0]["used_pct"], 20)
        self.assertTrue(source["error"])
        with mock.patch.object(B, "_reader", return_value=source), mock.patch.dict(B._samples, {}, clear=True):
            self.assertFalse(B.check("codex", now=1000, prefs={"agents": {"codex": {"session_cap": 80}}})["allowed"])

    def test_failed_claude_refresh_is_not_a_fresh_low_reading(self):
        import server
        with (mock.patch.dict(server._usage_cache, {"ts": 999, "data": {"session": {"pct": 20}}}, clear=True),
              mock.patch.object(A, "claude_usage", side_effect=RuntimeError("CLI failed"))):
            source = server._usage_all_anthropic(1000, True)
        self.assertEqual(source["windows"][0]["used_pct"], 20)
        self.assertEqual(source["error"], "CLI failed")

    def test_failed_agy_cli_exit_is_unknown_even_with_json(self):
        import server
        result = mock.Mock(returncode=1, stdout='{"command":{"data":{}}}', stderr="CLI failed")
        with mock.patch.object(A, "binary", return_value="fake-agy"), mock.patch.object(server.subprocess, "run", return_value=result):
            self.assertIn("exited 1", server._capture_agy_usage_cli()["error"])


class Execution(unittest.TestCase):
    def test_restricted_commands_and_refusal(self):
        with mock.patch.object(C, "get", return_value=replace(C.get(), unrestricted_agents=False)):
            codex = A.argv("codex", "P", Path("/job"), model=None, effort=None)
            self.assertIn("workspace-write", codex)
            self.assertIn('approval_policy="never"', codex)
            self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", codex)
            self.assertIn("--skip-git-repo-check", codex)        # a project folder needn't be a git repository
            claude = A.argv("claude", "P", Path("/job"), model=None, effort=None)
            self.assertIn("--restricted", claude)
            self.assertIn("--permission-prompts", claude)
            self.assertEqual(claude[claude.index("--permission-prompts") + 1], "none")
            self.assertIn("--strict-mcp-config", claude)
            with self.assertRaisesRegex(ValueError, "needs unrestricted_agents"):
                A.argv("antigravity", "P", Path("/job"), model=None, effort=None)

    def test_the_wiring_check_leaves_out_a_refused_agent(self):
        from flask import Flask
        from api import agents as api
        app = Flask(__name__)
        app.register_blueprint(api.bp)
        made = []
        with (mock.patch.object(C, "get", return_value=replace(C.get(), unrestricted_agents=False)),
              mock.patch.object(api, "_types", return_value=[{"type": "t", "start": ["x"],
                                                               "agents": ["claude", "antigravity"]}]),
              mock.patch.object(api.Q, "enqueue", side_effect=lambda **k: made.append(k) or {"id": str(len(made))}),
              mock.patch.object(api.Q, "get", side_effect=lambda jid: {"id": jid, "status": "queued", "kind": "ping"}),
              mock.patch.object(api, "_row_of", side_effect=lambda j: {"status": j["status"]}),
              mock.patch.object(api, "start_runner", return_value=({"ok": True}, 202))):
            r = app.test_client().post("/api/agents/check", json={})
        self.assertEqual(r.status_code, 202, r.get_json())
        self.assertEqual([k["backend"] for k in made], ["claude", "render"])

    def test_opt_in_keeps_existing_commands(self):
        with mock.patch.object(C, "get", return_value=replace(C.get(), unrestricted_agents=True)):
            self.assertIn("--dangerously-bypass-approvals-and-sandbox", A.argv("codex", "P", Path("/job"), model=None, effort=None))
            self.assertIn("--dangerously-skip-permissions", A.argv("antigravity", "P", Path("/job"), model=None, effort=None))
            self.assertNotIn("--restricted", A.argv("claude", "P", Path("/job"), model=None, effort=None))

    def test_config_requires_a_boolean_and_defaults_restricted(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "picker.toml"
            base = 'data="data"\nstate="state"\ncache="cache"\nagents="agents.json"\nresearch="."\ntypes=[]\n'
            f.write_text(base)
            self.assertFalse(C.read(f).unrestricted_agents)
            f.write_text(base + 'unrestricted_agents="true"\n')
            with self.assertRaises(C.ConfigError):
                C.read(f)
            f.write_text(base + 'unrestricted_agents=true\n')
            self.assertTrue(C.read(f).unrestricted_agents)
