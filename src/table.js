// Texas Hold'em No-Limit table. Knows nothing about sockets or the database;
// it talks to the outside world through the `hooks` object.
const { newDeck, bestHand, compareScores } = require('./hand');

const MAX_SEATS = 9;
const TURN_MS = 30000;
const DISCONNECTED_TURN_MS = 8000;
const NEXT_HAND_MS = 5000;
const RUNOUT_STEP_MS = 1200;

class Table {
  constructor(code, { smallBlind, bigBlind }, hooks = {}) {
    this.code = code;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.hooks = {
      onChange: () => {},
      onLog: () => {},
      syncStack: () => {}, // (username, stack) — persist the stack while seated
      cashOut: () => {}, // (username, amount) — chips go back to the wallet
      ...hooks,
    };
    this.seats = new Array(MAX_SEATS).fill(null);
    this.phase = 'waiting';
    this.board = [];
    this.deck = [];
    this.dealer = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.toAct = -1;
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.handNumber = 0;
    this.turnDeadline = 0;
    this.lastResult = null;
    this.turnTimer = null;
    this.nextHandTimer = null;
    this.runoutTimer = null;
  }

  // ---------- helpers ----------
  seatOf(username) {
    return this.seats.findIndex((s) => s && s.username === username);
  }

  get inProgress() {
    return ['preflop', 'flop', 'turn', 'river'].includes(this.phase);
  }

  activeSeats() {
    // players still contesting the pot
    return this.seats.map((s, i) => i).filter((i) => {
      const s = this.seats[i];
      return s && s.inHand && !s.folded;
    });
  }

  nextSeat(from, pred) {
    for (let k = 1; k <= MAX_SEATS; k++) {
      const i = (from + k + MAX_SEATS) % MAX_SEATS;
      if (this.seats[i] && pred(this.seats[i], i)) return i;
    }
    return -1;
  }

  log(msg) {
    this.hooks.onLog(msg);
  }

  changed() {
    this.hooks.onChange();
  }

