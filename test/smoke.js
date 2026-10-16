// End-to-end smoke test: boots the server, joins one player, and checks that
// the match starts, a bot backfills the empty team, the player moves, and
// shots fly. Run with: npm test
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4123;
const URL = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (buf) => buf.toString().includes('running') && resolve());
  server.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
});

try {
  const socket = io(URL, { transports: ['websocket'] });
  await once(socket, 'connect');

  const snaps = [];
  let mapPayload = null;
  socket.on('map', (m) => {
    mapPayload = m;
  });
  socket.on('snapshot', (s) => snaps.push(s));

  const joined = await new Promise((resolve) => socket.emit('join', { name: 'Tester', roomId: 0 }, resolve));
  assert.equal(joined.ok, true, 'join should succeed');

  // Countdown is 8s; allow some slack
  const deadline = Date.now() + 15_000;
  while (!mapPayload && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(mapPayload, 'match started within 15s');

  assert.equal(mapPayload.cols, 20);
  assert.equal(mapPayload.rows, 13);
  assert.equal(mapPayload.tiles.length, mapPayload.cols * mapPayload.rows, 'tile count matches dimensions');
  assert.equal(mapPayload.teams.length, 2, 'one human means two teams');

  // Wait for the first playing snapshot to take the starting position
  while (!snaps.some((s) => s.phase === 'playing') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const firstPlaying = snaps.find((s) => s.phase === 'playing');
  const startX = firstPlaying.actors.find((a) => a.id === socket.id).x;

  // Walk right and hold fire for 4 seconds
  const inputTimer = setInterval(() => socket.emit('input', { dx: 1, dy: 0, fire: true }), 33);
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(inputTimer);
  socket.emit('input', { dx: 0, dy: 0, fire: false });

  const playing = snaps.filter((s) => s.phase === 'playing');
  assert.ok(playing.length > 20, 'received live snapshots during play');

  const last = playing.at(-1);
  const me = last.actors.find((a) => a.id === socket.id);
  assert.ok(me, 'human is in the match');
  assert.notEqual(me.x, startX, 'human moved when input was sent');

  const bots = last.actors.filter((a) => a.bot);
  assert.equal(bots.length, 1, 'one bot backfilled the second team');
  assert.equal(bots[0].team, 1, 'bot is on team 1');

  assert.ok(
    playing.some((s) => s.bullets.length > 0),
    'bullets were fired',
  );
  assert.ok(last.crates.length > 0, 'arena has destructible crates');

  console.log('smoke test passed:', {
    startX,
    endX: me.x,
    bots: bots.map((b) => b.name),
    bulletsSeen: playing.reduce((n, s) => n + s.bullets.length, 0),
    crates: last.crates.length,
  });

  socket.disconnect();
} finally {
  server.kill();
}
