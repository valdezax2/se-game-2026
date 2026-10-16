// Constants shared by the Node server and the browser client.
// World units are pixels. The arena is COLS x ROWS tiles of TILE px,
// drawn beneath a HUD_H px bar, for a 320x224 internal canvas.

export const TILE = 16;
export const COLS = 20;
export const ROWS = 13;
export const HUD_H = 16;

export const TICK_HZ = 30;

// Room and match flow (milliseconds)
export const COUNTDOWN_MS = 5_000; // after the host starts (or reloads)
export const MATCH_MS = 180_000;
export const RESULTS_MS = 10_000;
export const SCORE_LIMIT = 20;
export const HOST_GRACE_MS = 5_000; // host offline this long -> host passes to another player
export const PRESENCE_MS = 30_000; // players offline this long are removed from the room

// Room limits
export const ROOM_LIMITS = {
  totalMin: 2,
  totalMax: 8,
  nameMax: 24,
  passwordMin: 4,
  passwordMax: 32,
};
export const MAX_ROOMS = 30;
export const DIFFICULTIES = ['easy', 'medium', 'hard'];

// Combat
export const MAX_HP = 100;
export const MOVE_SPEED = 62; // px per second
export const RESPAWN_MS = 3_000;
export const INVULN_MS = 1_500;
export const FIRE_COOLDOWN_MS = 380;
export const BULLET_SPEED = 180; // px per second
export const BULLET_DAMAGE = 20;
export const SHOOT_ANIM_MS = 160; // how long the shooting pose shows after a shot

// Bullets stop after a set distance, measured in tiles from where they spawn.
export const BULLET_RANGE_TILES = 4;
export const LONG_RANGE_TILES = 5; // upgrade range
export const LONG_RANGE_KILLS = 5; // upgrade applies once a player has MORE than this many kills

// Lives: after this many deaths a player can no longer respawn this match
export const MAX_DEATHS = 5;

// Candy (health pickups)
export const CANDY_HEAL = 30;
export const CANDY_MAX = 4;
export const CANDY_SPAWN_MS = 8_000;

// Rare power-ups. Each spawn rolls for one of these, otherwise it is candy.
export const POWER_CHANCE = 0.06; // per kind
export const POWER_MS = 8_000;
export const RAPID_COOLDOWN_MS = 140; // fire cooldown while Rapid Fire is active

export const PLAYER_HALF = 5; // collision box half-size

// One distinct clothing colour per player slot (8 is the maximum room size).
// Each player keeps the same colour for the whole time they're in a room.
export const PLAYER_COLORS = [
  0xe63946, // red
  0x3a7bd5, // blue
  0x3ddc84, // green
  0xffd23f, // yellow
  0xb26bff, // purple
  0xff8c1a, // orange
  0x3ee8e8, // cyan
  0xff6fb5, // pink
];

// Teams double as costumes. Index = team id used everywhere.
export const TEAMS = [
  { name: 'Vampires', short: 'VAMP', color: 0xe63946 },
  { name: 'Witches', short: 'WTCH', color: 0x3a7bd5 },
  { name: 'Mummies', short: 'MUMY', color: 0x3ddc84 },
  { name: 'Scarecrows', short: 'SCRW', color: 0xffd23f },
];
