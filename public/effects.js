// Visual + sound effects. Big poker hands get military-themed celebrations
// (sniper → strafing run → missile strike → carpet bombing → barrage → nuke);
// basic hands only get chips flying to the winner. Sounds are synthesized.
window.FX = (() => {
  'use strict';

  const canvas = document.getElementById('fx-canvas');
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const PALETTE = ['#f2c14e', '#e5484d', '#2fbf71', '#3e63dd', '#d6409f', '#12a594', '#f76b15', '#ffffff'];
  const FIRE = ['#fff3b0', '#ffd25e', '#ff9a3c', '#ff6a1c', '#e8430c'];
  const SMOKE = ['#3a3a36', '#4a4a44', '#5c5a52', '#2e2d2a'];
  const SMOKE_BROWN = ['#5a4636', '#6b5646', '#4a3a2e', '#7a6656'];
  const DUST = ['#b8a27a', '#a08a64', '#8f7a58'];

  let dpr = 1;
  let quality = 1; // fewer particles on small screens
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    quality = innerWidth < 700 ? 0.6 : 1;
  }
  resize();
  addEventListener('resize', resize);

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const n = (count) => Math.max(1, Math.round(count * quality));

  // Soft round sprites, pre-rendered once per color (much faster than gradients per particle).
  const sprites = new Map();
  function sprite(hex) {
    if (sprites.has(hex)) return sprites.get(hex);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const v = parseInt(hex.slice(1), 16);
    const rgb = `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.45, `rgba(${rgb},.65)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites.set(hex, c);
    return c;
  }

  // ---------- engine: particles + actors ----------
  let particles = [];
  let actors = []; // { layer, step(dt) -> alive, draw() }
  let running = false;
  let last = 0;

  function wake() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }

  function add(p) {
    particles.push({
      age: 0, delay: 0, rot: rand(0, Math.PI * 2), vr: rand(-8, 8), g: 500, drag: 0.985, size: 8,
      kind: 'rect', color: pick(PALETTE), life: 1.4, alpha: 1, fadeAt: 0.7, ...p,
    });
    wake();
  }

  function actor(layer, step, draw) {
    actors.push({ layer, step, draw });
    wake();
  }

  function later(ms, fn) {
    setTimeout(fn, ms);
  }

  function drawParticle(p) {
    const t = p.age / p.life;
    ctx.globalAlpha = p.alpha * (t > p.fadeAt ? (1 - t) / (1 - p.fadeAt) : 1);
    ctx.globalCompositeOperation = p.blend || 'source-over';
    switch (p.kind) {
      case 'soft': {
        const r = p.size + ((p.size1 ?? p.size) - p.size) * easeOut(t);
        ctx.drawImage(sprite(p.color), p.x - r, p.y - r, r * 2, r * 2);
        break;
      }
      case 'streak':
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.size;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * (p.len || 0.03), p.y - p.vy * (p.len || 0.03));
        ctx.stroke();
        break;
      case 'debris':
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        ctx.restore();
        break;
      case 'coin': {
        const w = Math.abs(Math.cos(p.rot)) * p.size + 1;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, w, p.size, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#b8860b';
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, w * 0.6, p.size * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      default: // confetti rect
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.rot * 1.7)) + 1);
        ctx.restore();
    }
  }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, innerWidth, innerHeight);

    // Actors may spawn new actors while stepping (a missile's impact starts an explosion),
    // so step a snapshot and keep whatever was added meanwhile.
    const stepping = actors;
    actors = [];
    actors = stepping.filter((a) => a.step(dt) !== false).concat(actors);
    for (const a of actors) if (a.layer === 0) resetAnd(a.draw);

    particles = particles.filter((p) => {
      if (p.delay > 0) {
        p.delay -= dt;
        return true;
      }
      return (p.age += dt) < p.life;
    });
    for (const p of particles) {
      if (p.delay > 0) continue;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy = p.vy * drag + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      drawParticle(p);
    }
    for (const a of actors) if (a.layer === 1) resetAnd(a.draw);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (particles.length || actors.length) requestAnimationFrame(tick);
    else {
      running = false;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  function resetAnd(draw) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    draw();
  }

  // ---------- generic bursts (used by the lobby too) ----------
  function burst(x, y, { count = 40, colors = PALETTE, speed = [150, 450], shape = 'rect', size = [6, 11], life = [0.9, 1.5], g = 500, spread = Math.PI * 2, angle = -Math.PI / 2, drag = 0.975 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread / 2, spread / 2);
      const v = rand(speed[0], speed[1]);
      add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: pick(colors), kind: shape, size: rand(size[0], size[1]), life: rand(life[0], life[1]), g, drag });
    }
  }

  // ---------- building blocks ----------
  let shakeTarget = null;

  function shake(el, intensity = 1, duration = 450) {
    if (!el || reducedMotion) return;
    const frames = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const k = (1 - i / steps) * 9 * intensity;
      frames.push({
        transform: i === steps ? 'none' : `translate(${rand(-k, k)}px, ${rand(-k, k)}px) rotate(${rand(-k, k) * 0.06}deg)`,
      });
    }
    el.animate(frames, { duration, easing: 'linear' });
  }

  function screenFlash(color, duration = 500) {
    const f = document.createElement('div');
    f.className = 'screen-flash';
    f.style.background = color;
    document.body.append(f);
    f.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration, easing: 'ease-out' }).onfinish = () => f.remove();
  }

  function fireflash(x, y, R, dur) {
    let t = 0;
    actor(1, (dt) => (t += dt) < dur, () => {
      const u = t / dur;
      const r = R * (0.4 + 0.6 * easeOut(u));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1 - u;
      ctx.drawImage(sprite('#fff3c4'), x - r, y - r, r * 2, r * 2);
    });
  }

  // Shockwave; squashed into an ellipse so it lies flat on the table.
  function ring(x, y, R, dur, width, rgb = '255,244,214') {
    let t = 0;
    actor(1, (dt) => (t += dt) < dur, () => {
      const u = t / dur;
      const r = R * easeOut(u);
      ctx.globalAlpha = (1 - u) * 0.8;
      ctx.strokeStyle = `rgb(${rgb})`;
      ctx.lineWidth = width * (1 - u) + 1;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  // Scorch marks and bullet holes that fade away.
  function decal(x, y, r, dur, kind) {
    let t = 0;
    const cracks = kind === 'hole'
      ? Array.from({ length: 6 }, () => ({ a: rand(0, Math.PI * 2), l: rand(r * 1.6, r * 3.4) }))
      : null;
    actor(0, (dt) => (t += dt) < dur, () => {
      const a = t < dur * 0.5 ? 1 : 1 - (t - dur * 0.5) / (dur * 0.5);
      if (kind === 'scorch') {
        ctx.globalAlpha = a * 0.8;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.72);
        ctx.drawImage(sprite('#140c06'), -r, -r, r * 2, r * 2);
        ctx.restore();
        // glowing embers fade faster
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.max(0, 1 - t / (dur * 0.45)) * 0.6;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.72);
        ctx.drawImage(sprite('#ff6a1c'), -r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
        ctx.restore();
      } else {
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = '#0b0b0b';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const c of cracks) {
          ctx.moveTo(x, y);
          ctx.lineTo(x + Math.cos(c.a) * c.l, y + Math.sin(c.a) * c.l);
        }
        ctx.stroke();
      }
    });
  }

  // Pulsing red "target locked" marker on the felt.
  function targetLock(x, y, dur) {
    let t = 0;
    actor(0, (dt) => (t += dt) < dur, () => {
      const pulse = 0.5 + 0.5 * Math.sin(t * 22);
      const r = 26 + 16 * (1 - Math.min(1, t / 0.35));
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      ctx.strokeStyle = '#ff2d2d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.45, r * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x + dx * r * 0.8, y + dy * r * 0.58);
        ctx.lineTo(x + dx * r * 1.35, y + dy * r * 0.97);
        ctx.stroke();
      }
    });
  }

  function fireball(x, y, R, dur) {
    let t = 0;
    actor(1, (dt) => (t += dt) < dur, () => {
      const u = t / dur;
      const r = R * (0.35 + 0.65 * easeOut(Math.min(1, u * 2.2)));
      const flick = 0.85 + Math.random() * 0.15;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - u) ** 1.4 * flick;
      ctx.drawImage(sprite('#ff7a1c'), x - r, y - r * 0.85, r * 2, r * 1.7);
      ctx.globalAlpha = (1 - u) ** 2 * flick;
      ctx.drawImage(sprite('#ffe08a'), x - r * 0.55, y - r * 0.5, r * 1.1, r);
    });
  }

  function explosion(x, y, s = 1) {
    sound('boom', s);
    fireflash(x, y, 150 * s, 0.35);
    fireball(x, y, 95 * s, 0.75 + 0.15 * s);
    ring(x, y, 210 * s, 0.55, 8 * s);
    decal(x, y, 62 * s, 2.4, 'scorch');
    for (let i = 0; i < n(28 * s); i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(40, 240) * s;
      add({ kind: 'soft', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.75 - 40, g: -50, drag: 0.88, color: pick(FIRE), blend: 'lighter', size: rand(16, 30) * s, size1: rand(4, 10), life: rand(0.5, 1.0), fadeAt: 0.35 });
    }
    for (let i = 0; i < n(18 * s); i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(20, 120) * s;
      add({ kind: 'soft', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.7 - 30, g: -45, drag: 0.95, color: pick(SMOKE), size: 12 * s, size1: rand(40, 66) * s, life: rand(1.1, 1.9), alpha: 0.55, fadeAt: 0.15, delay: rand(0, 0.15) });
    }
    for (let i = 0; i < n(12 * s); i++) {
      const a = rand(-Math.PI, 0);
      add({ kind: 'debris', x, y, vx: Math.cos(a) * rand(150, 420) * s, vy: -rand(200, 520) * s, g: 1100, drag: 0.99, color: pick(['#2a2a2a', '#4a3b2a', '#1c1c1c', '#556b2f']), size: rand(3, 7), life: rand(0.7, 1.1), vr: rand(-14, 14) });
    }
    for (let i = 0; i < n(22 * s); i++) {
      const a = rand(0, Math.PI * 2);
      const v = rand(250, 650) * s;
      add({ kind: 'streak', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, g: 600, drag: 0.97, color: pick(FIRE.slice(0, 3)), blend: 'lighter', size: 2, len: 0.035, life: rand(0.3, 0.7) });
    }
    shake(shakeTarget, s, 380 + 220 * s);
  }

  function bulletImpact(x, y, big) {
    for (let i = 0; i < n(big ? 22 : 8); i++) {
      const a = rand(-Math.PI, 0);
      const v = rand(150, big ? 520 : 360);
      add({ kind: 'streak', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 900, drag: 0.97, color: pick(FIRE.slice(0, 3)), blend: 'lighter', size: 1.6, len: 0.025, life: rand(0.2, 0.45) });
    }
    for (let i = 0; i < n(big ? 7 : 3); i++) {
      add({ kind: 'soft', x: x + rand(-4, 4), y, vx: rand(-40, 40), vy: -rand(20, 70), g: -10, drag: 0.94, color: pick(DUST), size: 5, size1: rand(14, big ? 30 : 20), life: rand(0.5, 0.9), alpha: 0.6, fadeAt: 0.2 });
    }
    decal(x, y, big ? 11 : 5, 2.2, 'hole');
  }

  // ---------- vehicles ----------
  function drawMissile(x, y, ang, s, label) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(s, s);
    // exhaust flame
    ctx.globalCompositeOperation = 'lighter';
    const fl = 18 + Math.random() * 16;
    const g = ctx.createLinearGradient(-44 - fl, 0, -40, 0);
    g.addColorStop(0, 'rgba(255,120,20,0)');
    g.addColorStop(1, 'rgba(255,236,160,.95)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-40, -5);
    ctx.lineTo(-44 - fl, 0);
    ctx.lineTo(-40, 5);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // fins
    ctx.fillStyle = '#39431d';
    for (const k of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-40, 5 * k);
      ctx.lineTo(-50, 16 * k);
      ctx.lineTo(-28, 5 * k);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-2, 5 * k);
      ctx.lineTo(-8, 11 * k);
      ctx.lineTo(8, 5 * k);
      ctx.fill();
    }
    // body
    const bg = ctx.createLinearGradient(0, -6, 0, 6);
    bg.addColorStop(0, '#a3b16c');
    bg.addColorStop(0.5, '#6b7a3a');
    bg.addColorStop(1, '#343d1b');
    ctx.fillStyle = bg;
    ctx.fillRect(-40, -6, 64, 12);
    // nose cone
    const ng = ctx.createLinearGradient(0, -6, 0, 6);
    ng.addColorStop(0, '#f0f0f0');
    ng.addColorStop(1, '#8a8a8a');
    ctx.fillStyle = ng;
    ctx.beginPath();
    ctx.moveTo(24, -6);
    ctx.quadraticCurveTo(44, -4, 50, 0);
    ctx.quadraticCurveTo(44, 4, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#d4a93a';
    ctx.fillRect(18, -6, 3, 12);
    if (label) {
      ctx.fillStyle = '#f4f1e1';
      ctx.font = '8px "Black Ops One", Impact, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, -9, 0.5);
    }
    ctx.restore();
  }

  function missile({ from, to, dur = 0.7, scale = 1, label = '', onImpact }) {
    let t = 0;
    let x = from.x;
    let y = from.y;
    const ang = Math.atan2(to.y - from.y, to.x - from.x);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    sound('whistle', dur);
    actor(1, (dt) => {
      t += dt;
      const u = Math.min(1, t / dur);
      const e = 0.45 * u + 0.55 * u * u; // accelerates as it falls
      x = from.x + (to.x - from.x) * e;
      y = from.y + (to.y - from.y) * e;
      const tx = x - dx * 44 * scale;
      const ty = y - dy * 44 * scale;
      add({ kind: 'soft', x: tx, y: ty, vx: rand(-15, 15), vy: rand(-15, 15), g: -20, drag: 0.96, color: pick(SMOKE.concat(['#8a8a80'])), size: 6 * scale, size1: rand(20, 30) * scale, life: rand(0.7, 1.2), alpha: 0.5, fadeAt: 0.1 });
      add({ kind: 'soft', x: tx, y: ty, vx: -dx * 60, vy: -dy * 60, g: 0, drag: 0.9, color: pick(FIRE), blend: 'lighter', size: 9 * scale, size1: 2, life: 0.18, fadeAt: 0.3 });
      if (u >= 1) {
        if (onImpact) onImpact(to.x, to.y);
        return false;
      }
      return true;
    }, () => drawMissile(x, y, ang, scale, label));
  }

  // Top-down aircraft silhouettes (pointing to +x).
  function fighterPath() {
    const pts = [[34, 0], [22, -3], [6, -4], [-6, -24], [-14, -24], [-10, -5], [-22, -5], [-30, -13], [-34, -13], [-32, -3], [-36, -2]];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
    for (const [px, py] of pts.slice(1).reverse()) ctx.lineTo(px, -py);
    ctx.closePath();
  }
  function bomberPath() {
    const pts = [[40, 0], [-14, -74], [-22, -68], [-10, -46], [-24, -26], [-14, -12], [-22, 0]];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts.slice(1)) ctx.lineTo(px, py);
    for (const [px, py] of pts.slice(1, -1).reverse()) ctx.lineTo(px, -py);
    ctx.closePath();
  }

  function flyover({ kind, y, x0, x1, dur, scale = 1, onMove }) {
    let t = 0;
    let x = x0;
    const dir = Math.sign(x1 - x0) || 1;
    const path = kind === 'bomber' ? bomberPath : fighterPath;
    const tail = kind === 'bomber' ? 20 : 36;
    actor(1, (dt) => {
      t += dt;
      const u = Math.min(1, t / dur);
      x = x0 + (x1 - x0) * u;
      if (onMove) onMove(x, t);
      if (kind === 'fighter') {
        add({ kind: 'soft', x: x - dir * tail * scale, y, vx: -dir * 80, vy: 0, g: 0, drag: 0.9, color: pick(FIRE), blend: 'lighter', size: 7 * scale, size1: 2, life: 0.14 });
      }
      add({ kind: 'soft', x: x - dir * tail * scale, y: y + rand(-3, 3), vx: 0, vy: 0, g: 0, drag: 1, color: '#d9d9d9', size: 3, size1: 10, life: 0.5, alpha: 0.25, fadeAt: 0.1 });
      return u < 1;
    }, () => {
      // shadow on the table
      ctx.save();
      ctx.translate(x + 26, y + 40);
      ctx.scale(dir * scale * 0.92, scale * 0.92);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      path();
      ctx.fill();
      ctx.restore();
      // aircraft
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(dir * scale, scale);
      const g = ctx.createLinearGradient(0, -30, 0, 30);
      g.addColorStop(0, kind === 'bomber' ? '#3b4048' : '#6b737c');
      g.addColorStop(0.5, kind === 'bomber' ? '#23272c' : '#4b525b');
      g.addColorStop(1, kind === 'bomber' ? '#15181c' : '#353a41');
      ctx.fillStyle = g;
      path();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (kind === 'fighter') {
        ctx.fillStyle = '#9fd3ff';
        ctx.beginPath();
        ctx.ellipse(16, 0, 6, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c0282e';
        ctx.beginPath();
        ctx.arc(-9, 15, 2.5, 0, Math.PI * 2);
        ctx.arc(-9, -15, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  // Bomb seen from above: it shrinks as it falls away from the camera.
  function bomb({ x, y, vx, dur = 0.5, onImpact }) {
    let t = 0;
    let px = x;
    actor(1, (dt) => {
      t += dt;
      px += vx * dt;
      if (t >= dur) {
        onImpact(px, y);
        return false;
      }
      return true;
    }, () => {
      const u = t / dur;
      const s = 1 - 0.65 * u;
      ctx.fillStyle = 'rgba(0,0,0,.3)';
      ctx.beginPath();
      ctx.ellipse(px + 26 * (1 - u), y + 40 * (1 - u), 8 * s, 4 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(px, y);
      ctx.scale(s, s);
      ctx.fillStyle = '#2b2f24';
      ctx.beginPath();
      ctx.ellipse(0, 0, 10, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-15, -5, 4, 10);
      ctx.restore();
    });
  }

  function crosshair(target, onFire) {
    let t = 0;
    const dur = 1.15;
    const fireAt = 0.72;
    let fired = false;
    const ox = rand(-150, 150);
    const oy = rand(-100, -40);
    actor(1, (dt) => {
      t += dt;
      if (!fired && t >= fireAt) {
        fired = true;
        onFire(target.x, target.y);
      }
      return t < dur;
    }, () => {
      const e = easeOut(Math.min(1, t / 0.6));
      const wob = t < fireAt ? (1 - e) * 3 : 0;
      const cx = target.x + ox * (1 - e) + Math.sin(t * 23) * wob;
      const cy = target.y + oy * (1 - e) + Math.cos(t * 19) * wob;
      let r = 150 - 100 * e;
      if (t > fireAt) r += (t - fireAt) * 140;
      ctx.globalAlpha = t < fireAt ? Math.min(1, t * 5) : Math.max(0, 1 - (t - fireAt) / (dur - fireAt));
      ctx.strokeStyle = 'rgba(8,8,8,.85)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = '#ff3b3b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(cx + dx * (r - 4), cy + dy * (r - 4));
        ctx.lineTo(cx + dx * 7, cy + dy * 7);
      }
      ctx.stroke();
      ctx.fillStyle = '#ff3b3b';
      for (let k = 1; k <= 4; k++) {
        const d = (r - 4) * (k / 5);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath();
          ctx.arc(cx + dx * d, cy + dy * d, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function mushroom(x, y, H) {
    let t = 0;
    const dur = 2.1;
    const capAt = (time) => {
      const e = easeOut(Math.min(1, time / 1.4));
      return { cy: y - H * e, R: 26 + 95 * e };
    };
    actor(1, (dt) => {
      t += dt;
      const { cy, R } = capAt(t);
      if (t < 1.7) {
        // stem: a column of fire that turns to smoke
        for (let i = 0; i < n(3); i++) {
          const sy = cy + (y - cy) * Math.random();
          const hot = t < 0.8 && Math.random() < 0.6;
          add({ kind: 'soft', x: x + rand(-16, 16), y: sy, vx: rand(-6, 6), vy: -rand(30, 70), g: -10, drag: 0.96, color: hot ? pick(FIRE) : pick(SMOKE_BROWN), blend: hot ? 'lighter' : 'source-over', size: rand(10, 16), size1: rand(22, 34), life: rand(0.5, 0.9), alpha: hot ? 0.75 : 0.7, fadeAt: 0.25 });
        }
        // cap: a flattened, rolling ball of fire and smoke
        for (let i = 0; i < n(7); i++) {
          const a = rand(0, Math.PI * 2);
          const k = Math.sqrt(Math.random());
          const hot = k < 0.7 && Math.random() < (t < 1 ? 0.45 : 0.15);
          add({ kind: 'soft', x: x + Math.cos(a) * R * k, y: cy + Math.sin(a) * R * 0.5 * k, vx: Math.cos(a) * rand(15, 45), vy: Math.sin(a) * rand(5, 20) - rand(15, 35), g: -12, drag: 0.95, color: hot ? pick(FIRE) : pick(k > 0.75 ? SMOKE : SMOKE_BROWN), blend: hot ? 'lighter' : 'source-over', size: rand(14, 24), size1: rand(34, 58), life: rand(0.7, 1.2), alpha: hot ? 0.7 : 0.72, fadeAt: 0.3 });
        }
        // base surge rolling out across the felt
        if (t < 0.9) {
          for (let i = 0; i < n(3); i++) {
            const a = rand(0, Math.PI * 2);
            const v = rand(120, 260);
            add({ kind: 'soft', x: x + Math.cos(a) * 20, y: y + Math.sin(a) * 14, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.55, g: 0, drag: 0.95, color: pick(DUST.concat(SMOKE_BROWN)), size: rand(10, 16), size1: rand(26, 40), life: rand(0.7, 1.1), alpha: 0.55, fadeAt: 0.3 });
          }
        }
      }
      return t < dur;
    }, () => {
      // fire glowing inside the cap while it is still hot
      const heat = Math.max(0, 1 - t / 1.3);
      if (!heat) return;
      const { cy, R } = capAt(t);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = heat * 0.8;
      ctx.drawImage(sprite('#ff7a1c'), x - R, cy - R * 0.55, R * 2, R * 1.1);
    });
  }

  // ---------- the six celebrations (return ms until the "impact") ----------
  function sniperShot(c) {
    crosshair(c, (x, y) => {
      sound('sniper');
      bulletImpact(x, y, true);
      ring(x, y, 70, 0.3, 3);
      shake(shakeTarget, 0.5, 260);
    });
    return 720;
  }

  function strafingRun(c, tr) {
    const y = c.y + rand(-8, 8);
    const x0 = tr.left - 160;
    const x1 = tr.right + 160;
    const dur = 1.15;
    const lead = 110; // bullets land ahead of the jet
    const count = n(16);
    const hits = Array.from({ length: count }, (_, i) => ({
      x: tr.left + tr.width * (0.12 + (0.76 * i) / Math.max(1, count - 1)) + rand(-8, 8),
      y: y + rand(-20, 20),
      done: false,
    }));
    sound('jet', 1.4);
    flyover({
      kind: 'fighter', y: y - 34, x0, x1, dur, scale: 1.1,
      onMove: (x) => {
        for (const h of hits) {
          if (h.done || x < h.x - lead) continue;
          h.done = true;
          const sx = x + 30;
          const sy = y - 34;
          let tt = 0;
          actor(1, (dt) => (tt += dt) < 0.06, () => {
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = '#ffe28a';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(h.x, h.y);
            ctx.stroke();
          });
          sound('gun');
          bulletImpact(h.x, h.y, false);
        }
      },
    });
    const lastX = hits[hits.length - 1].x - lead;
    return ((lastX - x0) / (x1 - x0)) * dur * 1000;
  }

  function missileStrike(c) {
    targetLock(c.x, c.y, 0.75);
    missile({ from: { x: c.x + 90, y: -100 }, to: c, dur: 0.75, scale: 1.3, label: 'NIKE', onImpact: (x, y) => explosion(x, y, 1.4) });
    return 750;
  }

  function carpetBombing(c, tr) {
    const x0 = tr.left - 220;
    const x1 = tr.right + 220;
    const dur = 1.7;
    const drops = [0.16, 0.32, 0.48, 0.64, 0.8].map((f) => ({ x: tr.left + tr.width * f, done: false }));
    sound('jet', 1.9, 0.6);
    flyover({
      kind: 'bomber', y: c.y - 24, x0, x1, dur, scale: 1.25,
      onMove: (x) => {
        for (const d of drops) {
          if (d.done || x < d.x - 30) continue;
          d.done = true;
          bomb({ x, y: c.y - 16 + rand(-8, 8), vx: 70, dur: 0.5, onImpact: (bx, by) => explosion(bx, by + rand(-12, 18), 0.85) });
        }
      },
    });
    const lastDrop = drops[drops.length - 1].x - 30;
    return (((lastDrop - x0) / (x1 - x0)) * dur + 0.5) * 1000;
  }

  function barrage(c, tr) {
    const spots = [[-0.3, -0.12], [0.3, -0.1], [-0.14, 0.15], [0.15, 0.16], [0, 0]];
    spots.forEach(([fx, fy], i) => {
      const to = { x: c.x + fx * tr.width, y: c.y + fy * tr.height };
      const main = i === spots.length - 1;
      later(i * 170, () => {
        targetLock(to.x, to.y, 0.6);
        missile({
          from: { x: to.x + rand(-260, 260), y: -90 }, to, dur: 0.6, scale: main ? 1.3 : 0.9, label: main ? 'NIKE' : '',
          onImpact: (x, y) => explosion(x, y, main ? 1.7 : 0.9),
        });
      });
    });
    return (spots.length - 1) * 170 + 600;
  }

  function nuke(c, tr) {
    sound('siren', 1.0);
    const delay = 380;
    later(delay, () => {
      targetLock(c.x, c.y, 0.8);
      missile({
        from: { x: c.x + 50, y: -110 }, to: c, dur: 0.8, scale: 1.5, label: 'NUKE',
        onImpact: (x, y) => {
          screenFlash('radial-gradient(circle, #fffef5, #fff3c4 45%, rgba(255,243,196,.6))', 900);
          explosion(x, y, 2);
          ring(x, y, Math.max(innerWidth, innerHeight), 1.1, 16);
          ring(x, y, Math.max(innerWidth, innerHeight) * 0.6, 1.4, 8, '255,190,120');
          mushroom(x, y, Math.min(tr.height * 0.45, 240));
          shake(shakeTarget, 2.4, 1100);
          sound('rumble', 2.6);
        },
      });
    });
    return delay + 800;
  }

  const SCENARIOS = {
    4: { run: sniperShot, title: 'Straight', sub: 'Target eliminated' },
    5: { run: strafingRun, title: 'Flush', sub: 'Strafing run' },
    6: { run: missileStrike, title: 'Full House', sub: 'Direct hit' },
    7: { run: carpetBombing, title: 'Four of a Kind', sub: 'Carpet bombing' },
    8: { run: barrage, title: 'Straight Flush', sub: 'Full barrage' },
    9: { run: nuke, title: '☢ Royal Flush ☢', sub: 'Nuclear option' },
  };

  function banner(layer, title, sub, rank) {
    if (!layer) return;
    const b = document.createElement('div');
    b.className = `mil-banner rank-${rank}`;
    const t = document.createElement('div');
    t.className = 'mil-title';
    t.textContent = title;
    const s = document.createElement('div');
    s.className = 'mil-sub';
    s.textContent = sub;
    b.append(t, s);
    layer.append(b);
    setTimeout(() => b.remove(), rank >= 9 ? 2700 : 2100);
  }

  // Celebrate a win. Hands below a straight get nothing here: the caller only flies chips.
  // Returns how many ms until the impact, so the chips can fly out of the explosion.
  function celebrate({ rank, boardRect, tableRect, layer, tableEl }) {
    const sc = SCENARIOS[Math.min(9, rank)];
    if (!sc) return 0;
    const tr = tableRect || { left: 0, right: innerWidth, top: 0, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const c = boardRect
      ? { x: boardRect.left + boardRect.width / 2, y: boardRect.top + boardRect.height / 2 }
      : { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
    if (reducedMotion) {
      banner(layer, sc.title, sc.sub, rank);
      return 0;
    }
    shakeTarget = tableEl;
    const impact = sc.run(c, tr);
    later(impact + 280, () => banner(layer, sc.title, sc.sub, rank));
    return impact;
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
    later(560, () => sound('coins'));
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

  // ---------- sounds ----------
  let ac = null;
  let out = null;
  let muted = false;
  function audio() {
    if (muted) return null;
    try {
      if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        out = ac.createDynamicsCompressor(); // keeps stacked explosions from clipping
        out.threshold.value = -16;
        out.ratio.value = 6;
        out.connect(ac.destination);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch {
      return null;
    }
  }

  function env(a, peak, attack, dur, start = 0) {
    const g = a.createGain();
    const t0 = a.currentTime + start;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    return g;
  }

  function tone(a, freq, start, dur, { type = 'sine', vol = 0.1, to } = {}) {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime + start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, a.currentTime + start + dur);
    o.connect(env(a, vol, 0.01, dur, start)).connect(out);
    o.start(a.currentTime + start);
    o.stop(a.currentTime + start + dur + 0.02);
  }

  function noise(a, dur, start = 0) {
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource();
    src.buffer = buf;
    src.start(a.currentTime + start);
    return src;
  }

  function filter(a, type, freq, q = 0.7) {
    const f = a.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  const SOUNDS = {
    turn: (a) => tone(a, 880, 0, 0.25, { vol: 0.12 }),
    card: (a) => noise(a, 0.07).connect(filter(a, 'bandpass', 4000)).connect(env(a, 0.25, 0.005, 0.07)).connect(out),
    chip: (a) => {
      tone(a, 2600, 0, 0.05, { type: 'triangle', vol: 0.05 });
      tone(a, 3400, 0.04, 0.05, { type: 'triangle', vol: 0.04 });
    },
    pop: (a) => tone(a, 420, 0, 0.1, { type: 'triangle', vol: 0.08, to: 900 }),
    coins: (a) => {
      for (let i = 0; i < 5; i++) tone(a, 2400 + Math.random() * 1200, i * 0.05, 0.08, { type: 'triangle', vol: 0.04 });
    },
    boom: (a, s = 1) => {
      const dur = 1.0 + 0.5 * s;
      const lp = filter(a, 'lowpass', 2200);
      lp.frequency.setValueAtTime(2200, a.currentTime);
      lp.frequency.exponentialRampToValueAtTime(90, a.currentTime + dur);
      noise(a, dur).connect(lp).connect(env(a, Math.min(1, 0.6 * s), 0.01, dur)).connect(out);
      tone(a, 110, 0, 0.6, { vol: Math.min(0.9, 0.7 * s), to: 36 });
    },
    whistle: (a, dur = 0.7) => tone(a, 2200, 0, dur, { vol: 0.05, to: 480 }),
    jet: (a, dur = 1.3, pitch = 1) => {
      const bp = filter(a, 'bandpass', 300 * pitch, 0.8);
      const t0 = a.currentTime;
      bp.frequency.setValueAtTime(260 * pitch, t0);
      bp.frequency.exponentialRampToValueAtTime(1700 * pitch, t0 + dur * 0.5);
      bp.frequency.exponentialRampToValueAtTime(320 * pitch, t0 + dur);
      const g = a.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.55, t0 + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      let chain = noise(a, dur).connect(bp).connect(g);
      if (a.createStereoPanner) {
        const p = a.createStereoPanner();
        p.pan.setValueAtTime(-1, t0);
        p.pan.linearRampToValueAtTime(1, t0 + dur);
        chain = chain.connect(p);
      }
      chain.connect(out);
    },
    gun: (a) => {
      noise(a, 0.05).connect(filter(a, 'highpass', 900)).connect(env(a, 0.35, 0.003, 0.06)).connect(out);
      tone(a, 150, 0, 0.05, { type: 'square', vol: 0.08, to: 60 });
    },
    sniper: (a) => {
      noise(a, 0.04).connect(filter(a, 'highpass', 2500)).connect(env(a, 0.8, 0.002, 0.05)).connect(out);
      noise(a, 0.7).connect(filter(a, 'lowpass', 500)).connect(env(a, 0.35, 0.01, 0.7)).connect(out);
      tone(a, 95, 0, 0.3, { vol: 0.45, to: 40 });
    },
    siren: (a, dur = 1) => {
      const o = a.createOscillator();
      o.type = 'sawtooth';
      const t0 = a.currentTime;
      o.frequency.setValueAtTime(520, t0);
      o.frequency.linearRampToValueAtTime(900, t0 + dur / 2);
      o.frequency.linearRampToValueAtTime(520, t0 + dur);
      o.connect(filter(a, 'lowpass', 1800)).connect(env(a, 0.07, 0.05, dur)).connect(out);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    },
    rumble: (a, dur = 2.5) => {
      const g = a.createGain();
      const t0 = a.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise(a, dur).connect(filter(a, 'lowpass', 150)).connect(g).connect(out);
    },
  };

  function sound(name, ...args) {
    const a = audio();
    if (!a || !SOUNDS[name]) return;
    try {
      SOUNDS[name](a, ...args);
    } catch {}
  }

  return {
    celebrate, flyChips, emote, sound, burst,
    hasEffect: (rank) => !!SCENARIOS[Math.min(9, rank)],
    setMuted(v) { muted = !!v; },
    get muted() { return muted; },
  };
})();
