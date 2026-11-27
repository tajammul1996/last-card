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
const Accounts = require('./accounts.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const Analytics = require('./analytics');
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
// Moving address: PUBLIC_HOST (e.g. saylastcard.com) is where onrender.com visitors get sent, sign-in and all.
const PUBLIC_HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(process.env.PUBLIC_HOST || '') ? process.env.PUBLIC_HOST.toLowerCase() : null;
const handoffs = new Map(); // one-time code -> { data, at }
function handoff(req, res, which) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
  req.on('end', () => {
    const now = Date.now();
    for (const [k, v] of handoffs) if (now - v.at > 120_000) handoffs.delete(k);
    let j = null; try { j = JSON.parse(body); } catch (e) {}
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (!j) return send(400, { ok: false });
    if (which === '/handoff') {
      if (!PUBLIC_HOST || handoffs.size > 5000 || !j.data || typeof j.data !== 'object') return send(400, { ok: false });
      const data = {};
      for (const [k, v] of Object.entries(j.data)) if (/^lc-[a-z-]{1,20}$/.test(k) && typeof v === 'string' && v.length < 4000) data[k] = v;
      const code = crypto.randomBytes(16).toString('hex');
      handoffs.set(code, { data, at: now });
      return send(200, { ok: true, code });
    }
    const h = handoffs.get(String(j.code || ''));
    handoffs.delete(String(j.code || ''));
    if (!h) return send(404, { ok: false });
    Analytics.capture(Analytics.deviceId(h.data['lc-token'] || ''), 'address_moved', {});
    return send(200, { ok: true, data: h.data });
  });
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname === '/move.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ to: PUBLIC_HOST })); }
  if (req.method === 'POST' && (url.pathname === '/handoff' || url.pathname === '/handoff/redeem')) return handoff(req, res, url.pathname);
  if (/^\/t\/[^/]{1,60}\/?$/.test(url.pathname)) return servePersonal(req, res, url);
  if (url.pathname === '/qr.svg') return serveQr(req, res, url);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.normalize(path.join(PUBLIC, file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const extra = file === '/sw.js' ? { 'service-worker-allowed': '/' } : {};
    res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': /^\/icons\//.test(file) ? 'public, max-age=86400' : 'no-cache', ...extra });
    res.end(data);
  });
});

// The app page with a link preview naming the player (WhatsApp, iMessage and others read these tags).
// The words stay the same over time on purpose: chat apps cache previews, so nothing here goes stale.
const escAttr = (x) => String(x).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
async function servePersonal(req, res, url) {
  const slug = url.pathname.split('/')[2];
  const owner = await Accounts.findBySlug(slug).catch(() => null);
  fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8', (err, html) => {
    if (err) { res.writeHead(500); return res.end(); }
    const host = req.headers.host || PUBLIC_HOST || '';
    const title = owner ? `${owner.name}’s Last Card table` : 'Last Card';
    const desc = owner ? `Tap to sit down at ${owner.name}’s table. Free, no download.` : 'The card game for your group chat. Free, no download.';
    const tags = `<meta property="og:title" content="${escAttr(title)}"><meta property="og:description" content="${escAttr(desc)}">`
      + `<meta property="og:image" content="https://${escAttr(host)}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`
      + `<meta property="og:url" content="https://${escAttr(host)}${escAttr(url.pathname)}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">`;
    const out = html.replace(/<!-- og -->[\s\S]*?<!-- \/og -->/, '<!-- og -->' + tags + '<!-- /og -->').replace(/<title>[^<]*<\/title>/, `<title>${escAttr(title)}</title>`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(out);
  });
}
const QRCode = require('qrcode');
function serveQr(req, res, url) {
  const u = url.searchParams.get('u') || '';
  let ok = false; try { const x = new URL(u); ok = /^https?:$/.test(x.protocol) && (x.host === req.headers.host || x.host === PUBLIC_HOST) && u.length < 200; } catch (e) {}
  if (!ok) { res.writeHead(400); return res.end(); }
  QRCode.toString(u, { type: 'svg', margin: 2, color: { dark: '#0f2a3fff', light: '#ffffffff' } }, (err, svg) => {
    if (err) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    res.end(svg);
  });
}

// Admin accounts, by name, from the ADMIN_NAMES setting on Render (comma separated)
const ADMINS = new Set(String(process.env.ADMIN_NAMES || '').split(',').map((n) => Accounts.keyOf(n)).filter(Boolean));
const isAdmin = (socket) => !!(socket.data.account && ADMINS.has(socket.data.account.key));
const webpush = require('web-push');
let vapidPublic = null;
async function setupPush() {
  try {
    const keys = process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE
      ? { publicKey: process.env.VAPID_PUBLIC, privateKey: process.env.VAPID_PRIVATE }
      : await Accounts.meta('vapid', () => webpush.generateVAPIDKeys());
    webpush.setVapidDetails(process.env.RENDER_EXTERNAL_URL || 'mailto:lastcard@example.com', keys.publicKey, keys.privateKey);
    vapidPublic = keys.publicKey;
  } catch (e) { console.error('turn alerts off:', e.message); }
}
async function sendPush(acctKey, payload) {
  if (!ADMINS.has(acctKey)) Analytics.capture(acctKey, 'push_sent', { type: /^lc-fbu-/.test(payload.tag || '') ? 'reply' : /^lc-admin|^lc-fb-/.test(payload.tag || '') ? 'admin' : /^Round over/.test(payload.title || '') ? 'round_over' : 'turn', app_version: BUILD });
  if (!vapidPublic || !acctKey) return;
  const subs = await Accounts.pushSubs(acctKey).catch(() => []);
  for (const sub of subs) {
    webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 120 })
      .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) Accounts.dropPush(acctKey, sub.endpoint).catch(() => {}); });
  }
}
const io = new Server(server, { pingInterval: 20_000, pingTimeout: 25_000, maxHttpBufferSize: 10_000 });

// ---------- state ----------
/** code -> { code, created, lastActive, rev, names, chat, players: Map<id, player>, s } */
const tables = new Map();
/** account key -> code of that player's own table (what saylastcard.com/t/<them> opens) */
const homes = new Map();
function setHome(t, key, name) { t.home = key; t.homeName = name; homes.set(key, t.code); }
function dropHome(t) { if (t.home && homes.get(t.home) === t.code) homes.delete(t.home); }
/** who sat where last: 'a:<account>' or 't:<token>' -> table code (for the "Rejoin" card) */
const lastTable = new Map();
const seatKeys = (p) => [p.account ? 'a:' + p.account : null, p.token ? 't:' + p.token : null].filter(Boolean);
function remember(t, p) { for (const k of seatKeys(p)) lastTable.set(k, t.code); }
function forget(t, p) { for (const k of seatKeys(p)) if (lastTable.get(k) === t.code) lastTable.delete(k); }

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
    code: t.code, created: t.created, lastActive: t.lastActive, rev: t.rev, names: t.names, chat: t.chat, s: t.s, home: t.home || null, homeName: t.homeName || null,
    players: [...t.players.values()].map((p) => ({ id: p.id, token: p.token, account: p.account || null, name: p.name, joined: p.joined })),
  };
}
function deserialize(d) {
  const t = { code: d.code, created: d.created, lastActive: d.lastActive || Date.now(), rev: d.rev || 0, names: d.names || {}, chat: d.chat || [], s: d.s, players: new Map(), home: d.home || null, homeName: d.homeName || null };
  for (const p of d.players || []) t.players.set(p.id, { ...p, sockets: new Set() });
  return t;
}
// put a table loaded from storage in place, keeping any phones already connected to the old copy
function install(nt) {
  const old = tables.get(nt.code);
  if (old) {
    for (const p of old.players.values()) {
      const np = nt.players.get(p.id);
      if (np) for (const sid of p.sockets) np.sockets.add(sid);
    }
  }
  if (old) { nt.requests = old.requests; nt.allowed = old.allowed; nt.observers = old.observers; }
  tables.set(nt.code, nt);
  if (nt.home) homes.set(nt.home, nt.code);
  for (const p of nt.players.values()) remember(nt, p);
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
    .map((p) => ({ id: p.id, name: p.name, online: isOnline(p), signedIn: !!p.account }));
  const gone = {};
  for (const [id, name] of Object.entries(t.names || {})) if (!t.players.has(id)) gone[id] = name;
  return {
    code: t.code, me: pid, host: s.host, status: s.status, settings: s.settings, round: s.round, v: s.v,
    players, gone, order: s.order, turn: s.turn, dir: s.dir, pending: s.pending || 0, drew: !!s.drew,
    color: s.color, top: s.discard[s.discard.length - 1] || null, pile: s.discard.length, deckCount: s.deck.length,
    counts, hand: (s.hands && s.hands[pid]) || [], unsafe: s.unsafe || null, turnAt: s.turnAt || 0,
    winner: s.winner || null, wins: s.wins || {}, log: (s.log || []).slice(-6), now: Date.now(),
    ready: s.status === 'over' && t.ready ? [...t.ready].filter((id) => t.players.has(id)) : [], dealAt: s.status === 'over' ? t.dealAt || 0 : 0,
    home: t.home ? { slug: Accounts.slugOf(t.home), name: t.homeName || '' } : null,
    requests: pid === s.host && t.requests ? [...t.requests.entries()].map(([key, r]) => ({ key, name: r.name })) : [],
  };
}

