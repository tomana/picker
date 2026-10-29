"""Track job processes in groups; cancellation and deadlines stop descendants too.
Read output without blocking and bound draining even if descendants retain the pipe."""
from __future__ import annotations

import os
import selectors
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import trace as T
from .worker import Stopped

POLL = 3.0                        # seconds between looks at the job's stop and the deadline
DRAIN_S = 10                      # seconds to read what is left in the pipe once the process has gone


class TimedOut(RuntimeError):
    """The deadline passed: the process and what it started were stopped."""


@dataclass
class Done:
    exit: int | None
    lines: list = field(default_factory=list)
    seconds: float = 0.0

    @property
    def text(self) -> str:
        return "\n".join(self.lines)

    @property
    def returncode(self) -> int | None:
        return self.exit

    @property
    def stdout(self) -> str:
        return self.text


def job_stop() -> bool:
    """Use bound trace tokens, or the inherited job/live-attempt environment in runner-owned threads."""
    jid = T.token("job") or os.environ.get("PICKER_JOB")
    if not jid:
        return False
    try:
        from . import queue as Q
        return Q.stop_asked(jid, T.token("attempt"))
    except Exception:                               # noqa: BLE001  a queue read must never stop the work
        return False


def stop_group(pid: int, grace: float = 10.0, reap=None) -> bool:
    """Terminate then kill after grace; reap owned children so zombies do not keep groups apparently alive."""
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        end = time.time() + wait
        while time.time() < end:
            if reap:
                reap()
            try:
                os.killpg(pid, 0)
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            time.sleep(0.1)
    return False


def _child(pgid: int, running: bool) -> None:
    """The runner's lane lock lists the groups it is running (runner.child); a process outside a runner has none."""
    try:
        import runner as R
        R.child(pgid, running)
    except Exception:                               # noqa: BLE001  the picker's own process, a test: no lane
        pass


def run(argv: list, *, log: Path | None = None, cwd: Path | None = None, env: dict | None = None,
        deadline: float | None = None, on_line=None, stop=job_stop, poll: float = POLL,
        drain: float = DRAIN_S) -> Done:
    """Return nonzero exits for the caller to classify; stop/deadline raises only after the group is gone.
    Exceptions carry captured output in done; on_line replaces default logging and collection."""
    t0 = time.time()
    res = Done(exit=None)
    if log:
        Path(log).parent.mkdir(parents=True, exist_ok=True)
    out = open(log, "a", buffering=1) if log else None
    proc = subprocess.Popen([str(a) for a in argv], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                 cwd=str(cwd) if cwd else None, env=env, start_new_session=True)
    _child(proc.pid, True)
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    buf, eof = b"", False

    def take(chunk: bytes, final: bool = False):
        nonlocal buf
        buf += chunk
        *whole, buf = buf.split(b"\n")
        if final and buf:
            whole, buf = [*whole, buf], b""
        for raw in whole:
            line = raw.decode("utf-8", errors="replace").rstrip("\r")
            if on_line is not None:
                on_line(line)
            else:
                res.lines.append(line)
                if out:
                    out.write(line + "\n")

    def read(timeout: float) -> bool:
        nonlocal eof
        if eof:
            time.sleep(min(timeout, 0.05))
            return False
        for key, _ in sel.select(timeout=timeout):
            chunk = os.read(key.fileobj.fileno(), 65536)
            if not chunk:
                eof = True
                return False
            take(chunk)
        return True

    why = None
    try:
        look = time.time() + poll
        while proc.poll() is None:
            if time.time() >= look:
                look = time.time() + poll
                if stop():
                    why = "stopped"
                    break
            if deadline and time.time() > deadline:
                why = "deadline"
                break
            read(timeout=min(1.0, poll))
        if why:
            if out:
                out.write(f"\n[{'paused or cancelled in the picker' if why == 'stopped' else 'the time ran out'}"
                          f" — stopped, with what it started]\n")
            stop_group(proc.pid, reap=proc.poll)
        else:
            # Stop remaining group members before bounded draining so background children cannot keep writing.
            stop_group(proc.pid, grace=5.0, reap=proc.poll)
            end = time.time() + drain
            while time.time() < end and read(timeout=max(0.0, end - time.time())):
                pass
        take(b"", final=True)
    finally:
        sel.close()
        proc.stdout.close()
        # Keep the group registered until all descendants stop, including on exceptional exit.
        if stop_group(proc.pid, grace=5.0, reap=proc.poll):
            _child(proc.pid, False)
        if proc.poll() is None:
            proc.wait()
        if out:
            out.close()
    res.exit, res.seconds = proc.returncode, time.time() - t0
    if why:
        name = Path(str(argv[0])).name
        e = (Stopped(f"{name}: the job was paused or cancelled") if why == "stopped"
             else TimedOut(f"{name}: its time ran out after {res.seconds:.0f} s"))
        e.done = res
        raise e
    return res
