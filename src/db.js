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
const DAILY_REWARD = 250;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HOUR = 60 * 60 * 1000;

// Miners pay for themselves in roughly 3-4 days of non-stop mining, and every extra
// miner of the same type costs 15% more, so they're a slow long-term investment,
// not a money printer. The vault only holds 24h of output: log in daily to collect.
const MINERS = [
  { id: 'usb', name: 'USB Stick Miner', icon: '🔌', cost: 500, rate: 5 },
  { id: 'laptop', name: 'Old Laptop', icon: '💻', cost: 2500, rate: 28 },
  { id: 'rig', name: 'Gaming Rig', icon: '🖥️', cost: 10000, rate: 125 },
  { id: 'asic', name: 'ASIC Miner', icon: '📟', cost: 40000, rate: 550 },
  { id: 'farm', name: 'Mining Farm', icon: '🏭', cost: 150000, rate: 2250 },
];
const MINER_PRICE_GROWTH = 1.15;
const MINER_VAULT_HOURS = 24;

const AVATAR_EMOJIS = [
  '🦊', '🐯', '🐼', '🐸', '🦁', '🐵', '🐙', '🦄', '🐺', '🐻', '🐨', '🐷',
  '🤠', '😎', '🤖', '👽', '👻', '💀', '🎩', '🧙', '🥷', '🦈', '🐲', '🐧',
];
const AVATAR_COLORS = ['#e5484d', '#f76b15', '#f2c14e', '#2fbf71', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];
const MAX_AVATAR_BYTES = 60000; // data-URL length; the client uploads a 128x128 JPEG

let data = { users: {}, sessions: {}, avatars: {} };
let saveTimer = null;

function pick(list) {
  return list[crypto.randomInt(list.length)];
}

// Fill in fields added after a user was created.
function normalizeUser(u) {
  u.inPlay ||= 0;
  u.lastRefill ||= 0;
  u.lastDaily ||= 0;
  u.miners ||= {};
  u.minerPending ||= 0;
  u.minerTick ||= Date.now();
  u.avatar ||= { type: 'emoji', emoji: pick(AVATAR_EMOJIS), color: pick(AVATAR_COLORS) };
  if (u.recoveryHash === undefined) u.recoveryHash = null;
  return u;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    data.users ||= {};
    data.sessions ||= {};
    data.avatars ||= {};
  }
  for (const u of Object.values(data.users)) {
    normalizeUser(u);
    // Chips that were sitting on a table when the server stopped go back to the wallet.
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

function hashSecret(secret, salt) {
  return crypto.scryptSync(secret, salt, 64).toString('hex');
}

function secretMatches(secret, salt, hash) {
  if (typeof secret !== 'string' || !salt || !hash) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashSecret(secret, salt), 'hex'));
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 100) {
    throw new Error('Password must be at least 4 characters');
  }
}

function setPassword(u, password) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashSecret(password, u.salt);
}

// ---------- daily reward ----------
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // UTC calendar day
}

function dailyStatus(u) {
  const canClaim = dayKey(u.lastDaily) !== dayKey(Date.now());
  const nextAt = new Date(dayKey(Date.now()) + 'T00:00:00Z').getTime() + 24 * HOUR;
  return { canClaim, nextAt, amount: DAILY_REWARD };
}

function claimDaily(u) {
  if (!dailyStatus(u).canClaim) throw new Error('You already claimed today\'s reward');
  u.chips += DAILY_REWARD;
  u.lastDaily = Date.now();
  saveNow();
  return DAILY_REWARD;
}

// ---------- miners ----------
function minerRate(u) {
  return MINERS.reduce((sum, m) => sum + (u.miners[m.id] || 0) * m.rate, 0);
}

function minerPrice(m, owned) {
  return Math.round((m.cost * MINER_PRICE_GROWTH ** owned) / 10) * 10;
}

// Bring the vault up to date with the time that has passed.
function settleMiners(u, now = Date.now()) {
  const rate = minerRate(u);
  const cap = rate * MINER_VAULT_HOURS;
  const elapsedHours = Math.max(0, now - u.minerTick) / HOUR;
  u.minerPending = Math.min(cap, u.minerPending + rate * elapsedHours);
  u.minerTick = now;
}

function minerInfo(u) {
  settleMiners(u);
  const rate = minerRate(u);
  return {
    ratePerHour: rate,
    pending: u.minerPending,
    cap: rate * MINER_VAULT_HOURS,
    vaultHours: MINER_VAULT_HOURS,
    at: u.minerTick,
    miners: MINERS.map((m) => ({
      ...m,
      owned: u.miners[m.id] || 0,
      price: minerPrice(m, u.miners[m.id] || 0),
    })),
  };
}

function buyMiner(u, id) {
  const m = MINERS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown miner');
  settleMiners(u); // bank what the old setup produced before the rate changes
  const price = minerPrice(m, u.miners[id] || 0);
  if (u.chips < price) throw new Error(`You need ${price} chips (you have ${u.chips})`);
  u.chips -= price;
  u.miners[id] = (u.miners[id] || 0) + 1;
  saveNow();
}

