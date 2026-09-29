const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const db = require('./src/db');
const { Table } = require('./src/table');

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = 2 * 60 * 1000; // stand up players who are gone this long
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

db.load();

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- simple login rate limit ----------
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, reset: now + 60000 };
  if (now > a.reset) Object.assign(a, { count: 0, reset: now + 60000 });
  a.count++;
  attempts.set(ip, a);
  return a.count > 20;
}

function authUser(req) {
  const header = req.get('authorization') || '';
  return db.userFromToken(header.replace(/^Bearer /, ''));
}

app.post('/api/register', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  try {
    const token = db.register(req.body.username, req.body.password);
    res.json({ token, user: db.publicUser(db.userFromToken(token)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  try {
    const token = db.login(req.body.username, req.body.password);
    res.json({ token, user: db.publicUser(db.userFromToken(token)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  db.logout((req.get('authorization') || '').replace(/^Bearer /, ''));
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: db.publicUser(u) });
});

app.post('/api/refill', (req, res) => {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  try {
    db.refill(u);
    res.json({ user: db.publicUser(u) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/leaderboard', (req, res) => res.json({ leaders: db.leaderboard() }));

// ---------- rooms ----------
const server = http.createServer(app);
const io = new Server(server);

/** code -> { table, members: Map<username, Set<socketId>>, chat: [], log: [] } */
const rooms = new Map();
const goneTimers = new Map(); // `${code}:${username}` -> timeout

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function createRoom(code, smallBlind, bigBlind) {
  const room = { code, members: new Map(), chat: [], log: [] };
  room.table = new Table(code, { smallBlind, bigBlind }, {
    onChange: () => broadcast(room),
    onLog: (msg) => {
      room.log.push(msg);
      if (room.log.length > 60) room.log.shift();
      io.to(code).emit('log', msg);
    },
    syncStack: (username, stack) => {
      const u = db.getUser(username);
      if (u) db.setInPlay(u, stack);
    },
    cashOut: (username, amount) => {
      const u = db.getUser(username);
      if (!u) return;
      db.cashOut(u, amount);
      sendWallet(username);
    },
  });
  rooms.set(code, room);
  return room;
}

function broadcast(room) {
  for (const [username, sockets] of room.members) {
    const state = room.table.stateFor(username);
    state.spectators = [...room.members.keys()].filter((n) => room.table.seatOf(n) === -1);
    state.serverTime = Date.now();
    for (const id of sockets) io.to(id).emit('state', state);
  }
}

function sendWallet(username) {
  const u = db.getUser(username);
  if (u) io.to('user:' + u.username.toLowerCase()).emit('wallet', db.publicUser(u));
}

function maybeDeleteRoom(room) {
  if (room.members.size === 0 && room.table.seats.every((s) => !s)) {
    room.table.destroy();
    rooms.delete(room.code);
  }
}

// Which room a user is seated in (a user can only sit at one table at a time).
function seatedRoom(username) {
  for (const room of rooms.values()) if (room.table.seatOf(username) !== -1) return room;
  return null;
}

io.use((socket, next) => {
  const u = db.userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.data.username = u.username;
  next();
});

io.on('connection', (socket) => {
  const username = socket.data.username;
  const user = () => db.getUser(username);
  socket.join('user:' + username.toLowerCase());
  let room = null;

  const fail = (cb, e) => typeof cb === 'function' && cb({ error: e.message || String(e) });
  const ok = (cb, data = {}) => typeof cb === 'function' && cb({ ok: true, ...data });

  function enter(r) {
    leave();
    room = r;
    socket.join(r.code);
    if (!r.members.has(username)) r.members.set(username, new Set());
    r.members.get(username).add(socket.id);
    const key = `${r.code}:${username}`;
    if (goneTimers.has(key)) {
      clearTimeout(goneTimers.get(key));
      goneTimers.delete(key);
    }
    r.table.setConnected(username, true);
    socket.emit('history', { chat: r.chat, log: r.log });
    broadcast(r);
  }

  function leave() {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.code);
    const set = r.members.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        r.members.delete(username);
        if (r.table.seatOf(username) !== -1) {
          // keep their seat for a while in case they're just reloading
          r.table.setConnected(username, false);
          const key = `${r.code}:${username}`;
          goneTimers.set(key, setTimeout(() => {
            goneTimers.delete(key);
            if (!r.members.has(username)) r.table.stand(username);
            maybeDeleteRoom(r);
          }, DISCONNECT_GRACE_MS));
        }
      }
    }
    broadcast(r);
    maybeDeleteRoom(r);
  }

  socket.on('create-room', (opts, cb) => {
    try {
      const bb = Math.floor(Number(opts && opts.bigBlind)) || 20;
      if (bb < 2 || bb > 10000) throw new Error('Big blind must be between 2 and 10000');
      let code = normalizeCode(opts && opts.code);
      if (code) {
        if (code.length < 3) throw new Error('Room code must be at least 3 characters');
        if (rooms.has(code)) throw new Error('That room code is already in use');
      } else code = newCode();
      const r = createRoom(code, Math.floor(bb / 2), bb);
      enter(r);
      ok(cb, { code });
    } catch (e) {
      fail(cb, e);
    }
  });

  socket.on('join-room', (opts, cb) => {
    const r = rooms.get(normalizeCode(opts && opts.code));
    if (!r) return fail(cb, new Error('No room with that code. Check the code or create a new room.'));
    enter(r);
    ok(cb, { code: r.code });
  });

  socket.on('leave-room', (_, cb) => {
    if (room && room.table.seatOf(username) !== -1) room.table.stand(username);
    leave();
    ok(cb);
  });

  socket.on('sit', (opts, cb) => {
    try {
      if (!room) throw new Error('Join a room first');
      const other = seatedRoom(username);
      if (other) throw new Error(`You are already seated in room ${other.code}`);
      const buyIn = Math.floor(Number(opts && opts.buyIn));
      if (!(buyIn >= room.table.bigBlind)) throw new Error(`Buy-in must be at least ${room.table.bigBlind}`);
      const seat = Number(opts && opts.seat);
      if (room.table.seats[seat]) throw new Error('Seat is taken');
      db.buyIn(user(), buyIn);
      try {
        room.table.sit(username, seat, buyIn);
      } catch (e) {
        db.cashOut(user(), buyIn); // refund
        throw e;
      }
      sendWallet(username);
      ok(cb);
    } catch (e) {
      fail(cb, e);
    }
  });

  socket.on('stand', (_, cb) => {
    if (room) room.table.stand(username);
    ok(cb);
  });

  socket.on('add-chips', (opts, cb) => {
    try {
      if (!room) throw new Error('Join a room first');
      const amount = Math.floor(Number(opts && opts.amount));
      const i = room.table.seatOf(username);
      if (i === -1) throw new Error('You are not seated');
      const seat = room.table.seats[i];
      if (room.table.inProgress && seat.inHand && !seat.folded) throw new Error('You can add chips between hands');
      const u = user();
      db.buyIn(u, amount); // u.inPlay grows; table then syncs the exact stack
      room.table.addChips(username, amount);
      sendWallet(username);
      ok(cb);
    } catch (e) {
      fail(cb, e);
    }
  });

  socket.on('sit-out', (opts, cb) => {
    if (room) room.table.setSittingOut(username, !!(opts && opts.value));
    ok(cb);
  });

  socket.on('action', (opts, cb) => {
    try {
      if (!room) throw new Error('Join a room first');
      room.table.act(username, opts && opts.type, opts && opts.amount);
      ok(cb);
    } catch (e) {
      fail(cb, e);
    }
  });

  socket.on('chat', (text) => {
    if (!room || typeof text !== 'string') return;
    text = text.trim().slice(0, 200);
    if (!text) return;
    const msg = { username, text, time: Date.now() };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(room.code).emit('chat', msg);
  });

  socket.on('disconnect', leave);

  // if they refreshed or reopened the site while still seated, send them back to their table
  const seatedIn = seatedRoom(username);
  if (seatedIn) socket.emit('seated-in', seatedIn.code);
});

function shutdown() {
  // put every stack back into its owner's wallet
  for (const room of rooms.values()) {
    for (const s of room.table.seats) {
      if (!s || s.left) continue;
      const u = db.getUser(s.username);
      if (u) {
        u.chips += s.stack + (room.table.inProgress && s.inHand ? s.totalBet : 0);
        u.inPlay = 0;
      }
    }
  }
  db.saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => console.log(`Poker server running on http://localhost:${PORT}`));
