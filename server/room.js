import {
  TILE,
  TEAMS,
  MAX_HP,
  MOVE_SPEED,
  FIRE_COOLDOWN_MS,
  RAPID_COOLDOWN_MS,
  BULLET_SPEED,
  BULLET_RANGE_TILES,
  LONG_RANGE_TILES,
  LONG_RANGE_KILLS,
  BULLET_DAMAGE,
  CANDY_HEAL,
  CANDY_MAX,
  CANDY_SPAWN_MS,
  POWER_CHANCE,
  POWER_MS,
  MAX_DEATHS,
  RESPAWN_MS,
  INVULN_MS,
  MATCH_MS,
  SCORE_LIMIT,
  COUNTDOWN_MS,
  RESULTS_MS,
  HOST_GRACE_MS,
  PRESENCE_MS,
  TICK_HZ,
} from '../shared/config.js';
import {
  generateArena,
  moveBox,
  solidTile,
  randomFloorTile,
  clamp,
  SPAWN_CORNERS,
  FLOOR,
  CRATE,
} from './arena.js';
import { CpuBot } from './bot.js';
import { checkSecret } from './security.js';

const CPU_NAMES = ['CPU Gus', 'CPU Boo', 'CPU Crumb', 'CPU Skelly', 'CPU Pete', 'CPU Lantern', 'CPU Cobweb', 'CPU Moth'];
const PICKUP_RADIUS = 10;
const HIT_RADIUS = 8;
const FEED_MAX = 4;
const CRATE_CANDY_CHANCE = 0.35;
// QT_MATCH_MS shortens matches for testing; the default is the real length.
const MATCH_LENGTH_MS = Number(process.env.QT_MATCH_MS) || MATCH_MS;
// Offsets (in tiles, from a team's corner) for team members. Odd-odd and even-odd
// tiles are always floor, so these never land on a tombstone.
const SPAWN_STEPS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [2, 0],
  [0, 2],
  [2, 1],
  [1, 2],
  [3, 0],
];

let idSeq = 1;
const nextId = () => idSeq++;

const teamCountFor = (totalSlots) => clamp(totalSlots, 2, 4);

// Lowest colour index not already in use. Room sizes are capped at 8, so one is always free.
const freeColor = (taken) => {
  let c = 0;
  while (taken.has(c)) c++;
  return c;
};
const fail = (error) => ({ ok: false, error });

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Which pickup a spawn becomes. Rapid Fire and Two-Way are rare; the rest is candy.
export function rollPickupKind(r = Math.random()) {
  if (r < POWER_CHANCE) return 'rapid';
  if (r < POWER_CHANCE * 2) return 'double';
  return 'candy';
}

// Fire cooldown for an actor right now (Rapid Fire shortens it)
export function fireCooldownFor(a, now) {
  return a.rapidUntil > now ? RAPID_COOLDOWN_MS : FIRE_COOLDOWN_MS;
}

// Bullet range in pixels: players with more than LONG_RANGE_KILLS kills get the longer range
export function bulletRangeFor(a) {
  const tiles = a.kills > LONG_RANGE_KILLS ? LONG_RANGE_TILES : BULLET_RANGE_TILES;
  return tiles * TILE;
}

// Humans and CPUs share this shape. Humans keep their record while they stay in the room.
function makeActor(fields) {
  return {
    team: -1,
    color: 0,
    x: 0,
    y: 0,
    hp: MAX_HP,
    alive: false,
    kills: 0,
    deaths: 0,
    out: false, // true once deaths reaches MAX_DEATHS: no more respawns this match
    aim: { x: 1, y: 0 },
    dx: 0,
    dy: 0,
    fire: false,
    lastFire: 0,
    rapidUntil: 0,
    doubleUntil: 0,
    respawnAt: 0,
    invulnUntil: 0,
    ai: null,
    ...fields,
  };
}

