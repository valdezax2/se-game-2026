import { GameScene, session } from './game-scene.js';
import { PLAYER_COLORS } from '/shared/config.js';

const TOKEN_KEY = 'qt-token';
const PHASE_LABEL = { waiting: 'Open', starting: 'Starting', playing: 'In match', results: 'Results' };

const $ = (sel) => document.querySelector(sel);
const show = (el, on) => {
  el.hidden = !on;
};
const setText = (sel, text) => {
  $(sel).textContent = text ?? '';
};
const el = (tag, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

let token = null;
let me = null; // { id, displayName, email }
let socket = null;
let game = null;
let room = null; // latest room state while in a room
let latestMap = null;
let lastRoomsSig = '';

// ---- HTTP helpers ---------------------------------------------------------

const errorText = (err) => (err?.errors ? err.errors.join(' ') : err?.error) || 'Something went wrong. Please try again.';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw data;
  return data;
}

// ---- Views ----------------------------------------------------------------

function setView(name) {
  show($('#auth'), name === 'auth');
  show($('#lobby'), name === 'lobby');
  show($('#room'), name === 'room');
  show($('#game'), name === 'game');
  show($('#game-bar'), name === 'game');
  document.body.classList.toggle('in-game', name === 'game');
}

// Decides between room screen and live game from the room's phase.
function syncView() {
  if (!room) {
    stopGame();
    setView('lobby');
    return;
  }
  const playing = room.phase === 'playing' && latestMap;
  // Show the right container first: Phaser sizes its canvas from the parent when it starts.
  setView(playing ? 'game' : 'room');
  if (playing && !game) startGame();
  if (!playing && game) stopGame();
}

// ---- Session --------------------------------------------------------------

function startSession({ token: t, user }) {
  token = t;
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* storage blocked: the session still works until reload */
  }
  me = user;
  showLobby();
}

function forgetSession() {
  token = null;
  me = null;
  room = null;
  latestMap = null;
  stopGame();
  socket?.disconnect();
  socket = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}

async function boot() {
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    token = null;
  }
  if (token) {
    try {
      me = await api('/api/me');
      return showLobby();
    } catch {
      forgetSession();
    }
  }
  setView('auth');
}

function showLobby() {
  setView('lobby');
  setText('#whoami', `Signed in as ${me.displayName}`);
  connectSocket();
  loadLeaderboard();
}

function connectSocket() {
  if (socket) return;
  socket = io({ auth: { token } });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      forgetSession();
      setView('auth');
      setText('#auth-error', 'Your session expired. Please log in again.');
    }
  });
  socket.on('rooms', renderRooms);
  socket.on('room:state', onRoomState);
  socket.on('map', (m) => {
    latestMap = m;
    syncView();
  });
}

// ---- Auth forms -----------------------------------------------------------

function selectAuthTab(which) {
  const login = which === 'login';
  $('#tab-login').setAttribute('aria-selected', String(login));
  $('#tab-register').setAttribute('aria-selected', String(!login));
  show($('#login-form'), login);
  show($('#register-form'), !login);
  setText('#auth-error', '');
}

