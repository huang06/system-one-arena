import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, createBag, decisionQuestion, parseAction, pieceCells, PIECE_TYPES, HEIGHT, WIDTH } from '../public/games/tetris/engine.js';

const fill = (game, rows) => {
  // rows: strings from the bottom of the board upward, '#' = filled
  rows.forEach((r, i) => {
    game.board[HEIGHT - 1 - i] = [...r].map((c) => (c === '#' ? 'X' : null));
  });
};

test('parseAction mirrors response.strip()[:1].upper()', () => {
  assert.equal(parseAction('L'), 'L');
  assert.equal(parseAction(' s'), 'S');
  assert.equal(parseAction('\nRight'), 'R');
  assert.equal(parseAction('u'), 'U');
  assert.equal(parseAction(''), null);
  assert.equal(parseAction('   '), null);
  assert.equal(parseAction('X'), null);
  assert.equal(parseAction('1'), null);
  assert.equal(parseAction(null), null);
});

test('7-bag: each group of 7 is a permutation and same seed gives same sequence', () => {
  const a = createBag(123);
  const b = createBag(123);
  const seqA = Array.from({ length: 70 }, a);
  const seqB = Array.from({ length: 70 }, b);
  assert.deepEqual(seqA, seqB);
  for (let i = 0; i < 70; i += 7) {
    assert.deepEqual([...seqA.slice(i, i + 7)].sort(), [...PIECE_TYPES].sort());
  }
  const other = Array.from({ length: 70 }, createBag(124));
  assert.notDeepEqual(seqA, other);
});

test('pieces spawn inside the top of the board', () => {
  for (const type of PIECE_TYPES) {
    const g = new Game();
    g.current = { type, rot: 0, x: 3, y: type === 'I' ? -1 : 0 };
    assert.ok(g.fits(g.current), type);
    const ys = pieceCells(g.current).map(([, y]) => y);
    assert.equal(Math.min(...ys), 0, type);
  }
});

test('move + gravity, blocked moves, and step counter', () => {
  const g = new Game({ seed: 1 });
  g.current = { type: 'O', rot: 0, x: 3, y: 0 }; // cols 4-5
  let ev = g.step('L');
  assert.equal(ev.result, 'ok');
  assert.deepEqual([g.current.x, g.current.y], [2, 1]); // moved left, then fell one row
  g.step('L');
  g.step('L');
  g.step('L'); // x = -1 -> cells at cols 0-1
  ev = g.step('L');
  assert.equal(ev.result, 'blocked');
  assert.equal(g.pieceStep, 5);
  assert.deepEqual(g.lastAction, { action: 'L', result: 'blocked' });
});

test('D moves down plus gravity; illegal output is a no-op that still falls', () => {
  const g = new Game({ seed: 1 });
  g.current = { type: 'T', rot: 0, x: 3, y: 0 };
  g.step('D');
  assert.equal(g.current.y, 2);
  const ev = g.step(null);
  assert.equal(ev.result, 'invalid');
  assert.equal(g.current.y, 3);
  assert.match(g.buildUserMessage(), /Last action: invalid output \(no-op\)/);
});

test('hard drop locks at ghost and clears lines with guideline scores', () => {
  const g = new Game({ seed: 1 });
  fill(g, ['####.#####', '####.#####', '####.#####', '####.#####']);
  g.current = { type: 'I', rot: 1, x: 2, y: 0 }; // vertical in column 4
  const ev = g.step('S');
  assert.equal(ev.locked, true);
  assert.equal(ev.cleared, 4);
  assert.equal(g.score, 800);
  assert.equal(g.lines, 4);
  assert.equal(g.pieces, 1);
  assert.ok(g.board.every((row) => row.every((c) => c === null)));

  const g2 = new Game({ seed: 1 });
  fill(g2, ['########..']);
  g2.current = { type: 'O', rot: 0, x: 7, y: 0 }; // cols 8-9
  g2.step('S');
  assert.equal(g2.score, 100);
});

test('piece resting on the stack locks during gravity', () => {
  const g = new Game({ seed: 1 });
  g.current = { type: 'O', rot: 0, x: 3, y: HEIGHT - 2 };
  const ev = g.step('L');
  assert.equal(ev.result, 'ok');
  assert.equal(ev.locked, true);
  assert.equal(g.board[HEIGHT - 1][3], 'O');
  assert.equal(g.pieces, 1);
});