// One room. Lifecycle: waiting -> starting (countdown) -> playing -> results -> waiting.
// Nothing auto-starts: the host decides when a match begins.
export class Room {
  constructor(io, cfg, hooks = {}) {
    this.io = io;
    this.id = cfg.id;
    this.name = cfg.name;
    this.visibility = cfg.visibility;
    this.passwordHash = cfg.passwordHash ?? null;
    this.totalSlots = cfg.totalSlots; // humans + CPUs
    this.humanSlots = cfg.humanSlots; // max humans; the rest of the total are CPUs
    this.difficulty = cfg.difficulty;
    this.seed = cfg.seed ?? Math.floor(Math.random() * 1e9);
    this.crateChance = cfg.crateChance ?? 0.25;
    this.hooks = hooks;
    this.clock = () => Date.now();
    this.channel = `room:${this.id}`;

    this.hostId = null;
    this.humans = new Map(); // user id -> human actor (lobby and in-match)
    this.actors = []; // humans + CPUs taking part in the current match
    this.bullets = [];
    this.pickups = [];
    this.feed = [];
    this.scores = [0, 0, 0, 0];
    this.teamCount = 2;
    this.map = null;
    this.matchNo = 0;
    this.cpuSeq = 0;
    this.phase = 'waiting';
    this.phaseEnd = 0;
    this.lastCandy = 0;
    this.result = null;
    this.lastTick = this.clock();
    this.lastPhase = 'waiting';

    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  destroy() {
    clearInterval(this.timer);
  }

  hostName() {
    return this.humans.get(this.hostId)?.name ?? null;
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      visibility: this.visibility,
      locked: this.visibility === 'private',
      phase: this.phase,
      humans: this.humans.size,
      humanSlots: this.humanSlots,
      totalSlots: this.totalSlots,
      difficulty: this.difficulty,
      host: this.hostName(),
    };
  }

  state(now = this.clock()) {
    const inMatch = new Set(this.actors.filter((a) => !a.bot).map((a) => a.id));
    const planning = this.phase === 'waiting' || this.phase === 'starting';
    return {
      id: this.id,
      name: this.name,
      visibility: this.visibility,
      phase: this.phase,
      left: Math.max(0, this.phaseEnd - now),
      hostId: this.hostId,
      totalSlots: this.totalSlots,
      humanSlots: this.humanSlots,
      difficulty: this.difficulty,
      teams: teamCountFor(this.totalSlots),
      cpuCount: planning ? Math.max(0, this.totalSlots - this.humans.size) : this.actors.filter((a) => a.bot).length,
      humans: [...this.humans.values()].map((h) => ({
        id: h.id,
        name: h.name,
        color: h.color,
        connected: h.connected,
        inMatch: inMatch.has(h.id),
      })),
      result: this.result,
    };
  }

  emitState() {
    this.io.to(this.channel).emit('room:state', this.state());
  }

  // Joins a user. The first user to join becomes host. `owner` skips the password check (room creator).
  join(user, password = '', { owner = false } = {}) {
    if (this.humans.has(user.id)) {
      this.reattach(user.id, user.socket);
      return this.joinResult();
    }
    if (!owner && this.passwordHash && !checkSecret(String(password), this.passwordHash)) {
      return fail('Wrong room password.');
    }
    if (this.humans.size >= this.humanSlots) return fail('That room is full.');

    const color = freeColor(new Set([...this.humans.values()].map((h) => h.color)));
    this.humans.set(
      user.id,
      makeActor({
        id: user.id,
        name: user.name,
        bot: false,
        socket: user.socket,
        connected: true,
        disconnectedAt: 0,
        color,
      }),
    );
    this.hostId ??= user.id;
    user.socket.join(this.channel);
    this.emitState();
    return this.joinResult();
  }

  joinResult() {
    return {
      ok: true,
      roomId: this.id,
      roomName: this.name,
      phase: this.phase,
      map: this.map ? this.mapPayload() : null,
      state: this.state(),
    };
  }

  // Reconnect within the grace window: same player, new socket.
  reattach(userId, socket) {
    const h = this.humans.get(userId);
    if (!h) return false;
    h.socket = socket;
    h.connected = true;
    h.disconnectedAt = 0;
    socket.join(this.channel);
    this.emitState();
    return true;
  }

  // Socket dropped. The player keeps their place until PRESENCE_MS passes.
  disconnect(userId, socket) {
    const h = this.humans.get(userId);
    if (!h || h.socket !== socket) return; // already reconnected on another socket
    h.connected = false;
    h.socket = null;
    h.disconnectedAt = this.clock();
    h.dx = 0;
    h.dy = 0;
    h.fire = false;
    this.emitState();
  }

  // Explicit leave: removed immediately.
  leave(userId) {
    const h = this.humans.get(userId);
    if (!h) return false;
    this.humans.delete(userId);
    this.actors = this.actors.filter((a) => a !== h);
    if (this.hostId === userId) this.transferHost();
    this.emitState();
    return true;
  }

