"""Probe forbidden writes, processes and connections; inspect hidden paths for existence without reading them."""
import os
import socket
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import guard  # noqa: E402

LEAKS = Path(sys.argv[1])
LEAKS.write_text("")
guard.install(LEAKS)

try:
    (guard.PICKER / "selftest_escape.txt").write_text("this must never land")
except OSError:
    pass
try:
    subprocess.run(["claude", "--version"], capture_output=True)
except (PermissionError, OSError):
    pass

try:
    socket.create_connection(("127.0.0.1", 8080), timeout=2).close()
except OSError:
    pass

home = Path(os.environ.get("HOME", "/nonexistent"))
private = [home / ".claude" / ".credentials.json", home / ".codex" / "auth.json", home / ".gemini",
           home / ".local" / "share" / "uv" / "credentials", home / ".ssh"]
# what move_check.sh hides (FIXTURE_HIDDEN): a suite's private folders
hidden = [Path(d) for d in os.environ.get("FIXTURE_HIDDEN", "").split(os.pathsep) if d]
with open(LEAKS, "a") as f:
    for p in private:
        if p.exists():
            f.write(f"read\t{p}\n")
    for d in hidden:
        if d.is_dir() and any(d.iterdir()):
            f.write(f"read\t{d}\n")
