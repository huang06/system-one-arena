import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '../public/games/tetris/engine.js';
import {
  decisionQuestion, Game, parseAction, insideTable, flipperTip, ACTIONS, WIDTH, HEIGHT, BALL_RADIUS, MAX_SPEED, FLIPPER_LENGTH,
  FLIPPER_RADIUS, OVERHEAT_STEPS, POINTS, SYSTEM_PROMPT, STEP_SECONDS,
} from '../public/games/pinball/engine.js';

const place = (g, x, y, vx = 0, vy = 0) => Object.assign(g.ball, { x, y, vx, vy });

// Ball resting on the left flipper (at rest) at distance t from the pivot.
const onLeftFlipper = (g, t) => {
  const f = g.left;
  const off = FLIPPER_RADIUS + BALL_RADIUS + 0.02;
  place(g, f.px + t * Math.cos(f.angle) + off * Math.sin(f.angle), f.py + t * Math.sin(f.angle) - off * Math.cos(f.angle));
};

// Simple bot: pulse the flipper on the ball's side when the ball is within 3 cells above it and not rising.
function heuristic(g) {
  const b = g.ball;
  if (b.vy < 0) return 'N';
  const near = (f) => {
    const dx = Math.cos(f.rest);
    const dy = Math.sin(f.rest);
    const rx = b.x - f.px;
    const ry = b.y - f.py;
    const t = rx * dx + ry * dy;
    return !f.up && t > 0 && t < 4.2 && Math.abs(rx * dy - ry * dx) < 3;
  };
  const l = near(g.left);
  const r = near(g.right);
  return l && r ? 'B' : l ? 'L' : r ? 'R' : 'N';
}

function play(seed, policy, opts = {}) {
  const g = new Game({ seed, maxSteps: 600, ...opts });
  const rand = mulberry32(1000 + seed);
  while (!g.over) g.step(policy(g, rand));
  return g;
}

test('parseAction mirrors response.strip()[:1].upper()', () => {
  assert.equal(ACTIONS, 'LRBN');
  assert.equal(parseAction('L'), 'L');
  assert.equal(parseAction(' r'), 'R');
  assert.equal(parseAction('\nBoth'), 'B');
  assert.equal(parseAction('none'), 'N');
  assert.equal(parseAction(''), null);
  assert.equal(parseAction('   '), null);
  assert.equal(parseAction('X'), null);
  assert.equal(parseAction('1'), null);
  assert.equal(parseAction(null), null);
});

test('launches are seeded: same seed -> same balls, different seed -> different balls', () => {
  const launches = (seed) => {
    const g = new Game({ seed });
    const out = [];
    while (!g.over) {
      out.push([g.ball.x, g.ball.y, g.ball.vx, g.ball.vy]);
      const n = g.ballNo;
      while (!g.over && g.ballNo === n) g.step('N');
    }
    return out;
  };
  const a = launches(5);
  assert.equal(a.length, 3);
  assert.deepEqual(a, launches(5));
  assert.notDeepEqual(a, launches(6));
  for (const [x, y] of a) assert.ok(insideTable(x, y));
});

test('same seed + same actions give identical games', () => {
  const run = () => {
    const g = new Game({ seed: 99, maxSteps: 400 });
    const actions = 'NNLNRNBNNNLLNR';
    let i = 0;
    while (!g.over) g.step(actions[i++ % actions.length]);
    return [g.score, g.steps, g.bumperHits, g.shots, g.misses, g.ball.x, g.ball.y, g.tableRows().join('')];
  };
  assert.deepEqual(run(), run());
});

test('gravity pulls the ball down; illegal output is a no-op that still advances time', () => {
  const g = new Game({ seed: 1 });
  place(g, 10.5, 15, 0, 0);
  const ev = g.step(null);
  assert.equal(ev.result, 'invalid');
  assert.equal(g.steps, 1);
  // 0.1 s at 25 cells/s^2: v = 2.5 cells/s, dy ~ 0.125 cells
  assert.ok(Math.abs(g.ball.vy - 2.5) < 1e-6);
  assert.ok(Math.abs(g.ball.y - 15.125) < 0.01);
  assert.equal(g.left.up, false);
  assert.match(g.buildUserMessage(), /Last action: invalid output \(no-op\)/);
});

