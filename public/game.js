'use strict';

// ---------- constants ----------
const W = 1024, H = 576;
const HB_W = 10, HB_H = 15;            // hitbox in world px; sprite frames are drawn at native 16px (1 sprite px = 1 map px)
const GRAVITY = 1400, MAX_FALL = 460;
const RUN_SPEED = 120, GROUND_ACC = 1200, AIR_ACC = 800, GROUND_FRIC = 1500;
const JUMP_V = 500, COYOTE = 0.1, JUMP_BUFFER = 0.12;
const WALL_SLIDE = 45, WALL_SLIDE_FAST = 130, WALL_CLIMB = 65;
const WALL_JUMP_VX = 150, WALL_LOCK = 0.17;
const DASH_TIME = 0.18, DASH_SPEED = 300, DASH_COOLDOWN = 0.45;
const DROP_TIME = 0.18, HIT_TIME = 0.5, DEATH_TIME = 1.4;
const SPAWN = { x: 90, y: 300 };
const STEP = 1 / 60;

const SPRITES = {            // file, frames, fps, loop
  Idle:      { n: 4, fps: 6,  loop: true },
  Run:       { n: 5, fps: 14, loop: true },
  Jump:      { n: 1, fps: 1,  loop: true },
  Fall:      { n: 1, fps: 1,  loop: true },
  Dash:      { n: 1, fps: 1,  loop: true },
  Wallslide: { n: 4, fps: 10, loop: true },
  Climb:     { n: 2, fps: 8,  loop: true },
  Hit:       { n: 7, fps: 14, loop: false },
  Death:     { n: 1, fps: 1,  loop: false },
};

// ---------- assets ----------
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// kind map: 0 empty, 1 solid wall, 2 one-way platform (orange pixels of the map)
let kind;
function buildCollision(img) {
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  const d = octx.getImageData(0, 0, W, H).data;
  kind = new Uint8Array(W * H);
  let topY = H, botY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 180 && g > 70 && g < 140 && b < 70) { kind[y * W + x] = 2; if (y < topY) topY = y; if (y > botY) botY = y; }
  }
  // long vertical runs are walls (solid); short ones are thin floors (one-way, jump through from below)
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!kind[y * W + x]) { y++; continue; }
      let e = y;
      while (e < H && kind[e * W + x]) e++;
      if (e - y >= 14) for (let k = y; k < e; k++) kind[k * W + x] = 1;
      y = e;
    }
  }
  // floor of the frame is solid too (can't drop out of the map)
  for (let y = botY - 7; y <= botY; y++) for (let x = 0; x < W; x++) if (kind[y * W + x]) kind[y * W + x] = 1;
  // ceiling of the frame is solid so the player can't leave the map upward
  for (let y = topY; y < topY + 8; y++) for (let x = 0; x < W; x++) if (kind[y * W + x]) kind[y * W + x] = 1;
}
const K = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 1 : kind[y * W + x];

// ---------- input (websocket + keyboard) ----------
// Every player (one per phone, plus an optional keyboard player) owns its input state and edge latches.
const BUTTONS = ['left', 'right', 'up', 'down', 'jump', 'dash', 'hit', 'die'];
const EDGE = ['jump', 'dash', 'hit', 'die'];
const players = new Map();
let kbPlayer = null;

function onRemote(p, s) {
  for (const b of EDGE) if (s[b] && !p.input[b]) p.latch[b] = true;
  for (const b of BUTTONS) p.input[b] = !!s[b];
}
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down', Space: 'jump', KeyZ: 'jump', ShiftLeft: 'dash', ShiftRight: 'dash', KeyX: 'dash',
  KeyH: 'hit', KeyK: 'die',
};
addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  if (e.code === 'KeyI') document.getElementById('bar').classList.toggle('hide');
});
addEventListener('dblclick', () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); });
function keyboardPlayer() {
  if (!kbPlayer || !players.has('kb')) kbPlayer = addPlayer('kb', 0);
  return kbPlayer;
}
addEventListener('keydown', (e) => {
  const a = KEYMAP[e.code]; if (!a) return;
  e.preventDefault();
  const p = keyboardPlayer();
  if (!p.input[a] && EDGE.includes(a)) p.latch[a] = true;
  p.input[a] = true;
});
addEventListener('keyup', (e) => { const a = KEYMAP[e.code]; if (a) { if (kbPlayer) kbPlayer.input[a] = false; e.preventDefault(); } });
const held = (a) => !!P.input[a];

