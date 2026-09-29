(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const fmt = (n) => Math.floor(Number(n)).toLocaleString('en-US');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  let me = null; // public user from the server
  let config = { avatarEmojis: [], avatarColors: [], emotes: [] };
  // In the sandbox each tab keeps its own login, so one person can play several test accounts.
  const tokenStore = () => (config.sandbox && !config.offline ? sessionStorage : localStorage);
  let token = null; // read in boot(), once we know whether this is the sandbox
  let socket = null;
  let currentRoom = null;
  let state = null;
  let prev = null; // previous table state, to detect what changed
  let serverOffset = 0;
  let celebratedHand = -1;

  // ---------- helpers ----------
  // Some HTML previews run pages in a sandbox where confirm() silently returns false.
  const confirmAction = (msg) => (config.offline ? true : confirm(msg));

  function show(screen) {
    for (const s of ['auth', 'lobby', 'table']) $(`#${s}-screen`).classList.toggle('hidden', s !== screen);
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  async function api(path, body) {
    // offline edition: the "server" runs inside this page
    if (window.LocalServer) return window.LocalServer.api(path, body, token);
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function emit(event, data) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) return resolve({ error: 'Not connected to the server' });
      socket.emit(event, data, (res) => resolve(res || {}));
    });
  }

  function fillAvatar(div, av) {
    div.innerHTML = '';
    div.style.background = av.color || '#555';
    if (av.img) {
      const img = new Image();
      img.alt = '';
      img.src = av.img;
      div.append(img);
    } else div.textContent = av.emoji || '👤';
  }
  function avatarEl(av) {
    const d = el('div', 'avatar');
    fillAvatar(d, av);
    return d;
  }

  function centerOf(node) {
    return node ? node.getBoundingClientRect() : null;
  }

  function setWallet(user) {
    me = user;
    for (const e of $$('.wallet-amount')) e.textContent = fmt(user.chips);
    $('#lobby-user').textContent = user.username;
    const la = $('#lobby-avatar');
    la.innerHTML = '';
    la.append(avatarEl(user.avatar));
    $('#recovery-banner').classList.toggle('hidden', !!user.hasRecovery);
    renderRewards();
    renderMiners();
  }

  function setToken(t) {
    token = t;
    try {
      if (t == null) tokenStore().removeItem('pokerToken');
      else tokenStore().setItem('pokerToken', t);
    } catch {}
    if (socket) socket.auth = { token: t };
  }

  function roomFromUrl() {
    if (config.offline) return null; // offline tables don't survive a reload
    const code = new URLSearchParams(location.search).get('room');
    return code ? code.toUpperCase() : null;
  }

  function setUrlRoom(code) {
    if (config.offline) return;
    try {
      const url = new URL(location.href);
      if (code) url.searchParams.set('room', code);
      else url.searchParams.delete('room');
      history.replaceState(null, '', url);
    } catch {}
  }

  // ---------- auth ----------
  let authMode = 'login';
  for (const tab of $$('.auth-panel .tab')) {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      $$('.auth-panel .tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#auth-submit').textContent = authMode === 'login' ? 'Log in' : 'Create account';
      $('#auth-password').autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      $('#auth-error').textContent = '';
    });
  }

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#auth-error').textContent = '';
    try {
      const data = await api('/api/' + authMode, {
        username: $('#auth-username').value.trim(),
        password: $('#auth-password').value,
      });
      setToken(data.token);
      $('#auth-password').value = '';
      onLoggedIn(data.user);
      if (data.recoveryCode) showRecoveryCode(data.recoveryCode);
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  $('#forgot-link').addEventListener('click', () => {
    $('#auth-main').classList.add('hidden');
    $('#reset-main').classList.remove('hidden');
    $('#reset-username').value = $('#auth-username').value;
  });
  $('#back-to-login').addEventListener('click', () => {
    $('#reset-main').classList.add('hidden');
    $('#auth-main').classList.remove('hidden');
  });

  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#reset-error').textContent = '';
    try {
      const data = await api('/api/reset-password', {
        username: $('#reset-username').value.trim(),
        recoveryCode: $('#reset-code').value.trim(),
        newPassword: $('#reset-password').value,
      });
      setToken(data.token);
      $('#reset-password').value = '';
      $('#reset-code').value = '';
      $('#reset-main').classList.add('hidden');
      $('#auth-main').classList.remove('hidden');
      onLoggedIn(data.user);
      toast('Password changed!');
      showRecoveryCode(data.recoveryCode, 'Your old recovery code is used up. Here is your new one:');
    } catch (err) {
      $('#reset-error').textContent = err.message;
    }
  });

  function showRecoveryCode(code, note) {
    $('#recovery-code').textContent = code;
    const d = $('#code-dialog');
    d.querySelector('p').innerHTML = note
      ? `${note} Save it somewhere safe — it won't be shown again.`
      : "Save this somewhere safe (screenshot, notes app). It's the <b>only</b> way to reset your password if you forget it, and it won't be shown again.";
    d.showModal();
  }
  $('#copy-code-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#recovery-code').textContent);
      toast('Copied!');
    } catch {}
  });
  $('#code-ok-btn').addEventListener('click', () => $('#code-dialog').close());

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch {}
    logoutLocal();
  });

  function logoutLocal() {
    setToken(null);
    if (socket) socket.disconnect();
    socket = null;
    show('auth');
  }

  function onLoggedIn(user) {
    setWallet(user);
    connectSocket();
    const code = roomFromUrl();
    if (code) joinRoom(code);
    else showLobby();
  }

  // ---------- lobby ----------
  async function showLobby() {
    currentRoom = null;
    state = prev = null;
    $('#chat-list').innerHTML = '';
    $('#log-list').innerHTML = '';
    setUrlRoom(null);
    show('lobby');
    try {
      const { user } = await api('/api/me');
      setWallet(user);
      loadLeaderboard();
      loadMiners();
    } catch (err) {
      if (err.status === 401) logoutLocal();
    }
  }

  async function loadLeaderboard() {
    try {
      const { leaders } = await api('/api/leaderboard');
      const list = $('#leaderboard');
      list.innerHTML = '';
      for (const l of leaders) {
        const li = el('li');
        li.append(avatarEl(l.avatar), el('span', null, l.username), el('b', null, fmt(l.chips)));
        list.append(li);
      }
    } catch {}
  }

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#join-code').value.trim().toUpperCase();
    if (code) joinRoom(code);
  });

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#create-error').textContent = '';
    const res = await emit('create-room', {
      bigBlind: Number($('#create-blinds').value),
      code: $('#create-code').value.trim(),
    });
    if (res.error) return ($('#create-error').textContent = res.error);
    enteredRoom(res.code);
    toast(config.offline ? 'The bots are taking their seats. Tap an empty seat (+) to join!' : `Room ${res.code} created — share the code with your friends!`);
  });

  // ---------- rewards ----------
  function renderRewards() {
    if (!me) return;
    const d = me.daily;
    $('#daily-box').classList.toggle('claimable', d.canClaim);
    const btn = $('#daily-btn');
    btn.disabled = !d.canClaim;
    btn.textContent = d.canClaim ? `Claim ${d.amount}` : 'Claimed ✓';
    if (d.canClaim) $('#daily-text').textContent = `+${d.amount} chips — ready to claim!`;
    else {
      const ms = Math.max(0, d.nextAt - Date.now());
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      $('#daily-text').textContent = `Next reward in ${h}h ${m}m`;
    }
    $('#refill-box').classList.toggle('hidden', !me.canRefill);
  }

  function coinBurstAt(node, count = 30) {
    const r = centerOf(node);
    if (!r) return;
    FX.burst(r.left + r.width / 2, r.top + r.height / 2, {
      count, colors: ['#f2c14e', '#ffd978', '#fff3c4'], shape: 'coin', size: [5, 8], speed: [150, 380], life: [0.7, 1.1],
    });
    FX.sound('coins');
  }

  $('#daily-btn').addEventListener('click', async () => {
    $('#reward-error').textContent = '';
    try {
      const { user, amount } = await api('/api/daily', {});
      coinBurstAt($('#daily-btn'));
      setWallet(user);
      toast(`+${amount} chips!`);
      loadLeaderboard();
    } catch (err) {
      $('#reward-error').textContent = err.message;
    }
  });

  $('#refill-btn').addEventListener('click', async () => {
    $('#reward-error').textContent = '';
    try {
      const { user } = await api('/api/refill', {});
      coinBurstAt($('#refill-btn'));
      setWallet(user);
      toast('+500 chips!');
      loadLeaderboard();
    } catch (err) {
      $('#reward-error').textContent = err.message;
    }
  });

  // ---------- miners ----------
  let mine = null; // { ratePerHour, pending, cap, at, miners, offset }

  async function loadMiners() {
    try {
      const data = await api('/api/miners');
      setMine(data);
    } catch {}
  }

  function setMine(data) {
    mine = { ...data, offset: data.serverTime - Date.now() };
    renderMiners();
  }

  function minePending() {
    if (!mine) return 0;
    const now = Date.now() + mine.offset;
    return Math.min(mine.cap, mine.pending + (mine.ratePerHour * Math.max(0, now - mine.at)) / 3600000);
  }

  function renderMiners() {
    if (!mine || !me) return;
    const list = $('#miner-list');
    list.innerHTML = '';
    for (const m of mine.miners) {
      const card = el('div', 'miner' + (m.owned ? ' owned' : ''));
      if (m.owned) card.append(el('span', 'owned-badge', '×' + m.owned));
      const days = m.price / m.rate / 24;
      card.append(
        el('div', 'icon', m.icon),
        el('b', null, m.name),
        el('div', 'rate', `+${fmt(m.rate)} / hour`),
        el('div', 'payback muted', `pays back in ~${days.toFixed(1)} days`),
      );
      const buy = el('button', 'btn' + (me.chips >= m.price ? ' primary' : ''), `Buy · ${fmt(m.price)}`);
      buy.disabled = me.chips < m.price;
      buy.addEventListener('click', async () => {
        $('#miner-error').textContent = '';
        try {
          const data = await api('/api/miners/buy', { id: m.id });
          coinBurstAt(card, 16);
          setMine(data);
          setWallet(data.user);
          toast(`${m.name} is now mining for you!`);
      loadLeaderboard();
        } catch (err) {
          $('#miner-error').textContent = err.message;
        }
      });
      card.append(buy);
      list.append(card);
    }
    tickVault();
  }

  function tickVault() {
    if (!mine) return;
    const p = minePending();
    $('#vault-amount').textContent = fmt(p);
    $('#vault-cap').textContent = mine.cap ? `/ ${fmt(mine.cap)} max` : '';
    $('#mine-rate').textContent = mine.ratePerHour
      ? `⛏️ ${fmt(mine.ratePerHour)} chips / hour`
      : 'Buy a miner to start mining';
    const fill = $('#vault-bar');
    const pct = mine.cap ? (p / mine.cap) * 100 : 0;
    fill.style.width = pct + '%';
    fill.classList.toggle('full', pct >= 99.9);
    $('#collect-btn').disabled = p < 1;
    $('#collect-btn').textContent = pct >= 99.9 ? 'Collect (vault full!)' : 'Collect';
  }
  setInterval(() => {
    if (!$('#lobby-screen').classList.contains('hidden')) {
      tickVault();
      renderRewards();
    }
  }, 1000);

  $('#collect-btn').addEventListener('click', async () => {
    $('#miner-error').textContent = '';
    try {
      const data = await api('/api/miners/collect', {});
      coinBurstAt($('#collect-btn'), 40);
      setMine(data);
      setWallet(data.user);
      toast(`Collected ${fmt(data.amount)} chips!`);
      loadLeaderboard();
    } catch (err) {
      $('#miner-error').textContent = err.message;
    }
  });

  // ---------- profile ----------
  let sel = null; // { emoji, color, image }

  function openProfile(focusRecovery) {
    const av = me.avatar;
    sel = { emoji: av.emoji || config.avatarEmojis[0], color: av.color, image: null, keepImage: !!av.img };
    $('#profile-name').textContent = me.username;
    ['avatar-error', 'pw-error', 'recovery-error'].forEach((id) => ($('#' + id).textContent = ''));
    renderProfile();
    $('#profile-dialog').showModal();
    if (focusRecovery) $('#recovery-pw').focus();
  }

  function renderProfile() {
    const preview = $('#profile-avatar-preview');
    preview.innerHTML = '';
    const av = sel.image ? { img: sel.image, color: sel.color }
      : sel.keepImage ? me.avatar
      : { emoji: sel.emoji, color: sel.color };
    preview.append(avatarEl(av));
    const grid = $('#avatar-grid');
    grid.innerHTML = '';
    for (const e of config.avatarEmojis) {
      const b = el('button', !sel.image && !sel.keepImage && e === sel.emoji ? 'sel' : '', e);
      b.type = 'button';
      b.addEventListener('click', () => {
        Object.assign(sel, { emoji: e, image: null, keepImage: false });
        renderProfile();
      });
      grid.append(b);
    }
    const colors = $('#color-grid');
    colors.innerHTML = '';
    for (const c of config.avatarColors) {
      const b = el('button', c === sel.color ? 'sel' : '');
      b.type = 'button';
      b.style.background = c;
      b.addEventListener('click', () => {
        sel.color = c;
        if (sel.keepImage) sel.keepImage = false;
        renderProfile();
      });
      colors.append(b);
    }
  }

  $('#profile-btn').addEventListener('click', () => openProfile(false));
  $('#recovery-banner-btn').addEventListener('click', () => openProfile(true));
  $('#profile-close').addEventListener('click', () => $('#profile-dialog').close());

  // Photo upload: crop to a square and shrink to 128px before sending.
  $('#avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const size = 128;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      sel.image = c.toDataURL('image/jpeg', 0.85);
      sel.keepImage = false;
      URL.revokeObjectURL(img.src);
      renderProfile();
    };
    img.onerror = () => ($('#avatar-error').textContent = "Couldn't read that image");
    img.src = URL.createObjectURL(file);
  });

  $('#avatar-save').addEventListener('click', async () => {
    $('#avatar-error').textContent = '';
    if (sel.keepImage) return $('#profile-dialog').close();
    try {
      const body = sel.image ? { image: sel.image } : { emoji: sel.emoji, color: sel.color };
      const { user } = await api('/api/avatar', body);
      setWallet(user);
      toast('Avatar saved!');
      $('#profile-dialog').close();
      if (!$('#lobby-screen').classList.contains('hidden')) showLobby();
    } catch (err) {
      $('#avatar-error').textContent = err.message;
    }
  });

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#pw-error').textContent = '';
    try {
      const data = await api('/api/change-password', { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value });
      setToken(data.token);
      $('#pw-old').value = $('#pw-new').value = '';
      toast('Password changed. Other devices were logged out.');
    } catch (err) {
      $('#pw-error').textContent = err.message;
    }
  });

  $('#recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#recovery-error').textContent = '';
    try {
      const { recoveryCode } = await api('/api/recovery-code', { password: $('#recovery-pw').value });
      $('#recovery-pw').value = '';
      me.hasRecovery = true;
      $('#recovery-banner').classList.add('hidden');
      $('#profile-dialog').close();
      showRecoveryCode(recoveryCode);
    } catch (err) {
      $('#recovery-error').textContent = err.message;
    }
  });

  // ---------- rooms ----------
  async function joinRoom(code) {
    $('#join-error').textContent = '';
    const res = await emit('join-room', { code });
    if (res.error) {
      if (!currentRoom) {
        await showLobby();
        $('#join-error').textContent = res.error;
      } else toast(res.error);
      return;
    }
    enteredRoom(res.code);
  }

  // The server sends this room's state and chat history before it acknowledges the join,
  // so keep them; only drop state that belongs to a different room.
  function enteredRoom(code) {
    if (state && state.code !== code) state = prev = null;
    currentRoom = code;
    setUrlRoom(code);
    $('#room-code').textContent = code;
    show('table');
    renderTable(); // re-layout now that the table is visible
  }

  // ---------- socket ----------
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('connect', () => {
      if (currentRoom) joinRoom(currentRoom); // rejoin after a dropped connection
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') logoutLocal();
    });
    socket.on('seated-in', (code) => {
      if (!currentRoom) joinRoom(code);
    });
    socket.on('wallet', setWallet);
    socket.on('state', (s) => {
      serverOffset = s.serverTime - Date.now();
      prev = state && state.code === s.code ? state : null;
      state = s;
      renderTable();
    });
    socket.on('history', ({ chat, log }) => {
      $('#chat-list').innerHTML = '';
      $('#log-list').innerHTML = '';
      chat.forEach(addChat);
      log.forEach(addLog);
    });
    socket.on('chat', addChat);
    socket.on('log', addLog);
    socket.on('emote', onEmote);
  }

  // ---------- chat, log, emotes ----------
  function scrollFeed(feed) {
    feed.scrollTop = feed.scrollHeight;
  }
  function addChat(m, cls) {
    const line = el('div', 'msg' + (typeof cls === 'string' ? ' ' + cls : ''));
    line.append(el('b', null, m.username + ': '), document.createTextNode(m.text));
    $('#chat-list').append(line);
    scrollFeed($('#chat-list'));
  }
  function addLog(msg) {
    const line = el('div', 'log-line' + (msg.startsWith('---') ? ' sep' : ''), msg);
    $('#log-list').append(line);
    scrollFeed($('#log-list'));
  }
  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text || !socket) return;
    socket.emit('chat', text);
    $('#chat-input').value = '';
  });
  for (const tab of $$('.side-tabs .tab')) {
    tab.addEventListener('click', () => {
      $$('.side-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      $('#chat-list').classList.toggle('hidden', tab.dataset.side !== 'chat');
      $('#log-list').classList.toggle('hidden', tab.dataset.side !== 'log');
      scrollFeed($(tab.dataset.side === 'chat' ? '#chat-list' : '#log-list'));
    });
  }

  function buildEmotePicker() {
    const picker = $('#emote-picker');
    picker.innerHTML = '';
    for (const e of config.emotes) {
      const b = el('button', null, e);
      b.addEventListener('click', () => {
        if (socket) socket.emit('emote', e);
        picker.classList.add('hidden');
      });
      picker.append(b);
    }
  }
  $('#emote-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#emote-picker').classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.emote-wrap')) $('#emote-picker').classList.add('hidden');
  });

  function onEmote({ username, emoji }) {
    const i = state ? state.seats.findIndex((p) => p && p.username === username) : -1;
    if (i !== -1) FX.emote(seatUI[i].node, emoji);
    else addChat({ username, text: emoji }, 'emote-msg');
  }

  // ---------- table chrome ----------
  $('#leave-btn').addEventListener('click', async () => {
    const seated = state && state.you;
    if (seated && !confirmAction('Leave the table? Your chips go back to your account (if you are in a hand, you fold).')) return;
    await emit('leave-room');
    showLobby();
  });

  $('#copy-link-btn').addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}?room=${currentRoom}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
    } catch {
      prompt('Copy this link:', url);
    }
  });

  const THEMES = ['green', 'blue', 'red', 'purple', 'black'];
  function applyTheme(t) {
    $('#table-wrap').dataset.theme = t;
    store.set('pokerTheme', t);
  }
  applyTheme(THEMES.includes(store.get('pokerTheme')) ? store.get('pokerTheme') : 'green');
  $('#theme-btn').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf($('#table-wrap').dataset.theme) + 1) % THEMES.length];
    applyTheme(next);
    toast(`Table color: ${next}`);
  });

  function applyMute(m) {
    FX.setMuted(m);
    store.set('pokerMuted', m ? '1' : null);
    $('#sound-btn').textContent = m ? '🔇' : '🔊';
  }
  applyMute(store.get('pokerMuted') === '1');
  $('#sound-btn').addEventListener('click', () => applyMute(!FX.muted));

  // ---------- cards & chips ----------
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardEl(code) {
    if (!code || code === '??') return el('div', 'card back');
    const c = el('div', 'card' + (code[1] === 'h' || code[1] === 'd' ? ' red' : ''));
    c.dataset.card = code;
    c.append(el('span', 'r', code[0] === 'T' ? '10' : code[0]), el('span', 's', SUIT[code[1]]), el('span', 'big', SUIT[code[1]]));
    return c;
  }

  const CHIP_COLORS = [[1000, '#1b1b1b'], [500, '#8e4ec6'], [100, '#2a3a9e'], [25, '#1f8f53'], [5, '#c0282e'], [1, '#d9d9d9']];
  function chipStack(amount) {
    const wrap = el('div', 'chipstack');
    const discs = [];
    let rem = amount;
    for (const [v, c] of CHIP_COLORS) {
      while (rem >= v && discs.length < 5) {
        discs.push(c);
        rem -= v;
      }
    }
    discs.forEach((c, i) => {
      const d = el('div', 'chipdisc');
      d.style.background = c;
      d.style.top = -i * 3 + 'px';
      wrap.append(d);
    });
    return wrap;
  }

  function applyHighlight(container, highlight) {
    for (const c of container.querySelectorAll('.card')) {
      c.classList.toggle('highlight', !!highlight && highlight.has(c.dataset.card));
      c.classList.toggle('dim', !!highlight && !!c.dataset.card && !highlight.has(c.dataset.card));
    }
  }

  // ---------- seat layout ----------
  // positions (in % of the table box), index 0 = bottom centre, going clockwise
  const WIDE = [[50, 102], [17, 94], [-2, 62], [3, 18], [30, -4], [70, -4], [97, 18], [102, 62], [83, 94]];
  const TALL = [[50, 101], [9, 86], [1, 58], [3, 26], [26, 1], [74, 1], [97, 26], [99, 58], [91, 86]];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  const seatUI = [];
  let dealerNode;
  (function buildSeats() {
    const seatsEl = $('#seats');
    for (let i = 0; i < 9; i++) {
      const node = el('div', 'seat');
      const hole = el('div', 'hole');
      const avWrap = el('div', 'av-wrap');
      const ring = el('div', 'ring');
      const avatar = el('div', 'avatar');
      avWrap.append(ring, avatar);
      const plate = el('div', 'plate');
      const tag = el('div', 'tag');
      const name = el('div', 'name');
      const stack = el('div', 'stack');
      plate.append(tag, name, stack);
      node.append(hole, avWrap, plate);
      avWrap.addEventListener('click', () => {
        if (node.classList.contains('empty')) openBuyIn('sit', i);
      });
      const bet = el('div', 'bet hidden');
      seatsEl.append(node, bet);
      seatUI.push({ node, hole, avatar, ring, name, stack, tag, bet, avKey: '', holeKey: '', betAmt: -1 });
    }
    dealerNode = el('div', 'dealer-btn hidden', 'D');
    seatsEl.append(dealerNode);
  })();

  const IN_HAND = ['preflop', 'flop', 'turn', 'river'];

  function renderTable() {
    if (!state) return;
    const s = state;
    const wrap = $('#table-wrap');
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const layout = H > W ? TALL : WIDE;
    const pivot = s.you ? s.you.seat : 0;
    const posOf = (seat) => layout[(seat - pivot + 9) % 9];
    const newHand = !prev || prev.handNumber !== s.handNumber;

    $('#blinds-info').textContent = `Blinds ${fmt(s.smallBlind)} / ${fmt(s.bigBlind)}`;

    // winning cards get highlighted after a showdown
    let highlight = null;
    const winners = new Map();
    if (s.phase === 'showdown' && s.lastResult) {
      for (const w of s.lastResult.winners) winners.set(w.username, w);
      const main = s.lastResult.winners.find((w) => w.cards);
      if (main) highlight = new Set(main.cards);
    }

    renderBoard(s, highlight);

    const pot = $('#pot');
    pot.innerHTML = '';
    if (s.totalPot > 0 && s.phase !== 'showdown') {
      pot.append(chipStack(s.totalPot), el('span', null, 'Pot ' + fmt(s.totalPot)));
    }

    const status = $('#status');
    status.innerHTML = '';
    const seatedCount = s.seats.filter(Boolean).length;
    if (s.phase === 'showdown' && s.lastResult) {
      for (const w of s.lastResult.winners) {
        status.append(el('div', 'win', `${w.username} wins ${fmt(w.amount)}${w.hand ? ' with ' + w.hand : ''}`));
      }
    } else if (s.phase === 'waiting') {
      status.textContent = seatedCount < 2
        ? `Room ${s.code} — waiting for players… share the code!`
        : 'Waiting for the next hand…';
    }

    let chipSound = false;
    for (let i = 0; i < 9; i++) {
      const ui = seatUI[i];
      const p = s.seats[i];
      const pos = posOf(i);
      ui.node.style.left = pos[0] + '%';
      ui.node.style.top = pos[1] + '%';

      if (!p) {
        ui.node.className = 'seat empty' + (s.you ? ' hidden-seat' : '');
        if (ui.avKey !== 'empty') {
          ui.avatar.removeAttribute('style');
          ui.avatar.textContent = '+';
          ui.avKey = 'empty';
        }
        ui.name.textContent = 'Sit here';
        ui.stack.textContent = '';
        ui.tag.className = 'tag';
        ui.hole.innerHTML = '';
        ui.holeKey = '';
        ui.bet.classList.add('hidden');
        ui.betAmt = -1;
        continue;
      }

      const cls = ['seat'];
      if (s.you && s.you.seat === i) cls.push('me');
      if (s.toAct === i) cls.push('acting');
      if (p.folded) cls.push('folded');
      if (!p.connected) cls.push('away');
      if (p.sittingOut && !p.inHand) cls.push('out');
      if (winners.has(p.username)) cls.push('winner');
      ui.node.className = cls.join(' ');

      const avKey = JSON.stringify(p.avatar);
      if (ui.avKey !== avKey) {
        fillAvatar(ui.avatar, p.avatar);
        ui.avKey = avKey;
      }
      ui.name.textContent = p.username;
      ui.stack.textContent = fmt(p.stack);

      let label = p.lastAction;
      if (p.sittingOut && !p.inHand) label = 'Sitting out';
      ui.tag.textContent = label || '';
      ui.tag.className = 'tag' + (label ? ' show' : '')
        + (label === 'Fold' ? ' fold' : '')
        + (label === 'All-in' ? ' allin' : '')
        + (/^(Bet|Raise)/.test(label || '') ? ' raise' : '');

      // hole cards
      const holeKey = s.handNumber + ':' + p.cards.join(',');
      if (ui.holeKey !== holeKey) {
        const dealing = newHand && p.cards.length > 0 && IN_HAND.includes(s.phase);
        ui.hole.innerHTML = '';
        p.cards.forEach((c, k) => {
          const card = cardEl(c);
          if (dealing) {
            card.classList.add('deal');
            card.style.setProperty('--dx', ((50 - pos[0]) / 100) * W + 'px');
            card.style.setProperty('--dy', ((50 - pos[1]) / 100) * H + 'px');
            card.style.animationDelay = (k * 9 + ((i - s.dealer + 9) % 9)) * 45 + 'ms';
          }
          ui.hole.append(card);
        });
        ui.holeKey = holeKey;
      }
      applyHighlight(ui.hole, winners.has(p.username) ? highlight : null);

      // bet in front of the player
      if (p.bet > 0) {
        const bp = lerp(pos, [50, 50], H > W ? 0.42 : 0.38);
        ui.bet.style.left = bp[0] + '%';
        ui.bet.style.top = bp[1] + '%';
        if (ui.betAmt !== p.bet) {
          if (p.bet > ui.betAmt && ui.betAmt >= 0) chipSound = true;
          ui.bet.innerHTML = '';
          ui.bet.append(chipStack(p.bet), el('span', null, fmt(p.bet)));
          ui.betAmt = p.bet;
        }
        ui.bet.classList.remove('hidden');
      } else {
        ui.bet.classList.add('hidden');
        ui.betAmt = 0;
      }
    }

    // dealer button slides between seats
    if (s.dealer >= 0 && s.handNumber > 0 && s.seats[s.dealer]) {
      // sits beside the avatar, on the side facing the middle of the table
      const pos = posOf(s.dealer);
      const side = pos[0] > 50 ? -1 : 1;
      const dx = side * (H > W ? 34 : 44);
      dealerNode.style.left = `calc(${pos[0]}% + ${dx}px)`;
      dealerNode.style.top = `${pos[1]}%`;
      dealerNode.classList.remove('hidden');
    } else dealerNode.classList.add('hidden');

    const specs = s.spectators || [];
    $('#spectators').textContent = specs.length ? '👀 Watching: ' + specs.join(', ') : '';

    renderActions();
    updateTimers();
    playEvents(s, winners, chipSound, newHand);
  }

  let boardCards = [];
  function renderBoard(s, highlight) {
    const board = $('#board');
    const same = s.board.length >= boardCards.length && boardCards.every((c, i) => s.board[i] === c);
    if (!same) {
      board.innerHTML = '';
      boardCards = [];
    }
    const fresh = s.board.slice(boardCards.length);
    fresh.forEach((c, k) => {
      const card = cardEl(c);
      card.classList.add('flip');
      card.style.animationDelay = k * 110 + 'ms';
      board.append(card);
      setTimeout(() => FX.sound('card'), k * 110);
    });
    boardCards = s.board.slice();
    applyHighlight(board, highlight);
  }

  // Sounds and effects that react to changes between two states.
  function playEvents(s, winners, chipSound, newHand) {
    if (chipSound) FX.sound('chip');
    if (newHand && prev && IN_HAND.includes(s.phase)) {
      for (let k = 0; k < 4; k++) setTimeout(() => FX.sound('card'), k * 90);
    }
    const myTurn = !!(s.you && s.you.myTurn);
    if (myTurn && !(prev && prev.you && prev.you.myTurn)) {
      FX.sound('turn');
      if (navigator.vibrate) navigator.vibrate(120);
    }

    if (s.phase === 'showdown' && s.lastResult && celebratedHand !== s.handNumber) {
      celebratedHand = s.handNumber;
      if (!prev) return; // just joined: don't replay an old celebration
      const best = s.lastResult.winners.reduce((b, w) => ((w.rank ?? -1) > (b.rank ?? -1) ? w : b));
      const rank = best.rank ?? -1;
      // Straight or better calls in an airstrike; the chips fly out of the impact.
      const impactMs = FX.celebrate({
        rank,
        boardRect: centerOf($('#board')),
        tableRect: centerOf($('#table-wrap')),
        layer: $('#fx-layer'),
        tableEl: $('#table-wrap'),
        // things the shockwave shoves around
        knockables: [...$$('#seats .seat:not(.empty)'), ...$$('#board .card'), $('#pot'), ...$$('#seats .bet:not(.hidden)'), dealerNode],
        winner: { name: best.username, amount: best.amount },
      });
      const big = FX.hasEffect(rank);
      const hand = s.handNumber;
      setTimeout(() => {
        if (!state || state.handNumber !== hand) return;
        const origin = centerOf($('#board'));
        for (const w of s.lastResult.winners) {
          const i = state.seats.findIndex((p) => p && p.username === w.username);
          if (i === -1) continue;
          FX.flyChips(origin, centerOf(seatUI[i].avatar), big ? 10 : 6);
          if (big) {
            const amt = el('div', 'win-amount', '+' + fmt(w.amount));
            seatUI[i].node.append(amt);
            setTimeout(() => amt.remove(), 1900);
          }
        }
      }, impactMs);
    }
  }

  function updateTimers() {
    if (!state) return;
    const now = Date.now() + serverOffset;
    for (let i = 0; i < 9; i++) {
      const ui = seatUI[i];
      if (state.toAct !== i) continue;
      const total = state.turnMs || 30000;
      const p = Math.max(0, Math.min(1, (state.turnDeadline - now) / total));
      ui.ring.style.setProperty('--p', p.toFixed(3));
      ui.ring.style.setProperty('--ring-color', p > 0.5 ? '#2fbf71' : p > 0.25 ? '#f2c14e' : '#e5484d');
    }
  }
  setInterval(updateTimers, 100);
  window.addEventListener('resize', () => renderTable());

  // ---------- action bar ----------
  let raiseDraft = null; // keeps the slider value between re-renders of the same turn

  function renderActions() {
    const bar = $('#action-bar');
    bar.innerHTML = '';
    const s = state;
    const you = s.you;

    if (!you) {
      bar.append(el('span', 'muted', 'You are watching. Tap an empty seat (+) to join the game.'));
      raiseDraft = null;
      return;
    }
    const mine = s.seats[you.seat];

    if (you.hand) bar.append(el('span', 'hand-name', you.hand));

    if (you.myTurn) {
      const fold = el('button', 'btn danger', 'Fold');
      fold.addEventListener('click', () => act('fold'));
      bar.append(fold);

      if (you.toCall === 0) {
        const check = el('button', 'btn', 'Check');
        check.addEventListener('click', () => act('check'));
        bar.append(check);
      } else {
        const call = el('button', 'btn', `Call ${fmt(you.toCall)}${you.toCall >= mine.stack ? ' (all-in)' : ''}`);
        call.addEventListener('click', () => act('call'));
        bar.append(call);
      }

      if (you.canRaise) {
        const box = el('div', 'raise-box');
        const min = you.minRaiseTo;
        const max = you.maxRaiseTo;
        if (raiseDraft == null || raiseDraft < min || raiseDraft > max) raiseDraft = min;

        const range = el('input');
        range.type = 'range';
        range.min = min;
        range.max = max;
        range.step = 1;
        const num = el('input', 'amount-input');
        num.type = 'number';
        num.min = min;
        num.max = max;
        const verb = s.currentBet === 0 ? 'Bet' : 'Raise to';
        const raiseBtn = el('button', 'btn primary');
        const setVal = (v) => {
          v = Math.max(min, Math.min(max, Math.round(Number(v) || min)));
          raiseDraft = v;
          range.value = v;
          num.value = v;
          raiseBtn.textContent = v >= max ? 'All-in ' + fmt(v) : `${verb} ${fmt(v)}`;
        };
        range.addEventListener('input', () => setVal(range.value));
        num.addEventListener('change', () => setVal(num.value));
        raiseBtn.addEventListener('click', () => act('raise', raiseDraft));

        const potAfterCall = s.totalPot + you.toCall;
        const quick = [
          ['½ Pot', s.currentBet + Math.floor(potAfterCall / 2)],
          ['Pot', s.currentBet + potAfterCall],
          ['All-in', max],
        ];
        for (const [label, v] of quick) {
          const b = el('button', 'btn tiny', label);
          b.addEventListener('click', () => setVal(v));
          box.append(b);
        }
        setVal(raiseDraft);
        box.append(range, num, raiseBtn);
        bar.append(box);
      }
      return;
    }

    raiseDraft = null;
    const inHand = mine.inHand && !mine.folded && IN_HAND.includes(s.phase);
    if (inHand) bar.append(el('span', 'muted', 'Waiting for your turn…'));

    if (mine.sittingOut) {
      const back = el('button', 'btn primary', "I'm back");
      back.addEventListener('click', () => emit('sit-out', { value: false }));
      bar.append(back);
    } else {
      const out = el('button', 'btn ghost', 'Sit out next hand');
      out.addEventListener('click', () => emit('sit-out', { value: true }));
      bar.append(out);
    }
    if (!inHand) {
      const add = el('button', 'btn' + (mine.stack === 0 ? ' gold' : ''), mine.stack === 0 ? 'Rebuy' : 'Add chips');
      add.addEventListener('click', () => openBuyIn('add'));
      bar.append(add);
    }
    const stand = el('button', 'btn ghost', 'Stand up');
    stand.addEventListener('click', async () => {
      if (inHand && !confirmAction('Stand up? You will fold this hand.')) return;
      emit('stand');
    });
    bar.append(stand);
  }

  async function act(type, amount) {
    const res = await emit('action', { type, amount });
    if (res.error) toast(res.error);
  }

  // ---------- buy-in dialog ----------
  let buyInMode = null;
  let buyInSeat = null;

  function openBuyIn(mode, seat) {
    if (!me || !state) return;
    buyInMode = mode;
    buyInSeat = seat;
    const bb = state.bigBlind;
    const wallet = me.chips;
    $('#buyin-error').textContent = '';
    if (wallet < bb) {
      toast(`You need at least ${fmt(bb)} chips. Go to the lobby for your daily reward or free chips.`);
      return;
    }
    const min = Math.min(wallet, bb * 10);
    const max = wallet;
    const def = Math.min(wallet, bb * 50);
    $('#buyin-title').textContent = mode === 'sit' ? 'Buy in' : 'Add chips';
    $('#buyin-hint').textContent = `You have ${fmt(wallet)} chips in your account. Blinds are ${fmt(state.smallBlind)} / ${fmt(bb)}.`;
    $('#buyin-confirm').textContent = mode === 'sit' ? 'Sit down' : 'Add chips';
    const range = $('#buyin-range');
    const num = $('#buyin-amount');
    range.min = num.min = mode === 'sit' ? min : 1;
    range.max = num.max = max;
    range.value = num.value = def;
    $('#buyin-dialog').showModal();
  }

  $('#buyin-range').addEventListener('input', () => ($('#buyin-amount').value = $('#buyin-range').value));
  $('#buyin-amount').addEventListener('input', () => ($('#buyin-range').value = $('#buyin-amount').value));

  $('#buyin-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') {
      $('#buyin-dialog').close();
      return;
    }
    e.preventDefault();
    const amount = Math.floor(Number($('#buyin-amount').value));
    const res = buyInMode === 'sit'
      ? await emit('sit', { seat: buyInSeat, buyIn: amount })
      : await emit('add-chips', { amount });
    if (res.error) {
      $('#buyin-error').textContent = res.error;
      return;
    }
    $('#buyin-dialog').close();
  });

  // ---------- win effect preview (lobby) ----------
  const PREVIEWS = [[4, 'Straight', 'Sniper'], [5, 'Flush', 'Strafing run'], [6, 'Full House', 'Missile strike'],
    [7, 'Four of a Kind', 'Carpet bombing'], [8, 'Straight Flush', 'Barrage'], [9, 'Royal Flush', 'Nuke']];
  for (const [rank, name, what] of PREVIEWS) {
    const b = el('button', 'btn');
    b.append(el('span', null, name), el('small', null, what));
    b.addEventListener('click', () => {
      const w = innerWidth;
      const h = innerHeight;
      const area = { left: w * 0.08, right: w * 0.92, top: h * 0.2, bottom: h * 0.8, width: w * 0.84, height: h * 0.6 };
      const c = { left: w / 2 - 40, top: h * 0.55 - 20, width: 80, height: 40 };
      FX.celebrate({
        rank, boardRect: c, tableRect: area, layer: $('#fx-global'), tableEl: $('.lobby-grid'),
        knockables: $$('.lobby-grid .panel'), winner: { name: me ? me.username : 'You', amount: 1337 },
      });
    });
    $('#arsenal').append(b);
  }

  // ---------- sandbox (local test mode) ----------
  function setupSandbox() {
    document.body.classList.add('sandbox');
    document.body.append(el('div', 'sandbox-badge', '🧪 SANDBOX'));

    // one-click logins for the test accounts
    const hint = $('#auth-hint');
    if (config.testAccounts.length) {
    hint.textContent = `Sandbox: test accounts ${config.testAccounts.join(', ')} (password: ${config.testPassword}). Every tab can use a different one.`;
    const quick = el('div', 'row sandbox-logins');
    for (const name of config.testAccounts) {
      const b = el('button', 'btn tiny', 'Log in as ' + name);
      b.addEventListener('click', async () => {
        try {
          const data = await api('/api/login', { username: name, password: config.testPassword });
          setToken(data.token);
          onLoggedIn(data.user);
        } catch (err) {
          $('#auth-error').textContent = err.message;
        }
      });
      quick.append(b);
    }
    hint.after(quick);
    }

    // table tools: bots and rigged hands
    const tools = el('span', 'sandbox-tools');
    const addBot = el('button', 'btn tiny', '🤖 Add bot');
    addBot.addEventListener('click', async () => {
      const res = await emit('sandbox-add-bot');
      toast(res.error || `${res.name} joined the table`);
    });
    const removeBots = el('button', 'btn tiny', '🧹 Remove bots');
    removeBots.addEventListener('click', () => emit('sandbox-remove-bots'));
    const rig = el('select', 'sandbox-rig');
    rig.append(new Option('🎯 Rig my next hand…', ''));
    for (const r of config.rigs) rig.append(new Option(r.name, r.rank));
    rig.addEventListener('change', async () => {
      if (!rig.value) return;
      const res = await emit('sandbox-rig', { rank: Number(rig.value) });
      toast(res.error || `Your next hand: ${res.name}. Play it to the showdown!`);
      rig.value = '';
    });
    tools.append(addBot, removeBots, rig);
    $('#blinds-info').after(tools);

    // lobby tools: skip time, free chips
    const lobby = el('div', 'row sandbox-lobby');
    const warp = el('button', 'btn tiny', '⏩ Skip 12 hours');
    warp.addEventListener('click', async () => {
      const { user } = await api('/api/sandbox/time-warp', {});
      setWallet(user);
      loadMiners();
      toast('12 hours later… miners have been busy and the daily reward is back.');
    });
    const chips = el('button', 'btn tiny', '💰 +10,000 chips');
    chips.addEventListener('click', async () => {
      const { user } = await api('/api/sandbox/chips', {});
      setWallet(user);
      loadLeaderboard();
    });
    lobby.append(el('span', 'muted small', '🧪 Sandbox:'), warp, chips);
    $('#reward-error').before(lobby);
  }

  // ---------- offline edition (single HTML file): you against bots ----------
  // HTML previews may sandbox the page so that forms can't be submitted at all; submit
  // them ourselves (on click and on Enter) so every form keeps working there.
  function installFormFallback() {
    const submit = (form, submitter) => {
      if (!(submitter && submitter.formNoValidate) && !form.noValidate && !form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const ev = typeof SubmitEvent === 'function'
        ? new SubmitEvent('submit', { cancelable: true, submitter: submitter || null })
        : new Event('submit', { cancelable: true });
      form.dispatchEvent(ev);
    };
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn || !btn.form || btn.type !== 'submit') return;
      e.preventDefault();
      submit(btn.form, btn);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const input = e.target.closest && e.target.closest('input');
      if (!input || !input.form || input.type === 'button') return;
      e.preventDefault();
      submit(input.form, input.form.querySelector('button[type=submit], button:not([type])'));
    }, true);
  }

  function setupOffline() {
    document.body.classList.add('offline');
    installFormFallback();
    // a profile is just a name, kept in this browser
    authMode = 'register';
    $('.auth-panel .tabs').classList.add('hidden');
    $('#forgot-link').classList.add('hidden');
    const pw = $('#auth-password');
    pw.required = false;
    pw.value = 'offline';
    pw.classList.add('hidden');
    $('#auth-username').placeholder = 'Your name (letters, numbers or _)';
    $('#auth-submit').textContent = 'Start playing';
    $('#auth-hint').textContent = config.persistent
      ? 'Offline edition: you play against bots. Your chips are saved in this browser.'
      : 'Offline edition: you play against bots. This browser blocks storage, so progress resets when you close the page.';
    $('#logout-btn').textContent = 'Switch player';
    $('#create-title').textContent = 'Start a table';
    $('#create-btn').textContent = 'Start table (3 bots join)';
    $('.sandbox-badge').textContent = '🤖 OFFLINE vs BOTS';
  }

  // ---------- boot ----------
  async function boot() {
    try {
      config = await api('/api/config');
    } catch {}
    token = (() => {
      try {
        return tokenStore().getItem('pokerToken');
      } catch {
        return null;
      }
    })();
    if (config.sandbox) setupSandbox();
    if (config.offline) setupOffline();
    buildEmotePicker();
    const code = roomFromUrl();
    if (code) $('#join-code').value = code;
    if (!token) return show('auth');
    try {
      const { user } = await api('/api/me');
      onLoggedIn(user);
    } catch {
      logoutLocal();
    }
  }
  boot();
})();
