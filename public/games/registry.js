// Games on the landing page. Each id maps to public/games/<id>/:
//   engine.js  pure game logic, importable in Node (exports SYSTEM_PROMPT, ACTIONS, parseAction)
//   game.js    arena adapter (default export, see public/arena.js)
//   style.css  game styles, scoped to body[data-game="<id>"]
export const GAMES = [
  {
    id: 'tetris',
    title: 'Tetris',
    subtitle: 'Puzzle',
    description: '10×20 board, 7-bag pieces. Move, rotate and drop; score by clearing lines.',
    actions: ['L', 'R', 'U', 'D', 'S'],
  },
  {
    id: 'snake',
    title: 'Snake',
    subtitle: 'Arcade',
    description: 'N×N board, same food sequence per seed. Eat to grow; hitting a wall or yourself ends the game.',
    actions: ['U', 'D', 'L', 'R'],
  },
  {
    id: 'mario',
    title: 'Mario',
    subtitle: 'Platformer',
    description: 'Procedural side-scrolling level. Jump pits, stomp enemies, race to the flag.',
    actions: ['R', 'L', 'J', 'U', 'N'],
  },
  {
    id: 'pinball',
    title: 'Pinball',
    subtitle: 'Physics',
    description: '21×30 table, same launches per seed. Time the flippers to hit bumpers and targets.',
    actions: ['L', 'R', 'B', 'N'],
  },
];