$('#tab-login').addEventListener('click', () => selectAuthTab('login'));
$('#tab-register').addEventListener('click', () => selectAuthTab('register'));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setText('#auth-error', '');
  try {
    startSession(await api('/api/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
  } catch (err) {
    setText('#auth-error', errorText(err));
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setText('#auth-error', '');
  try {
    startSession(await api('/api/register', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
  } catch (err) {
    setText('#auth-error', errorText(err));
  }
});

$('#logout').addEventListener('click', () => {
  if (room) socket?.emit('room:leave', {}, () => {});
  api('/api/logout', { method: 'POST' }).catch(() => {});
  forgetSession();
  setView('auth');
});

// ---- Lobby ----------------------------------------------------------------

$('#visibility').addEventListener('change', (e) => {
  show($('#create-password-wrap'), e.target.value === 'private');
});

$('#create-form').addEventListener('submit', (e) => {
  e.preventDefault();
  setText('#create-error', '');
  const body = Object.fromEntries(new FormData(e.target));
  socket.emit('room:create', body, (res) => {
    if (!res?.ok) return setText('#create-error', res?.error ?? 'Could not create the room.');
    enterRoom(res);
  });
});

function renderRooms(list) {
  const sig = JSON.stringify(list);
  if (sig === lastRoomsSig) return; // avoid wiping a password someone is typing
  lastRoomsSig = sig;

  const container = $('#rooms');
  if (!list.length) {
    container.replaceChildren(el('p', 'hint', 'No rooms yet. Create one above.'));
    return;
  }
  container.replaceChildren(...list.map(roomCard));
}

function roomCard(r) {
  const full = r.humans >= r.humanSlots;
  const card = el('article', 'room');
  card.append(
    el('h3', '', r.name),
    el(
      'p',
      'meta',
      `${r.locked ? 'Private' : 'Public'} · ${PHASE_LABEL[r.phase] ?? r.phase} · ${r.humans}/${r.humanSlots} humans · ` +
        `${r.totalSlots} total · ${r.difficulty} CPUs · host ${r.host ?? '—'}`,
    ),
  );

  let pw = null;
  if (r.locked) {
    pw = el('input');
    pw.type = 'password';
    pw.placeholder = 'Room password';
    pw.autocomplete = 'off';
    card.append(pw);
  }

  const btn = el('button', '', full ? 'Full' : 'Join');
  btn.disabled = full;
  btn.addEventListener('click', () => joinRoom(r.id, pw?.value ?? ''));
  card.append(btn);
  return card;
}

function joinRoom(roomId, password) {
  setText('#lobby-error', '');
  socket.emit('room:join', { roomId, password }, (res) => {
    if (!res?.ok) return setText('#lobby-error', res?.error ?? 'Could not join that room.');
    enterRoom(res);
  });
}

async function loadLeaderboard() {
  try {
    const rows = await api('/api/leaderboard');
    const list = rows.length
      ? rows.map((r) => el('li', '', `${r.displayName} — ${r.totalKills} kills (${r.matches} matches)`))
      : [el('li', 'hint', 'No finished matches yet.')];
    $('#leaders').replaceChildren(...list);
  } catch {
    /* leaderboard is optional */
  }
}

// ---- Room -----------------------------------------------------------------

function enterRoom(res) {
  room = res.state;
  latestMap = res.map;
  renderRoom();
  syncView();
}

function onRoomState(st) {
  if (!room) return;
  const prevPhase = room.phase;
  room = st;
  if (st.phase === 'results' && prevPhase !== 'results') loadLeaderboard();
  renderRoom();
  syncView();
}

function leaveRoom() {
  // Deferred so the game scene can finish its update before it is torn down.
  setTimeout(() => {
    stopGame();
    socket?.emit('room:leave', {}, () => {});
    room = null;
    latestMap = null;
    syncView();
    loadLeaderboard();
  }, 0);
}

function statusText() {
  if (!room) return '';
  switch (room.phase) {
    case 'waiting':
      return 'Waiting for the host to start. Players can keep joining until the room is full.';
    case 'starting':
      return `Match starts in ${Math.ceil(room.left / 1000)}s.`;
    case 'playing':
      return 'Match in progress.';
    case 'results':
      return 'Match over. The host can start another round.';
    default:
      return '';
  }
}

function renderRoom() {
  if (!room || !me) return;
  const isHost = room.hostId === me.id;
  const host = room.humans.find((h) => h.id === room.hostId);

  setText('#room-title', room.name);
  setText(
    '#room-meta',
    `${room.visibility === 'private' ? 'Password-protected' : 'Public'} room · ${room.difficulty} CPUs · ${room.teams} teams`,
  );
  setText(
    '#slots',
    `${room.humans.length}/${room.humanSlots} human slots · ${room.cpuCount} CPU · ${room.totalSlots} total`,
  );

  $('#players').replaceChildren(
    ...room.humans.map((h) => {
      const li = el('li', '');
      const swatch = el('span', 'swatch');
      swatch.style.background = `#${PLAYER_COLORS[h.color].toString(16).padStart(6, '0')}`;
      li.append(swatch, h.name);
      if (h.id === room.hostId) li.append(' ', el('span', 'badge', 'HOST'));
      if (h.id === me.id) li.append(' ', el('span', 'badge', 'YOU'));
      if (h.inMatch) li.append(' ', el('span', 'badge', 'IN MATCH'));
      if (!h.connected) li.append(' ', el('span', 'badge off', 'OFFLINE'));
      return li;
    }),
  );

  setText(
    '#host-note',
    isHost ? 'You are the host.' : `Host: ${host?.name ?? 'unknown'}. Only the host can start or reload.`,
  );
  $('#btn-start').disabled = !isHost || room.phase !== 'waiting';
  $('#btn-reload').disabled = !isHost;
  $('#bar-reload').disabled = !isHost;
  setText('#room-status', statusText());

  show($('#results-card'), Boolean(room.result));
  if (room.result) $('#results').replaceChildren(resultsNode(room.result));
}

function resultsNode(r) {
  const wrap = el('div');
  const headline = r.winner < 0 ? 'Draw!' : `${r.teams.find((t) => t.team === r.winner)?.name ?? ''} win!`;
  wrap.append(el('p', 'headline', headline));
  wrap.append(el('p', 'meta', r.teams.map((t) => `${t.name} ${t.score}`).join(' · ')));

  const table = el('ol', 'board');
  for (const p of r.players) {
    table.append(el('li', '', `${p.name} — ${p.kills} kills, ${p.deaths} deaths${p.bot ? ' (CPU)' : ''}`));
  }
  wrap.append(table);
  return wrap;
}

function hostAction(evt, errorSel) {
  setText(errorSel, '');
  socket.emit(evt, {}, (res) => {
    if (!res?.ok) setText(errorSel, res?.error ?? 'Request failed.');
  });
}

$('#btn-start').addEventListener('click', () => hostAction('room:start', '#room-error'));
$('#btn-reload').addEventListener('click', () => hostAction('room:reload', '#room-error'));
$('#bar-reload').addEventListener('click', () => hostAction('room:reload', '#bar-error'));
$('#btn-leave').addEventListener('click', leaveRoom);
$('#bar-leave').addEventListener('click', leaveRoom);

// ---- Game -----------------------------------------------------------------

function startGame() {
  session.net = { socket, userId: me.id, onLeave: leaveRoom, initialMap: latestMap };
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

function stopGame() {
  session.detach?.();
  session.detach = null;
  game?.destroy(true);
  game = null;
}

boot();
