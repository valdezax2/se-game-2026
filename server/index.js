import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { Room } from './room.js';
import { UserStore, profileOf, displayNameOf } from './store.js';
import { validateRoomConfig } from './validate.js';
import { hashSecret, newToken } from './security.js';
import { MAX_ROOMS } from '../shared/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

const store = new UserStore(path.join(DATA_DIR, 'users.json'));
const sessions = new Map(); // token -> { userId, expires }
const rooms = new Map(); // room id -> Room
const userRoom = new Map(); // user id -> room id
let roomSeq = 1;

const hooks = {
  onMatchEnd: (humans) => {
    for (const h of humans) store.recordMatch(h.id, h.kills);
  },
};

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));

const http = createServer(app);
const io = new Server(http);

function userFromToken(token) {
  const s = token ? sessions.get(token) : null;
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return store.byId.get(s.userId) ?? null;
}

const tokenFromReq = (req) => {
  const h = req.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

function startSession(userId) {
  const token = newToken();
  sessions.set(token, { userId, expires: Date.now() + SESSION_MS });
  return token;
}

// ---- Accounts -------------------------------------------------------------

app.post('/api/register', (req, res) => {
  const r = store.register(req.body ?? {});
  if (r.errors) return res.status(400).json({ errors: r.errors });
  res.json({ token: startSession(r.user.id), user: profileOf(r.user) });
});

app.post('/api/login', (req, res) => {
  const u = store.login(req.body?.email, req.body?.password);
  if (!u) return res.status(401).json({ error: 'Email or password is incorrect.' });
  res.json({ token: startSession(u.id), user: profileOf(u) });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(tokenFromReq(req));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = userFromToken(tokenFromReq(req));
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  res.json(profileOf(u));
});

// Public: display names and kill totals only
app.get('/api/leaderboard', (_req, res) => res.json(store.leaderboard(20)));

// ---- Rooms ----------------------------------------------------------------

const listRooms = () => [...rooms.values()].map((r) => r.summary());

function destroyIfEmpty(room) {
  if (room.humans.size > 0) return;
  room.destroy();
  rooms.delete(room.id);
}

setInterval(() => {
  for (const room of [...rooms.values()]) destroyIfEmpty(room);
  io.emit('rooms', listRooms());
}, 1000);

function leaveRoom(userId, socket) {
  const room = rooms.get(userRoom.get(userId));
  userRoom.delete(userId);
  if (!room) return;
  socket?.leave(room.channel);
  room.leave(userId);
  destroyIfEmpty(room);
}

function withRoom(userId, fn) {
  const room = rooms.get(userRoom.get(userId));
  if (!room) return fail('You are not in a room.');
  return fn(room) ?? { ok: true };
}

const fail = (error) => ({ ok: false, error });

io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  socket.data.name = displayNameOf(user);
  next();
});

io.on('connection', (socket) => {
  const { userId, name } = socket.data;

  // A returning player resumes their room seat on the new socket.
  const current = rooms.get(userRoom.get(userId));
  if (!current || !current.reattach(userId, socket)) userRoom.delete(userId);

  socket.emit('rooms', listRooms());

  socket.on('room:create', (req = {}, ack = () => {}) => {
    if (rooms.get(userRoom.get(userId))) return ack(fail('Leave your current room first.'));
    if (rooms.size >= MAX_ROOMS) return ack(fail('There are too many rooms right now. Try joining one.'));

    const v = validateRoomConfig(req);
    if (v.errors) return ack(fail(v.errors.join(' ')));
    const cfg = v.value;

    const room = new Room(
      io,
      {
        id: roomSeq++,
        name: cfg.name,
        visibility: cfg.visibility,
        passwordHash: cfg.password ? hashSecret(cfg.password) : null,
        totalSlots: cfg.totalSlots,
        humanSlots: cfg.humanSlots,
        difficulty: cfg.difficulty,
      },
      hooks,
    );
    rooms.set(room.id, room);
    const res = room.join({ id: userId, name, socket }, '', { owner: true });
    userRoom.set(userId, room.id);
    ack(res);
  });

  socket.on('room:join', (req = {}, ack = () => {}) => {
    const room = rooms.get(Number(req.roomId));
    if (!room) return ack(fail('That room no longer exists.'));
    if (userRoom.get(userId) !== room.id) leaveRoom(userId, socket);
    const res = room.join({ id: userId, name, socket }, req.password ?? '');
    if (res.ok) userRoom.set(userId, room.id);
    ack(res);
  });

  socket.on('room:leave', (_req, ack = () => {}) => {
    leaveRoom(userId, socket);
    ack({ ok: true });
  });

  socket.on('room:start', (_req, ack = () => {}) => ack(withRoom(userId, (room) => room.start(userId))));
  socket.on('room:reload', (_req, ack = () => {}) => ack(withRoom(userId, (room) => room.reload(userId))));

  socket.on('input', (msg) => {
    withRoom(userId, (room) => room.setInput(userId, msg));
  });

  socket.on('disconnect', () => {
    rooms.get(userRoom.get(userId))?.disconnect(userId, socket);
  });
});

http.listen(PORT, () => {
  console.log(`Queens Tech: Cloud 3Lit3S is running at http://localhost:${PORT}`);
});