  // Host passes to the earliest-joined connected player.
  transferHost() {
    const next = [...this.humans.values()].find((h) => h.id !== this.hostId && h.connected);
    if (!next) return false;
    this.hostId = next.id;
    this.emitState();
    return true;
  }

  setInput(userId, { dx = 0, dy = 0, fire = false } = {}) {
    const human = this.humans.get(userId);
    if (!human) return;
    human.dx = clamp(Number(dx) || 0, -1, 1);
    human.dy = clamp(Number(dy) || 0, -1, 1);
    human.fire = Boolean(fire);
  }

  start(userId) {
    if (userId !== this.hostId) return fail('Only the host can start the match.');
    if (this.phase !== 'waiting') return fail('A match is already running. Use Reload to restart it.');
    this.phase = 'starting';
    this.phaseEnd = this.clock() + COUNTDOWN_MS;
    this.emitState();
    return { ok: true };
  }

  // Restarts the round with a new map and zeroed scores. Reloads are not recorded.
  reload(userId) {
    if (userId !== this.hostId) return fail('Only the host can reload the match.');
    this.closeRound();
    this.result = null;
    this.phase = 'starting';
    this.phaseEnd = this.clock() + COUNTDOWN_MS;
    this.emitState();
    return { ok: true };
  }

  closeRound() {
    this.actors = [];
    this.bullets = [];
    this.pickups = [];
    this.feed = [];
    this.scores = [0, 0, 0, 0];
    for (const h of this.humans.values()) {
      h.alive = false;
      h.team = -1;
    }
  }

  tick() {
    const now = this.clock();
    const dtMs = Math.min(100, now - this.lastTick);
    this.lastTick = now;

    this.checkPresence(now);

    switch (this.phase) {
      case 'starting':
        if (now >= this.phaseEnd) this.startMatch(now);
        break;
      case 'playing': {
        this.step(now, dtMs);
        // Over when time runs out, a team hits the score limit, or no human can still act.
        const humanCanAct = this.actors.some((a) => !a.bot && (a.alive || !a.out));
        if (!humanCanAct || now >= this.phaseEnd || Math.max(...this.scores) >= SCORE_LIMIT) {
          this.endMatch(now);
        }
        break;
      }
      case 'results':
        if (now >= this.phaseEnd) {
          this.closeRound();
          this.phase = 'waiting';
        }
        break;
      default:
        break;
    }

    if (this.phase !== this.lastPhase) {
      this.lastPhase = this.phase;
      this.emitState();
    }
    if (this.humans.size) this.broadcast(now);
  }

  checkPresence(now) {
    const host = this.humans.get(this.hostId);
    if (host && !host.connected && now - host.disconnectedAt >= HOST_GRACE_MS) this.transferHost();
    for (const h of [...this.humans.values()]) {
      if (!h.connected && now - h.disconnectedAt >= PRESENCE_MS) this.leave(h.id);
    }
  }

  startMatch(now) {
    const humans = shuffle([...this.humans.values()]);
    const cpuCount = Math.max(0, this.totalSlots - humans.length);
    this.teamCount = teamCountFor(this.totalSlots);

    this.map = generateArena(this.seed + this.matchNo * 7919, this.crateChance);
    this.matchNo += 1;
    this.bullets = [];
    this.pickups = [];
    this.feed = [];
    this.result = null;
    this.scores = [0, 0, 0, 0];
    this.lastCandy = now;

    const cpus = Array.from({ length: cpuCount }, () => this.spawnCpu());
    // Humans keep their colour; CPUs take the colours left over.
    const taken = new Set(humans.map((h) => h.color));
    for (const cpu of cpus) {
      cpu.color = freeColor(taken);
      taken.add(cpu.color);
    }
    this.actors = [...humans, ...cpus];
    // Round-robin over everyone keeps team sizes within one of each other.
    const perTeam = Array(this.teamCount).fill(0);
    this.actors.forEach((a, i) => {
      a.team = i % this.teamCount;
      a.slot = perTeam[a.team]++;
      a.kills = 0;
      a.deaths = 0;
      a.out = false;
      this.place(a, now);
    });

    this.phase = 'playing';
    this.phaseEnd = now + MATCH_LENGTH_MS;
    this.io.to(this.channel).emit('map', this.mapPayload());
    this.io.to(this.channel).emit('fx', { type: 'start' });
    this.emitState();
  }

