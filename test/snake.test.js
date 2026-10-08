import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../public/games/tetris/engine.js';
import { Game, parseAction, decisionQuestion, ACTIONS, DIRS, SYSTEM_PROMPT } from '../public/games/snake/engine.js';

test('parseAction mirrors response.strip()[:1].upper()', () => {
  assert.equal(parseAction('U'), 'U');
  assert.equal(parseAction(' d'), 'D');
  assert.equal(parseAction('\nRight'), 'R');
  assert.equal(parseAction('left'), 'L');
  assert.equal(parseAction(''), null);
  assert.equal(parseAction('   '), null);
  assert.equal(parseAction('S'), null);
  assert.equal(parseAction('1'), null);
  assert.equal(parseAction(null), null);
  assert.equal(ACTIONS, 'UDLR');
  assert.match(SYSTEM_PROMPT, /Reply with exactly ONE letter from: U D L R/);
});

test('initial state: length 3 heading right from the center, food on a free cell', () => {
  const g = new Game({ seed: 5 });
  assert.equal(g.size, 12);
  assert.deepEqual(g.snake, [[6, 6], [5, 6], [4, 6]]);
  assert.equal(g.heading, 'R');
  assert.ok(g.foodPos);
  assert.ok(!g.occupied(...g.foodPos));
  assert.equal(new Game({ size: 99 }).size, 20);
  assert.equal(new Game({ size: 2 }).size, 6);
});

test('same seed gives the same food; different seeds differ', () => {
  const foods = (seed) => Array.from({ length: 20 }, (_, k) => {
    const g = new Game({ seed });
    g.food = k;
    g.snake = [[0, 0]];
    g.spawnFood();
    return g.foodPos.join(',');
  });
  assert.deepEqual(foods(7), foods(7));
  assert.notDeepEqual(foods(7), foods(8));
});

test('k-th food is shared by games whose snakes took different paths', () => {
  const a = new Game({ seed: 11 });
  const b = new Game({ seed: 11 });
  a.foodPos = [7, 6];
  b.foodPos = [6, 5];
  a.step('R'); // both eat food #0 at different cells
  b.step('U');
  assert.equal(a.food, 1);
  assert.equal(b.food, 1);
  assert.deepEqual(a.foodPos, b.foodPos);
});

test('turning, blocked reverse, and invalid output keep moving', () => {
  const g = new Game({ seed: 1 });
  g.foodPos = [0, 0];
  let ev = g.step('U');
  assert.equal(ev.result, 'ok');
  assert.deepEqual(g.head, [6, 5]);
  ev = g.step('D'); // reverse of U
  assert.equal(ev.result, 'blocked');
  assert.equal(g.heading, 'U');
  assert.deepEqual(g.head, [6, 4]);
  assert.match(g.buildUserMessage(), /Last action: D \(blocked\)/);
  ev = g.step(null);
  assert.equal(ev.result, 'invalid');
  assert.deepEqual(g.head, [6, 3]);
  assert.equal(g.length, 3);
  assert.equal(g.steps, 3);
  assert.match(g.buildUserMessage(), /Last action: invalid output \(no-op\)/);
});

test('eating grows the snake, scores 10 and resets hunger', () => {
  const g = new Game({ seed: 1 });
  g.foodPos = [8, 6];
  g.step('R');
  assert.equal(g.sinceFood, 1);
  const ev = g.step('R');
  assert.equal(ev.ate, true);
  assert.equal(g.score, 10);
  assert.equal(g.food, 1);
  assert.equal(g.length, 4);
  assert.equal(g.sinceFood, 0);
  assert.deepEqual(g.snake, [[8, 6], [7, 6], [6, 6], [5, 6]]);
  assert.ok(!g.occupied(...g.foodPos));
});

test('wall collision ends the game without moving', () => {
  const g = new Game({ seed: 1, size: 6 });
  g.foodPos = [0, 0];
  g.step('R'); // head (4,3)
  g.step('R'); // head (5,3)
  const ev = g.step('R');
  assert.equal(ev.crash, 'wall');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'wall');
  assert.deepEqual(g.head, [5, 3]);
  assert.throws(() => g.step('U'));
});

