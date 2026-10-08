// Pinball engine shared by the browser UI and the Node tests.
// Coordinates are in cells: x = column (0..21, left to right), y = row (0..30, top to bottom).
// Gravity pulls toward +y. One step = 0.1 s of game time = SUBSTEPS fixed physics ticks with the
// chosen flipper buttons held.
import { mulberry32 } from '../tetris/engine.js';

export const WIDTH = 21;
export const HEIGHT = 30;
export const ACTIONS = 'LRBN';
export const STEP_SECONDS = 0.1;
export const SUBSTEPS = 100;
export const OVERHEAT_STEPS = 10; // a flipper held longer than this drops until released
export const DEFAULT_BALLS = 3;
export const DEFAULT_MAX_STEPS = 1000;
export const BALL_RADIUS = 0.45;
export const GRAVITY = 25; // cells / s^2
export const MAX_SPEED = 60; // cells / s
export const FLIPPER_ZONE_Y = 22.5; // "flipper height" used by the ETA hint
export const MAX_MULTIPLIER = 5;
export const FLIPPER_LENGTH = 3.6;
export const FLIPPER_RADIUS = 0.3;
export const POINTS = { bumper: 100, target: 250, litTarget: 50, bank: 1000, miss: -20 };

const DT = STEP_SECONDS / SUBSTEPS;
const FRAME_EVERY = 10; // substeps between recorded animation frames
const DRAIN_Y = HEIGHT + BALL_RADIUS;
const WALL_E = 0.45; // restitution
const TARGET_E = 0.6;
const FLIPPER_E = 0.35;
const BUMPER_KICK = 22; // minimum outgoing normal speed off a bumper
const FLIPPER_UP_SPEED = 14; // rad / s
const FLIPPER_DOWN_SPEED = 12;
const DEG = Math.PI / 180;

export const SYSTEM_PROMPT = `You are playing pinball. Each turn you choose which flippers to hold up for the next 0.1 seconds.

Actions:
L = left flipper up
R = right flipper up
B = both flippers up
N = no flipper (both down)

A pressed flipper swings up at once; a released flipper falls back down.
Every swing (a flipper going up) that does not touch the ball costs ${-POINTS.miss} points, so flip only when the ball is on or just above a flipper.
A flipper held up for more than ${OVERHEAT_STEPS} turns in a row overheats and drops until you release it for one turn.

Table legend (x = column, y = row; y grows downward and gravity pulls the ball down):
# = wall
* = bumper (${POINTS.bumper} points)
T = unlit target (${POINTS.target} points, lights it); t = lit target
\\ / = flipper, drawn at its current angle
O = ball
. = open table
The left flipper pivots at x=6 y=25 and the right flipper at x=15 y=25; each is ${FLIPPER_LENGTH} cells long and points toward the centre.

The ball drains through the gap between the two flippers at the bottom. When your last ball drains the game ends.
Lighting all 4 targets gives a bonus and raises the score multiplier.
Tip: when the ball comes down onto a flipper, press that flipper to shoot it back up the table.

Reply with exactly ONE letter from: L R B N
No other text.`;

// ---------- table geometry ----------

const LEFT_PIVOT = { x: 6, y: 25 };
const PIVOT_RADIUS = 0.35;
const RIGHT_PIVOT = { x: 15, y: 25 };
const LEFT_REST = 30 * DEG;
const LEFT_UP = -28 * DEG;

function arcPoints(cx, cy, r, a0, a1, n) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (a0 + ((a1 - a0) * i) / n) * DEG;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

// Outer wall as one polyline from the left inlane guide, over the top, to the right guide.
// The 45-degree guides end tangent to the pivot caps so a rolling ball has no bump to rest against.
const GUIDE_END = PIVOT_RADIUS * Math.SQRT1_2;
const GUIDE_TOP = LEFT_PIVOT.y - (LEFT_PIVOT.x - 0.5) - 2 * GUIDE_END; // where the guide meets the side wall
const WALL_PATH = [
  [LEFT_PIVOT.x + GUIDE_END, LEFT_PIVOT.y - GUIDE_END],
  [0.5, GUIDE_TOP],
  ...arcPoints(4, 4, 3.5, 180, 270, 6),
  ...arcPoints(17, 4, 3.5, 270, 360, 6),
  [20.5, GUIDE_TOP],
  [RIGHT_PIVOT.x - GUIDE_END, RIGHT_PIVOT.y - GUIDE_END],
];