  spawnCpu() {
    this.cpuSeq += 1;
    const name = CPU_NAMES[(this.cpuSeq - 1) % CPU_NAMES.length];
    return makeActor({ id: `cpu-${this.cpuSeq}`, name, bot: true, ai: new CpuBot(this.difficulty) });
  }

  // Spawn or respawn. Power-ups are lost on death.
  // Team members share a corner, so each gets a nearby free tile (slot 0 is the corner itself).
  spawnTile(team, slot) {
    const c = SPAWN_CORNERS[team];
    const sx = c.tx === 1 ? 1 : -1;
    const sy = c.ty === 1 ? 1 : -1;
    const [i, j] = SPAWN_STEPS[slot] ?? [0, 0];
    const tx = c.tx + sx * i;
    const ty = c.ty + sy * j;
    return solidTile(this.map, tx, ty) ? c : { tx, ty };
  }

  place(a, now) {
    const spawn = this.spawnTile(a.team, a.slot ?? 0);
    a.x = (spawn.tx + 0.5) * TILE;
    a.y = (spawn.ty + 0.5) * TILE;
    a.hp = MAX_HP;
    a.alive = true;
    a.dx = 0;
    a.dy = 0;
    a.fire = false;
    a.aim = { x: 1, y: 0 };
    a.rapidUntil = 0;
    a.doubleUntil = 0;
    a.invulnUntil = now + INVULN_MS;
    if (a.ai) a.ai.reset();
  }

  step(now, dtMs) {
    const dt = dtMs / 1000;
    const ctx = { map: this.map, actors: this.actors, pickups: this.pickups, now };

    for (const a of this.actors) if (a.bot && a.alive) a.ai.think(ctx, a, dtMs);

    for (const a of this.actors) {
      if (!a.alive) {
        if (!a.out && now >= a.respawnAt) this.place(a, now);
        continue;
      }

      const len = Math.hypot(a.dx, a.dy);
      if (len > 0) {
        const k = (MOVE_SPEED * dt) / len;
        moveBox(this.map, a, a.dx * k, a.dy * k);
        if (!a.bot) a.aim = { x: a.dx / len, y: a.dy / len };
      }

      if (a.fire && now - a.lastFire >= fireCooldownFor(a, now)) this.shoot(a, now);
      this.collectPickups(a, now);
    }

    if (now - this.lastCandy >= CANDY_SPAWN_MS && this.pickups.length < CANDY_MAX) {
      this.lastCandy = now;
      this.spawnPickup(randomFloorTile(this.map));
    }

    for (const b of this.bullets) this.moveBullet(b, dtMs, now);
    this.bullets = this.bullets.filter((b) => !b.dead);
  }

  // Two-Way power-up fires both forward and backward.
  shoot(a, now) {
    a.lastFire = now;
    const { x: ax, y: ay } = a.aim;
    const dirs = a.doubleUntil > now ? [1, -1] : [1];
    const range = bulletRangeFor(a);
    for (const s of dirs) {
      this.bullets.push({
        id: nextId(),
        color: a.color,
        x: a.x + ax * s * 10,
        y: a.y + ay * s * 10,
        vx: ax * s * BULLET_SPEED,
        vy: ay * s * BULLET_SPEED,
        travelled: 0,
        range,
        team: a.team,
        owner: a,
        dead: false,
      });
    }
  }

