import { TILE, HUD_H, TEAMS } from '/shared/config.js';
import { makeTextures } from './sprites.js';
import { sfx } from './audio.js';

const WALL = 1;
const CRATE = 2;
const LERP = 0.35;
const SHOT_SFX_MS = 380;
const MAX_HP = 100;

// Set by main.js before the Phaser game boots.
// `detach` is filled in by the scene so the lobby can unhook socket listeners.
export const session = { net: null, detach: null };

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

export class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  create() {
    this.net = session.net;
    this.myId = this.net.socket.id;
    makeTextures(this);

    this.mapNo = -1;
    this.mapObjs = [];
    this.crateViews = new Map();
    this.actorViews = new Map();
    this.pickupViews = new Map();
    this.bulletViews = [];
    this.lastEnd = null;
    this.lastShotSfx = 0;

    this.buildHud();

    this.keys = this.input.keyboard.addKeys({
      up: 'W',
      down: 'S',
      left: 'A',
      right: 'D',
      arrowUp: 'UP',
      arrowDown: 'DOWN',
      arrowLeft: 'LEFT',
      arrowRight: 'RIGHT',
      fire: 'SPACE',
      fire2: 'J',
      leave: 'ESC',
    });

    this.handlers = {
      map: (m) => this.buildMap(m),
      snapshot: (s) => this.applySnapshot(s),
      'match:end': (r) => {
        this.lastEnd = r;
      },
      fx: (fx) => this.onFx(fx),
    };
    const socket = this.net.socket;
    for (const [evt, fn] of Object.entries(this.handlers)) socket.on(evt, fn);
    const detach = () => {
      for (const [evt, fn] of Object.entries(this.handlers)) socket.off(evt, fn);
    };
    session.detach = detach;
    this.events.once('shutdown', detach);

    if (this.net.initialMap) this.buildMap(this.net.initialMap);

