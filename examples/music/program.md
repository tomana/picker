# music — a loop from a few voices

A card here is one **loop**: two bars of two to four voices, written as notes and played by `synth.py`. Each version of
a card is one change to it. The tab is *hybrid*: each loop gets a score, **clash** — how much the notes that sound
together rub (seconds, tritones, sevenths; 0 is none, lower is better) — and the picker puts first the loops that want
the person's ear: a clash worse than the loops they voted up, or a doubt the score can't settle. The ear decides.

## What a loop is

One JSON file, `loop.json`:

| key | what it is |
|---|---|
| `name` | a few words: what the loop sounds like (the card's name) |
| `why` | one sentence: what this version changed, and why |
| `tempo` | beats a minute: 60 to 160 |
| `voices` | two to four voices, each below |

A voice:

| key | what it is |
|---|---|
| `name` | its part: `bass`, `pad`, `lead`, `click`… |
| `wave` | `sine`, `saw`, `square` or `noise` |
| `notes` | 16 steps (two bars of eighths): a MIDI note number (36 to 96) or `null` for a rest |
| `decay` | how long a note rings, in seconds: 0.03 to 2 |
| `level` | how loud: 0.1 to 1 |

## How to make one

The brief names the file to write, and the loop to build from when there is one. Write that one file and nothing else;
the runner plays it, scores it and the picker shows it.

- A **new** card: start from nothing, from the person's words if they gave any.
- A **revise**: the same loop, taken further or fixed — change one voice, not all of them.
- An **inspire**: a new loop that keeps something of the one named.

When the brief names a recording and seconds, use that stretch as the musical starting point. Write only the
loop's synth voices; the runner cuts or repeats that audio under them as a `rec` lane, without changing the clash score.

Say in `why` what you changed.
