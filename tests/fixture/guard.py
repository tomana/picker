"""Install before fixture work: audit writes and refuse unlisted programs and non-fixture connections.
FIXTURE_ALLOW extends writable roots; production endpoints remain forbidden."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

PICKER = Path(__file__).resolve().parents[2]
# Load config by path; runners must obtain the SDK through the editable package.
_spec = importlib.util.spec_from_file_location("_guard_config", PICKER / "core" / "config.py")
_C = sys.modules["_guard_config"] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_C)

_CFG = _C.read(Path(os.environ["PICKER_CONFIG"]))      # never a fallback: no config here is a broken check
ALLOWED = [str(_CFG.data), str(_CFG.state), str(_CFG.cache), "/tmp", "/dev", "/proc",
           *filter(None, os.environ.get("FIXTURE_ALLOW", "").split(os.pathsep))]
PROGRAMS = {"ffmpeg", "ffprobe", "git", "ss", "pgrep", "uv"}
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC


def install(leaks: Path) -> None:
    seen: set[str] = set()
    ports = {int(p) for p in [os.environ.get("FIXTURE_PORT"), *os.environ.get("FIXTURE_DOWN", "").split(":")] if p}

    def leak(what: str, path) -> None:
        if isinstance(path, int) or path is None:
            return
        p = os.path.abspath(os.fsdecode(path))
        if any(p == a or p.startswith(a + "/") for a in ALLOWED) or p in seen:
            return
        seen.add(p)
        with open(leaks, "a") as f:
            f.write(f"{what}\t{p}\n")

    def audit(event: str, args) -> None:
        if event == "socket.connect":
            addr = args[1]
            if isinstance(addr, tuple) and not (addr[0] in LOOPBACK and addr[1] in ports):
                with open(leaks, "a") as f:
                    f.write(f"net\t{addr[0]}:{addr[1]}\n")
                raise PermissionError(f"the fixture connects to nothing but its own picker, not {addr[0]}:{addr[1]}")
        elif event == "open":
            path, mode, flags = args
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or \
               (isinstance(flags, int) and flags & _WRITE_FLAGS):
                leak("write", path)
        elif event in ("os.rename", "os.link", "os.symlink"):
            leak(event, args[1])
        elif event in ("os.remove", "os.rmdir", "os.mkdir", "os.truncate", "shutil.rmtree", "os.chmod",
                       "os.utime"):
            leak(event, args[0])

    sys.addaudithook(audit)

    real = subprocess.Popen

    class GuardedPopen(real):
        def __init__(self, args, *a, **k):
            argv = [args] if isinstance(args, (str, bytes)) else list(args)
            exe = os.path.basename(os.fsdecode(argv[0])) if argv else ""
            if exe not in PROGRAMS and os.fsdecode(argv[0]) != sys.executable:
                with open(leaks, "a") as f:
                    f.write(f"exec\t{' '.join(os.fsdecode(x) for x in argv)[:200]}\n")
                raise PermissionError(f"the fixture picker does not run {exe!r}")
            super().__init__(args, *a, **k)

    subprocess.Popen = GuardedPopen
