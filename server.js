// Last Card: multiplayer card game server.
// The server is the only one that changes game state, so each phone only ever receives its own hand.
// Tables live in memory and, when REDIS_URL is set, are also saved to Render Key Value
// so a redeploy or restart picks every game back up where it was.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const E = require('./public/engine.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const BUILD = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev-' + Date.now().toString(36);
const MAX_PLAYERS = 10;
const MAX_TABLES = 500;
const IDLE_SKIP_MS = 45_000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 10; // actions per second per phone
const TABLE_TTL_MS = 6 * 3600_000;
const CHAT_KEEP = 60;
const CHAT_MAX_LEN = 200;
const REACTIONS = ['😂', '😱', '😤', '👏'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const KEY = (code) => 'lc:t:' + code;

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
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
/** code -> { code, created, lastActive, rev, names, chat, players: Map<id, player>, s } */
const tables = new Map();
/** token -> { code, id } */
const tokens = new Map();

const rid = (n) => crypto.randomBytes(n).toString('hex');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 18) || 'Player';
const cleanText = (n) => String(n || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
const validToken = (t) => typeof t === 'string' && /^[a-zA-Z0-9]{16,64}$/.test(t);
const validCode = (c) => typeof c === 'string' && /^[A-Z]{4}$/.test(c);
const isOnline = (p) => !!p && p.sockets.size > 0;

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
    code, created: Date.now(), lastActive: Date.now(), rev: 0, names: {}, chat: [], players: new Map(),
    s: { code, host: hostId, status: 'lobby', settings: { stack: true, drawUntil: false }, v: 0, wins: {}, round: 0, order: [], hands: {}, deck: [], discard: [], log: [] },
  };
  tables.set(code, t);
  return t;
}

// ---------- persistence (Render Key Value / Redis) ----------
let kv = null;
const dirty = new Set();
let flushTimer = null;

function serialize(t) {
  return {
    code: t.code, created: t.created, lastActive: t.lastActive, rev: t.rev, names: t.names, chat: t.chat, s: t.s,
    players: [...t.players.values()].map((p) => ({ id: p.id, token: p.token, name: p.name, joined: p.joined })),
  };
}
function deserialize(d) {
  const t = { code: d.code, created: d.created, lastActive: d.lastActive || Date.now(), rev: d.rev || 0, names: d.names || {}, chat: d.chat || [], s: d.s, players: new Map() };
  for (const p of d.players || []) t.players.set(p.id, { ...p, sockets: new Set() });
  return t;
}
// put a table loaded from storage in place, keeping any phones already connected to the old copy
function install(nt) {
  const old = tables.get(nt.code);
  if (old) {
    for (const p of old.players.values()) {
      tokens.delete(p.token);
      const np = nt.players.get(p.id);
      if (np) for (const sid of p.sockets) np.sockets.add(sid);
    }
  }
  tables.set(nt.code, nt);
  for (const p of nt.players.values()) tokens.set(p.token, { code: nt.code, id: p.id });
  return nt;
}
function markDirty(t) {
  t.rev = (t.rev || 0) + 1;
  if (!kv) return;
  dirty.add(t.code);
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
}
async function flush() {
  flushTimer = null;
  if (!kv || !kv.isReady || !dirty.size) return;
  const codes = [...dirty]; dirty.clear();
  await Promise.all(codes.map(async (code) => {
    const t = tables.get(code);
    try {
      if (!t) await kv.del(KEY(code));
      else await kv.set(KEY(code), JSON.stringify(serialize(t)), { EX: Math.ceil(TABLE_TTL_MS / 1000) });
    } catch (e) { console.error('save failed', code, e.message); dirty.add(code); }
  }));
  if (dirty.size && !flushTimer) flushTimer = setTimeout(flush, 2000);
}
// before seating someone, make sure this server has the newest saved copy of the table
async function freshTable(code) {
  const mem = tables.get(code);
  if (!kv || !kv.isReady || dirty.has(code)) return mem;
  try {
    const raw = await kv.get(KEY(code));
    if (raw) {
      const nt = deserialize(JSON.parse(raw));
      if (!mem || nt.rev > mem.rev) { install(nt); if (mem) broadcast(nt, false); return nt; }
    }
  } catch (e) { console.error('load failed', code, e.message); }
  return tables.get(code);
}
async function connectStore() {
  if (!process.env.REDIS_URL) { console.log('No REDIS_URL: tables are kept in memory only.'); return; }
  const { createClient } = require('redis');
  kv = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 5000, reconnectStrategy: (n) => Math.min(n * 250, 3000) } });
  kv.on('error', (e) => console.error('store:', e.message));
  try {
    await Promise.race([kv.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 6000))]);
    let n = 0;
    for await (const key of kv.scanIterator({ MATCH: 'lc:t:*', COUNT: 200 })) {
      const raw = await kv.get(key);
      if (raw) { try { install(deserialize(JSON.parse(raw))); n++; } catch (e) { console.error('bad table', key); } }
    }
    console.log(`Store connected, restored ${n} table(s).`);
  } catch (e) { console.error('Store unavailable, continuing in memory:', e.message); }
}

