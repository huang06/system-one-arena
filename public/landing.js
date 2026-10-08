import { GAMES } from './games/registry.js';

const $ = (id) => document.getElementById(id);

// Decorative thumbnails per game.
const THUMBS = {
  tetris: `<rect x="44" y="14" width="12" height="12" fill="#b06ee8"/><rect x="32" y="26" width="36" height="12" fill="#b06ee8"/>
    <rect x="8" y="62" width="12" height="12" fill="#35c9e8"/><rect x="20" y="62" width="12" height="12" fill="#35c9e8"/>
    <rect x="32" y="62" width="12" height="12" fill="#f2cf3a"/><rect x="56" y="62" width="24" height="12" fill="#5fd068"/>
    <rect x="80" y="62" width="12" height="12" fill="#f29a3a"/><rect x="8" y="50" width="24" height="12" fill="#4f7bf0"/>
    <rect x="68" y="50" width="24" height="12" fill="#f05a5a"/>`,
  snake: `<path d="M16 60 H52 V32 H80" stroke="#5fd068" stroke-width="10" fill="none" stroke-linejoin="round"/>
    <circle cx="80" cy="32" r="6" fill="#8be28f"/><circle cx="84" cy="62" r="5" fill="#f05a5a"/>`,
  mario: `<rect x="0" y="66" width="100" height="14" fill="#8a5a2b"/><rect x="58" y="42" width="14" height="24" fill="#3aa655"/>
    <rect x="24" y="44" width="10" height="10" fill="#f05a5a"/><rect x="24" y="54" width="10" height="12" fill="#4f7bf0"/>
    <rect x="44" y="18" width="12" height="12" fill="#f2cf3a"/><circle cx="86" cy="60" r="6" fill="#b06ee8"/>`,
  pinball: `<path d="M10 76 V20 Q10 6 50 6 Q90 6 90 20 V76" stroke="#8b93a1" stroke-width="3" fill="none"/>
    <circle cx="36" cy="30" r="7" fill="#f29a3a"/><circle cx="64" cy="30" r="7" fill="#f29a3a"/><circle cx="50" cy="46" r="5" fill="#e4e7ec"/>
    <path d="M24 66 L44 74 M76 66 L56 74" stroke="#5b9dff" stroke-width="5" stroke-linecap="round"/>`,
};

function renderGames(loaded) {
  const grid = $('gameGrid');
  grid.innerHTML = '';
  for (const g of GAMES) {
    const ready = loaded.has(g.id);
    const card = document.createElement(ready ? 'a' : 'div');
    card.className = `game-card${ready ? '' : ' disabled'}`;
    if (ready) card.href = `play.html?game=${encodeURIComponent(g.id)}`;
    card.innerHTML = `
      <svg class="thumb" viewBox="0 0 100 80" aria-hidden="true">${THUMBS[g.id] ?? ''}</svg>
      <div class="card-body">
        <h2>${g.title} <small>${g.subtitle}</small></h2>
        <p>${g.description}</p>
        <div class="chips">${g.actions.map((a) => `<span class="chip mono">${a}</span>`).join('')}</div>
      </div>
      <span class="card-cta">${ready ? 'Play →' : 'Unavailable'}</span>`;
    grid.appendChild(card);
  }
}

// All configured bots; the match page can leave some out.
function renderMatchup(panes) {
  const box = $('matchup');
  box.replaceChildren();
  panes.forEach(({ id, model }, i) => {
    if (i) box.appendChild(Object.assign(document.createElement('span'), { className: 'vs', textContent: 'vs' }));
    const side = box.appendChild(Object.assign(document.createElement('span'), { className: 'side' }));
    side.append(Object.assign(document.createElement('b'), { textContent: id }), ` ${model}`);
  });
}

try {
  const body = await (await fetch('/api/config')).json();
  renderMatchup(body.panes);
  renderGames(new Set(Object.keys(body.games)));
} catch (err) {
  $('matchup').textContent = `Cannot reach server: ${err}`;
  renderGames(new Set());
}