// ---------- player ----------
let P;   // the player currently being updated / drawn
function addPlayer(id, slot) {
  const p = { id, slot, input: {}, latch: {} };
  players.set(id, p);
  const prev = P; P = p; respawn(); P = prev;
  updateStatus();
  return p;
}
function removePlayer(id) { players.delete(id); if (id === 'kb') kbPlayer = null; updateStatus(); }
function respawn() {
  Object.assign(P, {
    x: SPAWN.x + (P.slot % 5) * 22, y: SPAWN.y, vx: 0, vy: 0, face: 1,
    ground: false, coyote: 0, jumpBuf: 0, wallDir: 0, grab: false, climbing: false,
    dashT: 0, dropT: 0, dashCd: 0, dashDir: 1, airDash: true, hitT: 0, lockT: 0,
    dead: false, deadT: 0, anim: 'Fall', animT: 0, jumped: false,
  });
}

function groundBelow() {
  const x0 = Math.floor(P.x), row = Math.floor(P.y + HB_H);
  for (let x = x0; x < x0 + HB_W; x++) {
    const k = K(x, row);
    if (k === 1) return true;
    if (k === 2 && P.dropT <= 0 && K(x, row - 1) !== 2) return true;
  }
  return false;
}
function onThinFloor() {
  const x0 = Math.floor(P.x), row = Math.floor(P.y + HB_H);
  let thin = false;
  for (let x = x0; x < x0 + HB_W; x++) { const k = K(x, row); if (k === 1) return false; if (k === 2) thin = true; }
  return thin;
}
function wallSide(dir) {
  const x = dir > 0 ? Math.floor(P.x) + HB_W : Math.floor(P.x) - 1;
  const y0 = Math.floor(P.y);
  for (let y = y0 + 1; y < y0 + HB_H - 1; y++) if (K(x, y) === 1) return true;
  return false;
}
function moveX(dx) {
  const dir = Math.sign(dx);
  let rem = Math.abs(dx);
  while (rem > 0) {
    const s = Math.min(1, rem); rem -= s;
    const nx = P.x + dir * s;
    const col = dir > 0 ? Math.floor(nx) + HB_W - 1 : Math.floor(nx);
    let blocked = false;
    const y0 = Math.floor(P.y);
    for (let y = y0; y < y0 + HB_H; y++) if (K(col, y) === 1) { blocked = true; break; }
    if (blocked) { P.vx = 0; return; }
    P.x = nx;
  }
}
function moveY(dy) {
  const dir = Math.sign(dy);
  let rem = Math.abs(dy);
  while (rem > 0) {
    const s = Math.min(1, rem); rem -= s;
    const ny = P.y + dir * s;
    const x0 = Math.floor(P.x);
    if (dir > 0) {
      const prev = Math.floor(P.y + HB_H) - 1, row = Math.floor(ny + HB_H) - 1;
      if (row > prev) {
        let land = false;
        for (let x = x0; x < x0 + HB_W; x++) {
          const k = K(x, row);
          if (k === 1 || (k === 2 && P.dropT <= 0 && K(x, prev) !== 2)) { land = true; break; }
        }
        if (land) { P.y = row - HB_H; P.vy = 0; P.ground = true; return; }
      }
    } else {
      const prev = Math.floor(P.y), row = Math.floor(ny);
      if (row < prev) {
        let hit = false;
        for (let x = x0; x < x0 + HB_W; x++) if (K(x, row) === 1) { hit = true; break; }
        if (hit) { P.vy = 0; return; }
      }
    }
    P.y = ny;
  }
}