// ---------- views ----------
function viewFor(t, pid) {
  const s = t.s;
  const counts = {};
  for (const [u, h] of Object.entries(s.hands || {})) counts[u] = h.length;
  const players = [...t.players.values()].sort((a, b) => a.joined - b.joined)
    .map((p) => ({ id: p.id, name: p.name, online: isOnline(p) }));
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

function broadcast(t, save = true) {
  for (const p of t.players.values()) {
    for (const sid of p.sockets) io.to(sid).emit('state', viewFor(t, p.id));
  }
  if (save) markDirty(t);
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
  if (t.players.size === 0) { tables.delete(t.code); markDirty(t); return; }
  if (t.s.host === id) {
    // hand the table to the earliest player who is online, else the earliest player
    const order = seatedOrder(t);
    t.s.host = order.find((u) => isOnline(t.players.get(u))) || order[0];
    t.s.v++; E.pushLog(t.s, E.T(t.s.host) + ' is now the host');
  }
  t.lastActive = Date.now();
  broadcast(t);
}

function attach(socket, t, p) {
  socket.data.code = t.code;
  socket.data.pid = p.id;
  socket.join(t.code);
  p.sockets.add(socket.id);
  socket.emit('chatHistory', t.chat || []);
  broadcast(t);
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.data = { token: null, code: null, pid: null, last: 0, burst: 0, lastChat: 0 };

  const limited = () => {
    const now = Date.now();
    if (now - socket.data.last > 1000) { socket.data.last = now; socket.data.burst = 0; }
    return ++socket.data.burst > RATE_LIMIT;
  };
  const ctx = () => {
    const t = tables.get(socket.data.code);
    const p = t && t.players.get(socket.data.pid);
    return t && p ? { t, p, s: t.s, me: p.id, isHost: t.s.host === p.id } : null;
  };
  const on = (ev, handler) => socket.on(ev, (...args) => {
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
    if (limited()) return ack({ ok: false, error: 'Slow down a little.' });
    Promise.resolve()
      .then(() => handler(args[0] && typeof args[0] === 'object' ? args[0] : {}, ack))
      .catch((e) => { console.error(ev, e); ack({ ok: false, error: 'Something went wrong.' }); });
  });
  const hostOnly = (c, ack) => {
    if (c.isHost) return true;
    const host = c.t.players.get(c.s.host);
    ack({ ok: false, error: `Only the host (${host ? host.name : 'the table creator'}) can do that.` });
    return false;
  };

  on('hello', async ({ token, code }, ack) => {
    if (!validToken(token)) return ack({ ok: false, error: 'Bad token', build: BUILD });
    socket.data.token = token;
    const link = tokens.get(token);
    const tryCode = (link && link.code) || (validCode(code) ? code : null);
    const t = tryCode ? await freshTable(tryCode) : null;
    const p = t && [...t.players.values()].find((x) => x.token === token);
    if (p) { attach(socket, t, p); return ack({ ok: true, code: t.code, build: BUILD }); }
    ack({ ok: true, code: null, build: BUILD });
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

  on('join', async ({ code, name }, ack) => {
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    code = String(code || '').toUpperCase();
    const t = validCode(code) ? await freshTable(code) : null;
    if (!t) return ack({ ok: false, error: `No table with code ${code}. Check the code with whoever started it.` });
    const mine = [...t.players.values()].find((x) => x.token === socket.data.token);
    if (mine) {
      if (name) mine.name = cleanName(name);
      attach(socket, t, mine); return ack({ ok: true, code });
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

  // ----- host-only controls -----
  on('setting', ({ key }, ack) => {
    const c = ctx(); if (!c || !['stack', 'drawUntil'].includes(key)) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    ack({ ok: act(c.t, (s) => { if (s.status !== 'lobby') return false; s.settings[key] = !s.settings[key]; }) });
  });
  on('start', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    const seated = seatedOrder(c.t);
    if (seated.length < 2) return ack({ ok: false, error: 'You need at least 2 players.' });
    ack({ ok: act(c.t, (s) => { if (s.status === 'playing') return false; E.dealRound(s, seated); }) });
  });
  on('makeHost', ({ id }, ack) => {
    const c = ctx(); if (!c || typeof id !== 'string' || !c.t.players.has(id) || id === c.me) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    ack({ ok: act(c.t, (s) => { s.host = id; E.pushLog(s, E.T(id) + ' is now the host'); }) });
  });
  // anyone can take over when the host has gone offline, so a table never gets stuck
  on('claimHost', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    if (c.isHost) return ack({ ok: true });
    if (isOnline(c.t.players.get(c.s.host))) return ack({ ok: false, error: 'The host is still here.' });
    ack({ ok: act(c.t, (s) => { s.host = c.me; E.pushLog(s, E.T(c.me) + ' took over as host'); }) });
  });
  // the host can remove anyone; others can only remove players who are offline
  on('remove', ({ id }, ack) => {
    const c = ctx(); if (!c || typeof id !== 'string' || id === c.me || !c.t.players.has(id)) return ack({ ok: false });
    if (!c.isHost && isOnline(c.t.players.get(id))) return ack({ ok: false, error: 'Only the host can remove someone who is still online.' });
    removePlayer(c.t, id); ack({ ok: true });
  });

  // ----- moves -----
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

  // ----- talk -----
  on('react', ({ e }, ack) => {
    const c = ctx(); if (!c || !REACTIONS.includes(e)) return ack({ ok: false });
    io.to(c.t.code).emit('react', { e, by: c.me }); ack({ ok: true });
  });
  on('chat', ({ text }, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const msg = cleanText(text);
    if (!msg) return ack({ ok: false });
    const now = Date.now();
    if (now - socket.data.lastChat < 350) return ack({ ok: false, error: 'You’re typing too fast.' });
    socket.data.lastChat = now;
    const m = { id: rid(5), by: c.me, text: msg, at: now };
    c.t.chat = (c.t.chat || []).concat(m).slice(-CHAT_KEEP);
    c.t.lastActive = now;
    io.to(c.t.code).emit('chat', m);
    markDirty(c.t);
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const c = ctx();
    if (c) { c.p.sockets.delete(socket.id); broadcast(c.t, false); }
  });
});

// drop tables nobody has touched for a few hours
setInterval(() => {
  const now = Date.now();
  for (const t of tables.values()) {
    const anyoneHere = [...t.players.values()].some(isOnline);
    if (!anyoneHere && now - t.lastActive > TABLE_TTL_MS) {
      for (const p of t.players.values()) tokens.delete(p.token);
      tables.delete(t.code);
    }
  }
}, 10 * 60_000).unref();

// Render sends SIGTERM before replacing this server with a new version: save everything first.
let stopping = false;
async function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(sig, 'received, saving tables');
  if (kv && kv.isReady) {
    clearTimeout(flushTimer);
    for (const code of tables.keys()) dirty.add(code);
    try { await flush(); await kv.quit(); } catch (e) { console.error(e.message); }
  }
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const ready = connectStore().then(() => new Promise((r) => server.listen(PORT, () => { console.log(`Last Card ${BUILD} listening on :${PORT}`); r(); })));
module.exports = { server, io, tables, ready, flush };