  moveBullet(b, dtMs, now) {
    const dt = dtMs / 1000;
    const step = Math.hypot(b.vx, b.vy) * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.travelled += step;
    if (b.travelled >= b.range) {
      b.dead = true;
      return;
    }

    const tx = Math.floor(b.x / TILE);
    const ty = Math.floor(b.y / TILE);
    if (solidTile(this.map, tx, ty)) {
      const idx = ty * this.map.cols + tx;
      if (this.map.tiles[idx] === CRATE) {
        this.map.tiles[idx] = FLOOR;
        if (Math.random() < CRATE_CANDY_CHANCE) this.spawnPickup({ tx, ty });
      }
      b.dead = true;
      return;
    }

    for (const a of this.actors) {
      if (!a.alive || a.team === b.team || a.invulnUntil > now) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) < HIT_RADIUS) {
        b.dead = true;
        this.damage(a, b.owner, now);
        return;
      }
    }
  }

  spawnPickup(tile) {
    if (this.pickups.length >= CANDY_MAX + 2) return;
    this.pickups.push({
      id: nextId(),
      kind: rollPickupKind(),
      x: (tile.tx + 0.5) * TILE,
      y: (tile.ty + 0.5) * TILE,
    });
  }

  collectPickups(a, now) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (Math.hypot(a.x - p.x, a.y - p.y) >= PICKUP_RADIUS) continue;
      if (p.kind === 'rapid') a.rapidUntil = now + POWER_MS;
      else if (p.kind === 'double') a.doubleUntil = now + POWER_MS;
      else a.hp = Math.min(MAX_HP, a.hp + CANDY_HEAL);
      this.pickups.splice(i, 1);
      this.io.to(this.channel).emit('fx', { type: 'pickup', kind: p.kind });
    }
  }

  damage(victim, attacker, now) {
    victim.hp -= BULLET_DAMAGE;
    this.io.to(this.channel).emit('fx', { type: 'hit' });
    if (victim.hp <= 0) this.kill(victim, attacker, now);
  }

  kill(victim, killer, now) {
    victim.hp = 0;
    victim.alive = false;
    victim.deaths += 1;
    victim.out = victim.deaths >= MAX_DEATHS;
    victim.respawnAt = now + RESPAWN_MS;
    if (killer && killer !== victim) {
      killer.kills += 1;
      this.scores[killer.team] += 1;
    }
    this.feed.push(`${killer ? killer.name : 'Ghost'} > ${victim.name}`);
    if (victim.out) this.feed.push(`${victim.name} is OUT of lives`);
    while (this.feed.length > FEED_MAX) this.feed.shift();
    this.io.to(this.channel).emit('fx', { type: 'kill' });
  }

  endMatch(now) {
    this.phase = 'results';
    this.phaseEnd = now + RESULTS_MS;
    this.bullets = [];

    const teams = Array.from({ length: this.teamCount }, (_, t) => ({
      team: t,
      name: TEAMS[t].name,
      score: this.scores[t],
    })).sort((a, b) => b.score - a.score);
    const best = teams[0].score;
    const leaders = teams.filter((t) => t.score === best);

    this.result = {
      winner: leaders.length === 1 ? leaders[0].team : -1,
      teams,
      players: this.actors
        .map((a) => ({ name: a.name, team: a.team, kills: a.kills, deaths: a.deaths, bot: a.bot }))
        .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths),
    };
    this.hooks.onMatchEnd?.(this.actors.filter((a) => !a.bot), this.result);
    this.io.to(this.channel).emit('match:end', this.result);
  }

  mapPayload() {
    return {
      matchNo: this.matchNo,
      cols: this.map.cols,
      rows: this.map.rows,
      tiles: Array.from(this.map.tiles),
      teams: TEAMS.slice(0, this.teamCount),
    };
  }

  crateIndices() {
    if (!this.map) return [];
    const out = [];
    this.map.tiles.forEach((t, i) => {
      if (t === CRATE) out.push(i);
    });
    return out;
  }

  broadcast(now) {
    const r2 = (v) => Math.round(v * 100) / 100;
    this.io.to(this.channel).emit('snapshot', {
      phase: this.phase,
      left: Math.max(0, this.phaseEnd - now),
      matchNo: this.matchNo,
      actors: this.actors.map((a) => ({
        id: a.id,
        name: a.name,
        team: a.team,
        color: a.color,
        bot: a.bot,
        x: Math.round(a.x),
        y: Math.round(a.y),
        hp: a.hp,
        alive: a.alive,
        ax: r2(a.aim.x),
        ay: r2(a.aim.y),
        kills: a.kills,
        deaths: a.deaths,
        lives: Math.max(0, MAX_DEATHS - a.deaths),
        out: a.out,
        longRange: a.kills > LONG_RANGE_KILLS,
        rapid: a.rapidUntil > now,
        double: a.doubleUntil > now,
        inv: a.invulnUntil > now,
      })),
      bullets: this.bullets.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), team: b.team, color: b.color })),
      pickups: this.pickups.map((p) => ({ id: p.id, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y) })),
      crates: this.crateIndices(),
      scores: this.scores.slice(0, this.teamCount),
      feed: this.feed,
    });
  }
}