function step(dt) {
  const left = held('left'), right = held('right'), up = held('up'), down = held('down'), jumpHeld = held('jump');
  const dirX = (right ? 1 : 0) - (left ? 1 : 0);
  const L = P.latch, jumpP = L.jump, dashP = L.dash, hitP = L.hit, dieP = L.die;
  L.jump = L.dash = L.hit = L.die = false;

  P.animT += dt;
  if (dieP && !P.dead) { P.dead = true; P.deadT = 0; P.vx = 0; P.vy = -200; P.dashT = 0; P.hitT = 0; setAnim('Death'); }

  if (P.dead) {
    P.deadT += dt;
    P.vy = Math.min(P.vy + GRAVITY * dt, MAX_FALL);
    P.vx *= 0.9;
    moveX(P.vx * dt); moveY(P.vy * dt);
    if (P.deadT > DEATH_TIME) respawn();
    return;
  }

  P.dropT -= dt; P.dashCd -= dt; P.lockT -= dt; P.hitT -= dt; P.dashT -= dt; P.jumpBuf -= dt; P.coyote -= dt;
  if (jumpP) P.jumpBuf = JUMP_BUFFER;

  P.ground = groundBelow();
  if (P.ground) { P.coyote = COYOTE; P.airDash = true; P.jumped = false; }
  // down while standing on a thin floor: drop through to the floor below
  if (P.ground && down && P.hitT <= 0 && P.dashT <= 0 && onThinFloor()) { P.dropT = DROP_TIME; P.ground = false; P.coyote = 0; P.y += 1; }
  P.wallDir = !P.ground ? (wallSide(1) ? 1 : wallSide(-1) ? -1 : 0) : 0;

  // hit (damage reaction with knockback)
  if (hitP && P.hitT <= 0 && P.dashT <= 0) {
    P.hitT = HIT_TIME; P.vx = -P.face * 100; P.vy = -190; P.ground = false; setAnim('Hit');
  }

  const dashing = P.dashT > 0;
  if (dashP && P.dashCd <= 0 && !dashing && P.hitT <= 0 && (P.ground || P.airDash)) {
    P.dashT = DASH_TIME; P.dashCd = DASH_COOLDOWN; P.dashDir = dirX || P.face; P.face = P.dashDir;
    if (!P.ground) P.airDash = false;
    P.vy = 0;
  }

  const controlled = P.lockT <= 0 && P.hitT <= 0 && P.dashT <= 0;

  if (P.dashT > 0) {
    P.vx = P.dashDir * DASH_SPEED; P.vy = 0;
  } else {
    if (controlled) {
      if (dirX) P.face = dirX;
      const target = dirX * RUN_SPEED;
      const acc = dirX === 0 ? (P.ground ? GROUND_FRIC : AIR_ACC * 0.6) : (P.ground ? GROUND_ACC : AIR_ACC);
      if (P.vx < target) P.vx = Math.min(P.vx + acc * dt, target);
      else if (P.vx > target) P.vx = Math.max(P.vx - acc * dt, target);
    } else if (P.hitT <= 0 && P.ground) {
      P.vx *= 0.85;
    }

    // jump / wall jump
    if (P.jumpBuf > 0 && P.hitT <= 0) {
      if (P.ground || P.coyote > 0) {
        P.vy = -JUMP_V; P.ground = false; P.coyote = 0; P.jumpBuf = 0; P.jumped = true;
      } else if (P.wallDir) {
        P.vx = -P.wallDir * WALL_JUMP_VX; P.vy = -JUMP_V * 0.95; P.face = -P.wallDir;
        P.lockT = WALL_LOCK; P.jumpBuf = 0; P.jumped = true; P.airDash = true; P.wallDir = 0;
      }
    }

    // wall grab: slide, climb up, or drop fast
    P.grab = P.wallDir !== 0 && P.hitT <= 0 && P.lockT <= 0 && (dirX === P.wallDir || up || down);
    if (P.grab) {
      P.face = P.wallDir;
      if (up && (P.vy >= -20 || P.climbing)) { P.vy = -WALL_CLIMB; P.climbing = true; }
      else if (down) { P.vy = WALL_SLIDE_FAST; P.climbing = false; }
      else if (P.vy > 0) { P.vy = Math.min(P.vy, WALL_SLIDE); P.climbing = false; }
      else P.climbing = false;
    } else P.climbing = false;

    // gravity (heavier when the jump button is released early)
    if (!P.ground && !(P.grab && P.climbing)) {
      const mult = (P.vy < 0 && !jumpHeld && P.jumped) ? 2.4 : 1;
      P.vy = Math.min(P.vy + GRAVITY * mult * dt, MAX_FALL);
      if (P.grab && !down && !P.climbing && P.vy > WALL_SLIDE) P.vy = WALL_SLIDE;
    }
    if (P.ground && P.vy > 0) P.vy = 0;
    if (P.dropT > 0 && P.vy < 60) P.vy = 60;
  }
  if (P.dashT <= 0 && P.dashT > -dt) P.vx = Math.sign(P.vx) * Math.min(Math.abs(P.vx), RUN_SPEED * 1.15);

  P.ground = false;
  moveX(P.vx * dt);
  moveY(P.vy * dt);
  if (!P.ground) P.ground = P.vy >= 0 && groundBelow();

  // pick animation
  const moving = Math.abs(P.vx) > 20;
  if (P.hitT > 0) setAnim('Hit');
  else if (P.dashT > 0) setAnim('Dash');
  else if (P.ground) setAnim(moving && dirX !== 0 ? 'Run' : 'Idle');
  else if (P.grab && P.wallDir) setAnim(P.climbing ? 'Climb' : 'Wallslide');
  else setAnim(P.vy < 0 ? 'Jump' : 'Fall');
}
function setAnim(a) { if (P.anim !== a) { P.anim = a; P.animT = 0; } }

