# The examples

Two kinds of card the picker can be set up for, each a small project of its own — what any project adds to use the
picker (`docs/TYPES.md`): a manifest, a runner, a sync and the instructions its agent reads.

| folder | the tab | a card | kind |
|---|---|---|---|
| `visual/` | `picked` | a moving pattern drawn from a few numbers (`draw.py`) | **picked**: no score; you judge every card |
| `music/` | `hybrid_two` | a two-bar loop of a few voices written as notes (`synth.py`); its seed: three recordings, and a loop over each | **hybrid**: each loop gets a score, *clash*, and the tab puts first the loops that want your ear |

Both are made by **the fake agent**: no model and no login. A job's brief goes to the project's own `fake_agent.py`,
which writes what the brief asks for the same way every time. So the examples run on a computer with no agent CLI. To
use a real agent, select an installed and authenticated CLI when sending a job; it reads the same `program.md`.

The files in `music/recordings/` are recordings of the author's. Put your own wav, mp3, m4a or flac files beside
them before seeding: the files come first, and made-up recordings fill up to three. A recording may bring the loop
that goes over it, `<name>.loop.json` (a loop as `music/program.md` describes it, plus the `span` of the recording it
sits on); without one, the fake agent makes it.
Or use **+ Add recording**, trim a stretch, then **make a card**: the loop keeps that stretch beneath its synth voices.

## Run them

From the picker's folder:

    uv run server.py --config examples/picker.toml

Then open http://127.0.0.1:8080 and press *+ Add idea*: the fake agent makes a card. To start with a few to look at:

    cd examples/visual && uv run seed.py 8
    cd examples/music && uv run seed.py

The music seed makes a card of each recording and a loop over each; a number adds that many loops of its own.

## What each folder holds

| file | what it is |
|---|---|
| `picker-type.json` | the manifest: the tab's name and kind, the runner, the sync, the agents it may run |
| `program.md` | what the agent reads: what a card is, and how to make one |
| `queue_runner.py` | works the picker's queue: asks the agent for one file, draws or plays it, says what it made |
| `fake_agent.py` | the fake agent's answer for this tab |
| `sync.py` | puts the work (`runs/`) into the card store (`cards/`), as the picker reads cards (`docs/CARD_FORMAT.md`) |
| `seed.py` | a few cards to start from |
| `draw.py` / `synth.py` | the picture, or the sound and its score |
