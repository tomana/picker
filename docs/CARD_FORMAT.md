# The card format

Cards belong to their producing project. Format changes use an explicit data conversion and matching code
update; readers use one format rather than live migrators.

## Where a card lives

- A **card store** is a folder named by a type's manifest (`cards`, relative to the manifest). A project may have
  several, such as `visual/cards/` and `music/cards/`. The picker
  finds the stores through the config's manifests and keeps no central one.
- A **card** is a folder `<store>/<id>/` holding `card.json`, `signals.jsonl` and `media/`. The id is the folder's
  name, and it is unique across every store the config names (a sync that would duplicate one is refused).
- **One writer per file:**
  - `card.json` and `media/`: the type's sync (the script that projects the project's research into its store),
    written atomically (a temp file, then a rename), so a reader never sees half a file.
  - `signals.jsonl`: the picker, append-only. It is the user's judgement and the one part no sync can rebuild.
    A sync creates it once, when it first projects a card (seeded with what the research already recorded, such as
    existing votes and comments), and never touches an existing one.
- `media/` holds relative symlinks into the project's research, or plain files the sync wrote (a thumbnail it
  made, a hand-made card's picture). Every path in `card.json` is relative to the card's folder.

## card.json

| field | type | what it is |
|---|---|---|
| `id` | string | the card's id, its folder's name |
| `type` | string | the manifest's id: `visual`, `music` or a fixture type such as `fx_show` |
| `label` | string | what the card is called |
| `name` | string, optional | a short name; the type's manifest says how it is shown (for example, `m:<name>`) |
| `created` | number | when it was made, Unix seconds |
| `created_from` | string | how `created` was found: `queue:<kind>`, `stack.json`, `version`, `first_signal`, `mtime`, `chat` |
| `agent`, `model`, `effort` | string or null | who made the first version, and with what; empty when not known |
| `origin` | object | where in the research it came from: `source` (below), `synced` (the last sync's time), `live` (still among the research's outputs, not in its own archive), and each type's own keys, unchanged: `kind` (`recording`, `scene_stack`, `show_run`), `job`, `from`, `span`, `chat` |
| `lineage` | object | where the card came from: `parent` (a card id or null), `refs` (card ids), `why` (text or null), `split` (`{card, version, ts}` when it was split off another card) |
| `narrative` | object | the agent's words about the card: `rationale`, and a type's own keys (`idea`; `source` as text, `chain`, `node`) |
| `media` | object | the newest version's `media`, copied: what the grid shows for the card |
| `versions` | list | the versions, oldest first (below) |

**`origin.source`** is a path relative to the folder that holds the type's research (the parent of its manifest's
`outputs` entry, so the research folder's own name leads): `runs/run_001` or `stacks/loop_001`. A card made by hand in a chat has no
`source`, and `chat: true`. The text `narrative.source` is something else: the agent's description of its material.

## A version

| field | type | what it is |
|---|---|---|
| `id` | string | the version's own name in the research (`v1`, or a folder's name, `v11`) |
| `n` | number | its place in the stack, from 1 |
| `created` | number | Unix seconds |
| `agent`, `model`, `effort` | string or null | who made it, and with what |
| `rationale` | string | the agent's account of this version |
| `source` | string, optional | this version's own place in the research, where it differs from the card's `origin.source` |
| `duration` | number, optional | seconds, for timed media |
| `media` | object | its files (below) |
| `parts` | list | what it is made of (below) |
| `notes`, `tags` | lists of strings, optional | the agent's notes and tags |
| `score` | object, optional | the version's one number, for a hybrid or a scored tab: `{name, value, lower_is_better, group, unit}` (`group`: scores on one scale are calibrated together by the votes; absent, the name alone; `unit`: what the number is in, `ms`) |
| `kept` | boolean, optional | a scored loop's try: the loop kept the change (true) or reverted it (false) |
| `measures` | object, optional | its other numbers, by name, shown beside the score |
| `doubts` | list of strings, optional | the research's own reasons the user's ear is wanted on it (two judges that disagree); each raises its need |
| `params`, `params_doc` | objects, optional | the knobs it was made with, and per knob `{unit, what}`: shown in the open card |
| `ab_at` | number, optional | where B starts in `media.ab`, in seconds |
| a type's own | | a sound type may use `method`, `settings`, `items` (takes, each `{id, name, label, parts}`), `face_item`; a show type may use `sections` (`{name, start, len}`); a fitted-sound type may use `family`, `variant`, `ab_gain_db`, `source_sample` |

## media

| key | what it is |
|---|---|
| `still` | the picture the grid and lists show (png, jpg or webp, any size: the grid asks the picker for a 360 px copy, `?w=360`). A version with a `poster` may leave it out: the grid then shows the poster's copy |
| `poster` | the full-size frame (1280×720) a video starts from, which the open card shows large |
| `gif` | a moving picture that plays by itself |
| `video` | a moving picture with a play button |
| `audio` | the version's mix |
| `ab` | an A/B: the reference (A), a gap, the version (B), at one gain, as one file — its `still` then shows that file on the same time axis; `ab_at` says where B starts (a type with `capabilities.ab`) |
| `reference` | what the version was made to match (the A of `ab`) |
| a type's own | a visual type may use `views` (`[{slug, still, gif}]`, alternate renders selected by the `face` signal) or `scene`; a show type may use `show` (JSON) and `timeline` (a picture) |

## A part

Every part has `kind` (`shader`, `voice` or `node`), `id`, `label` and `enabled`, and usually `group` (a number:
parts in one group play or draw together) and `src` (its source file in `media/`). A timed part has `time`:
`{start, len}` in seconds, plus `layer` (a node's), or `gain`, `fadeIn`, `fadeOut` (a voice's). Each kind adds its own:
- a **shader**: `mode` (its id in the renderer), `params` (its knobs), `puppet`, `skin`;
- a **voice**: `audio` (its file in `media/`), `peaks` (its waveform, base64);
- a **node**: `params`.

## signals.jsonl

One JSON object per line, appended, never rewritten: un-voting is a new vote, unarchiving a new `archive: false`.
Every line has `ts` (Unix seconds) and `kind`. A line may name what it is about: `version` (a version's `n`),
`voice` (a part's `id`, across the card's versions), `item` (a bundle's take, with `voice`). `by` says what wrote a
line written by a process, such as a sync's cull or AUTO. `agent` may identify an automated comment's author.

| kind | value | what it says |
|---|---|---|
| `vote` | integer | up or down; on the card, a version or a voice |
| `comment` | text | the user's words |
| `archive` | true or false | taken out (never deleted), or brought back |
| `face` | text | which of a version's `views` is the card's picture |
| `trim` | `{start, end}` or null | the part of a recording that is used; null is all of it |
| `pool` | true or false (`pool`: its name, `auto`) | in or out of an auto pool: what AUTO makes from (none marked: every active card) |
| `attach` | text | a file the user attached |
| `held` | none (`version`, `job`) | a version AUTO made with "keep in list until voted": out of the stack until voted up |

**What a reader outside the picker may take straight from this file:** one flag.
- **archived**: the value of the last `archive` line that names no `voice`. A line without a `value` means true. A card
  that isn't archived is **active**.

Everything else here — the votes on versions, voices and takes, the rating, the pools, which held versions are out of
the stack until voted up, the cuts — is the picker's to fold, in one place (`core/signals.py`). A project's own tools
read only the one flag; the runners get the rest with each job.
