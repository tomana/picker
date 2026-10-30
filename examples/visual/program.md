# visual — a pattern from a few numbers

A card here is one **pattern**: a moving picture drawn from a handful of numbers by `draw.py`. Each version of a card is
one change to its numbers. The person at the picker looks at the patterns and votes; there is no score (this tab is
*picked*).

## What a pattern is

One JSON file, `pattern.json`:

| key | what it is |
|---|---|
| `name` | a few words: what the pattern looks like (the card's name) |
| `why` | one sentence: what this version changed, and why |
| `shape` | `rings`, `bands` or `spiral` |
| `count` | how many rings, bands or arms: 2 to 14 |
| `twist` | how much they turn as they go out: −3 to 3 |
| `warp` | how much they wobble: 0 to 1 |
| `speed` | how fast they move: 0.25 to 2 |
| `colors` | two or more colours, dark to light, `["#050505", "#4a4a4a", "#f0f0f0"]` (two blend, more are stops along the way), or `"orig01"`: a hue wheel |

## How to make one

The brief names the file to write, and the pattern to build from when there is one. Write that one file and nothing
else; the runner draws it (a still and a gif) and the picker shows it.

- A **new** card: start from nothing, from the person's words if they gave any.
- A **revise**: the same pattern, taken further or fixed — change one or two numbers, not all of them.
- An **inspire**: a new pattern that keeps something of the one named.

Say in `why` what you changed. Keep every number in its range.
