import { GameScene, session } from './game-scene.js';

const PHASE_LABEL = {
  waiting: 'Open',
  starting: 'Filling up',
  playing: 'In match',
  results: 'Results',
};

const $ = (sel) => document.querySelector(sel);
const lobbyEl = $('#lobby');
const gameEl = $('#game');
const roomsEl = $('#rooms');
const nameEl = $('#name');
const errorEl = $('#error');

const socket = io();
let game = null;

try {
  nameEl.value = localStorage.getItem('qt-name') ?? '';
} catch {
  /* storage blocked: fine */
}

socket.on('rooms', renderRooms);
socket.on('connect', () => setError(''));
socket.on('disconnect', () => setError('Lost connection to the server. Reconnecting...'));

function setError(msg) {
  errorEl.textContent = msg;
}

function renderRooms(rooms) {
  roomsEl.replaceChildren(...rooms.map(roomCard));
}

function roomCard(r) {
  const card = document.createElement('article');
  card.className = 'room';

  const title = document.createElement('h2');
  title.textContent = r.name;

  const theme = document.createElement('p');
  theme.className = 'theme';
  theme.textContent = r.theme;

  const meta = document.createElement('p');
  meta.className = 'meta';
  const humans = `${r.humans} player${r.humans === 1 ? '' : 's'}`;
  meta.textContent = `${PHASE_LABEL[r.phase] ?? r.phase} · ${humans} · ${r.bots} bot${r.bots === 1 ? '' : 's'}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = r.full ? 'Full' : 'Join';
  btn.disabled = r.full;
  btn.addEventListener('click', () => join(r.id));

  card.append(title, theme, meta, btn);
  return card;
}

function join(roomId) {
  const name = nameEl.value.trim() || 'Trick-or-Treater';
  try {
    localStorage.setItem('qt-name', name);
  } catch {
    /* storage blocked: fine */
  }
  setError('');
  socket.emit('join', { name, roomId }, (res) => {
    if (!res?.ok) return setError(res?.error ?? 'Could not join that room.');
    enterGame(res.map);
  });
}

function enterGame(initialMap) {
  lobbyEl.hidden = true;
  gameEl.hidden = false;
  session.net = { socket, onLeave: leave, initialMap };
  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: 320,
    height: 224,
    pixelArt: true,
    backgroundColor: '#0b0712',
    audio: { noAudio: true }, // sound comes from audio.js
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene: [GameScene],
  });
}

// Deferred so the scene can finish its current update before the game is torn down.
function leave() {
  setTimeout(() => {
    if (!game) return;
    session.detach?.();
    session.detach = null;
    socket.emit('leave');
    game.destroy(true);
    game = null;
    gameEl.hidden = true;
    lobbyEl.hidden = false;
  }, 0);
}