// ---------- render ----------
let bg; const sheets = {};
const tinted = new Map();      // slot -> { anim: canvas }, hue-rotated copies of the sprite sheets
const HUES = [0, 200, 100, 290];
const hueFor = (slot) => (slot === 0 ? 60 : HUES[(slot - 1) % HUES.length]);
const LABEL_COLORS = ['#e16714', '#4aa3ff', '#5fd068', '#c76bff'];

function tintedSheets(slot) {
  const hue = hueFor(slot);
  if (!hue) return sheets;
  if (tinted.has(slot)) return tinted.get(slot);
  const a = hue * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const m = [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ];
  const out = {};
  for (const [name, img] of Object.entries(sheets)) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, c.width, c.height), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      d[i] = Math.max(0, Math.min(255, m[0] * r + m[1] * g + m[2] * b));
      d[i + 1] = Math.max(0, Math.min(255, m[3] * r + m[4] * g + m[5] * b));
      d[i + 2] = Math.max(0, Math.min(255, m[6] * r + m[7] * g + m[8] * b));
    }
    cx.putImageData(id, 0, 0);
    out[name] = c;
  }
  tinted.set(slot, out);
  return out;
}

function drawPlayer() {
  const def = SPRITES[P.anim], img = tintedSheets(P.slot)[P.anim];
  let f = Math.floor(P.animT * def.fps);
  f = def.loop ? f % def.n : Math.min(f, def.n - 1);
  if (P.anim === 'Hit') f = Math.min(def.n - 1, Math.floor((P.animT / HIT_TIME) * def.n));
  if (P.dead && P.deadT > DEATH_TIME - 0.4 && Math.floor(P.deadT * 20) % 2) return; // blink before respawn
  const cx = Math.round(P.x + HB_W / 2), by = Math.round(P.y + HB_H);
  ctx.save();
  ctx.translate(cx, by);
  if (P.face < 0) ctx.scale(-1, 1);
  const ox = P.anim === 'Wallslide' || P.anim === 'Climb' ? -3 : 0;   // keep the hand on the wall, not inside it
  ctx.drawImage(img, f * 16, 0, 16, 16, -8 + ox, -16, 16, 16);
  ctx.restore();
  // tiny tag over the head so players can tell each other apart
  ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.slot === 0 ? '#c9b400' : LABEL_COLORS[(P.slot - 1) % LABEL_COLORS.length];
  ctx.fillText(P.slot === 0 ? 'KB' : `P${P.slot}`, cx, by - 19);
}
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bg, 0, 0);
  for (const p of players.values()) { P = p; drawPlayer(); }
}

let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000); last = now;
  while (acc >= STEP) { for (const p of players.values()) { P = p; step(STEP); } acc -= STEP; }
  draw();
  requestAnimationFrame(frame);
}

// ---------- websocket ----------
const dot = document.getElementById('wsDot'), txt = document.getElementById('wsTxt');
let connected = false;
function updateStatus() {
  const phones = [...players.values()].filter((p) => p.id !== 'kb').length;
  dot.classList.toggle('on', phones > 0);
  txt.textContent = !connected ? 'desconectado, reintentando…' : phones ? `${phones} control${phones > 1 ? 'es' : ''} conectado${phones > 1 ? 's' : ''}` : 'servidor ok · esperando control';
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=game`);
  ws.onopen = () => { connected = true; updateStatus(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'join') { if (!players.has(m.id)) addPlayer(m.id, m.slot); }
    else if (m.t === 'leave') removePlayer(m.id);
    else if (m.t === 'input') { if (!players.has(m.id)) addPlayer(m.id, m.slot); onRemote(players.get(m.id), m.s || {}); }
  };
  ws.onclose = () => {
    connected = false; updateStatus(); setTimeout(connect, 1000);
    for (const id of [...players.keys()]) if (id !== 'kb') removePlayer(id);   // server re-announces them on reconnect
  };
}

(async function init() {
  const [map, ...imgs] = await Promise.all([loadImg('MapaML.png'), ...Object.keys(SPRITES).map((n) => loadImg(`sprites/${n}.png`))]);
  bg = map;
  Object.keys(SPRITES).forEach((n, i) => { sheets[n] = imgs[i]; });
  buildCollision(map);
  connect();
  fetch('/api/info').then((r) => r.json()).then((i) => {
    const host = /^(localhost|127\.)/.test(location.hostname) && i.ips[0] ? i.ips[0] : location.hostname;
    const url = `http://${host}:${i.port}/controller`;
    const a = document.getElementById('ctrlUrl'); a.href = url; a.textContent = url;
  }).catch(() => {});
  requestAnimationFrame(frame);
})();
