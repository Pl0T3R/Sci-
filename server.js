const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

// Sandbox mode (npm run sandbox): a local test setup with its own data folder. It never
// touches a real database, so this has to happen before the storage layer is loaded.
const SANDBOX = process.argv.includes('--sandbox') || process.env.SANDBOX === '1';
if (SANDBOX) {
  delete process.env.DATABASE_URL;
  process.env.DATA_DIR = process.env.SANDBOX_DATA_DIR || path.join(__dirname, 'sandbox-data');
}

const db = require('./src/db');
const { Table, RIGS } = require('./src/table');
const sandbox = SANDBOX ? require('./src/sandbox') : null;

const PORT = process.env.PORT || 3000;
const DISCONNECT_GRACE_MS = 2 * 60 * 1000; // stand up players who are gone this long
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMOTES = ['😂', '😭', '😡', '😎', '🤔', '👏', '🔥', '💀', '😱', '🤑', '👍', '🙏', '🤡', '😴', '🥳', '🤯'];
const EMOTE_COOLDOWN_MS = 1200;

const app = express();
// Behind a hosting proxy (Render, Railway, Fly…) the real client IP is in X-Forwarded-For;
// without this every player would share one login rate-limit bucket.
if (process.env.TRUST_PROXY || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME) {
  app.set('trust proxy', 1);
}
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.json({ limit: '100kb' })); // room for a small avatar photo
app.use(express.static(path.join(__dirname, 'public')));

// ---------- simple rate limit for login / register / reset ----------
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, reset: now + 60000 };
  if (now > a.reset) Object.assign(a, { count: 0, reset: now + 60000 });
  a.count++;
  attempts.set(ip, a);
  return a.count > 20;
}

function bearer(req) {
  return (req.get('authorization') || '').replace(/^Bearer /, '');
}

