// Visual + sound effects. Big poker hands get cinematic, military-themed celebrations
// (sniper → strafing run → missile strike → carpet bombing → barrage → nuke);
// basic hands only get chips flying to the winner. All sounds are synthesized.
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
  const HUD = '#8dff7a';
  const MONO = '600 12px ui-monospace, Menlo, Consolas, monospace';

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
  const fmt = (v) => Math.floor(v).toLocaleString('en-US');
  const later = (ms, fn) => setTimeout(fn, ms);

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

  let scanlines = null;
  function scanPattern() {
    if (!scanlines) {
      const c = document.createElement('canvas');
      c.width = 1;
      c.height = 3;
      const g = c.getContext('2d');
      g.fillStyle = 'rgba(0,0,0,.28)';
      g.fillRect(0, 0, 1, 1);
      scanlines = ctx.createPattern(c, 'repeat');
    }
    return scanlines;
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

  function drawParticle(p) {
    const t = p.age / p.life;
    let alpha = p.alpha * (t > p.fadeAt ? (1 - t) / (1 - p.fadeAt) : 1);
    if (p.flicker) alpha *= 0.6 + Math.random() * 0.4;
    ctx.globalAlpha = alpha;
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

  function resetAnd(draw) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    draw();
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
    for (const a of actors) if (a.layer === 2) resetAnd(a.draw); // HUD / scope on top of everything

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (particles.length || actors.length) requestAnimationFrame(tick);
    else {
      running = false;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
    }
  }

  // ---------- generic bursts (used by the lobby too) ----------
  function burst(x, y, { count = 40, colors = PALETTE, speed = [150, 450], shape = 'rect', size = [6, 11], life = [0.9, 1.5], g = 500, spread = Math.PI * 2, angle = -Math.PI / 2, drag = 0.975 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = angle + rand(-spread / 2, spread / 2);
      const v = rand(speed[0], speed[1]);
      add({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color: pick(colors), kind: shape, size: rand(size[0], size[1]), life: rand(life[0], life[1]), g, drag });
    }
  }

  // ---------- the stage: DOM the effects react to ----------
  // { tableEl, knockables: Element[], tintEls: Element[] }
  let stage = { tableEl: null, knockables: [], tintEls: [] };

  function shake(intensity = 1, duration = 450) {
    const el = stage.tableEl;
    if (!el || reducedMotion) return;
    const frames = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const k = (1 - i / steps) ** 1.5 * 10 * intensity;
      frames.push({
        transform: i === steps ? 'none' : `translate(${rand(-k, k)}px, ${rand(-k, k)}px) rotate(${rand(-k, k) * 0.07}deg)`,
      });
    }
    el.animate(frames, { duration, easing: 'linear' });
  }

  // Quick zoom toward the viewer, like a camera jolt.
  function punch(amount = 0.03) {
    const el = stage.tableEl;
    if (!el || reducedMotion) return;
    el.animate([{ scale: '1' }, { scale: String(1 + amount), offset: 0.12 }, { scale: '1' }], { duration: 520, easing: 'ease-out' });
  }

  // The shockwave shoves cards, chips and players away from the blast, then they settle.
  function knock(x, y, strength = 1, speed = 1500) {
    if (reducedMotion) return;
    for (const el of stage.knockables) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const dx = r.left + r.width / 2 - x;
      const dy = r.top + r.height / 2 - y;
      const d = Math.hypot(dx, dy) || 1;
      const fall = Math.max(0.25, 1 - d / 1000);
      const m = 24 * strength * fall;
      const ux = dx / d;
      const uy = dy / d;
      const spin = rand(-14, 14) * Math.min(1.5, strength) * fall;
      el.animate([
        { translate: '0px 0px', rotate: '0deg' },
        { translate: `${ux * m}px ${uy * m}px`, rotate: `${spin}deg`, offset: 0.22 },
        { translate: `${-ux * m * 0.2}px ${-uy * m * 0.2}px`, rotate: `${-spin * 0.25}deg`, offset: 0.6 },
        { translate: '0px 0px', rotate: '0deg' },
      ], { duration: 650 + 150 * Math.min(2, strength), delay: (d / speed) * 1000, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  }

  // Tint the table (not the canvas) — e.g. a green night-vision drone feed.
  const NIGHT_VISION = 'sepia(.7) hue-rotate(55deg) saturate(2.4) brightness(.78) contrast(1.3)';
  function tint(filter, fadeInMs = 180) {
    if (reducedMotion) return { release() {} };
    const anims = stage.tintEls.map((el) => el.animate([{ filter: 'none' }, { filter }], { duration: fadeInMs, fill: 'forwards' }));
    return {
      release(fadeOutMs = 0) {
        anims.forEach((a) => a.cancel());
        if (fadeOutMs) stage.tintEls.forEach((el) => el.animate([{ filter }, { filter: 'none' }], { duration: fadeOutMs, easing: 'ease-in' }));
      },
    };
  }

  function overlay(cls, style = {}) {
    const d = document.createElement('div');
    d.className = cls;
    Object.assign(d.style, style);
    document.body.append(d);
    return d;
  }

  function screenFlash(color, duration = 500, peak = 0.95) {
    const f = overlay('screen-flash', { background: color });
    f.animate([{ opacity: peak }, { opacity: 0 }], { duration, easing: 'ease-out' }).onfinish = () => f.remove();
  }

  // Warm light from a blast washing over the felt (blended with the page underneath).
  function light(x, y, R, color, dur) {
    const l = overlay('fx-light', {
      left: x - R + 'px', top: y - R + 'px', width: R * 2 + 'px', height: R * 2 + 'px',
      background: `radial-gradient(circle closest-side, ${color}, transparent)`,
    });
    l.animate([{ opacity: 0 }, { opacity: 1, offset: 0.06 }, { opacity: 0 }], { duration: dur * 1000, easing: 'ease-out' }).onfinish = () => l.remove();
  }

  // Cinematic black bars.
  function letterbox(totalMs) {
    if (reducedMotion) return;
    for (const side of ['top', 'bottom']) {
      const bar = overlay(`lb ${side}`);
      const hidden = side === 'top' ? 'translateY(-100%)' : 'translateY(100%)';
      bar.animate([
        { transform: hidden }, { transform: 'none', offset: 250 / totalMs }, { transform: 'none', offset: 1 - 300 / totalMs }, { transform: hidden },
      ], { duration: totalMs, easing: 'ease-in-out' }).onfinish = () => bar.remove();
    }
  }

  // Scorched, orange "fallout" wash over the table that fades away (opacity only: cheap to animate).
  function fallout(rect, ms) {
    const f = overlay('fallout', { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    f.animate([{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in' }).onfinish = () => f.remove();
  }

  function redAlert(ms, pulses = 3) {
    const a = overlay('red-alert');
    const frames = [];
    for (let i = 0; i < pulses; i++) frames.push({ opacity: 0 }, { opacity: 1 });
    frames.push({ opacity: 0 });
    a.animate(frames, { duration: ms, easing: 'ease-in-out' }).onfinish = () => a.remove();
  }

  // ---------- canvas building blocks ----------
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

  // Scorch marks, craters with cracks, and bullet holes that fade away.
  function decal(x, y, r, dur, kind) {
    let t = 0;
    const cracks = kind === 'scorch' ? null : Array.from({ length: kind === 'crater' ? 9 : 6 }, () => {
      const pts = [];
      let a = rand(0, Math.PI * 2);
      let d = r * (kind === 'crater' ? 0.5 : 0.3);
      const len = kind === 'crater' ? rand(r * 1.3, r * 2.4) : rand(r * 1.6, r * 3.4);
      pts.push([Math.cos(a) * d, Math.sin(a) * d * 0.72]);
      while (d < len) {
        d += rand(r * 0.25, r * 0.5);
        a += rand(-0.35, 0.35);
        pts.push([Math.cos(a) * d, Math.sin(a) * d * 0.72]);
      }
      return pts;
    });
    actor(0, (dt) => (t += dt) < dur, () => {
      const a = t < dur * 0.5 ? 1 : 1 - (t - dur * 0.5) / (dur * 0.5);
      if (kind === 'scorch' || kind === 'crater') {
        ctx.globalAlpha = a * 0.85;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.72);
        ctx.drawImage(sprite('#140c06'), -r, -r, r * 2, r * 2);
        ctx.restore();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.max(0, 1 - t / (dur * 0.45)) * 0.65;
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(1, 0.72);
        ctx.drawImage(sprite('#ff6a1c'), -r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = '#0b0b0b';
        ctx.beginPath();
        ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
      if (cracks) {
        ctx.globalAlpha = a * 0.75;
        ctx.strokeStyle = '#0a0806';
        ctx.lineWidth = kind === 'crater' ? 2 : 1;
        ctx.beginPath();
        for (const pts of cracks) {
          ctx.moveTo(x + pts[0][0], y + pts[0][1]);
          for (const [px, py] of pts.slice(1)) ctx.lineTo(x + px, y + py);
        }
        ctx.stroke();
      }
    });
  }

  // Anamorphic lens flare: a horizontal streak plus ghosts mirrored through the screen centre.
  function lensFlare(x, y, dur, s = 1) {
    let t = 0;
    const cx = innerWidth / 2;
    const cy = innerHeight / 2;
    const ghosts = [[0.45, 16, '#7fd8ff'], [0.9, 32, '#b4ff9a'], [1.35, 12, '#ffb36b'], [1.75, 44, '#8fa8ff']];
    actor(1, (dt) => (t += dt) < dur, () => {
      const a = (1 - t / dur) ** 1.5;
      ctx.globalCompositeOperation = 'lighter';
      const w = innerWidth * 0.95 * s;
      ctx.globalAlpha = a * 0.9;
      ctx.drawImage(sprite('#9fd4ff'), x - w / 2, y - 5 * s, w, 10 * s);
      ctx.globalAlpha = a * 0.5;
      ctx.drawImage(sprite('#9fd4ff'), x - w * 0.3, y - 14 * s, w * 0.6, 28 * s);
      ctx.globalAlpha = a;
      ctx.drawImage(sprite('#ffffff'), x - 60 * s, y - 60 * s, 120 * s, 120 * s);
      for (const [k, r, col] of ghosts) {
        const gx = x + (cx - x) * k;
        const gy = y + (cy - y) * k;
        ctx.globalAlpha = a * 0.3;
        ctx.drawImage(sprite(col), gx - r * s, gy - r * s, 2 * r * s, 2 * r * s);
      }
    });
  }

  function embers(x, y, count, spread = 1) {
    for (let i = 0; i < n(count); i++) {
      const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
      const v = rand(120, 420) * spread;
      add({ kind: 'soft', x: x + rand(-10, 10), y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: 260, drag: 0.975, color: pick(['#ffb347', '#ff7a1c', '#ffd25e']), blend: 'lighter', size: rand(1.6, 3), size1: 1, life: rand(1.1, 2.0), fadeAt: 0.5, flicker: true });
    }
  }

  // Ash drifting down over the table after the nuke.
  function ashfall(rect, dur) {
    let t = 0;
    actor(1, (dt) => {
      t += dt;
      for (let i = 0; i < n(2); i++) {
        add({ kind: 'soft', x: rand(rect.left, rect.right), y: rect.top - 10, vx: rand(-25, 25), vy: rand(40, 90), g: 8, drag: 0.99, color: pick(['#9a948a', '#b5aea2', '#7d776d', '#ff9a3c']), size: rand(1.2, 2.4), life: rand(1.4, 2.2), alpha: 0.8, fadeAt: 0.6 });
      }
      return t < dur;
    }, () => {});
  }

  function explosion(x, y, s = 1) {
    sound('boom', s);
    fireflash(x, y, 150 * s, 0.35);
    fireball(x, y, 95 * s, 0.75 + 0.15 * s);
    ring(x, y, 210 * s, 0.55, 8 * s);
    decal(x, y, 62 * s, 2.6, s >= 1.2 ? 'crater' : 'scorch');
    light(x, y, 380 * s, 'rgba(255,165,70,.85)', 0.7 + 0.2 * s);
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
    embers(x, y, 14 * s);
    knock(x, y, 0.8 * s);
    shake(s, 380 + 220 * s);
  }

  // The full treatment for a main impact.
  function bigImpact(x, y, s) {
    screenFlash('#fffdf2', 160, 0.85);
    lensFlare(x, y, 0.6, s * 0.8);
    explosion(x, y, s);
    punch(0.02 * s);
    if (s >= 1.4) sound('subdrop');
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
    decal(x, y, big ? 11 : 5, 2.4, 'hole');
  }

  // ---------- vehicles ----------
  function drawMissile(x, y, ang, s, label) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.scale(s, s);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(sprite('#ff9a3c'), -70, -18, 40, 36); // engine glow
    const fl = 22 + Math.random() * 20;
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
    const bg = ctx.createLinearGradient(0, -6, 0, 6);
    bg.addColorStop(0, '#a3b16c');
    bg.addColorStop(0.5, '#6b7a3a');
    bg.addColorStop(1, '#343d1b');
    ctx.fillStyle = bg;
    ctx.fillRect(-40, -6, 64, 12);
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
      add({ kind: 'soft', x: tx, y: ty, vx: rand(-15, 15), vy: rand(-15, 15), g: -20, drag: 0.96, color: pick(SMOKE.concat(['#8a8a80', '#a5a59a'])), size: 6 * scale, size1: rand(20, 32) * scale, life: rand(0.8, 1.4), alpha: 0.5, fadeAt: 0.1 });
      add({ kind: 'soft', x: tx, y: ty, vx: -dx * 60, vy: -dy * 60, g: 0, drag: 0.9, color: pick(FIRE), blend: 'lighter', size: 10 * scale, size1: 2, life: 0.2, fadeAt: 0.3 });
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
    const bomber = kind === 'bomber';
    const path = bomber ? bomberPath : fighterPath;
    const tail = bomber ? 20 : 36;
    const shadowOff = bomber ? [34, 56] : [26, 40];
    let prevX = x0;
    actor(1, (dt) => {
      t += dt;
      const u = Math.min(1, t / dur);
      prevX = x;
      x = x0 + (x1 - x0) * u;
      if (onMove) onMove(x, t);
      if (!bomber) {
        add({ kind: 'soft', x: x - dir * tail * scale, y, vx: -dir * 90, vy: 0, g: 0, drag: 0.9, color: pick(FIRE), blend: 'lighter', size: 9 * scale, size1: 2, life: 0.16 });
      }
      // vapour trails from the wingtips, filled in between frames so they stay continuous
      const span = (bomber ? 70 : 22) * scale;
      const back = dir * (bomber ? 14 : 12) * scale;
      const steps = Math.min(6, Math.max(1, Math.ceil(Math.abs(x - prevX) / 7)));
      for (let s = 1; s <= steps; s++) {
        const px = prevX + ((x - prevX) * s) / steps - back;
        for (const k of [-1, 1]) {
          add({ kind: 'soft', x: px, y: y + k * span, vx: 0, vy: 0, g: 0, drag: 1, color: '#e6ecf2', size: 2, size1: 6, life: 0.5, alpha: 0.28, fadeAt: 0.1 });
        }
      }
      return u < 1;
    }, () => {
      const bank = 1 - 0.1 * Math.sin(t * 7);
      ctx.save();
      ctx.translate(x + shadowOff[0], y + shadowOff[1]);
      ctx.scale(dir * scale * 0.92, scale * 0.92 * bank);
      ctx.fillStyle = 'rgba(0,0,0,.38)';
      path();
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(dir * scale, scale * bank);
      const g = ctx.createLinearGradient(0, -30, 0, 30);
      g.addColorStop(0, bomber ? '#3b4048' : '#6b737c');
      g.addColorStop(0.5, bomber ? '#23272c' : '#4b525b');
      g.addColorStop(1, bomber ? '#15181c' : '#353a41');
      ctx.fillStyle = g;
      path();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.15)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (!bomber) {
        ctx.fillStyle = '#9fd3ff';
        ctx.beginPath();
        ctx.ellipse(16, 0, 6, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#c0282e';
        ctx.beginPath();
        ctx.arc(-9, 15, 2.5, 0, Math.PI * 2);
        ctx.arc(-9, -15, 2.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = Math.floor(t * 6) % 2 ? '#ff3b3b' : '#5a1010'; // blinking nav light
        ctx.beginPath();
        ctx.arc(-12, 0, 2.2, 0, Math.PI * 2);
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

  function tracer(sx, sy, tx, ty, dur, onHit) {
    let t = 0;
    actor(1, (dt) => {
      t += dt;
      if (t >= dur) {
        onHit();
        return false;
      }
      return true;
    }, () => {
      const u = t / dur;
      const hx = sx + (tx - sx) * u;
      const hy = sy + (ty - sy) * u;
      const bx = sx + (tx - sx) * Math.max(0, u - 0.35);
      const by = sy + (ty - sy) * Math.max(0, u - 0.35);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#ffe28a';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    });
  }

  // ---------- HUDs ----------
  function brackets(x, y, w, h, k) {
    ctx.beginPath();
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      ctx.moveTo(cx, cy + sy * k);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + sx * k, cy);
    }
    ctx.stroke();
  }

  // Drone-camera overlay: scanlines, telemetry and lock boxes closing on the targets.
  function droneHud({ rect, targets, dur, lockAt, title, lines = [] }) {
    let t = 0;
    const alt0 = rand(11000, 14000);
    actor(2, (dt) => (t += dt) < dur, () => {
      const a = Math.min(1, t / 0.15, (dur - t) / 0.12);
      const L = rect.left;
      const T = rect.top;
      const W = rect.width;
      const H = rect.height;
      const m = 12;
      ctx.globalAlpha = a;
      ctx.fillStyle = scanPattern();
      ctx.fillRect(L, T, W, H);
      const vg = ctx.createRadialGradient(L + W / 2, T + H / 2, Math.min(W, H) * 0.35, L + W / 2, T + H / 2, Math.max(W, H) * 0.7);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,20,0,.55)');
      ctx.fillStyle = vg;
      ctx.fillRect(L, T, W, H);

      ctx.strokeStyle = HUD;
      ctx.lineWidth = 2;
      brackets(L + m, T + m, W - 2 * m, H - 2 * m, 28);
      ctx.globalAlpha = a * 0.35;
      ctx.setLineDash([4, 7]);
      ctx.beginPath();
      ctx.moveTo(L + m, T + H / 2);
      ctx.lineTo(L + W - m, T + H / 2);
      ctx.moveTo(L + W / 2, T + m);
      ctx.lineTo(L + W / 2, T + H - m);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = a;
      ctx.font = MONO;
      ctx.textBaseline = 'top';
      const blink = Math.floor(t * 4) % 2 === 0;
      ctx.fillStyle = HUD;
      ctx.textAlign = 'left';
      ctx.fillText(`${blink ? '●' : '○'} REC  ${title}`, L + m + 8, T + m + 8);
      lines.forEach((line, i) => {
        const start = 0.12 + i * 0.22;
        if (t < start) return;
        ctx.fillStyle = i === 0 ? '#ff5a4a' : HUD;
        ctx.fillText(line.slice(0, Math.floor((t - start) * 45)), L + m + 8, T + m + 26 + i * 16);
      });
      ctx.fillStyle = HUD;
      ctx.textAlign = 'right';
      ctx.fillText(`ALT ${fmt(alt0 * (1 - 0.6 * t / dur))} FT`, L + W - m - 8, T + m + 8);
      ctx.fillText('ZOOM ×4 · IR', L + W - m - 8, T + m + 24);
      ctx.textBaseline = 'bottom';
      ctx.fillText(`T+00:0${t.toFixed(2)}`, L + W - m - 8, T + H - m - 8);
      ctx.textAlign = 'left';
      ctx.fillText('N 52°13′47″  E 21°00′42″', L + m + 8, T + H - m - 8);

      targets.forEach((tg, i) => {
        const t0 = i * 0.09;
        if (t < t0) return;
        const e = easeOut(Math.min(1, (t - t0) / Math.max(0.1, lockAt - t0)));
        const size = 130 - 84 * e;
        const locked = t >= lockAt;
        ctx.save();
        ctx.translate(tg.x, tg.y);
        ctx.rotate((1 - e) * Math.PI / 2);
        ctx.strokeStyle = locked ? '#ff3b3b' : HUD;
        ctx.lineWidth = 2;
        brackets(-size / 2, -size / 2, size, size, size * 0.28);
        ctx.restore();
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = locked ? '#ff3b3b' : HUD;
        if (!locked || blink) ctx.fillText(locked ? 'LOCKED' : `TGT ${i + 1}`, tg.x + size / 2 + 6, tg.y - size / 2 + 12);
      });
    });
  }

  // Sniper point of view: darkness around a swaying scope that settles, then fires.
  function scope(target, fireAt, dur, onFire) {
    let t = 0;
    let fired = false;
    const ox = rand(-170, 170);
    const oy = rand(-120, -50);
    actor(2, (dt) => {
      t += dt;
      if (!fired && t >= fireAt) {
        fired = true;
        onFire(target.x, target.y);
      }
      return t < dur;
    }, () => {
      const settle = easeOut(Math.min(1, t / 0.75));
      const sway = t < fireAt ? (1 - settle * 0.8) * 7 : 0;
      const cx = target.x + ox * (1 - settle) + Math.sin(t * 5.3) * sway;
      let cy = target.y + oy * (1 - settle) + Math.cos(t * 4.1) * sway;
      if (t > fireAt) cy -= Math.max(0, 1 - (t - fireAt) / 0.25) * 30; // recoil
      const R = Math.min(150, Math.min(innerWidth, innerHeight) * 0.28);
      const vis = t < 0.2 ? t / 0.2 : t > fireAt + 0.15 ? Math.max(0, 1 - (t - fireAt - 0.15) / (dur - fireAt - 0.15)) : 1;

      ctx.globalAlpha = vis * 0.93;
      ctx.fillStyle = '#020403';
      ctx.beginPath();
      ctx.rect(0, 0, innerWidth, innerHeight);
      ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.globalAlpha = vis;
      const g = ctx.createRadialGradient(cx, cy, R * 0.55, cx, cy, R);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,.8)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      if (t > fireAt && t < fireAt + 0.07) {
        ctx.fillStyle = 'rgba(255,246,216,.9)';
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 5;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        ctx.moveTo(cx + dx * R, cy + dy * R);
        ctx.lineTo(cx + dx * R * 0.5, cy + dy * R * 0.5);
      }
      ctx.stroke();
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx - R * 0.5, cy);
      ctx.lineTo(cx + R * 0.5, cy);
      ctx.moveTo(cx, cy - R * 0.5);
      ctx.lineTo(cx, cy + R * 0.5);
      ctx.stroke();
      ctx.fillStyle = '#0a0a0a';
      for (let k = 1; k <= 4; k++) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          ctx.beginPath();
          ctx.arc(cx + dx * R * 0.1 * k, cy + dy * R * 0.1 * k, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = '#ff3b3b';
      ctx.beginPath();
      ctx.arc(cx, cy, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#050505';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ff6a5a';
      ctx.fillText(`RNG ${Math.round(460 - 60 * settle)} M   WIND 3 →`, cx, cy + R * 0.72);
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
        for (let i = 0; i < n(3); i++) {
          const sy = cy + (y - cy) * Math.random();
          const hot = t < 0.8 && Math.random() < 0.6;
          add({ kind: 'soft', x: x + rand(-16, 16), y: sy, vx: rand(-6, 6), vy: -rand(30, 70), g: -10, drag: 0.96, color: hot ? pick(FIRE) : pick(SMOKE_BROWN), blend: hot ? 'lighter' : 'source-over', size: rand(10, 16), size1: rand(22, 34), life: rand(0.5, 0.9), alpha: hot ? 0.75 : 0.7, fadeAt: 0.25 });
        }
        for (let i = 0; i < n(7); i++) {
          const a = rand(0, Math.PI * 2);
          const k = Math.sqrt(Math.random());
          const hot = k < 0.7 && Math.random() < (t < 1 ? 0.45 : 0.15);
          add({ kind: 'soft', x: x + Math.cos(a) * R * k, y: cy + Math.sin(a) * R * 0.5 * k, vx: Math.cos(a) * rand(15, 45), vy: Math.sin(a) * rand(5, 20) - rand(15, 35), g: -12, drag: 0.95, color: hot ? pick(FIRE) : pick(k > 0.75 ? SMOKE : SMOKE_BROWN), blend: hot ? 'lighter' : 'source-over', size: rand(14, 24), size1: rand(34, 58), life: rand(0.7, 1.2), alpha: hot ? 0.7 : 0.72, fadeAt: 0.3 });
        }
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
      const heat = Math.max(0, 1 - t / 1.3);
      if (!heat) return;
      const { cy, R } = capAt(t);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = heat * 0.85;
      ctx.drawImage(sprite('#ff7a1c'), x - R, cy - R * 0.55, R * 2, R * 1.1);
      ctx.globalAlpha = heat * 0.5;
      ctx.drawImage(sprite('#ffd25e'), x - R * 0.5, cy - R * 0.25, R, R * 0.5);
    });
  }

  // ---------- the six celebrations (each returns ms until the main impact) ----------
  function sniperShot(c) {
    sound('heartbeat');
    later(480, () => sound('heartbeat'));
    scope(c, 0.95, 1.4, (x, y) => {
      sound('sniper');
      bulletImpact(x, y, true);
      decal(x, y, 16, 2.6, 'hole');
      ring(x, y, 90, 0.35, 3);
      light(x, y, 180, 'rgba(255,220,160,.7)', 0.3);
      lensFlare(x, y, 0.35, 0.45);
      knock(x, y, 0.45);
      shake(0.5, 260);
    });
    return 950;
  }

  function strafingRun(c, tr) {
    const dur = 1.25;
    const lead = 120; // bullets land ahead of the jets
    const jets = [
      { y: c.y - 44, offset: 0, scale: 1.15, rowY: c.y - 8 },
      { y: c.y + 52, offset: -110, scale: 1.0, rowY: c.y + 30 },
    ];
    let lastHit = 0;
    sound('jet', 1.6);
    later(dur * 450, () => {
      sound('sonicboom');
      ring(c.x, c.y, 300, 0.45, 3, '220,235,255');
      knock(c.x, c.y, 0.35, 2600);
      shake(0.4, 250);
    });
    for (const j of jets) {
      const x0 = tr.left - 200 + j.offset;
      const x1 = tr.right + 200 + j.offset;
      const count = n(11);
      const hits = Array.from({ length: count }, (_, i) => ({
        x: tr.left + tr.width * (0.12 + (0.76 * i) / Math.max(1, count - 1)) + rand(-8, 8),
        y: j.rowY + rand(-16, 16),
        done: false,
      }));
      const last = hits[hits.length - 1].x - lead;
      lastHit = Math.max(lastHit, ((last - x0) / (x1 - x0)) * dur * 1000 + 70);
      flyover({
        kind: 'fighter', y: j.y, x0, x1, dur, scale: j.scale,
        onMove: (x) => {
          for (const h of hits) {
            if (h.done || x < h.x - lead) continue;
            h.done = true;
            tracer(x + 30 * j.scale, j.y, h.x, h.y, 0.07, () => {
              sound('gun');
              bulletImpact(h.x, h.y, false);
            });
          }
        },
      });
    }
    return lastHit;
  }

  function missileStrike(c, tr) {
    letterbox(2700);
    const nv = tint(NIGHT_VISION);
    droneHud({ rect: tr, targets: [c], dur: 1.15, lockAt: 0.6, title: 'UAV-7 · STRIKE', lines: ['FIRE MISSION APPROVED', 'ORDNANCE: MIM-14 NIKE'] });
    sound('lock', 0.6);
    later(380, () => missile({
      from: { x: c.x + 120, y: tr.top - 160 }, to: c, dur: 0.72, scale: 1.35, label: 'NIKE',
      onImpact: (x, y) => {
        nv.release(0);
        bigImpact(x, y, 1.5);
      },
    }));
    return 1100;
  }

  function carpetBombing(c, tr) {
    letterbox(3100);
    redAlert(1500, 3);
    sound('klaxon');
    const x0 = tr.left - 240;
    const x1 = tr.right + 240;
    const dur = 1.9;
    const drops = [0.14, 0.28, 0.42, 0.56, 0.7, 0.84].map((f) => ({ x: tr.left + tr.width * f, done: false }));
    sound('jet', 2.1, 0.6);
    flyover({
      kind: 'bomber', y: c.y - 24, x0, x1, dur, scale: 1.35,
      onMove: (x) => {
        drops.forEach((d, i) => {
          if (d.done || x < d.x - 30) return;
          d.done = true;
          bomb({
            x, y: c.y - 16 + rand(-10, 10), vx: 70, dur: 0.55,
            onImpact: (bx, by) => (i === drops.length - 1 ? bigImpact(bx, by + 8, 1.15) : explosion(bx, by + rand(-12, 18), 0.85)),
          });
        });
      },
    });
    const lastDrop = drops[drops.length - 1].x - 30;
    return (((lastDrop - x0) / (x1 - x0)) * dur + 0.55) * 1000;
  }

  function barrage(c, tr) {
    letterbox(3100);
    const nv = tint(NIGHT_VISION);
    const spots = [[-0.3, -0.12], [0.3, -0.1], [-0.14, 0.15], [0.15, 0.16], [0, 0]];
    const targets = spots.map(([fx, fy]) => ({ x: c.x + fx * tr.width, y: c.y + fy * tr.height }));
    droneHud({ rect: tr, targets, dur: 0.95, lockAt: 0.55, title: 'SALVO · 5 TGT', lines: ['BARRAGE AUTHORIZED'] });
    sound('lock', 0.55);
    targets.forEach((to, i) => {
      const main = i === targets.length - 1;
      later(260 + i * 140, () => missile({
        from: { x: to.x + rand(-280, 280), y: tr.top - 150 }, to, dur: 0.6, scale: main ? 1.35 : 0.9, label: main ? 'NIKE' : '',
        onImpact: (x, y) => {
          if (i === 0) nv.release(0);
          if (main) bigImpact(x, y, 1.8);
          else explosion(x, y, 0.95);
        },
      }));
    });
    return 260 + (targets.length - 1) * 140 + 600;
  }

  function nuke(c, tr) {
    letterbox(4300);
    redAlert(1500, 3);
    sound('siren', 1.4);
    const nv = tint(NIGHT_VISION);
    droneHud({ rect: tr, targets: [c], dur: 1.5, lockAt: 0.95, title: 'DEFCON 1', lines: ['LAUNCH AUTHORIZED', 'WARHEAD ARMED', 'TARGET: THE POT'] });
    later(350, () => sound('lock', 0.6));
    const launch = 620;
    later(launch, () => missile({
      from: { x: c.x + 60, y: tr.top - 220 }, to: c, dur: 0.85, scale: 1.6, label: 'NUKE',
      onImpact: (x, y) => {
        nv.release(0);
        screenFlash('#ffffff', 1300, 1);
        light(x, y, 700, 'rgba(255,190,90,1)', 1.5);
        lensFlare(x, y, 1.1, 1.6);
        explosion(x, y, 2.1);
        decal(x, y, 130, 3.4, 'crater');
        ring(x, y, Math.max(innerWidth, innerHeight), 1.2, 18);
        ring(x, y, Math.max(innerWidth, innerHeight) * 0.6, 1.5, 8, '255,190,120');
        knock(x, y, 2.6, 1500);
        mushroom(x, y, Math.min(tr.height * 0.45, 240));
        embers(x, y, 60, 1.4);
        shake(2.4, 1200);
        punch(0.06);
        sound('subdrop');
        sound('rumble', 3);
        later(250, () => {
          fallout(tr, 2300);
          ashfall(tr, 1.6);
        });
        later(700, () => sound('geiger', 1.8));
      },
    }));
    return launch + 850;
  }

  const SCENARIOS = {
    4: { run: sniperShot, title: 'Straight', sub: 'Target eliminated' },
    5: { run: strafingRun, title: 'Flush', sub: 'Strafing run' },
    6: { run: missileStrike, title: 'Full House', sub: 'Direct hit' },
    7: { run: carpetBombing, title: 'Four of a Kind', sub: 'Carpet bombing' },
    8: { run: barrage, title: 'Straight Flush', sub: 'Full barrage' },
    9: { run: nuke, title: '☢ Royal Flush ☢', sub: 'Nuclear option' },
  };

  function banner(layer, sc, rank, winner) {
    if (!layer) return;
    const b = document.createElement('div');
    b.className = `mil-banner rank-${rank}`;
    const parts = [['mil-title', sc.title], ['mil-sub', sc.sub]];
    if (winner && winner.name) parts.push(['mil-who', `${winner.name} +${fmt(winner.amount || 0)}`]);
    for (const [cls, text] of parts) {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      b.append(d);
    }
    layer.append(b);
    const life = rank >= 9 ? 2600 : 2000;
    // the banner "lands" 12% into its stamp animation: kick up dust and sparks
    later(life * 0.12, () => {
      if (!b.isConnected || reducedMotion) return;
      const r = b.querySelector('.mil-title').getBoundingClientRect();
      for (let i = 0; i < n(26); i++) {
        const x = rand(r.left, r.right);
        add({ kind: 'soft', x, y: r.bottom - 6, vx: (x - (r.left + r.width / 2)) * rand(0.6, 1.4), vy: -rand(10, 60), g: 30, drag: 0.93, color: pick(DUST), size: rand(4, 7), size1: rand(14, 24), life: rand(0.5, 0.9), alpha: 0.6, fadeAt: 0.3 });
      }
      for (let i = 0; i < n(12); i++) {
        add({ kind: 'streak', x: rand(r.left, r.right), y: r.bottom - 4, vx: rand(-260, 260), vy: -rand(120, 320), g: 900, drag: 0.97, color: pick(FIRE.slice(0, 3)), blend: 'lighter', size: 1.6, len: 0.025, life: rand(0.25, 0.5) });
      }
      sound('stamp');
      shake(0.35, 200);
    });
    setTimeout(() => b.remove(), life);
  }

  // Celebrate a win. Hands below a straight get nothing here: the caller only flies chips.
  // Returns how many ms until the main impact, so the chips can fly out of the explosion.
  function celebrate({ rank, boardRect, tableRect, layer, tableEl, knockables = [], winner }) {
    const sc = SCENARIOS[Math.min(9, rank)];
    if (!sc) return 0;
    const tr = tableRect || { left: 0, right: innerWidth, top: 0, bottom: innerHeight, width: innerWidth, height: innerHeight };
    const c = boardRect
      ? { x: boardRect.left + boardRect.width / 2, y: boardRect.top + boardRect.height / 2 }
      : { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
    if (reducedMotion) {
      banner(layer, sc, rank, winner);
      return 0;
    }
    stage = {
      tableEl,
      knockables: knockables.filter(Boolean),
      tintEls: tableEl ? [...tableEl.children].filter((el) => !el.classList.contains('fx-layer')) : [],
    };
    const impact = sc.run(c, tr);
    later(impact + 280, () => banner(layer, sc, rank, winner));
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
      const c = overlay('fly-chip', { background: pick(['#e5484d', '#3e63dd', '#2fbf71', '#111', '#f2c14e']), left: sx + 'px', top: sy + 'px' });
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
  let verbIn = null;
  let muted = false;

  function impulse(a, seconds) {
    const len = Math.floor(a.sampleRate * seconds);
    const buf = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    return buf;
  }

  function audio() {
    if (muted) return null;
    try {
      if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        out = ac.createDynamicsCompressor(); // keeps stacked explosions from clipping
        out.threshold.value = -16;
        out.ratio.value = 6;
        out.connect(ac.destination);
        const verb = ac.createConvolver(); // a big outdoor echo for blasts and gunfire
        verb.buffer = impulse(ac, 2.4);
        verbIn = ac.createGain();
        verbIn.gain.value = 0.4;
        verbIn.connect(verb).connect(out);
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    } catch {
      return null;
    }
  }

  // Route a node to the speakers, optionally with some echo.
  function send(a, node, wet = 0) {
    node.connect(out);
    if (wet) {
      const g = a.createGain();
      g.gain.value = wet;
      node.connect(g).connect(verbIn);
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

  function tone(a, freq, start, dur, { type = 'sine', vol = 0.1, to, wet = 0 } = {}) {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, a.currentTime + start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, a.currentTime + start + dur);
    send(a, o.connect(env(a, vol, 0.01, dur, start)), wet);
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
    card: (a) => send(a, noise(a, 0.07).connect(filter(a, 'bandpass', 4000)).connect(env(a, 0.25, 0.005, 0.07))),
    chip: (a) => {
      tone(a, 2600, 0, 0.05, { type: 'triangle', vol: 0.05 });
      tone(a, 3400, 0.04, 0.05, { type: 'triangle', vol: 0.04 });
    },
    pop: (a) => tone(a, 420, 0, 0.1, { type: 'triangle', vol: 0.08, to: 900 }),
    coins: (a) => {
      for (let i = 0; i < 5; i++) tone(a, 2400 + Math.random() * 1200, i * 0.05, 0.08, { type: 'triangle', vol: 0.04 });
    },
    boom: (a, s = 1) => {
      const dur = 1.0 + 0.6 * s;
      const lp = filter(a, 'lowpass', 2400);
      lp.frequency.setValueAtTime(2400, a.currentTime);
      lp.frequency.exponentialRampToValueAtTime(80, a.currentTime + dur);
      send(a, noise(a, dur).connect(lp).connect(env(a, Math.min(1, 0.6 * s), 0.01, dur)), 0.9);
      tone(a, 120, 0, 0.6, { vol: Math.min(0.9, 0.7 * s), to: 34 });
    },
    subdrop: (a) => tone(a, 58, 0, 1.4, { vol: 0.7, to: 22 }),
    whistle: (a, dur = 0.7) => tone(a, 2400, 0, dur, { vol: 0.05, to: 420, wet: 0.3 }),
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
      send(a, chain, 0.4);
    },
    sonicboom: (a) => {
      for (const s of [0, 0.09]) {
        send(a, noise(a, 0.3, s).connect(filter(a, 'lowpass', 320)).connect(env(a, 0.9, 0.005, 0.3, s)), 0.8);
      }
    },
    gun: (a) => {
      send(a, noise(a, 0.05).connect(filter(a, 'highpass', 900)).connect(env(a, 0.35, 0.003, 0.06)), 0.5);
      tone(a, 150, 0, 0.05, { type: 'square', vol: 0.08, to: 60 });
    },
    sniper: (a) => {
      send(a, noise(a, 0.04).connect(filter(a, 'highpass', 2500)).connect(env(a, 0.85, 0.002, 0.05)), 1);
      send(a, noise(a, 0.7).connect(filter(a, 'lowpass', 500)).connect(env(a, 0.35, 0.01, 0.7)), 0.8);
      tone(a, 95, 0, 0.3, { vol: 0.5, to: 40 });
    },
    heartbeat: (a) => {
      tone(a, 62, 0, 0.14, { vol: 0.55, to: 40 });
      tone(a, 58, 0.2, 0.12, { vol: 0.4, to: 38 });
    },
    lock: (a, dur = 0.6) => {
      let t = 0;
      let gap = 0.16;
      while (t < dur) {
        tone(a, 1450, t, 0.035, { type: 'square', vol: 0.04 });
        t += gap;
        gap = Math.max(0.045, gap * 0.8);
      }
      tone(a, 1450, dur, 0.3, { type: 'square', vol: 0.04 });
    },
    klaxon: (a) => {
      for (let i = 0; i < 3; i++) {
        tone(a, 440, i * 0.5, 0.22, { type: 'square', vol: 0.04 });
        tone(a, 330, i * 0.5 + 0.22, 0.22, { type: 'square', vol: 0.04 });
      }
    },
    siren: (a, dur = 1) => {
      const o = a.createOscillator();
      o.type = 'sawtooth';
      const t0 = a.currentTime;
      o.frequency.setValueAtTime(520, t0);
      o.frequency.linearRampToValueAtTime(900, t0 + dur / 2);
      o.frequency.linearRampToValueAtTime(520, t0 + dur);
      send(a, o.connect(filter(a, 'lowpass', 1800)).connect(env(a, 0.07, 0.05, dur)), 0.4);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    },
    rumble: (a, dur = 2.5) => {
      const g = a.createGain();
      const t0 = a.currentTime;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.9, t0 + 0.2);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      send(a, noise(a, dur).connect(filter(a, 'lowpass', 150)).connect(g), 0.6);
    },
    geiger: (a, dur = 1.5) => {
      for (let i = 0; i < 34; i++) {
        const s = Math.random() * dur;
        send(a, noise(a, 0.004, s).connect(filter(a, 'highpass', 2500)).connect(env(a, 0.3, 0.001, 0.01, s)));
      }
    },
    stamp: (a) => {
      tone(a, 140, 0, 0.18, { vol: 0.5, to: 50 });
      send(a, noise(a, 0.08).connect(filter(a, 'lowpass', 900)).connect(env(a, 0.3, 0.002, 0.08)), 0.3);
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
