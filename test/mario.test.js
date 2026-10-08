import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../public/games/tetris/engine.js';
import {
  decisionQuestion, Game, generateLevel, parseAction, ACTIONS, HEIGHT, VIEW_WIDTH, START_X, SCORE, DEFAULT_LIMIT, STUCK_STEPS,
} from '../public/games/mario/engine.js';

// Flat test level: `ground` rows of ground everywhere, no enemies/coins, player at column 2.
function sandbox({ width = 40, ground = 2, limit = DEFAULT_LIMIT } = {}) {
  const g = new Game({ seed: 1, length: 60, limit });
  g.width = width;
  g.tiles = Array.from({ length: HEIGHT }, (_, y) => Array(width).fill(y >= HEIGHT - ground ? 'G' : '.'));
  g.coinSet = new Set();
  g.enemies = [];
  g.flagX = width - 2;
  g.x = START_X;
  g.y = HEIGHT - 1 - ground;
  g.maxX = START_X;
  return g;
}
const pos = (g) => [g.x, g.y];
const wall = (g, x, rows) => rows.forEach((y) => (g.tiles[y][x] = 'S'));

// Simple reactive bot: jump when a pit, wall or enemy is close ahead, otherwise run right.
function heuristic(g) {
  if (!g.grounded) return 'N';
  const { x, y } = g;
  const pit = [1, 2].some((k) => !g.solid(x + k, HEIGHT - 1));
  const blocked = g.solid(x + 1, y) || g.solid(x + 2, y);
  const enemy = g.enemies.some((e) => e.alive && e.y === y && e.x > x && e.x - x <= 3);
  return (pit || blocked || enemy) && !g.solid(x, y - 1) ? 'J' : 'R';
}

// Depth-first search over cloned games; proves the flag is reachable.
function solve(game, budget = 200000) {
  const seen = new Set();
  let nodes = 0;
  const dfs = (g) => {
    if (g.over) return g.endReason === 'goal' ? g : null;
    const key = `${g.x},${g.y},${g.rise},${g.vx}`;
    if (++nodes > budget || seen.has(key)) return null;
    seen.add(key);
    for (const a of g.grounded ? 'RJUNL' : 'NRUL') {
      const c = g.clone();
      c.step(a);
      const found = dfs(c);
      if (found) return found;
    }
    return null;
  };
  return dfs(game.clone());
}

function randomRun(seed) {
  const rand = mulberry32(seed + 1000);
  const g = new Game({ seed });
  while (!g.over) g.step(rand() < 0.1 ? null : ACTIONS[Math.floor(rand() * ACTIONS.length)]);
  return g;
}

test('parseAction mirrors response.strip()[:1].upper()', () => {
  assert.equal(parseAction('R'), 'R');
  assert.equal(parseAction(' j'), 'J');
  assert.equal(parseAction('\nNope'), 'N');
  assert.equal(parseAction('u'), 'U');
  assert.equal(parseAction('Left'), 'L');
  assert.equal(parseAction(''), null);
  assert.equal(parseAction('  '), null);
  assert.equal(parseAction('S'), null);
  assert.equal(parseAction('1'), null);
  assert.equal(parseAction(undefined), null);
});

test('levels are deterministic per seed and respect the length setting', () => {
  const a = generateLevel(42);
  const b = generateLevel(42);
  assert.deepEqual(a.tiles, b.tiles);
  assert.deepEqual([...a.coins], [...b.coins]);
  assert.deepEqual(a.enemies, b.enemies);
  assert.notDeepEqual(generateLevel(43).tiles, a.tiles);
  assert.equal(generateLevel(1, 120).tiles[0].length, 120);
  assert.equal(generateLevel(1, 10).width, 60); // clamped
  for (let seed = 0; seed < 20; seed++) {
    const lv = generateLevel(seed);
    // Start and flag areas stand on solid ground; enemies start on free tiles above ground.
    assert.equal(lv.tiles[HEIGHT - 1][START_X], 'G');
    assert.equal(lv.tiles[HEIGHT - 1][lv.flagX], 'G');
    for (const e of lv.enemies) {
      assert.equal(lv.tiles[e.y][e.x], '.');
      assert.notEqual(lv.tiles[e.y + 1][e.x], '.');
    }
    assert.ok(lv.enemies.length >= 2, `seed ${seed} has enemies`);
  }
});

