import {
  TILE,
  TEAMS,
  MAX_HP,
  MOVE_SPEED,
  FIRE_COOLDOWN_MS,
  RAPID_COOLDOWN_MS,
  BULLET_SPEED,
  BULLET_LIFE_MS,
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
  MAX_HUMANS_PER_ROOM,
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
import { MediumBot } from './bot.js';

const BOT_NAMES = ['CPU Gus', 'CPU Boo', 'CPU Crumb', 'CPU Skelly', 'CPU Pete', 'CPU Lantern', 'CPU Cobweb', 'CPU Moth'];
const PICKUP_RADIUS = 10;
const HIT_RADIUS = 8;
const FEED_MAX = 4;
const CRATE_CANDY_CHANCE = 0.35;

let idSeq = 1;
const nextId = () => idSeq++;

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

// Humans and bots share this shape; humans keep their record across matches.
function makeActor(fields) {
  return {
    team: -1,
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

// One authoritative match room. Lifecycle:
//   waiting -> starting (countdown) -> playing -> results -> waiting
export class Room {
  constructor(io, def) {
    this.io = io;
    this.id = def.id;
    this.name = def.name;
    this.theme = def.theme;
    this.seed = def.seed;
    this.crateChance = def.crateChance;
    this.channel = `room:${def.id}`;

    this.humans = new Map(); // socket id -> human actor (lobby and in-match)
    this.actors = []; // humans + bots taking part in the current match
    this.bullets = [];
    this.pickups = [];
    this.feed = [];
    this.scores = [0, 0, 0, 0];
    this.teamCount = 2;
    this.map = null;
    this.matchNo = 0;
    this.botSeq = 0;
    this.phase = 'waiting';
    this.phaseEnd = 0;
    this.lastCandy = 0;
    this.result = null;
    this.lastTick = Date.now();

    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      theme: this.theme,
      phase: this.phase,
      humans: this.humans.size,
      bots: this.actors.filter((a) => a.bot).length,
      full: this.humans.size >= MAX_HUMANS_PER_ROOM,
    };
  }

  join(socket, name) {
    if (this.humans.size >= MAX_HUMANS_PER_ROOM) return { ok: false, error: 'That room is full.' };

    this.humans.set(socket.id, makeActor({ id: socket.id, name, bot: false, socket }));
    socket.join(this.channel);

    if (this.phase === 'waiting') {
      this.phase = 'starting';
      this.phaseEnd = Date.now() + COUNTDOWN_MS;
    }
    // Returned in the ack so the client has the map before its listeners attach.
    // Late joiners spectate until the next match.
    return {
      ok: true,
      roomName: this.name,
      theme: this.theme,
      map: this.map ? this.mapPayload() : null,
    };
  }

  leave(socket) {
    const human = this.humans.get(socket.id);
    if (!human) return;
    this.humans.delete(socket.id);
    this.actors = this.actors.filter((a) => a !== human);
    socket.leave(this.channel);
  }

  setInput(id, { dx = 0, dy = 0, fire = false } = {}) {
    const human = this.humans.get(id);
    if (!human) return;
    human.dx = clamp(Number(dx) || 0, -1, 1);
    human.dy = clamp(Number(dy) || 0, -1, 1);
    human.fire = Boolean(fire);
  }

  tick() {
    const now = Date.now();
    const dtMs = Math.min(100, now - this.lastTick);
    this.lastTick = now;

    if (this.humans.size === 0 && this.phase !== 'waiting') this.reset();

    switch (this.phase) {
      case 'starting':
        if (now >= this.phaseEnd) this.startMatch(now);
        break;
      case 'playing': {
        this.step(now, dtMs);
        // The match is over when no human can still act: all are out of lives.
        const humanCanAct = this.actors.some((a) => !a.bot && (a.alive || !a.out));
        if (!humanCanAct || now >= this.phaseEnd || Math.max(...this.scores) >= SCORE_LIMIT) {
          this.endMatch(now);
        }
        break;
      }
      case 'results':
        if (now >= this.phaseEnd) {
          this.reset();
          if (this.humans.size) {
            this.phase = 'starting';
            this.phaseEnd = now + COUNTDOWN_MS;
          }
        }
        break;
      default:
        break;
    }

    if (this.humans.size) this.broadcast(now);
  }

  reset() {
    this.phase = 'waiting';
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

  startMatch(now) {
    const humans = shuffle([...this.humans.values()]);
    this.teamCount = clamp(humans.length, 2, 4);
    const target = Math.ceil(humans.length / this.teamCount);

    this.map = generateArena(this.seed + this.matchNo * 7919, this.crateChance);
    this.matchNo += 1;
    this.bullets = [];
    this.pickups = [];
    this.feed = [];
    this.result = null;
    this.scores = [0, 0, 0, 0];
    this.lastCandy = now;

    // Round-robin assignment keeps team sizes within one of each other.
    const sizes = Array(this.teamCount).fill(0);
    humans.forEach((h, i) => {
      h.team = i % this.teamCount;
      sizes[h.team] += 1;
    });
    this.actors = [...humans];

    // AI backfill: every team is topped up to the target size with medium bots.
    for (let team = 0; team < this.teamCount; team++) {
      for (let n = sizes[team]; n < target; n++) this.actors.push(this.spawnBot(team));
    }

    for (const a of this.actors) {
      a.kills = 0;
      a.deaths = 0;
      a.out = false;
      this.place(a, now);
    }

    this.phase = 'playing';
    this.phaseEnd = now + MATCH_MS;
    this.io.to(this.channel).emit('map', this.mapPayload());
    this.io.to(this.channel).emit('fx', { type: 'start' });
  }

  spawnBot(team) {
    this.botSeq += 1;
    const name = BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length];
    return makeActor({ id: `bot-${this.botSeq}`, name, bot: true, team, ai: new MediumBot() });
  }

  // Spawn or respawn. Power-ups are lost on death.
  place(a, now) {
    const spawn = SPAWN_CORNERS[a.team];
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
    for (const s of dirs) {
      this.bullets.push({
        id: nextId(),
        x: a.x + ax * s * 10,
        y: a.y + ay * s * 10,
        vx: ax * s * BULLET_SPEED,
        vy: ay * s * BULLET_SPEED,
        life: BULLET_LIFE_MS,
        team: a.team,
        owner: a,
        dead: false,
      });
    }
  }

  moveBullet(b, dtMs, now) {
    const dt = dtMs / 1000;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dtMs;
    if (b.life <= 0) {
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
        rapid: a.rapidUntil > now,
        double: a.doubleUntil > now,
        inv: a.invulnUntil > now,
      })),
      bullets: this.bullets.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), team: b.team })),
      pickups: this.pickups.map((p) => ({ id: p.id, kind: p.kind, x: Math.round(p.x), y: Math.round(p.y) })),
      crates: this.crateIndices(),
      scores: this.scores.slice(0, this.teamCount),
      feed: this.feed,
    });
  }
}
