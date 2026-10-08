import {
  Game, parseAction, decisionQuestion, SYSTEM_PROMPT, WIDTH, HEIGHT, WALLS, OUTLINE, TARGETS, BUMPERS, BALL_RADIUS,
  FLIPPER_LENGTH, FLIPPER_RADIUS, STEP_SECONDS, SUBSTEPS, OVERHEAT_STEPS, POINTS, DEFAULT_BALLS,
  DEFAULT_MAX_STEPS,
} from './engine.js';

const SCALE = 14; // CSS px per cell
const ANIM_MS = STEP_SECONDS * 1000; // replay a step in real time
const TRAIL = 16; // frames in the ball trail
const round2 = (v) => Math.round(v * 100) / 100;
const flipperState = (f) => (f.overheated ? 'overheated' : f.up ? 'up' : 'down');

export default {
  systemPrompt: SYSTEM_PROMPT,
  parseAction,
  settings: [
    { id: 'balls', label: 'Balls', type: 'number', min: 1, default: DEFAULT_BALLS },
    { id: 'max_steps', label: 'Step limit', type: 'number', min: 1, default: DEFAULT_MAX_STEPS },
    { id: 'eta', label: 'Flipper ETA', type: 'checkbox', default: false },
    { id: 'trail', label: 'Ball trail', type: 'checkbox', default: false },
  ],
  fixedSettings: {
    step_seconds: STEP_SECONDS,
    substeps: SUBSTEPS,
    overheat_steps: OVERHEAT_STEPS,
    miss_penalty: -POINTS.miss,
  },

  createGame: ({ seed, settings }) => new Game({ seed, balls: settings.balls, maxSteps: settings.max_steps }),
  decisionQuestion,
  prompt: (game, settings) => game.buildUserMessage({ eta: settings.eta, trail: settings.trail }),
  snapshot: (game) => ({
    ball_no: game.ballNo,
    x: round2(game.ball.x),
    y: round2(game.ball.y),
    vx: round2(game.ball.vx * STEP_SECONDS),
    vy: round2(game.ball.vy * STEP_SECONDS),
    flippers: { left: flipperState(game.left), right: flipperState(game.right) },
    table: game.tableRows(),
  }),
  step(game, action) {
    const ev = game.step(action);
    return {
      result: ev.result,
      bumpers: ev.bumpers,
      targets: ev.targets,
      bank: ev.bank,
      shots: ev.shots,
      misses: ev.misses,
      drained: ev.drained,
    };
  },

  stats: [
    { key: 'score', label: 'Score', value: (g) => g.score },
    { key: 'ball', label: 'Ball', value: (g) => `${g.ballNo} / ${g.totalBalls}` },
    { key: 'multiplier', label: 'Multiplier', value: (g) => `×${g.multiplier}` },
    { key: 'bumpers', label: 'Bumpers', value: (g) => g.bumperHits },
    { key: 'targets', label: 'Targets', value: (g) => `${g.lit.filter(Boolean).length} / ${TARGETS.length}` },
    { key: 'shots', label: 'Hits / misses', value: (g) => `${g.shots} / ${g.misses}` },
    { key: 'best', label: 'Best ball', value: (g) => g.bestBall },
  ],
  result: (g) => ({
    score: g.score,
    balls: g.ballNo,
    bumper_hits: g.bumperHits,
    target_hits: g.targetHits,
    banks: g.banks,
    multiplier: g.multiplier,
    shots: g.shots,
    misses: g.misses,
    best_ball: g.bestBall,
  }),
  endLabel: (g) => (g.endReason === 'drained' ? `All ${g.totalBalls} balls drained` : `Limit: ${g.steps} steps`),
  endReasons: { drained: 'Drained', limit: 'Step limit' },
  summary: [
    { key: 'score', label: 'Avg score' },
    { key: 'bumper_hits', label: 'Avg bumpers' },
    { key: 'shots', label: 'Avg hits' },
    { key: 'misses', label: 'Avg misses' },
    { key: 'best_ball', label: 'Avg best ball' },
  ],
  columns: [
    { key: 'score', label: 'Score' },
    { key: 'shots', label: 'Hits' },
    { key: 'misses', label: 'Misses' },
  ],

  createView(el) {
    el.classList.add('pinball-view');
    const canvas = el.appendChild(document.createElement('canvas'));
    canvas.className = 'pinball-canvas';
    const ctx = canvas.getContext('2d');
    let dpr = 0;
    let game = null;
    let key = null; // step whose frames are shown
    let started = 0;
    let raf = 0;
    let base = []; // ball path before the replayed step
    let frames = []; // frames of the replayed step

    function resize() {
      const d = window.devicePixelRatio || 1;
      if (d === dpr) return;
      dpr = d;
      canvas.width = Math.round(WIDTH * SCALE * dpr);
      canvas.height = Math.round(HEIGHT * SCALE * dpr);
    }

    function frame(now) {
      raf = 0;
      if (!game) return;
      resize();
      const t = Math.min(1, Math.max(0, (now - started) / ANIM_MS));
      const idx = Math.round(t * (frames.length - 1));
      draw(ctx, dpr, game, frames[idx], trailPath([...base, ...frames.slice(0, idx + 1)]), t);
      if (t < 1) raf = requestAnimationFrame(frame);
    }

    return {
      render(g) {
        const k = `${g.steps}:${g.ballNo}`;
        if (g !== game || k !== key) {
          // New step or game: replay its frames in real time.
          base = g !== game ? [] : trailPath([...base, ...frames]);
          frames = g.frames;
          game = g;
          key = k;
          started = performance.now();
        }
        if (!raf) raf = requestAnimationFrame(frame);
      },
    };
  },
};