test('self collision, but following the tail is allowed', () => {
  const g = new Game({ seed: 1 });
  g.foodPos = [0, 0];
  // 2x2 loop: head at (5,5) heading L, tail at (5,6) right below.
  g.snake = [[5, 5], [6, 5], [6, 6], [5, 6]];
  g.heading = 'L';
  assert.equal(g.probe('D'), 'ok'); // tail cell vacates
  g.step('D');
  assert.equal(g.over, false);
  assert.deepEqual(g.head, [5, 6]);

  const h = new Game({ seed: 1 });
  h.foodPos = [0, 0];
  h.snake = [[5, 5], [6, 5], [6, 6], [5, 6], [4, 6]];
  h.heading = 'L';
  const ev = h.step('D');
  assert.equal(ev.crash, 'self');
  assert.equal(h.endReason, 'self');

  // Moving onto the tail while eating there is a crash (the tail stays).
  const k = new Game({ seed: 1 });
  k.snake = [[5, 5], [6, 5], [6, 6], [5, 6]];
  k.heading = 'L';
  k.foodPos = [5, 6];
  assert.equal(k.probe('D'), 'self');
});

test('a move into a dead end crashes in the same step; following the tail out is not a dead end', () => {
  // Head (1,0) heading U; L enters the corner (0,0): walls left and up, body below (not the tail).
  const g = new Game({ seed: 1 });
  g.foodPos = [9, 9];
  g.snake = [[1, 0], [1, 1], [0, 1], [0, 2], [0, 3]];
  g.heading = 'U';
  const ev = g.step('L');
  assert.equal(g.over, true);
  assert.equal(ev.result, 'ok');
  assert.equal(ev.crash, 'wall'); // played out with no input: keeps going straight
  assert.equal(g.endReason, 'wall');
  assert.equal(g.steps, 2); // the forced move still counts as survived
  assert.equal(g.score, 0);
  assert.deepEqual(g.head, [0, 0]);

  // Same corner, but the body cell below is the tail, which moves away: the game goes on.
  const h = new Game({ seed: 1 });
  h.foodPos = [9, 9];
  h.snake = [[1, 0], [1, 1], [0, 1], [0, 2]];
  h.heading = 'U';
  assert.equal(h.step('L').crash, null);
  assert.equal(h.over, false);
  assert.deepEqual(h.safeMoves(), ['D']);
  assert.equal(h.steps, 1);
});

test('starvation after N steps without food, and the step cap', () => {
  const g = new Game({ seed: 1, starveSteps: 3 });
  g.foodPos = [0, 0];
  g.step('U');
  g.step('R');
  assert.equal(g.over, false);
  g.step('D');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'starve');

  const lim = new Game({ seed: 1, maxSteps: 2 });
  lim.foodPos = [0, 0];
  lim.step('U');
  assert.equal(lim.over, false);
  lim.step('L');
  assert.equal(lim.over, true);
  assert.equal(lim.endReason, 'limit');
});

test('filling the board ends the game', () => {
  const g = new Game({ seed: 1, size: 6 });
  // Snake covers every cell except (0,0) in a boustrophedon path ending next to it.
  const path = [];
  for (let y = 5; y >= 0; y--) {
    const xs = [0, 1, 2, 3, 4, 5];
    if (y % 2 === 0) xs.reverse();
    for (const x of xs) path.push([x, y]);
  }
  // path ends at (0,0); drop it so the head is (1,0).
  path.pop();
  g.snake = path.reverse();
  g.heading = 'L';
  g.foodPos = [0, 0];
  g.step('L');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'full');
  assert.equal(g.length, 36);
  assert.equal(g.foodPos, null);
});

test('user message format: indexed board and optional aux info', () => {
  const g = new Game({ seed: 3 });
  g.foodPos = [9, 2];
  g.lastAction = { action: 'U', result: 'ok' };
  const msg = g.buildUserMessage();
  const lines = msg.split('\n');
  assert.equal(lines[0], 'Step: 1/500  Since food: 0/100');
  assert.equal(lines[1], 'Last action: U (ok)');
  assert.equal(lines[2], 'Heading: R  Length: 3');
  assert.equal(lines[3], 'Head: x=6 y=6  Food: x=9 y=2');
  assert.equal(lines[5], '    0  1  2  3  4  5  6  7  8  9 10 11');
  assert.equal(lines[6 + 2], ' 2  .  .  .  .  .  .  .  .  .  *  .  .');
  assert.equal(lines[6 + 6], ' 6  .  .  .  .  o  o  H  .  .  .  .  .');
  assert.equal(lines[6 + 11], '11  .  .  .  .  .  .  .  .  .  .  .  .');
  assert.equal(lines.at(-1), 'Action:');
  assert.ok(!msg.includes('Food offset'));
  assert.ok(!msg.includes('Safe moves'));

  const full = g.buildUserMessage({ showFoodOffset: true, showSafeMoves: true });
  assert.match(full, /Food offset: dx=\+3 dy=-4 \(3 right, 4 up\)/);
  assert.match(full, /Safe moves: U D R\n\nAction:$/);

  g.snake = [[11, 0], [10, 0], [9, 0]];
  g.heading = 'R';
  assert.match(g.buildUserMessage({ showSafeMoves: true }), /Safe moves: D\n/);
  assert.match(new Game().buildUserMessage(), /^Step: 1\/500 {2}Since food: 0\/100\nLast action: none\n/);
});