function collectMiners(u) {
  settleMiners(u);
  const amount = Math.floor(u.minerPending);
  if (amount <= 0) throw new Error('Nothing to collect yet');
  u.minerPending -= amount;
  u.chips += amount;
  saveNow();
  return amount;
}

// ---------- avatars ----------
function setAvatar(u, { emoji, color, image }) {
  if (image !== undefined) {
    if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw new Error('Invalid image');
    }
    if (image.length > MAX_AVATAR_BYTES) throw new Error('Image is too large');
    data.avatars[u.username.toLowerCase()] = image;
    u.avatar = { type: 'img', v: Date.now(), color: u.avatar.color };
  } else {
    if (!AVATAR_EMOJIS.includes(emoji)) throw new Error('Pick one of the avatars');
    if (!AVATAR_COLORS.includes(color)) throw new Error('Pick one of the colors');
    delete data.avatars[u.username.toLowerCase()];
    u.avatar = { type: 'emoji', emoji, color };
  }
  saveNow();
}

function avatarImage(username) {
  return data.avatars[String(username).toLowerCase()] || null;
}

// What clients need to draw someone's avatar.
function avatarOf(username) {
  const u = getUser(username);
  if (!u) return { emoji: '👤', color: '#555' };
  if (u.avatar.type === 'img') {
    return { img: `/api/avatar/${encodeURIComponent(u.username)}?v=${u.avatar.v}`, color: u.avatar.color };
  }
  return { emoji: u.avatar.emoji, color: u.avatar.color };
}

// ---------- accounts ----------
function publicUser(u) {
  return {
    username: u.username,
    chips: u.chips,
    inPlay: u.inPlay || 0,
    canRefill: canRefill(u),
    daily: dailyStatus(u),
    avatar: avatarOf(u.username),
    hasRecovery: !!u.recoveryHash,
  };
}

function getUser(username) {
  return data.users[String(username).toLowerCase()] || null;
}

// A recovery code lets a player reset a forgotten password without email.
function newRecoveryCode(u) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''),
  ).join('-');
  u.recoverySalt = crypto.randomBytes(16).toString('hex');
  u.recoveryHash = hashSecret(normalizeRecovery(code), u.recoverySalt);
  return code;
}

function normalizeRecovery(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function register(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new Error('Username must be 3-16 letters, numbers or _');
  }
  validatePassword(password);
  const key = username.toLowerCase();
  if (data.users[key]) throw new Error('That username is taken');
  const u = normalizeUser({ username, chips: STARTING_CHIPS, createdAt: Date.now() });
  setPassword(u, password);
  const recoveryCode = newRecoveryCode(u);
  data.users[key] = u;
  saveNow();
  return { token: createSession(username), recoveryCode };
}

function login(username, password) {
  const u = typeof username === 'string' ? getUser(username) : null;
  if (!u || !secretMatches(password, u.salt, u.hash)) throw new Error('Wrong username or password');
  return createSession(u.username);
}

function endAllSessions(u) {
  for (const [token, s] of Object.entries(data.sessions)) {
    if (s.username.toLowerCase() === u.username.toLowerCase()) delete data.sessions[token];
  }
}

function resetPassword(username, recoveryCode, newPassword) {
  const u = typeof username === 'string' ? getUser(username) : null;
  if (!u || !secretMatches(normalizeRecovery(recoveryCode), u.recoverySalt, u.recoveryHash)) {
    throw new Error('Wrong username or recovery code');
  }
  validatePassword(newPassword);
  setPassword(u, newPassword);
  endAllSessions(u); // log out everywhere, in case someone else had the password
  const code = newRecoveryCode(u); // each recovery code works once
  saveNow();
  return { token: createSession(u.username), recoveryCode: code };
}

function changePassword(u, oldPassword, newPassword) {
  if (!secretMatches(oldPassword, u.salt, u.hash)) throw new Error('Current password is wrong');
  validatePassword(newPassword);
  setPassword(u, newPassword);
  endAllSessions(u);
  saveNow();
  return createSession(u.username);
}

function regenerateRecovery(u, password) {
  if (!secretMatches(password, u.salt, u.hash)) throw new Error('Password is wrong');
  const code = newRecoveryCode(u);
  saveNow();
  return code;
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
    .map((u) => ({ username: u.username, chips: u.chips + (u.inPlay || 0), avatar: avatarOf(u.username) }))
    .sort((a, b) => b.chips - a.chips)
    .slice(0, limit);
}

module.exports = {
  load, saveNow, register, login, logout, userFromToken, getUser, publicUser,
  resetPassword, changePassword, regenerateRecovery,
  refill, claimDaily, buyIn, setInPlay, cashOut, leaderboard,
  minerInfo, buyMiner, collectMiners, settleMiners,
  setAvatar, avatarImage, avatarOf,
  STARTING_CHIPS, REFILL_AMOUNT, DAILY_REWARD, MINERS, AVATAR_EMOJIS, AVATAR_COLORS,
};
