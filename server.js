#!/usr/bin/env node
/*
 * Slythera.io — online sunucu (Node 18+, bağımlılık YOK)
 *
 * Çalıştırma:   node server.js
 * Sonra:        http://SUNUCU_IP:8080   (oyun dosyası aynı klasörde index.html ya da
 *               Slythera_Jackpot-v4.html adıyla durmalı; sunucu onu da servis eder)
 *
 * Ortam değişkenleri (hepsi isteğe bağlı):
 *   PORT=8080  MAX_ROOM=30 (oda başına gerçek oyuncu)  BOT_FILL=14 (oda bu sayıya kadar botla dolar)
 *   MAX_PER_IP=6  TRUST_PROXY=1 (nginx/Caddy arkasındaysa)  ALLOWED_ORIGINS=https://site.com,https://x.com
 *   GAME_FILE=/tam/yol/oyun.html
 *
 * Mimari: sunucu otoriter. İstemci yalnızca {yön açısı, hızlanma} yollar; hareket, yem,
 * çarpışma, skor ve ölüm sunucuda hesaplanır (hile yapmak zor). 60 Hz simülasyon, 20 Hz snapshot.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const MAX_ROOM = +process.env.MAX_ROOM || 30;
const BOT_FILL = process.env.BOT_FILL !== undefined ? +process.env.BOT_FILL : 14;
const MAX_PER_IP = +process.env.MAX_PER_IP || 6;
const MAX_ROOMS = 60;
const MAX_PRIVATE = +process.env.MAX_PRIVATE || 30;          // aynı anda açık özel lobi sayısı
const MAX_PRIVATE_PLAYERS = +process.env.MAX_PRIVATE_PLAYERS || 16; // özel lobide oyuncu sınırı
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

/* ---------------- oyun sabitleri (istemciyle birebir aynı) ---------------- */
const TAU = Math.PI * 2, WORLD = 4200, BASE = 2.8, BOOST = 5.2, AMBIENT = 1100, POWER_COUNT = 14;
const TYPES = [
  { spd: 1, turn: 1, rad: 1, mag: 1, cost: 1 },
  { spd: 1.12, turn: 0.85, rad: 0.95, mag: 1, cost: 1.4 },
  { spd: 0.92, turn: 0.9, rad: 1.25, mag: 1.3, cost: 0.9 },
  { spd: 1, turn: 1.45, rad: 0.85, mag: 0.9, cost: 1 },
  { spd: 0.97, turn: 1, rad: 1, mag: 2, cost: 1 }
];
const POWERS = [{ id: 'kalkan', dur: 240 }, { id: 'miknatis', dur: 300 }, { id: 'hiz', dur: 210 }, { id: 'cift', dur: 360 }];
const FOOD_COLORS = ['#ff4d5e', '#ffd23f', '#5af0b3', '#3ec9ff', '#c43bff', '#ff9f43', '#ff6fb5', '#c8f542'];
const NAMES = ['Kobra', 'Anakonda', 'Boa', 'Zeynep', 'Bora', 'Mert', 'Elif', 'Pars', 'Çınar', 'Deniz', 'Efe', 'Ada', 'Tarkan', 'Mavi', 'Fırtına', 'Sultan', 'Atlas', 'Yıldız', 'Ege', 'Kuzey', 'Poyraz', 'Tuna', 'Lale', 'Karaca', 'Sedef', 'Umay', 'Kıvrak', 'Yılancık', 'Gölge', 'Ejder'];
const BOT_SKINS = [['#ffd23f', '#ff8c42'], ['#3ec9ff', '#2b6bff'], ['#5af0b3', '#1fb58a'], ['#ff6fb5', '#c43bff'], ['#ff4d5e', '#ff9f43'],
  ['#ff4d5e', '#ffd23f', '#5af0b3', '#3ec9ff', '#c43bff'], ['#39ff14', '#00e5ff'], ['#2fe08f', '#0b6b45'], ['#ff3d00', '#4a0d00'],
  ['#ffb3d9', '#ffffff', '#9ad7ff'], ['#00f0ff', '#7a00ff'], ['#b28dff', '#7a4dff'], ['#c8f542', '#6fd13a'], ['#f2e3b3', '#d1a85f']];
