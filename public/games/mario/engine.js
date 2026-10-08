// Turn-based side-scrolling platformer shared by the browser UI and the Node tests.
// Coordinates: x = column (0..width-1, left to right), y = row (0..11, top to bottom).
import { mulberry32 } from '../tetris/engine.js';

export const HEIGHT = 12;
export const DEFAULT_LENGTH = 200;
export const DEFAULT_LIMIT = 500;
export const START_X = 2;
export const JUMP_RISE = 4; // rows gained by a jump, one per step
export const STUCK_STEPS = 5; // this many steps in a row that change nothing on screen end the game
export const VIEW_BEHIND = 4;
export const VIEW_AHEAD = 19;
export const VIEW_WIDTH = VIEW_BEHIND + 1 + VIEW_AHEAD;
export const ACTIONS = 'RLJUN';
export const SCORE = { column: 10, coin: 50, stomp: 100, goal: 1000, stepLeft: 5 };

export const SYSTEM_PROMPT = `You are playing a side-scrolling platformer. Each turn you choose ONE action for your character M.
Goal: run right and reach the flag F at the end of the level.

Actions:
R = move right one column
L = move left one column
J = jump forward (up and to the right)
U = jump straight up
N = do nothing

Physics (each step: your action, then the world moves one step):
- A jump rises 1 row per step for 4 steps, then you fall 1 row per step until you land.
- J jumps with right drift: while in the air you also move 1 column right every step. U jumps with no drift.
- In the air: R = drift right, L = drift left, U = stop drifting (fall straight), N = keep drifting. J does nothing until you land.
- Walking off a ledge keeps your drift. Solid tiles (# and ?) block you. Hitting ? from below gives a coin.

Enemies E walk 1 column per step and turn around at walls, ledges and other enemies.
- Touching an enemy while you are falling kills it (stomp). Any other touch kills you.
- Falling into a pit (below the bottom row) kills you.

Map legend:
M = you
# = solid ground / wall / pipe
? = coin block (solid)
o = coin
E = enemy
F = flag (goal)
. = air

Rows go from 0 (top) to 11 (bottom). Column numbers are absolute and read top to bottom above the map.
If nothing on the screen changes for ${STUCK_STEPS} steps in a row (e.g. you keep walking into a wall), the game ends.
Score: 10 per column of progress, 50 per coin, 100 per stomp, and a big bonus for reaching the flag (bigger when faster).
Tip: keep moving right; press J when a pit, wall or enemy is 1-3 columns ahead.

Reply with exactly ONE letter from: R L J U N
No other text.`;

// Internal tile codes: . air, G ground, B brick, Q coin block, U used block, P pipe, S stone (stairs).
const SOLID = new Set(['G', 'B', 'Q', 'U', 'P', 'S']);
const TEXT_TILE = { '.': '.', G: '#', B: '#', Q: '?', U: '#', P: '#', S: '#' };

// response.strip()[:1].upper(); returns null when not one of RLJUN.
export function parseAction(raw) {
  const ch = String(raw ?? '').trim().slice(0, 1).toUpperCase();
  return ch && ACTIONS.includes(ch) ? ch : null;
}

