// Sandbox mode only (npm run sandbox): test accounts and bots that play by themselves,
// so one person can try the whole game locally.
const crypto = require('crypto');
const { bestHand } = require('./hand');

const TEST_ACCOUNTS = ['test1', 'test2', 'test3'];
const TEST_PASSWORD = 'test';
const TEST_CHIPS = 100000;
const BOT_NAMES = ['Bot_Rambo', 'Bot_Sarge', 'Bot_Maverick', 'Bot_Ghost', 'Bot_Viper', 'Bot_Iceman', 'Bot_Havoc', 'Bot_Nomad'];
const BOT_STACK = 5000;
const BOT_COLORS = ['#e5484d', '#f76b15', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];

// Create the test accounts, and top them up if they've run low.
function seed(db) {
  for (const name of TEST_ACCOUNTS) {
    if (!db.getUser(name)) db.register(name, TEST_PASSWORD);
    const u = db.getUser(name);
    if (u.chips < TEST_CHIPS / 10) u.chips = TEST_CHIPS;
  }
  db.saveNow();
}

function botAccount(db, name) {
  let u = db.getUser(name);
  if (!u) {
    db.register(name, crypto.randomBytes(16).toString('hex')); // nobody can log in as a bot
    u = db.getUser(name);
    db.setAvatar(u, { emoji: '🤖', color: BOT_COLORS[crypto.randomInt(BOT_COLORS.length)] });
  }
  if (u.chips < BOT_STACK * 2) u.chips = BOT_STACK * 20;
  return u;
}

const RANK_VALUE = '23456789TJQKA';

// 0..1, how good the bot thinks its hand is.
function strength(hole, board) {
  if (board.length >= 3) {
    const rank = bestHand([...hole, ...board]).rank;
    return [0.2, 0.5, 0.68, 0.78, 0.86, 0.9, 0.95, 0.98, 0.99, 1][rank];
  }
  const [a, b] = hole.map((c) => RANK_VALUE.indexOf(c[0]) + 2);
  if (a === b) return 0.55 + a / 40;
  return ((a + b) / 28) * 0.6 + (hole[0][1] === hole[1][1] ? 0.05 : 0);
}

class Bots {
  constructor(room, db, isNameFree) {
    this.room = room;
    this.db = db;
    this.isNameFree = isNameFree; // (name) => not seated at any table
    this.names = new Set();
    this.pending = null;
  }

  get table() {
    return this.room.table;
  }

  isBot(name) {
    return this.names.has(name);
  }

  add() {
    const table = this.table;
    const seat = table.seats.findIndex((s) => !s);
    if (seat === -1) throw new Error('The table is full');
    const name = BOT_NAMES.find((n) => !this.names.has(n) && this.isNameFree(n));
    if (!name) throw new Error('No more bots available');
    const u = botAccount(this.db, name);
    this.db.buyIn(u, BOT_STACK);
    table.sit(name, seat, BOT_STACK);
    this.names.add(name);
    return name;
  }

  removeAll() {
    for (const name of [...this.names]) {
      this.names.delete(name);
      this.table.stand(name);
    }
  }

  // Called whenever the table changes: rebuy busted bots and act when it's a bot's turn.
  onChange() {
    const table = this.table;
    if (!table.inProgress) {
      for (const name of this.names) {
        const i = table.seatOf(name);
        if (i !== -1 && table.seats[i].stack === 0) {
          const u = botAccount(this.db, name);
          this.db.buyIn(u, BOT_STACK);
          table.addChips(name, BOT_STACK);
        }
      }
      return;
    }
    const seat = table.seats[table.toAct];
    if (!seat || !this.names.has(seat.username)) return;
    const key = `${table.handNumber}:${table.toAct}:${table.phase}:${table.currentBet}`;
    if (this.pending === key) return;
    this.pending = key;
    setTimeout(() => {
      if (this.pending === key) this.pending = null;
      if (!table.inProgress || table.seats[table.toAct] !== seat) return;
      try {
        const { type, amount } = this.decide(seat);
        table.act(seat.username, type, amount);
      } catch {
        try {
          table.act(seat.username, table.currentBet > seat.bet ? 'call' : 'check');
        } catch {}
      }
    }, 600 + crypto.randomInt(700));
  }

  decide(s) {
    const table = this.table;
    const toCall = Math.max(0, table.currentBet - s.bet);
    // During a rigged hand the bots just go along, so the hand reaches the showdown.
    if (table.riggedHand === table.handNumber) return { type: toCall ? 'call' : 'check' };
    const st = strength(s.hole, table.board);
    const r = Math.random();
    const raiseTo = () => {
      const target = table.currentBet + Math.max(table.minRaise, Math.floor(table.potTotal() / 2));
      return { type: 'raise', amount: Math.min(target, s.stack + s.bet) };
    };
    if (toCall === 0) return st > 0.7 && r < 0.35 ? raiseTo() : { type: 'check' };
    const potOdds = toCall / (table.potTotal() + toCall);
    if (st < potOdds && toCall > table.bigBlind && r < 0.75) return { type: 'fold' };
    if (st > 0.82 && r < 0.25) return raiseTo();
    return { type: 'call' };
  }
}

module.exports = { seed, Bots, TEST_ACCOUNTS, TEST_PASSWORD, TEST_CHIPS };