test('drain launches the next ball; the last drain ends the game', () => {
  const g = new Game({ seed: 2, balls: 2 });
  place(g, 10.5, 29, 0, 20);
  let ev = g.step('N');
  assert.equal(ev.drained, true);
  assert.equal(g.ballNo, 2);
  assert.equal(g.ballsLeft, 0);
  assert.equal(g.over, false);
  assert.ok(g.ball.y < 5);
  assert.ok(g.frames.some((f) => f.jump), 'drain animation kept, new ball starts a new path');
  place(g, 10.5, 29, 0, 20);
  ev = g.step('N');
  assert.equal(ev.drained, true);
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'drained');
  assert.throws(() => g.step('N'));
});

test('step limit ends the game', () => {
  const g = new Game({ seed: 3, maxSteps: 5 });
  for (let i = 0; i < 4; i++) g.step('N');
  assert.equal(g.over, false);
  g.step('N');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'limit');
});

test('flippers swing up within a step and fall back when released', () => {
  const g = new Game({ seed: 4 });
  place(g, 10.5, 5, 0, 0);
  const rest = g.left.angle;
  g.step('L');
  assert.equal(g.left.up, true);
  assert.equal(g.left.angle, g.left.upAngle);
  assert.equal(g.right.angle, g.right.rest);
  g.step('B');
  assert.equal(g.right.angle, g.right.upAngle);
  g.step('N');
  assert.equal(g.left.angle, rest);
  assert.equal(g.right.angle, g.right.rest);
});

test('holding a flipper overheats it after the limit; releasing resets', () => {
  const g = new Game({ seed: 4, maxSteps: 100 });
  for (let i = 1; i <= OVERHEAT_STEPS; i++) {
    place(g, 10.5, 5, 0, 0);
    assert.equal(g.step('L').result, 'ok');
    assert.equal(g.left.up, true);
  }
  place(g, 10.5, 5, 0, 0);
  assert.equal(g.step('L').result, 'overheat');
  assert.equal(g.left.overheated, true);
  assert.equal(g.left.up, false);
  assert.equal(g.left.angle, g.left.rest);
  assert.match(g.buildUserMessage(), /left DOWN \(overheated, release to reset\)/);
  assert.match(g.buildUserMessage(), /Last action: L \(overheat\)/);
  place(g, 10.5, 5, 0, 0);
  g.step('N');
  assert.equal(g.left.overheated, false);
  place(g, 10.5, 5, 0, 0);
  assert.equal(g.step('L').result, 'ok');
  assert.equal(g.left.up, true);
});

test('a swing that misses costs points; a swing that hits shoots the ball up for free', () => {
  const g = new Game({ seed: 5 });
  place(g, 10.5, 5, 0, 0);
  let ev = g.step('B');
  assert.equal(ev.misses, 2);
  assert.equal(g.score, 2 * POINTS.miss);
  // Holding is not a new swing.
  place(g, 10.5, 5, 0, 0);
  ev = g.step('B');
  assert.equal(ev.misses, 0);
  assert.equal(g.score, 2 * POINTS.miss);

  const h = new Game({ seed: 5 });
  h.step('N');
  onLeftFlipper(h, 2.8);
  ev = h.step('L');
  assert.equal(ev.shots, 1);
  assert.equal(ev.misses, 0);
  assert.equal(h.score, 0);
  assert.ok(h.ball.vy < -30, `ball should fly up, vy=${h.ball.vy}`);
  assert.ok(h.ball.vx > 0, 'left flipper shoots toward the right');
});

test('bumpers score and kick; targets light and a full bank raises the multiplier', () => {
  const g = new Game({ seed: 6 });
  place(g, 10.5, 9.3, 0, 5); // just above the centre bumper at (10.5, 11.5)
  let ev = g.step('N');
  assert.equal(ev.bumpers, 1);
  assert.equal(g.score, POINTS.bumper);
  assert.ok(g.ball.vy < -15, 'kicked back up');

  const t = new Game({ seed: 6 });
  place(t, 2, 12.5, -25, 0); // moving into the left wall target
  ev = t.step('N');
  assert.equal(ev.targets, 1);
  assert.deepEqual(t.lit, [true, false, false, false]);
  assert.equal(t.score, POINTS.target);
  assert.match(t.buildUserMessage(), /Targets lit: 1\/4/);
  assert.equal(t.tableRows()[12][0], 't');
  assert.equal(t.tableRows()[12][20], 'T');

  t.lit = [false, true, true, true];
  place(t, 2, 12.5, -25, 0);
  ev = t.step('N');
  assert.equal(ev.bank, true);
  assert.equal(t.multiplier, 2);
  assert.equal(t.banks, 1);
  assert.deepEqual(t.lit, [false, false, false, false]);
  assert.equal(t.score, 2 * POINTS.target + POINTS.bank);
  // Later points are doubled.
  place(t, 10.5, 9.3, 0, 5);
  t.step('N');
  assert.equal(t.score, 2 * POINTS.target + POINTS.bank + 2 * POINTS.bumper);
});

