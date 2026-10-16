import { COLS, ROWS, TILE, PLAYER_HALF } from '../shared/config.js';

export const FLOOR = 0;
export const WALL = 1; // tombstones, indestructible
export const CRATE = 2; // pumpkin crates, shot apart

// Corners in team order. Teams 0 and 1 start diagonally opposite.
export const SPAWN_CORNERS = [
  { tx: 1, ty: 1 },
  { tx: COLS - 2, ty: ROWS - 2 },
  { tx: COLS - 2, ty: 1 },
  { tx: 1, ty: ROWS - 2 },
];

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Small seeded PRNG (xorshift32) so each room's arena layout is repeatable.
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

export function generateArena(seed, crateChance = 0.25) {
  const rand = makeRng(seed);
  const tiles = new Uint8Array(COLS * ROWS);

  for (let ty = 0; ty < ROWS; ty++) {
    for (let tx = 0; tx < COLS; tx++) {
      const border = tx === 0 || ty === 0 || tx === COLS - 1 || ty === ROWS - 1;
      const pillar = tx % 2 === 0 && ty % 2 === 0;
      let tile = FLOOR;
      if (border || pillar) tile = WALL;
      else if (rand() < crateChance) tile = CRATE;
      tiles[ty * COLS + tx] = tile;
    }
  }

  // Clear crates around each spawn corner so nobody starts boxed in.
  for (const c of SPAWN_CORNERS) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = c.tx + dx;
        const y = c.ty + dy;
        if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
        if (tiles[y * COLS + x] === CRATE) tiles[y * COLS + x] = FLOOR;
      }
    }
  }

  return { cols: COLS, rows: ROWS, tiles, seed };
}

export function solidTile(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= map.cols || ty >= map.rows) return true;
  return map.tiles[ty * map.cols + tx] !== FLOOR;
}

export function solidAt(map, x, y) {
  return solidTile(map, Math.floor(x / TILE), Math.floor(y / TILE));
}

function boxBlocked(map, x, y) {
  const h = PLAYER_HALF;
  const e = 0.01;
  return (
    solidAt(map, x - h, y - h) ||
    solidAt(map, x + h - e, y - h) ||
    solidAt(map, x - h, y + h - e) ||
    solidAt(map, x + h - e, y + h - e)
  );
}

// Moves an entity's centre by (dx, dy), one axis at a time so it slides along walls.
export function moveBox(map, ent, dx, dy) {
  if (dx && !boxBlocked(map, ent.x + dx, ent.y)) ent.x += dx;
  if (dy && !boxBlocked(map, ent.x, ent.y + dy)) ent.y += dy;
}

export function hasLineOfSight(map, x1, y1, x2, y2) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (solidAt(map, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return false;
  }
  return true;
}

// A* over the tile grid (4-way). Returns tile steps after the start, or null.
export function findPath(map, sx, sy, gx, gy) {
  if (solidTile(map, gx, gy)) return null;
  if (sx === gx && sy === gy) return [];

  const W = map.cols;
  const start = sy * W + sx;
  const goal = gy * W + gx;
  const h = (i) => Math.abs((i % W) - gx) + Math.abs(Math.floor(i / W) - gy);

  const open = new Set([start]);
  const came = new Map();
  const g = new Map([[start, 0]]);
  const f = new Map([[start, h(start)]]);

  while (open.size) {
    let cur = null;
    let best = Infinity;
    for (const n of open) {
      const fn = f.get(n);
      if (fn < best) {
        best = fn;
        cur = n;
      }
    }

    if (cur === goal) {
      const path = [];
      for (let c = cur; c !== start; c = came.get(c)) {
        path.push({ tx: c % W, ty: Math.floor(c / W) });
      }
      return path.reverse();
    }

    open.delete(cur);
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (solidTile(map, nx, ny)) continue;
      const n = ny * W + nx;
      const ng = g.get(cur) + 1;
      if (ng < (g.get(n) ?? Infinity)) {
        came.set(n, cur);
        g.set(n, ng);
        f.set(n, ng + h(n));
        open.add(n);
      }
    }
  }
  return null;
}

export function randomFloorTile(map) {
  for (let tries = 0; tries < 200; tries++) {
    const tx = 1 + Math.floor(Math.random() * (map.cols - 2));
    const ty = 1 + Math.floor(Math.random() * (map.rows - 2));
    if (!solidTile(map, tx, ty)) return { tx, ty };
  }
  return { tx: 1, ty: 1 };
}
