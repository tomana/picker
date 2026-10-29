"""Import before path-binding modules: use explicit config or temporary roots, never production data.
Fallback type syncs refuse execution; example homes are copied, not reused."""
import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
if not os.environ.get("PICKER_CONFIG"):
    _d = Path(tempfile.mkdtemp(prefix="picker-pytest-"))
    atexit.register(shutil.rmtree, _d, True)
    # every type's sync refuses: a test that reaches one without stubbing it fails loudly
    _types = []
    for _f in sorted([*(PICKER / "tests" / "fixture" / "types").glob("*.json"), *(PICKER / "examples").glob("*/picker-type.json")]):
        _t = json.loads(_f.read_text())
        _t = {**_t, **{k: str((_f.parent / _t[k]).resolve()) for k in ("researcher", "program", "plugin", "cards") if _t.get(k)},
              "outputs": [str((_f.parent / o).resolve()) for o in _t.get("outputs") or []],
              "sync": {"argv": ["{python}", "-c", f"import sys; sys.exit('a test reached the real sync of "
                                f"{_t['type']}: stub core.researcher.sync')"], "cwd": "."}}
        _t["cards"] = str(_d / "stores" / _t["type"])      # never the example's own folder
        _m = _d / "types" / f"{_t['type']}.json"
        _m.parent.mkdir(exist_ok=True)
        _m.write_text(json.dumps(_t))
        _types.append(str(_m))
    (_d / "picker.toml").write_text(
        f'data = "data"\nstate = "state"\ncache = "cache"\n'
        f'agents = "{PICKER / "agents.json"}"\ntypes = {json.dumps(_types)}\nresearch = "{_d}"\n')
    os.environ["PICKER_CONFIG"] = str(_d / "picker.toml")
if str(PICKER) not in sys.path:
    sys.path.insert(0, str(PICKER))


def _research() -> Path:
    import importlib.util
    spec = importlib.util.spec_from_file_location("_picker_config_r", PICKER / "core" / "config.py")
    C = sys.modules[spec.name] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(C)
    return C.read(Path(os.environ["PICKER_CONFIG"])).research


RESEARCH = _research()                  # the research the config in use names
