# Snake (`snake`)

[← README](../README.md) · [Match rules](match.md)

| Item | Implementation |
|---|---|
| Board | N×N (default 12, range 6–20); x = column (0 left), y = row (0 top) |
| Start | Length 3, heading right, head at (⌊N/2⌋, ⌊N/2⌋), body to the left |
| Actions | `U` up, `D` down, `L` left, `R` right (absolute); illegal output keeps the heading |
| Step | Apply the action → move one cell. Reversing reports `blocked` and goes straight |
| Tail | Without food the tail moves in the same step, so the head may enter the vacated cell; when eating, the tail stays |
| Food | Food k has its own random stream (from seed and k): up to 64 random cells, first empty one wins; if all are taken, scan linearly from a random start. The k-th food matches across sides as long as that cell isn't under the side's own snake |
| Scoring | +10 per food (length +1) |
| End | Wall (`wall`) or self (`self`) hit: the snake stays and the game ends; N steps without food (`starve`, default 100); step limit (`limit`, default 500); full board (`full`). If a move leaves no safe direction, the crash is played out straight ahead in the same step with no further request; that step still counts as survived |

## User message

Example (12×12, both helper-info options on):

```
Step: 1/500  Since food: 0/100
Last action: none
Heading: R  Length: 3
Head: x=6 y=6  Food: x=10 y=5

    0  1  2  3  4  5  6  7  8  9 10 11
 0  .  .  .  .  .  .  .  .  .  .  .  .
 ...
 5  .  .  .  .  .  .  .  .  .  .  *  .
 6  .  .  .  .  o  o  H  .  .  .  .  .
 ...
11  .  .  .  .  .  .  .  .  .  .  .  .

Food offset: dx=+4 dy=-1 (4 right, 1 up)
Safe moves: U D R

Action:
```

- Cells are 3 characters wide to align two-digit columns. `H` head, `o` body, `*` food, `.` empty.
- `Last action`: `none` (first step), `U (ok)`, `D (blocked)`, `invalid output (no-op)`.
- `Since food`: steps since the last food (or start) / N.

## Settings

"Board size", "Step limit", "Starve steps N". Helper info: `Food offset` (food relative to the head), `Safe moves` (directions that don't crash next step, excluding the blocked reverse). Fixed `initial_length: 3` and `food_score: 10` are also in settings.

## Decisions API options

Legal moves only (no blocked reverse). Each option states where the head goes; wall / own body (game over) / food / empty; food distance afterwards; reachable cells left (flags moves that trap the snake). See [Decisions API](endpoints.md#decisions-api-system-one-decision-models).

Example (heading up, head on the top row):

```jsonc
"instructions": "Which direction should the snake move next? Each option says where the head goes and what happens. Never choose a move that ends the game or traps the snake when another option is safe. Among safe moves, eat the food or get closer to it.",
"criteria": {
  "U": "keep going up to x=6 y=-1: outside the board, hits the wall and the game ends",
  "L": "turn left to x=5 y=0: empty cell, food 2 moves away; 141 cells reachable afterwards",
  "R": "turn right to x=7 y=0: eats the food (+10); 140 cells reachable afterwards"
}
```

## Log

Step log: `heading`, `length`, `head`, `food_pos`, `since_food`, `board` (compact N rows), `result`, `ate`, `crash` (`wall` / `self` / null). Game result: `score`, `food`, `length`, `survived`. See [Exported JSON](export.md).
