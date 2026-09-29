const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { Table, RIGS } = require('../src/table');

test('rigged hands deal the chosen hand and win the showdown', () => {
  for (const rank of Object.keys(RIGS).map(Number)) {
    const t = new Table('RIG', { smallBlind: 5, bigBlind: 10 });
    ['a', 'b', 'c'].forEach((name, i) => t.sit(name, i, 1000));
    clearTimeout(t.nextHandTimer);
    t.nextHandTimer = null;
    t.rigNextHand('b', rank);
    t.startHand();
    // every card is unique
    const all = [...t.seats.filter(Boolean).flatMap((s) => s.hole), ...t.deck, ...t.riggedBoard];
    assert.equal(new Set(all).size, all.length, 'duplicate card after rigging');
    let guard = 0;
    while (t.inProgress && t.toAct !== -1 && guard++ < 50) {
      const p = t.seats[t.toAct];
      t.act(p.username, p.bet < t.currentBet ? 'call' : 'check');
    }
    const winner = t.lastResult.winners[0];
    assert.equal(winner.username, 'b');
    assert.equal(winner.rank, rank, `expected ${RIGS[rank].name}, got ${winner.hand}`);
    assert.equal(t.rig, null, 'a rig only applies to one hand');
    t.destroy();
  }
});

const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;

test('sandbox server: test accounts, bots and rigging; never touches DATABASE_URL', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-sandbox-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--sandbox'], {
    // a bogus database URL: sandbox mode must ignore it and use its own folder
    env: { ...process.env, PORT, SANDBOX_DATA_DIR: dir, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/nope' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve()));
  try {
    const config = await (await fetch(BASE + '/api/config')).json();
    assert.equal(config.sandbox, true);
    assert.deepEqual(config.testAccounts, ['test1', 'test2', 'test3']);
    assert.ok(fs.existsSync(path.join(dir, 'db.json')), 'sandbox data goes to its own folder');

    const login = await (await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test1', password: 'test' }),
    })).json();
    assert.equal(login.user.chips, 100000);
    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };

    const warped = await (await fetch(BASE + '/api/sandbox/time-warp', { method: 'POST', headers: auth, body: '{}' })).json();
    assert.equal(warped.user.daily.canClaim, true);

    const s = io(BASE, { auth: { token: login.token }, transports: ['websocket'] });
    await new Promise((r) => s.on('connect', r));
    const call = (ev, data) => new Promise((r) => s.emit(ev, data, r));
    let state = null;
    s.on('state', (st) => (state = st));

    await call('create-room', { bigBlind: 20, code: 'SANDBOX' });
    assert.ok((await call('sit', { seat: 0, buyIn: 2000 })).ok);
    assert.ok((await call('sandbox-rig', { rank: 9 })).name, 'Royal Flush');
    assert.match((await call('sandbox-add-bot')).name, /^Bot_/);
    assert.match((await call('sandbox-add-bot')).name, /^Bot_/);

    // play: we just check/call; the bots act on their own
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      if (state && state.phase === 'showdown' && state.lastResult && state.lastResult.winners[0].rank === 9) break;
      if (state && state.you && state.you.myTurn) {
        await call('action', { type: state.you.toCall ? 'call' : 'check' });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(state.lastResult.winners[0].username, 'test1');
    assert.equal(state.lastResult.winners[0].hand, 'Royal Flush');

    await call('sandbox-remove-bots');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(state.seats.filter(Boolean).length, 1, 'bots left the table');
    s.close();
  } finally {
    await new Promise((resolve) => {
      proc.on('exit', resolve);
      proc.kill('SIGTERM');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal mode has no sandbox tools', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-normal-'));
  const port = PORT + 20;
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve()));
  try {
    const config = await (await fetch(`http://localhost:${port}/api/config`)).json();
    assert.equal(config.sandbox, false);
    assert.equal(config.testAccounts, undefined);
    const warp = await fetch(`http://localhost:${port}/api/sandbox/time-warp`, { method: 'POST' });
    assert.equal(warp.status, 404);
    const login = await fetch(`http://localhost:${port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test1', password: 'test' }),
    });
    assert.equal(login.status, 400, 'no test accounts outside the sandbox');
  } finally {
    await new Promise((resolve) => {
      proc.on('exit', resolve);
      proc.kill('SIGTERM');
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
