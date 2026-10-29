# Checks

Browser checks use the generated fixture picker, never the production store. Python tests use temporary configs.

```bash
cd tests && npm install
./quick.sh
./move_check.sh
./move_check.sh t09 fx05
./move_check.sh --with <dir>/picker-type.json --dry
./move_check.sh --serve
./move_check.sh --suite <project>/tests
```

`quick.sh` selects checks for changed files through `affects.py`. `move_check.sh` creates the fixture store and
runs syntax-independent behaviour checks in a sandbox. `--serve` leaves that fixture available for inspection;
`--with` adds a manifest, and `--dry` checks its runner without an agent. A project-specific `--suite` supplies
`fixture.py` (`KINDS`, `extra()`, `DRY_JOBS`, `HIDDEN`), browser checks and Python checks.

## Real agents

`agents_matrix.py` runs the installed agent CLIs through a copy of the examples on a spare port, restricted and then
unrestricted: a seed, revisions with a chosen model and with the ⚙ model, a refused agent handed to another,
pause and resume on another model, AUTO with and without a criterion, the session cap and the wiring check. Each case
is judged by what ran (the trace's command line and the version it made), not by what was asked. It uses the cheapest
models it finds but still spends quota, so it is not part of `move_check.sh`.

```bash
uv run --no-project python tests/agents_matrix.py [--agents claude,codex] [--only R2,U3] [--keep]
```

## Isolation

The fixture uses generated pictures, sounds and shows, plus the runnable examples. Tests pass a config explicitly;
Python tests import `py/_cfg.py` before project modules. The sandbox hides production stores, state, caches,
credentials and declared research outputs. Only its work directories and designated caches are writable.

Browser checks require `PICKER_URL` and refuse port 8080 because they write. Do not start a second server on a
service's port: use a separate config and port, or restart the existing service through the maintenance gate.

`withPage` in `lib.mjs` intercepts writes unless a check explicitly routes them to a fixture. Checks never trim or
restore existing logs, so concurrent user input cannot be erased by cleanup.

## Adding a Browser Check

Create `tNN-something.mjs` exporting `name` and `run(log)`. Throw to fail and log measurements that help explain
future regressions. Keep fixture media deterministic and use the sandbox for checks that need real writes.
