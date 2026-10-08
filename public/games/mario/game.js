import {
  Game, parseAction, decisionQuestion, SYSTEM_PROMPT, HEIGHT, VIEW_WIDTH, DEFAULT_LENGTH, DEFAULT_LIMIT, JUMP_RISE, STUCK_STEPS,
} from './engine.js';

const DEATH_LABEL = { pit: 'fell in a pit', enemy: 'hit an enemy' };

export default {
  systemPrompt: SYSTEM_PROMPT,
  parseAction,
  settings: [
    { id: 'length', label: 'Level length', type: 'number', min: 60, max: 400, default: DEFAULT_LENGTH },
    { id: 'limit', label: 'Step limit', type: 'number', min: 1, default: DEFAULT_LIMIT },
    { id: 'next_pit', label: 'Next pit', type: 'checkbox', default: false },
    { id: 'enemy_info', label: 'Enemies in view', type: 'checkbox', default: false },
  ],
  fixedSettings: { height: HEIGHT, view_width: VIEW_WIDTH, jump_rise: JUMP_RISE, stuck_steps: STUCK_STEPS },

  createGame: ({ seed, settings }) => new Game({ seed, length: settings.length, limit: settings.limit }),
  decisionQuestion,
  prompt: (game, settings) =>
    game.buildUserMessage({ showPit: settings.next_pit, showEnemies: settings.enemy_info }),
  snapshot: (game) => ({ x: game.x, y: game.y, state: game.stateText(), view: game.viewRows() }),
  step(game, action) {
    const ev = game.step(action);
    return { result: ev.result, coins: ev.coins, stomps: ev.stomps, x_after: game.x, y_after: game.y };
  },

  stats: [
    { key: 'score', label: 'Score', value: (g) => g.score },
    { key: 'distance', label: 'Progress', value: (g) => `${g.distance} / ${g.flagX - 2} cells` },
    { key: 'coins', label: 'Coins', value: (g) => g.coins },
    { key: 'stomps', label: 'Stomps', value: (g) => g.stomps },
    { key: 'pos', label: 'Position', value: (g) => (g.y >= HEIGHT ? `col ${g.x} (falling)` : `col ${g.x} row ${g.y}`) },
  ],
  result: (g) => ({
    score: g.score,
    distance: g.distance,
    progress: Math.round((g.distance / (g.flagX - 2)) * 1000) / 1000,
    coins: g.coins,
    stomps: g.stomps,
    goal: g.endReason === 'goal',
    death: g.death,
  }),
  endLabel: (g) =>
    g.endReason === 'goal'
      ? `Goal (${g.steps} steps)`
      : g.endReason === 'dead'
        ? `Dead: ${DEATH_LABEL[g.death]}`
        : g.endReason === 'stuck'
          ? `Stuck: no change on screen for ${STUCK_STEPS} steps`
          : `Step limit ${g.limit}`,
  endReasons: { goal: 'Goal', dead: 'Dead', limit: 'Step limit', stuck: 'Stuck' },
  summary: [
    { key: 'score', label: 'Avg score' },
    { key: 'distance', label: 'Avg progress' },
    { key: 'coins', label: 'Avg coins' },
    { key: 'goal', label: 'Goal rate', percent: true },
  ],
  columns: [
    { key: 'score', label: 'Score' },
    { key: 'distance', label: 'Progress' },
  ],

  createView(el) {
    el.classList.add('mario-view');
    const grid = el.appendChild(document.createElement('div'));
    grid.className = 'mario-grid';
    const cells = [];
    for (let i = 0; i < VIEW_WIDTH * HEIGHT; i++) cells.push(grid.appendChild(document.createElement('div')));
    const bar = el.appendChild(document.createElement('div'));
    bar.className = 'mario-progress';
    const fill = bar.appendChild(document.createElement('div'));
    fill.className = 'mario-progress-fill';
    const marker = bar.appendChild(document.createElement('div'));
    marker.className = 'mario-progress-marker';
    const cols = el.appendChild(document.createElement('div'));
    cols.className = 'mario-cols';
    return {
      render(game) {
        const view = game.viewCells();
        const dead = game.endReason === 'dead';
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < VIEW_WIDTH; x++) {
            const c = view[y][x];
            const cls = [];
            if (c.tile !== '.') {
              cls.push(`mario-t-${c.tile}`);
              // Highlight top surfaces; pipe tops get a lip.
              if (y === 0 || view[y - 1][x].tile !== c.tile) cls.push('mario-top');
              if (c.tile === 'P') {
                cls.push(game.tiles[y][c.x - 1] === 'P' ? 'mario-pipe-r' : 'mario-pipe-l');
              }
            } else if (c.player) {
              cls.push('mario-player', game.grounded ? 'mario-still' : 'mario-air');
              if (dead) cls.push('mario-dead');
            } else if (c.enemy) {
              cls.push('mario-enemy');
            } else if (c.coin) {
              cls.push('mario-coin');
            } else if (c.flag) {
              cls.push(c.y === game.flagTop ? 'mario-flag-top' : 'mario-flag');
            }
            cells[y * VIEW_WIDTH + x].className = cls.join(' ');
          }
        }
        const pct = Math.min(100, (game.x / game.flagX) * 100);
        fill.style.width = `${Math.min(100, (game.maxX / game.flagX) * 100)}%`;
        marker.style.left = `${pct}%`;
        const x0 = game.viewStart();
        cols.replaceChildren(
          ...[`col ${x0}`, `flag col ${game.flagX}`, `col ${x0 + VIEW_WIDTH - 1}`].map((t) =>
            Object.assign(document.createElement('span'), { textContent: t }),
          ),
        );
      },
    };
  },
};