// ---------- analytics (see analytics.js; off without POSTHOG_KEY) ----------
const NEW_PLAYER_MS = 7 * 864e5;
function platformOf(ua) {
  ua = String(ua || '');
  return /iPhone|iPod/.test(ua) ? 'iphone' : /iPad/.test(ua) ? 'ipad' : /Android/.test(ua) ? 'android' : /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : 'other';
}
// one event for one player at a table, from wherever it happens (a round ending, a table closing)
function trackPlayer(t, p, event, props) {
  if (!Analytics.enabled() || !p || (p.account && ADMINS.has(p.account))) return;
  const sock = [...p.sockets].map((id) => io.sockets.sockets.get(id)).find(Boolean);
  const sd = sock ? sock.data : {};
  Analytics.capture(p.account || Analytics.deviceId(p.token), event, {
    platform: sd.platform || null, installed: !!sd.installed, app_version: BUILD,
    table_code: t.code, table_players: t.players.size, is_host: t.s.host === p.id,
    new_player: sd.account && sd.account.since ? Date.now() - sd.account.since < NEW_PLAYER_MS : null, ...props,
  });
}
// rounds start and end in several ways (deal, last card, last player standing), so watch the state instead
function trackRounds(t) {
  if (!Analytics.enabled()) return;
  const s = t.s;
  if (s.status === 'playing' && t.anRound !== s.round) {
    t.anRound = s.round; t.rs = { at: Date.now(), plays: 0, draws: 0, calls: 0, catches: 0, idle_skips: 0 };
    const watchers = t.players.size - s.order.length;
    for (const id of s.order) trackPlayer(t, t.players.get(id), 'round_started', { round: s.round, players: s.order.length, watchers });
  }
  if (s.status === 'over' && t.anOver !== s.round) {
    t.anOver = s.round;
    const rs = t.rs || {};
    for (const id of s.order) trackPlayer(t, t.players.get(id), 'round_finished', {
      won: s.winner === id, round: s.round, players: s.order.length, seconds: rs.at ? Math.round((Date.now() - rs.at) / 1000) : null,
      plays: rs.plays || 0, draws: rs.draws || 0, calls: rs.calls || 0, catches: rs.catches || 0, idle_skips: rs.idle_skips || 0,
    });
  }
}
const roundStat = (t, k) => { if (t.rs) t.rs[k] = (t.rs[k] || 0) + 1; };

function broadcast(t, save = true) {
  if (t.ready && t.ready.size) scheduleDeal(t);
  for (const p of t.players.values()) {
    for (const sid of p.sockets) io.to(sid).emit('state', viewFor(t, p.id));
  }
  if (t.observers && t.observers.size) {
    const view = Object.assign(viewFor(t, null), { admin: true });
    for (const sid of t.observers) io.to(sid).emit('adminState', { code: t.code, view });
  }
  if (save) { markDirty(t); maybeAlert(t); trackRounds(t); }
}
// ---------- ready-up between rounds ----------
// After a round everyone taps "I'm in". Once two are in, the next round deals itself READY_DEAL_MS later,
// or almost at once when everyone online is in. Nobody waits on the host any more.
const READY_DEAL_MS = Number(process.env.READY_DEAL_MS || 5000);
function scheduleDeal(t) {
  const now = Date.now();
  const stop = () => { clearTimeout(t.dealTimer); t.dealTimer = null; t.dealAt = 0; };
  if (t.s.status !== 'over' || tables.get(t.code) !== t) { stop(); if (t.s.status === 'playing') t.ready = null; return; }
  const seated = seatedOrder(t);
  const ready = [...(t.ready || [])].filter((id) => t.players.has(id));
  if (ready.length < 2 || seated.length < 2) { stop(); return; }
  const everyone = seated.filter((id) => isOnline(t.players.get(id))).every((id) => ready.includes(id));
  const at = now + (everyone ? 1200 : READY_DEAL_MS);
  if (t.dealTimer && t.dealAt <= at) return; // already counting down to something sooner
  stop();
  t.dealAt = at;
  t.dealTimer = setTimeout(() => autoDeal(t), at - now);
}
function autoDeal(t) {
  t.dealTimer = null; t.dealAt = 0;
  if (tables.get(t.code) !== t || t.s.status !== 'over') return;
  const seated = seatedOrder(t); if (seated.length < 2) return;
  t.ready = null;
  if (act(t, (s) => { if (s.status === 'playing') return false; E.dealRound(s, seated); })) Accounts.bumpStat('deals').catch(() => {});
}

function plainLog(t) {
  const lg = (t.s.log || []).slice(-1)[0];
  if (!lg) return '';
  return String(lg.msg).replace(/\{\{([^}]+)\}\}/g, (_, u) => { const p = t.players.get(u); return p ? p.name : (t.names && t.names[u]) || 'Someone'; });
}
function maybeAlert(t) {
  const s = t.s;
  if (s.status === 'playing') {
    const u = s.order[s.turn], p = t.players.get(u), tag = s.round + ':' + s.turnAt;
    if (!p || !p.account || isOnline(p) || p.alerted === tag) return;
    p.alerted = tag;
    // give a phone that is just reconnecting a moment before buzzing it
    setTimeout(() => {
      const t2 = tables.get(t.code), p2 = t2 && t2.players.get(u);
      if (!t2 || !p2 || isOnline(p2) || t2.s.status !== 'playing' || t2.s.order[t2.s.turn] !== u || t2.s.round + ':' + t2.s.turnAt !== tag) return;
      sendPush(p2.account, { title: `Your turn at ${t2.code}`, body: plainLog(t2), url: '/#' + t2.code, tag: 'lc-' + t2.code });
    }, 4000);
  } else if (s.status === 'over' && t.overAlerted !== s.round) {
    t.overAlerted = s.round;
    const w = t.players.get(s.winner);
    for (const p of t.players.values()) {
      if (p.account && !isOnline(p) && s.order.includes(p.id)) sendPush(p.account, { title: `Round over at ${t.code}`, body: `${w ? w.name : 'Someone'} wins`, url: '/#' + t.code, tag: 'lc-' + t.code });
    }
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
  io.to(t.code).emit('presence', { code: t.code, type: 'left', id, name: p.name, status: t.s.status });
  t.players.delete(id);
  forget(t, p);
  for (const sid of p.sockets) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) { sock.leave(t.code); sock.data.code = null; sock.data.pid = null; sock.emit('left', { code: t.code }); }
  }
  if (t.players.size === 0) { trackPlayer(t, p, 'table_closed', { reason: 'empty', rounds: t.s.round || 0, players: 0, minutes_open: Math.round((Date.now() - (t.created || Date.now())) / 60000) }); tellObservers(t); dropHome(t); tables.delete(t.code); markDirty(t); return; }
  if (t.s.host === id) {
    // hand the table to the earliest player who is online, else the earliest player
    const order = seatedOrder(t);
    t.s.host = order.find((u) => isOnline(t.players.get(u))) || order[0];
    t.s.v++; E.pushLog(t.s, E.T(t.s.host) + ' is now the host');
  }
  t.lastActive = Date.now();
  broadcast(t);
}

