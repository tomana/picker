# Making a type

A **type** is a project's kind of card, such as visual patterns or music loops. Each type has a tab, its agents
produce cards, and a human judges them. Cards remain in the project's store.

A type is four things, all in the project, wherever its research is (no layout is required), and its cards are the
project's too, in the store its manifest names:

| part | file | what it does |
|---|---|---|
| the manifest | `picker-type.json` | says what the type is, what it can do and where its other parts are |
| the runner | `queue_runner.py` | claims the type's jobs from the picker's queue and has an agent make the cards |
| the sync | `sync.py` | projects the project's research into the card store, in the card format |
| the plugin (optional) | `picker_plugin.py` | the type's own server code: its routes, AUTO's hooks, its split |

The picker finds a type through its config: `picker.toml`'s `types` lists each manifest by path, in tab order.

## The manifest

Paths are relative to the manifest. Format changes require an explicit data conversion and matching code update;
there is no live compatibility layer.

| field | | what it says |
|---|---|---|
| `type` | required | the type's id (`music`), unique across the config |
| `label`, `short` | required | the words the page uses: the tab's, and AUTO's (a short tab label) |
| `about` | required | one sentence: what one card is |
| `kind` | required | `picked`, `hybrid` or `scored`: what kind of autoresearch the tab is — the human judges every card; a score does the work and asks the human where it can't decide; or the score keeps or reverts each try, and the tab shows the tries best first (its newest version's `score`) |
| `researcher`, `start` | required | the runner's file, and the command that starts it: `["uv", "run", "--with-editable", "{picker}", "queue_runner.py", "--agent", "claude"]` (`{picker}` is the running picker's own tree, `{python}` its interpreter) |
| `agents` | required | the agent CLIs it may run, the default first; `sweep` is a parametric path, not a model |
| `program` | required | the instructions file the agents read |
| `outputs` | required | the research folders its runner writes |
| `cards` | | its card store (`../../cards/modes`); several types may share one, as their cards' ids differ. Its project logs sit there too (cup rounds, timelines, AUTO's survey). Absent: the config's `data/cards` |
| `sync` | | `{"argv": ["{python}", "sync.py"], "cwd": "."}`: its sync script; absent: the runner writes its cards itself |
| `plugin` | | its plugin module (below) |
| `lanes` | | `"by_agent"`: a runner per agent, so jobs for different agents do not block each other; absent: one job at a time |
| `methods`, `default_method` | | the ways a job can be done (for example, `bundle`) |
| `name_prefix` | | its cards' short names are shown as `<prefix>:<name>` (for example, `m:loop1`) and work wherever an id does |
| `survey_tools` | | commands AUTO's survey agent may run (for example, timing tools) |
| `capabilities` | | what its cards can do in the page (below) |
| `auto_placeholder` | | copy for `auto: "placeholder"`: `{title, summary, description, tooltip}` for the sheet heading, panel line, sheet body and panel hover text; omitted fields use generic defaults |

### Capabilities

The page shows a control only when the type says it can; the server asks the same. Nothing in the picker tests a
type's id.

| capability | value | what it turns on |
|---|---|---|
| `auto` | `revise`, `placeholder` | the tab's AUTO (core/auto, one engine on every tab: revise and/or inspire from its auto pool); a sheet that says what is planned |
| `add` | `idea`, `recording`, or a list of these | *+ Add idea* (a seed from words), *+ Add recording*, or both |
| `upload` | a URL | where an `add` containing `recording` posts the file (multipart `file`): its plugin's route, which makes the recording card |
| `split`, `duplicate`, `merge` | `true` | a version taken out into a new stack, copied, or stacks put together: the plugin's functions of those names |
| `timeline` | `true` | the composition timeline leads the tab |
| `hears` | `true` | the open card says what a send would hear (the plugin's `hears`), and a sent job keeps it |
| `panel` | a URL | the type's own panel in AUTO's place: an ES module its plugin serves, whose `mount(hooks)` returns `{el, pause, refresh, busy}` (for example, an audio player) |
| `vote_count` | `true` | "7 / 18 voted" on the version row |
| `images` | `false` | no image button on the open card |
| `ab` | `true` | the A/B on the small and the open card (`static/app/parts/ab.js`): a version's `media.ab` (the version, a gap, the reference, one file: the version is heard first) and its `still` on the same time axis, shown as two boxes split at `ab_at`, each with its slice of the picture and a ▶ that plays that half; a small card's bottom row plays the whole between the stack's ‹ ›, and the open card hangs ▶ A and ▶ B under − +. The version's score, measures, doubts and parameters show in the open card's text |
| `need` | `true` | the tab is ordered by need, the cards that want the user's ear first (`core/signals.need`, from the versions' `score` and `doubts` and the votes; on the list, on a card's read and after a signal, so the open card's reasons follow a vote); a reload keeps the order on screen, so a vote doesn't move a card. For a hybrid tab |

## The runner

