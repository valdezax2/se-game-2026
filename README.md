# Queens Tech: Cloud 3Lit3S

A Halloween 8-bit multiplayer arena brawl for the browser. Four permanent rooms,
2–4 teams per match, and CPU "medium" bots that fill any empty slots.

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm start          # then open http://localhost:3000
npm test           # boots the server and runs an end-to-end smoke test
```

Open two or more browser windows to play against each other. With one player,
the match is 1 human vs. 1 CPU.

### Controls

| Action | Keys |
| ------ | ---- |
| Move | Arrow keys or WASD |
| Fire candy | Space or J |
| Leave the room | Esc |

## How a match runs

1. **Lobby.** Pick a name and join one of four rooms.
2. **Matchmaking.** The first player starts an 8-second countdown. Anyone who
   joins during it is included.
3. **Balancing.** Teams = humans clamped to 2–4. Target size = `ceil(humans / teams)`.
   Humans are dealt round-robin, then a medium bot fills each team up to the target.
4. **Match.** 3 minutes or first team to 20 kills. Candy (health) spawns
   periodically, and pumpkin crates drop candy when shot.
5. **Results.** Scores and top players for 10 seconds, then back to matchmaking.
   Players who join mid-match spectate until the next match.

## The costumes

Every character shares one body (same silhouette, face, and shoes, defined in
`public/js/sprites.js`). Only the attire changes per team:

| Team | Costume | Attire |
| ---- | ------- | ------ |
| Red · Vampires | Vampire | Red cape, black collar, fangs |
| Blue · Witches | Witch | Tall hat with an orange star band, wide brim |
| Green · Mummies | Mummy | Cream bandages on head and torso |
| Yellow · Scarecrows | Scarecrow | Straw hat, patched coat |

## Medium bots

`server/bot.js`. A state machine: patrol, search, chase, attack, and flee.

- **Reaction time:** 200–350 ms before engaging a newly spotted enemy.
- **Accuracy:** 70–80% per bot. Misses rotate the aim 17–29°.
- **Routing:** A* on the tile grid, re-planned every 500 ms.
- **Flee:** below 25% HP, runs for the nearest candy, or to the far corner if there is none.

## Architecture

The server is authoritative. Clients send input only and render snapshots.

```
browser (Phaser 3, 320x224 pixel canvas)  <--- socket.io --->  Node.js
  public/js/main.js        lobby, room list                  server/index.js     express + socket.io
  public/js/game-scene.js  render, input, interpolation      server/room.js      match lifecycle, 30 Hz tick
  public/js/sprites.js     procedural pixel art             server/bot.js       medium AI
  public/js/audio.js       WebAudio chiptune blips          server/arena.js     maps, collision, A*
                                                            shared/config.js    constants used by both sides
```

Each room runs its own 30 Hz loop and broadcasts a snapshot every tick to its
socket.io channel. Phaser is served from `node_modules` at `/vendor/phaser`,
so the game runs offline once installed.

## Status against the design doc

- [x] Phase 1: Node backend, four isolated rooms, real-time sync over WebSocket
- [x] Phase 2: Phaser 3 canvas, pixel-perfect scaling, keyboard controls
- [x] Phase 3: room auto-balancer, medium bot state machine
- [~] Phase 4: sprites and tiles are procedural (no external asset packs yet),
  sound effects are procedural WebAudio blips, and there is no background music yet

Not yet built: client-side prediction (fine on localhost, noticeable over the internet),
walk-cycle frames (the sprite bobs instead), and a custom map editor.
