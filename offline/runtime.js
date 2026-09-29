// Offline edition: a tiny CommonJS loader plus the few Node APIs the server modules use
// (crypto, fs, path, Buffer), so src/*.js runs unchanged inside the page.
(function () {
  'use strict';
  const defs = {};
  const cache = {};
  const shims = {};

  window.__define = (name, fn) => {
    defs[name] = fn;
  };

  function req(name) {
    const key = name.replace(/^(\.\.?\/)+(src\/)?/, '').replace(/\.js$/, '');
    if (shims[key]) return shims[key];
    if (cache[key]) return cache[key].exports;
    if (!defs[key]) throw new Error('Module not available offline: ' + name);
    const module = { exports: {} };
    cache[key] = module;
    defs[key](module, module.exports, req, { env: {}, argv: [] }, '/src', BufferShim);
    return module.exports;
  }
  window.__require = req;

  // ---------- crypto ----------
  const rng = window.crypto;
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const withHex = (bytes) => {
    bytes.toString = () => hex(bytes);
    return bytes;
  };
  function randomInt(a, b) {
    if (b === undefined) {
      b = a;
      a = 0;
    }
    const range = b - a;
    const limit = Math.floor(0x100000000 / range) * range; // avoid modulo bias
    const buf = new Uint32Array(1);
    do rng.getRandomValues(buf);
    while (buf[0] >= limit);
    return a + (buf[0] % range);
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    rng.getRandomValues(b);
    return withHex(b);
  }
  // Offline profiles are just names in this browser, so there's nothing a slow password
  // hash would protect: a fast deterministic mixing hash is enough here.
  function scryptSync(secret, salt, len) {
    const out = new Uint8Array(len);
    let h1 = 0x9e3779b9;
    let h2 = 0x85ebca6b;
    const input = String(secret) + '\u0000' + String(salt);
    for (let round = 0; round < len / 8; round++) {
      for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i) + round;
        h1 = Math.imul(h1 ^ c, 2654435761);
        h2 = Math.imul(h2 ^ c, 1597334677);
      }
      h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
      h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
      for (let k = 0; k < 4 && round * 8 + k < len; k++) out[round * 8 + k] = (h1 >>> (k * 8)) & 255;
      for (let k = 0; k < 4 && round * 8 + 4 + k < len; k++) out[round * 8 + 4 + k] = (h2 >>> (k * 8)) & 255;
    }
    return withHex(out);
  }
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  shims.crypto = { randomInt, randomBytes, scryptSync, timingSafeEqual };

  const BufferShim = {
    from(str, enc) {
      if (enc !== 'hex') throw new Error('Only hex buffers are supported offline');
      const out = new Uint8Array(str.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
      return out;
    },
  };

  // ---------- path ----------
  shims.path = { join: (...parts) => parts.join('/').replace(/\/+/g, '/') };

  // ---------- fs: "files" live in localStorage (or memory if the browser blocks it) ----------
  const ls = (() => {
    try {
      const k = '__pokerNightTest';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return localStorage;
    } catch {
      return null;
    }
  })();
  window.__persistent = !!ls;
  const mem = new Map();
  const key = (p) => 'pokerNight:' + p;
  const fsShim = {
    mkdirSync() {},
    existsSync: (p) => mem.has(p) || (!!ls && ls.getItem(key(p)) !== null),
    readFileSync: (p) => (mem.has(p) ? mem.get(p) : ls ? ls.getItem(key(p)) : null),
    writeFileSync(p, data) {
      mem.set(p, data);
      if (!ls) return;
      try {
        ls.setItem(key(p), data);
      } catch (e) {
        console.warn('Could not save to this browser:', e.message);
      }
    },
    renameSync(from, to) {
      fsShim.writeFileSync(to, fsShim.readFileSync(from));
      mem.delete(from);
      if (ls) ls.removeItem(key(from));
    },
  };
  shims.fs = fsShim;
})();