test('no tunnelling through walls or flippers at max speed', () => {
  const rand = mulberry32(7);
  const minWallDist = (x, y) => Math.min(x - 0.5, 20.5 - x, y - 0.5);
  let trials = 0;
  while (trials < 400) {
    const x = 1 + 19 * rand();
    const y = 1 + 23 * rand();
    if (!insideTable(x, y) || minWallDist(x, y) < 1 || (y > 18 && Math.abs(x - 10.5) > 8 - (y - 18))) continue;
    const g = new Game({ seed: trials, maxSteps: 40 });
    if (Math.hypot(x - 10.5, y - 11.5) < 2 || Math.hypot(x - 6.5, y - 7.5) < 2 || Math.hypot(x - 14.5, y - 7.5) < 2) continue;
    trials += 1;
    const a = rand() * Math.PI * 2;
    place(g, x, y, MAX_SPEED * Math.cos(a), MAX_SPEED * Math.sin(a));
    const ball = g.ballNo;
    let prev = null;
    while (!g.over && g.ballNo === ball) {
      g.step('LRBN'[Math.floor(rand() * 4)]);
      for (const f of g.frames) {
        if (f.jump) break;
        assert.ok(insideTable(f.x, f.y) || f.y > HEIGHT - 1, `ball left the table at (${f.x}, ${f.y})`);
        const sides = g.flippers.map((fl, i) => {
          const ang = i === 0 ? f.la : f.ra;
          const dx = Math.cos(ang);
          const dy = Math.sin(ang);
          const rx = f.x - fl.px;
          const ry = f.y - fl.py;
          const t = rx * dx + ry * dy;
          const s = (rx * -dy + ry * dx) * (i === 0 ? 1 : -1); // > 0 = below the flipper
          return { t, s };
        });
        if (prev) {
          sides.forEach((c, i) => {
            const p = prev[i];
            const span = (v) => v > 0.3 && v < FLIPPER_LENGTH - 0.8;
            assert.ok(!(span(p.t) && span(c.t) && p.s < 0 && c.s > 0), `ball crossed flipper ${i} at (${f.x}, ${f.y})`);
          });
        }
        prev = sides;
      }
    }
  }
});

test('a ball left alone always drains (nothing to rest on)', () => {
  for (let seed = 0; seed < 20; seed++) {
    const g = play(seed, () => 'N');
    assert.equal(g.endReason, 'drained', `seed ${seed}`);
    assert.ok(g.steps < 300, `seed ${seed}: ${g.steps} steps`);
  }
});

