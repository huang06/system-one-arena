# Mario-style platformer (`mario`)

[← README](../README.md) · [Match rules](match.md)

| Item | Implementation |
|---|---|
| Map | 12 rows (row 0 at top) × level length (default 200); generated from the seed, identical on every side |
| Terrain | Ground, pits, height changes, pipes, stone stairs (maybe with a pit between), bricks / `?` blocks, floating brick ledges (over 8–10 wide pits; you must land on them), coins, enemies; wider pits and more enemies later |
| Start / goal | Start at column 2; flag at column "level length − 6"; x ≥ flag column wins |
| Actions | `R` right, `L` left, `J` jump right, `U` jump up, `N` stay; illegal output = stay (air drift continues) |
| Step | Apply the action → player moves horizontally, then vertically → every enemy moves one cell |
| Jump | Rise 1 row per step for 4 steps (the jump step counts), then fall 1 row per step until landing. `J` adds right drift (1 column per air step), clearing exactly 8 columns on flat ground; `U` has no drift. Can jump onto a 4-high wall directly ahead |
| In the air | `R` / `L` set right / left drift, `U` stops drift (straight down), `N` keeps drift, `J` does nothing (`ignored`). Walking off a ledge keeps drift; landing resets it |
| Blocks | `#` and `?` are solid. Hitting `?` from below gives 1 coin and turns it into `#`. With a solid block overhead, `J` / `U` report `blocked` |
| Enemies | Start walking left, 1 cell per step, turning at walls, ledge edges and other enemies; never fall. Touching one **while falling** (landing on it or it walking into you) stomps it; any other contact kills |
| End | Reach the flag (`goal`); fall off the bottom or touch an enemy (`dead`); step limit (`limit`, default 500). If the player is in the air and no steering can land (e.g. in a pit past its wall), the fall is played out with no input in the same step and the game ends without another LLM call. After 5 steps in a row with no change on screen (map, player position and motion, direction of enemies in view; not the `Step` or `Last action` lines), e.g. walking into a wall, the game ends as `stuck` with the score so far. The system prompt states this rule |
| Scoring | Farthest column × 10 + coins × 50 + stomps × 100; reaching the goal adds 1000 + 5 × (step limit − steps used) |

## User message

- `Last action`: `none` on the first step, then `X (ok)`, `X (blocked)`, `J (ignored)` or `invalid output (no-op)`.
- The view is 24 columns: 4 left of the player, 19 right (clamped at level edges). Absolute column numbers run down 3 rows on top (hundreds, tens, ones); row numbers on the left.

Example:

```
Step: 14/500
Last action: N (ok)
You: column 15, row 7, in the air, rising (2 more rows), drift right
Flag: column 194

   000000000000000000000000
   111111111222222222233333
   123456789012345678901234
 0 ........................
 ...
 7 ....M...................
 8 .....##........##.......
 9 .....##........##.......
10 #######################.
11 #######################.

Action:
```

Legend: `M` you, `#` ground / wall / pipe, `?` coin block, `o` coin, `E` enemy, `F` flag, `.` air.

## Settings

"Level length" (default 200, range 60–400), "Step limit" (default 500). Helper info: `Next pit` (e.g. `Next pit: columns 34-35 (width 2), 19 columns ahead`), `Enemies in view` (e.g. `Enemies in view: column 30 row 9 moving left; ...`). Fixed `height`, `view_width`, `jump_rise` and `stuck_steps` are also in settings.

## Decisions API options

All five actions. Each option states the resulting column and progress (+/-); coins and stomps; death (pit / enemy); in the air, where you land if you keep drifting, and if that dies, that steering can still land (an unsavable fall already ends the game as death); that the game ends if this is the 5th step in a row with no change on screen. See [Decisions API](endpoints.md#decisions-api-system-one-decision-models).

## Log

Step log: `x`, `y`, `state`, `view` (the 12-row map sent to the LLM), `result`, `coins`, `stomps`, `x_after`, `y_after`. Game result: `score`, `distance`, `progress`, `coins`, `stomps`, `goal`, `death` (`pit` / `enemy`). See [Exported JSON](export.md).