test('rotation uses SRS kicks off the wall and reports blocked when impossible', () => {
  const g = new Game({ seed: 1 });
  // Vertical I hugging the left wall: rotating back to horizontal needs a kick.
  g.current = { type: 'I', rot: 3, x: -1, y: 5 };
  assert.ok(g.fits(g.current));
  assert.equal(g.tryRotate(), true);
  assert.ok(pieceCells(g.current).every(([x]) => x >= 0 && x < WIDTH));

  const g2 = new Game({ seed: 1 });
  // T in a 3-wide slot that has no room to rotate.
  g2.board = g2.board.map(() => Array(WIDTH).fill('X'));
  g2.current = { type: 'T', rot: 0, x: 3, y: 10 };
  for (const [x, y] of pieceCells(g2.current)) g2.board[y][x] = null;
  assert.equal(g2.tryRotate(), false);
});

test('auto hard drop after the per-piece step cap', () => {
  const g = new Game({ seed: 1, maxStepsPerPiece: 3 });
  g.current = { type: 'O', rot: 0, x: 3, y: 0 };
  g.step('L');
  g.step('R');
  const ev = g.step('L');
  assert.equal(ev.autoDrop, true);
  assert.equal(ev.locked, true);
  assert.equal(g.pieces, 1);
  assert.equal(g.pieceStep, 0);
});

test('top out when the spawn area is blocked, and piece limit M ends the game', () => {
  const g = new Game({ seed: 1 });
  for (let y = 0; y < 2; y++) g.board[y] = Array(WIDTH).fill(null).map((_, x) => (x === 5 ? 'X' : null));
  g.board[HEIGHT - 1] = Array(WIDTH).fill(null);
  g.current = { type: 'O', rot: 0, x: 0, y: 0 }; // not overlapping column 5
  g.step('S');
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'topout');
  assert.throws(() => g.step('S'));

  const lim = new Game({ seed: 1, maxPieces: 3 });
  lim.step('S');
  assert.equal(lim.over, false);
  lim.step('S');
  // The last piece can clear no line on this board, so it is dropped at once (see below).
  assert.equal(lim.over, true);
  assert.equal(lim.endReason, 'limit');
  assert.equal(lim.pieces, 3);
});

test('a piece whose every placement ends the game with the same lines cleared is dropped at once', () => {
  // Column 5 blocks the spawn area: wherever the O lands, the next piece tops out.
  const g = new Game({ seed: 1 });
  for (let y = 0; y < 2; y++) g.board[y][5] = 'X';
  g.current = { type: 'O', rot: 0, x: 0, y: 0 }; // cols 1-2
  const ev = g.step('L');
  assert.deepEqual(ev, { piece: 'O', action: 'L', result: 'ok', locked: true, cleared: 0, autoDrop: true });
  assert.equal(g.over, true);
  assert.equal(g.endReason, 'topout');
  assert.equal(g.steps, 1);
  assert.deepEqual([g.board[18][0], g.board[19][1]], ['O', 'O']); // dropped straight down, no further input

  // A line the O can still clear (+100) before topping out keeps the game going.
  const c = new Game({ seed: 1 });
  for (let y = 0; y < 2; y++) c.board[y][5] = 'X';
  fill(c, ['####..####']);
  c.current = { type: 'O', rot: 0, x: 0, y: 0 };
  c.step('L');
  assert.equal(c.over, false);
  for (let i = 0; i < 4; i++) c.step('R');
  c.step('S'); // cols 4-5, under the blocked spawn cells
  assert.equal(c.score, 100);
  assert.equal(c.endReason, 'topout');

  // The last piece (limit M) ends the game whatever it does, so only the lines it can clear matter.
  const last = new Game({ seed: 1, maxPieces: 1 });
  assert.equal(last.over, false);
  last.step(null);
  assert.equal(last.over, true);
  assert.equal(last.endReason, 'limit');
  assert.equal(last.steps, 1);
  const clear = new Game({ seed: 1, maxPieces: 1 });
  fill(clear, ['######....']);
  clear.current = { type: 'I', rot: 0, x: 3, y: -1 }; // cols 3-6
  clear.step('R');
  assert.equal(clear.over, false);
  clear.step('R');
  clear.step('R'); // cols 6-9
  clear.step('S');
  assert.equal(clear.score, 100);
  assert.equal(clear.endReason, 'limit');
});

