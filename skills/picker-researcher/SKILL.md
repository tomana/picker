---
name: picker-researcher
description: Implement or change a project's picker runner, its job brief, SDK execution and explicit result publication.
---

# Implement a runner

Use [picker/sdk.py](../../picker/sdk.py), [docs/TYPES.md](../../docs/TYPES.md) and the runner/sync pairs in
[examples/visual](../../examples/visual) or [examples/music](../../examples/music). They are the maintained contracts;
do not import `core` or implement another queue, vote fold, retry loop or process supervisor.

1. Define research outputs before the store projection. A `seed` makes a new card; `inspire` makes a new card from
   a parent; `revise` adds a version to the same card. `sdk.drain` handles claiming, locks, ping/survey dispatch,
   publication checks and outcomes. Let it exit when no work is claimable.
2. Resolve the selected base with `sdk.context(job)["base"]` or `sdk.version_votes(job)`. `job.version` is the
   numeric version on screen, not an array offset; the resolved base has its research `id`. Read that output,
   not whichever version is newest. Without an explicit version, use the SDK's base selection.
3. Interpret only fields the type supports: `text` is this request; `trim` is `{start, end}` in seconds;
   `recording` identifies source material when supplied. Music also recognizes a recording through the card's
   research metadata. Use frozen request fields, not a recording's later UI trim. Attachments arrive as stored
   names; use the context's `requests`/`attachments` paths or `sdk.attachment_note`, not guessed paths.
   `count` asks for multiple results in one job; honor it in the output plan as well as the prompt.
4. Build a brief with an exact output target, base path, source seconds and `program.md`. Use `sdk.note_line`,
   `sdk.version_note`, `sdk.attachment_note` and `sdk.attempt_note`; the last includes count and continuation
   context, so do not also append `sdk.count_note`. Never treat an earlier rationale as the current request.
5. Execute the chosen agent and validate/render its output before returning refs:

   ```python
   agent = sdk.agent_for(job, default_agent)
   sdk.run_job(agent, brief, here, here / "logs" / f"queue_{job['id']}.log",
               model=job.get("model"))
   ```

   Use `sdk.run(argv, cwd=..., log=..., deadline=...)` for child tools; its deadline is an absolute epoch time,
   and a nonzero `result.exit` needs handling. Agent calls already record receipts. Wrap significant tool steps
   in `with sdk.receipt("tool", inputs=..., files=[...]):` when their inputs need an audit trail.
6. Publish complete research outputs with `origin.job` provenance available to the sync. Return refs from
   `work(job, report)`, for example `[{"card": cid, "version": "v2"}]`; the version id is not its numeric `n`.
   Card-only and part refs are also supported; see the result contract in docs/TYPES.md. The SDK records refs
   before sync, validates that the store holds them, and finishes the job. Do not report success by scanning the
   store for changes. For mid-job publication, sync complete output then call `sdk.published(job, refs)` and still
   return all refs at the end. Do not call `sdk.sync` while holding `sdk.sync_lock`.
7. Make retry behavior explicit: preserve completed outputs, name them again rather than duplicating them, and
   resume partial research. Let `AgentLimited` reach the SDK so usage waits release the lane. Use `sdk.Unchanged`
   only for a valid search with no improvement; missing required output is `sdk.NothingMade` or another error,
   not a successful empty result. Never turn exceptions into empty success refs.
8. Test through the local fake agent on a disposable config/store. Add an argparse `--dry-run` flag if absent;
   inside that harness-only path skip agent/render work and return `[]` so sync is still exercised. Run
   `tests/move_check.sh --with /absolute/project/picker-type.json --dry`, then a real fake-agent job on a free
   non-8080 port. Do not pass a type already under `examples/` via `--with`; the harness copies examples itself.
   The harness uses temporary directories and a blocked production-port probe; when these are outside the task's
   limits, use equivalent scratch-only checks, not relaxed limits. For a standalone trial, adapt
   `examples/picker.toml` with all paths rebased to that config, then run `uv run server.py --config <config>
   --host 127.0.0.1 --port <free-port>` and set `PICKER_URL` to that instance for HTTP requests.
   Check seed, inspire, a revise of an older on-screen version, empty text and count if supported;
   verify actual output and result refs, not just a zero runner exit. A dry pass alone does not prove generation.