// Standup targets sit on top of the wall; the wall behind them is still solid.
export const TARGETS = [
  { x1: 0.5, y1: 11, x2: 0.5, y2: 14 }, // left wall, rows 11-13
  { x1: 6, y1: 0.5, x2: 9, y2: 0.5 }, // top, columns 6-8
  { x1: 12, y1: 0.5, x2: 15, y2: 0.5 }, // top, columns 12-14
  { x1: 20.5, y1: 11, x2: 20.5, y2: 14 }, // right wall, rows 11-13
];

export const BUMPERS = [
  { x: 6.5, y: 7.5, r: 1.3 },
  { x: 14.5, y: 7.5, r: 1.3 },
  { x: 10.5, y: 11.5, r: 1.3 },
];

export const WALLS = [];
for (let i = 1; i < WALL_PATH.length; i++) {
  const [x1, y1] = WALL_PATH[i - 1];
  const [x2, y2] = WALL_PATH[i];
  WALLS.push({ x1, y1, x2, y2 });
}
// Aprons below the flipper pivots enclose the drain.
WALLS.push({ x1: LEFT_PIVOT.x, y1: LEFT_PIVOT.y, x2: LEFT_PIVOT.x, y2: HEIGHT });
WALLS.push({ x1: RIGHT_PIVOT.x, y1: RIGHT_PIVOT.y, x2: RIGHT_PIVOT.x, y2: HEIGHT });

// Closed outline of the playfield (for rendering and "inside" tests).
export const OUTLINE = [
  ...WALL_PATH,
  [RIGHT_PIVOT.x, RIGHT_PIVOT.y],
  [RIGHT_PIVOT.x, HEIGHT],
  [LEFT_PIVOT.x, HEIGHT],
  [LEFT_PIVOT.x, LEFT_PIVOT.y],
];

