// Real-Time Communication App server
// Express + Socket.io: auth (JWT + bcrypt), WebRTC signaling, room state for whiteboard/chat/file relay.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-' + Math.random().toString(36).slice(2);
const USERS_FILE = path.join(__dirname, 'users.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 }); // 5MB chunks for file relay fallback

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- tiny JSON-file user store (demo-grade) ---
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'username >=3 chars, password >=6 chars' });
  }
  const users = loadUsers();
  if (users[username]) return res.status(409).json({ error: 'username taken' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { hash, createdAt: Date.now() };
  saveUsers(users);
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const users = loadUsers();
  const u = users[username];
  if (!u) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, u.hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, username });
});

// --- socket.io: JWT-authenticated, room-scoped signaling + state ---
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('no token'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.data.username = payload.username;
    next();
  } catch {
    next(new Error('bad token'));
  }
});

// Per-room whiteboard history so latecomers see existing strokes.
const roomState = new Map(); // room -> { strokes: [] }
function getRoom(name) {
  if (!roomState.has(name)) roomState.set(name, { strokes: [] });
  return roomState.get(name);
}

io.on('connection', (socket) => {
  const username = socket.data.username;

  socket.on('join-room', ({ room }) => {
    if (!room || typeof room !== 'string') return;
    socket.data.room = room;
    socket.join(room);
    const state = getRoom(room);

    // Tell the joiner who is already here (so the joiner initiates offers).
    const others = [];
    for (const id of io.sockets.adapter.rooms.get(room) || []) {
      if (id === socket.id) continue;
      const s = io.sockets.sockets.get(id);
      if (s) others.push({ id, username: s.data.username });
    }
    socket.emit('room-peers', { peers: others, strokes: state.strokes });

    // Announce the joiner to existing peers.
    socket.to(room).emit('peer-joined', { id: socket.id, username });
  });

  // WebRTC signaling relays
  socket.on('signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('signal', { from: socket.id, username, data });
  });

  // Encrypted chat (server only relays opaque ciphertext blobs)
  socket.on('chat', (msg) => {
    const room = socket.data.room;
    if (!room) return;
    socket.to(room).emit('chat', { from: socket.id, username, ...msg });
  });

  // Whiteboard strokes
  socket.on('stroke', (stroke) => {
    const room = socket.data.room;
    if (!room) return;
    const state = getRoom(room);
    state.strokes.push(stroke);
    if (state.strokes.length > 5000) state.strokes.splice(0, state.strokes.length - 5000);
    socket.to(room).emit('stroke', stroke);
  });

  socket.on('clear-board', () => {
    const room = socket.data.room;
    if (!room) return;
    getRoom(room).strokes = [];
    io.to(room).emit('clear-board');
  });

  // File transfer fallback over socket (WebRTC data channel is primary).
  socket.on('file-chunk', ({ to, ...rest }) => {
    if (to) io.to(to).emit('file-chunk', { from: socket.id, username, ...rest });
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) socket.to(room).emit('peer-left', { id: socket.id, username });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RTC app running on port ${PORT}`);
});
