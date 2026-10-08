// Snake engine shared by the browser UI and the Node tests.
// Coordinates: x = column (0 = left), y = row (0 = top). The snake is a list of [x, y], head first.
import { mulberry32 } from '../tetris/engine.js';

export const ACTIONS = 'UDLR';
export const DEFAULT_SIZE = 12;
export const MIN_SIZE = 6;
export const MAX_SIZE = 20;
export const INITIAL_LENGTH = 3;
export const FOOD_SCORE = 10;
export const DEFAULT_MAX_STEPS = 500;
export const DEFAULT_STARVE_STEPS = 100;

export const DIRS = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };
export const OPPOSITE = { U: 'D', D: 'U', L: 'R', R: 'L' };

export const SYSTEM_PROMPT = `You are playing Snake. Each turn you choose the direction of the snake's next move.

Actions:
U = up (y - 1)
D = down (y + 1)
L = left (x - 1)
R = right (x + 1)

Board legend:
. = empty
H = snake head
o = snake body
* = food

Coordinates: x = column (0 = left), y = row (0 = top).
Every turn the snake moves one cell. Eating food makes it one cell longer and scores 10 points.
Choosing the opposite of the current heading is blocked: the snake keeps going straight.
The tail moves away each turn, so its cell is safe unless you eat food on that move.
The game ends if the head hits a wall or the snake's body, or if no food is eaten for too many steps.

Goal: eat as much food as possible without crashing.

Reply with exactly ONE letter from: U D L R
No other text.`;

// response.strip()[:1].upper(); returns null when not one of UDLR.
export function parseAction(raw) {
  const ch = String(raw ?? '').trim().slice(0, 1).toUpperCase();
  return ch && ACTIONS.includes(ch) ? ch : null;
}

// Decisions API question (see decisions.js). Only legal moves are offered: given all four, models
// often picked the blocked reverse (toward the food) and went straight into a wall. Each option
// says what the head hits, the food distance after, and the room left (fewer reachable cells than
// the snake's length = trapped).
export const DECISION_INSTRUCTIONS =
  'Which direction should the snake move next? Each option says where the head goes and what happens. ' +
  'Never choose a move that ends the game or traps the snake when another option is safe. ' +
  'Among safe moves, eat the food or get closer to it.';

const DIR_NAMES = { U: 'up', D: 'down', L: 'left', R: 'right' };

export function decisionQuestion(game) {
  const criteria = {};
  for (const d of ACTIONS) {
    if (d === OPPOSITE[game.heading]) continue;
    const [x, y] = [game.head[0] + DIRS[d][0], game.head[1] + DIRS[d][1]];
    const outcome = game.probe(d);
    let text = `${d === game.heading ? 'keep going' : 'turn'} ${DIR_NAMES[d]} to x=${x} y=${y}: `;
    if (outcome === 'wall') text += 'outside the board, hits the wall and the game ends';
    else if (outcome === 'self') text += 'runs into your own body, the game ends';
    else {
      const body = [[x, y], ...game.snake.slice(0, outcome === 'food' ? undefined : -1)];
      const { room, tail } = reachableCells(game.size, body);
      const length = body.length;
      text += outcome === 'food' ? `eats the food (+${FOOD_SCORE})` : `empty cell, food ${foodDistance(game, x, y)} moves away`;
      text += room < length && !tail
        ? `; only ${room} cells reachable afterwards for a snake of length ${length}, it gets trapped`
        : `; ${room} cells reachable afterwards`;
    }
    criteria[d] = text;
  }
  return { instructions: DECISION_INSTRUCTIONS, criteria };
}

function foodDistance(game, x, y) {
  return game.foodPos ? Math.abs(game.foodPos[0] - x) + Math.abs(game.foodPos[1] - y) : 0;
}

