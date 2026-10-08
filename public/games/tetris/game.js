import { Game, parseAction, decisionQuestion, SYSTEM_PROMPT, WIDTH, HEIGHT, MAX_STEPS_PER_PIECE } from './engine.js';

export default {
  systemPrompt: SYSTEM_PROMPT,
  parseAction,
  settings: [
    { id: 'max_pieces', label: 'Piece limit M', type: 'number', min: 1, default: 100 },
    { id: 'column_heights', label: 'Column heights', type: 'checkbox', default: false },
    { id: 'holes', label: 'Holes', type: 'checkbox', default: false },
  ],
  fixedSettings: { max_steps_per_piece: MAX_STEPS_PER_PIECE },

  createGame: ({ seed, settings }) => new Game({ seed, maxPieces: settings.max_pieces }),
  decisionQuestion,
  prompt: (game, settings) =>
    game.buildUserMessage({ showHeights: settings.column_heights, showHoles: settings.holes }),
  snapshot: (game) => ({ piece: game.current.type, piece_step: game.pieceStep + 1, board: game.boardRows() }),
  step(game, action) {
    const ev = game.step(action);
    return { result: ev.result, locked: ev.locked, cleared: ev.cleared, auto_drop: ev.autoDrop };
  },

  decisionNote: (e) =>
    [
      `${e.piece} ${e.piece_step}/${MAX_STEPS_PER_PIECE} ${e.result}`,
      e.auto_drop && 'auto-drop',
      e.locked && 'locked',
      e.cleared && `cleared ${e.cleared}`,
    ].filter(Boolean).join(' · '),

  stats: [
    { key: 'score', label: 'Score', value: (g) => g.score },
    { key: 'lines', label: 'Lines', value: (g) => g.lines },
    { key: 'pieces', label: 'Pieces', value: (g) => g.pieces },
    { key: 'next', label: 'Next', value: (g) => (g.over ? '–' : g.next) },
  ],
  result: (g) => ({ score: g.score, lines: g.lines, pieces: g.pieces }),
  endLabel: (g) => (g.endReason === 'topout' ? 'Top out' : `Limit: ${g.pieces} pieces`),
  endReasons: { topout: 'Top out', limit: 'Limit' },
  summary: [
    { key: 'score', label: 'Avg score' },
    { key: 'lines', label: 'Avg lines' },
    { key: 'pieces', label: 'Avg pieces' },
  ],
  columns: [
    { key: 'score', label: 'Score' },
    { key: 'lines', label: 'Lines' },
  ],

  createView(el) {
    el.classList.add('tetris-board');
    const cells = [];
    for (let i = 0; i < WIDTH * HEIGHT; i++) cells.push(el.appendChild(document.createElement('div')));
    return {
      render(game) {
        const grid = game.renderCells();
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < WIDTH; x++) {
            const c = grid[y][x];
            cells[y * WIDTH + x].className = c === null ? '' : c === 'ghost' ? 'ghost' : `c-${c}`;
          }
        }
      },
    };
  },
};
