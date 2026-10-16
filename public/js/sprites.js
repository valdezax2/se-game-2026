import { TEAMS } from '/shared/config.js';

// 8-bit palette. Team clothing colours are added per team in buildPixels().
const PAL = {
  K: '#1b1024', // outline
  T: '#f4c7a1', // skin
  t: '#d9a07a', // skin shade
  H: '#2b1d2e', // hair
  E: '#15101c', // eyes
  W: '#ffffff',
  R: '#8f1d2a', // mouth
  B: '#2a1d26', // shoes
  A: '#ff8c1a', // Halloween orange accent
  C: '#efe6c8', // bandage cream
  Q: '#e2b85c', // straw
  q: '#b38a36', // straw shade
  N: '#7a4a22', // patch brown
};

// One shared body for every costume: same silhouette, face and shoes.
// P = team colour, S = team shade. Attire is painted on top per team.
const BODY = [
  '................',
  '....KKKKKKKK....',
  '...KHHHHHHHHK...',
  '...KHHHHHHHHK...',
  '...KHTTTTTTHK...',
  '...KTTETTETTK...',
  '...KTTTTTTTTK...',
  '...KTTTRRTTTK...',
  '....KttttttK....',
  '..KPPPPPPPPPPK..',
  '..KTPPPPPPPPTK..',
  '..KTPPPAAPPPTK..',
  '..KTPPPPPPPPTK..',
  '....KSSSSSSK....',
  '....KSSKKSSK....',
  '...KBBBKKBBBK...',
];

const put = (px, x, y, c) => {
  if (px[y] && x >= 0 && x < 16) px[y][x] = c;
};

// Costume per team index: Vampires, Witches, Mummies, Scarecrows.
const ATTIRE = [
  // Vampire: red cape, black collar, fangs
  (px, c) => {
    for (let y = 8; y <= 14; y++) {
      for (const x of [0, 1, 14, 15]) {
        if (!px[y][x]) put(px, x, y, x === 0 || x === 15 ? c.S : c.P);
      }
    }
    for (let x = 6; x <= 9; x++) put(px, x, 9, c.K);
    put(px, 6, 7, c.W);
    put(px, 9, 7, c.W);
  },
  // Witch: tall hat, orange star band, wide brim
  (px, c) => {
    put(px, 7, 0, c.P);
    put(px, 8, 0, c.P);
    for (let x = 6; x <= 9; x++) put(px, x, 1, c.P);
    put(px, 7, 1, c.A);
    put(px, 8, 1, c.A);
    for (let x = 1; x <= 14; x++) put(px, x, 2, c.S);
  },
  // Mummy: cream bandages around head and body
  (px, c) => {
    for (const y of [2, 3]) {
      for (let x = 3; x <= 12; x++) if (px[y][x]) put(px, x, y, c.C);
    }
    for (const y of [10, 12]) {
      for (let x = 4; x <= 11; x++) put(px, x, y, c.C);
    }
  },
  // Scarecrow: straw hat, patched coat
  (px, c) => {
    put(px, 7, 0, c.Q);
    put(px, 8, 0, c.Q);
    for (let x = 5; x <= 10; x++) put(px, x, 1, x % 2 ? c.Q : c.q);
    for (let x = 1; x <= 14; x++) put(px, x, 2, x % 2 ? c.Q : c.q);
    for (const [x, y] of [[5, 10], [6, 10], [9, 12], [10, 12]]) put(px, x, y, c.N);
  },
];

const hexOf = (n) => `#${n.toString(16).padStart(6, '0')}`;
const shade = (n, f) => {
  const r = (((n >> 16) & 255) * f) | 0;
  const g = (((n >> 8) & 255) * f) | 0;
  const b = ((n & 255) * f) | 0;
  return hexOf((r << 16) | (g << 8) | b);
};

function buildPixels(team) {
  const color = TEAMS[team].color;
  const c = { ...PAL, P: hexOf(color), S: shade(color, 0.6) };
  const px = BODY.map((row) => [...row].map((ch) => (ch === '.' ? null : (c[ch] ?? null))));
  ATTIRE[team](px, c);
  return px;
}

// Seeded LCG so floor speckles are identical every run.
function rng(seed) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const dot = (ctx, x, y, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
};

function paint(scene, key, w, h, draw) {
  if (scene.textures.exists(key)) return;
  const tex = scene.textures.createCanvas(key, w, h);
  draw(tex.getContext());
  tex.refresh();
}

function drawGrid(ctx, rows, colors, ox = 0, oy = 0) {
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== '.' && colors[ch]) dot(ctx, ox + x, oy + y, colors[ch]);
    });
  });
}