export function insideTable(x, y) {
  let inside = false;
  for (let i = 0, j = OUTLINE.length - 1; i < OUTLINE.length; j = i++) {
    const [xi, yi] = OUTLINE[i];
    const [xj, yj] = OUTLINE[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function newFlipper(side) {
  const left = side === 'left';
  return {
    side,
    px: left ? LEFT_PIVOT.x : RIGHT_PIVOT.x,
    py: left ? LEFT_PIVOT.y : RIGHT_PIVOT.y,
    rest: left ? LEFT_REST : Math.PI - LEFT_REST,
    upAngle: left ? LEFT_UP : Math.PI - LEFT_UP,
    angle: left ? LEFT_REST : Math.PI - LEFT_REST,
    omega: 0,
    up: false, // commanded and powered this step
    held: 0, // consecutive steps the button has been held
    overheated: false,
  };
}

export function flipperTip(f) {
  return [f.px + FLIPPER_LENGTH * Math.cos(f.angle), f.py + FLIPPER_LENGTH * Math.sin(f.angle)];
}

// ---------- physics ----------

// Pushes the ball out of a contact with a round obstacle of radius rad centred at (qx, qy)
// (a point, or the closest point of a segment) moving with velocity (vcx, vcy).
// Returns the normal approach speed (negative = was moving into it), or null without contact.
function contact(ball, qx, qy, rad, e, vcx = 0, vcy = 0) {
  let nx = ball.x - qx;
  let ny = ball.y - qy;
  const min = rad + BALL_RADIUS;
  const d2 = nx * nx + ny * ny;
  if (d2 >= min * min) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-9) {
    nx = 0;
    ny = -1;
  } else {
    nx /= d;
    ny /= d;
  }
  ball.x = qx + nx * min;
  ball.y = qy + ny * min;
  const vn = (ball.vx - vcx) * nx + (ball.vy - vcy) * ny;
  if (vn < 0) {
    ball.vx -= (1 + e) * vn * nx;
    ball.vy -= (1 + e) * vn * ny;
  }
  contact.nx = nx;
  contact.ny = ny;
  return vn;
}

function closest(ball, s) {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t = ((ball.x - s.x1) * dx + (ball.y - s.y1) * dy) / (dx * dx + dy * dy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return [s.x1 + t * dx, s.y1 + t * dy];
}

// Advances { ball, flippers } by one physics tick. hits (optional) collects events.
function tick(state, hits) {
  const { ball, flippers } = state;
  for (const f of flippers) {
    const target = f.up ? f.upAngle : f.rest;
    const diff = target - f.angle;
    const max = (f.up ? FLIPPER_UP_SPEED : FLIPPER_DOWN_SPEED) * DT;
    const d = Math.abs(diff) <= max ? diff : Math.sign(diff) * max;
    f.angle += d;
    f.omega = d / DT;
  }

  ball.vy += GRAVITY * DT;
  ball.x += ball.vx * DT;
  ball.y += ball.vy * DT;

  for (let i = 0; i < TARGETS.length; i++) {
    const [qx, qy] = closest(ball, TARGETS[i]);
    const vn = contact(ball, qx, qy, 0, TARGET_E);
    if (vn !== null && vn < -3 && hits) hits.targets.add(i);
  }
  // Walls after targets, so the target in front of a wall sees the impact.
  for (const w of WALLS) {
    const [qx, qy] = closest(ball, w);
    contact(ball, qx, qy, 0, WALL_E);
  }
  for (let i = 0; i < BUMPERS.length; i++) {
    const bm = BUMPERS[i];
    const vn = contact(ball, bm.x, bm.y, bm.r, WALL_E);
    if (vn === null) continue;
    const out = ball.vx * contact.nx + ball.vy * contact.ny;
    if (out < BUMPER_KICK) {
      ball.vx += (BUMPER_KICK - out) * contact.nx;
      ball.vy += (BUMPER_KICK - out) * contact.ny;
    }
    if (hits) hits.bumpers.add(i);
  }
  for (const f of flippers) {
    contact(ball, f.px, f.py, PIVOT_RADIUS, WALL_E);
    const [tx, ty] = flipperTip(f);
    const [qx, qy] = closest(ball, { x1: f.px, y1: f.py, x2: tx, y2: ty });
    // Velocity of the flipper surface at the contact point: omega x r.
    const vn = contact(ball, qx, qy, FLIPPER_RADIUS, FLIPPER_E, -f.omega * (qy - f.py), f.omega * (qx - f.px));
    if (vn !== null && hits) hits.touched.add(f.side);
  }

  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > MAX_SPEED) {
    ball.vx *= MAX_SPEED / speed;
    ball.vy *= MAX_SPEED / speed;
  }
  return ball.y > DRAIN_Y;
}

// A ball centre this close to a flipper's centre line touches it.
const FLIPPER_REACH = FLIPPER_RADIUS + BALL_RADIUS;
const REACH_MARGIN = 0.05; // rounding slack on top of the reach
const CERTAIN_DRAIN_STEPS = 8; // how far drainIsCertain follows the ball

// Distance from (x, y) to the sector a flipper's centre line sweeps between rest and up (right
// mirrored onto left). Outside the sector the nearest point is on one of its edges.
function sweptDistance(f, x, y) {
  const p = { x: f.side === 'left' ? x - f.px : f.px - x, y: y - f.py };
  const a = Math.atan2(p.y, p.x);
  if (a >= LEFT_UP && a <= LEFT_REST) return Math.max(0, Math.hypot(p.x, p.y) - FLIPPER_LENGTH);
  const edge = (ang) => {
    const [qx, qy] = closest(p, { x1: 0, y1: 0, x2: FLIPPER_LENGTH * Math.cos(ang), y2: FLIPPER_LENGTH * Math.sin(ang) });
    return Math.hypot(p.x - qx, p.y - qy);
  };
  return Math.min(edge(LEFT_UP), edge(LEFT_REST));
}

// ---------- parsing ----------

// response.strip()[:1].upper(); returns null when not one of LRBN.
export function parseAction(raw) {
  const ch = String(raw ?? '').trim().slice(0, 1).toUpperCase();
  return ch && ACTIONS.includes(ch) ? ch : null;
}

const fmt = (v) => v.toFixed(1);
const signed = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);

// ---------- game ----------

export class Game {
  constructor({ seed = 0, balls = DEFAULT_BALLS, maxSteps = DEFAULT_MAX_STEPS } = {}) {
    this.rand = mulberry32(seed);
    this.totalBalls = balls;
    this.maxSteps = maxSteps;
    this.flippers = [newFlipper('left'), newFlipper('right')];
    this.score = 0;
    this.multiplier = 1;
    this.lit = TARGETS.map(() => false);
    this.bumperHits = 0;
    this.targetHits = 0;
    this.banks = 0;
    this.shots = 0; // flipper swings that touched the ball
    this.misses = 0; // flipper swings that did not
    this.ballNo = 0; // 1-based index of the ball in play
    this.ballScore = 0;
    this.bestBall = 0;
    this.steps = 0;
    this.over = false;
    this.endReason = null; // 'drained' | 'limit'
    this.lastAction = null; // { action, result }
    this.frames = []; // animation frames of the last step: { x, y, la, ra, jump? }
    this.history = []; // ball positions at the start of recent steps (for the trail hint)
    this.bumperFlash = BUMPERS.map(() => -Infinity); // step of last hit
    this.targetFlash = TARGETS.map(() => -Infinity);
    this.launch();
  }

  get ball() {
    return this.state.ball;
  }

  get left() {
    return this.flippers[0];
  }

  get right() {
    return this.flippers[1];
  }

  get ballsLeft() {
    return this.totalBalls - this.ballNo; // in reserve, not counting the ball in play
  }

  // Seeded launch: the ball enters near the top with a random position and sideways speed.
  launch() {
    this.ballNo += 1;
    this.ballScore = 0;
    this.history = [];
    this.flippers = [newFlipper('left'), newFlipper('right')];
    const x = 3 + 15 * this.rand();
    const vx = (this.rand() * 2 - 1) * 12;
    const vy = this.rand() * 4;
    this.state = { ball: { x, y: 2.5, vx, vy }, flippers: this.flippers };
    this.frames = [this.frame()];
  }

  frame() {
    return { x: this.ball.x, y: this.ball.y, la: this.left.angle, ra: this.right.angle };
  }

  addPoints(p) {
    const pts = p * this.multiplier;
    this.score += pts;
    this.ballScore += pts;
    this.bestBall = Math.max(this.bestBall, this.ballScore);
  }

  // One turn (see advance). Once no flipper can reach the ball before it drains, the drain is
  // played out now with flippers released; those turns still count toward the step limit.
  step(action) {
    const ev = this.advance(action);
    if (ev.drained || this.over || !this.drainIsCertain()) return ev;
    const frames = this.frames;
    while (!this.over && !ev.drained) {
      const more = this.advance('N');
      frames.push(...this.frames.slice(1)); // each turn's first frame repeats the previous last one
      ev.bumpers += more.bumpers;
      ev.targets += more.targets;
      ev.bank ||= more.bank;
      ev.drained = more.drained;
    }
    this.frames = frames;
    return ev;
  }

  // True when the ball drains whatever the player does: followed with flippers released, it never
  // comes within reach of any flipper's sweep. Gives up (false) after CERTAIN_DRAIN_STEPS turns.
  // Only checks a ball at flipper height and not rising, which covers nearly all cases cheaply.
  drainIsCertain() {
    if (this.ball.y < FLIPPER_ZONE_Y || this.ball.vy < 0) return false;
    const state = { ball: { ...this.ball }, flippers: this.flippers.map((f) => ({ ...f, up: false })) };
    for (let i = 0; i < CERTAIN_DRAIN_STEPS * SUBSTEPS; i++) {
      if (tick(state)) return true;
      if (state.flippers.some((f) => sweptDistance(f, state.ball.x, state.ball.y) < FLIPPER_REACH + REACH_MARGIN)) {
        return false;
      }
    }
    return false;
  }

  // One raw turn: hold the chosen flippers (null = illegal output -> no-op, both released) for
  // SUBSTEPS ticks. A drained ball ends the turn early and the next ball is launched.
  advance(action) {
    if (this.over) throw new Error('game is over');
    this.steps += 1;
    let result = action === null ? 'invalid' : 'ok';
    const want = [action === 'L' || action === 'B', action === 'R' || action === 'B'];
    const wasUp = this.flippers.map((f) => f.up);
    this.flippers.forEach((f, i) => {
      if (want[i]) {
        f.held += 1;
        if (f.held > OVERHEAT_STEPS) f.overheated = true;
        if (f.overheated) result = 'overheat';
      } else {
        f.held = 0;
        f.overheated = false;
      }
      f.up = want[i] && !f.overheated;
    });
    const swings = this.flippers.map((f, i) => f.up && !wasUp[i]);

    this.history = [[this.ball.x, this.ball.y], ...this.history].slice(0, 2);
    // A bumper or target counts at most once per step (a contact lasts a few ticks).
    const hits = { bumpers: new Set(), targets: new Set(), touched: new Set() };
    const before = { bumpers: 0, targets: 0 };
    this.frames = [this.frame()];
    let drained = false;
    const ev = { bumpers: 0, targets: 0, bank: false };
    for (let i = 1; i <= SUBSTEPS && !drained; i++) {
      drained = tick(this.state, hits);
      // Score new contacts right away so a bank completed mid-step multiplies later hits.
      if (hits.bumpers.size > before.bumpers || hits.targets.size > before.targets) {
        this.scoreHits(hits, before, ev);
      }
      if (i % FRAME_EVERY === 0 || drained) this.frames.push(this.frame());
    }
    // A swing (flipper going up this step) that never touches the ball costs points.
    let shots = 0;
    let misses = 0;
    this.flippers.forEach((f, i) => {
      if (!swings[i]) return;
      if (hits.touched.has(f.side)) shots += 1;
      else misses += 1;
    });
    this.shots += shots;
    this.misses += misses;
    this.score += misses * POINTS.miss;
    this.ballScore += misses * POINTS.miss;

    this.lastAction = { action, result };
    const out = { action, result, bumpers: ev.bumpers, targets: ev.targets, bank: ev.bank, shots, misses, drained };
    if (drained) {
      if (this.ballNo >= this.totalBalls) {
        this.over = true;
        this.endReason = 'drained';
      } else {
        const frames = this.frames;
        this.launch();
        // Keep the drain animation; the new ball's first frame starts a new path.
        this.frames = [...frames, { ...this.frames[0], jump: true }];
      }
    }
    if (!this.over && this.steps >= this.maxSteps) {
      this.over = true;
      this.endReason = 'limit';
    }
    return out;
  }

  scoreHits(hits, before, ev) {
    const bumpers = [...hits.bumpers].slice(before.bumpers);
    const targets = [...hits.targets].slice(before.targets);
    before.bumpers = hits.bumpers.size;
    before.targets = hits.targets.size;
    for (const i of bumpers) {
      this.bumperHits += 1;
      ev.bumpers += 1;
      this.bumperFlash[i] = this.steps;
      this.addPoints(POINTS.bumper);
    }
    for (const i of targets) {
      this.targetHits += 1;
      ev.targets += 1;
      this.targetFlash[i] = this.steps;
      if (this.lit[i]) {
        this.addPoints(POINTS.litTarget);
        continue;
      }
      this.lit[i] = true;
      this.addPoints(POINTS.target);
      if (this.lit.every(Boolean)) {
        this.addPoints(POINTS.bank);
        this.banks += 1;
        ev.bank = true;
        this.multiplier = Math.min(MAX_MULTIPLIER, this.multiplier + 1);
        this.lit = TARGETS.map(() => false);
      }
    }
  }

  // Simulates with both flippers released until the ball reaches flipper height.
  // Returns { steps, x } (steps = 0 when already there) or null if not within maxSteps.
  predictFlipperArrival(maxSteps = 30) {
    if (this.ball.y >= FLIPPER_ZONE_Y) return { steps: 0, x: this.ball.x };
    const state = {
      ball: { ...this.ball },
      flippers: this.flippers.map((f) => ({ ...f, up: false })),
    };
    for (let s = 1; s <= maxSteps; s++) {
      for (let i = 0; i < SUBSTEPS; i++) {
        tick(state);
        if (state.ball.y >= FLIPPER_ZONE_Y) return { steps: s, x: state.ball.x };
      }
    }
    return null;
  }

  // HEIGHT strings of WIDTH chars.
  tableRows({ trail = false } = {}) {
    const rows = BASE_ROWS.map((r) => [...r]);
    const put = (x, y, ch) => {
      const c = cellColumn(x);
      const r = Math.floor(y);
      if (c >= 0 && c < WIDTH && r >= 0 && r < HEIGHT) rows[r][c] = ch;
    };
    TARGETS.forEach((t, i) => rasterize(t, (x, y) => put(x, y, this.lit[i] ? 't' : 'T')));
    for (const f of this.flippers) {
      const [tx, ty] = flipperTip(f);
      const dx = tx - f.px;
      const dy = ty - f.py;
      const ch = Math.abs(dy) < 0.2 * Math.abs(dx) ? '-' : dx * dy > 0 ? '\\' : '/';
      rasterize({ x1: f.px, y1: f.py, x2: tx, y2: ty }, (x, y) => put(x, y, ch));
    }
    if (trail) for (const [x, y] of [...this.history].reverse()) put(x, y, 'o');
    if (!this.over) put(this.ball.x, this.ball.y, 'O');
    return rows.map((r) => r.join(''));
  }

  flipperText(f) {
    if (f.overheated) return 'DOWN (overheated, release to reset)';
    if (f.up) return `UP (held ${f.held}/${OVERHEAT_STEPS})`;
    return 'down';
  }

  buildUserMessage({ eta = false, trail = false } = {}) {
    const last = this.lastAction;
    const lastText = !last
      ? 'none'
      : last.result === 'invalid'
        ? 'invalid output (no-op)'
        : `${last.action} (${last.result})`;
    const b = this.ball;
    const toStep = STEP_SECONDS; // cells/s -> cells/step
    const lines = [
      `Step: ${this.steps + 1}/${this.maxSteps}  Ball: ${this.ballNo}/${this.totalBalls} (${this.ballsLeft} left after this one)  Score: ${this.score}  Multiplier: x${this.multiplier}`,
      `Last action: ${lastText}`,
      `Flippers: left ${this.flipperText(this.left)}, right ${this.flipperText(this.right)}`,
      `Targets lit: ${this.lit.filter(Boolean).length}/${TARGETS.length}`,
      `Ball position: x=${fmt(b.x)} y=${fmt(b.y)} (column, row)`,
      `Ball velocity: vx=${signed(b.vx * toStep)} vy=${signed(b.vy * toStep)} (cells per step; +vx = right, +vy = down)`,
      '',
      `   ${Array.from({ length: WIDTH }, (_, x) => (x >= 10 ? Math.floor(x / 10) : ' ')).join('')}`,
      `   ${Array.from({ length: WIDTH }, (_, x) => x % 10).join('')}`,
      ...this.tableRows({ trail }).map((r, y) => `${String(y).padStart(2)} ${r}`),
      '',
    ];
    if (eta) lines.push(`Flipper ETA: ${this.etaText()}`);
    if (trail) lines.push('Trail: o = ball position 1 and 2 steps ago');
    if (eta || trail) lines.push('');
    lines.push('Action:');
    return lines.join('\n');
  }

  etaText() {
    const p = this.predictFlipperArrival();
    if (!p) return 'ball will not reach flipper height within 30 steps';
    const side = p.x < 9.6 ? 'left flipper' : p.x > 11.4 ? 'right flipper' : 'center gap (drain)';
    if (p.steps === 0) return `ball is at flipper height now (y >= ${FLIPPER_ZONE_Y}), above the ${side}`;
    return `with no flipper pressed the ball reaches flipper height (y >= ${FLIPPER_ZONE_Y}) in ${p.steps} step${p.steps > 1 ? 's' : ''} at x=${fmt(p.x)} (${side})`;
  }
}

// Decisions API question (see decisions.js): each action is simulated on a copy, then flippers
// stay down to see whether the ball drains. An unreachable ball drains within the step (Game.step).
export const DECISION_INSTRUCTIONS =
  'Which flippers should the player hold up next? Each option says what the flippers do to the ball this ' +
  'step and whether the ball drains if you stop flipping afterwards. Never let the ball drain when an ' +
  'option hits it back up; do not swing a flipper that misses the ball.';

const ACTION_NAMES = { L: 'left flipper up', R: 'right flipper up', B: 'both flippers up', N: 'no flipper' };
const DRAIN_LOOKAHEAD = 20; // steps

export function decisionQuestion(game) {
  const criteria = {};
  for (const a of ACTIONS) {
    const g = simCopy(game);
    const ev = g.step(a);
    const parts = [];
    game.flippers.forEach((f, i) => {
      const want = a === 'B' || a === (i === 0 ? 'L' : 'R');
      const now = g.flippers[i];
      if (want && now.overheated) parts.push(`the ${f.side} flipper overheats and drops`);
      else if (want && f.up) parts.push(`keeps the ${f.side} flipper up`);
      else if (!want && f.up) parts.push(`the ${f.side} flipper drops`);
    });
    const swing = ev.shots + ev.misses > 1 ? ['both swings', 'one swing', 'the other swing'] : ['the swing', 'the swing', 'the swing'];
    if (ev.shots) parts.push(`${ev.shots > 1 ? swing[0] : swing[1]} hit${ev.shots > 1 ? '' : 's'} the ball`);
    if (ev.misses) {
      const who = ev.misses > 1 ? `${swing[0]} miss` : `${ev.shots ? swing[2] : swing[1]} misses`;
      parts.push(`${who} the ball (${ev.misses * POINTS.miss} points)`);
    }
    const gained = g.score - game.score - ev.misses * POINTS.miss;
    if (gained > 0) parts.push(`+${gained} points from bumpers and targets`);
    if (ev.drained) {
      parts.push(game.ballsLeft ? 'the ball drains, losing it' : 'the ball drains and the game ends');
    } else {
      const b = g.ball;
      parts.push(`ball then at x=${fmt(b.x)} y=${fmt(b.y)} moving ${b.vy < 0 ? 'up' : 'down'}`);
      const drainIn = stepsToDrain(g);
      parts.push(drainIn === null
        ? `with no more flips it does not drain within ${DRAIN_LOOKAHEAD} steps`
        : `with no more flips it drains in ${drainIn} step${drainIn > 1 ? 's' : ''}`);
    }
    criteria[a] = `${ACTION_NAMES[a]}: ${parts.join('; ')}`;
  }
  return { instructions: DECISION_INSTRUCTIONS, criteria };
}

// Copy that can step without touching the real game (a drain launches a ball from a dummy stream).
function simCopy(game) {
  const g = Object.create(Game.prototype);
  Object.assign(g, game);
  g.rand = () => 0.5;
  g.flippers = game.flippers.map((f) => ({ ...f }));
  g.state = { ball: { ...game.ball }, flippers: g.flippers };
  g.lit = [...game.lit];
  g.history = [...game.history];
  g.bumperFlash = [...game.bumperFlash];
  g.targetFlash = [...game.targetFlash];
  return g;
}

function stepsToDrain(g) {
  for (let s = 1; s <= DRAIN_LOOKAHEAD && !g.over; s++) {
    if (g.advance('N').drained) return s;
  }
  return null;
}

// Column of x; a point exactly on a cell boundary goes to the cell nearer the centre line so
// that the mirror-symmetric table also renders symmetrically.
export const cellColumn = (x) => (x < WIDTH / 2 ? Math.floor(x) : Math.ceil(x) - 1);

// Marks every cell a segment passes through (ends pulled in slightly so that a segment ending
// exactly on a cell boundary does not spill into the next cell).
function rasterize(s, mark) {
  const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  const n = Math.max(1, Math.ceil(len / 0.1));
  for (let i = 0; i <= n; i++) {
    const t = 0.001 + (0.998 * i) / n;
    mark(s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t);
  }
}

// Static part of the ASCII table: outside = space, inside = '.', walls, bumpers.
const BASE_ROWS = (() => {
  const rows = Array.from({ length: HEIGHT }, (_, r) =>
    Array.from({ length: WIDTH }, (_, c) => (insideTable(c + 0.5, r + 0.5) ? '.' : ' ')),
  );
  // The guides are drawn through the pivots (0.25 cells off the physical surface) so that
  // they rasterize as clean one-cell diagonals.
  const guides = [WALLS[0], WALLS[WALL_PATH.length - 2]];
  const shown = [
    ...WALLS.filter((w) => !guides.includes(w)),
    { x1: 0.5, y1: LEFT_PIVOT.y - (LEFT_PIVOT.x - 0.5), x2: LEFT_PIVOT.x, y2: LEFT_PIVOT.y },
    { x1: 20.5, y1: RIGHT_PIVOT.y - (20.5 - RIGHT_PIVOT.x), x2: RIGHT_PIVOT.x, y2: RIGHT_PIVOT.y },
  ];
  for (const w of shown) {
    rasterize(w, (x, y) => {
      const c = cellColumn(x);
      const r = Math.floor(y);
      if (c >= 0 && c < WIDTH && r >= 0 && r < HEIGHT) rows[r][c] = '#';
    });
  }
  for (const bm of BUMPERS) {
    for (let r = 0; r < HEIGHT; r++) {
      for (let c = 0; c < WIDTH; c++) {
        if (Math.hypot(c + 0.5 - bm.x, r + 0.5 - bm.y) <= bm.r + 0.2) rows[r][c] = '*';
      }
    }
  }
  return rows.map((r) => r.join(''));
})();