test('walking, blocked moves and the level edge', () => {
  const g = sandbox();
  assert.equal(g.grounded, true);
  let ev = g.step('R');
  assert.equal(ev.result, 'ok');
  assert.deepEqual(pos(g), [3, 9]);
  g.step('L');
  g.step('L');
  g.step('L');
  assert.deepEqual(pos(g), [0, 9]);
  ev = g.step('L');
  assert.equal(ev.result, 'blocked');
  wall(g, 1, [9]);
  ev = g.step('R');
  assert.equal(ev.result, 'blocked');
  assert.deepEqual(g.lastAction, { action: 'R', result: 'blocked' });
  assert.equal(g.step('N').result, 'ok');
  assert.equal(g.steps, 7);
});

test('J follows a fixed arc: 4 rows up, then down, drifting right; U goes straight up', () => {
  const g = sandbox();
  const path = [];
  g.step('J');
  path.push(pos(g));
  while (!g.grounded) {
    g.step('N');
    path.push(pos(g));
  }
  assert.deepEqual(path, [[3, 8], [4, 7], [5, 6], [6, 5], [7, 6], [8, 7], [9, 8], [10, 9]]);
  assert.equal(g.vx, 0); // drift resets on landing

  const u = sandbox();
  u.step('U');
  assert.equal(u.stateText(), 'in the air, rising (3 more rows), drift none');
  for (let i = 0; i < 7; i++) u.step('N');
  assert.deepEqual(pos(u), [2, 9]);
  assert.equal(u.grounded, true);
});

test('air control: R/L set drift, U stops it, J is ignored until landing', () => {
  const g = sandbox();
  g.x = 10;
  g.step('U'); // (10, 8)
  assert.equal(g.step('R').result, 'ok'); // (11, 7)
  assert.equal(g.step('N').result, 'ok'); // drift kept: (12, 6)
  assert.equal(g.step('J').result, 'ignored'); // (13, 5)
  assert.equal(g.stateText(), 'in the air, falling, drift right');
  g.step('L'); // (12, 6)
  g.step('U'); // (12, 7)
  assert.deepEqual(pos(g), [12, 7]);
  g.step(null); // invalid keeps drift (none): (12, 8)
  assert.deepEqual(pos(g), [12, 8]);
  assert.match(g.buildUserMessage(), /Last action: invalid output \(no-op\)/);
});

test('a jump clears a wall 4 tiles high from right next to it', () => {
  const g = sandbox();
  wall(g, 3, [6, 7, 8, 9]);
  assert.equal(g.step('R').result, 'blocked');
  g.step('J'); // blocked sideways while rising, drift carries over the top
  while (!g.grounded) g.step('N');
  assert.deepEqual(pos(g), [3, 5]);
  const tall = sandbox();
  wall(tall, 3, [5, 6, 7, 8, 9]);
  tall.step('J');
  while (!tall.grounded) tall.step('N');
  assert.deepEqual(pos(tall), [2, 9]);
});

