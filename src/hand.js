// Texas Hold'em hand evaluation. Cards are 2-char strings: rank + suit, e.g. "As", "Td", "7h".
const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const CATEGORY_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

function rankValue(card) {
  return RANKS.indexOf(card[0]) + 2;
}

function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  // Fisher-Yates with a crypto-quality RNG
  const crypto = require('crypto');
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Returns a score array; compare lexicographically (higher wins).
function eval5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let straightHigh = 0;
  if (counts.size === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // wheel A-2-3-4-5
  }

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, ...groups.map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...groups.map((g) => g[0])];
  if (groups[0][1] === 2) return [1, ...groups.map((g) => g[0])];
  return [0, ...vals];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Best 5-card hand out of 5-7 cards.
function bestHand(cards) {
  let best = null;
  const n = cards.length;
  const combo = [];
  const pick = (start) => {
    if (combo.length === 5) {
      const score = eval5(combo);
      if (!best || compareScores(score, best.score) > 0) best = { score, cards: [...combo] };
      return;
    }
    for (let i = start; i <= n - (5 - combo.length); i++) {
      combo.push(cards[i]);
      pick(i + 1);
      combo.pop();
    }
  };
  pick(0);
  best.name = CATEGORY_NAMES[best.score[0]];
  if (best.score[0] === 8 && best.score[1] === 14) best.name = 'Royal Flush';
  return best;
}

module.exports = { newDeck, eval5, bestHand, compareScores, CATEGORY_NAMES };