function detach(socket) {
  const t = tables.get(socket.data.code);
  if (t) {
    const p = t.players.get(socket.data.pid);
    socket.leave(t.code);
    if (p) { p.sockets.delete(socket.id); broadcast(t, false); }
  }
  socket.data.code = null; socket.data.pid = null;
}

function attach(socket, t, p) {
  if (socket.data.code && (socket.data.code !== t.code || socket.data.pid !== p.id)) detach(socket);
  socket.data.code = t.code;
  socket.data.pid = p.id;
  socket.join(t.code);
  p.sockets.add(socket.id);
  remember(t, p);
  socket.emit('chatHistory', { code: t.code, list: t.chat || [] });
  broadcast(t);
}

// ---------- leaderboard ----------
// A round counts when someone wins by playing their last card. Players who aren't signed in aren't counted.
function recordRound(t, game) {
  const s = t.s;
  Accounts.bumpStat('rounds').catch(() => {});
  const acct = (id) => { const p = t.players.get(id); return p && p.account; };
  const winner = acct(s.winner);
  const keys = s.order.map(acct).filter(Boolean), lineup = keys.slice().sort().join('|');
  if (keys.length > 1 && t.matesNoted !== lineup) { t.matesNoted = lineup; Accounts.noteMates(keys).catch(() => {}); }
  Accounts.recordResult(game, winner, s.order.map(acct))
    .then(async (ok) => {
      if (!ok) return;
      const rows = await Accounts.leaderboard('all', 1, 'all', winner);
      io.to(t.code).emit('recorded', { code: t.code, round: s.round, winner: s.winner, rank: rows.mine ? rows.mine.rank : null });
    })
    .catch((e) => console.error('leaderboard save failed', e.message));
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  socket.data = { token: null, account: null, code: null, pid: null, last: 0, burst: 0, lastChat: 0 };
  socket.data.platform = platformOf(socket.handshake && socket.handshake.headers['user-agent']);
  // analytics for this connection: who it is, plus the details every event carries
  const track = (event, props) => {
    if (!Analytics.enabled() || isAdmin(socket)) return;
    const who = socket.data.account ? socket.data.account.key : socket.data.token ? Analytics.deviceId(socket.data.token) : null;
    const c = ctx();
    Analytics.capture(who, event, {
      platform: socket.data.platform, installed: !!socket.data.installed, app_version: BUILD,
      table_code: c ? c.t.code : null, table_players: c ? c.t.players.size : null, is_host: c ? c.isHost : false,
      new_player: socket.data.account && socket.data.account.since ? Date.now() - socket.data.account.since < NEW_PLAYER_MS : null, ...props,
    });
  };

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

  const findSeat = (t) => {
    const acct = socket.data.account && socket.data.account.key;
    const ps = [...t.players.values()];
    return (acct && ps.find((x) => x.account === acct)) || ps.find((x) => x.token === socket.data.token && (!x.account || x.account === acct)) || null;
  };
  const needAccount = (ack) => {
    if (socket.data.account) return true;
    ack({ ok: false, needLogin: true, error: 'Sign in with your name and PIN first.' });
    return false;
  };
  const peek = (t) => {
    const host = t.players.get(t.s.host);
    return {
      code: t.code, status: t.s.status, round: t.s.round || 0, host: host ? host.name : null,
      players: [...t.players.values()].sort((a, b) => a.joined - b.joined).map((x) => x.name),
      full: t.players.size >= MAX_PLAYERS, approve: !!(t.s.settings && t.s.settings.approve),
    };
  };
  const lastFor = () => {
    const keys = [socket.data.account ? 'a:' + socket.data.account.key : null, socket.data.token ? 't:' + socket.data.token : null].filter(Boolean);
    for (const k of keys) {
      const code = lastTable.get(k); const t = code && tables.get(code);
      const seat = t && findSeat(t);
      if (seat) {
        const s = t.s;
        const others = [...t.players.values()].filter((x) => x.id !== seat.id).sort((a, b) => a.joined - b.joined).map((x) => x.name);
        const host = t.players.get(s.host);
        return { code, status: s.status, round: s.round || 0, yourTurn: s.status === 'playing' && s.order[s.turn] === seat.id,
          players: others, host: host ? host.name : null, isHost: s.host === seat.id };
      }
    }
    return null;
  };
  // a signed-in player sitting in a seat claimed before accounts existed takes it over
  const adoptSeat = (t, p) => {
    if (socket.data.account && !p.account && ![...t.players.values()].some((x) => x.account === socket.data.account.key)) {
      p.account = socket.data.account.key; p.name = socket.data.account.name; remember(t, p); return true;
    }
    return false;
  };

  on('hello', async ({ token, session, installed }, ack) => {
    if (!validToken(token)) return ack({ ok: false, error: 'Bad token', build: BUILD });
    socket.data.token = token; socket.data.installed = !!installed;
    socket.data.account = session ? await Accounts.fromSession(session) : null;
    if (socket.data.account) Accounts.markActive(socket.data.account.key).catch(() => {});
    ack({ ok: true, build: BUILD, account: socket.data.account ? { name: socket.data.account.name, key: socket.data.account.key, slug: Accounts.slugOf(socket.data.account.key), protect: socket.data.account.protect || 'pin', admin: isAdmin(socket) } : null, emailOn: Accounts.emailOn(), sessionValid: !session || !!socket.data.account, last: lastFor(), analytics: Analytics.clientConfig(token) });
  });

  on('login', async ({ name, pin, mode, known }, ack) => {
    const now = Date.now();
    socket.data.logins = (socket.data.logins || []).filter((x) => now - x < 60_000);
    if (socket.data.logins.length >= 12) return ack({ ok: false, error: 'Too many tries. Wait a minute.' });
    socket.data.logins.push(now);
    const r = mode === 'reset' ? await Accounts.setNewPin(name, pin) : await Accounts.login(name, pin, mode === 'guest' ? 'guest' : mode === 'new' ? 'new' : 'back');
    if (!r.ok) {
      track('signin_failed', { reason: r.taken ? 'taken' : r.notFound ? 'not_found' : mode === 'reset' && /expired/i.test(r.error || '') ? 'expired_reset' : /Too many/i.test(r.error || '') ? 'locked' : /Wrong PIN/i.test(r.error || '') ? 'wrong_pin' : 'other', method: mode === 'new' ? 'new' : mode === 'reset' ? 'reset' : 'back' });
      return ack(r);
    }
    socket.data.account = { key: r.key, name: r.name, since: r.since || 0, protect: r.protect };
    if (!isAdmin(socket)) { Analytics.link(r.key, socket.data.token); track('signed_in', { method: r.newPin ? 'reset' : r.created ? (mode === 'guest' ? 'new_username' : 'new') : 'back', known_on_device: Number(known) || 0 }); }
    Accounts.markActive(r.key).catch(() => {});
    if (r.created) Accounts.bumpStat('signups').catch(() => {});
    const c = ctx();
    if (c && adoptSeat(c.t, c.p)) broadcast(c.t);
    ack({ ok: true, session: r.session, name: r.name, key: r.key, slug: Accounts.slugOf(r.key), protect: r.protect || 'pin', created: r.created, newPin: !!r.newPin, last: lastFor(), admin: isAdmin(socket) });
  });

  // ---- email: add one to keep your username; sign in on any phone with a code ----
  const emailLimit = (field, max) => {
    const now = Date.now();
    socket.data[field] = (socket.data[field] || []).filter((x) => now - x < 600_000);
    if (socket.data[field].length >= max) return false;
    socket.data[field].push(now); return true;
  };
  on('emailStart', async ({ purpose, who }, ack) => {
    if (!emailLimit('emailStarts', 6)) return ack({ ok: false, error: 'Too many tries. Wait a few minutes.' });
    if (purpose === 'add' && !needAccount(ack)) return;
    const r = await Accounts.emailStart({ purpose: purpose === 'add' ? 'add' : 'signin', key: socket.data.account && socket.data.account.key, who }).catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }));
    track(purpose === 'add' ? 'email_add_started' : 'email_signin_started', { ok: !!r.ok });
    ack(r);
  });
  on('emailVerify', async ({ id, code, known }, ack) => {
    if (!emailLimit('emailVerifies', 25)) return ack({ ok: false, error: 'Too many tries. Wait a few minutes.' });
    const r = await Accounts.emailVerify({ id, code, key: socket.data.account && socket.data.account.key }).catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }));
    if (!r.ok) { track('email_code_failed', {}); return ack(r); }
    if (r.added) { socket.data.account.protect = 'email'; track('email_added', {}); return ack(r); }
    socket.data.account = { key: r.key, name: r.name, since: r.since || 0, protect: r.protect };
    if (!isAdmin(socket)) { Analytics.link(r.key, socket.data.token); track('signed_in', { method: 'email', known_on_device: Number(known) || 0 }); }
    Accounts.markActive(r.key).catch(() => {});
    const c = ctx();
    if (c && adoptSeat(c.t, c.p)) broadcast(c.t);
    ack({ ok: true, session: r.session, name: r.name, key: r.key, slug: Accounts.slugOf(r.key), protect: r.protect, last: lastFor(), admin: isAdmin(socket) });
  });
  on('setPin', async ({ pin }, ack) => {
    if (!needAccount(ack)) return;
    if (!emailLimit('pinSets', 6)) return ack({ ok: false, error: 'Too many tries. Wait a few minutes.' });
    const r = await Accounts.setPinOnce(socket.data.account.key, pin);
    if (r.ok) { socket.data.account.protect = 'pin'; track('pin_added', {}); }
    ack(r);
  });
  on('accountInfo', async (_, ack) => {
    if (!socket.data.account) return ack({ ok: false });
    ack({ ok: true, emailOn: Accounts.emailOn(), ...(await Accounts.accountInfo(socket.data.account.key)) });
  });

  // ---- feedback from players ----
  const fbText = (x) => String(x || '').replace(/\s+\n/g, '\n').trim().slice(0, 1000);
  on('fbSend', async ({ kind, text }, ack) => {
    if (!needAccount(ack)) return;
    const now = Date.now();
    socket.data.fbSends = (socket.data.fbSends || []).filter((x) => now - x < 600_000);
    if (socket.data.fbSends.length >= 6) return ack({ ok: false, error: 'That’s a lot of messages. Try again in a few minutes.' });
    const msg = fbText(text);
    if (msg.length < 2) return ack({ ok: false, error: 'Write a few words first.' });
    socket.data.fbSends.push(now);
    const c = ctx();
    const t = await Accounts.fbCreate({ key: socket.data.account.key, name: socket.data.account.name, kind: ['idea', 'problem', 'other'].includes(kind) ? kind : 'other', text: msg, code: c ? c.t.code : null, device: deviceOf(socket) });
    alertAdminsFeedback(t);
    track('feedback_sent', { kind: t.kind, from: c ? 'table' : 'home' });
    ack({ ok: true, item: fbUser(t) });
  });
  on('fbMine', async (_, ack) => {
    if (!socket.data.account) return ack({ ok: true, items: [], unread: 0 });
    const items = (await Accounts.fbList(socket.data.account.key, 50)).map(fbUser);
    ack({ ok: true, items, unread: items.filter((t) => t.unread).length });
  });
  on('fbReply', async ({ id, text }, ack) => {
    if (!needAccount(ack)) return;
    const msg = fbText(text); if (msg.length < 1) return ack({ ok: false, error: 'Write something first.' });
    const t = await Accounts.fbUpdate(id, (x) => { if (x.key !== socket.data.account.key || x.msgs.length >= 60) return false; x.msgs.push({ from: 'user', text: msg, at: Date.now() }); x.adminUnread = true; x.unread = false; });
    if (!t || t.key !== socket.data.account.key) return ack({ ok: false });
    alertAdminsFeedback(t, true);
    ack({ ok: true, item: fbUser(t) });
  });
  on('fbRead', async ({ id }, ack) => {
    if (!socket.data.account) return ack({ ok: false });
    let wasUnread = false;
    const t = await Accounts.fbUpdate(id, (x) => { if (x.key !== socket.data.account.key || !x.unread) return false; x.unread = false; wasUnread = true; });
    if (t && wasUnread) { const lastAdmin = [...t.msgs].reverse().find((m) => m.from === 'admin'); track('feedback_read', { hours_after_reply: lastAdmin ? Math.round((Date.now() - lastAdmin.at) / 360000) / 10 : null }); }
    ack({ ok: !!t });
  });

  // ---- the admin inbox ----
  on('adminFb', async (_, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    const items = (await Accounts.fbList(null, 200)).map(fbAdmin);
    ack({ ok: true, items });
  });
  on('adminFbOpen', async ({ id }, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    let seenNow = false;
    const t = await Accounts.fbUpdate(id, (x) => { if (!x.adminUnread && x.status !== 'new') return false; x.adminUnread = false; if (x.status === 'new' && x.kind !== 'pin') { x.status = 'seen'; seenNow = true; } });
    if (!t) return ack({ ok: false, error: 'That message is gone.' });
    if (seenNow) tellPlayerFeedback(t, null);
    ack({ ok: true, item: fbAdmin(t) });
  });
  on('adminFbReply', async ({ id, text, status }, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    const msg = fbText(text);
    if (!msg && !Accounts.FB_STATUS.includes(status)) return ack({ ok: false, error: 'Write a reply or pick a status.' });
    const t = await Accounts.fbUpdate(id, (x) => {
      if (msg) x.msgs.push({ from: 'admin', text: msg, at: Date.now() });
      if (Accounts.FB_STATUS.includes(status) && status !== 'new') { if (status !== x.status) x.msgs.push({ from: 'status', text: status, at: Date.now() }); x.status = status; }
      x.unread = true; x.adminUnread = false;
    });
    if (!t) return ack({ ok: false, error: 'That message is gone.' });
    tellPlayerFeedback(t, msg || null);
    if (t.key && !ADMINS.has(t.key)) Analytics.capture(t.key, 'feedback_answered', { status: t.status, has_text: !!msg, hours_to_answer: Math.round((Date.now() - t.at) / 360000) / 10, kind: t.kind, app_version: BUILD });
    ack({ ok: true, item: fbAdmin(t) });
  });
  on('adminFbPin', async ({ id }, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    const t0 = await Accounts.fbGet(id); if (!t0 || t0.kind !== 'pin') return ack({ ok: false });
    const name = await Accounts.allowPinReset(t0.name);
    if (!name) return ack({ ok: false, error: 'That player no longer exists.' });
    const t = await Accounts.fbUpdate(id, (x) => { x.status = 'done'; x.adminUnread = false; x.unread = true; x.msgs.push({ from: 'admin', text: `Done. Sign in as ${name} within a day and you’ll pick a new PIN.`, at: Date.now() }); });
    if (t.key) Analytics.capture(t.key, 'pin_reset_allowed', { hours_waiting: Math.round((Date.now() - t.at) / 360000) / 10, app_version: BUILD });
    ack({ ok: true, item: fbAdmin(t) });
  });

  // "Forgot your PIN?": goes to the admin inbox; once the admin allows it, signing in with that name picks a new PIN
  on('forgotPin', async ({ name }, ack) => {
    const now = Date.now();
    socket.data.pinAsks = (socket.data.pinAsks || []).filter((x) => now - x < 3600_000);
    if (socket.data.pinAsks.length >= 3) return ack({ ok: false, error: 'You’ve asked already. The admin will get to it.' });
    const ck = await Accounts.checkName(name);
    if (!ck.valid || ck.available) return ack({ ok: false, error: 'No player with that name.' });
    socket.data.pinAsks.push(now);
    const key = Accounts.keyOf(ck.name);
    const open = (await Accounts.fbList(key, 20)).find((t) => t.kind === 'pin' && t.status === 'new');
    if (!open) {
      const t = await Accounts.fbCreate({ key, name: ck.name, kind: 'pin', text: `${ck.name} forgot their PIN and asked for a reset.`, device: deviceOf(socket) });
      alertAdminsFeedback(t);
      track('pin_reset_requested', {});
    }
    ack({ ok: true });
  });

  on('checkName', async ({ name }, ack) => {
    const now = Date.now();
    socket.data.checks = (socket.data.checks || []).filter((x) => now - x < 10_000);
    if (socket.data.checks.length >= 30) return ack({ ok: false });
    socket.data.checks.push(now);
    ack(await Accounts.checkName(name));
  });

  on('logout', async ({ session }, ack) => {
    await Accounts.logout(session);
    detach(socket);
    socket.data.account = null;
    ack({ ok: true });
  });

  // open a table from a link: sit back down if you have a seat, otherwise just look at it
  on('open', async ({ code, via }, ack) => {
    code = String(code || '').toUpperCase();
    const t = validCode(code) ? await freshTable(code) : null;
    const seat = t ? findSeat(t) : null;
    const closed = t ? null : closedInfo(code);
    track('invite_opened', { via: ['link', 'code', 'invite_card', 'start_confirm', 'closed_page'].includes(via) ? via : 'link', table_exists: !!t, closed_reason: closed ? closed.reason : null, already_seated: !!seat, table_status: t ? t.s.status : null, table_code: code });
    if (!t) return ack({ ok: true, exists: false, code, closed });
    if (seat) {
      adoptSeat(t, seat);
      attach(socket, t, seat);
      return ack({ ok: true, exists: true, seated: true, code });
    }
    looking(t);
    ack({ ok: true, exists: true, seated: false, info: peek(t) });
  });

  // someone opened this table's link but hasn't sat down yet: the host sees "Ravi opened your link"
  const looking = (t) => {
    const now = Date.now();
    if (now - (socket.data.lookedAt || 0) < 20_000 && socket.data.lookedCode === t.code) return;
    socket.data.lookedAt = now; socket.data.lookedCode = t.code;
    io.to(t.code).emit('presence', { code: t.code, type: 'looking', name: socket.data.account ? socket.data.account.name : null, key: socket.data.account ? socket.data.account.key : socket.data.token.slice(0, 8), status: t.s.status });
  };

  // a personal link, saylastcard.com/t/<name>: that player's table if it's open, otherwise who they are
  on('openHome', async ({ slug, via }, ack) => {
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    const owner = await Accounts.findBySlug(slug).catch(() => null);
    if (!owner) { track('invite_opened', { via: 'home_link', table_exists: false, unknown_link: true }); return ack({ ok: true, exists: false, unknown: true }); }
    const mine = socket.data.account && socket.data.account.key === owner.key;
    const code = homes.get(owner.key);
    const t = code ? await freshTable(code) : null;
    const host = { name: owner.name, slug: Accounts.slugOf(owner.key), online: socketsOf(owner.key).length > 0, mine };
    track('invite_opened', { via: 'home_link', table_exists: !!t, already_seated: !!(t && findSeat(t)), own_link: mine, table_status: t ? t.s.status : null });
    if (!t) return ack({ ok: true, exists: false, host });
    const seat = findSeat(t);
    if (seat) { adoptSeat(t, seat); attach(socket, t, seat); return ack({ ok: true, exists: true, seated: true, code: t.code }); }
    looking(t);
    ack({ ok: true, exists: true, seated: false, info: peek(t), host });
  });

  // "Tell Tajammul I'm in": their table is closed, so buzz them
  on('knock', async ({ slug }, ack) => {
    const owner = await Accounts.findBySlug(slug).catch(() => null);
    if (!owner) return ack({ ok: false, error: 'We couldn’t find that player.' });
    const now = Date.now(), who = socket.data.account ? socket.data.account.name : null;
    socket.data.knocks = (socket.data.knocks || []).filter((x) => now - x.at < 600_000);
    if (socket.data.knocks.some((x) => x.key === owner.key && now - x.at < 120_000)) return ack({ ok: true, again: true });
    if (socket.data.knocks.length >= 6) return ack({ ok: false, error: 'That’s a lot of knocking. Try again in a few minutes.' });
    socket.data.knocks.push({ key: owner.key, at: now });
    const body = `${who || 'A friend'} opened your link and wants to play.`;
    for (const sk of socketsOf(owner.key)) sk.emit('knock', { name: who, at: now });
    sendPush(owner.key, { title: 'Someone’s at your table', body, tag: 'lc-knock', url: '/?src=push' }).catch(() => {});
    track('knock_sent', { host_online: socketsOf(owner.key).length > 0 });
    ack({ ok: true });
  });

  // people you've played with, for the invite sheet
  on('mates', async (_, ack) => {
    if (!socket.data.account) return ack({ ok: true, list: [] });
    const list = await Accounts.mates(socket.data.account.key, 12).catch(() => []);
    ack({ ok: true, list: list.map((m) => ({ key: m.key, name: m.name, last: m.last, online: socketsOf(m.key).length > 0 })) });
  });
  // ping one of them: a push alert plus an in-app note, sending them to your table
  on('ping', async ({ key }, ack) => {
    if (!needAccount(ack)) return;
    const me = socket.data.account, now = Date.now();
    if (typeof key !== 'string' || key === me.key || !(await Accounts.isMate(me.key, key).catch(() => false))) return ack({ ok: false, error: 'You can only ping people you’ve played with.' });
    socket.data.pings = (socket.data.pings || []).filter((x) => now - x.at < 600_000);
    if (socket.data.pings.some((x) => x.key === key)) return ack({ ok: true, again: true });
    if (socket.data.pings.length >= 10) return ack({ ok: false, error: 'That’s a lot of pings. Try again in a few minutes.' });
    socket.data.pings.push({ key, at: now });
    const slug = Accounts.slugOf(me.key);
    for (const sk of socketsOf(key)) sk.emit('pinged', { name: me.name, slug });
    sendPush(key, { title: `${me.name} is up for a game`, body: 'Tap to sit down at their table.', tag: 'lc-ping-' + slug, url: '/t/' + encodeURIComponent(slug) + '?src=push' }).catch(() => {});
    track('ping_sent', { mate_online: socketsOf(key).length > 0 });
    ack({ ok: true });
  });

  // look at a table without sitting down (the join-by-code preview and the invite card on home)
  on('peek', async ({ code }, ack) => {
    code = String(code || '').toUpperCase();
    const t = validCode(code) ? await freshTable(code) : null;
    if (!t) return ack({ ok: true, exists: false, code, closed: closedInfo(code) });
    ack({ ok: true, exists: true, seated: !!findSeat(t), info: peek(t) });
  });

  // stop getting updates from the current table but keep the seat
  on('away', ({ why }, ack) => {
    const c = ctx();
    if (c && why === 'break' && c.s.status === 'playing' && c.s.order.includes(c.me)) track('break_taken', { cards_left: c.s.hands[c.me] ? c.s.hands[c.me].length : 0 });
    detach(socket); ack({ ok: true });
  });

  on('create', ({ from, hadInvite }, ack) => {
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    if (!needAccount(ack)) return;
    if (tables.size >= MAX_TABLES) return ack({ ok: false, error: 'The server is full right now. Try again later.' });
    const akey = socket.data.account.key;
    // you have one table: if it's still open, go back to it (sitting down again if you'd left)
    const homeCode = homes.get(akey), home = homeCode && tables.get(homeCode);
    if (home) {
      let seat = findSeat(home);
      if (!seat) {
        if (home.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'Your table is full (10 players).' });
        seat = { id: rid(6), token: socket.data.token, account: akey, name: socket.data.account.name, joined: Date.now(), sockets: new Set() };
        home.players.set(seat.id, seat);
        io.to(home.code).emit('presence', { code: home.code, type: 'joined', id: seat.id, name: seat.name, status: home.s.status });
      }
      const old = ctx(); if (old && old.t.code !== home.code && old.s.status === 'lobby') removePlayer(old.t, old.me);
      attach(socket, home, seat);
      return ack({ ok: true, code: home.code, again: true });
    }
    const old = ctx(); if (old && old.s.status === 'lobby') removePlayer(old.t, old.me);
    const id = rid(6);
    const t = newTable(id);
    setHome(t, akey, socket.data.account.name);
    const p = { id, token: socket.data.token, account: akey, name: socket.data.account.name, joined: Date.now(), sockets: new Set() };
    t.players.set(id, p);
    attach(socket, t, p);
    ack({ ok: true, code: t.code });
    track('table_created', { from: ['home', 'join_sheet', 'closed_page', 'start_confirm'].includes(from) ? from : 'home', had_pending_invite: !!hadInvite });
    alertAdmins('open', t, p.name).catch(() => {});
  });

  on('join', async ({ code, via }, ack) => {
    const joinVia = ['link', 'code', 'invite_card', 'rejoin'].includes(via) ? via : 'link';
    if (!socket.data.token) return ack({ ok: false, error: 'Not ready yet. Try again.' });
    if (!needAccount(ack)) return;
    code = String(code || '').toUpperCase();
    const t = validCode(code) ? await freshTable(code) : null;
    if (!t) return ack({ ok: false, error: `No table with code ${code}. It may have ended. Ask for a new link.` });
    const mine = findSeat(t);
    if (mine) { adoptSeat(t, mine); attach(socket, t, mine); track('table_joined', { via: 'rejoin', as: t.s.order.includes(mine.id) || t.s.status === 'lobby' ? 'player' : 'watcher', table_status: t.s.status }); return ack({ ok: true, code }); }
    if (t.players.size >= MAX_PLAYERS) return ack({ ok: false, error: 'That table is full (10 players).' });
    const akey = socket.data.account.key;
    if (t.s.settings && t.s.settings.approve && !(t.allowed && t.allowed.has(akey))) {
      t.requests = t.requests || new Map();
      const req = t.requests.get(akey) || { name: socket.data.account.name, sockets: new Set(), at: Date.now() };
      req.sockets.add(socket.id); t.requests.set(akey, req);
      socket.data.asked = code;
      const host = t.players.get(t.s.host);
      if (host) for (const sid of host.sockets) io.to(sid).emit('joinRequest', { code, name: req.name });
      broadcast(t, false);
      track('join_requested', { table_code: code });
      return ack({ ok: false, waiting: true, code, host: host ? host.name : 'the host' });
    }
    if (t.allowed) t.allowed.delete(akey);
    if (t.requests) t.requests.delete(akey);
    // leaving a lobby elsewhere frees that seat; a seat in a running game is kept so you can go back
    const old = ctx(); if (old && old.t.code !== code && old.s.status === 'lobby') removePlayer(old.t, old.me);
    const id = rid(6);
    const p = { id, token: socket.data.token, account: socket.data.account.key, name: socket.data.account.name, joined: Date.now(), sockets: new Set() };
    t.players.set(id, p);
    attach(socket, t, p);
    io.to(code).emit('presence', { code, type: 'joined', id, name: p.name, status: t.s.status });
    track('table_joined', { via: joinVia, as: t.s.status === 'playing' ? 'watcher' : 'player', table_status: t.s.status });
    ack({ ok: true, code });
  });

  on('admit', ({ key, allow }, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    const req = c.t.requests && c.t.requests.get(key);
    if (!req) return ack({ ok: false, error: 'They stopped waiting.' });
    c.t.requests.delete(key);
    if (allow) { c.t.allowed = c.t.allowed || new Set(); c.t.allowed.add(key); }
    for (const sid of req.sockets) io.to(sid).emit(allow ? 'admitted' : 'declined', { code: c.t.code, host: c.p.name });
    if (!ADMINS.has(key)) Analytics.capture(key, 'join_answered', { answer: allow ? 'admitted' : 'declined', seconds_waiting: Math.round((Date.now() - (req.at || Date.now())) / 1000), table_code: c.t.code, app_version: BUILD });
    broadcast(c.t, false);
    ack({ ok: true });
  });
  on('cancelJoin', ({ code }, ack) => {
    const t = tables.get(String(code || '').toUpperCase());
    const key = socket.data.account && socket.data.account.key;
    if (t && t.requests && key && t.requests.delete(key)) broadcast(t, false);
    socket.data.asked = null;
    ack({ ok: true });
  });
  // ---------- admin: every table, usage numbers, and silent watching ----------
  on('practiceStat', (_, ack) => {
    const now = Date.now();
    if (now - (socket.data.lastPractice || 0) > 15000) { socket.data.lastPractice = now; Accounts.bumpStat('practice').catch(() => {}); }
    ack({ ok: true });
  });
  on('adminOverview', async (_, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    const now = Date.now(), online = new Set();
    for (const sock of io.sockets.sockets.values()) if (sock.connected && sock.data.account) online.add(sock.data.account.key);
    let atTables = 0, watching = 0, waiting = 0;
    const order = { playing: 0, over: 1, lobby: 2 };
    const list = [...tables.values()].map((t) => {
      const s = t.s, seated = new Set(s.order || []);
      const players = [...t.players.values()].sort((a, b) => a.joined - b.joined).map((p) => {
        const on = isOnline(p), watch = s.status === 'playing' && !seated.has(p.id);
        if (on) atTables++; if (watch) watching++;
        return { name: p.name, online: on, cards: (s.hands[p.id] || []).length, turn: s.status === 'playing' && s.order[s.turn] === p.id, host: p.id === s.host, watching: watch };
      });
      const req = t.requests ? t.requests.size : 0; waiting += req;
      const lg = (s.log || []).slice(-1)[0];
      return {
        code: t.code, status: s.status, round: s.round || 0, host: (t.players.get(s.host) || {}).name || '', players,
        turnFor: s.status === 'playing' ? now - (s.turnAt || now) : 0, pending: s.pending || 0, deck: (s.deck || []).length,
        openFor: now - (t.created || now), idleFor: now - (t.lastActive || now), requests: req, approve: !!(s.settings && s.settings.approve),
        winner: s.status === 'over' ? (t.players.get(s.winner) || {}).name || '' : '', last: lg ? plainLog(t) : '', observers: t.observers ? t.observers.size : 0,
      };
    }).filter((x) => x.players.length).sort((a, b) => (order[a.status] - order[b.status]) || a.idleFor - b.idleFor);
    const st = await Accounts.stats().catch(() => null);
    const top = await Accounts.leaderboard('all', 5, 'week').catch(() => []);
    ack({
      ok: true, now, tables: list,
      live: { playing: list.filter((x) => x.status === 'playing').length, lobby: list.filter((x) => x.status === 'lobby').length, over: list.filter((x) => x.status === 'over').length, online: online.size, atTables, watching, waiting },
      stats: st, top: top.map((x) => ({ name: x.name, wins: x.wins })), alerts: await adminPref(socket.data.account.key),
      chat: await Accounts.chatLog(80).catch(() => []),
      fbTodo: await Accounts.fbTodo().catch(() => 0),
      server: { uptime: Math.round(process.uptime()), mem: process.memoryUsage().rss, build: BUILD, saved: !!kv, accounts: Accounts.persistent(), sockets: io.engine.clientsCount },
    });
  });
  on('adminWatch', async ({ code }, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    const t = tables.get(String(code || '').toUpperCase());
    if (!t) return ack({ ok: false, error: 'That table has closed.' });
    unobserve();
    t.observers = t.observers || new Set(); t.observers.add(socket.id);
    socket.data.observing = t.code;
    ack({ ok: true, code: t.code, view: Object.assign(viewFor(t, null), { admin: true }), chat: (t.chat || []).slice(-60) });
  });
  on('adminUnwatch', (_, ack) => { unobserve(); ack({ ok: true }); });
  on('adminPref', async ({ alerts }, ack) => {
    if (!isAdmin(socket)) return ack({ ok: false, error: 'Not allowed.' });
    if (ALERT_KINDS.includes(alerts)) await Accounts.setMeta('adminpref:' + socket.data.account.key, alerts);
    ack({ ok: true, alerts: await adminPref(socket.data.account.key) });
  });
  function unobserve() {
    const t = socket.data.observing && tables.get(socket.data.observing);
    if (t && t.observers) t.observers.delete(socket.id);
    socket.data.observing = null;
  }

  on('vapid', (_, ack) => ack({ ok: !!vapidPublic, key: vapidPublic }));
  on('pushSub', async ({ sub, fresh, from }, ack) => {
    if (!socket.data.account) return ack({ ok: false });
    const ok = await Accounts.savePush(socket.data.account.key, sub).catch(() => false);
    if (ok && fresh) track('alerts_enabled', { asked_from: ['menu', 'round_over', 'admin', 'home'].includes(from) ? from : 'menu' });
    ack({ ok });
  });

  on('leave', (_, ack) => {
    const c = ctx();
    if (c) {
      const when = c.s.status === 'lobby' ? 'lobby' : c.s.status === 'playing' && c.s.order.includes(c.me) ? 'mid_round' : 'between_rounds';
      track('player_left', { when, was_host: c.isHost, cards_left: c.s.hands && c.s.hands[c.me] ? c.s.hands[c.me].length : 0 });
      removePlayer(c.t, c.me);
    }
    ack({ ok: true });
  });

  on('leaderboard', async ({ game, period, limit }, ack) => {
    const g = Accounts.GAMES[game] ? game : 'all';
    const per = period === 'week' ? 'week' : 'all';
    const mineKey = socket.data.account && socket.data.account.key;
    const rows = await Accounts.leaderboard(g, Math.min(Math.max(Number(limit) || 50, 1), 50), per, mineKey);
    // who has the app open right now (signed in, connected)
    const on = new Set();
    for (const sock of io.sockets.sockets.values()) if (sock.connected && sock.data.account) on.add(sock.data.account.key);
    const pub = (x) => x && ({ rank: x.rank, name: x.name, wins: x.wins, played: x.played, last: x.last, me: x.key === mineKey, online: on.has(x.key) });
    ack({ ok: true, game: g, period: per, games: Accounts.GAMES, persistent: Accounts.persistent(), rows: rows.map(pub), mine: pub(rows.mine), online: on.size });
  });

  // a gentle "your turn to deal" poke at the host, at most every 15 seconds
  on('nudge', (_, ack) => {
    const c = ctx(); if (!c || c.isHost) return ack({ ok: false });
    const now = Date.now();
    if (now - (socket.data.lastNudge || 0) < 15_000) return ack({ ok: false, error: 'You just nudged. Give them a moment.' });
    socket.data.lastNudge = now;
    const host = c.t.players.get(c.s.host);
    if (host) for (const sid of host.sockets) io.to(sid).emit('nudged', { code: c.t.code, by: c.me });
    ack({ ok: true });
  });

  // ----- host-only controls -----
  on('setting', ({ key }, ack) => {
    const c = ctx(); if (!c || !['stack', 'drawUntil', 'approve'].includes(key)) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    if (key === 'approve') return ack({ ok: act(c.t, (s) => { s.settings.approve = !s.settings.approve; }) });
    ack({ ok: act(c.t, (s) => { if (s.status !== 'lobby') return false; s.settings[key] = !s.settings[key]; }) });
  });
  on('start', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    if (!hostOnly(c, ack)) return;
    const seated = seatedOrder(c.t);
    if (seated.length < 2) return ack({ ok: false, error: 'You need at least 2 players.' });
    const ok = act(c.t, (s) => { if (s.status === 'playing') return false; E.dealRound(s, seated); });
    if (ok) Accounts.bumpStat('deals').catch(() => {});
    ack({ ok });
    if (ok && c.s.round === 1) alertAdmins('start', c.t).catch(() => {});
  });
  on('ready', ({ on: want }, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    if (c.s.status !== 'over') return ack({ ok: false, error: 'The round is still going.' });
    c.t.ready = c.t.ready || new Set();
    if (want === false) c.t.ready.delete(c.me); else c.t.ready.add(c.me);
    if (want !== false) track('ready_tapped', { ready: c.t.ready.size, seated: seatedOrder(c.t).length });
    broadcast(c.t, false);
    ack({ ok: true });
  });
  // the host can close the table at any time (anyone can when the host has gone offline):
  // everyone sees the standings and goes home
  on('endGame', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const t = c.t;
    if (!c.isHost && isOnline(t.players.get(t.s.host))) return ack({ ok: false, error: 'Only the host can end the game.' });
    closeTable(t, 'ended', c.p.name);
    ack({ ok: true });
  });
  // anyone at the table can reset the idle countdown
  on('keepOpen', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    track('table_kept_open', { seconds_left: c.t.warnedFor ? Math.max(0, Math.round((c.t.warnedFor - Date.now()) / 1000)) : null });
    c.t.lastActive = Date.now(); c.t.emptySince = null; c.t.warnedFor = null;
    io.to(c.t.code).emit('idleWarn', { code: c.t.code, closesAt: null, by: c.p.name });
    ack({ ok: true });
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
    if (ok) { roundStat(c.t, 'plays'); if (called) roundStat(c.t, 'calls'); } else track('action_refused', { action: 'play', error: c.s.status !== 'playing' ? 'round_not_running' : c.s.order[c.s.turn] !== c.me ? 'not_your_turn' : 'card_not_allowed' });
    ack({ ok, error: ok ? null : 'That card can’t be played right now.' });
    if (ok && c.s.status === 'over' && c.s.winner === c.me) recordRound(c.t, 'lastcard');
  });
  on('draw', (_, ack) => {
    const c = ctx(); const ok = !!c && act(c.t, (s) => E.applyDraw(s, c.me));
    if (ok) roundStat(c.t, 'draws'); else if (c) track('action_refused', { action: 'draw', error: c.s.order[c.s.turn] !== c.me ? 'not_your_turn' : 'already_drew' });
    ack({ ok });
  });
  on('pass', (_, ack) => { const c = ctx(); ack({ ok: !!c && act(c.t, (s) => E.applyPass(s, c.me)) }); });
  on('lateCall', (_, ack) => { const c = ctx(); const ok = !!c && act(c.t, (s) => E.applyLateCall(s, c.me, s.unsafeV)); if (ok) roundStat(c.t, 'calls'); ack({ ok }); });
  on('catch', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const ok = act(c.t, (s) => s.order.includes(c.me) && s.unsafe && s.unsafe !== c.me && E.applyCatch(s, c.me, s.unsafe, s.unsafeV));
    if (ok) roundStat(c.t, 'catches');
    ack({ ok });
  });
  on('skip', (_, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const ok = act(c.t, (s) => {
      const cur = s.order[s.turn];
      if (s.status !== 'playing' || cur === c.me || !s.order.includes(c.me) || Date.now() - (s.turnAt || 0) < IDLE_SKIP_MS) return false;
      return E.applySkipIdle(s, cur);
    });
    if (ok) roundStat(c.t, 'idle_skips');
    ack({ ok });
  });

  // ----- talk -----
  on('react', ({ e }, ack) => {
    const c = ctx(); if (!c || !REACTIONS.includes(e)) return ack({ ok: false });
    io.to(c.t.code).emit('react', { e, by: c.me, code: c.t.code }); track('reaction_sent', { emoji: e }); ack({ ok: true });
  });
  on('chat', ({ text, quick }, ack) => {
    const c = ctx(); if (!c) return ack({ ok: false });
    const msg = cleanText(text);
    if (!msg) return ack({ ok: false });
    const now = Date.now();
    if (now - socket.data.lastChat < 350) return ack({ ok: false, error: 'You’re typing too fast.' });
    socket.data.lastChat = now;
    const m = { id: rid(5), by: c.me, name: c.p.name, text: msg, at: now };
    c.t.chat = (c.t.chat || []).concat(m).slice(-CHAT_KEEP);
    c.t.lastActive = now;
    io.to(c.t.code).emit('chat', { ...m, code: c.t.code });
    if (c.t.observers) for (const sid of c.t.observers) io.to(sid).emit('chat', { ...m, code: c.t.code });
    Accounts.logChat({ ...m, code: c.t.code }).catch(() => {});
    track('chat_sent', { quick_reply: !!quick, between_rounds: c.s.status !== 'playing' });
    markDirty(c.t);
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const ob = socket.data.observing && tables.get(socket.data.observing);
    if (ob && ob.observers) ob.observers.delete(socket.id);
    const at = socket.data.asked && tables.get(socket.data.asked);
    if (at && at.requests) for (const [k, r] of at.requests) { r.sockets.delete(socket.id); if (!r.sockets.size) { at.requests.delete(k); broadcast(at, false); } }
    const c = ctx();
    if (c) { c.p.sockets.delete(socket.id); broadcast(c.t, false); }
  });
});