  clearTimers() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextHandTimer);
    clearTimeout(this.runoutTimer);
  }

  // ---------- seating ----------
  sit(username, seat, stack) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= MAX_SEATS) throw new Error('Invalid seat');
    if (this.seats[seat]) throw new Error('Seat is taken');
    if (this.seatOf(username) !== -1) throw new Error('You are already seated');
    this.seats[seat] = {
      username,
      stack,
      hole: [],
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      acted: false,
      inHand: false,
      sittingOut: false,
      left: false,
      connected: true,
      showCards: false,
      lastAction: null,
    };
    this.log(`${username} sits down with ${stack} chips`);
    this.scheduleNextHand(1500);
    this.changed();
  }

  stand(username) {
    const i = this.seatOf(username);
    if (i === -1) return;
    const s = this.seats[i];
    if (this.inProgress && s.inHand && !s.folded) {
      this.foldSeat(i, 'left the table');
    }
    const amount = s.stack;
    s.stack = 0;
    this.hooks.cashOut(username, amount);
    this.log(`${username} leaves the table with ${amount} chips`);
    if (this.inProgress && s.inHand) s.left = true; // keep the seat object until the hand ends
    else this.seats[i] = null;
    this.changed();
  }

  addChips(username, amount) {
    const i = this.seatOf(username);
    if (i === -1) throw new Error('You are not seated');
    const s = this.seats[i];
    if (this.inProgress && s.inHand && !s.folded) throw new Error('You can add chips between hands');
    s.stack += amount;
    this.hooks.syncStack(username, s.stack);
    this.log(`${username} adds ${amount} chips`);
    this.scheduleNextHand(1500);
    this.changed();
  }

  setSittingOut(username, value) {
    const i = this.seatOf(username);
    if (i === -1) return;
    this.seats[i].sittingOut = !!value;
    if (!value) this.scheduleNextHand(1500);
    this.changed();
  }

  setConnected(username, value) {
    const i = this.seatOf(username);
    if (i === -1) return;
    this.seats[i].connected = value;
    if (!value && i === this.toAct && this.inProgress) this.startTurnTimer();
    this.changed();
  }

  // ---------- hand flow ----------
  eligibleSeats() {
    return this.seats.map((s, i) => i).filter((i) => {
      const s = this.seats[i];
      return s && !s.left && !s.sittingOut && s.stack > 0;
    });
  }

  scheduleNextHand(delay = NEXT_HAND_MS) {
    if (this.inProgress || this.nextHandTimer || this.runoutTimer) return;
    if (this.eligibleSeats().length < 2) return;
    this.nextHandTimer = setTimeout(() => {
      this.nextHandTimer = null;
      this.startHand();
    }, delay);
  }

  startHand() {
    if (this.inProgress) return;
    const eligible = this.eligibleSeats();
    if (eligible.length < 2) {
      this.phase = 'waiting';
      this.changed();
      return;
    }
    this.handNumber++;
    this.phase = 'preflop';
    this.board = [];
    this.deck = newDeck();
    this.lastResult = null;
    for (const s of this.seats) {
      if (!s) continue;
      Object.assign(s, {
        hole: [], bet: 0, totalBet: 0, folded: false, allIn: false,
        acted: false, inHand: false, showCards: false, lastAction: null,
      });
    }
    for (const i of eligible) this.seats[i].inHand = true;

    const inHand = (s) => s.inHand;
    this.dealer = this.nextSeat(this.dealer, inHand);
    if (eligible.length === 2) {
      this.sbSeat = this.dealer;
      this.bbSeat = this.nextSeat(this.dealer, inHand);
    } else {
      this.sbSeat = this.nextSeat(this.dealer, inHand);
      this.bbSeat = this.nextSeat(this.sbSeat, inHand);
    }
    this.log(`--- Hand #${this.handNumber} ---`);
    this.putChips(this.sbSeat, Math.min(this.smallBlind, this.seats[this.sbSeat].stack));
    this.seats[this.sbSeat].lastAction = 'SB';
    this.putChips(this.bbSeat, Math.min(this.bigBlind, this.seats[this.bbSeat].stack));
    this.seats[this.bbSeat].lastAction = 'BB';
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    for (let r = 0; r < 2; r++) {
      for (let k = 1; k <= MAX_SEATS; k++) {
        const s = this.seats[(this.dealer + k) % MAX_SEATS];
        if (s && s.inHand) s.hole.push(this.deck.pop());
      }
    }
    this.proceed(this.bbSeat + 1);
  }

  putChips(i, amount) {
    const s = this.seats[i];
    amount = Math.min(amount, s.stack);
    s.stack -= amount;
    s.bet += amount;
    s.totalBet += amount;
    if (s.stack === 0) s.allIn = true;
    return amount;
  }

  // Decide what happens next: next player to act, next street, or end of hand.
  proceed(startFrom) {
    clearTimeout(this.turnTimer);
    const active = this.activeSeats();
    if (active.length === 1) return this.winUncontested(active[0]);

    const canAct = active.filter((i) => !this.seats[i].allIn);
    const pending = canAct.filter((i) => {
      const s = this.seats[i];
      return !s.acted || s.bet < this.currentBet;
    });
    const nobodyToBetAgainst =
      canAct.length <= 1 && canAct.every((i) => this.seats[i].bet >= this.currentBet);

    if (pending.length === 0 || nobodyToBetAgainst) return this.endBettingRound();

    this.toAct = this.nextSeat(startFrom - 1, (s, i) => pending.includes(i));
    this.startTurnTimer();
    this.changed();
  }

  startTurnTimer() {
    clearTimeout(this.turnTimer);
    const s = this.seats[this.toAct];
    const ms = s && s.connected ? TURN_MS : DISCONNECTED_TURN_MS;
    this.turnDeadline = Date.now() + ms;
    this.turnMs = ms;
    const seat = this.toAct;
    const hand = this.handNumber;
    this.turnTimer = setTimeout(() => {
      if (this.toAct !== seat || this.handNumber !== hand || !this.inProgress) return;
      const p = this.seats[seat];
      p.sittingOut = true; // sit out players who time out so they stop posting blinds
      this.log(`${p.username} ran out of time`);
      if (p.bet >= this.currentBet) this.act(p.username, 'check');
      else this.act(p.username, 'fold');
    }, ms);
  }

  act(username, type, amount) {
    if (!this.inProgress) throw new Error('No hand in progress');
    const i = this.seatOf(username);
    if (i === -1 || i !== this.toAct) throw new Error("It's not your turn");
    const s = this.seats[i];
    const toCall = this.currentBet - s.bet;

    switch (type) {
      case 'fold':
        s.folded = true;
        s.lastAction = 'Fold';
        this.log(`${username} folds`);
        break;
      case 'check':
        if (toCall > 0) throw new Error('You cannot check, there is a bet');
        s.lastAction = 'Check';
        this.log(`${username} checks`);
        break;
      case 'call': {
        if (toCall <= 0) return this.act(username, 'check');
        const paid = this.putChips(i, toCall);
        s.lastAction = s.allIn ? 'All-in' : 'Call';
        this.log(`${username} calls ${paid}${s.allIn ? ' (all-in)' : ''}`);
        break;
      }
      case 'allin':
        if (s.stack + s.bet <= this.currentBet) return this.act(username, 'call');
        return this.act(username, 'raise', s.stack + s.bet);
      case 'raise': {
        amount = Math.floor(Number(amount));
        const maxTo = s.stack + s.bet;
        if (!Number.isFinite(amount)) throw new Error('Invalid amount');
        if (amount >= maxTo) amount = maxTo;
        if (amount <= this.currentBet) throw new Error('Raise must be higher than the current bet');
        const minTo = this.currentBet + this.minRaise;
        if (amount < minTo && amount < maxTo) throw new Error(`Minimum raise is to ${minTo}`);
        const raiseSize = amount - this.currentBet;
        const wasBet = this.currentBet === 0;
        this.putChips(i, amount - s.bet);
        if (raiseSize >= this.minRaise) {
          this.minRaise = raiseSize;
          // a full raise re-opens the action for everyone else
          for (const j of this.activeSeats()) if (j !== i) this.seats[j].acted = false;
        }
        this.currentBet = amount;
        s.lastAction = s.allIn ? 'All-in' : wasBet ? `Bet ${amount}` : `Raise ${amount}`;
        this.log(`${username} ${s.allIn ? 'goes all-in for' : wasBet ? 'bets' : 'raises to'} ${amount}`);
        break;
      }
      default:
        throw new Error('Unknown action');
    }
    s.acted = true;
    this.proceed(i + 1);
  }

  foldSeat(i, reason) {
    const s = this.seats[i];
    s.folded = true;
    s.acted = true;
    s.lastAction = 'Fold';
    this.log(`${s.username} folds (${reason})`);
    if (i === this.toAct) this.proceed(i + 1);
    else if (this.activeSeats().length === 1) this.winUncontested(this.activeSeats()[0]);
  }

  endBettingRound() {
    if (!this.inProgress) return;
    clearTimeout(this.turnTimer);
    this.toAct = -1;
    for (const s of this.seats) {
      if (!s || !s.inHand) continue;
      s.bet = 0;
      s.acted = false;
      if (!s.folded && !s.allIn) s.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[this.phase];
    if (next === 'showdown') return this.showdown();

    this.phase = next;
    this.deck.pop(); // burn
    const count = next === 'flop' ? 3 : 1;
    for (let k = 0; k < count; k++) this.board.push(this.deck.pop());
    this.log(`${next[0].toUpperCase() + next.slice(1)}: ${this.board.join(' ')}`);

    const canAct = this.activeSeats().filter((i) => !this.seats[i].allIn);
    if (canAct.length <= 1) {
      // everyone is all-in: reveal hands and run out the board slowly for drama
      for (const i of this.activeSeats()) this.seats[i].showCards = true;
      this.changed();
      this.runoutTimer = setTimeout(() => {
        this.runoutTimer = null;
        this.endBettingRound();
      }, RUNOUT_STEP_MS);
      return;
    }
    this.proceed(this.dealer + 1);
  }

  // Split all contributions into main pot + side pots.
  buildPots() {
    const contributors = this.seats.filter((s) => s && s.totalBet > 0);
    const levels = [...new Set(
      contributors.filter((s) => !s.folded && s.inHand).map((s) => s.totalBet),
    )].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const s of contributors) amount += Math.max(0, Math.min(s.totalBet, level) - prev);
      const eligible = contributors.filter((s) => s.inHand && !s.folded && s.totalBet >= level);
      if (amount > 0) pots.push({ amount, eligible });
      prev = level;
    }
    // chips above the highest live contribution (e.g. from folded players) join the last pot
    let leftover = 0;
    for (const s of contributors) leftover += Math.max(0, s.totalBet - prev);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  potTotal() {
    return this.seats.reduce((sum, s) => sum + (s ? s.totalBet : 0), 0);
  }

  showdown() {
    this.phase = 'showdown';
    this.toAct = -1;
    const active = this.activeSeats();
    const hands = new Map();
    for (const i of active) {
      const s = this.seats[i];
      s.showCards = true;
      hands.set(s, bestHand([...s.hole, ...this.board]));
    }
    const winnings = new Map();
    const pots = this.buildPots();
    pots.forEach((pot, idx) => {
      let best = [];
      for (const s of pot.eligible) {
        if (!best.length) best = [s];
        else {
          const c = compareScores(hands.get(s).score, hands.get(best[0]).score);
          if (c > 0) best = [s];
          else if (c === 0) best.push(s);
        }
      }
      // odd chips go to the first winner left of the dealer
      best.sort((a, b) => this.distFromDealer(a) - this.distFromDealer(b));
      const share = Math.floor(pot.amount / best.length);
      let remainder = pot.amount - share * best.length;
      for (const w of best) {
        const amt = share + (remainder-- > 0 ? 1 : 0);
        w.stack += amt;
        winnings.set(w, (winnings.get(w) || 0) + amt);
      }
      const label = pots.length > 1 ? (idx === 0 ? 'main pot' : `side pot ${idx}`) : 'the pot';
      this.log(`${best.map((w) => w.username).join(' & ')} win${best.length > 1 ? '' : 's'} ${pot.amount} from ${label} with ${hands.get(best[0]).name}`);
    });

    this.lastResult = {
      winners: [...winnings.entries()].map(([s, amount]) => ({
        username: s.username, amount, hand: hands.get(s).name, rank: hands.get(s).rank, cards: hands.get(s).cards,
      })),
      hands: active.map((i) => ({
        username: this.seats[i].username, hand: hands.get(this.seats[i]).name,
      })),
    };
    this.finishHand();
  }

  winUncontested(i) {
    clearTimeout(this.turnTimer);
    const w = this.seats[i];
    const pot = this.potTotal();
    w.stack += pot;
    this.phase = 'showdown';
    this.toAct = -1;
    this.lastResult = { winners: [{ username: w.username, amount: pot, hand: null, rank: -1 }], hands: [] };
    this.log(`${w.username} wins ${pot}`);
    this.finishHand();
  }

  distFromDealer(s) {
    const i = this.seats.indexOf(s);
    return (i - this.dealer + MAX_SEATS) % MAX_SEATS || MAX_SEATS;
  }

  finishHand() {
    clearTimeout(this.runoutTimer);
    this.runoutTimer = null;
    for (let i = 0; i < MAX_SEATS; i++) {
      const s = this.seats[i];
      if (!s) continue;
      s.bet = 0;
      if (s.left) {
        this.seats[i] = null;
        continue;
      }
      this.hooks.syncStack(s.username, s.stack);
      if (s.stack === 0) s.lastAction = 'Busted';
    }
    this.changed();
    this.scheduleNextHand();
  }

  // ---------- view ----------
  stateFor(viewer) {
    const mySeat = this.seatOf(viewer);
    const seats = this.seats.map((s, i) => {
      if (!s || s.left) return null;
      const reveal = s.username === viewer || (s.showCards && !s.folded);
      return {
        username: s.username,
        stack: s.stack,
        bet: s.bet,
        folded: s.folded,
        allIn: s.allIn,
        inHand: s.inHand,
        sittingOut: s.sittingOut,
        connected: s.connected,
        lastAction: s.lastAction,
        cards: s.inHand ? (reveal ? s.hole : s.hole.map(() => '??')) : [],
        seat: i,
      };
    });
    let you = null;
    if (mySeat !== -1) {
      const s = this.seats[mySeat];
      const myTurn = this.inProgress && this.toAct === mySeat;
      you = {
        seat: mySeat,
        myTurn,
        toCall: Math.min(Math.max(0, this.currentBet - s.bet), s.stack),
        minRaiseTo: Math.min(this.currentBet + this.minRaise, s.stack + s.bet),
        maxRaiseTo: s.stack + s.bet,
        canRaise: s.stack + s.bet > this.currentBet,
        hand: null,
      };
      if (s.inHand && !s.folded && s.hole.length === 2) {
        const cards = [...s.hole, ...this.board];
        if (cards.length >= 5) you.hand = bestHand(cards).name;
        else if (s.hole[0][0] === s.hole[1][0]) you.hand = 'Pocket Pair';
      }
    }
    const collected = this.seats.reduce((sum, s) => sum + (s ? s.totalBet - s.bet : 0), 0);
    return {
      code: this.code,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      phase: this.phase,
      board: this.board,
      pot: collected,
      totalPot: this.potTotal(),
      currentBet: this.currentBet,
      dealer: this.dealer,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      toAct: this.inProgress ? this.toAct : -1,
      turnDeadline: this.turnDeadline,
      turnMs: this.turnMs || TURN_MS,
      handNumber: this.handNumber,
      seats,
      you,
      lastResult: this.lastResult,
    };
  }

  destroy() {
    this.clearTimers();
  }
}

module.exports = { Table, MAX_SEATS };