// Wraps a handler: sends { error } with status 400 on thrown errors.
function handle(fn, { auth = true, limited = false } = {}) {
  return (req, res) => {
    if (limited && rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
    const u = auth ? db.userFromToken(bearer(req)) : null;
    if (auth && !u) return res.status(401).json({ error: 'Not logged in' });
    try {
      res.json(fn(req.body || {}, u, req) || { ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };
}

const withUser = (token, extra = {}) => ({ token, user: db.publicUser(db.userFromToken(token)), ...extra });

app.post('/api/register', handle((b) => {
  const { token, recoveryCode } = db.register(b.username, b.password);
  return withUser(token, { recoveryCode });
}, { auth: false, limited: true }));

app.post('/api/login', handle((b) => withUser(db.login(b.username, b.password)), { auth: false, limited: true }));

app.post('/api/reset-password', handle((b) => {
  const { token, recoveryCode } = db.resetPassword(b.username, b.recoveryCode, b.newPassword);
  return withUser(token, { recoveryCode });
}, { auth: false, limited: true }));

app.post('/api/change-password', handle((b, u) => withUser(db.changePassword(u, b.oldPassword, b.newPassword)), { limited: true }));

app.post('/api/recovery-code', handle((b, u) => ({ recoveryCode: db.regenerateRecovery(u, b.password) }), { limited: true }));

app.post('/api/logout', (req, res) => {
  db.logout(bearer(req));
  res.json({ ok: true });
});

app.get('/api/me', handle((b, u) => ({ user: db.publicUser(u) })));

app.post('/api/refill', handle((b, u) => {
  db.refill(u);
  sendWallet(u.username);
  return { user: db.publicUser(u) };
}));

app.post('/api/daily', handle((b, u) => {
  const amount = db.claimDaily(u);
  sendWallet(u.username);
  return { amount, user: db.publicUser(u) };
}));

app.get('/api/miners', handle((b, u) => ({ ...db.minerInfo(u), serverTime: Date.now() })));

app.post('/api/miners/buy', handle((b, u) => {
  db.buyMiner(u, b.id);
  sendWallet(u.username);
  return { ...db.minerInfo(u), serverTime: Date.now(), user: db.publicUser(u) };
}));

app.post('/api/miners/collect', handle((b, u) => {
  const amount = db.collectMiners(u);
  sendWallet(u.username);
  return { amount, ...db.minerInfo(u), serverTime: Date.now(), user: db.publicUser(u) };
}));

app.post('/api/avatar', handle((b, u) => {
  db.setAvatar(u, b);
  refreshRoomsOf(u.username);
  return { user: db.publicUser(u) };
}));

app.get('/api/avatar/:username', (req, res) => {
  const img = db.avatarImage(req.params.username);
  if (!img) return res.status(404).end();
  const [, type, b64] = img.match(/^data:(image\/\w+);base64,(.+)$/);
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // URL carries a version
  res.send(Buffer.from(b64, 'base64'));
});

app.get('/api/leaderboard', (req, res) => res.json({ leaders: db.leaderboard() }));

app.get('/api/config', (req, res) => res.json({
  avatarEmojis: db.AVATAR_EMOJIS, avatarColors: db.AVATAR_COLORS, emotes: EMOTES,
  sandbox: SANDBOX,
  ...(SANDBOX && {
    testAccounts: sandbox.TEST_ACCOUNTS, testPassword: sandbox.TEST_PASSWORD,
    rigs: Object.entries(RIGS).map(([rank, r]) => ({ rank: Number(rank), name: r.name })),
  }),
}));

if (SANDBOX) {
  // Jump 12 hours ahead for this player: miners fill up and the daily reward resets.
  app.post('/api/sandbox/time-warp', handle((b, u) => {
    db.settleMiners(u);
    u.minerTick -= 12 * 3600 * 1000;
    u.lastDaily = 0;
    u.lastRefill = 0;
    db.saveNow();
    return { user: db.publicUser(u) };
  }));
  app.post('/api/sandbox/chips', handle((b, u) => {
    u.chips += 10000;
    db.saveNow();
    sendWallet(u.username);
    return { user: db.publicUser(u) };
  }));
}

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
    onChange: () => {
      broadcast(room);
      if (room.bots) room.bots.onChange();
    },
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
  if (SANDBOX) room.bots = new sandbox.Bots(room, db, (name) => !seatedRoom(name));
  rooms.set(code, room);
  return room;
}

function broadcast(room) {
  for (const [username, sockets] of room.members) {
    const state = room.table.stateFor(username);
    for (const seat of state.seats) if (seat) seat.avatar = db.avatarOf(seat.username);
    state.spectators = [...room.members.keys()].filter((n) => room.table.seatOf(n) === -1);
    state.serverTime = Date.now();
    for (const id of sockets) io.to(id).emit('state', state);
  }
}

// Re-send table state to rooms where this user is visible (e.g. after an avatar change).
function refreshRoomsOf(username) {
  for (const room of rooms.values()) {
    if (room.members.has(username) || room.table.seatOf(username) !== -1) broadcast(room);
  }
}

function sendWallet(username) {
  const u = db.getUser(username);
  if (u) io.to('user:' + u.username.toLowerCase()).emit('wallet', db.publicUser(u));
}

function maybeDeleteRoom(room) {
  if (room.members.size) return;
  const onlyBots = (s) => !s || (room.bots && room.bots.isBot(s.username));
  if (!room.table.seats.every(onlyBots)) return;
  if (room.bots) room.bots.removeAll(); // nobody left to play with them
  room.table.destroy();
  rooms.delete(room.code);
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

  let lastEmote = 0;
  socket.on('emote', (emoji) => {
    if (!room || !EMOTES.includes(emoji)) return;
    const now = Date.now();
    if (now - lastEmote < EMOTE_COOLDOWN_MS) return;
    lastEmote = now;
    io.to(room.code).emit('emote', { username, emoji });
  });

  if (SANDBOX) {
    socket.on('sandbox-add-bot', (_, cb) => {
      try {
        if (!room) throw new Error('Join a room first');
        ok(cb, { name: room.bots.add() });
      } catch (e) {
        fail(cb, e);
      }
    });
    socket.on('sandbox-remove-bots', (_, cb) => {
      if (room) room.bots.removeAll();
      ok(cb);
    });
    socket.on('sandbox-rig', (opts, cb) => {
      try {
        if (!room) throw new Error('Join a room first');
        const rank = opts && opts.rank ? Number(opts.rank) : null;
        ok(cb, { name: room.table.rigNextHand(username, rank) });
      } catch (e) {
        fail(cb, e);
      }
    });
  }

  socket.on('disconnect', leave);

  // if they refreshed or reopened the site while still seated, send them back to their table
  const seatedIn = seatedRoom(username);
  if (seatedIn) socket.emit('seated-in', seatedIn.code);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
  try {
    await db.close();
  } catch (e) {
    console.error('Final save failed:', e.message);
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {}
}

db.load().then(
  () => {
    if (SANDBOX) sandbox.seed(db);
    server.listen(PORT, () => {
      const url = `http://localhost:${PORT}`;
      console.log(`Poker server running on ${url} (storage: ${process.env.DATABASE_URL ? 'Postgres' : 'file'})`);
      if (SANDBOX) {
        console.log(`\n  🧪 SANDBOX MODE: test data lives in ${process.env.DATA_DIR}`);
        console.log(`     Test accounts: ${sandbox.TEST_ACCOUNTS.join(', ')} (password: ${sandbox.TEST_PASSWORD})`);
        console.log('     Each browser tab can log in as a different account. Ctrl+C to stop.\n');
      }
      if (process.argv.includes('--open')) openBrowser(url);
    });
  },
  (e) => {
    console.error('Could not load the database:', e.message);
    process.exit(1);
  },
);
