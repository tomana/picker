---
name: picker-type
description: Add or adapt a project's picker tab, including its manifest, card projection, capabilities and optional plugin.
---

# Add a tab

Paths below are relative to the picker checkout. Read [docs/TYPES.md](../../docs/TYPES.md) for the manifest and hooks,
[docs/CARD_FORMAT.md](../../docs/CARD_FORMAT.md) for stored cards, and [examples/README.md](../../examples/README.md)
for runnable starting points. Keep project code and cards outside the picker's implementation.

1. Decide what one card and one version mean. Choose `picked` when a person judges the work; `hybrid` when a score
   orders work that still needs judgement; `scored` when the research loop keeps or rejects tries by score.
2. Copy the closest example into the project: [examples/visual](../../examples/visual) for pictures or other picked
   work; [examples/music](../../examples/music) for sound, scores and recording-derived work. Replace its content
   generation, ids and `TYPE` constants together. Keep the card's media in formats the page already displays.
3. Write `program.md`: the output format, allowed tools, where to write, and what seed, inspire and revise mean.
   Adapt the runner through [picker/sdk.py](../../picker/sdk.py), not imports from `core`. Keep a local
   `fake_agent.py` for repeatable, no-quota checks; `tools/fake_agent.py` delegates to it in the runner's cwd.
4. Adapt the sync to publish research as cards with globally unique card ids, stable version ids and relative
   media links. Publish `card.json` atomically. Repeating a sync must not change the result; never overwrite
   existing `signals.jsonl`. The sync writes the configured `sdk.store(TYPE)`, not a guessed folder.
5. Set `picker-type.json`: unique `type`, readable `label`/`short`/`about`, `kind`, `researcher`, `start`, `agents`,
   `program`, `outputs`, `cards`, and `sync`. Paths are relative to the manifest; `{picker}` and `{python}` are
   expanded by the picker. The runner command needs `uv run --with-editable {picker}` to import the SDK.
6. Declare only working capabilities. `add: "idea"` enables seeds; `add: "recording"` also needs an `upload` route;
   `add: ["idea", "recording"]` enables both. `auto: "revise"` enables AUTO; `need: true` orders hybrid cards for
   judgement. Use the capability table for `panel`, `hears`, `ab`, timeline and part operations. Add a plugin only
   for required routes or hooks; it receives services through `S`, never imports `core`. Recording uploads can
   start from the music plugin; preserve `origin.kind`, `lineage.parent` and `origin.span` for the original row.
7. Add the manifest to the intended `picker.toml`'s `types`. Config paths are relative to the config, manifest paths
   to the manifest. Use separate data/state/cache and a free localhost port for a trial; never another instance's
   store or port. Leave AUTO off and choose the fake agent until real work is authorized.
8. Check the new type on scratch data. From the picker checkout:

   ```bash
   tests/move_check.sh --with /absolute/project/picker-type.json --dry
   ```

   The harness already copies `examples/*`; do not also pass an example via `--with`. For a new example,
   stage its folder outside `examples/` for this check, then restore it before testing the page.
   It uses temporary directories and a blocked production-port probe. If the task forbids those attempts or paths,
   use equivalent fake-only checks within the allowed scratch space instead; do not relax the task's limits.
   The runner must parse `--dry-run`; only the harness supplies `PICKER_DRY_RUN`. In that path, skip agent/render
   work and return no refs, allowing the SDK to exercise sync. A harness dry pass is wiring evidence, not proof a
   card was made. Do not run that flag against a working queue or set the harness variable to bypass the guard.
   Then start a disposable picker with an explicit config and unused non-8080 port, submit a fake seed and revise,
   and verify the tab, Add idea, result card, media URLs and selected version in the browser. See
   [tests/README.md](../../tests/README.md) for the harness; stop only the trial processes you started.