// Procedural level, identical for a given (seed, width). Difficulty ramps with x / width.
export function generateLevel(seed, width = DEFAULT_LENGTH) {
  width = Math.max(60, Math.floor(width));
  const rand = mulberry32(seed);
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const chance = (p) => rand() < p;
  const tiles = Array.from({ length: HEIGHT }, () => Array(width).fill('.'));
  const coins = new Set();
  const enemies = [];
  const flagX = width - 6;
  const end = width - 12; // flat run-out before the flag starts here
  let x = 0;
  let h = 2; // ground height in rows, standing row = HEIGHT - 1 - h

  const row = () => HEIGHT - 1 - h; // standing row on the current ground
  const column = (n = 1) => {
    for (let i = 0; i < n && x < width; i++, x++) {
      for (let y = HEIGHT - h; y < HEIGHT; y++) tiles[y][x] = 'G';
    }
  };
  const gap = (n) => (x += n); // pit columns stay air
  const coin = (cx, cy) => cy >= 0 && tiles[cy][cx] === '.' && coins.add(cy * width + cx);
  const enemy = (ex) => enemies.push({ x: ex, y: row(), dir: -1, alive: true });
  const room = (n) => x + n <= end;

  column(14);
  while (x < end) {
    const d = x / width;
    const weights = {
      flat: 3 - 2 * d,
      pit: 2 + 3 * d,
      step: 1.2,
      pipe: 1.3,
      pipes: d > 0.2 ? 2.5 * d : 0,
      enemies: 1 + 4 * d,
      blocks: 1.5 - d,
      stairs: 0.5 + d,
      platform: d > 0.25 ? 2.5 * d : 0,
    };
    let pick = rand() * Object.values(weights).reduce((a, b) => a + b, 0);
    let type = 'flat';
    for (const [k, w] of Object.entries(weights)) {
      if ((pick -= w) < 0) {
        type = k;
        break;
      }
    }

    if (type === 'pit' && room(16)) {
      const w = ri(2, Math.min(5, 2 + Math.round(3 * d)));
      column(1);
      const edgeRow = row();
      gap(w);
      if (chance(0.6)) coin(x - Math.ceil(w / 2), edgeRow - 3);
      if (chance(0.3)) h = Math.min(4, Math.max(2, h + ri(-1, 1)));
      column(Math.max(3, 10 - w - Math.floor(3 * d))); // landing zone for a J from the edge
    } else if (type === 'step' && room(10)) {
      const up = chance(h <= 2 ? 0.8 : h >= 4 ? 0.2 : 0.5); // drift back toward h = 3
      h = Math.min(5, Math.max(2, h + (up ? 1 : -1) * ri(1, 2)));
      column(ri(3, 6));
    } else if (type === 'pipe' && room(12)) {
      column(2);
      const top = row() - ri(1, d > 0.5 ? 3 : 2);
      for (let y = top; y <= row(); y++) tiles[y][x] = tiles[y][x + 1] = 'P';
      column(2);
      column(ri(4, 6)); // run-out: a jump off a pipe travels far
    } else if (type === 'pipes' && room(18)) {
      // Two pipes with enemies patrolling between them.
      column(2);
      const n = ri(5, 7);
      const tops = [row() - ri(1, 2), row() - ri(1, 2)];
      for (const [i, px] of [x, x + 2 + n].entries()) {
        for (let y = tops[i]; y <= row(); y++) tiles[y][px] = tiles[y][px + 1] = 'P';
      }
      column(2);
      const start = x;
      column(n);
      enemy(start + ri(1, n - 2));
      if (chance(d)) enemy(start + n - 1);
      column(2);
      column(ri(4, 5));
    } else if (type === 'enemies' && room(14)) {
      const n = ri(7, 11);
      const start = x;
      column(n);
      const count = 1 + (chance(d) ? 1 : 0) + (chance(d - 0.5) ? 1 : 0);
      for (let i = 0; i < count && 2 + i * 3 < n - 1; i++) enemy(start + 2 + i * 3);
      if (chance(0.4)) for (let i = 0; i < 3; i++) coin(start + 3 + i, row() - 4);
    } else if (type === 'blocks' && room(12)) {
      const n = ri(6, 9);
      const start = x;
      column(n);
      const by = row() - 3;
      const len = ri(3, 5);
      for (let i = 0; i < len; i++) {
        tiles[by][start + 1 + i] = chance(0.45) ? 'Q' : 'B';
        if (chance(0.3)) coin(start + 1 + i, by - 1);
      }
      if (!tiles[by].slice(start + 1, start + 1 + len).includes('Q')) tiles[by][start + 1 + ri(0, len - 1)] = 'Q';
    } else if (type === 'stairs' && room(18)) {
      const k = ri(3, Math.min(4, 9 - h));
      const base = row();
      for (let i = 1; i <= k; i++) {
        for (let y = base - i + 1; y <= base; y++) tiles[y][x] = 'S';
        column(1);
      }
      const pit = d > 0.5 && chance(0.5) ? ri(1, 2) : 0;
      if (pit) gap(pit);
      else column(1);
      for (let i = k; i >= 1; i--) {
        for (let y = base - i + 1; y <= base; y++) tiles[y][x] = 'S';
        column(1);
      }
      column(ri(4, 6));
    } else if (type === 'platform' && room(22)) {
      // Pit too wide to clear in one jump, with a floating brick ledge in the middle.
      column(1);
      const edge = x - 1;
      const base = row();
      const w = ri(8, 10);
      gap(w);
      const px = edge + ri(4, 5);
      for (let i = 0; i < 3; i++) tiles[base - 2][px + i] = 'B';
      coin(px + 1, base - 3);
      column(Math.max(4, 13 - w));
    } else {
      const start = x;
      column(ri(3, 6));
      if (chance(0.35)) for (let i = start; i < x; i++) coin(i, row() - (chance(0.5) ? 0 : 3));
    }
  }
  while (x < width) column(1);
  // Every enemy must start on free space with ground below it.
  const ok = (e) => tiles[e.y][e.x] === '.' && tiles[e.y + 1][e.x] !== '.' && !coins.has(e.y * width + e.x);
  return { width, tiles, coins, enemies: enemies.filter(ok), flagX, flagTop: 2 };
}

