// Tiny persistent store backed by a JSON file. Good enough for a group of friends;
// writes are atomic (write temp file + rename) so a crash can't corrupt the data.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const STARTING_CHIPS = 1000;
const REFILL_AMOUNT = 500;
const REFILL_THRESHOLD = 100;
const REFILL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

let data = { users: {}, sessions: {} };
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data.users ||= {};
    data.sessions ||= {};
  }
  // Chips that were sitting on a table when the server stopped go back to the wallet.
  for (const u of Object.values(data.users)) {
    if (u.inPlay) {
      u.chips += u.inPlay;
      u.inPlay = 0;
    }
  }
  const now = Date.now();
  for (const [token, s] of Object.entries(data.sessions)) {
    if (s.expires < now || !data.users[s.username.toLowerCase()]) delete data.sessions[token];
  }
  saveNow();
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 200);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function publicUser(u) {
  return { username: u.username, chips: u.chips, inPlay: u.inPlay || 0, canRefill: canRefill(u) };
}

function getUser(username) {
  return data.users[String(username).toLowerCase()] || null;
}

function register(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Username must be 3-16 letters, numbers or _');
  }
  if (typeof password !== 'string' || password.length < 4 || password.length > 100) {
    throw new Error('Password must be at least 4 characters');
  }
  const key = username.toLowerCase();
  if (data.users[key]) throw new Error('That username is taken');
  const salt = crypto.randomBytes(16).toString('hex');
  data.users[key] = {
    username,
    salt,
    hash: hashPassword(password, salt),
    chips: STARTING_CHIPS,
    inPlay: 0,
    lastRefill: 0,
    createdAt: Date.now(),
  };
  saveNow();
  return createSession(username);
}

function login(username, password) {
  const u = typeof username === 'string' ? getUser(username) : null;
  if (!u || typeof password !== 'string') throw new Error('Wrong username or password');
  const expected = Buffer.from(u.hash, 'hex');
  const actual = Buffer.from(hashPassword(password, u.salt), 'hex');
  if (!crypto.timingSafeEqual(expected, actual)) throw new Error('Wrong username or password');
  return createSession(u.username);
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  data.sessions[token] = { username, expires: Date.now() + SESSION_TTL_MS };
  save();
  return token;
}

function userFromToken(token) {
  if (typeof token !== 'string') return null;
  const s = data.sessions[token];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete data.sessions[token];
    save();
    return null;
  }
  return getUser(s.username);
}

function logout(token) {
  if (data.sessions[token]) {
    delete data.sessions[token];
    save();
  }
}

function canRefill(u) {
  return u.chips + (u.inPlay || 0) < REFILL_THRESHOLD && Date.now() - (u.lastRefill || 0) >= REFILL_COOLDOWN_MS;
}

function refill(u) {
  if (!canRefill(u)) throw new Error('Free chips are only available when you have under ' + REFILL_THRESHOLD + ' chips (once per hour)');
  u.chips += REFILL_AMOUNT;
  u.lastRefill = Date.now();
  saveNow();
}

// Move chips from wallet onto a table.
function buyIn(u, amount) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid amount');
  if (amount > u.chips) throw new Error('Not enough chips in your account');
  u.chips -= amount;
  u.inPlay = (u.inPlay || 0) + amount;
  saveNow();
}

// Record the current table stack so a crash never loses chips.
function setInPlay(u, amount) {
  u.inPlay = amount;
  save();
}

// Move a table stack back into the wallet.
function cashOut(u, amount) {
  u.chips += amount;
  u.inPlay = 0;
  saveNow();
}

function leaderboard(limit = 10) {
  return Object.values(data.users)
    .map((u) => ({ username: u.username, chips: u.chips + (u.inPlay || 0) }))
    .sort((a, b) => b.chips - a.chips)
    .slice(0, limit);
}

module.exports = {
  load, saveNow, register, login, logout, userFromToken, getUser, publicUser,
  refill, buyIn, setInPlay, cashOut, leaderboard,
  STARTING_CHIPS, REFILL_AMOUNT,
};
