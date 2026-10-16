// Unit checks for match rules that do not need a running server:
// the five-death limit, power-up rarity, Two-Way shots, and Rapid Fire cooldown.
import assert from 'node:assert/strict';
import { Room, rollPickupKind, fireCooldownFor } from '../server/room.js';
import { MAX_DEATHS, FIRE_COOLDOWN_MS, RAPID_COOLDOWN_MS, RESPAWN_MS } from '../shared/config.js';
import { generateArena } from '../server/arena.js';

const io = { to: () => ({ emit() {} }) };
const fakeSocket = (id) => ({ id, join() {}, leave() {}, emit() {} });

function newRoom() {
  const room = new Room(io, { id: 9, name: 'Test', theme: 't', seed: 42, crateChance: 0.25 });
  clearInterval(room.timer);
  return room;
}

// 1. Death limit: respawns until the fifth death, then never again
{
  const room = newRoom();
  room.join(fakeSocket('a'), 'A');
  room.startMatch(0);
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
  // Even long after the timer, an out player stays out
  room.step(now + 60_000, 33);
  assert.equal(a.alive, false, 'out player never respawns');
}

// 2. Power-ups are rare: each kind near 6%, candy the rest
{
  const N = 200_000;
  const counts = { rapid: 0, double: 0, candy: 0 };
  for (let i = 0; i < N; i++) counts[rollPickupKind(i / N)] += 1;
  const rapid = counts.rapid / N;
  const double = counts.double / N;
  assert.ok(rapid > 0.05 && rapid < 0.07, `rapid rate ${rapid}`);
  assert.ok(double > 0.05 && double < 0.07, `double rate ${double}`);
  assert.ok(counts.candy / N > 0.85, 'candy is the common pickup');
}

// 3. Two-Way fires forward and backward
{
  const room = newRoom();
  room.join(fakeSocket('b'), 'B');
  room.startMatch(0);
  const a = room.actors.find((x) => !x.bot);
  a.aim = { x: 0, y: 1 };
  const now = 5_000;

  a.doubleUntil = 0;
  room.shoot(a, now);
  assert.equal(room.bullets.length, 1, 'normal shot is one bullet');
  room.bullets = [];

  a.doubleUntil = now + 8_000;
  room.shoot(a, now);
  assert.equal(room.bullets.length, 2, 'two-way shot is two bullets');
  const [fwd, back] = room.bullets;
  assert.ok(fwd.vy > 0 && back.vy < 0, 'one bullet forward, one backward');
}

// 3b. Bullets stop at 4 tiles; players with more than 5 kills get 5 tiles
{
  const room = newRoom();
  room.join(fakeSocket('c'), 'C');
  room.startMatch(0);
  const a = room.actors.find((x) => !x.bot);
  a.aim = { x: 1, y: 0 };

  // The range each bullet is given depends on the shooter's kills
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

  // A bullet is removed once it has travelled its range
  // Open row 1 of a crate-free arena, so only the range can stop the bullet
  room.map = generateArena(1, 0);
  const b = { x: 24, y: 24, vx: 180, vy: 0, travelled: 0, range: 64, team: 0, dead: false };
  room.bullets = [b];
  room.actors = [];
  let ticks = 0;
  while (!b.dead && ticks < 1000) {
    room.moveBullet(b, 33, 0);
    ticks++;
  }
  assert.ok(b.dead, 'bullet is removed');
  assert.ok(Math.abs(b.travelled - 64) < 6, `bullet travelled about 64px, got ${b.travelled}`);
}

// 4. Rapid Fire shortens the cooldown only while active
{
  const a = { rapidUntil: 10_000 };
  assert.equal(fireCooldownFor(a, 5_000), RAPID_COOLDOWN_MS);
  assert.equal(fireCooldownFor(a, 10_001), FIRE_COOLDOWN_MS);
  assert.ok(RAPID_COOLDOWN_MS < FIRE_COOLDOWN_MS);
}

console.log('rules tests passed');