// Decisions API question (see decisions.js): each action is simulated on a copy. A move into the
// air is followed to landing with no input ("keep drifting"); if that dies, steering can still
// land, since step() already ends unsavable falls.
export const DECISION_INSTRUCTIONS =
  'Which action should the player take next? Each option says what happens to M if you take it. ' +
  'Never choose an action that dies when another option survives. Among safe options, prefer the one that ' +
  'gets furthest right (highest column), then coins o and stomps.';

const ACTION_NAMES = { R: 'move right', L: 'move left', J: 'jump forward', U: 'jump straight up', N: 'do nothing' };
const MAX_AIR_STEPS = 2 * HEIGHT; // a jump plus a fall from the top row always ends sooner

export function decisionQuestion(game) {
  const criteria = {};
  for (const a of ACTIONS) {
    const g = game.clone();
    const ev = g.step(a);
    let text = ACTION_NAMES[a];
    if (ev.result === 'blocked') text += ' (blocked by a solid tile)';
    else if (ev.result === 'ignored') text += ' (ignored in the air, you keep drifting)';
    text += `: ${outcomeText(game, g)}`;
    criteria[a] = text;
  }
  return { instructions: DECISION_INSTRUCTIONS, criteria };
}

function outcomeText(start, g) {
  const gains = () => {
    const parts = [];
    if (g.coins > start.coins) parts.push(`+${g.coins - start.coins} coin`);
    if (g.stomps > start.stomps) parts.push(`stomps ${g.stomps - start.stomps} enemy`);
    return parts.length ? ` (${parts.join(', ')})` : '';
  };
  const ended = () =>
    g.endReason === 'goal' ? `reaches the flag${gains()}`
      : g.endReason === 'dead' ? `you die (${g.death === 'pit' ? 'fall into a pit' : 'hit by an enemy'})`
        : g.endReason === 'stuck' ? `the game ends: nothing on screen has changed for ${STUCK_STEPS} steps`
          : null;
  const at = () => `column ${g.x} (${g.x - start.x >= 0 ? '+' : ''}${g.x - start.x})`;
  if (g.over) return ended() ?? `step limit reached at ${at()}`;
  if (g.grounded) return `on the ground at ${at()}${gains()}${doomed(g) ? ', but every action after that dies' : ''}`;
  const air = { x: g.x, y: g.y };
  let steps = 0;
  while (!g.over && !g.grounded && steps < MAX_AIR_STEPS) {
    g.advance('N');
    steps += 1;
  }
  const after = `in the air at column ${air.x} row ${air.y}; if you keep drifting, after ${steps} more step${steps > 1 ? 's' : ''} `;
  if (!g.over) return `${after}you land at ${at()}${gains()}`;
  if (g.endReason !== 'dead') return after + (ended() ?? `the step limit is reached at ${at()}`);
  // A fall no steering can save already ended the game in step(), so this one can still land.
  return `${after}${ended()}, but steering in the air can still land safely`;
}