// ---------- admin alerts ----------
// Each admin picks when to hear about new games: 'start' (a table deals its first round, the default),
// 'open' (someone opens a table) or 'off'. With the app open they get a pop-up; otherwise a phone alert.
const ALERT_KINDS = ['start', 'open', 'off'];
async function adminPref(key) { const v = await Accounts.meta('adminpref:' + key).catch(() => null); return ALERT_KINDS.includes(v) ? v : 'start'; }
function socketsOf(key) { return [...io.sockets.sockets.values()].filter((s) => s.connected && s.data.account && s.data.account.key === key); }
async function alertAdmins(kind, t, by) {
  if (!ADMINS.size) return;
  const names = [...t.players.values()].map((p) => p.name);
  const text = kind === 'open' ? `${by} opened table ${t.code}`
    : `Game started at ${t.code}: ${names.length <= 3 ? names.join(', ') : names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more'}`;
  for (const key of ADMINS) {
    if ([...t.players.values()].some((p) => p.account === key)) continue; // their own table
    if ((await adminPref(key)) !== kind) continue;
    const socks = socketsOf(key);
    if (socks.length) for (const s of socks) s.emit('adminAlert', { code: t.code, kind, text });
    else sendPush(key, { title: kind === 'open' ? 'New table' : 'New game', body: text, tag: 'lc-admin-' + t.code, url: '/#admin' });
  }
}