const HATS = ['none', 'top', 'party', 'cowboy', 'wizard', 'santa', 'flower', 'crown', 'pirate', 'chef', 'viking', 'halo', 'cap'];
const GLS = ['none', 'round', 'sun', 'heart', 'star', 'pixel', 'mono', 'visor', 'nerd'];
const ANI = ['snake', 'cobra', 'viper', 'python', 'horned', 'rattle', 'basilisk', 'dragon', 'ghost', 'naga'];
const PAT = ['solid', 'stripe', 'dots', 'glow', 'zigzag', 'scales', 'checker', 'rainbow', 'neon'];
const FRM = ['none', 'bear', 'panda', 'cow', 'cat', 'fox', 'tiger', 'dragon', 'wolf', 'rabbit', 'frog', 'shark', 'lion', 'penguin', 'deer', 'turtle'];
const FLG = ['none', 'tr', 'us', 'gb', 'de', 'fr', 'it', 'jp', 'br', 'kr', 'ca', 'es', 'ua', 'in', 'mx'];

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const wrap = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;
const pick = (a, p) => Math.random() < p ? a[1 + ((Math.random() * (a.length - 1)) | 0)] : a[0];
const radius = s => (7 + Math.min(7, Math.sqrt(s.score) * 0.3)) * s.type.rad;
const segCount = score => Math.min(100, Math.floor(10 + 8 * Math.log1p(Math.max(0, score - 10) / 15)));
const segColor = (skin, i) => skin.c[Math.floor(i / 3) % skin.c.length];
const randPoint = maxR => { const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * maxR; return { x: Math.cos(a) * r, y: Math.sin(a) * r }; };

