---
name: picker-ops
description: Install, run, inspect or maintain a picker instance, including its config, queue, agents, private phone access and safe restarts.
---

# Run the picker

Use [README.md](../../README.md) for installation, [examples/picker.toml](../../examples/picker.toml) for config,
[docs/TYPES.md](../../docs/TYPES.md) for runners, and [tests/README.md](../../tests/README.md) for checks.

1. Identify the checkout, explicit config, intended port and whether this is a trial or a working instance.
   Config paths resolve against the config file: data, state, cache, agents, research and manifest `types`.
   Never let a trial fall back to a user's default config. Use disposable stores and an unused localhost port,
   not 8080 or another running instance. Do not enable AUTO or invoke real agents without authorization.
2. Install the README prerequisites. Start the examples from the checkout, overriding the README's default port:

   ```bash
   uv run server.py --config examples/picker.toml --host 127.0.0.1 --port 8765
   ```

   Set `PICKER_URL=http://127.0.0.1:8765` in the shell making HTTP/gate requests, matching the chosen port.
   Replace 8765 if occupied. For a trial, also isolate HOME/XDG config and use fake-only agent settings so startup
   usage discovery cannot consult real accounts. Record the PID and retain stdout; stop only processes you start.
   Confirm `/api/types` and the page load before queueing. The scheduler wakes due jobs; give it time to claim.
3. For a persistent Linux instance, adapt this systemd user unit to actual paths and a free port. Install/enable
   it only when requested; do not install a service for a scratch trial.

   ```ini
   [Unit]
   Description=Picker
   [Service]
   WorkingDirectory=%h/src/picker
   Environment=PICKER_URL=http://127.0.0.1:8765
   ExecStart=%h/.local/bin/uv run server.py --config %h/.config/picker/picker.toml --host 127.0.0.1 --port 8765
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```

   A requested installation uses `systemctl --user daemon-reload` and `systemctl --user enable --now picker.service`.
   A user service inherits a different PATH from a terminal; ensure uv and agent CLIs are available there.
4. Real agents require subscription logins in Claude Code (`claude`), ChatGPT/Codex (`codex`) or Antigravity (`agy`).
   API keys and pay-per-use accounts are unsupported: unattended work bills per token, while usage bars and caps
   read only subscription windows. Keep API keys out of the environment entirely. The picker filters known API
   credentials and cloud-provider selectors from children; wiring warns with variable names, never their values.
   Stored CLI configuration is not rewritten: do not configure API-key logins or alternate paid providers there.
   Agents are restricted by default. Only a top-level `unrestricted_agents = true` in the intended config enables
   the unrestricted CLI modes; an agent without a verified unattended restricted mode refuses to start. Settings
   shows the mode and any refusal. Do not enable this opt-in merely to get a test past a denial.
   In settings, inspect discovered models and run the wiring check: it can invoke agents, so it is not a free
   status request. Usage bars reflect CLI account limits, may be cached/unavailable, and do not prove quota is
   available. The examples' `fake` agent requires neither an account nor model quota.
   Each row's session cap holds new work at its percent of account-session usage; unknown capped usage holds too.
   It never stops running jobs. Off (100%) does no admission usage reads; investigate its wait reason rather than
   increasing the cap automatically. Polls use the usage-bar CLI readers and adapt within 30 seconds to 10 minutes.
5. Before a requested restart or maintenance, point the gate tool at this exact instance:

   ```bash
   export PICKER_URL=http://127.0.0.1:8765
   python3 tools/gate.py close maintenance && \
     python3 tools/gate.py wait 900 && systemctl --user restart picker.service
   ```

   A timeout means stop and inspect, not force a restart. Closing blocks starts/claims, not queueing or ongoing
   work. After the restarted `/api/types` responds and the intended config is verified, run
   `python3 tools/gate.py open`. Leave it closed on failure; never delete its state to bypass the check.
6. Queue only authorized work. For a disposable examples instance, these requests use the no-quota fake agent:

   ```bash
   curl -fsS "$PICKER_URL/api/types"
   curl -fsS "$PICKER_URL/api/queue" -H 'Content-Type: application/json' \
     -d '{"type":"visual","kind":"seed","text":"slow rings","backend":"fake"}'
   curl -fsS "$PICKER_URL/api/queue/JOB_ID"
   ```

   Substitute the returned job id. Poll with a bounded timeout; `done` should name a result card you can fetch at
   `/api/cards/CARD_ID`. For revise, send the card id and numeric `version` on screen; include `trim` when relevant.
   Do not repeatedly enqueue a stuck request. Watch it in the queue UI or GET its `/log` subroute.
7. For private phone access, with Tailscale on both devices, use `tailscale serve --bg 8765` for this port and its
   HTTPS tailnet URL, and add that host name to `[server] names` in the config (then restart): the picker refuses
   requests that don't name it. This changes network configuration: do it only when requested. Never use
   `tailscale funnel`; picker has no login. Keep the server on localhost and restrict access to trusted devices.
8. Diagnose before intervening: GET `/api/gate`, `/api/queue?open=1`, `/api/queue/JOB_ID` and its `/log`.
   Check `journalctl --user -u picker.service`, the runner's `logs/queue_runner*.log` and `logs/queue_JOB_ID.log`,
   config data's `trace.jsonl` and `receipts/`. Waiting usage jobs resume when due; paused jobs need resume;
   failed jobs need their cause fixed before retry. Disable AUTO before investigating unwanted new work.
   Use the job's pause/cancel/retry UI or API, not edited JSONL, deleted locks or broad process kills. A quiet runner
   exiting when its queue is empty is normal; runners can outlive server restarts.
9. After code changes, `tests/quick.sh` selects checks and `tests/move_check.sh` runs the isolated harness
   (or select check names). Never aim write checks at a working instance. For a scratch shutdown, stop new work,
   wait for jobs and runner processes to finish, then terminate your recorded server PID and verify its port closed.
