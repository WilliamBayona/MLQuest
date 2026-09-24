'use strict';

// ---------- constants ----------
const W = 1024, H = 576;
const HB_W = 10, HB_H = 15;            // hitbox in world px; sprite frames are drawn at native 16px (1 sprite px = 1 map px)
const GRAVITY = 1400, MAX_FALL = 460;
const RUN_SPEED = 120, GROUND_ACC = 1200, AIR_ACC = 800, GROUND_FRIC = 1500;
const JUMP_V = 295, COYOTE = 0.1, JUMP_BUFFER = 0.12;   // one fixed ~31px hop: tables and steps (<=28px), never the floor above (>=34px)
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

// kind map: 0 empty, 1 solid wall, 2 one-way platform
// The collision is read straight off ML.png, from two things the art is consistent about:
//   · a floor slab is [black outline][light top strip][black][grey underside], and the grey
//     never gets covered, so it is what marks every floor out;
//   · anything standing on a floor — a table, a bench, a bookcase, the atrium platforms, a
//     stair step — is outlined in black with open room above it.
// Tall grey is a wall instead: the left pillar, the lift shaft, the stubs hanging off ceilings.
const AIR = [0xdebc8b, 0xeae0c5, 0x9e8572, 0xb4b4b4, 0x786257, 0x5b965b];  // wood, cream, brown, lobby grey, earth, grass
const UNDERSIDE = [0x696969, 0x323232];   // slab shading: light grey for floors, dark for the lobby beam
const SURFACE_SINK = 4;   // stand this deep into the top of a floor slab, so the feet overlap it
const OBJECT_SINK = 2;    // furniture tops are thinner than a slab, so the feet sit higher on them
const SLAB_TOP = 8;       // a slab's outline sits this far above its grey underside
const SLAB_CAP = 10;      // how far up to look for that outline before calling it a bare wall
const MIN_LEDGE = 6;      // shorter black runs are trim and window frames, not somewhere to stand
const WALL_RUN = 14;      // grey taller than this is a wall, on top of whatever floor it hangs from
const STEP_W = 14;        // a stair tread is never wider than this
const STEP_RUN = 3;       // and a flight is at least this many of them, so a machine isn't stairs
const STEP_BODY = 8;      // fill this far down each tread, so a flight is solid from the side
let kind;
function buildCollision(img) {
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  octx.drawImage(img, 0, 0);
  const d = octx.getImageData(0, 0, W, H).data;
  const rgb = new Int32Array(W * H);
  for (let p = 0, i = 0; p < rgb.length; p++, i += 4) rgb[p] = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
  kind = new Uint8Array(W * H);

  // Every slab in the art is drawn the same way: [black outline][light top strip][black][grey
  // underside]. The grey is what marks a floor out, because it runs unbroken beneath the
  // furniture, where a table or a bookcase would otherwise hide the slab's own outline.
  const isUnder = (c) => c === UNDERSIDE[0] || c === UNDERSIDE[1];
  const runs = [];
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!isUnder(rgb[y * W + x])) { y++; continue; }
      const c = rgb[y * W + x];
      let e = y;
      while (e < H && rgb[e * W + x] === c) e++;
      runs.push(x, y, e);
      y = e;
    }
  }
  // walk up from each grey run to the slab's outline; grey with nothing above it is the roof
  const floors = [];
  const lowest = new Int32Array(W).fill(-1);
  let roofY = H;
  for (let i = 0; i < runs.length; i += 3) {
    const x = runs[i], y0 = runs[i + 1];
    // a slab has an outline above its strip; the roof and bare walls do not. Measure the
    // surface from the grey itself, since furniture often covers the strip and its outline.
    let capped = false;
    if (y0 > 0 && rgb[(y0 - 1) * W + x] === 0)
      for (let t = y0 - 3; t >= y0 - SLAB_CAP && t >= 0; t--) if (rgb[t * W + x] === 0) { capped = true; break; }
    if (!capped) { if (y0 < roofY) roofY = y0; continue; }
    const top = y0 - SLAB_TOP;
    floors.push(x, top);
    if (top > lowest[x]) lowest[x] = top;
  }
  // a tall grey run is a wall — the left pillar, the lift shaft, the stubs hanging off a ceiling —
  // and it is marked on top of the floor it hangs from, not instead of it
  for (let i = 0; i < runs.length; i += 3) {
    const x = runs[i], y0 = runs[i + 1], y1 = runs[i + 2];
    if (y1 - y0 >= WALL_RUN || y0 < roofY + SLAB_CAP) for (let y = y0; y < y1; y++) kind[y * W + x] = 1;
  }
  for (let i = 0; i < floors.length; i += 2) {
    const x = floors[i], top = floors[i + 1], row = (top + SURFACE_SINK) * W + x;
    // with nothing below it, a floor is fully solid, so nobody can drop out of the world
    if (kind[row] !== 1) kind[row] = top === lowest[x] ? 1 : 2;
  }

  // Everything standing on those floors — the tables, the benches, the bookcases, the white
  // blocks — is outlined in black with open room above it. That outline is its top.
  const isAir = (c) => {
    for (let i = 0; i < AIR.length; i++) if (c === AIR[i]) return true;
    const r = c >> 16, g = (c >> 8) & 255, b = c & 255;   // the sky is a gradient, so take its whole range
    return r >= 185 && r <= 210 && g >= 215 && g <= 230 && b >= 230 && b <= 240;
  };
  // open space is a flat wall colour, or the black void outside the room — but a single black
  // line is an outline, not space, so black only counts where it runs thick
  const air = (x, y) => y < 0 || isAir(rgb[y * W + x]) ||
    (rgb[y * W + x] === 0 && y > 1 && rgb[(y - 1) * W + x] === 0 && rgb[(y - 2) * W + x] === 0);
  const body = (x, y) => { const c = rgb[y * W + x]; return c !== 0 && !isAir(c); };
  const isTop = (x, y) => rgb[y * W + x] === 0 && air(x, y - 1) && body(x, y + 1) && body(x, y + 2) && body(x, y + 3);
  for (let y = 1; y < H - 4; y++) {
    let x = 0;
    while (x < W) {
      if (!isTop(x, y)) { x++; continue; }
      let e = x;
      while (e < W && isTop(e, y)) e++;
      if (e - x >= MIN_LEDGE) {
        for (let k = x; k < e; k++) {
          // a floor slab already got its surface from the grey pass — leave those alone, this
          // pass is only for what stands on top of them
          let taken = false;
          for (let r = y + OBJECT_SINK; r <= y + SURFACE_SINK + 2 && !taken; r++) taken = kind[r * W + k] !== 0;
          if (!taken) kind[(y + OBJECT_SINK) * W + k] = 2;
        }
      }
      x = e;
    }
  }

  // Stairs are a chain of narrow treads stepping diagonally — some of them read as tiny slabs,
  // some as ledges, so gather them off the finished map. Fill each tread's front in, and a
  // flight becomes solid: it has to be climbed, not walked through from the side. Anything that
  // steps alone — a machine, a shelf — stays a platform you can pass in front of.
  const treads = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (kind[y * W + x] !== 2) { x++; continue; }
      let e = x;
      while (e < W && kind[y * W + e] === 2) e++;
      if (e - x <= STEP_W) treads.push(y, x, e - 1);
      x = e;
    }
  }
  const steps = (a, b) => {
    const dy = Math.abs(treads[a] - treads[b]), dx = Math.abs(treads[a + 1] - treads[b + 1]);
    return dy >= 4 && dy <= 12 && dx >= 3 && dx <= STEP_W;
  };
  const seen = new Uint8Array(treads.length / 3);
  for (let s = 0; s < treads.length; s += 3) {
    if (seen[s / 3]) continue;
    const flight = [s];
    seen[s / 3] = 1;
    for (let q = 0; q < flight.length; q++)
      for (let t = 0; t < treads.length; t += 3)
        if (!seen[t / 3] && steps(flight[q], t)) { seen[t / 3] = 1; flight.push(t); }
    if (flight.length < STEP_RUN) continue;
    for (const i of flight) {
      const y = treads[i], x0 = treads[i + 1], x1 = treads[i + 2];
      // a tread is floor, not furniture, so put every one of them at floor height: the two
      // passes sink by different amounts, which would leave 2px lips along the flight
      const outline = rgb[(y - OBJECT_SINK) * W + x0] === 0 ? y - OBJECT_SINK : y - SURFACE_SINK;
      for (let k = x0; k <= x1; k++) {
        if (kind[y * W + k] === 2) kind[y * W + k] = 0;
        for (let r = outline + SURFACE_SINK; r < outline + SURFACE_SINK + STEP_BODY && r < H; r++) kind[r * W + k] = 1;
      }
    }
  }
}
const K = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 1 : kind[y * W + x];

