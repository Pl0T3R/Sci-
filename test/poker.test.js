const test = require('node:test');
const assert = require('node:assert');
const { bestHand, compareScores } = require('../src/hand');
const { Table } = require('../src/table');

const best = (s) => bestHand(s.split(' '));
const cmp = (a, b) => Math.sign(compareScores(best(a).score, best(b).score));

test('hand names', () => {
  assert.equal(best('As Ks Qs Js Ts 2d 3c').name, 'Royal Flush');
  assert.equal(best('9h 8h 7h 6h 5h Ad Ac').name, 'Straight Flush');
  assert.equal(best('9h 9d 9s 9c 5h Ad Ac').name, 'Four of a Kind');
  assert.equal(best('9h 9d 9s Ac 5h Ad 2c').name, 'Full House');
  assert.equal(best('2h 7h 9h Jh Kh Ad Ac').name, 'Flush');
  assert.equal(best('Ah 2d 3s 4c 5h Kd Qc').name, 'Straight');
  assert.equal(best('9h 9d 9s Ac 5h Kd 2c').name, 'Three of a Kind');
  assert.equal(best('9h 9d 5s 5c Ah Kd 2c').name, 'Two Pair');
  assert.equal(best('9h 9d 5s 4c Ah Kd 2c').name, 'Pair');
  assert.equal(best('9h 8d 5s 4c Ah Kd 2c').name, 'High Card');
});

test('hand comparisons', () => {
  assert.equal(cmp('Ah 2d 3s 4c 5h', '2h 3d 4s 5c 6h'), -1); // wheel < six-high straight
  assert.equal(cmp('Ah Ad Ks Kc 2h', 'Ah Ad Qs Qc Jh'), 1);
  assert.equal(cmp('Ah Ad Ks Kc 2h', 'Ah Ad Ks Kc 3h'), -1); // kicker
  assert.equal(cmp('Ah Kd Qs Jc 9h', 'Ac Kh Qd Js 9s'), 0);
  assert.equal(cmp('2h 2d 2s 3c 3h', 'Ah Ad Ks Kc Qh'), 1);
});

function makeTable(players, { sb = 5, bb = 10 } = {}) {
  const cashed = {};
  const t = new Table('TEST', { smallBlind: sb, bigBlind: bb }, {
    cashOut: (u, amt) => (cashed[u] = (cashed[u] || 0) + amt),
  });
  players.forEach(([name, stack], i) => t.sit(name, i, stack));
  clearTimeout(t.nextHandTimer);
  t.nextHandTimer = null;
  return { t, cashed };
}

function chipsInPlay(t) {
  return t.seats.reduce((sum, s) => sum + (s ? s.stack + s.totalBet : 0), 0);
}

test('heads-up: dealer posts small blind and acts first preflop', () => {
  const { t } = makeTable([['a', 100], ['b', 100]]);
  t.startHand();
  assert.equal(t.sbSeat, t.dealer);
  assert.equal(t.toAct, t.dealer);
  const first = t.seats[t.toAct].username;
  t.act(first, 'fold');
  assert.equal(t.phase, 'showdown');
  const other = first === 'a' ? 'b' : 'a';
  assert.equal(t.seats[t.seatOf(other)].stack, 105);
  assert.equal(t.seats[t.seatOf(first)].stack, 95);
  t.destroy();
});

test('full hand checked down conserves chips', () => {
  const { t } = makeTable([['a', 200], ['b', 200], ['c', 200]]);
  t.startHand();
  let guard = 0;
  while (t.inProgress && guard++ < 50) {
    const p = t.seats[t.toAct];
    t.act(p.username, p.bet < t.currentBet ? 'call' : 'check');
  }
  assert.equal(t.phase, 'showdown');
  assert.equal(t.board.length, 5);
  assert.equal(t.seats.reduce((s, p) => s + (p ? p.stack : 0), 0), 600);
  t.destroy();
});

test('big blind gets the option to raise preflop', () => {
  const { t } = makeTable([['a', 200], ['b', 200], ['c', 200]]);
  t.startHand();
  // everyone limps
  t.act(t.seats[t.toAct].username, 'call');
  t.act(t.seats[t.toAct].username, 'call');
  assert.equal(t.phase, 'preflop');
  assert.equal(t.toAct, t.bbSeat);
  t.act(t.seats[t.toAct].username, 'raise', 40);
  assert.equal(t.phase, 'preflop');
  assert.equal(t.currentBet, 40);
  t.destroy();
});

test('min raise is enforced', () => {
  const { t } = makeTable([['a', 200], ['b', 200], ['c', 200]]);
  t.startHand();
  assert.throws(() => t.act(t.seats[t.toAct].username, 'raise', 15), /Minimum raise/);
  t.act(t.seats[t.toAct].username, 'raise', 30); // raise by 20
  assert.throws(() => t.act(t.seats[t.toAct].username, 'raise', 45), /Minimum raise is to 50/);
  t.destroy();
});

test('side pots: short stack can only win what it matched', () => {
  const { t } = makeTable([['short', 50], ['big1', 500], ['big2', 500]]);
  t.startHand();
  // force a known board / hole cards so "short" wins the main pot and big1 the side pot
  const s = (n) => t.seats[t.seatOf(n)];
  s('short').hole = ['As', 'Ad'];
  s('big1').hole = ['Ks', 'Kd'];
  s('big2').hole = ['7c', '2d'];
  t.deck = ['3h', '9c', '8d', '4s', '5c', 'Jh', '2h', '6s', 'Qc', 'Td'].reverse(); // no straights/flushes
  const total = chipsInPlay(t);

  let guard = 0;
  while (t.inProgress && t.toAct !== -1 && guard++ < 50) {
    const p = t.seats[t.toAct];
    if (t.phase === 'preflop') t.act(p.username, 'allin');
    else t.act(p.username, p.bet < t.currentBet ? 'call' : 'check');
  }
  // all-in runout uses timers; drain them
  while (t.runoutTimer) {
    clearTimeout(t.runoutTimer);
    t.runoutTimer = null;
    t.endBettingRound();
  }
  assert.equal(t.phase, 'showdown');
  assert.equal(s('short').stack, 150); // 50 x 3
  assert.equal(s('big1').stack, 900); // side pot 450 x 2
  assert.equal(s('big2').stack, 0);
  assert.equal(s('short').stack + s('big1').stack + s('big2').stack, total);
  t.destroy();
});

test('standing up mid-hand folds and cashes out the remaining stack', () => {
  const { t, cashed } = makeTable([['a', 100], ['b', 100], ['c', 100]]);
  t.startHand();
  const bb = t.seats[t.bbSeat].username;
  t.stand(bb);
  assert.equal(cashed[bb], 90);
  assert.ok(t.inProgress);
  // hand continues with the other two; bb seat is freed once it ends
  let guard = 0;
  while (t.inProgress && guard++ < 50) t.act(t.seats[t.toAct].username, 'fold');
  assert.equal(t.seatOf(bb), -1);
  assert.equal(t.seats.reduce((s, p) => s + (p ? p.stack : 0), 0), 210);
  t.destroy();
});

test('timeout auto-folds and sits the player out', async () => {
  const { t } = makeTable([['a', 100], ['b', 100]]);
  t.startHand();
  const p = t.seats[t.toAct];
  clearTimeout(t.turnTimer);
  t.turnDeadline = 0;
  // simulate the timer firing
  p.connected = false;
  t.startTurnTimer();
  await new Promise((r) => setTimeout(r, 8100));
  assert.equal(p.folded, true);
  assert.equal(p.sittingOut, true);
  t.destroy();
});
