# Queens Tech: Cloud 3Lit3S

A Halloween 8-bit multiplayer arena brawl for the browser. Players sign in, create
public or password-protected rooms, and play with human friends and CPU opponents.

## Run it locally

Requires Node.js 18 or newer.

```bash
npm install
npm start          # then open http://localhost:3000
npm test           # account, room and rule checks, plus an end-to-end smoke test
```

Accounts are saved to `data/users.json` (ignored by git). Set `DATA_DIR` to use a
different folder, and `PORT` to use a different port.

## Accounts

Sign-up asks for first and last name, phone, email, zip code, date of birth, and a
password. Only the first name and last initial are shown to other players.

- Passwords are stored as salted scrypt hashes, never in plain text.
- Email is the login name and must be unique.
- Zip codes are checked against the US format (5 digits, optional +4).
- Date of birth must be a real date in the past. The app stores it but does not yet
  enforce an age limit.

## Rooms

Any signed-in player can create a room with:

| Setting | Meaning |
| ------- | ------- |
| Name | Up to 24 characters |
| Total players | 2 to 8, including CPUs |
| Human slots | How many humans may join. The rest of the total are CPUs. Leave blank to allow all humans. |
| CPU difficulty | Easy, medium or hard. Applies to every CPU in the room. |
| Visibility | Public, or password protected (4 to 32 characters) |

Password-protected rooms are still listed, marked Private, and need the password to join.

### Host

The player who creates a room is the host. Only the host can:

- **Start match.** Begins a 5-second countdown. Nothing starts on its own; the room
  waits until the host presses Start.
- **Reload match.** Restarts the round immediately with a new map and zeroed scores.
  Reloaded rounds do not count toward the leaderboard.
- **Leave room** and **Leave** (in-match bar) are available to everyone.

If the host is disconnected for more than 5 seconds, host status passes to the
earliest-joined connected player. A host who reconnects within 5 seconds keeps it.
Players who stay offline for 30 seconds are removed from the room.

## Matches and scoring

- Teams: 2 to 4, chosen from the total player count. Players and CPUs are spread
  round-robin so team sizes differ by at most one.
- A match ends at 3 minutes, when a team reaches 20 kills, or when every human is out
  of lives.
- Each player has 5 lives. After the fifth death they can watch but not respawn.
- **Scoreboard:** hold Tab during a match to see the live kill ranking. The results
  screen shows the final ranking.
- **Top killers:** the lobby leaderboard adds up kills from every finished match
  (reloads excluded).

### Power-ups and range

- Rapid Fire: shorter fire cooldown for 8 seconds (rare).
- Two-Way: fires forward and backward for 8 seconds (rare).
- Bullets stop after 4 tiles. Players with more than 5 kills fire 5 tiles (shown as LONG on the HUD).

## CPU difficulty

`server/bot.js` holds the three profiles:

| | Easy | Medium | Hard |
| - | ---- | ------ | ---- |
| Reaction time | 450–650 ms | 200–350 ms | 120–200 ms |
| Accuracy | 40–50% | 70–80% | 88–95% |
| Sight | 130 px | 170 px | 220 px |
| Flees below | 35% HP | 25% HP | 15% HP |

## Controls

| Action | Keys |
| ------ | ---- |
| Move | Arrow keys or WASD |
| Fire | Space or J |
| Scoreboard | Hold Tab |
| Leave the room | Esc |

## Architecture

The server is authoritative. Clients send input and render snapshots.

```
browser (Phaser 3, 320x224 pixel canvas)  <--- socket.io (auth token) --->  Node.js
  public/js/main.js         sign-in, lobby, room screen, game lifecycle
  public/js/game-scene.js   render, input, scoreboard
  public/js/sprites.js      procedural pixel art
  public/js/audio.js        WebAudio blips

server/index.js     express routes (/api/*), socket.io events, room registry
server/store.js     account storage (JSON file), leaderboard
server/validate.js  registration and room form rules
server/security.js  scrypt hashing, session tokens
server/room.js      room lifecycle, host, slots, match simulation at 30 Hz
server/bot.js       CPU profiles and state machine
server/arena.js     maps, collision, A* routing
shared/config.js    constants used by server and client
```

## Before a public launch

This build is for local play and testing. Before exposing it to the internet:

- **Move accounts to a real database** and encrypt personal fields (phone, email, zip,
  date of birth). They are currently plain text in `data/users.json`.
- **Serve over HTTPS.** Session tokens are sent in the browser on each request.
- **Add rate limits** on `/api/login` and `/api/register`, and lock accounts after repeated failures.
- **Decide on an age rule** for date of birth, and add a privacy notice to sign-up.
- Sessions are kept in memory, so they reset when the server restarts.