// ---------- input (websocket + keyboard) ----------
// Every player (one per phone, plus an optional keyboard player) owns its input state and edge latches.
const BUTTONS = ['left', 'right', 'up', 'down', 'jump', 'dash', 'act', 'die'];
const EDGE = ['jump', 'dash', 'act', 'die'];
const players = new Map();
let kbPlayer = null;

function onRemote(p, s) {
  for (const b of EDGE) if (s[b] && !p.input[b]) p.latch[b] = true;
  for (const b of BUTTONS) p.input[b] = !!s[b];
}
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down', Space: 'jump', KeyZ: 'jump', ShiftLeft: 'dash', ShiftRight: 'dash', KeyX: 'dash',
  KeyE: 'act', KeyK: 'die',
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
  const p = { id, slot, input: {}, latch: {}, score: {}, done: new Set(), asking: null, askT: 0, near: null };
  players.set(id, p);
  const prev = P; P = p; respawn(); P = prev;
  sendProgress(p);
  updateStatus();
  return p;
}
function removePlayer(id) { players.delete(id); if (id === 'kb') kbPlayer = null; updateStatus(); }
function respawn() {
  Object.assign(P, {
    x: SPAWN.x + (P.slot % 5) * 22, y: SPAWN.y, vx: 0, vy: 0, face: 1,
    ground: false, coyote: 0, jumpBuf: 0, wallDir: 0, grab: false, climbing: false,
    dashT: 0, dropT: 0, dashCd: 0, dashDir: 1, airDash: true, hitT: 0, lockT: 0,
    dead: false, deadT: 0, anim: 'Fall', animT: 0,
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
      // rows just below the feet, the same row groundBelow() looks at, so landings snap to whole px
      const prev = Math.floor(P.y + HB_H), row = Math.floor(ny + HB_H);
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
  if (P.asking) {
    P.latch.jump = P.latch.dash = P.latch.act = P.latch.die = false; P.input = {};
    P.askT -= dt;
    const left = document.getElementById('qt');
    if (left && P.id === 'kb') left.textContent = Math.max(0, Math.ceil(P.askT));
    if (P.askT <= 0) closeAsk(P);         // ran out of time: step away and come back to retry
  }
  const left = held('left'), right = held('right'), up = held('up'), down = held('down');
  const dirX = (right ? 1 : 0) - (left ? 1 : 0);
  const L = P.latch, jumpP = L.jump, dashP = L.dash, dieP = L.die;
  L.jump = L.dash = L.die = false;      // act is read by checkMarkers()

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
  if (P.ground) { P.coyote = COYOTE; P.airDash = true; }
  // down while standing on a thin floor: drop through to the floor below
  if (P.ground && down && P.hitT <= 0 && P.dashT <= 0 && onThinFloor()) { P.dropT = DROP_TIME; P.ground = false; P.coyote = 0; P.y += 1; }
  P.wallDir = !P.ground ? (wallSide(1) ? 1 : wallSide(-1) ? -1 : 0) : 0;

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
        P.vy = -JUMP_V; P.ground = false; P.coyote = 0; P.jumpBuf = 0;
      } else if (P.wallDir) {
        P.vx = -P.wallDir * WALL_JUMP_VX; P.vy = -JUMP_V * 0.95; P.face = -P.wallDir;
        P.lockT = WALL_LOCK; P.jumpBuf = 0; P.airDash = true; P.wallDir = 0;
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

    // gravity — one weight, so every jump is the same height however long the button is held
    if (!P.ground && !(P.grab && P.climbing)) {
      P.vy = Math.min(P.vy + GRAVITY * dt, MAX_FALL);
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

// ---------- the aptitude test, laid over the building ----------
// Each room in EVENTS floats an exclamation mark, lit for everyone since the screen is shared.
// Standing under one and pressing ACCIÓN sends its question to that player's phone; each player
// answers any EVENTS_PER_PLAYER of them, never the same one twice. After the last one they are sent
// up to the tree on the roof (GOAL), where ACCIÓN hands over their top 3 careers.
let ws = null;
const toPhone = (id, msg) => { if (ws && ws.readyState === 1 && id !== 'kb') ws.send(JSON.stringify({ ...msg, id })); };
const atMarker = (p, m) => p.ground && Math.abs(p.x + HB_W / 2 - m.x) < 14 && Math.abs(p.y + HB_H - m.row) <= 4;
const finished = (p) => p.done.size >= EVENTS_PER_PLAYER;

function askEvent(p, ev) {
  p.asking = ev;
  p.askT = ANSWER_SECONDS;
  const ask = {
    t: 'ask', ev: ev.id, room: ev.room, floor: ev.floor, item: ev.item, context: ev.context,
    question: ev.question, options: ev.options.map((o) => o.t), seconds: ANSWER_SECONDS,
  };
  toPhone(p.id, ask);
  if (p.id === 'kb') localQuiz(ask);
}
function closeAsk(p) {
  p.asking = null;
  toPhone(p.id, { t: 'close' });
  if (p.id === 'kb') localQuiz(null);
}
function answerEvent(p, choice) {
  const ev = p.asking;
  if (!ev || !(choice >= 0 && choice < ev.options.length)) return;
  for (const [k, v] of Object.entries(ev.options[choice].s)) p.score[k] = (p.score[k] || 0) + v;
  p.done.add(ev.id);
  closeAsk(p);
  sendProgress(p);
  if (finished(p)) notice(p, '¡Completaste tus ' + EVENTS_PER_PLAYER + ' eventos!', GOAL_TEXT, true);
  else toPhone(p.id, { t: 'saved', item: ev.item, collected: p.done.size, total: EVENTS_PER_PLAYER });
}
// how far along a player is goes to their own phone only, never onto the shared screen
function sendProgress(p) { toPhone(p.id, { t: 'progress', collected: p.done.size, total: EVENTS_PER_PLAYER }); }
function sendResult(p) {
  const res = {
    t: 'result', collected: p.done.size, total: EVENTS_PER_PLAYER,
    top: ranking(p.score).slice(0, 3).map((c) => ({ name: c.name, pct: c.pct, points: c.points })),
  };
  toPhone(p.id, res);
  if (p.id === 'kb') localQuiz(res);
}
// a short message on the player's phone; `stay` keeps it up until they close it
function notice(p, title, text, stay = false) {
  const m = { t: 'notice', title, text, stay };
  toPhone(p.id, m);
  if (p.id === 'kb') localQuiz(m);
}
function setNear(p, id) {
  if (p.near === id) return;
  p.near = id;
  toPhone(p.id, { t: 'near', on: id !== null });   // the phone lights up its ACCIÓN button
}
// runs after step(), so the ACCIÓN latch is still set: nothing fires by just walking past a marker
function checkMarkers(p) {
  const act = p.latch.act; p.latch.act = false;
  if (p.dead || p.asking) return;
  const done = finished(p), atGoal = atMarker(p, GOAL);
  const ev = atGoal ? null : EVENTS.find((e) => atMarker(p, e));
  // ACCIÓN only lights up where it will do something: an unanswered event, or the tree once finished
  setNear(p, atGoal ? (done ? 'goal' : null) : ev && !done && !p.done.has(ev.id) ? ev.id : null);
  if (!act) return;
  if (atGoal) {
    if (done) sendResult(p);
    else {
      const left = EVENTS_PER_PLAYER - p.done.size;
      notice(p, 'Todavía no', `Te ${left === 1 ? 'falta 1 evento' : `faltan ${left} eventos`}. Respóndelos y vuelve al árbol para ver tus resultados.`);
    }
  } else if (ev) {
    if (done) notice(p, 'Ya completaste tus eventos', GOAL_TEXT);
    else if (p.done.has(ev.id)) notice(p, 'Ya respondiste este evento', 'Busca otro signo de admiración y oprime ACCIÓN debajo de él.');
    else askEvent(p, ev);
  }
}

// the markers themselves, drawn over the map
function drawBang(cx, by, col) {
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 3, by - 13, 6, 13);
  ctx.fillStyle = col;
  ctx.fillRect(cx - 2, by - 12, 4, 7);
  ctx.fillRect(cx - 2, by - 3, 4, 2);
}
function drawStar(cx, by) {
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - 5, by - 12, 10, 12);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(cx - 1, by - 11, 2, 10);
  ctx.fillRect(cx - 4, by - 7, 8, 2);
  ctx.fillRect(cx - 3, by - 9, 6, 6);
}
function drawMarkers(t) {
  drawStar(GOAL.x, GOAL.row - 20 + Math.round(Math.sin(t * 2.2) * 2));
  for (const ev of EVENTS) {
    const by = ev.row - 20 + Math.round(Math.sin(t * 2.2 + ev.id) * 2);
    drawBang(ev.x, by, '#ffd23f');   // always lit: the screen is shared, so a marker never goes out for everyone
  }
}

// the same question on the game screen, for whoever is playing on the keyboard
const quizBox = document.getElementById('quiz');
function localQuiz(m) {
  if (!m) { quizBox.classList.add('hide'); return; }
  quizBox.classList.remove('hide');
  if (m.t === 'notice') {
    quizBox.innerHTML = `<h2>${m.title}</h2><p>${m.text}</p>`;
    if (!m.stay) setTimeout(() => { if (quizBox.innerHTML.includes(m.text)) localQuiz(null); }, 2500);
    return;
  }
  if (m.t === 'result') {
    quizBox.innerHTML = `<h2>Top 3 · ${m.collected}/${m.total} respondidas</h2>` +
      (m.top.length ? m.top.map((c, i) => `<p class="rank"><b>${i + 1}. ${c.name}</b> — ${c.pct}%</p>`).join('') : '<p>Responde algún evento primero.</p>');
    return;
  }
  quizBox.innerHTML = `<h2>${m.room} · ${m.floor}</h2><p>${m.context}</p><p><b>${m.question}</b></p>` +
    m.options.map((o, i) => `<p class="opt"><b>${i + 1}</b> ${o}</p>`).join('') +
    `<p class="hint">Responde con las teclas 1–5 · <span id="qt">${m.seconds}</span>s</p>`;
}
addEventListener('keydown', (e) => {
  const n = '12345'.indexOf(e.key);
  if (n >= 0 && kbPlayer && kbPlayer.asking) { answerEvent(kbPlayer, n); e.preventDefault(); }
});

// ---------- render ----------
let bg; const sheets = {};
const tinted = new Map();      // slot -> { anim: canvas }, hue-rotated copies of the sprite sheets
const HUES = [0, 200, 100, 290];            // controller.html repeats these two lists for its character preview
const hueFor = (slot) => (slot === 0 ? 60 : HUES[(slot - 1) % HUES.length]);
const LABEL_COLORS = ['#e16714', '#4aa3ff', '#5fd068', '#c76bff'];
const tagColor = (p) => (p.slot === 0 ? '#c9b400' : LABEL_COLORS[(p.slot - 1) % LABEL_COLORS.length]);

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
  // the depth overlap lives in the collision mask (SURFACE_SINK), so the feet are drawn where they really are
  const cx = Math.round(P.x + HB_W / 2), by = Math.round(P.y + HB_H);
  ctx.save();
  ctx.translate(cx, by);
  if (P.face < 0) ctx.scale(-1, 1);
  const ox = P.anim === 'Wallslide' || P.anim === 'Climb' ? -3 : 0;   // keep the hand on the wall, not inside it
  ctx.drawImage(img, f * 16, 0, 16, 16, -8 + ox, -16, 16, 16);
  ctx.restore();
  // tiny tag over the head so players can tell each other apart
  ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = tagColor(P);
  ctx.fillText(P.slot === 0 ? 'KB' : `P${P.slot}`, cx, by - 19);
  // standing under a marker they have not answered yet: remind them which button opens it
  if (P.near !== null && !P.asking) {
    ctx.font = 'bold 7px monospace';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.strokeText('ACCIÓN', cx, by - 28);
    ctx.fillStyle = '#ffd23f'; ctx.fillText('ACCIÓN', cx, by - 28);
  }
}
function draw(t) {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(bg, 0, 0);
  drawMarkers(t);
  for (const p of players.values()) { P = p; drawPlayer(); }
}

let acc = 0, last = performance.now();
function frame(now) {
  acc += Math.min(0.1, (now - last) / 1000); last = now;
  while (acc >= STEP) { for (const p of players.values()) { P = p; step(STEP); checkMarkers(p); } acc -= STEP; }
  draw(now / 1000);
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
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=game`);
  ws.onopen = () => { connected = true; updateStatus(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'join') { if (!players.has(m.id)) addPlayer(m.id, m.slot); }
    else if (m.t === 'leave') removePlayer(m.id);
    else if (m.t === 'input') { if (!players.has(m.id)) addPlayer(m.id, m.slot); onRemote(players.get(m.id), m.s || {}); }
    else if (m.t === 'answer') { const p = players.get(m.id); if (p) answerEvent(p, m.choice); }
    else if (m.t === 'seen') { const p = players.get(m.id); if (p && p.asking) closeAsk(p); }
  };
  ws.onclose = () => {
    connected = false; updateStatus(); setTimeout(connect, 1000);
    for (const id of [...players.keys()]) if (id !== 'kb') removePlayer(id);   // server re-announces them on reconnect
  };
}

(async function init() {
  const [map, ...imgs] = await Promise.all([loadImg('ML.png'), ...Object.keys(SPRITES).map((n) => loadImg(`sprites/${n}.png`))]);
  bg = map;
  Object.keys(SPRITES).forEach((n, i) => { sheets[n] = imgs[i]; });
  buildCollision(map);
  // the tree's planter has no floor drawn under it: make it a solid block you can bump into or stand on
  const pl = GOAL.planter;
  for (let y = pl.top + SURFACE_SINK; y <= pl.bottom; y++) for (let x = pl.x0; x <= pl.x1; x++) kind[y * W + x] = 1;
  connect();
  fetch('/api/info').then((r) => r.json()).then((i) => {
    // on a LAN run, point phones at this PC's address; once deployed, the page's own origin is the one to share
    const local = /^(localhost|127\.)/.test(location.hostname);
    const url = local && i.ips[0] ? `http://${i.ips[0]}:${i.port}/controller` : `${location.origin}/controller`;
    const a = document.getElementById('ctrlUrl'); a.href = url; a.textContent = url;
  }).catch(() => {});
  requestAnimationFrame(frame);
})();