// ---------- feedback ----------
function deviceOf(socket) {
  const ua = String((socket.handshake && socket.handshake.headers['user-agent']) || '');
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return os + ', ' + br;
}
const fbUser = (t) => ({ id: t.id, kind: t.kind, status: t.status, at: t.at, updated: t.updated, code: t.code, msgs: t.msgs, unread: !!t.unread });
const fbAdmin = (t) => ({ ...fbUser(t), name: t.name, device: t.device, adminUnread: !!t.adminUnread, open: !!(t.code && tables.has(t.code)) });
// the admin hears about new feedback (and replies to it) right away: a pop-up if the app is open, else a phone alert
function alertAdminsFeedback(t, reply) {
  const text = t.msgs[t.msgs.length - 1].text;
  const head = reply ? `${t.name} replied` : t.kind === 'pin' ? `${t.name} forgot their PIN` : `${t.name} sent ${t.kind === 'idea' ? 'an idea' : t.kind === 'problem' ? 'a problem' : 'a message'}`;
  for (const key of ADMINS) {
    const socks = socketsOf(key);
    if (socks.length) for (const s of socks) s.emit('adminFeedback', { id: t.id, kind: t.kind, head, text });
    else sendPush(key, { title: head, body: text.slice(0, 140), tag: 'lc-fb-' + t.id, url: '/#admin' });
  }
}
// the player hears about a reply or a status change the same way
function tellPlayerFeedback(t, text) {
  if (!t.key) return;
  const socks = socketsOf(t.key);
  if (socks.length) for (const s of socks) s.emit('fbUpdate', { id: t.id, kind: t.kind, status: t.status, text });
  else sendPush(t.key, { title: text ? 'The admin replied' : 'Your feedback was updated', body: text ? text.slice(0, 140) : 'Status: ' + t.status, tag: 'lc-fbu-' + t.id, url: '/#feedback' });
}