test('walking off a ledge keeps drift; falling into a pit is death', () => {
  const g = sandbox({ ground: 4 });
  for (let x = 5; x < 40; x++) g.tiles[8][x] = g.tiles[9][x] = '.'; // step down from height 4 to 2
  for (let x = 12; x < 15; x++) g.tiles[10][x] = g.tiles[11][x] = '.';
  g.x = 4;
  g.y = 7;
  g.step('R'); // off the ledge: (5, 7) then falls to (5, 8)
  assert.deepEqual(pos(g), [5, 8]);
  assert.equal(g.grounded, false);
  assert.equal(g.step('N').result, 'ok'); // drift right: (6, 9) and landed
  assert.deepEqual(pos(g), [6, 9]);
  assert.equal(g.grounded, true);
  while (!g.over) g.step('R');
  assert.equal(g.endReason, 'dead');
  assert.equal(g.death, 'pit');
  assert.equal(g.x, 14); // air steering R carried it across the pit, into the far wall
  assert.throws(() => g.step('R'));
});

test('a fall that no steering can save ends the game at once', () => {
  const g = sandbox();
  for (let x = 4; x < 12; x++) g.tiles[10][x] = g.tiles[11][x] = '.'; // pit 8 wide
  g.x = 3;
  const ev = g.step('R'); // walks off the edge: the fall is played out within this step
  assert.equal(ev.endReason, 'dead');
  assert.ok(g.over);
  assert.equal(g.death, 'pit');
  assert.ok(g.y >= HEIGHT);
  assert.equal(g.lastAction.action, 'N'); // the played-out turns had no input

  // A jump over the same pit stays in play: steering in the air can still land.
  const j = sandbox();
  for (let x = 4; x < 12; x++) j.tiles[10][x] = j.tiles[11][x] = '.';
  j.tiles[9][7] = 'S'; // a pillar in the middle to land on
  j.step('J');
  assert.equal(j.over, false);
  while (!j.grounded && !j.over) j.step(j.x < 7 ? 'R' : 'U');
  assert.equal(j.over, false);
  assert.deepEqual(pos(j), [7, 8]);
});

test('? blocks give a coin when hit from below; a ceiling blocks jumping', () => {
  const g = sandbox();
  g.tiles[6][2] = 'Q';
  const ev = g.step('U'); // 9 -> 8
  assert.equal(ev.coins, 0);
  const ev2 = g.step('N'); // 8 -> 7
  const ev3 = g.step('N'); // head hits the block at row 6
  assert.equal(ev2.coins + ev3.coins, 1);
  assert.equal(g.coins, 1);
  assert.equal(g.tiles[6][2], 'U');
  assert.equal(g.rise, 0);
  while (!g.grounded) g.step('N');
  g.tiles[8][2] = 'B';
  assert.equal(g.step('J').result, 'blocked');
  assert.deepEqual(pos(g), [2, 9]);
});

test('coins are collected on touch', () => {
  const g = sandbox();
  g.coinSet = new Set([9 * g.width + 3, 7 * g.width + 5]);
  g.step('R');
  assert.equal(g.coins, 1);
  g.step('J'); // (4, 8)
  g.step('N'); // (5, 7)
  assert.equal(g.coins, 2);
  assert.equal(g.coinSet.size, 0);
});

test('enemies walk, turn at walls, ledges and each other', () => {
  const g = sandbox();
  wall(g, 20, [9]);
  g.tiles[9][10] = g.tiles[10][10] = g.tiles[11][10] = '.'; // pit at column 10
  g.enemies = [{ x: 12, y: 9, dir: -1, alive: true }, { x: 18, y: 9, dir: 1, alive: true }];
  g.step('N'); // 11, 19
  g.step('N'); // pit edge / wall: both turn in place
  assert.deepEqual(g.enemies.map((e) => [e.x, e.dir]), [[11, 1], [19, -1]]);
  for (let i = 0; i < 3; i++) g.step('N'); // 14, 16
  g.step('N'); // 15, 16 blocked by the first -> turns
  assert.deepEqual(g.enemies.map((e) => [e.x, e.dir]), [[15, 1], [16, 1]]);
});

