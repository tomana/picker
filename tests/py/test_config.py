"""Explicit config wins over the environment; subprocesses and their children must share isolated roots."""
import _cfg  # noqa: F401
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from core import config as C  # noqa: E402

PICKER = Path(__file__).resolve().parents[2]
# the picker's own types: its made-up ones and the examples, read only (as a TOML list); served against the picker
TYPES = json.dumps(sorted([str(m) for m in (PICKER / "tests" / "fixture" / "types").glob("*.json")]
                          + [str(m) for m in (PICKER / "examples").glob("*/picker-type.json")]))
RESEARCH = PICKER


def make(root: Path, name: str) -> Path:
    """A config at root/name/picker.toml, its paths relative to it."""
    d = root / name
    d.mkdir(parents=True)
    f = d / "picker.toml"
    f.write_text(f'data = "store"\nstate = "state"\ncache = "cache"\ndownloads = "dl"\n'
                 f'agents = "{PICKER / "agents.json"}"\ntypes = {TYPES}\nresearch = "{RESEARCH}"\n'
                 f'band = "band.js"\n[server]\nport = 8123\n')
    return f


def py(code: str, *, cwd: Path, env: dict | None = None, args=()) -> subprocess.CompletedProcess:
    """`python -c code` from `cwd`, the picker's code on the path, PICKER_CONFIG as `env` says (absent: none)."""
    e = {k: v for k, v in os.environ.items() if k not in ("PICKER_CONFIG", "PICKER_TRACE")}
    e.update(PYTHONPATH=str(PICKER), PYTHONDONTWRITEBYTECODE="1", **(env or {}))
    return subprocess.run([sys.executable, "-c", code, *args], cwd=cwd, env=e, capture_output=True, text=True,
                          timeout=60)




def _absolute(entry: dict, cfg) -> dict:
    """A served manifest entry with its paths absolute (as the fixture writes its manifests)."""
    return C._paths(entry, lambda v: os.path.normpath(cfg.research / v))

class ConfigTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.away = self.root / "elsewhere"            # an unrelated working directory
        self.away.mkdir()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_paths_resolve_against_the_file_and_a_bad_one_says_why(self):
        from core import config as C
        f = make(self.root, "a")
        c = C.read(f)
        self.assertEqual((c.data, c.state, c.cache, c.band, c.port),
                         (f.parent / "store", f.parent / "state", f.parent / "cache", f.parent / "band.js", 8123))
        self.assertEqual(c.research, RESEARCH)
        with self.assertRaisesRegex(C.ConfigError, "no config at"):
            C.read(self.root / "none.toml")
        (self.root / "bad.toml").write_text("data = \"x\"\n")
        with self.assertRaisesRegex(C.ConfigError, "missing state, cache"):
            C.read(self.root / "bad.toml")
        (self.root / "one.toml").write_text(f.read_text().replace(f"types = {TYPES}", 'types = "types.json"'))
        with self.assertRaisesRegex(C.ConfigError, "types is a list of manifests"):
            C.read(self.root / "one.toml")
        (self.root / "junk.toml").write_text("data = [")
        with self.assertRaises(C.ConfigError):
            C.read(self.root / "junk.toml")

    def test_config_beats_a_conflicting_picker_config_and_children_get_the_same(self):
        a, b = make(self.root, "a"), make(self.root, "b")
        code = ("import os, subprocess, sys\nfrom core import config as C\nc = C.require(sys.argv[1:])\n"
                "print(c.data)\nprint(os.environ['PICKER_CONFIG'])\n"
                "print(subprocess.run([sys.executable, '-c', 'from core import config as C; print(C.get().data)'],"
                " capture_output=True, text=True).stdout.strip())")
        r = py(code, cwd=self.away, env={"PICKER_CONFIG": str(b)}, args=["--config", str(a)])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), [str(a.parent / "store"), str(a), str(a.parent / "store")],
                         "--config wins, PICKER_CONFIG is set to it, and a child resolves the same store")
        r = py(code, cwd=self.away, env={"PICKER_CONFIG": str(b)})
        self.assertEqual(r.stdout.split()[0], str(b.parent / "store"), "no --config: PICKER_CONFIG")

    def test_the_server_with_no_config_or_a_bad_one_exits_before_it_imports_anything(self):
        for env, said in (({}, "no config"), ({"PICKER_CONFIG": str(self.root / "gone.toml")}, "bad config")):
            e = {k: v for k, v in os.environ.items() if k != "PICKER_CONFIG"}
            e.update(PYTHONDONTWRITEBYTECODE="1", **env)
            r = subprocess.run([sys.executable, "-X", "importtime", str(PICKER / "server.py"), "--port", "0"],
                               cwd=self.away, env=e, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(said, r.stderr)
            imported = {ln.rsplit("|", 1)[-1].strip() for ln in r.stderr.splitlines() if ln.startswith("import time:")}
            self.assertIn("core.config", imported)
            for m in ("flask", "api", "api.cards", "core.queue"):
                self.assertNotIn(m, imported, f"{m} was imported before the server gave up")
        self.assertEqual(list(self.away.iterdir()), [], "nothing written where it was started")

    def test_two_stores_stay_independent(self):
        a, b = make(self.root, "a"), make(self.root, "b")
        # each process queues a job, sets a pref, traces, closes its gate and names its caches; its child syncs
        code = ("import json, subprocess, sys\nfrom core import config as C\nC.require(sys.argv[1:])\n"
                "from core import queue as Q, prefs as P, trace as T, gate as G\nfrom api import cards as CA\n"
                "j = Q.enqueue(type='t', kind='seed', text=sys.argv[3])\nP.set('panels', {'who': sys.argv[3]})\n"
                "T.emit('test', 'here', who=sys.argv[3])\nG.close(sys.argv[3])\n"
                "child = subprocess.run([sys.executable, '-c', 'from core import queue as Q; print(len(Q.jobs()))'],"
                " capture_output=True, text=True).stdout.strip()\n"
                "print(json.dumps({'job': j['id'], 'thumbs': str(CA.THUMB_DIR), 'mix': str(CA.MIX_DIR), 'child': child}))")
        out = {}
        for f, who in ((a, "A"), (b, "B")):
            r = py(code, cwd=self.away, args=["--config", str(f), who])
            self.assertEqual(r.returncode, 0, r.stderr)
            out[who] = json.loads(r.stdout.strip().splitlines()[-1])
        for f, who, other in ((a, "A", "B"), (b, "B", "A")):
            store = f.parent / "store"
            queue = (store / "queue.jsonl").read_text()
            self.assertIn(out[who]["job"], queue)
            self.assertNotIn(out[other]["job"], queue, f"{who}'s queue has {other}'s job")
            self.assertIn(f'"who": "{who}"', (store / "prefs.jsonl").read_text())
            self.assertNotIn(f'"who": "{other}"', (store / "prefs.jsonl").read_text())
            self.assertIn(f'"who": "{who}"', (store / "trace.jsonl").read_text())
            self.assertEqual(json.loads((f.parent / "state" / "gate.json").read_text())["why"], who)
            self.assertEqual((out[who]["thumbs"], out[who]["mix"]),
                             (str(f.parent / "cache" / "thumbs"), str(f.parent / "cache" / "mix")))
            self.assertEqual(out[who]["child"], "1", "the child read its parent's store, and only it")
        self.assertEqual(list(self.away.iterdir()), [], "nothing written where they were started")

    def test_the_types_are_the_manifests_their_paths_served_against_the_research(self):
        """Resolve each manifest relative to itself and preserve config order; report malformed manifests."""
        cfg = C.read(make(self.root, "a"))
        ts = C.types(cfg)
        # in the config's order, each manifest's own id; a type's paths served against the research
        self.assertEqual([t["type"] for t in ts], [json.loads(Path(m).read_text())["type"] for m in json.loads(TYPES)])
        music = next(t for t in ts if t["type"] == "music")
        self.assertEqual((music["researcher"], music["outputs"], music["program"], music["sync"]),
                         ("examples/music/queue_runner.py", ["examples/music/runs"], "examples/music/program.md",
                          {"argv": ["{python}", "sync.py"], "cwd": "examples/music"}))
        copies = []
        for t in ts:
            m = self.root / "copies" / f"{t['type']}.json"
            m.parent.mkdir(exist_ok=True)
            m.write_text(json.dumps(_absolute(t, cfg)))
            copies.append(str(m))
        f = make(self.root, "b")
        f.write_text(f.read_text().replace(f"types = {TYPES}", f"types = {json.dumps(copies)}"))
        self.assertEqual(C.types(C.read(f)), ts)
        Path(copies[2]).write_text("{")
        with self.assertRaisesRegex(C.ConfigError, f"{ts[2]['type']}.json"):
            C.types(C.read(f))

    def test_what_a_type_can_do_is_its_manifests_under_any_id_and_an_edit_is_read(self):
        """Capabilities come from manifests rather than type IDs; reload edited manifests."""
        cfg = C.read(make(self.root, "a"))
        self.assertEqual((C.capability("music", "need", cfg), C.capability("visual", "need", cfg)), (True, None))
        self.assertEqual((C.capability("visual", "auto", cfg), C.capability("fx_show", "auto", cfg)), ("revise", "placeholder"))
        self.assertTrue(C.capability("fx_music", "timeline", cfg))
        self.assertEqual(C.manifest("fx_music", cfg).get("lanes"), "by_agent")
        self.assertEqual(C.manifest("fx_music", cfg).get("name_prefix"), "m")
        self.assertIsNone(C.capability("nope", "need", cfg))
        music = _absolute(C.manifest("music", cfg), cfg)
        m = self.root / "renamed.json"
        m.write_text(json.dumps({**music, "type": "renamed"}))
        f = make(self.root, "b")
        f.write_text(f.read_text().replace(f"types = {TYPES}", f'types = ["{m}"]'))
        cfg2 = C.read(f)
        self.assertTrue(C.capability("renamed", "need", cfg2))
        m.write_text(json.dumps({**music, "type": "renamed", "capabilities": {}}))
        st = m.stat()
        os.utime(m, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        self.assertIsNone(C.capability("renamed", "need", cfg2), "the edited manifest wasn't read again")

    def test_sync_runs_the_declared_command_where_declared(self):
        """Resolve sync cwd against its manifest, use the caller interpreter and lock in caller state."""
        research = self.root / "research"
        (research / "sub").mkdir(parents=True)
        out = self.root / "said.txt"
        (research / "picker-type.json").write_text(json.dumps({"type": "t", "sync": {
            "argv": ["{python}", "-c", f"import os, sys; open({str(out)!r}, 'w').write(os.getcwd() + '\\n' + "
                                        "sys.executable)"], "cwd": "sub"}}))
        f = make(self.root, "a")
        f.write_text(f.read_text().replace(f"types = {TYPES}", f'types = ["{research / "picker-type.json"}"]')
                     .replace(f'research = "{RESEARCH}"', f'research = "{research}"'))
        code = "import sys\nfrom core import researcher as R\nR.sync('t')\nprint(sys.executable)"
        r = py(code, cwd=self.away, env={"PICKER_CONFIG": str(f)})
        self.assertEqual(r.returncode, 0, r.stderr)
        cwd, exe = out.read_text().splitlines()
        self.assertEqual((cwd, exe), (str(research / "sub"), r.stdout.split()[0]))
        self.assertTrue((f.parent / "state" / "sync_t.lock").is_file(), "the lock is in the caller's state")

    @unittest.skipUnless(shutil.which("uv"), "uv starts the runners")
    def test_a_runner_by_hand_gets_the_sdk_from_the_pickers_tree_and_a_wrong_path_fails_first(self):
        """Resolve the SDK from the selected tree; an invalid editable path must fail before claiming work."""
        f = make(self.root, "a")
        script = self.away / "runner.py"
        script.write_text("from picker import sdk\nimport core.researcher as R\nprint(sdk.__file__)\n"
                          "print(R.__file__)\nprint(sdk.config().data)\n")
        e = {k: v for k, v in os.environ.items() if k not in ("PICKER_CONFIG", "PICKER_TRACE", "PYTHONPATH")}
        e.update(PICKER_CONFIG=str(f), PYTHONDONTWRITEBYTECODE="1")
        r = subprocess.run(["uv", "run", "-q", "--no-project", "--with-editable", str(PICKER), "runner.py"],
                           cwd=self.away, env=e, capture_output=True, text=True, timeout=180)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.split(), [str(PICKER / "picker" / "sdk.py"), str(PICKER / "core" / "researcher.py"),
                                            str(f.parent / "store")])
        r = subprocess.run(["uv", "run", "-q", "--no-project", "--with-editable", str(self.root / "nowhere"),
                            "runner.py"], cwd=self.away, env=e, capture_output=True, text=True, timeout=180)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((f.parent / "store").exists(), "nothing ran: no store, no claim")


if __name__ == "__main__":
    unittest.main()
