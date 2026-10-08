# Pinball (`pinball`)

[← README](../README.md) · [Match rules](match.md)

| Item | Implementation |
|---|---|
| Table | 21 columns × 30 rows (x = 0..20 rightward, y = 0..29 downward, gravity +y). Symmetric: arched top, side walls, 45° inlane guides to the two flippers, 3 round bumpers `*`, 4 standup targets `T` (one per side wall, two on top), drain between the flippers |
| Physics | Fixed timestep: 1 step = 0.1 s = 100 sub-ticks. Gravity 25 cells/s², ball radius 0.45, max speed 60 cells/s (≤ 0.06 cells per tick, no tunneling). Walls, targets and flippers are segments with restitution; bumpers kick the ball out (normal speed ≥ 22 cells/s); flippers are rotating segments passing on the contact-point velocity (ω × r) |
| Flippers | Pivots (6,25) and (15,25), length 3.6. Rest 30° down toward the center; held, 28° up. Raising takes ~0.07 s, lowering ~0.08 s, both within one step |
| Actions | `L` left up, `R` right up, `B` both up, `N` both down. Held for the whole step; illegal output = `N` |
| Overheat | Held more than 10 steps in a row, a flipper overheats and drops; one released step resets it (no cradling forever) |
| Miss | A flipper swinging up without touching the ball costs 20 points (not multiplied). Holding isn't a new swing |
| Launch | 3 balls per game. Start position (y = 2.5, x ∈ [3,18]) and velocity come from the seed, identical on every side |
| Scoring | Bumper 100; unlit target 250 (lights it), lit target 50; all 4 lit adds 1000 and multiplier +1 (max ×5), then resets the targets. Points are multiplied |
| End | Last ball drains (`drained`) or step limit (`limit`). Once no flipper can reach the ball before it drains, the remaining turns are played out with flippers down in the same step (still counting toward the limit), so the next ball or the end comes at once |

The miss penalty makes timing matter: without it, randomly alternating `B`/`N` beats a strategic bot. Average over 20 seeds: random −252, always `N` 503, always `B` 383, simple timing heuristic 12320.

## User message

Example (Flipper ETA on):

```
Step: 16/1000  Ball: 1/3 (2 left after this one)  Score: 430  Multiplier: x1
Last action: L (ok)
Flippers: left UP (held 1/10), right down
Targets lit: 1/4
Ball position: x=4.2 y=16.3 (column, row)
Ball velocity: vx=+1.4 vy=+2.0 (cells per step; +vx = right, +vy = down)

             11111111112
   012345678901234567890
 0   ####TTT###TTT####  
 1  ##...............## 
 2 ##.................##
 3 #...................#
 4 #...................#
 5 #...................#
 6 #....***.....***....#
 7 #....***.....***....#
 8 #....***.....***....#
 9 #...................#
10 #........***........#
11 t........***........T
12 t........***........T
13 t...................T
14 #...................#
15 #...................#
16 #...O...............#
17 #...................#
18 #...................#
19 #...................#
20  #.................# 
21   #...............#  
22    #.............#   
23     #..///......#    
24      #//.......#     
25       #......//      
26       #....///#      
27       #.......#      
28       #.......#      
29       #.......#      

Flipper ETA: with no flipper pressed the ball reaches flipper height (y >= 22.5) in 3 steps at x=7.8 (left flipper)

Action:
```

Legend: `#` wall, `*` bumper, `T`/`t` unlit / lit target, `\` `/` flipper (at its current angle), `O` ball, `.` playfield; blank outside. First-step `Last action` is `none`; illegal output is `invalid output (no-op)`; overheat shows `L (overheat)`.

## Settings

"Balls" (default 3), "Step limit" (default 1000). Helper info: `Flipper ETA` (with no flipper pressed, steps until the ball reaches flipper height, and which side), `Ball trail` (`o` marks the ball 1 and 2 steps ago). Fixed `step_seconds: 0.1`, `substeps: 100`, `overheat_steps: 10` and `miss_penalty: 20` are also in settings.

## Decisions API options

All four actions. Each option states which flippers hit or miss (and the miss penalty); points; whether the ball drains now, or within 20 steps if you stop flipping. See [Decisions API](endpoints.md#decisions-api-system-one-decision-models).

## Log

Step log: `ball_no`, `x`, `y`, `vx`, `vy` (cells/step), `flippers`, `table` (the 30-row table sent to the LLM), `result`, `bumpers`, `targets`, `bank`, `shots`, `misses`, `drained`. Game result: `score`, `balls`, `bumper_hits`, `target_hits`, `banks`, `multiplier`, `shots`, `misses`, `best_ball`. See [Exported JSON](export.md).
