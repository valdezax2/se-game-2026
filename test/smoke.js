// End-to-end smoke test: boots the server with a temporary data folder, signs up an
// account, creates a room, starts it as host, and checks that the match plays out.
// Run with: npm test
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4123;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-smoke-'));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  // Tests must never post fake accounts to the real webhook, so point it at a dead address.
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ACCOUNT_WEBHOOK_URL: 'http://localhost:1/disabled' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (buf) => buf.toString().includes('running') && resolve());
  server.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
});

const post = (p, body, token) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

try {
  // Sign up
  const reg = await post('/api/register', {
    firstName: 'Test',
    lastName: 'Player',
    phone: '555-123-4567',
    email: `tester+${Date.now()}@example.com`,
    zip: '11367',
    dob: '1990-05-17',
    password: 'correct-horse',
  });
  assert.equal(reg.status, 200, 'registration succeeds');
  const { token, user } = await reg.json();
  assert.equal(user.displayName, 'Test P.');

  // Socket connects only with a valid token
  const bad = io(BASE, { transports: ['websocket'], auth: { token: 'nope' } });
  const [badErr] = await once(bad, 'connect_error');
  assert.equal(badErr.message, 'unauthorized', 'bad token refused');
  bad.close();

  const socket = io(BASE, { transports: ['websocket'], auth: { token } });
  await once(socket, 'connect');

  const call = (evt, data = {}) => new Promise((resolve) => socket.emit(evt, data, resolve));

  // Room: 2 total players, 1 human slot, so one CPU
  const created = await call('room:create', {
    name: 'Smoke Room',
    totalSlots: 2,
    humanSlots: 1,
    difficulty: 'medium',
    visibility: 'public',
  });
  assert.equal(created.ok, true, 'room created');
  assert.equal(created.state.hostId, user.id, 'creator is host');

  // Start as host; the match should begin after the countdown
  const started = await call('room:start');
  assert.equal(started.ok, true, 'host can start');

  const snaps = [];
  socket.on('snapshot', (s) => snaps.push(s));

  const deadline = Date.now() + 20_000;
  while (!snaps.some((s) => s.phase === 'playing') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const firstPlaying = snaps.find((s) => s.phase === 'playing');
  assert.ok(firstPlaying, 'match reached playing');
  const startX = firstPlaying.actors.find((a) => a.id === user.id).x;

  // Walk right and hold fire for 4 seconds
  const inputTimer = setInterval(() => socket.emit('input', { dx: 1, dy: 0, fire: true }), 33);
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(inputTimer);
  socket.emit('input', { dx: 0, dy: 0, fire: false });

  const playing = snaps.filter((s) => s.phase === 'playing');
  assert.ok(playing.length > 20, 'received live snapshots during play');

  const last = playing.at(-1);
  const me = last.actors.find((a) => a.id === user.id);
  assert.ok(me, 'host is in the match under their account id');
  assert.notEqual(me.x, startX, 'player moved when input was sent');

  const cpus = last.actors.filter((a) => a.bot);
  assert.equal(cpus.length, 1, 'one CPU fills the second slot');
  assert.equal(cpus[0].team, 1, 'CPU is on team 1');

  assert.ok(
    playing.some((s) => s.bullets.length > 0),
    'bullets were fired',
  );
  assert.ok(last.crates.length > 0, 'arena has destructible crates');

  // Leaderboard endpoint is public
  const board = await fetch(`${BASE}/api/leaderboard`).then((r) => r.json());
  assert.ok(Array.isArray(board), 'leaderboard responds');

  console.log('smoke test passed:', {
    startX,
    endX: me.x,
    cpus: cpus.map((b) => b.name),
    bulletsSeen: playing.reduce((n, s) => n + s.bullets.length, 0),
    crates: last.crates.length,
  });

  socket.close();
} finally {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}
