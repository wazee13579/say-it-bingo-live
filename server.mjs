import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
// Edit sayings.txt (one saying per line) to change future Bingo cards.
// Existing player cards remain unchanged until the player randomises or rejoins.
function loadSayings(file) {
  const words = [...new Set(readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))];
  if (words.length < 2) {
    throw new Error('sayings.txt must contain at least two different sayings.');
  }
  return words;
}
const LINES = [
  ...Array.from({ length: 5 }, (_, r) => Array.from({ length: 5 }, (_, c) => r * 5 + c)),
  ...Array.from({ length: 5 }, (_, c) => Array.from({ length: 5 }, (_, r) => r * 5 + c)),
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20],
];
const asId = () => randomBytes(9).toString('base64url');
const asKey = () => randomBytes(32).toString('base64url');
const digest = (key) => createHash('sha256').update(key).digest('hex');
function keyMatches(key, storedHash) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{40,50}$/.test(key) || typeof storedHash !== 'string') return false;
  const a = Buffer.from(digest(key), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
function shuffle(sayings) {
  // With 25+ sayings, choose 25 different sayings without replacement.
  // With fewer than 25, repeat them evenly to fill the card.
  const a = sayings.length >= 25
    ? [...sayings]
    : Array.from({ length: 25 }, (_, i) => sayings[i % sayings.length]);
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, 25);
}
function differentShuffle(previous, sayings) {
  const a = shuffle(sayings);
  if (previous && a.every((v, i) => v === previous[i])) {
    const j = a.findIndex((v) => v !== a[0]);
    if (j > 0) [a[0], a[j]] = [a[j], a[0]];
  }
  return a;
}
function stats(marks) {
  let streak = 0, lineProgress = 0, bingos = 0;
  const wins = new Set();
  for (const line of LINES) {
    let run = 0, count = 0;
    for (const cell of line) {
      if (marks[cell]) { run += 1; count += 1; streak = Math.max(streak, run); }
      else run = 0;
    }
    lineProgress = Math.max(lineProgress, count);
    if (count === 5) { bingos += 1; for (const cell of line) wins.add(cell); }
  }
  return { streak, lineProgress, marked: marks.filter(Boolean).length, bingos, winningCells: [...wins] };
}
function leaderboard(room) {
  return Object.values(room.players).map((p) => ({ id: p.id, name: p.name, ...stats(p.marks) }))
    .sort((a, b) => b.bingos - a.bingos || b.streak - a.streak || b.lineProgress - a.lineProgress || b.marked - a.marked || a.name.localeCompare(b.name))
    .map(({ winningCells, ...p }, i) => ({ ...p, rank: i + 1 }));
}
function privatePlayer(p) {
  return { id: p.id, name: p.name, board: p.board, marks: p.marks, stats: stats(p.marks) };
}
function validCode(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value); }
function safeName(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 28
    && !/[\x00-\x1f\x7f]/.test(value);
}
function responseJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function error(res, status, message) { responseJson(res, status, { error: message }); }
async function bodyJson(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('Send JSON'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Object.assign(new Error('Expected an object'), { status: 400 });
  return data;
}

export function createApp(options = {}) {
  const sayings = loadSayings(options.sayingsFile || join(here, 'sayings.txt'));
  const stateFile = options.stateFile || process.env.STATE_FILE || join(here, 'data', 'state.json');
  let store = { rooms: {} };
  if (existsSync(stateFile)) {
    const loaded = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (loaded && loaded.rooms && typeof loaded.rooms === 'object') store = loaded;
  }
  const connections = new Map();
  const rate = new Map();
  function save() {
    mkdirSync(dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
    renameSync(tmp, stateFile);
  }
  function throttle(req, label, max, interval) {
    const ip = req.socket.remoteAddress || 'unknown';
    const k = label + ':' + ip;
    const now = Date.now();
    const entry = rate.get(k);
    if (!entry || entry.until < now) { rate.set(k, { count: 1, until: now + interval }); return; }
    if (++entry.count > max) throw Object.assign(new Error('Too many requests. Try again shortly.'), { status: 429 });
  }
  function makeRoom() {
    let code;
    do { code = asId(); } while (store.rooms[code]);
    const ownerKey = asKey();
    store.rooms[code] = { code, ownerHash: digest(ownerKey), status: 'active', players: {}, createdAt: Date.now() };
    return { code, ownerKey };
  }
  function broadcast(code, event) {
    const clients = connections.get(code);
    if (!clients) return;
    const frame = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const res of [...clients]) {
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }
  function snapshot(room) { return { type: 'snapshot', status: room.status, leaderboard: leaderboard(room) }; }
  function authPlayer(room, body) {
    if (typeof body.playerId !== 'string' || typeof body.playerKey !== 'string') return null;
    const player = room.players[body.playerId];
    return player && keyMatches(body.playerKey, player.keyHash) ? player : null;
  }
  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const method = req.method || 'GET';
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (path === '/health' && method === 'GET') return responseJson(res, 200, { ok: true });
    if (method === 'GET' && (path === '/' || path === '/app.js' || path === '/style.css')) {
      const file = path === '/' ? 'index.html' : path.slice(1);
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return createReadStream(join(here, 'public', file)).pipe(res);
    }
    if (method === 'POST') {
      const origin = req.headers.origin;
      if (origin) {
        let o;
        try { o = new URL(origin); } catch { return error(res, 403, 'Invalid request origin'); }
        if (o.host !== req.headers.host || !['http:', 'https:'].includes(o.protocol)) return error(res, 403, 'Cross-site request denied');
      }
    }
    if (path === '/api/rooms' && method === 'POST') {
      throttle(req, 'create', 15, 3600000);
      await bodyJson(req);
      const room = makeRoom(); save();
      return responseJson(res, 201, room);
    }
    const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(join|resume|toggle|shuffle|clear|rotate|events))?$/);
    if (!match || !validCode(match[1])) return error(res, 404, 'Not found');
    const [, code, action] = match;
    const room = store.rooms[code];
    if (!room) return error(res, 404, 'Room not found. Ask the host for an invitation link.');
    if (method === 'GET' && !action) {
      return responseJson(res, 200, { code, status: room.status, leaderboard: room.status === 'active' ? leaderboard(room) : [] });
    }
    if (room.status !== 'active') return error(res, 410, 'This round was closed by the host. Ask for a new link.');
    if (method === 'GET' && action === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      res.write('data: ' + JSON.stringify(snapshot(room)) + '\n\n');
      if (!connections.has(code)) connections.set(code, new Set());
      connections.get(code).add(res);
      req.on('close', () => connections.get(code)?.delete(res));
      return;
    }
    if (method !== 'POST' || !action || action === 'events') return error(res, 405, 'Method not allowed');
    const body = await bodyJson(req);
    if (action === 'join') {
      throttle(req, 'join', 60, 60000);
      if (!safeName(body.name)) return error(res, 400, 'Enter a name between 1 and 28 characters.');
      if (Object.keys(room.players).length >= 150) return error(res, 403, 'Room is full');
      const id = asId(), playerKey = asKey();
      const p = { id, keyHash: digest(playerKey), name: body.name.trim(), board: shuffle(sayings), marks: Array(25).fill(false), joinedAt: Date.now() };
      room.players[id] = p; save(); broadcast(code, snapshot(room));
      return responseJson(res, 201, { playerKey, player: privatePlayer(p), leaderboard: leaderboard(room) });
    }
    if (action === 'rotate') {
      throttle(req, 'rotate', 12, 60000);
      if (!keyMatches(body.ownerKey, room.ownerHash)) return error(res, 403, 'Host permission required');
      const next = makeRoom();
      room.status = 'closed';
      room.players = {};
      save();
      broadcast(code, { type: 'roomClosed', message: 'The host has ended this round. Ask for the new link.' });
      for (const client of connections.get(code) || []) client.end();
      connections.delete(code);
      return responseJson(res, 201, next);
    }
    const p = authPlayer(room, body);
    if (!p) return error(res, 401, 'Player session not found. Rejoin this room.');
    if (action === 'resume') return responseJson(res, 200, { player: privatePlayer(p), leaderboard: leaderboard(room) });
    if (action === 'toggle') {
      if (!Number.isInteger(body.cell) || body.cell < 0 || body.cell >= 25) return error(res, 400, 'Invalid tile');
      p.marks[body.cell] = !p.marks[body.cell];
    } else if (action === 'shuffle') {
      p.board = differentShuffle(p.board, sayings); p.marks = Array(25).fill(false);
    } else if (action === 'clear') {
      p.marks = Array(25).fill(false);
    } else return error(res, 404, 'Unknown action');
    save(); broadcast(code, snapshot(room));
    return responseJson(res, 200, { player: privatePlayer(p), leaderboard: leaderboard(room) });
  }
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((e) => {
      console.error('Request error:', e?.message || e);
      if (!res.headersSent) error(res, e?.status && e.status >= 400 && e.status <= 500 ? e.status : 500, e?.status ? e.message : 'Server error');
      else res.end();
    });
  });
  const ping = setInterval(() => {
    const frame = ': heartbeat\n\n';
    for (const list of connections.values()) for (const res of list) {
      try { res.write(frame); } catch { list.delete(res); }
    }
    for (const [k, v] of rate.entries()) if (v.until < Date.now()) rate.delete(k);
  }, 20000);
  ping.unref();
  server.on('close', () => clearInterval(ping));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Say It! Bingo ready on port ${port}`));
}
