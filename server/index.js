import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { Room } from './room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3000;

// Four permanent rooms. Each has its own arena look and crate density.
const ROOM_DEFS = [
  { id: 0, name: 'Room 1', theme: 'Graveyard Gate', seed: 1313, crateChance: 0.22 },
  { id: 1, name: 'Room 2', theme: 'Haunted Gym', seed: 2024, crateChance: 0.3 },
  { id: 2, name: 'Room 3', theme: 'Pumpkin Patch', seed: 3141, crateChance: 0.36 },
  { id: 3, name: 'Room 4', theme: 'Witch Lab', seed: 666, crateChance: 0.18 },
];

const FALLBACK_NAME = 'Trick-or-Treater';

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/vendor/phaser', express.static(path.join(ROOT, 'node_modules/phaser/dist')));

const http = createServer(app);
const io = new Server(http);
const rooms = ROOM_DEFS.map((def) => new Room(io, def));

const listRooms = () => rooms.map((r) => r.summary());
setInterval(() => io.emit('rooms', listRooms()), 1000);

const cleanName = (raw) =>
  String(raw ?? '')
    .replace(/[<>&"']/g, '')
    .trim()
    .slice(0, 12) || FALLBACK_NAME;

function leaveCurrent(socket) {
  rooms.find((r) => r.id === socket.data.roomId)?.leave(socket);
  socket.data.roomId = null;
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.emit('rooms', listRooms());

  socket.on('join', (req = {}, ack = () => {}) => {
    const room = rooms.find((r) => r.id === Number(req.roomId));
    if (!room) return ack({ ok: false, error: 'That room does not exist.' });
    leaveCurrent(socket);
    const res = room.join(socket, cleanName(req.name));
    if (res.ok) socket.data.roomId = room.id;
    ack(res);
  });

  socket.on('input', (msg) => {
    rooms.find((r) => r.id === socket.data.roomId)?.setInput(socket.id, msg);
  });

  socket.on('leave', () => leaveCurrent(socket));
  socket.on('disconnect', () => leaveCurrent(socket));
});

http.listen(PORT, () => {
  console.log(`Queens Tech: Cloud 3Lit3S is running at http://localhost:${PORT}`);
});
