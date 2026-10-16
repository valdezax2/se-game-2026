import { TILE, MAX_HP } from '../shared/config.js';
import { findPath, hasLineOfSight, randomFloorTile, SPAWN_CORNERS } from './arena.js';

// "Medium" difficulty tuning
const SIGHT_RANGE = 170; // px
const ATTACK_RANGE = 120; // px: stop and shoot inside this
const LOST_TARGET_MS = 2_500; // keep searching this long after losing sight
const REPLAN_MS = 500; // NavMesh-style re-route interval
const FLEE_HP = MAX_HP * 0.25;

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
// Each bot gets its own accuracy (70-80%) and reaction time (200-350 ms).
export class MediumBot {
  constructor() {
    this.accuracy = rand(0.7, 0.8);
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

  // Writes ctx-free intents onto `me`: dx/dy (unit or zero), aim (unit), fire.
  think(ctx, me, dtMs) {
    const { map, actors, pickups, now } = ctx;
    me.dx = 0;
    me.dy = 0;
    me.fire = false;

    // 1. Perception: nearest enemy we have line of sight to
    let seen = null;
    let seenDist = Infinity;
    for (const a of actors) {
      if (!a.alive || a.team === me.team) continue;
      const d = Math.hypot(a.x - me.x, a.y - me.y);
      if (d < SIGHT_RANGE && d < seenDist && hasLineOfSight(map, me.x, me.y, a.x, a.y)) {
        seen = a;
        seenDist = d;
      }
    }
    if (seen) {
      if (this.targetId !== seen.id) {
        this.targetId = seen.id;
        this.reactionMs = rand(200, 350); // human-like delay before engaging
      }
      this.reactionMs = Math.max(0, this.reactionMs - dtMs);
      this.lastSeen = { x: seen.x, y: seen.y, at: now };
    } else if (this.lastSeen && now - this.lastSeen.at > LOST_TARGET_MS) {
      this.targetId = null;
    }

    // 2. Decide what to do
    const engaged = seen !== null && this.reactionMs <= 0;
    const lowHp = me.hp < FLEE_HP;
    let goal = null;

    if (lowHp && pickups.length) {
      this.state = 'flee';
      const p = nearest(pickups, me);
      goal = { tx: tileOf(p.x), ty: tileOf(p.y) };
    } else if (lowHp) {
      this.state = 'flee';
      goal = farthestCorner(seen ?? me);
    } else if (engaged && seenDist <= ATTACK_RANGE) {
      this.state = 'attack';
    } else if (engaged) {
      this.state = 'chase';
      goal = { tx: tileOf(seen.x), ty: tileOf(seen.y) };
    } else if (this.lastSeen && this.targetId && now - this.lastSeen.at < LOST_TARGET_MS) {
      this.state = 'search';
      goal = { tx: tileOf(this.lastSeen.x), ty: tileOf(this.lastSeen.y) };
    } else {
      this.state = 'patrol';
      if (!this.patrolGoal || this.path.length === 0) this.patrolGoal = randomFloorTile(map);
      goal = this.patrolGoal;
    }

    // 3. Route (re-plan every REPLAN_MS or when the goal changes)
    if (goal) {
      const key = `${goal.tx},${goal.ty}`;
      this.replanIn -= dtMs;
      if (key !== this.goalKey || this.replanIn <= 0 || this.path.length === 0) {
        const me0 = { tx: tileOf(me.x), ty: tileOf(me.y) };
        this.path = findPath(map, me0.tx, me0.ty, goal.tx, goal.ty) ?? [];
        this.goalKey = key;
        this.replanIn = REPLAN_MS;
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

    // 5. Combat: plant and shoot, with a deliberate miss for the other 20-30%
    if (this.state === 'attack' && seen) {
      me.dx = 0;
      me.dy = 0;
      const dx = seen.x - me.x;
      const dy = seen.y - me.y;
      const d = Math.hypot(dx, dy) || 1;
      let ax = dx / d;
      let ay = dy / d;
      if (Math.random() > this.accuracy) {
        const a = rand(0.3, 0.5) * (Math.random() < 0.5 ? -1 : 1);
        [ax, ay] = [ax * Math.cos(a) - ay * Math.sin(a), ax * Math.sin(a) + ay * Math.cos(a)];
      }
      me.aim = { x: ax, y: ay };
      me.fire = true;
    } else if (me.dx || me.dy) {
      me.aim = { x: me.dx, y: me.dy };
    }
  }
}