test('side contact kills the player; landing on an enemy stomps it', () => {
  const g = sandbox();
  g.enemies = [{ x: 6, y: 9, dir: -1, alive: true }];
  g.step('R'); // player 3, enemy 5
  g.step('N'); // enemy 4, adjacent
  assert.equal(g.over, false);
  g.step('N'); // enemy 3 == player
  assert.equal(g.endReason, 'dead');
  assert.equal(g.death, 'enemy');

  const s = sandbox();
  wall(s, 9, [9]);
  wall(s, 11, [9]);
  s.enemies = [{ x: 10, y: 9, dir: -1, alive: true }]; // boxed in, turns every step
  s.x = 10;
  s.y = 5;
  for (let i = 0; i < 4; i++) s.step('N');
  assert.equal(s.over, false);
  assert.equal(s.stomps, 1);
  assert.equal(s.enemies[0].alive, false);
  assert.deepEqual(pos(s), [10, 9]);
  assert.equal(s.score, (10 - START_X) * SCORE.column + SCORE.stomp);
});

test('an enemy walking into a falling player is stomped too', () => {
  const g = sandbox();
  g.x = 8;
  g.y = 8; // one row above the ground, about to fall
  g.enemies = [{ x: 9, y: 9, dir: -1, alive: true }];
  g.step('N'); // player falls to (8, 9), enemy walks into it
  assert.equal(g.over, false);
  assert.equal(g.stomps, 1);
});

test('reaching the flag ends the game with a time bonus; the step limit ends it too', () => {
  const g = sandbox({ width: 20, limit: 100 });
  while (!g.over) g.step('R');
  assert.equal(g.endReason, 'goal');
  assert.equal(g.x, 18);
  assert.equal(g.steps, 16);
  assert.equal(g.score, 16 * SCORE.column + SCORE.goal + SCORE.stepLeft * (100 - 16));

  const l = sandbox({ limit: 5 });
  while (!l.over) l.step('N');
  assert.equal(l.endReason, 'limit');
  assert.equal(l.steps, 5);
  assert.equal(l.score, 0);
});

test('user message: header, absolute column ruler, 12 map rows and optional aux lines', () => {
  const g = new Game({ seed: 42 });
  const lines = g.buildUserMessage().split('\n');
  assert.equal(lines[0], `Step: 1/${DEFAULT_LIMIT}`);
  assert.equal(lines[1], 'Last action: none');
  assert.equal(lines[2], 'You: column 2, row 9, on ground');
  assert.equal(lines[3], `Flag: column ${g.flagX}`);
  assert.equal(lines[5], `   ${'0'.repeat(VIEW_WIDTH)}`);
  assert.equal(lines[7], '   012345678901234567890123');
  const map = lines.slice(8, 8 + HEIGHT);
  assert.equal(map.length, HEIGHT);
  assert.ok(map.every((r) => r.length === 3 + VIEW_WIDTH));
  assert.equal(map[9].slice(3)[2], 'M');
  assert.equal(map[11].slice(3, 6), '###');
  assert.equal(lines.at(-1), 'Action:');
  assert.doesNotMatch(lines.join('\n'), /Next pit|Enemies in view/);

  // The ruler follows the player: 4 columns behind, absolute indices with 3 digits.
  g.x = 130;
  const far = g.buildUserMessage({ showPit: true, showEnemies: true }).split('\n');
  assert.equal(far[5].slice(3, 4), '1');
  assert.equal(far[6].slice(3, 5), '22');
  assert.equal(far[7].slice(3, 5), '67');
  assert.ok(far.some((l) => /^Next pit: (none|columns \d+-\d+ \(width \d\), \d+ columns ahead)$/.test(l)));
  assert.ok(far.some((l) => /^Enemies in view: (none|column \d+ row \d+ moving (left|right)(; .*)?)$/.test(l)));
});