// admins watching a table that closes go back to their dashboard
function tellObservers(t) { if (t.observers) for (const sid of t.observers) io.to(sid).emit('adminEnded', { code: t.code }); }

// Recently closed tables, so an old link can say what happened instead of "not found".
const closedTables = new Map(); // code -> { at, reason, by, rounds, standings }
const CLOSED_KEEP_MS = 24 * 3600_000;

// Close a table for good: everyone at it sees the standings and goes home.
// reason: 'ended' (someone pressed End game) or 'idle' (nobody played for a while)
function closeTable(t, reason, by) {
  const host = t.players.get(t.s.host) || [...t.players.values()][0];
  trackPlayer(t, host, 'table_closed', { reason, rounds: t.s.round || 0, players: t.players.size, minutes_open: Math.round((Date.now() - (t.created || Date.now())) / 60000) });
  const wins = t.s.wins || {};
  const standings = [...t.players.values()].sort((a, b) => (wins[b.id] || 0) - (wins[a.id] || 0) || a.joined - b.joined)
    .map((p) => ({ name: p.name, wins: wins[p.id] || 0 }));
  const msg = { code: t.code, by: by || null, reason, rounds: t.s.round || 0, midRound: t.s.status === 'playing', standings };
  for (const p of t.players.values()) {
    forget(t, p);
    for (const sid of p.sockets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) { sock.emit('ended', msg); sock.leave(t.code); sock.data.code = null; sock.data.pid = null; }
    }
  }
  tellObservers(t);
  closedTables.set(t.code, { at: Date.now(), reason, by: by || null, rounds: msg.rounds, standings });
  dropHome(t); tables.delete(t.code); markDirty(t);
}

