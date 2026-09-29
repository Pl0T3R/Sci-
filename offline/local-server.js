// Offline edition: the game "server" runs inside the page — no Node, no network.
// app.js talks to it exactly as it talks to the real server: LocalServer.api() for the
// REST calls and a fake socket.io client (window.io) for the table. It reuses the real
// table engine, bots and storage code from src/.
window.LocalServer = (() => {
  'use strict';
  const db = __require('db');
  const { Table, RIGS } = __require('table');
  const { Bots } = __require('sandbox');

  const PASSWORD = 'offline-player'; // profiles are just names in this browser
  const BOTS_PER_TABLE = 3;
  const EMOTES = ['😂', '😭', '😡', '😎', '🤔', '👏', '🔥', '💀', '😱', '🤑', '👍', '🙏', '🤡', '😴', '🥳', '🤯'];
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const httpError = (status, message) => Object.assign(new Error(message), { status });

  db.load(); // synchronous: the "file" is localStorage

  // The real server serves photo avatars from a URL; offline we inline the image itself.
  const fixAvatar = (av, username) => (av && av.img ? { ...av, img: db.avatarImage(username) || '' } : av);
  const publicUser = (u) => ({ ...db.publicUser(u), avatar: fixAvatar(db.avatarOf(u.username), u.username) });

  // ---------- tables ----------
  const rooms = new Map();
  const sockets = new Set();

  function toRoom(room, ev, data) {
    for (const s of sockets) if (s.room === room) s._deliver(ev, data);
  }

  function broadcast(room) {
    for (const s of sockets) {
      if (s.room !== room) continue;
      const st = room.table.stateFor(s.username);
      for (const seat of st.seats) if (seat) seat.avatar = fixAvatar(db.avatarOf(seat.username), seat.username);
      st.spectators = [];
      st.serverTime = Date.now();
      s._deliver('state', st);
    }
  }

  function sendWallet(username) {
    const u = db.getUser(username);
    if (!u) return;
    for (const s of sockets) if (s.username === username) s._deliver('wallet', publicUser(u));
  }

  const seatedRoom = (name) => [...rooms.values()].find((r) => r.table.seatOf(name) !== -1) || null;

  function createRoom(bigBlind) {
    let code;
    do code = Math.random().toString(36).slice(2, 7).toUpperCase();
    while (rooms.has(code));
    const room = { code, chat: [], log: [], lastHand: 0 };
    room.table = new Table(code, { smallBlind: Math.floor(bigBlind / 2), bigBlind }, {
      onChange: () => {
        broadcast(room);
        room.bots.onChange();
        botBanter(room);
      },
      onLog: (msg) => {
        room.log.push(msg);
        if (room.log.length > 60) room.log.shift();
        toRoom(room, 'log', msg);
      },
      syncStack: (name, stack) => {
        const u = db.getUser(name);
        if (u) db.setInPlay(u, stack);
      },
      cashOut: (name, amount) => {
        const u = db.getUser(name);
        if (!u) return;
        db.cashOut(u, amount);
        sendWallet(name);
      },
    });
    room.bots = new Bots(room, db, (name) => !seatedRoom(name));
    rooms.set(code, room);
    return room;
  }

  // Bots react to showdowns with an emote now and then.
  function botBanter(room) {
    const t = room.table;
    if (t.phase !== 'showdown' || !t.lastResult || room.lastHand === t.handNumber) return;
    room.lastHand = t.handNumber;
    const winners = new Set(t.lastResult.winners.map((w) => w.username));
    const shown = t.lastResult.hands.length > 0;
    for (const name of room.bots.names) {
      const i = t.seatOf(name);
      if (i === -1 || !t.seats[i].inHand) continue;
      const won = winners.has(name);
      if (!won && (!shown || t.seats[i].folded)) continue;
      if (Math.random() > (won ? 0.45 : 0.35)) continue;
      const list = won ? ['😎', '🤑', '🥳', '😂', '🔥'] : ['😭', '😡', '🤯', '💀', '😱'];
      const emoji = list[Math.floor(Math.random() * list.length)];
      setTimeout(() => toRoom(room, 'emote', { username: name, emoji }), 900 + Math.random() * 1500);
    }
  }

  function enter(s, room) {
    leave(s);
    s.room = room;
    s._deliver('history', { chat: room.chat, log: room.log });
    broadcast(room);
  }

  function leave(s) {
    const room = s.room;
    if (!room) return;
    s.room = null;
    const watched = [...sockets].some((o) => o.room === room);
    const humanSeated = room.table.seats.some((seat) => seat && !room.bots.isBot(seat.username));
    if (!watched && !humanSeated) {
      room.bots.removeAll();
      room.table.destroy();
      rooms.delete(room.code);
    } else broadcast(room);
  }

  // Socket events, mirroring server.js.
  function handle(s, ev, d = {}) {
    const name = s.username;
    const room = s.room;
    const needRoom = () => {
      if (!room) throw new Error('Join a table first');
      return room.table;
    };
    switch (ev) {
      case 'create-room': {
        const bb = Math.floor(Number(d.bigBlind)) || 20;
        if (bb < 2 || bb > 10000) throw new Error('Big blind must be between 2 and 10000');
        const r = createRoom(bb);
        enter(s, r);
        for (let i = 0; i < BOTS_PER_TABLE; i++) r.bots.add();
        return { ok: true, code: r.code };
      }
      case 'join-room': {
        const r = rooms.get(String(d.code || '').toUpperCase());
        if (!r) throw new Error('That table is gone. Start a new one!');
        enter(s, r);
        return { ok: true, code: r.code };
      }
      case 'leave-room':
        if (room && room.table.seatOf(name) !== -1) room.table.stand(name);
        leave(s);
        return { ok: true };
      case 'sit': {
        const table = needRoom();
        const other = seatedRoom(name);
        if (other) throw new Error('You are already seated');
        const buyIn = Math.floor(Number(d.buyIn));
        if (!(buyIn >= table.bigBlind)) throw new Error(`Buy-in must be at least ${table.bigBlind}`);
        const u = db.getUser(name);
        db.buyIn(u, buyIn);
        try {
          table.sit(name, Number(d.seat), buyIn);
        } catch (e) {
          db.cashOut(u, buyIn);
          throw e;
        }
        sendWallet(name);
        return { ok: true };
      }
      case 'stand':
        if (room) room.table.stand(name);
        return { ok: true };
      case 'add-chips': {
        const table = needRoom();
        const i = table.seatOf(name);
        if (i === -1) throw new Error('You are not seated');
        const seat = table.seats[i];
        if (table.inProgress && seat.inHand && !seat.folded) throw new Error('You can add chips between hands');
        const amount = Math.floor(Number(d.amount));
        db.buyIn(db.getUser(name), amount);
        table.addChips(name, amount);
        sendWallet(name);
        return { ok: true };
      }
      case 'sit-out':
        if (room) room.table.setSittingOut(name, !!d.value);
        return { ok: true };
      case 'action':
        needRoom().act(name, d.type, d.amount);
        return { ok: true };
      case 'chat': {
        const text = String(d || '').trim().slice(0, 200);
        if (!room || !text) return null;
        const msg = { username: name, text, time: Date.now() };
        room.chat.push(msg);
        if (room.chat.length > 50) room.chat.shift();
        toRoom(room, 'chat', msg);
        return null;
      }
      case 'emote':
        if (room && EMOTES.includes(d)) toRoom(room, 'emote', { username: name, emoji: d });
        return null;
      case 'sandbox-add-bot':
        needRoom();
        return { ok: true, name: room.bots.add() };
      case 'sandbox-remove-bots':
        if (room) room.bots.removeAll();
        return { ok: true };
      case 'sandbox-rig':
        return { ok: true, name: needRoom().rigNextHand(name, d.rank ? Number(d.rank) : null) };
      default:
        throw new Error('Not available offline');
    }
  }

  // A stand-in for the socket.io client.
  class FakeSocket {
    constructor(token) {
      this.auth = { token };
      this.handlers = {};
      this.connected = false;
      this.room = null;
      this.username = null;
      sockets.add(this);
      setTimeout(() => this._connect(), 0);
    }

    on(ev, fn) {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    }

    _deliver(ev, data, raw = false) {
      if (!sockets.has(this)) return;
      const payload = raw ? data : clone(data);
      for (const fn of this.handlers[ev] || []) {
        try {
          fn(payload);
        } catch (e) {
          console.error(e);
        }
      }
    }

    _connect() {
      const u = db.userFromToken(this.auth && this.auth.token);
      if (!u) return this._deliver('connect_error', new Error('unauthorized'), true);
      this.username = u.username;
      this.connected = true;
      this._deliver('connect');
      const seated = seatedRoom(u.username);
      if (seated) this._deliver('seated-in', seated.code);
    }

    emit(ev, data, cb) {
      setTimeout(() => {
        if (!this.connected) return;
        let res;
        try {
          res = handle(this, ev, data);
        } catch (e) {
          res = { error: e.message };
        }
        if (typeof cb === 'function') cb(clone(res || { ok: true }));
      }, 0);
    }

    disconnect() {
      this.connected = false;
      leave(this);
      sockets.delete(this);
    }
  }

  window.io = (opts) => new FakeSocket(opts && opts.auth && opts.auth.token);

  // ---------- REST endpoints, mirroring server.js ----------
  function refreshRoomsOf(username) {
    for (const room of rooms.values()) if (room.table.seatOf(username) !== -1 || [...sockets].some((s) => s.room === room)) broadcast(room);
  }

  function route(path, b, token) {
    if (path === '/api/config') {
      return {
        avatarEmojis: db.AVATAR_EMOJIS, avatarColors: db.AVATAR_COLORS, emotes: EMOTES,
        offline: true, sandbox: true, persistent: window.__persistent, testAccounts: [],
        rigs: Object.entries(RIGS).map(([rank, r]) => ({ rank: Number(rank), name: r.name })),
      };
    }
    if (path === '/api/register' || path === '/api/login') {
      // name-only profiles: typing an existing name logs you back in
      const name = String(b.username || '').trim();
      if (/^Bot_/i.test(name)) throw httpError(400, 'That name belongs to a bot');
      const tok = db.getUser(name) ? db.login(name, PASSWORD) : db.register(name, PASSWORD).token;
      return { token: tok, user: publicUser(db.userFromToken(tok)) };
    }
    if (path === '/api/logout') {
      db.logout(token);
      return { ok: true };
    }
    if (path === '/api/leaderboard') {
      return { leaders: db.leaderboard().map((l) => ({ ...l, avatar: fixAvatar(l.avatar, l.username) })) };
    }
    const u = db.userFromToken(token);
    if (!u) throw httpError(401, 'Not logged in');
    switch (path) {
      case '/api/me':
        return { user: publicUser(u) };
      case '/api/refill':
        db.refill(u);
        sendWallet(u.username);
        return { user: publicUser(u) };
      case '/api/daily': {
        const amount = db.claimDaily(u);
        sendWallet(u.username);
        return { amount, user: publicUser(u) };
      }
      case '/api/miners':
        return { ...db.minerInfo(u), serverTime: Date.now() };
      case '/api/miners/buy':
        db.buyMiner(u, b.id);
        sendWallet(u.username);
        return { ...db.minerInfo(u), serverTime: Date.now(), user: publicUser(u) };
      case '/api/miners/collect': {
        const amount = db.collectMiners(u);
        sendWallet(u.username);
        return { amount, ...db.minerInfo(u), serverTime: Date.now(), user: publicUser(u) };
      }
      case '/api/avatar':
        db.setAvatar(u, b);
        refreshRoomsOf(u.username);
        return { user: publicUser(u) };
      case '/api/sandbox/time-warp':
        db.settleMiners(u);
        u.minerTick -= 12 * 3600 * 1000;
        u.lastDaily = 0;
        u.lastRefill = 0;
        db.saveNow();
        return { user: publicUser(u) };
      case '/api/sandbox/chips':
        u.chips += 10000;
        db.saveNow();
        sendWallet(u.username);
        return { user: publicUser(u) };
      default:
        throw httpError(404, 'Not available offline');
    }
  }

  function api(path, body, token) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(clone(route(String(path).split('?')[0], body || {}, token)));
        } catch (e) {
          if (!e.status) e.status = 400;
          reject(e);
        }
      }, 0);
    });
  }

  return { api };
})();