The picker starts it (`start`, in the runner's folder) when a job is queued or due, in its own systemd scope, and it
exits when nothing is left to claim. It gets the picker as a package — `from picker import sdk` — through
`uv run --with-editable {picker}`, never by putting the picker on its path. By hand, from its folder:

    uv run --with-editable <picker> queue_runner.py --agent claude      # <picker>: this repository

`--dry-run` belongs to the isolated harness, not a working queue. A runner must accept that flag and skip
agent/render work in its dry path; the SDK still exercises sync. The harness alone supplies `PICKER_DRY_RUN`.

What it may use is the SDK, and nothing else of the picker (`picker/sdk.py` lists it): `sdk.drain(type, agent,
work, here, …)`, the shared runner half that claims the type's jobs until none is left; the agent layer
(`sdk.run_job`, `sdk.names`, `sdk.choice`, the `Agent…` exceptions, `sdk.Deferred` to make a job wait); the brief's
parts (`sdk.note_line`, `sdk.attempt_note`, `sdk.version_note(job)`, `sdk.attachment_note(job, base)`, …); the
preflights (`sdk.need_exe`, `need_path`, `need_writable`); `sdk.emit` for the trace; `sdk.runner` for a loop's
runner.json.

**The job comes with its context** (`sdk.context(job)`): the card's versions with their votes and hidden marks, the
base to build from, the images on the card and with the request, and the files of a frozen cut — resolved by the
picker from the one fold when the job is claimed. A runner never opens the card store, nor re-implements a vote rule.

**The work says what it made** (the result contract): `work(job, report)` returns a list of refs, from the type's own
research, never from the store — `{"card": id, "version": id}` (a version it made), `{"card": id}` (a card it made or
grew), or `{"part": id}` (the version that holds a part it wrote, for a sync that files parts as versions). The picker
syncs, finds each in the store (a ref the store doesn't hold after the sync fails the job), records them, stamps
the new cards with what they were based on, and names the result. A seed, revise or inspire that names nothing
fails; a retry that finds its work already there names it again and makes no second card.

## The sync

`sync.py` turns the project's research (its runs, its stacks) into cards in the store, in the card format
(`CARD_FORMAT.md`), every time a job ends and whenever a runner publishes mid-job. The picker runs it with the
picker's tree on `PYTHONPATH`, one at a time per type (a lock in the picker's state), and fails the job if it fails.

- It takes the SDK and its helper: `from picker import sdk, links` (`links.place` writes a relative media link
  atomically). It writes into
  `sdk.store(TYPE)`, its type's store.
- It is idempotent: run twice, it writes nothing new the second time.
- It writes `card.json` and `media/`, never an existing `signals.jsonl` (the user's judgement): it may create
  one, seeded with what the research already recorded, when it first projects a card.
- It writes `card.json` atomically (a temp file, then a rename), so no reader sees half a file.
- By hand on scratch data, from its folder: `PYTHONPATH=<picker> python3 sync.py`. A dry flag is type-specific;
  only use it if that sync implements it.

## The plugin

`picker_plugin.py` is loaded once by the server (a change to it needs a picker restart). Every hook is optional:

| hook | when |
|---|---|
| `routes(S)` → blueprints | the server starts: its HTTP routes, registered as they are |
| `start(S)` | the scheduler starts |
| `split(card, k, S)`, `duplicate(card, k, S)`, `merge(cards, S)` | what a version is in its research; the picker does the checks, the sync, the votes following their versions and the auto pools |
| `hears(card, job, S)` | a send is about to be queued, or the open card asks |
| `auto_text(kind)` | AUTO's first words to a job of this type (else core's) |
| `auto_eligible(card, kind)` | whether AUTO may make `kind` from the card (else: a recording only inspires) |

`S`, the services, is the plugin's only way into the picker: `config`, `stores` (`card_dir(id)`, `cards()`,
`of_type(type)`: core/stores.py), `research`, `state`, `queue`, `prefs`, `signals`, `trace`, `jsonl`, `arrange`,
`auto`, `gate`, `sync`, `sync_lock`, `Refused` (raise it with the reason the user reads), and what the server
provides: `read_card`, `cut_audio`, `safe`, `start`, and once the scheduler runs, `cards` and `usage`. A plugin never imports `core`. A plugin of several files loads its own parts by path, as
a multi-file plugin can do.

Server extensions not tied to a type are listed in the config's `plugins`.

A downloads plugin can serve `GET /api/downloads/app` to enable the phone-app row in settings. It returns
`{app: {id, name, description, publish}, apk}` even when no build exists (`apk: null`). `publish` is a displayed
command/path, never executed by the page. A build supplies `version`, `sha`, `size`, `mtime`, `behind`,
`uncommitted`, `dirty_build`, download `url` and filename `name`; settings uses these for freshness and download.

## Adding a type, in order

1. The runner and its instructions (`program.md`), beside the research it writes.
2. `sync.py`, projecting that research into the card format; check it on a scratch store.
3. `picker-type.json`: the fields above, the capabilities the cards need.
4. A line in `picker.toml`'s `types`, then restart the picker through the gate (`picker/tools/gate.py`).
5. Only if the type needs server code of its own: `picker_plugin.py`, named by the manifest's `plugin`.

A project checks its types on the picker's harness with a suite of its own (`tests/move_check.sh --suite <dir>`,
tests/README.md): every type of its config gets a fake researcher on a made-up store and its real runner a dry run,
and the suite's own checks run there. One type not in the config yet: `tests/move_check.sh --with <manifest> --dry`.
The harness copies `examples/*` itself; do not pass the same type again via `--with`. When contributing an example,
stage that new folder outside `examples/` for this check, then restore it for the browser check.
