// Unit checks for room and match rules, run without a server:
// host control, host transfer, slots and balancing, CPU difficulty, death limit,
// power-up rarity, Two-Way shots, Rapid Fire cooldown and bullet range.
import assert from 'node:assert/strict';
import { Room, rollPickupKind, fireCooldownFor } from '../server/room.js';
import { PROFILES } from '../server/bot.js';
import { generateArena } from '../server/arena.js';
import {
  MAX_DEATHS,
  FIRE_COOLDOWN_MS,
  RAPID_COOLDOWN_MS,
  RESPAWN_MS,
  HOST_GRACE_MS,
  PRESENCE_MS,
} from '../shared/config.js';

const io = { to: () => ({ emit() {} }) };
const fakeSocket = () => ({ join() {}, leave() {}, emit() {} });
const user = (id) => ({ id, name: id.toUpperCase(), socket: fakeSocket() });

function newRoom(extra = {}) {
  const room = new Room(io, {
    id: 9,
    name: 'Test',
    visibility: 'public',
    totalSlots: 2,
    humanSlots: 8,
    difficulty: 'medium',
    seed: 42,
    ...extra,
  });
  room.destroy();
  return room;
}

// 1. Host controls: only the host can start or reload
{
  const room = newRoom();
  room.join(user('a'), '', { owner: true });
  room.join(user('b'), '');
  assert.equal(room.hostId, 'a', 'creator is host');

  assert.equal(room.start('b').ok, false, 'non-host cannot start');
  assert.equal(room.reload('b').ok, false, 'non-host cannot reload');
  assert.equal(room.phase, 'waiting', 'nothing started by a non-host');

  assert.equal(room.start('a').ok, true, 'host can start');
  assert.equal(room.phase, 'starting');
  assert.equal(room.start('a').ok, false, 'cannot start twice');

  assert.equal(room.reload('a').ok, true, 'host can reload');
  assert.equal(room.phase, 'starting');
}

// 2. Host passes after 5 seconds offline, but not before
{
  const room = newRoom();
  let t = 1_000_000;
  room.clock = () => t;
  const a = user('a');
  room.join(a, '', { owner: true });
  room.join(user('b'), '');

  room.disconnect('a', a.socket);
  t += HOST_GRACE_MS - 1_000;
  room.tick();
  assert.equal(room.hostId, 'a', 'host kept during the grace period');

  t += 2_000;
  room.tick();
  assert.equal(room.hostId, 'b', 'host passes to b after 5 seconds');
}

// 3. Host reconnecting inside the grace period keeps the title
{
  const room = newRoom();
  let t = 1_000_000;
  room.clock = () => t;
  const a = user('a');
  room.join(a, '', { owner: true });
  room.join(user('b'), '');

  room.disconnect('a', a.socket);
  t += 2_000;
  assert.equal(room.reattach('a', fakeSocket()), true, 'reattach succeeds');
  t += 10_000;
  room.tick();
  assert.equal(room.hostId, 'a', 'host kept after a quick reconnect');
}

// 4. Players offline for too long are removed
{
  const room = newRoom();
  let t = 1_000_000;
  room.clock = () => t;
  room.join(user('a'), '', { owner: true });
  const b = user('b');
  room.join(b, '');
  room.disconnect('b', b.socket);
  t += PRESENCE_MS + 1;
  room.tick();
  assert.equal(room.humans.has('b'), false, 'long-offline player removed');
}

// 5. Password: wrong password is refused, correct one joins
{
  const room = newRoom({ visibility: 'private', passwordHash: null });
  // Use the real hash helper for a stored password
  const { hashSecret } = await import('../server/security.js');
  room.passwordHash = hashSecret('secret-pass');
  room.join(user('a'), '', { owner: true });
  assert.equal(room.join(user('b'), 'nope').ok, false, 'wrong password refused');
  assert.equal(room.join(user('b'), 'secret-pass').ok, true, 'correct password joins');
}

// 6. Human slots cap joins
{
  const room = newRoom({ totalSlots: 4, humanSlots: 2 });
  room.join(user('a'), '', { owner: true });
  room.join(user('b'), '');
  assert.equal(room.join(user('c'), '').ok, false, 'third human refused when only 2 human slots');
}

// 7. CPUs fill the rest of the total; teams stay balanced
{
  const room = newRoom({ totalSlots: 6, humanSlots: 6 });
  room.join(user('a'), '', { owner: true });
  room.join(user('b'), '');
  room.startMatch(0);
  assert.equal(room.actors.length, 6, 'total players is the slot count');
  assert.equal(room.actors.filter((a) => a.bot).length, 4, 'four CPUs for two humans');
  const sizes = [0, 1, 2, 3].map((t) => room.actors.filter((a) => a.team === t).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `teams balanced, got ${sizes}`);
}

// 8. CPU difficulty is applied to every CPU
{
  const room = newRoom({ totalSlots: 3, difficulty: 'hard' });
  room.join(user('a'), '', { owner: true });
  room.startMatch(0);
  for (const cpu of room.actors.filter((a) => a.bot)) {
    assert.equal(cpu.ai.p, PROFILES.hard, 'CPU uses the room difficulty');
  }
  assert.ok(PROFILES.hard.accuracy[0] > PROFILES.easy.accuracy[1], 'hard is more accurate than easy');
  assert.ok(PROFILES.hard.reaction[1] < PROFILES.easy.reaction[0], 'hard reacts faster than easy');
}

// Helper: a room with one human in a match, plus the bot
function matchRoom(extra = {}) {
  const room = newRoom(extra);
  room.join(user('a'), '', { owner: true });
  room.startMatch(0);
  return room;
}

