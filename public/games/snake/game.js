import {
  Game, parseAction, decisionQuestion, SYSTEM_PROMPT, DIRS, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE, INITIAL_LENGTH, FOOD_SCORE,
  DEFAULT_MAX_STEPS, DEFAULT_STARVE_STEPS,
} from './engine.js';

const END_LABELS = { wall: 'Hit wall', self: 'Hit self', starve: 'Starved', limit: 'Step limit', full: 'Board full' };

export default {
  systemPrompt: SYSTEM_PROMPT,
  parseAction,
  settings: [
    { id: 'size', label: 'Board size', type: 'number', min: MIN_SIZE, max: MAX_SIZE, default: DEFAULT_SIZE },
    { id: 'max_steps', label: 'Step limit', type: 'number', min: 1, default: DEFAULT_MAX_STEPS },
    { id: 'starve_steps', label: 'Starve steps N', type: 'number', min: 1, default: DEFAULT_STARVE_STEPS },
    { id: 'food_offset', label: 'Food offset', type: 'checkbox', default: false },
    { id: 'safe_moves', label: 'Safe moves', type: 'checkbox', default: false },
  ],
  fixedSettings: { initial_length: INITIAL_LENGTH, food_score: FOOD_SCORE },

  createGame: ({ seed, settings }) =>
    new Game({ seed, size: settings.size, maxSteps: settings.max_steps, starveSteps: settings.starve_steps }),
  decisionQuestion,
  prompt: (game, settings) =>
    game.buildUserMessage({ showFoodOffset: settings.food_offset, showSafeMoves: settings.safe_moves }),
  snapshot: (game) => ({
    heading: game.heading,
    length: game.length,
    head: [...game.head],
    food_pos: game.foodPos && [...game.foodPos],
    since_food: game.sinceFood,
    board: game.boardRows(),
  }),
  step(game, action) {
    const ev = game.step(action);
    return { result: ev.result, heading: ev.heading, ate: ev.ate, crash: ev.crash };
  },

  stats: [
    { key: 'score', label: 'Score', value: (g) => g.score },
    { key: 'length', label: 'Length', value: (g) => g.length },
    { key: 'food', label: 'Food', value: (g) => g.food },
    { key: 'hunger', label: 'Since food', value: (g) => `${g.sinceFood} / ${g.starveSteps}` },
    { key: 'heading', label: 'Heading', value: (g) => g.heading },
  ],
  result: (g) => ({ score: g.score, food: g.food, length: g.length, survived: g.steps }),
  endLabel: (g) =>
    g.endReason === 'limit' ? `Limit: ${g.steps} steps`
      : g.endReason === 'starve' ? `Starved (${g.starveSteps} steps without food)`
        : END_LABELS[g.endReason] ?? g.endReason,
  endReasons: END_LABELS,
  summary: [
    { key: 'score', label: 'Avg score' },
    { key: 'length', label: 'Avg length' },
    { key: 'survived', label: 'Avg steps survived' },
  ],
  columns: [
    { key: 'score', label: 'Score' },
    { key: 'length', label: 'Length' },
    { key: 'survived', label: 'Survived' },
  ],

  createView(el) {
    el.classList.add('snake-view');
    const canvas = el.appendChild(document.createElement('canvas'));
    canvas.className = 'snake-board';
    const ctx = canvas.getContext('2d');
    return { render: (game) => draw(canvas, ctx, game) };
  },
};

// ---------- canvas drawing ----------

const COLORS = {
  bg: '#0c0e12', alt: '#10131a', tail: [38, 110, 78], head: [110, 226, 140],
  crash: '#ff6b6b', food: '#ff5d73', leaf: '#5fd068', eye: '#0c0e12',
};

const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

function draw(canvas, ctx, game) {
  const cssSize = canvas.clientWidth || 300;
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round(cssSize * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  ctx.setTransform(px / cssSize, 0, 0, px / cssSize, 0, 0);

  const n = game.size;
  const cell = cssSize / n;
  const center = ([x, y]) => [(x + 0.5) * cell, (y + 0.5) * cell];

  // Checkerboard.
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = COLORS.alt;
  for (let y = 0; y < n; y++) {
    for (let x = (y % 2); x < n; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);
  }

  // Food: glow plus a leaf.
  if (game.foodPos) {
    const [fx, fy] = center(game.foodPos);
    ctx.save();
    ctx.shadowColor = 'rgba(255, 93, 115, 0.75)';
    ctx.shadowBlur = cell * 0.7;
    ctx.fillStyle = COLORS.food;
    ctx.beginPath();
    ctx.arc(fx, fy + cell * 0.04, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = COLORS.leaf;
    ctx.beginPath();
    ctx.ellipse(fx + cell * 0.1, fy - cell * 0.3, cell * 0.12, cell * 0.06, -0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Body: one rounded stroke per segment, dark tail to bright head.
  const pts = game.snake.map(center);
  const len = pts.length;
  ctx.lineCap = 'round';
  ctx.lineWidth = cell * 0.7;
  for (let i = len - 1; i > 0; i--) {
    ctx.strokeStyle = mix(COLORS.tail, COLORS.head, 1 - i / (len - 1));
    ctx.beginPath();
    ctx.moveTo(...pts[i]);
    ctx.lineTo(...pts[i - 1]);
    ctx.stroke();
  }

  // Head: eyes face the heading; red after a crash.
  const crashed = game.endReason === 'wall' || game.endReason === 'self';
  const [hx, hy] = pts[0];
  ctx.fillStyle = crashed ? COLORS.crash : mix(COLORS.head, [190, 255, 205], 0.25);
  ctx.beginPath();
  ctx.arc(hx, hy, cell * 0.42, 0, Math.PI * 2);
  ctx.fill();
  const [dx, dy] = DIRS[game.heading];
  ctx.fillStyle = COLORS.eye;
  for (const side of [-1, 1]) {
    const ex = hx + dx * cell * 0.14 + -dy * side * cell * 0.17;
    const ey = hy + dy * cell * 0.14 + dx * side * cell * 0.17;
    ctx.beginPath();
    ctx.arc(ex, ey, Math.max(1.2, cell * 0.075), 0, Math.PI * 2);
    ctx.fill();
  }

  // Dim the board once the game is over.
  if (game.over) {
    ctx.fillStyle = 'rgba(12, 14, 18, 0.55)';
    ctx.fillRect(0, 0, cssSize, cssSize);
    const label = END_LABELS[game.endReason] ?? '';
    const fontPx = Math.round(cssSize / 14);
    ctx.font = `600 ${fontPx}px system-ui, "Noto Sans TC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + fontPx * 1.4;
    const h = fontPx * 1.9;
    ctx.fillStyle = 'rgba(26, 29, 36, 0.92)';
    ctx.strokeStyle = crashed ? COLORS.crash : '#2c313b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect((cssSize - w) / 2, (cssSize - h) / 2, w, h, h / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = crashed ? COLORS.crash : '#e4e7ec';
    ctx.fillText(label, cssSize / 2, cssSize / 2 + 1);
  }
}