// what an old link can say about a table that has closed
function closedInfo(code) {
  const x = closedTables.get(code); if (!x) return null;
  const top = x.standings[0];
  return { ago: Date.now() - x.at, reason: x.reason, rounds: x.rounds, winner: top && top.wins ? top.name : null, players: x.standings.map((p) => p.name) };
}

// ---------- closing stale tables ----------
// A table closes after IDLE_CLOSE_MS with no moves and no chat, or with nobody online.
// IDLE_WARN_MS before that, everyone still there gets a countdown and a "Keep it open" button.
const IDLE_CLOSE_MS = Number(process.env.IDLE_CLOSE_MS || 10 * 60_000);
const IDLE_WARN_MS = Math.min(2 * 60_000, Math.round(IDLE_CLOSE_MS / 5));
function idleDeadline(t) {
  const anyoneHere = [...t.players.values()].some(isOnline);
  if (anyoneHere) t.emptySince = null; else if (!t.emptySince) t.emptySince = Date.now();
  return Math.min(t.lastActive + IDLE_CLOSE_MS, t.emptySince ? t.emptySince + IDLE_CLOSE_MS : Infinity);
}
function sweepIdle() {
  const now = Date.now();
  for (const t of [...tables.values()]) {
    const closesAt = idleDeadline(t);
    if (now >= closesAt) { closeTable(t, 'idle'); continue; }
    const warn = now >= closesAt - IDLE_WARN_MS;
    if (warn && t.warnedFor !== closesAt) {
      t.warnedFor = closesAt; io.to(t.code).emit('idleWarn', { code: t.code, closesAt, now });
      const online = [...t.players.values()].filter(isOnline);
      for (const p of online) trackPlayer(t, p, 'idle_warning_shown', { players_online: online.length });
    }
    else if (!warn && t.warnedFor) { t.warnedFor = null; io.to(t.code).emit('idleWarn', { code: t.code, closesAt: null }); }
  }
  for (const [code, x] of closedTables) if (now - x.at > CLOSED_KEEP_MS) closedTables.delete(code);
}
setInterval(sweepIdle, Number(process.env.IDLE_SWEEP_MS || 5_000)).unref();

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
  await Accounts.close();
  await Analytics.shutdown();
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const ready = Promise.all([connectStore(), Accounts.init(process.env.STORE_URL || process.env.REDIS_URL)]).then(setupPush).then(() => new Promise((r) => server.listen(PORT, () => { console.log(`Last Card ${BUILD} listening on :${PORT}`); r(); })));
module.exports = { server, io, tables, ready, flush };
