"""Subscription subprocesses must not inherit API billing credentials; warnings expose names only."""
import _cfg  # noqa: F401
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from core import agents as A


class SubscriptionEnvironment(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.secrets = {k: f"test-only-secret-{i}" for i, k in enumerate(A.API_ENV)}
        self.enterContext(mock.patch.dict(os.environ, {**self.secrets, "PICKER_ENV_PROBE": "preserved"}))

    def clean(self, env):
        self.assertTrue(set(A.API_ENV).isdisjoint(env))
        self.assertEqual(env["PICKER_ENV_PROBE"], "preserved")

    def test_each_launched_agent_gets_no_api_keys_and_keeps_subscription_login(self):
        code = ("import json, os; print(json.dumps({'present': [k for k in " + repr(A.API_ENV)
                + " if k in os.environ], 'safe': os.environ.get('PICKER_ENV_PROBE'), "
                  "'oauth': os.environ.get('CLAUDE_CODE_OAUTH_TOKEN')}))")
        with (mock.patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "subscription-test-token"}),
              mock.patch.object(A, "argv", return_value=[sys.executable, "-c", code])):
            for agent in ("claude", "codex", "antigravity"):
                with self.subTest(agent=agent):
                    result = A.run(agent, "environment probe", self.tmp, self.tmp / f"{agent}.log",
                                   model=None, effort=None)
                    self.assertTrue(result.ok)
                    self.assertEqual(json.loads(result.text), {
                        "present": [], "safe": "preserved", "oauth": "subscription-test-token"})
        for k, v in self.secrets.items():
            self.assertEqual(os.environ[k], v)

    def test_usage_and_model_discovery_filter_the_environment(self):
        import server
        with mock.patch.object(A, "binary", return_value="fake-cli"):
            answer = subprocess.CompletedProcess([], 0, stdout=json.dumps({"result": "Current session: 1% used"}), stderr="")
            with mock.patch.object(A.subprocess, "run", return_value=answer) as run:
                self.assertEqual(A.claude_usage(1000, cwd=self.tmp)["session"]["pct"], 1)
                self.clean(run.call_args.kwargs["env"])
            answer.stdout = json.dumps({"command": {"data": {"groups": [{
                "name": "gemini", "buckets": [{"window": "5h", "remaining_fraction": 0.9}]}]}}})
            with mock.patch.object(server.subprocess, "run", return_value=answer) as run:
                self.assertIn("groups", server._capture_agy_usage_cli())
                self.clean(run.call_args.kwargs["env"])
            answer.stdout = "model-test\tModel test\n"
            run = mock.Mock(return_value=answer)
            with mock.patch.dict(A._agy_cache, {"at": 0, "models": None, "err": None}, clear=True):
                self.assertEqual(A.agy_models(run=run)[0]["id"], "model-test")
                self.clean(run.call_args.kwargs["env"])

    def test_codex_usage_process_is_filtered(self):
        import server
        with (mock.patch.object(A, "binary", return_value="fake-cli"),
              mock.patch.dict(server._CODEX_LIVE, {}, clear=False),
              mock.patch.object(server.subprocess, "Popen", side_effect=OSError("probe ended")) as spawn):
            self.assertIsNone(server._codex_rate_limits())
            self.clean(spawn.call_args.kwargs["env"])

    def test_wiring_warns_before_any_check_without_exposing_values(self):
        from flask import Flask
        from api import agents as api
        app = Flask(__name__)
        app.register_blueprint(api.bp)
        with mock.patch.object(api.Q, "jobs", return_value=[]):
            r = app.test_client().get("/api/agents/check")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json["rows"], [])
        warnings = r.json["issues"]
        self.assertEqual(len(warnings), len(A.api_env_vars()))
        for name in A.API_ENV:
            self.assertTrue(any(name in w["title"] and w["level"] == "warn" for w in warnings))
        for secret in self.secrets.values():
            self.assertNotIn(secret, r.get_data(as_text=True))

    def test_an_empty_key_is_still_reported_by_name(self):
        with mock.patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            self.assertIn("OPENAI_API_KEY", A.api_env_vars())
            self.assertNotIn("OPENAI_API_KEY", A.agent_env())

    def test_runner_and_check_helper_get_the_filtered_environment(self):
        from api import agents as api, researchers as R
        with (mock.patch.object(api, "_home", return_value=self.tmp),
              mock.patch.object(api.subprocess, "run", return_value=subprocess.CompletedProcess(
                  [], 0, stdout='{"cwd":"scratch","brief":"probe"}', stderr="")) as run):
            self.assertEqual(api._describe({}, "claude")["brief"], "probe")
            self.clean(run.call_args.kwargs["env"])
        t = {"type": "fx_visual", "researcher": "unused", "start": ["fake-runner"]}
        with (mock.patch.object(R, "_home", return_value=self.tmp),
              mock.patch.object(R.L, "alive", return_value=False), mock.patch.object(R.L, "release"),
              mock.patch("core.gate.closed", return_value=False),
              mock.patch.object(R, "_claimable", return_value={"claimable": 1}),
              mock.patch.object(R, "_admitted", return_value=True),
              mock.patch.object(R, "_detach", side_effect=lambda argv: argv),
              mock.patch.object(R.subprocess, "Popen", return_value=mock.Mock(pid=123)) as spawn):
            self.assertEqual(R.start_runner(t)[1], 202)
            self.clean(spawn.call_args.kwargs["env"])