/* ---------------- oda (simülasyon) ---------------- */
function createRoom(key, opts) {
  opts = opts || {};
  const salt = opts.priv && opts.pw ? crypto.randomBytes(16) : null;
  const pwHash = salt ? crypto.scryptSync(String(opts.pw), salt, 32) : null;
  function checkPw(pw) {
    if (!pwHash) return true;
    try { return crypto.timingSafeEqual(crypto.scryptSync(String(pw || ''), salt, 32), pwHash); } catch (e) { return false; }
  }
  let snakes = [], foods = [], powerups = [], ambCount = 0, fgrid = Object.create(null), tick = 0, nid = 1, fid = 1, pid = 1;
  let sorted = [], lbCache = [];
  const clients = new Set();
  let emptySince = Date.now();

  function buildGrid() {
    fgrid = Object.create(null);
    for (let i = 0; i < foods.length; i++) {
      const f = foods[i], k = Math.floor(f.x / 128) * 256 + Math.floor(f.y / 128), c = fgrid[k];
      if (c) c.push(f); else fgrid[k] = [f];
    }
  }
  function addFood(x, y, v, c, amb, k) {
    if (foods.length > 2200 && !amb) return;
    foods.push({ id: fid++, x, y, v, c, amb, k, e: 0 });
    if (amb) ambCount++;
  }
  function spawnAmbient() {
    const p = randPoint(WORLD - 300);
    addFood(p.x, p.y, Math.random() < 0.12 ? 2.5 : 1, FOOD_COLORS[(Math.random() * FOOD_COLORS.length) | 0], true);
  }
  function spawnPower(x, y) {
    if (x === undefined) { const p = randPoint(WORLD - 450); x = p.x; y = p.y; }
    powerups.push({ id: pid++, x, y, ti: (Math.random() * POWERS.length) | 0 });
  }
  function safePoint(maxR) {
    let p = null;
    for (let t = 0; t < 14; t++) {
      p = randPoint(maxR);
      let ok = true;
      for (const o of snakes) {
        if (o.dead) continue;
        const dx = o.x - p.x, dy = o.y - p.y;
        if (dx * dx + dy * dy < 450 * 450) { ok = false; break; }
      }
      if (ok) return p;
    }
    return p;
  }

  function makeSnake(id, name, skin, human, x, y, score, angle, type, look) {
    const s = {
      id, name, skin, human, x, y, score, max: score, angle, target: angle, boost: false, boosting: false, dropAcc: 0,
      segs: [], dead: false, kills: 0, protect: 0, respawn: 0, sp: 0, ai: null, client: null, type: type || TYPES[0], look,
      fx: { kalkan: 0, miknatis: 0, hiz: 0, cift: 0 }
    };
    s.sp = radius(s) * 0.62;
    const n = segCount(score);
    for (let i = 0; i < n; i++) s.segs.push({ x: x - Math.cos(angle) * i * s.sp, y: y - Math.sin(angle) * i * s.sp });
    return s;
  }
  function makeBot(id) {
    const p = safePoint(WORLD - 450);
    const s = makeSnake(id, NAMES[(Math.random() * NAMES.length) | 0], { c: BOT_SKINS[(Math.random() * BOT_SKINS.length) | 0] }, false,
      p.x, p.y, 10 + Math.pow(Math.random(), 2.2) * 220, Math.random() * TAU, TYPES[(Math.random() * TYPES.length) | 0],
      { hat: pick(HATS, .35), gls: pick(GLS, .3), ani: pick(ANI, .3), pat: pick(PAT, .35), frm: 'none', flag: 'none' });
    s.typeIdx = TYPES.indexOf(s.type);
    s.ai = { wander: 0, skill: 0.35 + Math.random() * 0.65, aggr: Math.random() };
    s.protect = 60;
    return s;
  }
  function respawnBot(s) { const f = makeBot(s.id); for (const k in f) if (Object.prototype.hasOwnProperty.call(f, k)) s[k] = f[k]; }

  /* ---- bot yapay zekası (istemciyle aynı) ---- */
  function aiThink(s) {
    const ai = s.ai, R = radius(s), dirx = Math.cos(s.angle), diry = Math.sin(s.angle);
    ai.wander = clamp(ai.wander + (Math.random() - 0.5) * 0.5, -1.2, 1.2);
    let ta = s.angle + ai.wander * 0.5, boost = false, i, f, dx, dy, d2;
    const reach = 240 + ai.skill * 220; let bf = null, bs = 1e12;
    const gx0 = Math.floor((s.x - reach) / 128), gx1 = Math.floor((s.x + reach) / 128), gy0 = Math.floor((s.y - reach) / 128), gy1 = Math.floor((s.y + reach) / 128);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const cell = fgrid[gx * 256 + gy]; if (!cell) continue;
      for (let q2 = 0; q2 < cell.length; q2++) {
        f = cell[q2]; if (f.e) continue;
        dx = f.x - s.x; dy = f.y - s.y; d2 = dx * dx + dy * dy;
        if (d2 < reach * reach) {
          let sc = d2 / (1 + f.v * 2);
          if (dx * dirx + dy * diry < 0) sc *= 3;
          if (sc < bs) { bs = sc; bf = f; }
        }
      }
    }
    if (bf) ta = Math.atan2(bf.y - s.y, bf.x - s.x);
    let bp = null, bpd = 360 * 360;
    for (i = 0; i < powerups.length; i++) { const pu = powerups[i]; dx = pu.x - s.x; dy = pu.y - s.y; d2 = dx * dx + dy * dy; if (d2 < bpd) { bpd = d2; bp = pu; } }
    if (bp) ta = Math.atan2(bp.y - s.y, bp.x - s.x);
    if (ai.aggr > 0.45 && s.score > 20) {
      let tgt = null, td = 520 * 520;
      for (i = 0; i < snakes.length; i++) {
        const o = snakes[i];
        if (o === s || o.dead || o.protect > 0 || o.score * 1.2 > s.score) continue;
        dx = o.x - s.x; dy = o.y - s.y; d2 = dx * dx + dy * dy;
        if (d2 < td) { td = d2; tgt = o; }
      }
      if (tgt) {
        const px = tgt.x + Math.cos(tgt.angle) * 140, py = tgt.y + Math.sin(tgt.angle) * 140;
        ta = Math.atan2(py - s.y, px - s.x);
        if (td < 380 * 380 && s.score > 40) boost = true;
      }
    }
    const pr = [R * 2.5 + 36, R * 2.5 + 110]; let danger = 0, side = 0;
    for (i = 0; i < snakes.length; i++) {
      const q = snakes[i]; if (q.dead) continue;
      const segs = q.segs, Rq = radius(q), start = (q === s) ? 10 : 0;
      if (q !== s) { const hx = q.x - s.x, hy = q.y - s.y, lim0 = segs.length * q.sp + 300; if (hx * hx + hy * hy > lim0 * lim0) continue; }
      const lim = Rq + R * 0.9 + 10, lim2 = lim * lim;
      for (let j = start; j < segs.length; j++) {
        const g = segs[j];
        for (let k = 0; k < 2; k++) {
          const qx = s.x + dirx * pr[k], qy = s.y + diry * pr[k], ex = g.x - qx, ey = g.y - qy;
          if (ex * ex + ey * ey < lim2) { if (danger < 2 - k) danger = 2 - k; side += (dirx * (g.y - s.y) - diry * (g.x - s.x)) > 0 ? 1 : -1; }
        }
      }
    }
    if (danger > 0 && Math.random() < 0.88 + 0.12 * ai.skill) { ta = s.angle + (side >= 0 ? -1 : 1) * (danger === 2 ? 1.5 : 0.9); boost = false; }
    const d0 = Math.hypot(s.x, s.y);
    if (d0 > WORLD - 900 && ((s.x * dirx + s.y * diry) / d0 > -0.2 || d0 > WORLD - 380)) { ta = Math.atan2(-s.y, -s.x); boost = false; }
    s.target = ta; s.boost = boost;
  }

  /* ---- simülasyon ---- */
  function stepSnake(s) {
    const R = radius(s), diff = wrap(s.target - s.angle);
    const maxTurn = 0.14 * (s.human ? 1 : 0.66) * s.type.turn * (1 - Math.min(0.45, s.segs.length * 0.0009));
    s.angle += clamp(diff, -maxTurn, maxTurn);
    let speed = BASE * s.type.spd; s.boosting = false;
    if (s.boost && s.score > 14) {
      speed = BOOST * s.type.spd; s.boosting = true; s.score -= 0.11 * s.type.cost; s.dropAcc++;
      if (s.dropAcc >= 9) { s.dropAcc = 0; const t = s.segs[s.segs.length - 1]; addFood(t.x, t.y, 0.5, segColor(s.skin, s.segs.length - 1), false); }
    }
    if (s.fx.hiz > 0) { s.boosting = true; speed *= 1.3; }
    s.x += Math.cos(s.angle) * speed; s.y += Math.sin(s.angle) * speed;
    const segs = s.segs; segs[0].x = s.x; segs[0].y = s.y;
    const sp = R * 0.62;
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1], b = segs[i], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
      if (d > sp) { const k = (d - sp) / d; b.x += dx * k; b.y += dy * k; }
    }
    const want = segCount(s.score);
    while (segs.length < want) { const tl = segs[segs.length - 1]; segs.push({ x: tl.x, y: tl.y }); }
    while (segs.length > want && segs.length > 6) segs.pop();
    s.sp = sp;
    if (s.score > s.max) s.max = s.score;
    if (Math.hypot(s.x, s.y) > WORLD - R * 0.3) killSnake(s, null);
  }
  function eatFoods(s) {
    const mag = s.type.mag * (s.fx.miknatis > 0 ? 3.2 : 1), R = radius(s), pull = R + 46 * mag, pull2 = pull * pull, eat = R + 8;
    const x0 = Math.floor((s.x - pull) / 128), x1 = Math.floor((s.x + pull) / 128), y0 = Math.floor((s.y - pull) / 128), y1 = Math.floor((s.y + pull) / 128);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const cell = fgrid[cx * 256 + cy]; if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const f = cell[i]; if (f.e) continue;
        const dx = s.x - f.x, dy = s.y - f.y, d2 = dx * dx + dy * dy;
        if (d2 < pull2) {
          const d = Math.sqrt(d2);
          if (d < eat) { s.score += f.v * (s.fx.cift > 0 ? 2 : 1); if (f.amb) ambCount--; f.e = 1; }
          else { f.x += dx / d * 4; f.y += dy / d * 4; }
        }
      }
    }
  }
  function pickPowerups(s) {
    const R = radius(s) + 16;
    for (let i = powerups.length - 1; i >= 0; i--) {
      const p = powerups[i], dx = s.x - p.x, dy = s.y - p.y;
      if (dx * dx + dy * dy < R * R) { s.fx[POWERS[p.ti].id] = POWERS[p.ti].dur; powerups[i] = powerups[powerups.length - 1]; powerups.pop(); }
    }
  }
  function killSnake(s, killer) {
    if (s.dead) return;
    const alive = snakes.filter(x => !x.dead).sort((a, b) => b.score - a.score);
    const rank = alive.indexOf(s) + 1;
    s.dead = true;
    const n = s.segs.length, step = Math.max(2, Math.ceil(n / 60)), count = Math.ceil(n / step), v = clamp((s.score * 0.8 + 4) / count, 0.8, 30);
    for (let i = 0; i < n; i += step) {
      const q = s.segs[i]; let qx = q.x, qy = q.y; const qr = Math.hypot(qx, qy), lim = WORLD - 110;
      if (qr > lim) { qx *= lim / qr; qy *= lim / qr; }
      addFood(qx + rnd(-8, 8), qy + rnd(-8, 8), v, segColor(s.skin, i), false, true);
    }
    if (Math.random() < 0.3 && powerups.length < POWER_COUNT + 4) { if (Math.hypot(s.x, s.y) > WORLD - 110) spawnPower(); else spawnPower(s.x, s.y); }
    if (killer) { killer.kills++; if (killer.client) killer.client.send({ t: 'kill', name: s.name }); }
    if (s.client) {
      const c = s.client; c.snake = null; s.client = null;
      c.send({ t: 'dead', by: killer ? killer.name : null, score: Math.floor(s.max), kills: s.kills, rank });
    } else s.respawn = 200;
  }
  function collisions() {
    const hits = [];
    for (let i = 0; i < snakes.length; i++) {
      const a = snakes[i];
      if (a.dead || a.protect > 0 || a.fx.kalkan > 0) continue;
      const Ra = radius(a);
      for (let j = 0; j < snakes.length; j++) {
        const b = snakes[j]; if (b === a || b.dead) continue;
        const Rb = radius(b), dxh = b.x - a.x, dyh = b.y - a.y, dh2 = dxh * dxh + dyh * dyh, reachB = b.segs.length * b.sp + Ra + Rb + 20;
        if (dh2 > reachB * reachB) continue;
        const hh = Ra * 0.8 + Rb * 0.8;
        if (dh2 < hh * hh) { if (b.protect > 0 || b.fx.kalkan > 0) continue; if (a.score <= b.score) hits.push([a, b]); continue; }
        const lim = Rb * 0.9 + Ra * 0.55, lim2 = lim * lim, segs = b.segs;
        for (let k = 1; k < segs.length; k++) { const dx = segs[k].x - a.x, dy = segs[k].y - a.y; if (dx * dx + dy * dy < lim2) { hits.push([a, b]); break; } }
      }
    }
    for (const h of hits) killSnake(h[0], h[1]);
  }

  /* ---- oda yönetimi ---- */
  const humans = () => { let n = 0; for (const c of clients) if (c.snake) n++; return n; };
  function balanceBots() {
    const want = opts.priv ? (opts.bots | 0) : Math.max(0, BOT_FILL - humans());
    let bots = snakes.filter(s => !s.human);
    while (bots.length < want) { const b = makeBot(nid++); snakes.push(b); bots.push(b); }
    if (bots.length > want) {
      bots.sort((a, b) => a.score - b.score);
      const drop = new Set(bots.slice(0, bots.length - want));
      snakes = snakes.filter(s => !drop.has(s));
    }
  }
  function spawnHuman(c) {
    const p = safePoint(1800), ang = Math.atan2(-p.y, -p.x), pr = c.profile;
    const s = makeSnake(c.id, pr.name, pr.skin, true, p.x, p.y, 10, ang, TYPES[pr.ty], pr.look);
    s.typeIdx = pr.ty; s.client = c; s.protect = 240;
    c.snake = s; c.started = true; c.lastIn = Date.now(); c.knownS.clear(); c.knownF.clear();
    snakes.push(s);
    balanceBots();
    c.send({ t: 'go', x: r1(s.x), y: r1(s.y), a: r3(ang), score: 10, prot: s.protect });
  }
  function addClient(c) { clients.add(c); c.id = nid++; }
  function removeClient(c) {
    clients.delete(c);
    if (c.snake) { c.snake.dead = true; c.snake.client = null; snakes = snakes.filter(s => s !== c.snake); c.snake = null; }
    if (!clients.size) emptySince = Date.now();
    balanceBots();
  }

  /* ---- snapshot ---- */
  const BX = 1750, BY = 1150;
  function inView(o, cx, cy) {
    if (Math.abs(o.x - cx) < BX + 200 && Math.abs(o.y - cy) < BY + 200) return true;
    const segs = o.segs;
    for (let i = 4; i < segs.length; i += 4) if (Math.abs(segs[i].x - cx) < BX + 80 && Math.abs(segs[i].y - cy) < BY + 80) return true;
    return false;
  }
  function refreshSorted() {
    sorted = snakes.filter(s => !s.dead).sort((a, b) => b.score - a.score);
    lbCache = sorted.slice(0, 10).map(s => [s.id, s.name, Math.floor(s.score)]);
  }
  function snapshot(c) {
    const me = c.snake, out = { t: 's', k: tick };
    if (me) { c.lx = me.x; c.ly = me.y; }
    const cx = c.lx || 0, cy = c.ly || 0;
    if (me) {
      out.me = [r1(me.x), r1(me.y), r3(me.angle), r1(me.score), me.protect, me.fx.kalkan, me.fx.miknatis, me.fx.hiz, me.fx.cift, me.kills, me.boosting ? 1 : 0];
      out.rk = sorted.indexOf(me) + 1;
    }
    out.tt = sorted.length;
    const s = [], n = [], vis = new Set();
    for (const o of snakes) {
      if (o.dead || o === me || !inView(o, cx, cy)) continue;
      vis.add(o.id);
      if (!c.knownS.has(o.id)) {
        c.knownS.add(o.id);
        const sg = []; for (const q of o.segs) sg.push(Math.round(q.x), Math.round(q.y));
        n.push({ id: o.id, name: o.name, c: o.skin.c, ty: o.typeIdx, look: o.look, sg, x: r1(o.x), y: r1(o.y), a: r3(o.angle), sc: r1(o.score) });
      }
      s.push([o.id, r1(o.x), r1(o.y), r3(o.angle), r1(o.score), (o.boosting ? 1 : 0) | (o.fx.kalkan > 0 ? 2 : 0), o.protect]);
    }
    const r = []; for (const id of c.knownS) if (!vis.has(id)) { r.push(id); c.knownS.delete(id); }
    if (s.length) out.s = s; if (n.length) out.n = n; if (r.length) out.r = r;
    // yemler (ızgara ile görüş alanına göre)
    const x0 = Math.floor((cx - BX) / 128), x1 = Math.floor((cx + BX) / 128), y0 = Math.floor((cy - BY) / 128), y1 = Math.floor((cy + BY) / 128);
    const fv = new Set(), fa = [];
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const cell = fgrid[gx * 256 + gy]; if (!cell) continue;
      for (let i = 0; i < cell.length; i++) {
        const f = cell[i]; if (f.e) continue;
        fv.add(f.id);
        if (!c.knownF.has(f.id)) { c.knownF.add(f.id); fa.push([f.id, Math.round(f.x), Math.round(f.y), r1(f.v), f.c, f.k ? 1 : 0]); }
      }
    }
    const fr = []; for (const id of c.knownF) if (!fv.has(id)) { fr.push(id); c.knownF.delete(id); }
    if (fa.length) out.fa = fa; if (fr.length) out.fr = fr;
    const p = [];
    for (const u of powerups) if (Math.abs(u.x - cx) < BX + 100 && Math.abs(u.y - cy) < BY + 100) p.push([u.id, Math.round(u.x), Math.round(u.y), u.ti]);
    out.p = p;
    out.ld = sorted.length ? sorted[0].id : 0;
    if (tick % 15 === 0) out.lb = lbCache;
    c.send(out);
  }

  function step() {
    tick++; buildGrid();
    const now = Date.now();
    for (let i = 0; i < snakes.length; i++) {
      const s = snakes[i];
      if (s.dead) { if (!s.human) { s.respawn--; if (s.respawn <= 0) respawnBot(s); } continue; }
      if (!s.human && (tick + s.id) % 4 === 0) aiThink(s);
      stepSnake(s); if (s.dead) continue;
      eatFoods(s); pickPowerups(s);
      if (s.protect > 0) s.protect--;
      for (const k in s.fx) if (s.fx[k] > 0) s.fx[k]--;
    }
    let w = 0; for (let i = 0; i < foods.length; i++) if (!foods[i].e) foods[w++] = foods[i]; foods.length = w;
    collisions();
    snakes = snakes.filter(s => !(s.dead && s.human));
    let n = 0; while (ambCount < AMBIENT && n < 6) { spawnAmbient(); n++; }
    while (powerups.length < POWER_COUNT) spawnPower();
    if (tick % 15 === 0) refreshSorted();
    if (tick % 3 === 0) {
      buildGrid();
      for (const c of clients) {
        if (!c.joined || !c.started) continue;
        if (c.snake && now - c.lastIn > 20000) { c.send({ t: 'kick', why: 'afk' }); c.close(); continue; }
        snapshot(c);
      }
    }
    if (tick % 300 === 0) balanceBots();
  }

  for (let i = 0; i < AMBIENT; i++) spawnAmbient();
  for (let i = 0; i < POWER_COUNT; i++) spawnPower();
  balanceBots(); refreshSorted();
  for (let i = 0; i < 60; i++) step0();
  function step0() { tick++; buildGrid(); for (const s of snakes) if (!s.dead) { if (tick % 4 === 0) aiThink(s); stepSnake(s); if (!s.dead) eatFoods(s); } let w = 0; for (let i = 0; i < foods.length; i++) if (!foods[i].e) foods[w++] = foods[i]; foods.length = w; }

  return { key, clients, step, addClient, removeClient, spawnHuman, humans, checkPw, priv: !!opts.priv, max: opts.max || MAX_ROOM, get emptySince() { return emptySince; }, get count() { return clients.size; } };
}