test('user message: header lines, 30 labelled rows, flipper shapes, aux info off by default', () => {
  const g = new Game({ seed: 8 });
  place(g, 10.2, 15.6, 3, -12);
  let lines = g.buildUserMessage().split('\n');
  assert.equal(lines[0], 'Step: 1/1000  Ball: 1/3 (2 left after this one)  Score: 0  Multiplier: x1');
  assert.equal(lines[1], 'Last action: none');
  assert.equal(lines[2], 'Flippers: left down, right down');
  assert.equal(lines[3], 'Targets lit: 0/4');
  assert.equal(lines[4], 'Ball position: x=10.2 y=15.6 (column, row)');
  assert.equal(lines[5], 'Ball velocity: vx=+0.3 vy=-1.2 (cells per step; +vx = right, +vy = down)');
  assert.equal(lines[7], '             11111111112');
  assert.equal(lines[8], '   012345678901234567890');
  const rows = lines.slice(9, 9 + HEIGHT);
  assert.equal(rows.length, 30);
  rows.forEach((r, y) => {
    assert.equal(r.slice(0, 3), `${String(y).padStart(2)} `);
    assert.equal(r.length, 3 + WIDTH);
  });
  assert.equal(rows[0], ' 0   ####TTT###TTT####  ');
  assert.equal(rows[7], ' 7 #....***.....***....#');
  assert.equal(rows[11], '11 T........***........T');
  assert.equal(rows[15], '15 #.........O.........#');
  assert.equal(rows[26], '26       #\\\\\\.///#      ');
  assert.equal(rows[29], '29       #.......#      ');
  assert.equal(lines.at(-1), 'Action:');
  assert.ok(!g.buildUserMessage().includes('Flipper ETA'));

  // Table is mirror-symmetric apart from the flipper glyphs and the ball.
  for (const r of g.tableRows()) {
    const plain = r.replace(/O/g, '.').replace(/[\\/]/g, '|');
    assert.equal(plain, [...plain].reverse().join(''));
  }

  place(g, 10.5, 5, 0, 0);
  g.step('L');
  lines = g.buildUserMessage().split('\n');
  assert.equal(lines[1], 'Last action: L (ok)');
  assert.equal(lines[2], `Flippers: left UP (held 1/${OVERHEAT_STEPS}), right down`);
  const table = g.tableRows();
  assert.ok(table[23].includes('/') && table[24].includes('/'), 'raised left flipper drawn as /');
  assert.ok(table[26].includes('///'), 'resting right flipper drawn as /');
});

test('aux info: flipper ETA and ball trail', () => {
  const g = new Game({ seed: 9 });
  place(g, 8, 18, 0, 5);
  const msg = g.buildUserMessage({ eta: true, trail: true });
  assert.match(msg, /Flipper ETA: with no flipper pressed the ball reaches flipper height \(y >= 22\.5\) in \d steps? at x=\d+\.\d \(left flipper\)/);
  assert.match(msg, /Trail: o = ball position 1 and 2 steps ago\n\nAction:$/);
  const p = g.predictFlipperArrival();
  // The prediction matches what actually happens without pressing anything.
  for (let i = 0; i < p.steps; i++) g.step('N');
  assert.ok(g.ball.y >= 22.5);
  assert.ok(Math.abs(g.ball.x - p.x) < 1);
  assert.equal(g.tableRows({ trail: true }).join('').split('o').length - 1, 2);

  place(g, 12.5, 23, 0, 2);
  assert.match(g.etaText(), /now .* right flipper/);
});

test('policy comparison: timing flips clearly beats random, idle, hold-both and flailing', () => {
  const policies = {
    random: (g, r) => (r() < 0.1 ? null : 'LRBN'[Math.floor(r() * 4)]),
    idle: () => 'N',
    holdBoth: () => 'B',
    flail: (g) => (g.steps % 2 ? 'B' : 'N'),
    heuristic,
  };
  const seeds = [0, 1, 2, 3, 4, 5, 6, 7];
  const avg = {};
  for (const [name, pol] of Object.entries(policies)) {
    avg[name] = seeds.reduce((s, seed) => s + play(seed, pol).score, 0) / seeds.length;
  }
  console.log('pinball average scores:', JSON.stringify(Object.fromEntries(Object.entries(avg).map(([k, v]) => [k, Math.round(v)]))));
  for (const name of ['random', 'idle', 'holdBoth', 'flail']) {
    assert.ok(avg.heuristic > 2 * Math.max(avg[name], 0) + 1000, `heuristic ${avg.heuristic} vs ${name} ${avg[name]}`);
  }
});

test('system prompt lists the actions and the step length matches', () => {
  assert.match(SYSTEM_PROMPT, /Reply with exactly ONE letter from: L R B N/);
  assert.equal(STEP_SECONDS, 0.1);
  const g = new Game({ seed: 0 });
  const [tx] = flipperTip(g.left);
  assert.ok(tx < 10.5 && tx > 8.5);
});

