// Tetris engine shared by the browser UI and the Node tests.
// Coordinates: x = column (0..9, left to right), y = row (0..19, top to bottom).

export const WIDTH = 10;
export const HEIGHT = 20;
export const MAX_STEPS_PER_PIECE = 30;
export const ACTIONS = 'LRUDS';
export const LINE_SCORES = [0, 100, 300, 500, 800];

export const SYSTEM_PROMPT = `You are playing Tetris. Each turn you choose ONE action for the falling piece.

Actions:
L = move left
R = move right
U = rotate clockwise
D = move down one row
S = hard drop (instantly place the piece at the ghost position)

Board legend:
. = empty
# = filled
@ = current falling piece
+ = ghost (where the piece lands if you press S)

Goal: clear as many lines as possible and avoid holes and tall stacks.
Tip: move and rotate the piece into position first, then press S.

Reply with exactly ONE letter from: L R U D S
No other text.`;

// Spawn-orientation cells [x, y] inside each piece's bounding box (SRS).
const BASE_SHAPES = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 4, cells: [[1, 0], [2, 0], [1, 1], [2, 1]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};
export const PIECE_TYPES = Object.keys(BASE_SHAPES);

// SHAPES[type][rot] = cells, rot 0..3 clockwise.
const SHAPES = {};
for (const [type, { size, cells }] of Object.entries(BASE_SHAPES)) {
  const rots = [cells];
  for (let r = 1; r < 4; r++) {
    rots.push(type === 'O' ? cells : rots[r - 1].map(([x, y]) => [size - 1 - y, x]));
  }
  SHAPES[type] = rots;
}