test('scripted bot beats random by a wide margin, levels are completable, games terminate', () => {
  const seeds = Array.from({ length: 30 }, (_, i) => i);
  let botDistance = 0;
  let botGoals = 0;
  let randomDistance = 0;
  for (const seed of seeds) {
    const g = new Game({ seed });
    while (!g.over) g.step(heuristic(g));
    assert.ok(g.steps <= DEFAULT_LIMIT);
    botDistance += g.distance;
    botGoals += g.endReason === 'goal';

    const r = randomRun(seed);
    assert.ok(r.over && r.steps <= DEFAULT_LIMIT);
    randomDistance += r.distance;

    const solved = solve(new Game({ seed }));
    assert.ok(solved, `seed ${seed} is completable`);
    assert.equal(solved.endReason, 'goal');
  }
  assert.ok(botDistance > 3 * randomDistance, `bot ${botDistance} vs random ${randomDistance}`);
  assert.ok(botGoals >= seeds.length / 3, `bot reached the flag ${botGoals} times`);
});

test('decision question: progress per action, pits and air landings', () => {
  const g = new Game({ seed: 1 });
  assert.equal(decisionQuestion(g).criteria.R, 'move right: on the ground at column 3 (+1)');
  const pit = g.nextPit();
  g.x = pit.start - 1;
  g.y = HEIGHT - 1 - g.groundHeight(g.x);
  const { criteria } = decisionQuestion(g);
  assert.equal(criteria.R, 'move right: you die (fall into a pit)');
  assert.match(criteria.J, /^jump forward: in the air .* you land at column \d+ \(\+\d+\)$/);
  assert.equal(criteria.N, `do nothing: on the ground at column ${g.x} (+0)`);
  assert.equal(g.steps, 0);
});

test('decision question: a jump still in the air at the step limit says so', () => {
  const g = sandbox({ limit: 3 });
  const { criteria } = decisionQuestion(g);
  assert.equal(
    criteria.J,
    'jump forward: in the air at column 3 row 8; if you keep drifting, after 2 more steps the step limit is reached at column 5 (+3)',
  );
  assert.doesNotMatch(criteria.U, /null/);
});

test(`${STUCK_STEPS} steps in a row with no change on screen end the game as stuck`, () => {
  const g = sandbox();
  wall(g, 3, [7, 8, 9]);
  g.step('R'); // into the wall: blocked
  for (let i = 1; i < STUCK_STEPS; i++) {
    assert.equal(g.over, false);
    g.step(i % 2 ? 'N' : 'R'); // the Last action line differs, the screen does not
  }
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'stuck');
  assert.equal(g.steps, STUCK_STEPS);
  assert.equal(g.score, 0);

  // Any change on screen restarts the count: here a jump that lands back in place.
  const h = sandbox();
  wall(h, 3, [7, 8, 9]);
  for (let i = 0; i < STUCK_STEPS - 1; i++) h.step('R');
  h.step('U');
  while (!h.grounded) h.step('N');
  for (let i = 0; i < STUCK_STEPS - 1; i++) h.step('R');
  assert.equal(h.over, false);
  h.step('R');
  assert.equal(h.endReason, 'stuck');

  // An enemy moving in view is a change too.
  const e = sandbox();
  wall(e, 3, [7, 8, 9]);
  wall(e, 20, [9]);
  wall(e, 26, [9]);
  e.enemies = [{ x: 22, y: 9, dir: -1, alive: true }];
  for (let i = 0; i < 3 * STUCK_STEPS; i++) e.step('R');
  assert.equal(e.over, false);
});

test('decision question: the option that would end the game as stuck says so', () => {
  const g = sandbox();
  wall(g, 3, [7, 8, 9]);
  for (let i = 0; i < STUCK_STEPS - 1; i++) g.step('R');
  const { criteria } = decisionQuestion(g);
  assert.equal(
    criteria.R,
    `move right (blocked by a solid tile): the game ends: nothing on screen has changed for ${STUCK_STEPS} steps`,
  );
  assert.equal(criteria.L, 'move left: on the ground at column 1 (-1)');
});