// True when every action from g dies on the next step (e.g. an enemy closing in from both sides).
function doomed(g) {
  return [...ACTIONS].every((a) => {
    const next = g.clone();
    next.step(a);
    return next.endReason === 'dead';
  });
}

// Whether some sequence of in-air inputs (R / L / U set the drift) gets back to the ground alive.
function canLand(g, depth, memo) {
  if (g.over) return g.endReason !== 'dead';
  if (g.grounded || depth === 0) return true;
  const key = `${g.x},${g.y},${g.rise},${g.vx},${g.steps},${g.stomps}`;
  if (memo.has(key)) return memo.get(key);
  let ok = false;
  for (const a of 'RLU') {
    const next = g.clone();
    next.advance(a);
    if (canLand(next, depth - 1, memo)) {
      ok = true;
      break;
    }
  }
  memo.set(key, ok);
  return ok;
}

export class Game {
  constructor({ seed = 0, length = DEFAULT_LENGTH, limit = DEFAULT_LIMIT } = {}) {
    const level = generateLevel(seed, length);
    this.width = level.width;
    this.tiles = level.tiles; // copy-on-write (see bump) so clones stay cheap
    this.coinSet = level.coins; // copy-on-write
    this.enemies = level.enemies;
    this.flagX = level.flagX;
    this.flagTop = level.flagTop;
    this.limit = limit;
    this.x = START_X;
    this.y = HEIGHT - 1 - this.groundHeight(START_X);
    this.rise = 0; // rows of jump still to rise
    this.vx = 0; // horizontal drift while airborne: -1, 0, 1
    this.falling = false; // moved down during the last step
    this.maxX = START_X;
    this.coins = 0;
    this.stomps = 0;
    this.steps = 0;
    this.goalBonus = 0;
    this.over = false;
    this.endReason = null; // 'goal' | 'dead' | 'limit' | 'stuck'
    this.death = null; // 'pit' | 'enemy'
    this.lastAction = null; // { action, result }
    this.still = 0; // steps in a row that left the screen unchanged
  }

  clone() {
    const g = Object.create(Game.prototype);
    Object.assign(g, this);
    g.enemies = this.enemies.map((e) => ({ ...e }));
    return g;
  }

  groundHeight(x) {
    let n = 0;
    for (let y = HEIGHT - 1; y >= 0 && this.tiles[y][x] === 'G'; y--) n++;
    return n;
  }

  solid(x, y) {
    if (x < 0 || x >= this.width) return true; // level edges are walls
    if (y < 0 || y >= HEIGHT) return false;
    return SOLID.has(this.tiles[y][x]);
  }

  get grounded() {
    return this.rise === 0 && this.y < HEIGHT - 1 && this.solid(this.x, this.y + 1);
  }

  get distance() {
    return this.maxX - START_X;
  }

  get score() {
    return this.distance * SCORE.column + this.coins * SCORE.coin + this.stomps * SCORE.stomp + this.goalBonus;
  }

  enemyAt(x, y) {
    return this.enemies.find((e) => e.alive && e.x === x && e.y === y);
  }

  // Player and enemy share a tile: a falling player stomps, anything else kills the player.
  touch(enemy) {
    if (this.falling) {
      enemy.alive = false;
      this.stomps += 1;
      return 'stomp';
    }
    this.die('enemy');
    return 'hit';
  }

  die(cause) {
    this.over = true;
    this.endReason = 'dead';
    this.death = cause;
  }

  bump(x, y) {
    if (this.tiles[y]?.[x] !== 'Q') return false;
    this.tiles = this.tiles.map((r, i) => (i === y ? r.slice() : r));
    this.tiles[y][x] = 'U';
    this.coins += 1;
    return true;
  }

