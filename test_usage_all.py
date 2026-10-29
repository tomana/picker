# /// script
# requires-python = ">=3.10"
# dependencies = ["flask>=3.0", "numpy"]
# ///
"""Check usage polarity and reset normalization without live sources."""
import importlib.util, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
spec = importlib.util.spec_from_file_location("psrv", str(ROOT / "server.py"))
m = importlib.util.module_from_spec(spec)
sys.modules["psrv"] = m
spec.loader.exec_module(m)

now = time.time()
FUT = (datetime.now(timezone.utc) + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%SZ")
PAST = (datetime.now(timezone.utc) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
fails = []

def check(label, got, want):
    ok = got == want
    print(f"{'PASS' if ok else 'FAIL'}  {label}: got={got!r} want={want!r}")
    if not ok: fails.append(label)

w = m._usage_window("session", "s", 41.0, FUT, now)
check("used passthrough", (w["used_pct"], w["post_reset"]), (41.0, False))
w = m._usage_window("session", "s", 41.0, PAST, now)
check("post-reset collapses to 0", (w["used_pct"], w["post_reset"]), (0.0, True))
w = m._usage_window("session", "s", 140.0, FUT, now)
check("clamp over 100", w["used_pct"], 100.0)
w = m._usage_window("session", "s", None, None, now)
check("no data stays None", w["used_pct"], None)
w = m._usage_window("session", "s", 41.0, "garbage-not-a-date", now)
check("unparseable reset != reset now", (w["used_pct"], w["post_reset"]), (41.0, False))

m._AGY_CACHE.update(ts=now, data={
    "models": {
        "Gemini 3 Pro":        {"pct": 73, "status": "Ready", "resets_at": FUT},
        "Gemini 3 Flash":      {"pct": 73, "status": "Ready", "resets_at": FUT},
        "Claude Sonnet 4.5":   {"pct": 12, "status": "Ready", "resets_at": FUT},
        "GPT-5":               {"pct": 12, "status": "Ready", "resets_at": FUT},
    }, "plan": "Pro"})
a = m._usage_all_agy(now, force=False)
byk = {w["key"]: w for w in a["windows"]}
check("agy gemini 73% remaining -> 27% used", byk["gemini"]["used_pct"], 27.0)
check("agy claude/gpt 12% remaining -> 88% used", byk["claude_gpt"]["used_pct"], 88.0)
check("agy available", a["available"], True)
check("agy plan carried", a["plan"], "Pro")

# untouched family: no remainingFraction -> server defaults pct=100 -> 0% used
m._AGY_CACHE.update(ts=now, data={"models": {
    "Gemini 3 Pro": {"pct": 100, "status": "Ready", "resets_at": FUT}}, "plan": "Pro"})
a = m._usage_all_agy(now, force=False)
byk = {w["key"]: w for w in a["windows"]}
check("untouched family -> 0% used", byk["gemini"]["used_pct"], 0.0)
check("missing family stays None", byk["claude_gpt"]["used_pct"], None)

m._AGY_CACHE.update(ts=now, data={"error": "no live agy daemon"},
                    good={"models": {"Gemini 3 Pro": {"pct": 50, "resets_at": FUT}},
                          "plan": "Pro", "good_ts": now - 600})
a = m._usage_all_agy(now, force=False)
byk = {w["key"]: w for w in a["windows"]}
check("falls back to last good", byk["gemini"]["used_pct"], 50.0)
check("fallback age is the GOOD snapshot's", a["age_seconds"], 600)
check("fallback still reports the error", a["error"], "no live agy daemon")

# Refreshing one source must leave other sources cached.
from unittest import mock
seen = []
with mock.patch.object(m, "_claude_usage", lambda f: (seen.append(("anthropic", f)), {})[1]), \
     mock.patch.object(m, "_codex_usage", lambda f: (seen.append(("codex", f)), {})[1]), \
     mock.patch.object(m, "_usage_all_agy", lambda now, f: (seen.append(("agy", f)), {"windows": []})[1]), \
     mock.patch("core.agents.binary", lambda cli: True):
    m.app.test_client().get("/api/usage/all?refresh=codex")
    check("a press forces only its source", sorted(seen), [("agy", False), ("anthropic", False), ("codex", True)])
    seen.clear()
    m.app.test_client().get("/api/usage/all?refresh=true")
    check("refresh=true forces all three", sorted(seen), [("agy", True), ("anthropic", True), ("codex", True)])

print()
print(f"{len(fails)} failure(s)" + (": " + ", ".join(fails) if fails else ""))
sys.exit(1 if fails else 0)