// 9. Death limit: respawns until the fifth death, then never again
{
  const room = matchRoom();
  const a = room.actors.find((x) => !x.bot);
  const bot = room.actors.find((x) => x.bot);

  let now = 1_000_000;
  for (let death = 1; death <= MAX_DEATHS; death++) {
    room.kill(a, bot, now);
    assert.equal(a.deaths, death);
    assert.equal(a.out, death >= MAX_DEATHS, `out flag after death ${death}`);
    now += RESPAWN_MS + 1;
    room.step(now, 33);
    assert.equal(a.alive, death < MAX_DEATHS, `alive after death ${death}`);
  }
  room.step(now + 60_000, 33);
  assert.equal(a.alive, false, 'out player never respawns');
}

// 10. Power-ups are rare: each kind near 6%, candy the rest
{
  const N = 200_000;
  const counts = { rapid: 0, double: 0, candy: 0 };
  for (let i = 0; i < N; i++) counts[rollPickupKind(i / N)] += 1;
  assert.ok(counts.rapid / N > 0.05 && counts.rapid / N < 0.07, 'rapid rate');
  assert.ok(counts.double / N > 0.05 && counts.double / N < 0.07, 'double rate');
  assert.ok(counts.candy / N > 0.85, 'candy is the common pickup');
}

// 11. Two-Way fires forward and backward
{
  const room = matchRoom();
  const a = room.actors.find((x) => !x.bot);
  a.aim = { x: 0, y: 1 };
  const now = 5_000;

  a.doubleUntil = 0;
  room.bullets = [];
  room.shoot(a, now);
  assert.equal(room.bullets.length, 1, 'normal shot is one bullet');

  room.bullets = [];
  a.doubleUntil = now + 8_000;
  room.shoot(a, now);
  assert.equal(room.bullets.length, 2, 'two-way shot is two bullets');
  const [fwd, back] = room.bullets;
  assert.ok(fwd.vy > 0 && back.vy < 0, 'one bullet forward, one backward');
}

// 12. Bullet range: 4 tiles, or 5 tiles with more than 5 kills
{
  const room = matchRoom();
  const a = room.actors.find((x) => !x.bot);
  a.aim = { x: 1, y: 0 };

  a.kills = 0;
  room.bullets = [];
  room.shoot(a, 1);
  assert.equal(room.bullets[0].range, 4 * 16, 'default range is 4 tiles');

  a.kills = 5;
  room.bullets = [];
  room.shoot(a, 1);
  assert.equal(room.bullets[0].range, 4 * 16, 'exactly 5 kills is not enough');

  a.kills = 6;
  room.bullets = [];
  room.shoot(a, 1);
  assert.equal(room.bullets[0].range, 5 * 16, 'more than 5 kills gives 5 tiles');

  // A bullet stops once it has travelled its range, on an open row of a crate-free arena
  room.map = generateArena(1, 0);
  room.actors = [];
  const b = { x: 24, y: 24, vx: 180, vy: 0, travelled: 0, range: 64, team: 0, dead: false };
  room.bullets = [b];
  let ticks = 0;
  while (!b.dead && ticks < 1000) {
    room.moveBullet(b, 33, 0);
    ticks++;
  }
  assert.ok(b.dead, 'bullet is removed');
  assert.ok(Math.abs(b.travelled - 64) < 6, `bullet travelled about 64px, got ${b.travelled}`);
}

// 13. Rapid Fire shortens the cooldown only while active
{
  const a = { rapidUntil: 10_000 };
  assert.equal(fireCooldownFor(a, 5_000), RAPID_COOLDOWN_MS);
  assert.equal(fireCooldownFor(a, 10_001), FIRE_COOLDOWN_MS);
  assert.ok(RAPID_COOLDOWN_MS < FIRE_COOLDOWN_MS);
}

// 14. Respawns avoid camping: the corner farthest from living enemies is chosen
{
  const room = matchRoom();
  const a = room.actors.find((x) => !x.bot); // team 0, spawns at (1,1)
  const bot = room.actors.find((x) => x.bot); // team 1, spawns at the far corner
  bot.x = (1 + 0.5) * 16; // enemy now sits on a's corner
  bot.y = (1 + 0.5) * 16;
  const spot = room.safestCorner(a);
  assert.deepEqual(spot, { tx: 18, ty: 11 }, 'respawn moves away from the enemy');

  bot.x = (18 + 0.5) * 16; // enemy back at the far corner: keep the own corner
  bot.y = (11 + 0.5) * 16;
  assert.deepEqual(room.safestCorner(a), { tx: 1, ty: 1 }, 'own corner kept when it is already safest');

  bot.alive = false;
  assert.deepEqual(room.safestCorner(a), { tx: 1, ty: 1 }, 'no living enemies: own corner');
}

// 15. CPUs detour for a nearby pickup while patrolling
{
  const room = matchRoom();
  room.map = generateArena(1, 0);
  const bot = room.actors.find((x) => x.bot);
  bot.team = 0;
  bot.x = 3 * 16 + 8;
  bot.y = 3 * 16 + 8;
  room.actors = [bot];
  room.pickups = [{ id: 1, kind: 'rapid', x: 5 * 16 + 8, y: 3 * 16 + 8 }];
  bot.ai.reset();
  bot.ai.think({ map: room.map, actors: room.actors, pickups: room.pickups, now: 0 }, bot, 33);
  assert.equal(bot.ai.state, 'patrol', 'still patrolling');
  assert.ok(bot.dx > 0.9 && Math.abs(bot.dy) < 0.1, `heads for the pickup, got dx=${bot.dx} dy=${bot.dy}`);
}

console.log('room rules tests passed');
