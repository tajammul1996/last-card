// Last Card: multiplayer card game server.
// The server holds every table in memory and is the only one that changes game state,
// so each phone only ever receives its own hand.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const E = require('./public/engine.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 10;
const MAX_TABLES = 500;
const IDLE_SKIP_MS = 45_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 10; // actions per second per phone
const TABLE_TTL_MS = 4 * 3600_000;
const REACTIONS = ['😂', '😱', '😤', '👏'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

const io = new Server(server, { pingInterval: 20_000, pingTimeout: 25_000, maxHttpBufferSize: 10_000 });

// ---------- state ----------
/** code -> { code, created, lastActive, players: Map<id, player>, s } */
const tables = new Map();
/** token -> { code, id } */
const tokens = new Map();

const rid = (n) => crypto.randomBytes(n).toString('hex');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 18) || 'Player';
const validToken = (t) => typeof t === 'string' && /^[a-zA-Z0-9]{16,64}$/.test(t);

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    if (!tables.has(c)) return c;
  }
  return null;
}

function newTable(hostId) {
  const code = newCode();
  const t = {
    code, created: Date.now(), lastActive: Date.now(), players: new Map(),
    s: { code, host: hostId, status: 'lobby', settings: { stack: true, drawUntil: false }, v: 0, wins: {}, round: 0, order: [], hands: {}, deck: [], discard: [], log: [] },
  };
  tables.set(code, t);
  return t;
}

function viewFor(t, pid) {
  const s = t.s;
  const counts = {};
  for (const [u, h] of Object.entries(s.hands || {})) counts[u] = h.length;
  const players = [...t.players.values()].sort((a, b) => a.joined - b.joined)
    .map((p) => ({ id: p.id, name: p.name, online: p.sockets.size > 0 }));
  // keep names for players who left mid-round so the log still reads well
  const gone = {};
  for (const [id, name] of Object.entries(t.names || {})) if (!t.players.has(id)) gone[id] = name;
  return {
    code: t.code, me: pid, host: s.host, status: s.status, settings: s.settings, round: s.round, v: s.v,
    players, gone, order: s.order, turn: s.turn, dir: s.dir, pending: s.pending || 0, drew: !!s.drew,
    color: s.color, top: s.discard[s.discard.length - 1] || null, deckCount: s.deck.length,
    counts, hand: (s.hands && s.hands[pid]) || [], unsafe: s.unsafe || null, turnAt: s.turnAt || 0,
    winner: s.winner || null, wins: s.wins || {}, log: (s.log || []).slice(-6), now: Date.now(),
  };
}

function broadcast(t) {
  for (const p of t.players.values()) {
    for (const sid of p.sockets) io.to(sid).emit('state', viewFor(t, p.id));
  }
}

function seatedOrder(t) {
  return [...t.players.values()].sort((a, b) => a.joined - b.joined).map((p) => p.id).slice(0, MAX_PLAYERS);
}

// run a rules-engine change; only broadcast when it was allowed
function act(t, fn) {
  const s = t.s;
  const before = s.v || 0;
  s.v = before + 1;
  let ok = false;
  try { ok = fn(s) !== false; } catch (e) { console.error('action failed', e); ok = false; }
  if (!ok) { s.v = before; return false; }
  t.lastActive = Date.now();
  broadcast(t);
  return true;
}

function removePlayer(t, id) {
  const p = t.players.get(id);
  if (!p) return;
  t.names = t.names || {};
  t.names[id] = p.name;
  if (t.s.status !== 'lobby' && t.s.order.includes(id)) {
    t.s.v++;
    E.applyRemove(t.s, id);
  }
  t.players.delete(id);
  tokens.delete(p.token);
  for (const sid of p.sockets) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) { sock.leave(t.code); sock.data.code = null; sock.emit('left'); }
  }
  if (t.players.size === 0) { tables.delete(t.code); return; }
  if (t.s.host === id) t.s.host = seatedOrder(t)[0];
  t.lastActive = Date.now();
  broadcast(t);
}