const FLOOR_BASE = '#2a1f35';
const WALL_BASE = '#15101f';

const TOMBSTONE = [
  '....KKKKKKKK....',
  '...KllllllllK...',
  '...KggggggggK...',
  '...KggggddggK...',
  '...KggddddggK...',
  '...KggggddggK...',
  '...KggggddggK...',
  '...KggggggggK...',
  '...KddddddddK...',
  '..KKKKKKKKKKKK..',
];
const TOMB_COLORS = { K: '#0d0814', l: '#b5b1c8', g: '#8a86a0', d: '#5b5876' };

// Pumpkin crate: drawn procedurally so it scales cleanly.
function drawPumpkin(ctx) {
  ctx.fillStyle = FLOOR_BASE;
  ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = (x + 0.5 - 8) / 6.6;
      const dy = (y + 0.5 - 9) / 5.6;
      const d = dx * dx + dy * dy;
      if (d <= 0.8) dot(ctx, x, y, x > 10 ? '#e0700f' : '#ff8c1a');
      else if (d <= 1) dot(ctx, x, y, '#3d1a05');
    }
  }
  // stem
  dot(ctx, 7, 1, '#4a7a2a');
  dot(ctx, 8, 1, '#4a7a2a');
  dot(ctx, 7, 2, '#4a7a2a');
  dot(ctx, 8, 2, '#4a7a2a');
  // face
  for (const [x, y] of [[5, 6], [6, 6], [5, 7], [6, 7], [9, 6], [10, 6], [9, 7], [10, 7]]) {
    dot(ctx, x, y, '#1b1024');
  }
  for (let x = 5; x <= 10; x++) dot(ctx, x, 10, '#1b1024');
  for (const x of [5, 7, 9]) dot(ctx, x, 11, '#1b1024');
}

export function makeTextures(scene) {
  // Floors: three dark-purple variants with moss and cracks
  for (let i = 0; i < 3; i++) {
    paint(scene, `floor${i}`, 16, 16, (ctx) => {
      ctx.fillStyle = FLOOR_BASE;
      ctx.fillRect(0, 0, 16, 16);
      const r = rng(11 + i * 97);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const v = r();
          if (v < 0.06) dot(ctx, x, y, '#3a2c47');
          else if (v < 0.09) dot(ctx, x, y, '#2f4a2c');
        }
      }
    });
  }

  paint(scene, 'wall', 16, 16, (ctx) => {
    ctx.fillStyle = WALL_BASE;
    ctx.fillRect(0, 0, 16, 16);
    drawGrid(ctx, TOMBSTONE, TOMB_COLORS, 0, 2);
  });

  paint(scene, 'crate', 16, 16, drawPumpkin);

  // Candy corn pickup (8x8)
  paint(scene, 'candy', 8, 8, (ctx) => {
    const rows = [
      [1, 6, '#fff7e6'],
      [2, 5, '#fff7e6'],
      [2, 5, '#ff8c1a'],
      [3, 4, '#ff8c1a'],
      [3, 4, '#ffd23f'],
      [3, 4, '#ffd23f'],
    ];
    rows.forEach(([x0, x1, color], y) => {
      for (let x = x0; x <= x1; x++) dot(ctx, x, y + 1, color);
    });
  });

  // Rapid Fire: orange lightning bolt (8x8)
  paint(scene, 'power-rapid', 8, 8, (ctx) => {
    const rows = ['...YYY..', '..YYY...', '.YYY....', '.YYYYYY.', '....YYY.', '...YYY..', '..YYY...', '..Y.....'];
    drawGrid(ctx, rows, { Y: '#ffd23f' });
  });

  // Two-Way: purple double arrow (8x8)
  paint(scene, 'power-double', 8, 8, (ctx) => {
    const rows = ['........', '.P..P...', 'PPPPPPPP', 'PPPPPPPP', 'PPPPPPPP', '.P..P...', '........', '........'];
    drawGrid(ctx, rows, { P: '#b26bff' });
  });

  // Candy bullet (4x4, tinted per team)
  paint(scene, 'bullet', 4, 4, (ctx) => {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        if ((x === 0 || x === 3) && (y === 0 || y === 3)) continue;
        dot(ctx, x, y, '#ffffff');
      }
    }
  });

  for (let t = 0; t < TEAMS.length; t++) {
    paint(scene, `char${t}`, 16, 16, (ctx) => {
      const px = buildPixels(t);
      px.forEach((row, y) => row.forEach((col, x) => col && dot(ctx, x, y, col)));
    });
  }
}