  moveEnemies() {
    let hit = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const nx = e.x + e.dir;
      const blocked = this.solid(nx, e.y) || !this.solid(nx, e.y + 1) || this.enemyAt(nx, e.y);
      if (blocked) {
        e.dir = -e.dir;
        continue;
      }
      e.x = nx;
      if (!this.over && e.x === this.x && e.y === this.y) hit = this.touch(e) === 'stomp' ? 'stomp' : 'hit';
    }
    return hit;
  }

  // One turn (see advance). An unsavable fall is played out now with no input. STUCK_STEPS steps
  // in a row with no change on screen (e.g. walking into a wall) end the game as 'stuck'.
  step(action) {
    const before = this.screenKey();
    const ev = this.advance(action);
    if (!this.over && !this.grounded && !canLand(this, MAX_AIR_STEPS, new Map())) {
      const coins = this.coins;
      const stomps = this.stomps;
      while (!this.over) this.advance('N');
      ev.coins += this.coins - coins;
      ev.stomps += this.stomps - stomps;
      ev.endReason = this.endReason;
    }
    if (!this.over) {
      this.still = this.screenKey() === before ? this.still + 1 : 0;
      if (this.still >= STUCK_STEPS) {
        this.over = true;
        this.endReason = 'stuck';
        ev.endReason = 'stuck';
      }
    }
    return ev;
  }

  // What the user message shows apart from the Step and Last action lines: the map, the
  // player's position and motion, and the direction of the enemies in view.
  screenKey() {
    const dirs = this.visibleEnemies().map((e) => `${e.x},${e.y},${e.dir}`);
    return `${this.x},${this.y},${this.stateText()}|${this.viewRows().join('|')}|${dirs.join(';')}`;
  }

  // One raw turn: apply the action (null = illegal output -> no-op), move the player (horizontal,
  // then vertical), then move every enemy one column.
  advance(action) {
    if (this.over) throw new Error('game is over');
    this.steps += 1;
    const onGround = this.grounded;
    let result = 'ok';
    let dx = 0;
    let coins = 0;
    const stompsBefore = this.stomps;

    if (action === null || action === undefined) {
      result = 'invalid';
      if (!onGround) dx = this.vx;
    } else if (onGround) {
      if (action === 'R' || action === 'L') {
        dx = action === 'R' ? 1 : -1;
        this.vx = dx; // kept if this walks off a ledge
      } else if (action === 'J' || action === 'U') {
        if (this.solid(this.x, this.y - 1)) {
          result = 'blocked';
        } else {
          this.rise = JUMP_RISE;
          this.vx = action === 'J' ? 1 : 0;
          dx = this.vx;
        }
      }
    } else {
      if (action === 'R') this.vx = 1;
      else if (action === 'L') this.vx = -1;
      else if (action === 'U') this.vx = 0;
      else if (action === 'J') result = 'ignored';
      dx = this.vx;
    }

    // Horizontal move.
    if (dx !== 0) {
      if (this.solid(this.x + dx, this.y)) {
        if (action === 'R' || action === 'L') result = 'blocked';
      } else {
        this.x += dx;
      }
    }

    // Vertical move.
    this.falling = false;
    if (this.rise > 0) {
      if (this.solid(this.x, this.y - 1) || this.y === 0) {
        if (this.bump(this.x, this.y - 1)) coins += 1;
        this.rise = 0;
      } else {
        this.y -= 1;
        this.rise -= 1;
      }
    } else if (!this.solid(this.x, this.y + 1)) {
      this.y += 1;
      this.falling = true;
    }
    this.maxX = Math.max(this.maxX, this.x);

    let contact = null;
    if (this.y >= HEIGHT) {
      this.die('pit');
    } else {
      const key = this.y * this.width + this.x;
      if (this.coinSet.has(key)) {
        this.coinSet = new Set(this.coinSet);
        this.coinSet.delete(key);
        this.coins += 1;
        coins += 1;
      }
      const e = this.enemyAt(this.x, this.y);
      if (e) contact = this.touch(e);
    }
    if (!this.over && this.x >= this.flagX) {
      this.over = true;
      this.endReason = 'goal';
      this.goalBonus = SCORE.goal + SCORE.stepLeft * Math.max(0, this.limit - this.steps);
    }
    if (!this.over) contact = this.moveEnemies() ?? contact;
    if (this.grounded) this.vx = 0;
    if (!this.over && this.steps >= this.limit) {
      this.over = true;
      this.endReason = 'limit';
    }

    this.lastAction = { action, result };
    return { action, result, coins, stomps: this.stomps - stompsBefore, contact, endReason: this.endReason };
  }

  viewStart() {
    return Math.max(0, Math.min(this.width - VIEW_WIDTH, this.x - VIEW_BEHIND));
  }

  // Tile kinds for the viewport columns [x0, x0 + VIEW_WIDTH): used by both text and UI.
  // Each cell: { tile, coin, enemy, player, flag }.
  viewCells() {
    const x0 = this.viewStart();
    const cells = [];
    for (let y = 0; y < HEIGHT; y++) {
      const row = [];
      for (let x = x0; x < x0 + VIEW_WIDTH; x++) {
        row.push({
          x,
          y,
          tile: this.tiles[y][x],
          coin: this.coinSet.has(y * this.width + x),
          flag: x === this.flagX && y >= this.flagTop && !this.solid(x, y),
          enemy: Boolean(this.enemyAt(x, y)),
          player: x === this.x && y === this.y,
        });
      }
      cells.push(row);
    }
    return cells;
  }

  viewRows() {
    return this.viewCells().map((row) =>
      row
        .map((c) => (c.player ? 'M' : c.enemy ? 'E' : c.coin ? 'o' : c.flag ? 'F' : TEXT_TILE[c.tile]))
        .join(''),
    );
  }

  stateText() {
    if (this.grounded) return 'on ground';
    const drift = this.vx > 0 ? 'right' : this.vx < 0 ? 'left' : 'none';
    const motion = this.rise > 0 ? `rising (${this.rise} more row${this.rise > 1 ? 's' : ''})` : 'falling';
    return `in the air, ${motion}, drift ${drift}`;
  }

  // Next pit (column with no ground under the bottom row) ahead of the player.
  nextPit() {
    for (let x = this.x + 1; x < this.flagX; x++) {
      if (!this.solid(x, HEIGHT - 1)) {
        let end = x;
        while (end + 1 < this.width && !this.solid(end + 1, HEIGHT - 1)) end++;
        return { start: x, end };
      }
    }
    return null;
  }

  visibleEnemies() {
    const x0 = this.viewStart();
    return this.enemies
      .filter((e) => e.alive && e.x >= x0 && e.x < x0 + VIEW_WIDTH)
      .sort((a, b) => a.x - b.x);
  }

  buildUserMessage({ showPit = false, showEnemies = false } = {}) {
    const last = this.lastAction;
    const lastText = !last
      ? 'none'
      : last.result === 'invalid'
        ? 'invalid output (no-op)'
        : `${last.action} (${last.result})`;
    const x0 = this.viewStart();
    const cols = Array.from({ length: VIEW_WIDTH }, (_, i) => String(x0 + i).padStart(3, '0'));
    const lines = [
      `Step: ${this.steps + 1}/${this.limit}`,
      `Last action: ${lastText}`,
      `You: column ${this.x}, row ${this.y}, ${this.stateText()}`,
      `Flag: column ${this.flagX}`,
      '',
      ...[0, 1, 2].map((d) => `   ${cols.map((c) => c[d]).join('')}`),
      ...this.viewRows().map((r, y) => `${String(y).padStart(2)} ${r}`),
      '',
    ];
    if (showPit) {
      const pit = this.nextPit();
      lines.push(
        pit
          ? `Next pit: columns ${pit.start}-${pit.end} (width ${pit.end - pit.start + 1}), ${pit.start - this.x} columns ahead`
          : 'Next pit: none',
      );
    }
    if (showEnemies) {
      const list = this.visibleEnemies().map(
        (e) => `column ${e.x} row ${e.y} moving ${e.dir > 0 ? 'right' : 'left'}`,
      );
      lines.push(`Enemies in view: ${list.length ? list.join('; ') : 'none'}`);
    }
    if (showPit || showEnemies) lines.push('');
    lines.push('Action:');
    return lines.join('\n');
  }
}