/* ---------------- WebSocket (RFC 6455, bağımlılıksız) ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(), ipCount = new Map(), fails = new Map();
function isBlocked(ip) { const f = fails.get(ip); return !!f && Date.now() - f.t < 60000 && f.n >= 6; }
function noteFail(ip) { const now = Date.now(); let f = fails.get(ip); if (!f || now - f.t >= 60000) f = { n: 0, t: now }; f.n++; fails.set(ip, f); }
function privCount() { let n = 0; rooms.forEach(r => { if (r.priv) n++; }); return n; }

function frame(opcode, payload) {
  const len = payload.length; let h;
  if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
  else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
  h[0] = 0x80 | opcode;
  return Buffer.concat([h, payload]);
}

function cleanText(v, max) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max); }
function cleanProfile(m) {
  const colors = Array.isArray(m.skin) ? m.skin.filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)).slice(0, 6) : [];
  if (!colors.length) colors.push('#ffd23f', '#ff8c42');
  const lk = m.look || {}, one = (list, v, d) => list.indexOf(v) >= 0 ? v : d;
  const ty = Number.isInteger(m.ty) && m.ty >= 0 && m.ty < TYPES.length ? m.ty : 0;
  return {
    name: cleanText(m.name, 14) || 'Oyuncu', skin: { c: colors }, ty,
    look: { hat: one(HATS, lk.hat, 'none'), gls: one(GLS, lk.gls, 'none'), ani: one(ANI, lk.ani, 'snake'), pat: one(PAT, lk.pat, 'solid'), frm: one(FRM, lk.frm, 'none'), flag: one(FLG, lk.flag, 'none') }
  };
}

class Conn {
  constructor(socket, ip, roomKey) {
    this.socket = socket; this.ip = ip; this.roomKey = roomKey; this.buf = Buffer.alloc(0);
    this.room = null; this.snake = null; this.joined = false; this.profile = null;
    this.knownS = new Set(); this.knownF = new Set(); this.lx = 0; this.ly = 0; this.lastIn = Date.now();
    this.msgs = 0; this.msgT = Date.now(); this.closed = false; this.id = 0;
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.cleanup());
    socket.on('error', () => this.cleanup());
    this.joinTimer = setTimeout(() => { if (!this.joined) this.close(); }, 10000);
  }
  send(obj) {
    if (this.closed || this.socket.destroyed) return;
    if (this.socket.writableLength > 1 << 20) return; // yavaş istemciyi tıkama
    try { this.socket.write(frame(1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)))); } catch (e) { }
  }
  close() { if (this.closed) return; try { this.socket.write(frame(8, Buffer.from([0x03, 0xe8]))); this.socket.end(); } catch (e) { } this.cleanup(); }
  cleanup() {
    if (this.closed) return; this.closed = true; clearTimeout(this.joinTimer);
    if (this.room) this.room.removeClient(this);
    const n = (ipCount.get(this.ip) || 1) - 1; if (n <= 0) ipCount.delete(this.ip); else ipCount.set(this.ip, n);
    try { this.socket.destroy(); } catch (e) { }
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 16384) return this.close();
    for (; ;) {
      const b = this.buf; if (b.length < 2) return;
      const op = b[0] & 0x0f, fin = (b[0] & 0x80) !== 0, masked = (b[1] & 0x80) !== 0; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) return this.close(); // büyük çerçeve istemiyoruz
      if (!masked || len > 4096 || !fin || op === 0) return this.close();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close();
      if (op === 9) { this.socket.write(frame(10, data)); continue; }
      if (op === 1) { this.onText(data.toString('utf8')); if (this.closed) return; }
    }
  }
  onText(txt) {
    const now = Date.now();
    if (now - this.msgT > 1000) { this.msgT = now; this.msgs = 0; }
    if (++this.msgs > 120) return this.close();
    let m; try { m = JSON.parse(txt); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'join': {
        if (this.joined) return;
        const priv = /^L-[A-Z0-9]{4,8}$/.test(this.roomKey);
        let room = rooms.get(this.roomKey);
        if (priv) {
          // ÖZEL LOBİ: kod URL'de, şifre mesaj gövdesinde (log'a düşmesin)
          if (isBlocked(this.ip)) { this.send({ t: 'err', why: 'ratelimit' }); return this.close(); }
          const pw = typeof m.pw === 'string' ? m.pw.slice(0, 32) : '';
          if (m.create) {
            if (room && room.count > 0) { this.send({ t: 'err', why: 'exists' }); return this.close(); }
            if (privCount() >= MAX_PRIVATE) { this.send({ t: 'err', why: 'full' }); return this.close(); }
            room = createRoom(this.roomKey, { priv: true, pw, bots: Math.max(0, Math.min(12, m.bots | 0)), max: MAX_PRIVATE_PLAYERS });
            rooms.set(this.roomKey, room);
          } else if (!room || !room.priv || !room.checkPw(pw)) {
            noteFail(this.ip); // "yok" ile "şifre yanlış" ayırt edilmez (kod tarama zorlaşsın)
            this.send({ t: 'err', why: 'denied' }); return this.close();
          }
        } else if (!room) {
          if (rooms.size >= MAX_ROOMS) { this.send({ t: 'full' }); return this.close(); }
          room = createRoom(this.roomKey); rooms.set(this.roomKey, room);
        }
        if (room.humans() >= room.max) { this.send(priv ? { t: 'err', why: 'full' } : { t: 'full' }); return this.close(); }
        this.profile = cleanProfile(m); this.room = room; this.joined = true; room.addClient(this);
        this.send({ t: 'init', id: this.id, world: WORLD, room: this.roomKey, priv });
        break;
      }
      case 'start': if (this.room && !this.snake) this.room.spawnHuman(this); break;
      case 'in': {
        const s = this.snake; if (!s) return;
        const a = +m.a; if (Number.isFinite(a)) s.target = wrap(a);
        s.boost = !!m.b; this.lastIn = now;
        break;
      }
      case 'ping': this.send({ t: 'pong', n: typeof m.n === 'number' ? m.n : 0 }); break;
      case 'leave': this.close(); break;
    }
  }
}

/* ---------------- HTTP ---------------- */
const GAME = process.env.GAME_FILE || ['index.html', 'Slythera_Jackpot-v4.html'].map(f => path.join(__dirname, f)).find(f => fs.existsSync(f));
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') {
    let players = 0; rooms.forEach(r => players += r.humans());
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
  }
  if (url === '/' || url === '/index.html') {
    if (!GAME) { res.writeHead(404); return res.end('Oyun dosyasi bulunamadi: index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(GAME).pipe(res);
  }
  res.writeHead(404); res.end('404');
});
server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  const key = req.headers['sec-websocket-key'];
  if (u.pathname !== '/ws' || !key) return socket.destroy();
  if (ORIGINS.length && ORIGINS.indexOf(req.headers.origin) < 0) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || socket.remoteAddress || '?';
  if ((ipCount.get(ip) || 0) >= MAX_PER_IP) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return socket.destroy(); }
  ipCount.set(ip, (ipCount.get(ip) || 0) + 1);
  let rk = String(u.searchParams.get('room') || 'TR1-1').toUpperCase();
  if (!/^L-[A-Z0-9]{4,8}$/.test(rk) && !/^[A-Z0-9]{2,6}-\d{1,2}$/.test(rk)) rk = 'TR1-1';
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  new Conn(socket, ip, rk);
});

/* ---------------- ana döngü ---------------- */
const TICK = 1000 / 60; let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now(); acc += Math.min(100, now - last); last = now;
  let n = 0; while (acc >= TICK && n < 4) { for (const r of rooms.values()) r.step(); acc -= TICK; n++; }
  if (acc > TICK * 4) acc = 0;
}, 5);
setInterval(() => { // boş odaları temizle
  const now = Date.now();
  for (const [k, r] of rooms) if (!r.count && now - r.emptySince > (r.priv ? 120000 : 30000)) rooms.delete(k);
  for (const [ip, f] of fails) if (now - f.t > 60000) fails.delete(ip);
}, 10000);

if (require.main === module) {
  server.listen(PORT, () => console.log('Slythera sunucusu hazır → http://localhost:' + PORT + (GAME ? '  (oyun: ' + path.basename(GAME) + ')' : '  (UYARI: oyun html dosyası bulunamadı)')));
}
module.exports = { server, rooms };
