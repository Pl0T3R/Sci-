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
  const fmt = (n) => Number(n).toLocaleString('en-US');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  let token = store.get('pokerToken');
  let me = null; // { username, chips, inPlay, canRefill }
  let socket = null;
  let currentRoom = null;
  let state = null;
  let serverOffset = 0;
  let wasMyTurn = false;
  let authMode = 'login';

  // ---------- helpers ----------
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

  function setWallet(user) {
    me = user;
    for (const e of $$('.wallet-amount')) e.textContent = fmt(user.chips);
    $('#lobby-user').textContent = user.username;
    $('#refill-btn').classList.toggle('hidden', !user.canRefill);
  }

  function roomFromUrl() {
    const code = new URLSearchParams(location.search).get('room');
    return code ? code.toUpperCase() : null;
  }

  function setUrlRoom(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  // ---------- audio ----------
  let audioCtx;
  function beep() {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.25);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.25);
    } catch {}
    if (navigator.vibrate) navigator.vibrate(120);
  }

  // ---------- auth ----------
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
      token = data.token;
      store.set('pokerToken', token);
      $('#auth-password').value = '';
      onLoggedIn(data.user);
    } catch (err) {
      $('#auth-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch {}
    token = null;
    store.set('pokerToken', null);
    if (socket) socket.disconnect();
    socket = null;
    show('auth');
  });

  function onLoggedIn(user) {
    setWallet(user);
    connectSocket();
    const code = roomFromUrl();
    if (code) {
      joinRoom(code);
    } else {
      showLobby();
    }
  }

  // ---------- lobby ----------
  async function showLobby() {
    currentRoom = null;
    state = null;
    setUrlRoom(null);
    show('lobby');
    try {
      const [{ user }, { leaders }] = await Promise.all([api('/api/me'), api('/api/leaderboard')]);
      setWallet(user);
      const list = $('#leaderboard');
      list.innerHTML = '';
      for (const l of leaders) {
        const li = el('li');
        li.append(el('span', null, l.username), el('b', null, fmt(l.chips)));
        list.append(li);
      }
    } catch (err) {
      if (err.status === 401) return logoutLocal();
    }
  }

  function logoutLocal() {
    token = null;
    store.set('pokerToken', null);
    if (socket) socket.disconnect();
    socket = null;
    show('auth');
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
    toast(`Room ${res.code} created — share the code with your friends!`);
  });

  $('#refill-btn').addEventListener('click', async () => {
    $('#refill-error').textContent = '';
    try {
      const { user } = await api('/api/refill', {});
      setWallet(user);
      toast('500 chips added!');
    } catch (err) {
      $('#refill-error').textContent = err.message;
    }
  });

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

  function enteredRoom(code) {
    currentRoom = code;
    setUrlRoom(code);
    $('#room-code').textContent = code;
    $('#chat-list').innerHTML = '';
    $('#log-list').innerHTML = '';
    show('table');
  }

  // ---------- socket ----------
  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('connect', () => {
      // rejoin after a dropped connection
      if (currentRoom) joinRoom(currentRoom);
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
  }

  // ---------- chat & log ----------
  function scrollFeed(feed) {
    feed.scrollTop = feed.scrollHeight;
  }
  function addChat(m) {
    const line = el('div', 'msg');
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

  // ---------- table top bar ----------
  $('#leave-btn').addEventListener('click', async () => {
    const seated = state && state.you;
    if (seated && !confirm('Leave the table? Your chips go back to your account (if you are in a hand, you fold).')) return;
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

  // ---------- cards ----------
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardEl(code, highlightSet) {
    if (!code || code === '??') return el('div', 'card back');
    const c = el('div', 'card' + (code[1] === 'h' || code[1] === 'd' ? ' red' : ''));
    c.append(el('span', 'rank', code[0] === 'T' ? '10' : code[0]), el('span', 'suit', SUIT[code[1]]));
    if (highlightSet) c.classList.add(highlightSet.has(code) ? 'highlight' : 'dim');
    return c;
  }

  // ---------- seat layout ----------
  // positions (in % of the table box), index 0 = bottom centre, going clockwise
  const WIDE = [[50, 103], [17, 95], [-3, 62], [3, 18], [30, -5], [70, -5], [97, 18], [103, 62], [83, 95]];
  const TALL = [[50, 102], [10, 88], [3, 62], [3, 32], [24, 3], [76, 3], [97, 32], [97, 62], [90, 88]];

  function lerp(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function renderTable() {
    if (!state) return;
    const s = state;
    const wrap = $('.table-wrap');
    const tall = wrap.clientHeight > wrap.clientWidth;
    const layout = tall ? TALL : WIDE;
    const pivot = s.you ? s.you.seat : 0;
    const posOf = (seat) => layout[(seat - pivot + 9) % 9];

    $('#blinds-info').textContent = `Blinds ${fmt(s.smallBlind)} / ${fmt(s.bigBlind)}`;

    // highlight winning cards after a showdown
    let highlight = null;
    const winners = new Set();
    if (s.phase === 'showdown' && s.lastResult) {
      for (const w of s.lastResult.winners) winners.add(w.username);
      const main = s.lastResult.winners.find((w) => w.cards);
      if (main) highlight = new Set(main.cards);
    }

    // board
    const board = $('#board');
    const boardKey = s.board.join(',') + '|' + (highlight ? [...highlight].join(',') : '');
    if (board.dataset.key !== boardKey) {
      board.dataset.key = boardKey;
      board.innerHTML = '';
      for (const c of s.board) board.append(cardEl(c, highlight));
    }

    const pot = $('#pot');
    pot.innerHTML = '';
    if (s.totalPot > 0 && s.phase !== 'showdown') {
      pot.append(el('span', 'chip-icon'), el('span', null, 'Pot ' + fmt(s.totalPot)));
    }

    // status line
    const status = $('#status');
    status.innerHTML = '';
    const seatedCount = s.seats.filter(Boolean).length;
    if (s.phase === 'showdown' && s.lastResult) {
      for (const w of s.lastResult.winners) {
        const line = el('div', 'win', `${w.username} wins ${fmt(w.amount)}${w.hand ? ' with ' + w.hand : ''}`);
        status.append(line);
      }
    } else if (s.phase === 'waiting') {
      status.textContent = seatedCount < 2
        ? `Room ${s.code} — waiting for players… share the code!`
        : 'Waiting for the next hand…';
    }

    // seats
    const seatsEl = $('#seats');
    seatsEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const p = s.seats[i];
      const pos = posOf(i);
      const node = el('div', 'seat');
      node.style.left = pos[0] + '%';
      node.style.top = pos[1] + '%';

      if (!p) {
        if (s.you) continue; // seated players don't need empty seat buttons
        node.classList.add('empty');
        const plate = el('div', 'plate');
        const btn = el('button', 'btn tiny', 'Sit here');
        btn.addEventListener('click', () => openBuyIn('sit', i));
        plate.append(btn);
        node.append(plate);
        seatsEl.append(node);
        continue;
      }

      if (s.you && s.you.seat === i) node.classList.add('me');
      if (s.toAct === i) node.classList.add('acting');
      if (p.folded) node.classList.add('folded');
      if (!p.connected) node.classList.add('away');
      if (winners.has(p.username)) node.classList.add('winner');

      const cards = el('div', 'cards');
      const myWinHighlight = highlight && winners.has(p.username) ? highlight : null;
      for (const c of p.cards) cards.append(cardEl(c, c !== '??' && myWinHighlight ? myWinHighlight : null));
      node.append(cards);

      const plate = el('div', 'plate');
      let label = p.lastAction;
      if (p.sittingOut && !p.inHand) label = 'Sitting out';
      if (label) plate.append(el('div', 'last-action', label));
      plate.append(el('div', 'name', p.username), el('div', 'stack', fmt(p.stack)));
      if (s.toAct === i) {
        const timer = el('div', 'timer');
        timer.dataset.deadline = s.turnDeadline;
        plate.append(timer);
      }
      node.append(plate);
      seatsEl.append(node);

      if (p.bet > 0) {
        const bp = lerp(pos, [50, 50], tall ? 0.5 : 0.4);
        const bet = el('div', 'bet');
        bet.style.left = bp[0] + '%';
        bet.style.top = bp[1] + '%';
        bet.append(el('span', 'chip-icon'), el('span', null, fmt(p.bet)));
        seatsEl.append(bet);
      }
      if (s.dealer === i && s.handNumber > 0) {
        const dp = lerp(pos, [50, 50], tall ? 0.3 : 0.27);
        const d = el('div', 'dealer-btn', 'D');
        d.style.left = (dp[0] + (pos[1] > 50 ? 8 : -8)) + '%';
        d.style.top = dp[1] + '%';
        seatsEl.append(d);
      }
    }

    const specs = s.spectators || [];
    $('#spectators').textContent = specs.length ? 'Watching: ' + specs.join(', ') : '';

    renderActions();
    updateTimers();

    const myTurn = !!(s.you && s.you.myTurn);
    if (myTurn && !wasMyTurn) beep();
    wasMyTurn = myTurn;
  }

  function updateTimers() {
    const now = Date.now() + serverOffset;
    for (const t of $$('.seat .timer')) {
      const deadline = Number(t.dataset.deadline);
      const left = Math.max(0, deadline - now);
      t.style.width = Math.min(100, (left / 30000) * 100) + '%';
      t.style.background = left < 8000 ? 'var(--red)' : '';
    }
  }
  setInterval(updateTimers, 250);
  window.addEventListener('resize', () => renderTable());

  // ---------- action bar ----------
  let raiseDraft = null; // keeps the slider value between re-renders of the same turn

  function renderActions() {
    const bar = $('#action-bar');
    bar.innerHTML = '';
    const s = state;
    const you = s.you;

    if (!you) {
      bar.append(el('span', 'muted', 'You are watching. Pick an empty seat to join the game.'));
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
        range.value = raiseDraft;
        const num = el('input', 'amount-input');
        num.type = 'number';
        num.min = min;
        num.max = max;
        num.value = raiseDraft;
        const verb = s.currentBet === 0 ? 'Bet' : 'Raise to';
        const raiseBtn = el('button', 'btn primary', `${verb} ${fmt(raiseDraft)}`);
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
    const inHand = mine.inHand && !mine.folded && ['preflop', 'flop', 'turn', 'river'].includes(s.phase);
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
      if (inHand && !confirm('Stand up? You will fold this hand.')) return;
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
    if (!me) return;
    buyInMode = mode;
    buyInSeat = seat;
    const bb = state.bigBlind;
    const wallet = me.chips;
    $('#buyin-error').textContent = '';
    if (wallet < bb) {
      toast(`You need at least ${fmt(bb)} chips. Go to the lobby to claim free chips.`);
      return;
    }
    const min = Math.min(wallet, bb * 10);
    const max = wallet;
    const def = Math.min(wallet, bb * 100);
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
    if (e.submitter && e.submitter.value === 'cancel') return;
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

  // ---------- boot ----------
  async function boot() {
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