// ---------- bots ----------

function reachable(game, d) {
  // Free cells reachable from the cell entered by moving d (approximate: tail treated as free).
  const [dx, dy] = DIRS[d];
  const start = [game.head[0] + dx, game.head[1] + dy];
  const blocked = new Set(game.snake.slice(0, -1).map(([x, y]) => `${x},${y}`));
  const seen = new Set([start.join(',')]);
  const stack = [start];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [ex, ey] of Object.values(DIRS)) {
      const nx = x + ex;
      const ny = y + ey;
      const key = `${nx},${ny}`;
      if (game.inBounds(nx, ny) && !blocked.has(key) && !seen.has(key)) {
        seen.add(key);
        stack.push([nx, ny]);
      }
    }
  }
  return seen.size;
}

function greedy(game) {
  const safe = game.safeMoves();
  if (!safe.length) return game.heading;
  const [fx, fy] = game.foodPos;
  const score = (d) => {
    const [dx, dy] = DIRS[d];
    const dist = Math.abs(game.head[0] + dx - fx) + Math.abs(game.head[1] + dy - fy);
    const room = reachable(game, d);
    return (room < game.length ? 1000 : 0) + dist;
  };
  const scored = safe.map((d) => [score(d), d]);
  return scored.reduce((best, c) => (c[0] < best[0] ? c : best))[1];
}

function play(seed, pick) {
  const g = new Game({ seed });
  let guard = 0;
  while (!g.over) {
    g.step(pick(g));
    assert.ok(++guard <= 500, 'game must terminate within max_steps');
  }
  return g;
}

test('greedy bot beats random play by a wide margin and every game terminates', () => {
  const seeds = Array.from({ length: 20 }, (_, i) => i);
  const rand = mulberry32(1);
  const randomBot = () => ACTIONS[Math.floor(rand() * 4)];
  const greedyGames = seeds.map((s) => play(s, greedy));
  const randomGames = seeds.map((s) => play(s, randomBot));
  const avg = (gs) => gs.reduce((s, g) => s + g.score, 0) / gs.length;
  const greedyAvg = avg(greedyGames);
  const randomAvg = avg(randomGames);
  assert.ok(greedyAvg >= 150, `greedy avg ${greedyAvg}`);
  assert.ok(greedyAvg >= 5 * Math.max(randomAvg, 10), `greedy ${greedyAvg} vs random ${randomAvg}`);
  for (const g of [...greedyGames, ...randomGames]) {
    assert.ok(['wall', 'self', 'starve', 'limit', 'full'].includes(g.endReason));
  }
});

test('same seed + same actions give identical games', () => {
  const run = () => {
    const g = new Game({ seed: 99 });
    const actions = 'UURRDDLLURDL';
    let i = 0;
    while (!g.over) g.step(actions[i++ % actions.length]);
    return [g.score, g.steps, g.endReason, g.boardRows().join('')];
  };
  assert.deepEqual(run(), run());
});

test('decision question: legal moves only, with wall, body, food and trap outcomes', () => {
  const g = new Game({ seed: 3 });
  g.snake = [[6, 0], [6, 1], [6, 2]];
  g.heading = 'U';
  g.foodPos = [7, 0];
  let q = decisionQuestion(g);
  assert.deepEqual(Object.keys(q.criteria), ['U', 'L', 'R']);
  assert.match(q.criteria.U, /^keep going up to x=6 y=-1: outside the board, hits the wall/);
  assert.match(q.criteria.L, /^turn left to x=5 y=0: empty cell, food 2 moves away; \d+ cells reachable/);
  assert.match(q.criteria.R, /eats the food \(\+10\)/);

  g.snake = [[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]];
  g.heading = 'L';
  g.foodPos = [9, 9];
  assert.match(decisionQuestion(g).criteria.D, /^turn down to x=2 y=3: runs into your own body, the game ends$/);

  // Right of the head is a 1-cell pocket walled in by the body, away from the tail.
  g.snake = [[1, 2], [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3]];
  g.heading = 'D';
  q = decisionQuestion(g);
  assert.match(q.criteria.R, /only 0 cells reachable afterwards for a snake of length 9, it gets trapped/);
});
