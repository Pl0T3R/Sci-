const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-db-'));
process.env.DATA_DIR = DATA_DIR;
const db = require('../src/db');
db.load();
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const HOUR = 3600 * 1000;

test('password reset with recovery code', () => {
  const { token, recoveryCode } = db.register('Resetter', 'oldpass');
  assert.match(recoveryCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.throws(() => db.resetPassword('Resetter', 'AAAA-BBBB-CCCC', 'newpass'), /Wrong username or recovery code/);

  // codes are case/format-insensitive
  const res = db.resetPassword('resetter', recoveryCode.toLowerCase().replace(/-/g, ' '), 'newpass');
  assert.ok(res.token);
  assert.notEqual(res.recoveryCode, recoveryCode);
  assert.equal(db.userFromToken(token), null, 'old sessions are logged out');
  assert.throws(() => db.login('Resetter', 'oldpass'));
  assert.ok(db.login('Resetter', 'newpass'));
  // a recovery code only works once
  assert.throws(() => db.resetPassword('Resetter', recoveryCode, 'again'));
  assert.ok(db.resetPassword('Resetter', res.recoveryCode, 'again').token);
});

test('change password and regenerate recovery code', () => {
  const { token } = db.register('Changer', 'first');
  const u = db.userFromToken(token);
  assert.throws(() => db.changePassword(u, 'wrong', 'second'), /Current password/);
  const t2 = db.changePassword(u, 'first', 'second');
  assert.equal(db.userFromToken(token), null);
  assert.equal(db.userFromToken(t2).username, 'Changer');
  assert.throws(() => db.regenerateRecovery(u, 'first'), /Password is wrong/);
  const code = db.regenerateRecovery(u, 'second');
  assert.ok(db.resetPassword('Changer', code, 'third').token);
});

test('daily reward once per day', () => {
  const u = db.userFromToken(db.register('Daily', 'pass').token);
  assert.equal(db.publicUser(u).daily.canClaim, true);
  assert.equal(db.claimDaily(u), 250);
  assert.equal(u.chips, 1250);
  assert.throws(() => db.claimDaily(u), /already claimed/);
  u.lastDaily -= 24 * HOUR; // pretend it was yesterday
  assert.equal(db.claimDaily(u), 250);
  assert.equal(u.chips, 1500);
});

test('miners: buy, mine over time, vault cap, rising prices', () => {
  const u = db.userFromToken(db.register('Miner', 'pass').token);
  let info = db.minerInfo(u);
  assert.equal(info.ratePerHour, 0);
  const usb = info.miners.find((m) => m.id === 'usb');
  assert.equal(usb.price, 500);

  db.buyMiner(u, 'usb');
  assert.equal(u.chips, 500);
  info = db.minerInfo(u);
  assert.equal(info.ratePerHour, 5);
  assert.equal(info.miners.find((m) => m.id === 'usb').price, 580); // 500 * 1.15 rounded to 10
  assert.throws(() => db.buyMiner(u, 'rig'), /You need/);
  assert.throws(() => db.buyMiner(u, 'nope'), /Unknown miner/);
  assert.throws(() => db.collectMiners(u), /Nothing to collect/);

  // 10 hours pass
  u.minerTick -= 10 * HOUR;
  assert.equal(db.collectMiners(u), 50);
  assert.equal(u.chips, 550);

  // a week offline: the vault stops at 24 hours of output
  u.minerTick -= 7 * 24 * HOUR;
  assert.equal(db.collectMiners(u), 5 * 24);

  // buying settles what the old rate produced before the rate changes
  u.chips = 10000;
  u.minerTick -= 2 * HOUR;
  db.buyMiner(u, 'laptop');
  assert.equal(Math.round(u.minerPending), 10);
  u.minerTick -= HOUR;
  assert.equal(db.collectMiners(u), 10 + 5 + 28);

  // every miner takes at least ~2.5 days to pay for itself at list price
  for (const m of db.MINERS) assert.ok(m.cost / m.rate / 24 >= 2.5, `${m.id} pays back too fast`);
});

test('avatars: emoji choices and image validation', () => {
  const u = db.userFromToken(db.register('Pic', 'pass').token);
  assert.ok(db.avatarOf('Pic').emoji);
  assert.throws(() => db.setAvatar(u, { emoji: 'X', color: '#e5484d' }), /Pick one of the avatars/);
  db.setAvatar(u, { emoji: '🦊', color: '#3e63dd' });
  assert.deepEqual(db.avatarOf('pic'), { emoji: '🦊', color: '#3e63dd' });

  assert.throws(() => db.setAvatar(u, { image: 'data:text/html;base64,PGgxPg==' }), /Invalid image/);
  assert.throws(() => db.setAvatar(u, { image: 'data:image/png;base64,' + 'A'.repeat(70000) }), /too large/);
  db.setAvatar(u, { image: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.match(db.avatarOf('Pic').img, /^\/api\/avatar\/Pic\?v=\d+$/);
  assert.ok(db.avatarImage('pic'));
  db.setAvatar(u, { emoji: '🐼', color: '#3e63dd' });
  assert.equal(db.avatarImage('pic'), null);
});

test('old accounts get new fields filled in on load', () => {
  const file = path.join(DATA_DIR, 'db.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.users.legacy = { username: 'Legacy', salt: 'x', hash: 'y', chips: 42, inPlay: 8 };
  fs.writeFileSync(file, JSON.stringify(raw));
  db.load();
  const u = db.getUser('legacy');
  assert.equal(u.chips, 50); // in-play chips refunded
  assert.equal(u.recoveryHash, null);
  assert.ok(u.avatar.emoji);
  assert.deepEqual(u.miners, {});
  assert.equal(db.publicUser(u).hasRecovery, false);
});