test('user message format: 20 labelled rows, ghost, optional aux info', () => {
  const g = new Game({ seed: 7 });
  fill(g, ['####.####.', '.####.#...']);
  g.current = { type: 'T', rot: 0, x: 2, y: 14 };
  g.next = 'S';
  g.pieceStep = 3;
  g.lastAction = { action: 'L', result: 'ok' };
  const msg = g.buildUserMessage();
  const lines = msg.split('\n');
  assert.equal(lines[0], 'Piece: T  Next: S  Step: 4/30');
  assert.equal(lines[1], 'Last action: L (ok)');
  assert.equal(lines[3], '   0123456789');
  assert.equal(lines[4], ' 0 ..........');
  assert.equal(lines[4 + 14], '14 ...@......');
  assert.equal(lines[4 + 15], '15 ..@@@.....');
  assert.equal(lines[4 + 16], '16 ...+......');
  assert.equal(lines[4 + 17], '17 ..+++.....');
  assert.equal(lines[4 + 18], '18 .####.#...');
  assert.equal(lines[4 + 19], '19 ####.####.');
  assert.equal(lines.at(-1), 'Action:');
  assert.ok(!msg.includes('Column heights'));
  assert.ok(!msg.includes('Holes'));

  const full = g.buildUserMessage({ showHeights: true, showHoles: true });
  assert.match(full, /Column heights: 1 2 2 2 2 1 2 1 1 0/);
  assert.match(full, /Holes: 1/);
  assert.match(full, /Holes: 1\n\nAction:$/);
});

test('first message says Last action: none', () => {
  const g = new Game({ seed: 3 });
  assert.match(g.buildUserMessage(), /^Piece: [IOTSZJL] {2}Next: [IOTSZJL] {2}Step: 1\/30\nLast action: none\n/);
});

test('same seed + same actions give identical games', () => {
  const run = () => {
    const g = new Game({ seed: 99, maxPieces: 50 });
    const actions = 'LLURSDRRSUULSRRRDS';
    let i = 0;
    while (!g.over) g.step(actions[i++ % actions.length]);
    return [g.score, g.lines, g.pieces, g.steps, g.boardRows().join('')];
  };
  assert.deepEqual(run(), run());
});

test('decision question: steps to the best placement per action', () => {
  const g = new Game({ seed: 1 });
  g.current = { type: 'O', rot: 0, x: -1, y: 0 };
  for (const y of [18, 19]) for (let x = 2; x < 10; x++) g.board[y][x] = 'I';
  const { criteria } = decisionQuestion(g);
  assert.deepEqual(Object.keys(criteria), ['L', 'R', 'U', 'D', 'S']);
  assert.equal(criteria.S, 'hard drop now: clears 2 lines (+300), no new holes, stack height 0, this is the best placement');
  assert.equal(
    criteria.R,
    'move right: piece in columns 1-2; the best placement (clears 2 lines (+300), no new holes, stack height 0) is then 2 more steps away',
  );
  assert.match(criteria.L, /^move left \(blocked\): piece in columns 0-1; .* is then 1 more step away$/);
  assert.equal(g.current.x, -1);
  assert.equal(g.board[0].every((c) => c === null), true);

  // Following the fewest-steps option clears lines instead of topping out.
  const h = new Game({ seed: 2, maxPieces: 30 });
  const cost = (t) => (/this is the best placement/.test(t) ? 0 : Number(t.match(/is then (\d+) more step/)?.[1] ?? 99));
  while (!h.over) {
    const q = decisionQuestion(h).criteria;
    h.step(Object.keys(q).reduce((a, b) => (cost(q[b]) < cost(q[a]) ? b : a)));
  }
  assert.equal(h.endReason, 'limit');
  assert.ok(h.lines >= 5, `lines ${h.lines}`);
});