test('decision question: hits, misses and drains per action', () => {
  const g = new Game({ seed: 1 });
  Object.assign(g.ball, { x: 8, y: 24, vx: 0, vy: 3 });
  const { criteria } = decisionQuestion(g);
  assert.match(criteria.L, /^left flipper up: the swing hits the ball; ball then at .* moving up/);
  assert.match(criteria.R, /^right flipper up: the swing misses the ball \(-20 points\)/);
  assert.match(criteria.B, /one swing hits the ball; the other swing misses the ball \(-20 points\)/);
  assert.match(criteria.N, /^no flipper: ball then at .* moving down; with no more flips it drains in \d+ steps$/);
  assert.equal(g.steps, 0);
  assert.equal(g.ball.y, 24);
});

// Copy for what-if play (a drain launches from a dummy stream instead of the real one).
function copy(game) {
  const g = Object.create(Game.prototype);
  Object.assign(g, game);
  g.rand = () => 0.5;
  g.flippers = game.flippers.map((f) => ({ ...f }));
  g.state = { ball: { ...game.ball }, flippers: g.flippers };
  g.lit = [...game.lit];
  return g;
}

test('a ball no flipper can reach drains within the step; the play-out turns still count', () => {
  const g = new Game({ seed: 10, balls: 2 });
  place(g, 10.5, 27, 0, 3); // below the flippers in the drain
  assert.equal(g.drainIsCertain(), true);
  const ref = copy(g);
  ref.rand = new Game({ seed: 10 }).rand; // the reference launches the same second ball
  let refEv = ref.advance('L');
  while (!refEv.drained) refEv = ref.advance('N');
  const ev = g.step('L');
  assert.equal(ev.drained, true);
  assert.equal(ev.misses, 1);
  assert.equal(g.ballNo, 2);
  assert.ok(g.steps > 1);
  assert.equal(g.steps, ref.steps);
  assert.equal(g.score, POINTS.miss);
  assert.equal(g.score, ref.score);
  assert.deepEqual(g.ball, ref.ball);
  assert.ok(g.frames.some((f) => f.y > 29) && g.frames.at(-1).jump, 'whole drain animated, then the new ball');

  // Last ball: the game ends at once. Every option of the decision question already says so.
  place(g, 10.5, 27, 0, 3);
  for (const a of ACTIONS) assert.match(decisionQuestion(g).criteria[a], /the ball drains and the game ends$/);
  g.step('N');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'drained');
  assert.equal(g.score, POINTS.miss);

  // The play-out stops at the step limit like the turns it replaces would.
  const h = new Game({ seed: 10, maxSteps: 2 });
  place(h, 10.5, 25.5, 0, 0);
  assert.equal(h.drainIsCertain(), true);
  h.step('N');
  assert.equal(h.over, true);
  assert.equal(h.endReason, 'limit');
  assert.equal(h.steps, 2);
  assert.equal(h.ballNo, 1);

  // A ball a flipper can still reach is left to the player.
  const k = new Game({ seed: 10 });
  place(k, 8, 24, 0, 3);
  assert.equal(k.drainIsCertain(), false);
  k.step('N');
  assert.equal(k.ballNo, 1);
});

test('a drain is only played out when every input sequence gives the same result', () => {
  // After the chosen turn, every flipper input over the played-out turns drains on the same turn,
  // with the same points apart from the miss penalties.
  const check = (start, turns) => {
    const outcomes = new Set();
    const walk = (g, n) => {
      for (const a of ACTIONS) {
        const c = copy(g);
        const ev = c.advance(a);
        if (ev.drained || n === turns) {
          outcomes.add(`${n} ${ev.drained} ${c.score - c.misses * POINTS.miss}`);
          continue;
        }
        walk(c, n + 1);
      }
    };
    walk(start, 1);
    return [...outcomes];
  };
  let forced = 0;
  for (let seed = 0; seed < 6; seed++) {
    const g = new Game({ seed, maxSteps: 300 });
    while (!g.over) {
      const before = copy(g);
      const action = heuristic(g);
      const ev = g.step(action);
      const turns = g.steps - before.steps;
      if (turns === 1) continue;
      forced += 1;
      assert.ok(ev.drained || g.over);
      const ref = copy(before);
      ref.advance(action);
      const after = copy(ref); // the chosen turn is played as asked; the rest is forced
      while (ref.steps < g.steps) ref.advance('N');
      assert.deepEqual(check(after, turns - 1), [`${turns - 1} ${ev.drained} ${ref.score - ref.misses * POINTS.miss}`]);
    }
  }
  assert.ok(forced > 5, `only ${forced} played-out drains`);
});