// SRS clockwise wall kicks, indexed by the rotation state being left.
// Written in the SRS convention (+y = up) and flipped to +y = down below.
const KICKS_JLSTZ = [
  [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
];
const KICKS_I = [
  [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
];
const flipY = (table) => table.map((row) => row.map(([dx, dy]) => [dx, -dy]));
const KICKS = { I: flipY(KICKS_I), O: [[[0, 0]], [[0, 0]], [[0, 0]], [[0, 0]]] };
for (const t of 'JLSTZ') KICKS[t] = flipY(KICKS_JLSTZ);

// Deterministic 32-bit PRNG.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 7-bag randomizer: every consecutive group of 7 pieces is a permutation of all 7 types.
export function createBag(seed) {
  const rand = mulberry32(seed);
  let bag = [];
  return () => {
    if (bag.length === 0) {
      bag = [...PIECE_TYPES];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    return bag.shift();
  };
}

// response.strip()[:1].upper(); returns null when not one of LRUDS.
export function parseAction(raw) {
  const ch = String(raw ?? '').trim().slice(0, 1).toUpperCase();
  return ch && ACTIONS.includes(ch) ? ch : null;
}

export function pieceCells(piece) {
  return SHAPES[piece.type][piece.rot].map(([x, y]) => [piece.x + x, piece.y + y]);
}

// Decisions API question (see decisions.js). The best spot is often several moves away, so every
// reachable placement (one action plus gravity per step) is searched and rated; each option says
// how many steps the best one is from there. An action that locks the piece gives its result.
export const DECISION_INSTRUCTIONS =
  'Which action should the player take next for the falling piece? Each option says how many steps the best ' +
  'placement is after taking it, or what happens when the piece locks. Take the option with the fewest steps ' +
  'to the best placement; never top out when another option avoids it.';

const ACTION_NAMES = { L: 'move left', R: 'move right', U: 'rotate clockwise', D: 'move down one row', S: 'hard drop now' };

export function decisionQuestion(game) {
  const stepsLeft = game.maxStepsPerPiece - game.pieceStep;
  const all = reachablePlacements(game, game.current, stepsLeft);
  const rate = (p) => p.rating ?? Object.assign(p, placementResult(game, p.piece)).rating;
  // Only hard-drop placements: sliding under an overhang takes many exact steps.
  const best = [...all.values()].filter((p) => p.drop).reduce((a, b) => (rate(b) > rate(a) || (rate(b) === rate(a) && b.steps < a.steps) ? b : a));
  const bestText = `the best placement (${resultText(best)})`;
  const criteria = {};
  for (const a of ACTIONS) {
    const sim = viewOf(game, game.current);
    let text = ACTION_NAMES[a];
    const landed = a === 'S' ? sim.ghost() : applyAction(sim, a) ? null : sim.current;
    if (a !== 'S' && sim.lastBlocked) text += ' (blocked)';
    if (landed || stepsLeft <= 1) {
      const p = landed ?? sim.ghost();
      const result = placementResult(game, p);
      const isBest = cellsKey(p) === cellsKey(best.piece);
      text += `${a === 'S' ? '' : landed ? ': the piece locks here' : ': the piece auto-drops (step limit)'}: ${resultText(result)}`;
      text += isBest ? ', this is the best placement' : `; ${bestText} needs ${best.steps} step${best.steps > 1 ? 's' : ''} from now`;
    } else {
      const xs = pieceCells(sim.current).map(([x]) => x);
      const after = reachablePlacements(game, sim.current, stepsLeft - 1).get(cellsKey(best.piece));
      text += `: piece in columns ${Math.min(...xs)}-${Math.max(...xs)}; ` +
        (after ? `${bestText} is then ${after.steps} more step${after.steps > 1 ? 's' : ''} away` : `${bestText} is then out of reach`);
    }
    criteria[a] = text;
  }
  return { instructions: DECISION_INSTRUCTIONS, criteria };
}

function viewOf(game, piece) {
  // Game methods only read this.board and this.current, so a view with its own piece is enough.
  const sim = Object.create(Game.prototype);
  sim.board = game.board;
  sim.current = { ...piece };
  return sim;
}

// Applies a non-drop action (null = illegal output, a no-op) and one row of gravity to sim.current;
// false when the piece locks.
function applyAction(sim, a) {
  const moved = a === 'L' ? sim.tryMove(-1, 0) : a === 'R' ? sim.tryMove(1, 0) : a === 'U' ? sim.tryRotate()
    : a === 'D' ? sim.tryMove(0, 1) : false;
  sim.lastBlocked = !moved;
  return sim.tryMove(0, 1);
}

const cellsKey = (piece) => pieceCells(piece).map(([x, y]) => y * WIDTH + x).sort((a, b) => a - b).join(',');

// Placements reachable from `start` within `stepsLeft` steps (the last step auto-drops), keyed by
// their cells: { piece, steps, drop } with the fewest steps; drop = reachable by a hard drop.
function reachablePlacements(game, start, stepsLeft, actions = ACTIONS) {
  const sim = viewOf(game, start);
  const out = new Map();
  const land = (piece, steps, drop = false) => {
    const k = cellsKey(piece);
    if (!out.has(k)) out.set(k, { piece, steps, drop });
    else if (drop) out.get(k).drop = true;
  };
  const seen = new Set();
  let frontier = [start];
  for (let step = 1; step <= stepsLeft && frontier.length; step++) {
    const next = [];
    for (const p of frontier) {
      for (const a of actions) {
        sim.current = { ...p };
        if (a === 'S') {
          land(sim.ghost(), step, true);
          continue;
        }
        if (!applyAction(sim, a)) {
          land(sim.current, step);
          continue;
        }
        if (step === stepsLeft) {
          land(sim.ghost(), step);
          continue;
        }
        const k = `${sim.current.x},${sim.current.y},${sim.current.rot}`;
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(sim.current);
      }
    }
    frontier = next;
  }
  return out;
}

// Locks `piece` on a copy of the board. rating: El-Tetris style weights over aggregate height,
// lines, holes and bumpiness; topping out rates lowest.
function placementResult(game, piece) {
  const sim = Object.create(Game.prototype);
  sim.board = game.board.map((row) => [...row]);
  for (const [x, y] of pieceCells(piece)) sim.board[y][x] = piece.type;
  const kept = sim.board.filter((row) => row.some((c) => c === null));
  const cleared = HEIGHT - kept.length;
  while (kept.length < HEIGHT) kept.unshift(Array(WIDTH).fill(null));
  sim.board = kept;
  const heights = sim.columnHeights();
  const holes = sim.holes();
  const newHoles = holes - game.holes();
  const topout = !sim.fits({ type: game.next, rot: 0, x: 3, y: game.next === 'I' ? -1 : 0 });
  const bumpiness = heights.slice(1).reduce((sum, h, i) => sum + Math.abs(h - heights[i]), 0);
  const rating = topout ? -Infinity
    : -0.51 * heights.reduce((a, b) => a + b, 0) + 0.76 * cleared - 0.36 * holes - 0.18 * bumpiness;
  return { cleared, newHoles, height: Math.max(...heights), topout, rating };
}

function resultText({ cleared, newHoles, height, topout }) {
  const parts = [
    cleared ? `clears ${cleared} line${cleared > 1 ? 's' : ''} (+${LINE_SCORES[cleared]})` : 'clears no lines',
    newHoles > 0 ? `${newHoles} new hole${newHoles > 1 ? 's' : ''}` : 'no new holes',
    `stack height ${height}`,
  ];
  if (topout) parts.push('tops out, the game ends');
  return parts.join(', ');
}

export class Game {
  constructor({ seed = 0, maxPieces = Infinity, maxStepsPerPiece = MAX_STEPS_PER_PIECE } = {}) {
    this.maxPieces = maxPieces;
    this.maxStepsPerPiece = maxStepsPerPiece;
    this.board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
    this.nextPiece = createBag(seed);
    this.score = 0;
    this.lines = 0;
    this.pieces = 0; // pieces locked on the board
    this.steps = 0; // total decisions
    this.over = false;
    this.endReason = null; // 'topout' | 'limit'
    this.lastAction = null; // { action, result }
    this.next = this.nextPiece();
    this.spawn();
  }

  spawn() {
    const type = this.next;
    this.next = this.nextPiece();
    // I spawns flat on row 0; 3x3 pieces occupy rows 0-1; O occupies columns 4-5.
    this.current = { type, rot: 0, x: 3, y: type === 'I' ? -1 : 0 };
    this.pieceStep = 0;
    if (!this.fits(this.current)) {
      this.over = true;
      this.endReason = 'topout';
    }
  }

  fits(piece) {
    return pieceCells(piece).every(
      ([x, y]) => x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && this.board[y][x] === null,
    );
  }

  tryMove(dx, dy) {
    const moved = { ...this.current, x: this.current.x + dx, y: this.current.y + dy };
    if (!this.fits(moved)) return false;
    this.current = moved;
    return true;
  }

  tryRotate() {
    const { type, rot } = this.current;
    const newRot = (rot + 1) % 4;
    for (const [dx, dy] of KICKS[type][rot]) {
      const cand = { ...this.current, rot: newRot, x: this.current.x + dx, y: this.current.y + dy };
      if (this.fits(cand)) {
        this.current = cand;
        return true;
      }
    }
    return false;
  }

  ghost() {
    let g = this.current;
    for (;;) {
      const below = { ...g, y: g.y + 1 };
      if (!this.fits(below)) return g;
      g = below;
    }
  }

  // Lock the current piece, clear lines, score, and spawn the next piece.
  lock() {
    for (const [x, y] of pieceCells(this.current)) this.board[y][x] = this.current.type;
    const kept = this.board.filter((row) => row.some((c) => c === null));
    const cleared = HEIGHT - kept.length;
    while (kept.length < HEIGHT) kept.unshift(Array(WIDTH).fill(null));
    this.board = kept;
    this.lines += cleared;
    this.score += LINE_SCORES[cleared];
    this.pieces += 1;
    if (this.pieces >= this.maxPieces) {
      this.over = true;
      this.endReason = 'limit';
    } else {
      this.spawn();
    }
    return cleared;
  }

  hardDrop() {
    this.current = this.ghost();
    return this.lock();
  }

  // One turn (see advance). When no input can change the result (doomed), the piece is
  // hard-dropped now and the game ends.
  step(action) {
    const ev = this.advance(action);
    if (!this.over && this.doomed()) {
      ev.cleared += this.hardDrop();
      ev.locked = true;
      ev.autoDrop = true;
    }
    return ev;
  }

  // True when every placement the current piece can still reach (with any inputs, illegal output
  // included) ends the game, by top out or the piece limit M, with the same lines cleared.
  doomed() {
    const last = this.pieces + 1 >= this.maxPieces;
    const ends = (piece) => {
      const { cleared, topout } = placementResult(this, piece);
      return last || topout ? cleared : null;
    };
    // Cheap check first: the drop from here must end the game.
    const cleared = ends(this.ghost());
    if (cleared === null) return false;
    const all = reachablePlacements(this, this.current, this.maxStepsPerPiece - this.pieceStep, [...ACTIONS, null]);
    return [...all.values()].every((p) => ends(p.piece) === cleared);
  }

  // One raw turn: apply the action (null = illegal output -> no-op), then one row of gravity.
  // A piece that cannot fall during gravity locks. After the per-piece step cap it auto-drops.
  advance(action) {
    if (this.over) throw new Error('game is over');
    this.steps += 1;
    this.pieceStep += 1;
    const piece = this.current.type;
    let result;
    let locked = false;
    let cleared = 0;
    let autoDrop = false;

    switch (action) {
      case 'L': result = this.tryMove(-1, 0) ? 'ok' : 'blocked'; break;
      case 'R': result = this.tryMove(1, 0) ? 'ok' : 'blocked'; break;
      case 'U': result = this.tryRotate() ? 'ok' : 'blocked'; break;
      case 'D': result = this.tryMove(0, 1) ? 'ok' : 'blocked'; break;
      case 'S': result = 'ok'; cleared = this.hardDrop(); locked = true; break;
      default: result = 'invalid';
    }

    if (!locked && !this.tryMove(0, 1)) {
      cleared = this.lock();
      locked = true;
    }
    if (!locked && this.pieceStep >= this.maxStepsPerPiece) {
      cleared = this.hardDrop();
      locked = true;
      autoDrop = true;
    }

    this.lastAction = { action, result };
    return { piece, action, result, locked, cleared, autoDrop };
  }

  columnHeights() {
    return Array.from({ length: WIDTH }, (_, x) => {
      for (let y = 0; y < HEIGHT; y++) if (this.board[y][x] !== null) return HEIGHT - y;
      return 0;
    });
  }

  holes() {
    let holes = 0;
    for (let x = 0; x < WIDTH; x++) {
      let covered = false;
      for (let y = 0; y < HEIGHT; y++) {
        if (this.board[y][x] !== null) covered = true;
        else if (covered) holes += 1;
      }
    }
    return holes;
  }

  // 20 strings of 10 chars using . # @ +
  boardRows() {
    const rows = this.board.map((row) => row.map((c) => (c === null ? '.' : '#')));
    if (!this.over) {
      for (const [x, y] of pieceCells(this.ghost())) rows[y][x] = '+';
      for (const [x, y] of pieceCells(this.current)) rows[y][x] = '@';
    }
    return rows.map((r) => r.join(''));
  }

  // Colored cells for the UI: piece type letter, 'ghost', or null.
  renderCells() {
    const cells = this.board.map((row) => [...row]);
    if (!this.over) {
      for (const [x, y] of pieceCells(this.ghost())) if (!cells[y][x]) cells[y][x] = 'ghost';
      for (const [x, y] of pieceCells(this.current)) cells[y][x] = this.current.type;
    }
    return cells;
  }

  buildUserMessage({ showHeights = false, showHoles = false } = {}) {
    const last = this.lastAction;
    const lastText = !last
      ? 'none'
      : last.result === 'invalid'
        ? 'invalid output (no-op)'
        : `${last.action} (${last.result})`;
    const lines = [
      `Piece: ${this.current.type}  Next: ${this.next}  Step: ${this.pieceStep + 1}/${this.maxStepsPerPiece}`,
      `Last action: ${lastText}`,
      '',
      '   0123456789',
      ...this.boardRows().map((r, y) => `${String(y).padStart(2)} ${r}`),
      '',
    ];
    if (showHeights) lines.push(`Column heights: ${this.columnHeights().join(' ')}`);
    if (showHoles) lines.push(`Holes: ${this.holes()}`);
    if (showHeights || showHoles) lines.push('');
    lines.push('Action:');
    return lines.join('\n');
  }
}
