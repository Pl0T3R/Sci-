const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-test-'));

function startServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve(proc)));
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.on('exit', resolve);
    proc.kill('SIGTERM');
  });
}

async function post(p, body, token) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
}

async function me(token) {
  const res = await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
  return (await res.json()).user;
}

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  s.latest = null;
  s.on('state', (st) => (s.latest = st));
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

const call = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};

test('register, login, play in a shared room, chips persist', { timeout: 30000 }, async () => {
  let server = await startServer();
  try {
    const bad = await post('/api/register', { username: 'x', password: 'secret' });
    assert.equal(bad.status, 400);

    const alice = await post('/api/register', { username: 'Alice', password: 'secret1' });
    const bob = await post('/api/register', { username: 'Bob', password: 'secret2' });
    assert.equal(alice.user.chips, 1000);
    assert.equal((await post('/api/register', { username: 'alice', password: 'zzzz' })).status, 400);
    assert.equal((await post('/api/login', { username: 'Alice', password: 'wrong' })).status, 400);
    const aliceLogin = await post('/api/login', { username: 'alice', password: 'secret1' });
    assert.ok(aliceLogin.token);

    // unauthenticated sockets are rejected
    await assert.rejects(connect('nope'));

    const a = await connect(alice.token);
    const b = await connect(bob.token);

    const created = await call(a, 'create-room', { bigBlind: 20, code: 'friday' });
    assert.equal(created.code, 'FRIDAY');
    assert.ok((await call(b, 'join-room', { code: 'nope1' })).error);
    assert.equal((await call(b, 'join-room', { code: 'friday' })).code, 'FRIDAY');

    assert.ok((await call(a, 'sit', { seat: 0, buyIn: 5000 })).error); // more than wallet
    assert.ok((await call(a, 'sit', { seat: 0, buyIn: 400 })).ok);
    assert.ok((await call(b, 'sit', { seat: 0, buyIn: 400 })).error); // seat taken
    assert.ok((await call(b, 'sit', { seat: 3, buyIn: 400 })).ok);
    assert.equal((await me(alice.token)).chips, 600);

    // hand starts automatically; both see the same hand, but only their own cards
    await waitFor(() => a.latest && a.latest.phase === 'preflop' && b.latest && b.latest.phase === 'preflop');
    await waitFor(() => a.latest.handNumber === b.latest.handNumber && a.latest.toAct === b.latest.toAct);
    assert.notEqual(a.latest.seats[0].cards[0], '??');
    assert.equal(a.latest.seats[3].cards[0], '??');
    assert.equal(b.latest.seats[0].cards[0], '??');

    // whoever is first to act folds
    const actor = a.latest.toAct === 0 ? a : b;
    const wrong = actor === a ? b : a;
    assert.ok((await call(wrong, 'action', { type: 'fold' })).error);
    assert.ok((await call(actor, 'action', { type: 'fold' })).ok);
    await waitFor(() => a.latest.phase === 'showdown');
    const stacks = [a.latest.seats[0].stack, a.latest.seats[3].stack].sort();
    assert.deepEqual(stacks, [390, 410]); // heads-up: SB (10) folded to BB

    // chat reaches everyone in the room
    const got = new Promise((r) => b.once('chat', r));
    a.emit('chat', 'gg');
    assert.equal((await got).text, 'gg');

    // avatars appear in table state; emotes reach the room
    assert.ok(a.latest.seats[3].avatar.emoji);
    const emoteGot = new Promise((r) => b.once('emote', r));
    a.emit('emote', 'not-an-emote'); // ignored
    a.emit('emote', '😂');
    assert.deepEqual(await emoteGot, { username: 'Alice', emoji: '😂' });

    // changing an avatar updates everyone's table
    const avatarRes = await post('/api/avatar', { emoji: '🦊', color: '#3e63dd' }, alice.token);
    assert.equal(avatarRes.user.avatar.emoji, '🦊');
    await waitFor(() => b.latest.seats[0].avatar.emoji === '🦊');

    // stand up: chips go back to the wallet
    const aliceStack = a.latest.seats[0].stack;
    await call(a, 'stand');
    assert.equal((await me(alice.token)).chips, 600 + aliceStack);

    a.close();
    b.close();

    // Bob is still seated when the server restarts — his stack must be returned
    await stopServer(server);
    server = await startServer();
    const bobAfter = await me(bob.token);
    assert.equal(bobAfter.chips + bobAfter.inPlay, 1000 + (400 - aliceStack) + 0);
    const aliceAfter = await me(alice.token);
    assert.equal(aliceAfter.chips, 600 + aliceStack);

    // daily reward + miners over HTTP
    const daily = await post('/api/daily', {}, alice.token);
    assert.equal(daily.amount, 250);
    assert.equal((await post('/api/daily', {}, alice.token)).status, 400);
    const bought = await post('/api/miners/buy', { id: 'usb' }, alice.token);
    assert.equal(bought.ratePerHour, 5);
    assert.equal(bought.user.chips, 600 + aliceStack + 250 - 500);
    assert.equal((await post('/api/miners/buy', { id: 'usb' }, 'bad-token')).status, 401);

    // password reset with the recovery code handed out at registration
    assert.ok(alice.recoveryCode);
    const reset = await post('/api/reset-password', { username: 'Alice', recoveryCode: alice.recoveryCode, newPassword: 'brandnew' });
    assert.ok(reset.token && reset.recoveryCode);
    assert.equal((await post('/api/login', { username: 'Alice', password: 'secret1' })).status, 400);
    assert.equal((await post('/api/login', { username: 'Alice', password: 'brandnew' })).status, 200);
  } finally {
    await stopServer(server);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
});
