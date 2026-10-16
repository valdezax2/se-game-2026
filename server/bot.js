import { TILE, MAX_HP } from '../shared/config.js';
import { findPath, hasLineOfSight, randomFloorTile, SPAWN_CORNERS } from './arena.js';

// CPU difficulty profiles
export const PROFILES = {
  easy: {
    reaction: [450, 650], // ms before engaging a newly spotted enemy
    accuracy: [0.4, 0.5],
    missAngle: [0.5, 0.7], // radians the aim is pushed off target on a miss
    sight: 130, // px
    attackRange: 100, // px
    fleeHp: 0.35, // flee below this fraction of max HP
    replanMs: 800,
  },
  medium: {
    reaction: [200, 350],
    accuracy: [0.7, 0.8],
    missAngle: [0.3, 0.5],
    sight: 170,
    attackRange: 120,
    fleeHp: 0.25,
    replanMs: 500,
  },
  hard: {
    reaction: [120, 200],
    accuracy: [0.88, 0.95],
    missAngle: [0.15, 0.25],
    sight: 220,
    attackRange: 140,
    fleeHp: 0.15,
    replanMs: 300,
  },
};

const LOST_TARGET_MS = 2_500; // keep searching this long after losing sight
const LOOT_PX = 112; // patrolling CPUs detour for a pickup this close

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const tileOf = (px) => Math.floor(px / TILE);
const centreOf = (t) => (t + 0.5) * TILE;

const nearest = (list, from) =>
  list.reduce((best, p) =>
    Math.hypot(p.x - from.x, p.y - from.y) < Math.hypot(best.x - from.x, best.y - from.y) ? p : best,
  );

const farthestCorner = (from) =>
  SPAWN_CORNERS.reduce((best, c) => {
    const d = Math.hypot(centreOf(c.tx) - from.x, centreOf(c.ty) - from.y);
    return !best || d > best.d ? { tx: c.tx, ty: c.ty, d } : best;
  }, null);

// State machine: patrol -> search / chase -> attack, with flee when hurt.
// Tuning comes from PROFILES[difficulty]; each bot gets its own accuracy roll.
export class CpuBot {
  constructor(difficulty = 'medium') {
    this.p = PROFILES[difficulty] ?? PROFILES.medium;
    this.accuracy = rand(...this.p.accuracy);
    this.reset();
  }

  reset() {
    this.state = 'patrol';
    this.path = [];
    this.goalKey = null;
    this.replanIn = 0;
    this.patrolGoal = null;
    this.targetId = null;
    this.reactionMs = 0;
    this.lastSeen = null;
  }

  // Writes intents onto `me`: dx/dy (unit or zero), aim (unit), fire.
  think(ctx, me, dtMs) {
    const { map, actors, pickups, now } = ctx;
    const p = this.p;
    me.dx = 0;
    me.dy = 0;
    me.fire = false;

    // 1. Perception: nearest enemy we have line of sight to
    let seen = null;
    let seenDist = Infinity;
    for (const a of actors) {
      if (!a.alive || a.team === me.team) continue;
      const d = Math.hypot(a.x - me.x, a.y - me.y);
      if (d < p.sight && d < seenDist && hasLineOfSight(map, me.x, me.y, a.x, a.y)) {
        seen = a;
        seenDist = d;
      }
    }
    if (seen) {
      if (this.targetId !== seen.id) {
        this.targetId = seen.id;
        this.reactionMs = rand(...p.reaction); // delay before engaging
      }
      this.reactionMs = Math.max(0, this.reactionMs - dtMs);
      this.lastSeen = { x: seen.x, y: seen.y, at: now };
    } else if (this.lastSeen && now - this.lastSeen.at > LOST_TARGET_MS) {
      this.targetId = null;
    }

    // 2. Decide what to do
    const engaged = seen !== null && this.reactionMs <= 0;
    const lowHp = me.hp < MAX_HP * p.fleeHp;
    let goal = null;

    if (lowHp && pickups.length) {
      this.state = 'flee';
      const c = nearest(pickups, me);
      goal = { tx: tileOf(c.x), ty: tileOf(c.y) };
    } else if (lowHp) {
      this.state = 'flee';
      goal = farthestCorner(seen ?? me);
    } else if (engaged && seenDist <= p.attackRange) {
      this.state = 'attack';
    } else if (engaged) {
      this.state = 'chase';
      goal = { tx: tileOf(seen.x), ty: tileOf(seen.y) };
    } else if (this.lastSeen && this.targetId && now - this.lastSeen.at < LOST_TARGET_MS) {
      this.state = 'search';
      goal = { tx: tileOf(this.lastSeen.x), ty: tileOf(this.lastSeen.y) };
    } else {
      this.state = 'patrol';
      // Detour for a pickup that is close by, otherwise keep wandering
      const loot = pickups.length ? nearest(pickups, me) : null;
      if (loot && Math.hypot(loot.x - me.x, loot.y - me.y) < LOOT_PX) {
        goal = { tx: tileOf(loot.x), ty: tileOf(loot.y) };
      } else {
        if (!this.patrolGoal || this.path.length === 0) this.patrolGoal = randomFloorTile(map);
        goal = this.patrolGoal;
      }
    }

    // 3. Route (re-plan on an interval or when the goal changes)
    if (goal) {
      const key = `${goal.tx},${goal.ty}`;
      this.replanIn -= dtMs;
      if (key !== this.goalKey || this.replanIn <= 0 || this.path.length === 0) {
        this.path = findPath(map, tileOf(me.x), tileOf(me.y), goal.tx, goal.ty) ?? [];
        this.goalKey = key;
        this.replanIn = p.replanMs;
      }
    }

    // 4. Walk the path
    while (this.path.length) {
      const wp = this.path[0];
      const dx = centreOf(wp.tx) - me.x;
      const dy = centreOf(wp.ty) - me.y;
      const d = Math.hypot(dx, dy);
      if (d < 2) {
        this.path.shift();
        continue;
      }
      me.dx = dx / d;
      me.dy = dy / d;
      break;
    }

    // 5. Combat: plant and shoot, with a deliberate miss part of the time
    if (this.state === 'attack' && seen) {
      me.dx = 0;
      me.dy = 0;
      const dx = seen.x - me.x;
      const dy = seen.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      let ax = dx / d;
      let ay = dy / d;
      if (Math.random() > this.accuracy) {
        const a = rand(...p.missAngle) * (Math.random() < 0.5 ? -1 : 1);
        [ax, ay] = [ax * Math.cos(a) - ay * Math.sin(a), ax * Math.sin(a) + ay * Math.cos(a)];
      }
      me.aim = { x: ax, y: ay };
      me.fire = true;
    } else if (me.dx || me.dy) {
      me.aim = { x: me.dx, y: me.dy };
    }
  }
}