// Free cells reachable from the head of `body` (head first), treating the body as walls, and
// whether that area reaches the tail: following the tail keeps a too-small area survivable.
function reachableCells(size, body) {
  const [tx, ty] = body[body.length - 1];
  const tailKey = ty * size + tx;
  const blocked = new Set(body.slice(0, -1).map(([x, y]) => y * size + x));
  const seen = new Set();
  const queue = [body[0]];
  while (queue.length) {
    const [cx, cy] = queue.pop();
    for (const [dx, dy] of Object.values(DIRS)) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = ny * size + nx;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size || blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      if (k !== tailKey) queue.push([nx, ny]);
    }
  }
  return { room: seen.size - (seen.has(tailKey) ? 1 : 0), tail: seen.has(tailKey) };
}

// Seed for the k-th food of a game: every food index has its own random stream, so all panes
// get the same k-th food as long as its cell is free on every board.
function foodSeed(seed, k) {
  let h = Math.imul(seed ^ 0x5bd1e995, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca77);
  h ^= h >>> 15;
  return Math.imul(h, 0xc2b2ae35) >>> 0;
}

const FOOD_TRIES = 64;

export class Game {
  constructor({ seed = 0, size = DEFAULT_SIZE, maxSteps = DEFAULT_MAX_STEPS, starveSteps = DEFAULT_STARVE_STEPS } = {}) {
    this.seed = seed;
    this.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.floor(size)));
    this.maxSteps = maxSteps;
    this.starveSteps = starveSteps;
    const cx = Math.floor(this.size / 2);
    const cy = Math.floor(this.size / 2);
    this.snake = Array.from({ length: INITIAL_LENGTH }, (_, i) => [cx - i, cy]);
    this.heading = 'R';
    this.score = 0;
    this.food = 0; // food eaten
    this.foodPos = null; // [x, y] or null when the board is full
    this.steps = 0;
    this.sinceFood = 0; // steps since the last food (or since the start)
    this.over = false;
    this.endReason = null; // 'wall' | 'self' | 'starve' | 'limit' | 'full'
    this.lastAction = null; // { action, result }
    this.spawnFood();
  }

  get head() {
    return this.snake[0];
  }

  get length() {
    return this.snake.length;
  }

  occupied(x, y, cells = this.snake) {
    return cells.some(([sx, sy]) => sx === x && sy === y);
  }

  inBounds(x, y) {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }

  // Food k: up to FOOD_TRIES random cells from its own stream, then the first free cell scanning
  // from a random start. No free cell means the snake fills the board.
  spawnFood() {
    const n = this.size;
    const rand = mulberry32(foodSeed(this.seed, this.food));
    for (let i = 0; i < FOOD_TRIES; i++) {
      const x = Math.floor(rand() * n);
      const y = Math.floor(rand() * n);
      if (!this.occupied(x, y)) {
        this.foodPos = [x, y];
        return;
      }
    }
    const start = Math.floor(rand() * n * n);
    for (let i = 0; i < n * n; i++) {
      const c = (start + i) % (n * n);
      const x = c % n;
      const y = Math.floor(c / n);
      if (!this.occupied(x, y)) {
        this.foodPos = [x, y];
        return;
      }
    }
    this.foodPos = null;
    this.over = true;
    this.endReason = 'full';
  }

  // What moving one cell in direction d would do: 'wall', 'self', 'food' or 'ok'.
  probe(d) {
    const [hx, hy] = this.head;
    const [dx, dy] = DIRS[d];
    const x = hx + dx;
    const y = hy + dy;
    if (!this.inBounds(x, y)) return 'wall';
    const eats = this.foodPos !== null && x === this.foodPos[0] && y === this.foodPos[1];
    // The tail vacates its cell this turn unless the snake grows.
    if (this.occupied(x, y, eats ? this.snake : this.snake.slice(0, -1))) return 'self';
    return eats ? 'food' : 'ok';
  }

  // Directions (excluding the blocked reverse) that do not crash on the next move.
  safeMoves() {
    return [...ACTIONS].filter((d) => d !== OPPOSITE[this.heading] && ['ok', 'food'].includes(this.probe(d)));
  }

  // One turn (see advance). With no safe move left, the next crash is played out now (going
  // straight): no choice could change the score or step count.
  step(action) {
    const ev = this.advance(action);
    if (!this.over && this.safeMoves().length === 0) ev.crash = this.advance(null).crash;
    return ev;
  }

  // One raw turn: apply the action (null = illegal output -> no-op, reverse = blocked), then move one cell.
  advance(action) {
    if (this.over) throw new Error('game is over');
    this.steps += 1;
    let result;
    if (!action || !DIRS[action]) result = 'invalid';
    else if (action === OPPOSITE[this.heading]) result = 'blocked';
    else {
      result = 'ok';
      this.heading = action;
    }

    const outcome = this.probe(this.heading);
    const crash = outcome === 'wall' || outcome === 'self' ? outcome : null;
    let ate = false;
    if (crash) {
      this.over = true;
      this.endReason = outcome;
    } else {
      const [dx, dy] = DIRS[this.heading];
      this.snake.unshift([this.head[0] + dx, this.head[1] + dy]);
      if (outcome === 'food') {
        ate = true;
        this.food += 1;
        this.score += FOOD_SCORE;
        this.sinceFood = 0;
        this.spawnFood();
      } else {
        this.snake.pop();
        this.sinceFood += 1;
      }
      if (!this.over && this.sinceFood >= this.starveSteps) {
        this.over = true;
        this.endReason = 'starve';
      }
      if (!this.over && this.steps >= this.maxSteps) {
        this.over = true;
        this.endReason = 'limit';
      }
    }

    this.lastAction = { action, result };
    return { action, result, heading: this.heading, ate, crash };
  }

  // size strings of size chars using . H o *
  boardRows() {
    const rows = Array.from({ length: this.size }, () => Array(this.size).fill('.'));
    if (this.foodPos) rows[this.foodPos[1]][this.foodPos[0]] = '*';
    this.snake.forEach(([x, y], i) => (rows[y][x] = i === 0 ? 'H' : 'o'));
    return rows.map((r) => r.join(''));
  }

  buildUserMessage({ showFoodOffset = false, showSafeMoves = false } = {}) {
    const last = this.lastAction;
    const lastText = !last
      ? 'none'
      : last.result === 'invalid'
        ? 'invalid output (no-op)'
        : `${last.action} (${last.result})`;
    const [hx, hy] = this.head;
    const food = this.foodPos ? `x=${this.foodPos[0]} y=${this.foodPos[1]}` : 'none';
    // Cells are 3 characters wide so two-digit column indices stay aligned.
    const idx = Array.from({ length: this.size }, (_, i) => String(i).padStart(2)).join(' ');
    const lines = [
      `Step: ${this.steps + 1}/${this.maxSteps}  Since food: ${this.sinceFood}/${this.starveSteps}`,
      `Last action: ${lastText}`,
      `Heading: ${this.heading}  Length: ${this.length}`,
      `Head: x=${hx} y=${hy}  Food: ${food}`,
      '',
      `   ${idx}`,
      ...this.boardRows().map((r, y) => `${String(y).padStart(2)} ${[...r].map((c) => c.padStart(2)).join(' ')}`),
      '',
    ];
    if (showFoodOffset && this.foodPos) {
      const dx = this.foodPos[0] - hx;
      const dy = this.foodPos[1] - hy;
      const parts = [];
      if (dx) parts.push(`${Math.abs(dx)} ${dx > 0 ? 'right' : 'left'}`);
      if (dy) parts.push(`${Math.abs(dy)} ${dy > 0 ? 'down' : 'up'}`);
      const sign = (v) => (v > 0 ? `+${v}` : String(v));
      lines.push(`Food offset: dx=${sign(dx)} dy=${sign(dy)} (${parts.join(', ')})`);
    }
    if (showSafeMoves) lines.push(`Safe moves: ${this.safeMoves().join(' ') || 'none'}`);
    if (showFoodOffset || showSafeMoves) lines.push('');
    lines.push('Action:');
    return lines.join('\n');
  }
}