function attach(socket, t, p) {
  socket.data.code = t.code;
  socket.data.pid = p.id;
  socket.join(t.code);
  p.sockets.add(socket.id);
  broadcast(t);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.data = { token: null, code: null, pid: null, last: 0, burst: 0 };

  // light flood control: ~10 actions per second per socket
  const limited = () => {
    const now = Date.now();
    if (now - socket.data.last > 1000) { socket.data.last = now; socket.data.burst = 0; }
    return ++socket.data.burst > RATE_LIMIT;
  };
  const ctx = () => {
    const t = tables.get(socket.data.code);
    const p = t && t.players.get(socket.data.pid);
    return t && p ? { t, p, s: t.s, me: p.id } : null;
  };
  const on = (ev, handler) => socket.on(ev, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
    try { handler(args[0] || {}, ack); } catch (e) { console.error(ev, e); ack({ ok: false, error: 'Something went wrong.' }); }
  });

  on('hello', ({ token }, ack) => {
    if (!validToken(token)) return ack({ ok: false, error: 'Bad token' });
    socket.data.token = token;
    const link = tokens.get(token);
    const t = link && tables.get(link.code);
    const p = t && t.players.get(link.id);
    if (p) { attach(socket, t, p); return ack({ ok: true, code: t.code }); }
    ack({ ok: true, code: null });
  });

  on('create', ({ name }, ack) => {
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    if (tables.size >= MAX_TABLES) return ack({ ok: false, error: 'The server is full right now. Try again later.' });
    const old = ctx(); if (old) removePlayer(old.t, old.me);
    const id = rid(6);
    const t = newTable(id);
    const p = { id, token: socket.data.token, name: cleanName(name), joined: Date.now(), sockets: new Set() };
    t.players.set(id, p); tokens.set(p.token, { code: t.code, id });
    attach(socket, t, p);
    ack({ ok: true, code: t.code });
  });

  on('join', ({ code, name }, ack) => {
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    code = String(code || '').toUpperCase();
    const t = tables.get(code);
    if (!t) return ack({ ok: false, error: `No table with code ${code}. Check the code with whoever started it.` });
    const link = tokens.get(socket.data.token);
    if (link && link.code === code && t.players.has(link.id)) {
      const p = t.players.get(link.id);
      if (name) p.name = cleanName(name);
      attach(socket, t, p); return ack({ ok: true, code });
    }
    if (t.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'That table is full (10 players).' });
    const old = ctx(); if (old) removePlayer(old.t, old.me);
    const id = rid(6);
    const p = { id, token: socket.data.token, name: cleanName(name), joined: Date.now(), sockets: new Set() };
    t.players.set(id, p); tokens.set(p.token, { code, id });
    attach(socket, t, p);
    ack({ ok: true, code });
  });

  on('leave', (_, ack) => { const c = ctx(); if (c) removePlayer(c.t, c.me); ack({ ok: true }); });

  on('rename', ({ name }, ack) => { const c = ctx(); if (!c) return ack({ ok: false }); c.p.name = cleanName(name); broadcast(c.t); ack({ ok: true }); });

  on('setting', ({ key }, ack) => {
    const c = ctx(); if (!c || !['stack', 'drawUntil'].includes(key)) return ack({ ok: false });
    ack({ ok: act(c.t, (s) => { if (s.status !== 'lobby') return false; s.settings[key] = !s.settings[key]; }) });
  });

  on('start', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const seated = seatedOrder(c.t);
    if (seated.length < 2) return ack({ ok: false, error: 'You need at least 2 players.' });
    ack({ ok: act(c.t, (s) => { if (s.status === 'playing') return false; E.dealRound(s, seated); }) });
  });

  on('play', ({ i, color, called }, ack) => {
    const c = ctx(); if (!c || !Number.isInteger(i)) return ack({ ok: false });
    const ok = act(c.t, (s) => E.applyPlay(s, c.me, i, color, !!called));
    ack({ ok, error: ok ? null : 'That card can’t be played right now.' });
  });
  on('draw', (_, ack) => { const c = ctx(); ack({ ok: !!c && act(c.t, (s) => E.applyDraw(s, c.me)) }); });
  on('pass', (_, ack) => { const c = ctx(); ack({ ok: !!c && act(c.t, (s) => E.applyPass(s, c.me)) }); });
  on('lateCall', (_, ack) => { const c = ctx(); ack({ ok: !!c && act(c.t, (s) => E.applyLateCall(s, c.me, s.unsafeV)) }); });
  on('catch', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    ack({ ok: act(c.t, (s) => s.order.includes(c.me) && s.unsafe && s.unsafe !== c.me && E.applyCatch(s, c.me, s.unsafe, s.unsafeV)) });
  });
  on('skip', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    ack({ ok: act(c.t, (s) => {
      const cur = s.order[s.turn];
      if (s.status !== 'playing' || cur === c.me || !s.order.includes(c.me) || Date.now() - (s.turnAt || 0) < IDLE_SKIP_MS) return false;
      return E.applySkipIdle(s, cur);
    }) });
  });
  on('remove', ({ id }, ack) => {
    const c = ctx(); if (!c || typeof id !== 'string' || id === c.me || !c.t.players.has(id)) return ack({ ok: false });
    removePlayer(c.t, id); ack({ ok: true });
  });
  on('react', ({ e }, ack) => {
    const c = ctx(); if (!c || !REACTIONS.includes(e)) return ack({ ok: false });
    io.to(c.t.code).emit('react', { e, by: c.me }); ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const c = ctx();
    if (c) { c.p.sockets.delete(socket.id); broadcast(c.t); }
  });
});

// drop tables nobody has touched for a few hours
setInterval(() => {
  const now = Date.now();
  for (const t of tables.values()) {
    const anyoneHere = [...t.players.values()].some((p) => p.sockets.size > 0);
    if (!anyoneHere && now - t.lastActive > TABLE_TTL_MS) {
      for (const p of t.players.values()) tokens.delete(p.token);
      tables.delete(t.code);
    }
  }
}, 10 * 60_000).unref();

server.listen(PORT, () => console.log(`Last Card listening on :${PORT}`));
module.exports = { server, io, tables };
