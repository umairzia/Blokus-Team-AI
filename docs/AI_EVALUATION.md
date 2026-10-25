# AI evaluation

How the three AI levels compare, measured with the harness in
[`scripts/ai-eval.ts`](../scripts/ai-eval.ts). Raw results (every game) are in
[`docs/ai-eval/`](ai-eval/).

## Method

- **Paired seeds.** For each seed, a short random opening is generated (each
  seat's first move is a random pentomino placement covering its corner, 4
  plies in total) and the game is played **twice** from it: once with level A
  as team 0 (seats 0 and 2, who move first) and once as team 1. Pairing
  cancels out first-move advantage and opening luck.
- **Full games.** Every game is played to the end with the real rules engine;
  the result is the team score (sum of the two seats' standard Blokus scores).
- **Statistics.** Game score rate (win = 1, draw = ½) with a normal-approximation
  95% interval; the mean score margin per pair (A minus B, averaged over the
  two games of the pair) with a 95% interval; and an exact two-sided sign test
  over pairs (pairs with a zero margin are left out).
- **Deterministic.** Given the seeds, every result is reproducible. Commands:

```bash
npm run ai:eval -- --a hard   --b normal --pairs 100 --seed 10000
npm run ai:eval -- --a normal --b easy   --pairs 100 --seed 20000
npm run ai:eval -- --a hard   --b easy   --pairs 50  --seed 30000
```

## Results (recorded 2026-10-25)

| Matchup (A vs B) | Games | A wins / draws / losses | A score rate (95% CI) | Mean paired margin, points (95% CI) | Pairs won / lost by A | Sign test p |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hard vs Normal | 200 | 175 / 4 / 21 | 88.5% (84.1–92.9%) | +16.3 (+14.1 to +18.6) | 95 / 5 | 1.3 × 10⁻²² |
| Normal vs Easy | 200 | 156 / 6 / 38 | 79.5% (73.9–85.1%) | +10.9 (+8.7 to +13.1) | 87 / 10 | 1.8 × 10⁻¹⁶ |
| Hard vs Easy | 100 | 96 / 0 / 4 | 96.0% (92.2–99.8%) | +28.8 (+25.5 to +32.1) | 50 / 0 | 1.8 × 10⁻¹⁵ |

Seating made little difference: Hard beat Normal in 87/100 games as team 0
and 88/100 as team 1.

**Thinking time** (Node 22 on the 4-core build machine, one thread per game):
Hard averaged about 20 ms per decision (about 0.7 s for both Hard seats over a
whole game), with a slowest single decision of 120 ms; Normal about 1 ms per
decision; no decision reached its time cap. Browsers on phones are slower, which
is why the AI runs in a Web Worker and Hard has a 2.5 s safety cap.

## What the results support

Within this experiment, **Hard is stronger than Normal, and Normal is stronger
than Easy**, by large and statistically clear margins. Hard also beats Easy in
every one of 50 pairs.

## Limitations

- **AI against AI only.** Nothing here measures play against people.
  Humans may find the levels easier or harder than these numbers suggest.
- **Hard models its opponents as Normal.** Hard's one-round look-ahead assumes
  every other seat answers with Normal's best move. Against Normal that model is
  exactly right, which probably inflates the Hard-vs-Normal margin. The
  Hard-vs-Easy result (where the model is wrong) suggests the advantage is
  real, but the size of the edge against other kinds of players is unknown.
- **Limited opening diversity.** Openings differ only in the first random
  pentomino of each seat; after that the AIs are deterministic (Easy adds
  seeded noise). The 100 pairs are therefore not 100 fully independent
  samples of Blokus play.
- **One tuning.** The evaluation weights were set by hand with a few small
  trial runs; they are not optimised, and these runs were not repeated on
  other machines.
- **Timing depends on hardware.** The time cap only matters on slow devices;
  if it ever cuts a Hard search short, that move is weaker than in these runs.

## How the levels work

All levels choose only from the rules engine's list of legal moves, and pass
only when that list is empty; the chosen move is validated again with the
same function that checks human moves.

- **Easy:** piece size plus the number of its own corner anchors (squares
  where it could start a piece next), plus seeded random noise. It ignores the
  other three seats.
- **Normal:** a team evaluation of every legal move: squares placed, corner
  anchors and territory (empty squares a seat can reach before anyone else,
  from a simultaneous flood fill) for the AI team minus the human team.
  Blocking opponents and not smothering the teammate both follow from that
  sum. It keeps the monomino for last when it can (+5 bonus). To stay fast,
  all moves get an exact cheap score (anchor changes computed locally) and the
  best 30 get the full evaluation with territory.
- **Hard:** takes Normal's 10 best moves and plays each one forward for a full
  round (opponent, teammate, opponent, each answering with its best Normal
  move), then judges the resulting position with Normal's evaluation plus real
  mobility (the square root of each seat's number of legal moves, teammate
  counted for, opponents against). Work is bounded by counts (10 candidates,
  one round), with a 2.5 s wall-clock cap as a safety net.

Unrestricted minimax is not feasible (hundreds of legal moves per turn, four
players); this bounded look-ahead with candidate filtering was chosen because
it is cheap enough for phones and measurably stronger than one-ply play.