// Last TRAIL ball positions; a new ball starts a fresh path.
function trailPath(list) {
  let out = [];
  for (const f of list) {
    if (f.jump) out = [];
    out.push(f);
  }
  return out.slice(-TRAIL);
}

// ---------- canvas drawing (units = cells) ----------

const COLORS = {
  bg: '#0c0e12',
  field: ['#171c27', '#10141b'],
  wall: '#566074',
  wallGlow: 'rgba(91, 157, 255, 0.18)',
  target: '#4b5261',
  targetLit: '#f2cf3a',
  bumper: '#f29a3a',
  bumperCore: '#3b2614',
  flipper: '#5b9dff',
  flipperUp: '#8fbcff',
  overheated: '#ff6b6b',
  ball: ['#ffffff', '#c9ced8', '#6b7280'],
  text: '#8b93a1',
};

function draw(ctx, dpr, game, cur, trail, t) {
  ctx.setTransform(dpr * SCALE, 0, 0, dpr * SCALE, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Playfield.
  ctx.beginPath();
  OUTLINE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, COLORS.field[0]);
  grad.addColorStop(1, COLORS.field[1]);
  ctx.fillStyle = grad;
  ctx.fill();

  // Spotlight and insert lamps mirroring the targets.
  const spot = ctx.createRadialGradient(WIDTH / 2, 12, 0, WIDTH / 2, 12, 11);
  spot.addColorStop(0, 'rgba(91, 157, 255, 0.07)');
  spot.addColorStop(1, 'rgba(91, 157, 255, 0)');
  ctx.fillStyle = spot;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  game.lit.forEach((on, i) => {
    const x = WIDTH / 2 + (i - (game.lit.length - 1) / 2) * 1.5;
    ctx.beginPath();
    ctx.arc(x, 17.5, 0.38, 0, Math.PI * 2);
    ctx.fillStyle = on ? COLORS.targetLit : 'rgba(242, 207, 58, 0.12)';
    ctx.save();
    if (on) {
      ctx.shadowColor = COLORS.targetLit;
      ctx.shadowBlur = 8 * dpr;
    }
    ctx.fill();
    ctx.restore();
  });
  // Inlane arrows pointing at the flippers.
  ctx.strokeStyle = 'rgba(91, 157, 255, 0.25)';
  ctx.lineWidth = 0.14;
  for (const side of [-1, 1]) {
    const d = [-side * Math.SQRT1_2, Math.SQRT1_2]; // down the guide
    const n = [side * -Math.SQRT1_2, -Math.SQRT1_2]; // into the table
    for (const k of [0.3, 0.5, 0.7]) {
      const cx = WIDTH / 2 + side * (10 - 5.5 * k) + n[0] * 1.4;
      const cy = 19.5 + 5.5 * k + n[1] * 1.4;
      ctx.beginPath();
      ctx.moveTo(cx - d[0] * 0.3 + n[0] * 0.45, cy - d[1] * 0.3 + n[1] * 0.45);
      ctx.lineTo(cx + d[0] * 0.3, cy + d[1] * 0.3);
      ctx.lineTo(cx - d[0] * 0.3 - n[0] * 0.45, cy - d[1] * 0.3 - n[1] * 0.45);
      ctx.stroke();
    }
  }

  // Walls.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.wallGlow;
  ctx.lineWidth = 0.6;
  strokeSegments(ctx, WALLS);
  ctx.strokeStyle = COLORS.wall;
  ctx.lineWidth = 0.22;
  strokeSegments(ctx, WALLS);

  // Targets: amber when lit, white flash on hit.
  TARGETS.forEach((s, i) => {
    const flash = flashLevel(game, game.targetFlash[i], t);
    ctx.save();
    ctx.strokeStyle = game.lit[i] ? COLORS.targetLit : COLORS.target;
    if (game.lit[i] || flash) {
      ctx.shadowColor = COLORS.targetLit;
      ctx.shadowBlur = (6 + 10 * flash) * dpr;
    }
    if (flash) ctx.strokeStyle = mix(game.lit[i] ? COLORS.targetLit : COLORS.target, '#ffffff', flash);
    ctx.lineWidth = 0.5;
    ctx.lineCap = 'butt';
    const inset = 0.15;
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    ctx.beginPath();
    ctx.moveTo(s.x1 + (dx / len) * inset, s.y1 + (dy / len) * inset);
    ctx.lineTo(s.x2 - (dx / len) * inset, s.y2 - (dy / len) * inset);
    ctx.stroke();
    ctx.restore();
  });

  // Bumpers.
  BUMPERS.forEach((b, i) => {
    const flash = flashLevel(game, game.bumperFlash[i], t);
    ctx.save();
    ctx.shadowColor = COLORS.bumper;
    ctx.shadowBlur = (4 + 16 * flash) * dpr;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = mix(COLORS.bumperCore, '#ffd9a8', flash);
    ctx.fill();
    ctx.lineWidth = 0.28;
    ctx.strokeStyle = mix(COLORS.bumper, '#ffffff', flash * 0.6);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = mix(COLORS.bumper, '#ffffff', flash);
    ctx.globalAlpha = 0.55 + 0.45 * flash;
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  // Flippers.
  game.flippers.forEach((f, i) => {
    const angle = i === 0 ? cur.la : cur.ra;
    const tx = f.px + FLIPPER_LENGTH * Math.cos(angle);
    const ty = f.py + FLIPPER_LENGTH * Math.sin(angle);
    const color = f.overheated ? COLORS.overheated : f.up ? COLORS.flipperUp : COLORS.flipper;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = (f.up ? 10 : 4) * dpr;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineWidth = FLIPPER_RADIUS * 2;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(f.px, f.py, 0.42, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(f.px, f.py, 0.16, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
  });

  // Spare balls below the left inlane.
  for (let i = 0; i < game.ballsLeft; i++) {
    ctx.beginPath();
    ctx.arc(1.2 + i * 1.2, 28.6, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#9aa3b2';
    ctx.fill();
  }

  // Trail and ball.
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1];
    const b = trail[i];
    const k = i / trail.length;
    ctx.strokeStyle = `rgba(200, 215, 240, ${0.35 * k})`;
    ctx.lineWidth = BALL_RADIUS * 2 * (0.3 + 0.6 * k);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  if (!game.over || cur.y < HEIGHT) {
    const g = ctx.createRadialGradient(cur.x - 0.15, cur.y - 0.18, 0.05, cur.x, cur.y, BALL_RADIUS);
    g.addColorStop(0, COLORS.ball[0]);
    g.addColorStop(0.5, COLORS.ball[1]);
    g.addColorStop(1, COLORS.ball[2]);
    ctx.save();
    ctx.shadowColor = 'rgba(255, 255, 255, 0.5)';
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    ctx.arc(cur.x, cur.y, BALL_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  // Text in CSS px so small type is not scaled up.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = game.multiplier > 1 ? COLORS.targetLit : COLORS.text;
  ctx.font = '600 16px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(`×${game.multiplier}`, 20.2 * SCALE, 28.6 * SCALE);
  if (game.over && t === 1) {
    ctx.fillStyle = 'rgba(12, 14, 18, 0.6)';
    ctx.fillRect(0, 0, WIDTH * SCALE, HEIGHT * SCALE);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e4e7ec';
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.fillText(game.endReason === 'drained' ? 'GAME OVER' : 'TIME UP', (WIDTH / 2) * SCALE, 14.5 * SCALE);
    ctx.fillStyle = COLORS.text;
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText(`${game.score} pts`, (WIDTH / 2) * SCALE, 16.5 * SCALE);
  }
}

function strokeSegments(ctx, segs) {
  ctx.beginPath();
  for (const s of segs) {
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(s.x2, s.y2);
  }
  ctx.stroke();
}

// 1 on the step shown when hit, fading over two steps.
function flashLevel(game, hitStep, t) {
  const age = game.steps - hitStep + t;
  return age >= 3 ? 0 : Math.max(0, 1 - age / 3);
}

function mix(a, b, k) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * k)).join(',')})`;
}
