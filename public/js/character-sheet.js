// Renders the character sheet from the same pixel data the game uses (sprites.js),
// so the sheet cannot drift from the in-game sprites.
import { buildPixels, buildFrames, BODY, PAL } from './sprites.js';
import {
  TEAMS,
  TILE,
  PLAYER_HALF,
  MAX_HP,
  MOVE_SPEED,
  FIRE_COOLDOWN_MS,
  RAPID_COOLDOWN_MS,
  BULLET_SPEED,
  BULLET_DAMAGE,
  BULLET_RANGE_TILES,
  LONG_RANGE_TILES,
  LONG_RANGE_KILLS,
  MAX_DEATHS,
  RESPAWN_MS,
  INVULN_MS,
  CANDY_HEAL,
  POWER_MS,
} from '/shared/config.js';

// What each team wears, matching ATTIRE in sprites.js
const ATTIRE = [
  'Red cape, black collar, white fangs.',
  'Tall pointed hat with an orange star band and a wide brim.',
  'Cream bandages wrapped around head and body.',
  'Straw hat and a patched brown coat.',
];

// What each palette key paints, for the legend
const KEY_NOTES = {
  K: 'Outline',
  T: 'Skin',
  t: 'Skin shade',
  H: 'Hair',
  E: 'Eyes',
  W: 'Fangs (vampire)',
  R: 'Mouth',
  B: 'Shoes',
  A: 'Orange accent (chest emblem, witch hat band)',
  C: 'Bandage (mummy)',
  Q: 'Straw (scarecrow hat)',
  q: 'Straw shade',
  N: 'Patch (scarecrow coat)',
  P: 'Team colour (cape, coat, hat)',
  S: 'Team shade (hem, collar edge)',
};

const SCALE_TEAM = 8; // 16 px sprite drawn at 128 px
const SCALE_BODY = 16; // 256 px anatomy view

// Draws a grid of colours (null = transparent) onto a canvas at an integer scale
function drawPixels(canvas, px, scale) {
  canvas.width = px[0].length * scale;
  canvas.height = px.length * scale;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  px.forEach((row, y) =>
    row.forEach((col, x) => {
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }),
  );
}

// Plain-colour grid for the anatomy view: the base body with team-neutral fill for P/S
function bodyGrid() {
  const neutral = { ...PAL, P: '#7a7a8c', S: '#4f4f5e' };
  return BODY.map((row) => [...row].map((ch) => (ch === '.' ? null : (neutral[ch] ?? null))));
}

function renderTeams() {
  const host = document.getElementById('teams');
  TEAMS.forEach((team, i) => {
    const hex = `#${team.color.toString(16).padStart(6, '0')}`;
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <header>
        <span class="swatch" style="background:${hex}"></span>
        <div>
          <div class="name">${team.name}</div>
          <div class="short">${team.short} · <span class="hex">${hex}</span></div>
        </div>
      </header>
      <canvas class="portrait" width="16" height="16" style="width:${16 * SCALE_TEAM}px;height:${16 * SCALE_TEAM}px"></canvas>
      <p class="attire">${ATTIRE[i]}</p>`;
    host.appendChild(card);
    drawPixels(card.querySelector('canvas'), buildPixels(i), SCALE_TEAM);
  });
}

function renderAnatomy() {
  drawPixels(document.getElementById('body'), bodyGrid(), SCALE_BODY);

  const legend = document.getElementById('legend');
  for (const [key, note] of Object.entries(KEY_NOTES)) {
    const colour = PAL[key] ?? '#7a7a8c';
    legend.insertAdjacentHTML(
      'beforeend',
      `<dt><i style="background:${colour}"></i>${key}</dt><dd>${note}</dd>`,
    );
  }
}

function renderStats() {
  const rows = [
    ['Hit points', `${MAX_HP} HP`, `Each candy heals ${CANDY_HEAL}`],
    ['Lives', `${MAX_DEATHS}`, 'Out of lives after the last death'],
    ['Respawn', `${RESPAWN_MS / 1000} s`, `${INVULN_MS / 1000} s of invulnerability on spawn`],
    ['Move speed', `${MOVE_SPEED} px/s`, `Body box ${PLAYER_HALF * 2} px, tile ${TILE} px`],
    ['Fire cooldown', `${FIRE_COOLDOWN_MS} ms`, `Rapid Fire: ${RAPID_COOLDOWN_MS} ms for ${POWER_MS / 1000} s`],
    ['Bullet', `${BULLET_DAMAGE} dmg at ${BULLET_SPEED} px/s`, `Range ${BULLET_RANGE_TILES} tiles`],
    ['Long range', `${LONG_RANGE_TILES} tiles`, `Needs more than ${LONG_RANGE_KILLS} kills`],
  ];
  const table = document.getElementById('stats');
  table.innerHTML = `<tr><th>Stat</th><th>Value</th><th>Notes</th></tr>${rows
    .map(([stat, value, note]) => `<tr><td>${stat}</td><td class="num">${value}</td><td>${note}</td></tr>`)
    .join('')}`;
}

// Each pose as it is drawn in a match, in the order the game uses them
const POSES = [
  ['base', 'Standing'],
  ['blink', 'Blink'],
  ['walkA', 'Walk 1'],
  ['walkB', 'Walk 2'],
  ['shoot', 'Shoot'],
];

function renderPoses() {
  const host = document.getElementById('poses');
  TEAMS.forEach((team, i) => {
    const frames = buildFrames(i);
    const row = document.createElement('div');
    row.className = 'pose-row';
    row.innerHTML = `<div class="name">${team.name}</div>`;
    for (const [key, label] of POSES) {
      const cell = document.createElement('figure');
      cell.innerHTML = `<canvas width="16" height="16"></canvas><figcaption>${label}</figcaption>`;
      row.appendChild(cell);
      drawPixels(cell.querySelector('canvas'), frames[key], 4);
    }
    host.appendChild(row);
  });
}

renderTeams();
renderAnatomy();
renderPoses();
renderStats();
