// Visual + sound effects: win celebrations (scaled by hand strength), chip flights,
// emote pops and small synthesized sounds. Every effect is over in ~2 seconds.
window.FX = (() => {
  'use strict';

  const canvas = document.getElementById('fx-canvas');
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PALETTE = ['#f2c14e', '#e5484d', '#2fbf71', '#3e63dd', '#d6409f', '#12a594', '#f76b15', '#ffffff'];
  const GOLD = ['#f2c14e', '#ffd978', '#fff3c4', '#e0a82e'];

  let dpr = 1;
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
  }
  resize();
  addEventListener('resize', resize);

  // ---------- particle system ----------
  let particles = [];
  let running = false;
  let last = 0;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  function add(p) {
    particles.push({
      age: 0, rot: rand(0, Math.PI * 2), vr: rand(-8, 8), g: 500, drag: 0.985, size: 8,
      shape: 'rect', color: pick(PALETTE), life: 1.4, ...p,
    });
    if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(tick);
    }
  }

  function star(x, y, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r;
      const a = (i * Math.PI) / 5 - Math.PI / 2;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => (p.age += dt) < p.life);
    for (const p of particles) {
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const t = p.age / p.life;
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.rot * 1.7)) + 1);
        ctx.restore();
      } else if (p.shape === 'spark') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.6), 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === 'star') {
        star(p.x, p.y, p.size * (1 - t * 0.4));
      } else if (p.shape === 'coin') {
        const w = Math.abs(Math.cos(p.rot)) * p.size + 1;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, w, p.size, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#b8860b';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, w * 0.6, p.size * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (particles.length) requestAnimationFrame(tick);
    else {
      running = false;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // ---------- emitters ----------
  function burst(x, y, { count = 40, colors = PALETTE, speed = [150, 450], shape = 'rect', size = [6, 11], life = [0.9, 1.5], g = 500, spread = Math.PI * 2, angle = -Math.PI / 2, drag = 0.975 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread / 2, spread / 2);
      const v = rand(speed[0], speed[1]);
      add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: pick(colors), shape, size: rand(size[0], size[1]), life: rand(life[0], life[1]), g, drag });
    }
  }

  function firework(x, y, colors) {
    const color = pick(colors || PALETTE);
    burst(x, y, { count: 55, colors: [color, '#fff'], shape: 'spark', size: [2, 3.5], speed: [120, 330], life: [0.8, 1.3], g: 160, drag: 0.955 });
  }

  function coinRain(rect, count) {
    for (let i = 0; i < count; i++) {
      add({
        x: rand(rect.left, rect.right), y: rect.top - rand(10, 200), vx: rand(-40, 40), vy: rand(150, 350),
        shape: 'coin', color: pick(GOLD), size: rand(6, 10), vr: rand(4, 10), g: 700, drag: 0.99, life: rand(1.2, 1.8),
      });
    }
  }

  // ---------- DOM effects ----------
  function banner(layer, text, tier) {
    if (!layer) return;
    const b = document.createElement('div');
    b.className = `win-banner tier-${tier}`;
    b.textContent = text;
    layer.append(b);
    setTimeout(() => b.remove(), 2300);
  }

  function shake(el) {
    if (!el || reducedMotion) return;
    el.animate([
      { transform: 'translate(0,0)' }, { transform: 'translate(-6px,3px)' }, { transform: 'translate(5px,-4px)' },
      { transform: 'translate(-4px,-2px)' }, { transform: 'translate(3px,3px)' }, { transform: 'translate(0,0)' },
    ], { duration: 420, easing: 'ease-out' });
  }

  function flash(color) {
    const f = document.createElement('div');
    f.className = 'screen-flash';
    f.style.background = `radial-gradient(circle, ${color}, transparent 70%)`;
    document.body.append(f);
    f.animate([{ opacity: 0 }, { opacity: 0.85 }, { opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => f.remove();
  }

  // Chips slide from the pot to a winner.
  function flyChips(from, to, count = 6) {
    if (!from || !to) return;
    const sx = from.left + from.width / 2;
    const sy = from.top + from.height / 2;
    const tx = to.left + to.width / 2;
    const ty = to.top + to.height / 2;
    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'fly-chip';
      c.style.background = pick(['#e5484d', '#3e63dd', '#2fbf71', '#111', '#f2c14e']);
      c.style.left = sx + 'px';
      c.style.top = sy + 'px';
      document.body.append(c);
      const ox = rand(-14, 14);
      const oy = rand(-10, 10);
      c.animate([
        { transform: `translate(${ox}px, ${oy}px) scale(1)`, opacity: 1 },
        { transform: `translate(${tx - sx + ox / 2}px, ${ty - sy + oy / 2}px) scale(.8)`, opacity: 1, offset: 0.85 },
        { transform: `translate(${tx - sx}px, ${ty - sy}px) scale(.5)`, opacity: 0 },
      ], { duration: 650, delay: i * 45, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'backwards' }).onfinish = () => c.remove();
    }
  }

  function emote(parent, emoji) {
    if (!parent) return;
    const e = document.createElement('div');
    e.className = 'emote-pop';
    e.textContent = emoji;
    parent.append(e);
    setTimeout(() => e.remove(), 2000);
    sound('pop');
  }

  // Win celebration; tier grows with hand strength (rank: -1 uncontested, 0 high card … 9 royal flush).
  function tierOf(rank) {
    if (rank >= 9) return 6;
    if (rank === 8) return 5;
    if (rank === 7) return 4;
    if (rank === 6) return 3;
    if (rank >= 4) return 2;
    if (rank >= 2) return 1;
    return 0;
  }

  function celebrate({ rank, handName, winnerRects = [], boardRect, tableRect, layer, tableEl }) {
    const tier = tierOf(rank);
    sound('win', tier);
    if (tier >= 2 && handName) banner(layer, handName + '!', tier);
    if (reducedMotion) return tier;

    const cx = boardRect ? boardRect.left + boardRect.width / 2 : innerWidth / 2;
    const cy = boardRect ? boardRect.top + boardRect.height / 2 : innerHeight / 2;
    const tr = tableRect || { left: 0, right: innerWidth, top: 0, bottom: innerHeight, width: innerWidth, height: innerHeight };

    if (tier >= 1) {
      for (const r of winnerRects) {
        burst(r.left + r.width / 2, r.top + r.height / 2, {
          count: tier === 1 ? 18 : 26, colors: GOLD, shape: 'star', size: [4, 7], speed: [80, 220], g: 120, life: [0.6, 1.0],
        });
      }
    }
    if (tier === 2) burst(cx, cy, { count: 70, speed: [200, 480], life: [0.9, 1.4] });
    if (tier >= 3) {
      const n = tier === 3 ? 60 : 45;
      burst(tr.left + 10, tr.bottom, { count: n, angle: -Math.PI / 3, spread: 0.7, speed: [450, 750], life: [1.1, 1.6] });
      burst(tr.right - 10, tr.bottom, { count: n, angle: (-2 * Math.PI) / 3, spread: 0.7, speed: [450, 750], life: [1.1, 1.6] });
    }
    if (tier >= 4) {
      shake(tableEl);
      coinRain(tr, tier === 4 ? 60 : 40);
    }
    if (tier >= 5) {
      const spots = [[0.3, 0.3], [0.7, 0.28], [0.5, 0.2], [0.2, 0.45]].slice(0, tier === 5 ? 3 : 4);
      spots.forEach(([fx, fy], i) => setTimeout(() => firework(tr.left + tr.width * fx, tr.top + tr.height * fy), i * 220));
    }
    if (tier >= 6) flash('#ffe08a');
    return tier;
  }

  // ---------- sounds ----------
  let ac = null;
  let muted = false;
  function audio() {
    if (muted) return null;
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch {
      return null;
    }
  }

  function tone(a, freq, start, dur, { type = 'sine', vol = 0.1, to } = {}) {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime + start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, a.currentTime + start + dur);
    g.gain.setValueAtTime(0.0001, a.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol, a.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
    o.connect(g).connect(a.destination);
    o.start(a.currentTime + start);
    o.stop(a.currentTime + start + dur + 0.02);
  }

  function noise(a, start, dur, { vol = 0.15, freq = 3000 } = {}) {
    const len = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = a.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(a.destination);
    src.start(a.currentTime + start);
  }

  const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093];
  function sound(name, tier = 0) {
    const a = audio();
    if (!a) return;
    try {
      if (name === 'turn') tone(a, 880, 0, 0.25, { vol: 0.12 });
      else if (name === 'card') noise(a, 0, 0.07, { vol: 0.25, freq: 4000 });
      else if (name === 'chip') {
        tone(a, 2600, 0, 0.05, { type: 'triangle', vol: 0.05 });
        tone(a, 3400, 0.04, 0.05, { type: 'triangle', vol: 0.04 });
      } else if (name === 'pop') tone(a, 420, 0, 0.1, { type: 'triangle', vol: 0.08, to: 900 });
      else if (name === 'coins') {
        for (let i = 0; i < 5; i++) tone(a, 2400 + Math.random() * 1200, i * 0.05, 0.08, { type: 'triangle', vol: 0.04 });
      } else if (name === 'win') {
        const n = Math.min(NOTES.length, 2 + tier);
        for (let i = 0; i < n; i++) tone(a, NOTES[i], i * 0.075, 0.3, { type: 'triangle', vol: 0.09 });
        if (tier >= 4) for (let i = 0; i < 6; i++) tone(a, 2000 + i * 180, 0.4 + i * 0.05, 0.2, { vol: 0.03 });
      }
    } catch {}
  }

  return {
    celebrate, flyChips, emote, sound, burst, coinRain,
    setMuted(v) { muted = !!v; },
    get muted() { return muted; },
  };
})();