    this.time.addEvent({ delay: 33, loop: true, callback: () => this.sendInput() });
  }

  buildHud() {
    const base = { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff' };
    this.add.rectangle(0, 0, 320, HUD_H, 0x0b0712, 0.92).setOrigin(0).setDepth(100);
    this.hudLeft = this.add.text(4, 4, '', base).setDepth(101);
    this.hudRight = this.add.text(316, 4, '', base).setOrigin(1, 0).setDepth(101);
    this.hudTeams = TEAMS.map((t) => this.add.text(0, 4, '', { ...base, color: hex(t.color) }).setDepth(101));
    this.feedText = this.add
      .text(4, HUD_H + 4, '', { fontFamily: 'monospace', fontSize: '7px', color: '#ffd23f' })
      .setDepth(101);
    this.banner = this.add
      .text(160, 120, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#ffd23f',
        align: 'center',
        stroke: '#000000',
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(200);
  }

  sendInput() {
    const k = this.keys;
    const dx = (k.right.isDown || k.arrowRight.isDown ? 1 : 0) - (k.left.isDown || k.arrowLeft.isDown ? 1 : 0);
    const dy = (k.down.isDown || k.arrowDown.isDown ? 1 : 0) - (k.up.isDown || k.arrowUp.isDown ? 1 : 0);
    const fire = k.fire.isDown || k.fire2.isDown;
    if (fire && this.time.now - this.lastShotSfx > SHOT_SFX_MS) {
      this.lastShotSfx = this.time.now;
      sfx('shoot');
    }
    this.net.socket.emit('input', { dx, dy, fire });
  }

  buildMap(m) {
    if (m.matchNo === this.mapNo) return;
    this.mapNo = m.matchNo;

    for (const o of this.mapObjs) o.destroy();
    this.mapObjs = [];
    for (const v of this.crateViews.values()) v.destroy();
    this.crateViews.clear();

    m.tiles.forEach((t, i) => {
      const tx = i % m.cols;
      const ty = Math.floor(i / m.cols);
      const x = tx * TILE;
      const y = HUD_H + ty * TILE;
      this.mapObjs.push(this.add.image(x, y, `floor${(tx * 7 + ty * 3) % 3}`).setOrigin(0).setDepth(0));
      if (t === WALL) this.mapObjs.push(this.add.image(x, y, 'wall').setOrigin(0).setDepth(1));
      if (t === CRATE) this.crateViews.set(i, this.add.image(x, y, 'crate').setOrigin(0).setDepth(2));
    });
  }

  applySnapshot(s) {
    // Crates shot since last snapshot
    const standing = new Set(s.crates);
    for (const [idx, view] of this.crateViews) {
      if (!standing.has(idx)) {
        this.poof(view);
        this.crateViews.delete(idx);
      }
    }

    // Actors (humans and bots)
    const ids = new Set();
    for (const a of s.actors) {
      ids.add(a.id);
      let v = this.actorViews.get(a.id);
      if (!v) {
        v = this.makeActorView(a);
        this.actorViews.set(a.id, v);
      }
      v.a = a;
    }
    for (const [id, v] of this.actorViews) {
      if (!ids.has(id)) {
        v.root.destroy();
        this.actorViews.delete(id);
      }
    }

    // Candy
    const candy = new Set(s.pickups.map((p) => p.id));
    for (const p of s.pickups) {
      if (!this.pickupViews.has(p.id)) this.pickupViews.set(p.id, this.makePickup(p));
    }
    for (const [id, img] of this.pickupViews) {
      if (!candy.has(id)) {
        img.destroy();
        this.pickupViews.delete(id);
      }
    }

    // Bullets: reuse a pool of images
    while (this.bulletViews.length < s.bullets.length) {
      this.bulletViews.push(this.add.image(0, 0, 'bullet').setDepth(12));
    }
    this.bulletViews.forEach((img, i) => {
      const b = s.bullets[i];
      img.setVisible(Boolean(b));
      if (b) {
        img.setPosition(b.x, b.y + HUD_H);
        img.setTint(TEAMS[b.team].color);
      }
    });

    this.updateHud(s);
  }

  makeActorView(a) {
    const root = this.add.container(0, 0).setDepth(10);
    const gun = this.add.graphics();
    const sprite = this.add.image(0, 0, `char${a.team}`);
    const hp = this.add.graphics();
    const tag = this.add
      .text(0, -12, a.name, {
        fontFamily: 'monospace',
        fontSize: '7px',
        color: a.bot ? '#c9bfe0' : '#ffffff',
        stroke: '#000000',
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1);
    root.add([gun, sprite, hp, tag]);
    return { root, sprite, gun, hp, a, moving: false };
  }

  makePickup(p) {
    const img = this.add.image(p.x, p.y + HUD_H, 'candy').setDepth(5);
    this.tweens.add({ targets: img, y: img.y - 2, duration: 500, yoyo: true, repeat: -1 });
    return img;
  }

  poof(img) {
    this.tweens.add({ targets: img, scale: 0, alpha: 0, duration: 180, onComplete: () => img.destroy() });
  }

  update(time) {
    if (Phaser.Input.Keyboard.JustDown(this.keys.leave)) {
      setTimeout(() => this.net.onLeave(), 0);
      return;
    }
    for (const v of this.actorViews.values()) this.renderActor(v, time);
  }

  renderActor(v, time) {
    const a = v.a;
    const tx = a.x;
    const ty = a.y + HUD_H;
    v.moving = Math.hypot(tx - v.root.x, ty - v.root.y) > 1.5;
    v.root.x += (tx - v.root.x) * LERP;
    v.root.y += (ty - v.root.y) * LERP;

    v.root.visible = a.alive;
    v.root.alpha = a.inv && Math.floor(time / 100) % 2 ? 0.4 : 1;
    v.sprite.setFlipX(a.ax < 0);
    v.sprite.y = v.moving ? Math.round(Math.sin(time / 60)) : 0;

    v.gun.clear();
    if (a.alive) {
      v.gun.fillStyle(0xffffff, 1);
      v.gun.fillRect(Math.round(a.ax * 9) - 1, Math.round(a.ay * 9) - 1, 2, 2);
    }

    v.hp.clear();
    if (a.alive) {
      const pct = Math.max(0, a.hp) / MAX_HP;
      v.hp.fillStyle(0x000000, 1);
      v.hp.fillRect(-8, 9, 16, 2);
      v.hp.fillStyle(pct > 0.5 ? 0x3ddc84 : pct > 0.25 ? 0xffd23f : 0xe63946, 1);
      v.hp.fillRect(-8, 9, Math.round(16 * pct), 2);
    }
  }

  updateHud(s) {
    const me = s.actors.find((a) => a.id === this.myId);

    this.hudLeft.setText(
      me ? `HP ${Math.max(0, me.hp)} K ${me.kills} D ${me.deaths}` : s.phase === 'starting' ? 'GET READY' : 'SPECTATING',
    );

    const slot = (i) => 96 + i * 44;
    this.hudTeams.forEach((txt, i) => {
      if (i < s.scores.length) {
        txt.setVisible(true).setText(`${TEAMS[i].short} ${s.scores[i]}`).setX(slot(i));
      } else {
        txt.setVisible(false);
      }
    });

    const clock =
      s.phase === 'playing'
        ? `${Math.floor(s.left / 60000)}:${String(Math.floor((s.left % 60000) / 1000)).padStart(2, '0')}`
        : s.phase === 'starting'
          ? `GO ${Math.ceil(s.left / 1000)}`
          : s.phase === 'results'
            ? 'OVER'
            : '--';
    this.hudRight.setText(clock);

    this.feedText.setText(s.feed.join('\n'));

    let text = '';
    if (s.phase === 'starting') text = `MATCH STARTS IN ${Math.ceil(s.left / 1000)}\nbots fill the empty slots`;
    else if (s.phase === 'playing' && me && !me.alive) text = "YOU'RE DOWN...\nrespawning";
    else if (s.phase === 'results' && this.lastEnd) text = this.resultText(this.lastEnd);
    else if (s.phase === 'waiting') text = 'Waiting for players...';
    this.banner.setText(text).setVisible(text.length > 0);
  }

  resultText(r) {
    const headline = r.winner < 0 ? 'DRAW!' : `${TEAMS[r.winner].name.toUpperCase()} WIN!`;
    const scores = r.teams.map((t) => `${TEAMS[t.team].short} ${t.score}`).join('   ');
    const top = r.players
      .slice(0, 3)
      .map((p, i) => `${i + 1}. ${p.name} ${p.kills}K`)
      .join('\n');
    return `${headline}\n${scores}\n${top}`;
  }

  onFx(fx) {
    if (fx.type === 'kill' || fx.type === 'pickup' || fx.type === 'start' || fx.type === 'hit') sfx(fx.type);
  }
}
