# Tetris (`tetris`)

[← README](../README.md) · [Match rules](match.md)

| Item | Implementation |
|---|---|
| Board | 10×20, no hidden rows; pieces spawn in row 0 |
| Pieces | 7-bag from the seed, identical on every side |
| Rotation | SRS clockwise with wall kicks; `blocked` when no kick fits |
| Actions | `L` left, `R` right, `U` rotate clockwise, `D` down one row, `S` hard drop |
| Step | Apply the action → gravity once (down one row); lock if it can't move. `S` hard-drops and locks, no gravity |
| Step limit | A piece not locked after its 30th step is hard-dropped (also when no input matters, see End) |
| Scoring | 1/2/3/4 lines = 100/300/500/800, fixed level 1, no drop points |
| End | Top out when a new piece's spawn is blocked; a side stops after M pieces; the game ends when all sides stop. If every reachable placement ends the game (top out or the M-th piece) with the same lines cleared, no input can change the score, so the piece is hard-dropped that step (logged as auto-drop) and the game ends |

Unspecified in the original spec:

- **First step** `Last action` is `none`; after illegal output, `invalid output (no-op)`. A new piece carries over the previous result (usually `S (ok)`).
- Gravity still applies after a successful **D**, so the piece drops two rows.

Helper info: `Column heights`, `Holes`.

## Decisions API options

All five actions. Each option states the steps from the best placement after the action (searches every reachable hard-drop placement, rated by lines, holes, height, bumpiness); if the action locks the piece: lines cleared, new holes, stack height, top-out. See [Decisions API](endpoints.md#decisions-api-system-one-decision-models).

## Log

Step log: `piece`, `piece_step` and `board` (the 20-row board sent to the LLM, with `@` and `+`) before the request; `result`, `locked`, `cleared`, `auto_drop` after. See [Exported JSON](export.md).
