// Player accounts (name + 4-digit PIN) and the all-games leaderboard.
// Kept in a permanent Redis store (STORE_URL, e.g. Upstash). Without one, everything lives in memory.
const crypto = require('crypto');

const SESSION_TTL = 180 * 24 * 3600; // seconds
const LOCK_AFTER = 5;                 // wrong PINs before a name is locked
const LOCK_SECONDS = 600;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,17}$/u;
const ALL = 'all';

let r = null;
const mem = { kv: new Map(), z: new Map() };

const K = {
  acct: (k) => 'lc:acct:' + k,
  sess: (t) => 'lc:sess:' + t,
  fail: (k) => 'lc:fail:' + k,
  wins: (g, w) => `lc:lb:${g}:wins` + (w ? ':' + w : ''),
  played: (g, w) => `lc:lb:${g}:played` + (w ? ':' + w : ''),
  last: 'lc:lb:last',
};
// Weeks start Monday 00:00 UTC (05:30 in India). 1970-01-01 was a Thursday, hence the +3.
const weekId = (t = Date.now()) => 'w' + Math.floor((Math.floor(t / 864e5) + 3) / 7);
const WEEK_TTL = 6 * 7 * 24 * 3600;

const keyOf = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
const cleanName = (name) => String(name || '').trim().replace(/\s+/g, ' ');

async function init(url) {
  if (!url) { console.log('Accounts: no STORE_URL, keeping accounts in memory only.'); return false; }
  // Upstash only accepts TLS: accept a pasted redis:// URL and upgrade it
  if (/^redis:\/\//.test(url) && /\.upstash\.io(:\d+)?(\/|$)/.test(url)) url = 'rediss://' + url.slice('redis://'.length);
  const { createClient } = require('redis');
  const c = createClient({ url, socket: { connectTimeout: 8000, reconnectStrategy: (n) => Math.min(n * 500, 5000) } });
  c.on('error', (e) => console.error('accounts store:', e.message));
  try {
    await Promise.race([c.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 9000))]);
    r = c;
    console.log('Accounts: permanent store connected.');
    return true;
  } catch (e) {
    console.error('Accounts store unavailable, using memory:', e.message);
    return false;
  }
}

// ---- tiny storage layer so the same code runs with or without Redis ----
async function get(k) {
  if (r) { const v = await r.get(k); return v ? JSON.parse(v) : null; }
  const e = mem.kv.get(k); if (!e) return null;
  if (e.exp && e.exp < Date.now()) { mem.kv.delete(k); return null; }
  return e.v;
}
async function set(k, v, { ex, nx } = {}) {
  if (r) {
    const opts = {}; if (ex) opts.EX = ex; if (nx) opts.NX = true;
    return (await r.set(k, JSON.stringify(v), opts)) === 'OK';
  }
  if (nx && (await get(k)) !== null) return false;
  mem.kv.set(k, { v, exp: ex ? Date.now() + ex * 1000 : 0 });
  return true;
}
async function del(k) { if (r) await r.del(k); else mem.kv.delete(k); }
async function incrFail(k) {
  if (r) { const n = await r.incr(k); if (n === 1) await r.expire(k, LOCK_SECONDS); return n; }
  const n = ((await get(k)) || 0) + 1; await set(k, n, { ex: LOCK_SECONDS }); return n;
}
async function zincr(k, member, by) {
  if (r) return r.zIncrBy(k, by, member);
  const z = mem.z.get(k) || new Map(); mem.z.set(k, z); z.set(member, (z.get(member) || 0) + by);
}
async function expire(k, sec) { if (r) await r.expire(k, sec); }
async function hset(k, field, v) {
  if (r) return r.hSet(k, field, String(v));
  const h = (await get(k)) || {}; h[field] = v; await set(k, h);
}
async function hgetall(k) {
  if (r) { const h = await r.hGetAll(k); const o = {}; for (const [a, b] of Object.entries(h)) o[a] = Number(b); return o; }
  return (await get(k)) || {};
}
async function zall(k, limit) {
  if (r) {
    const rows = await r.zRangeWithScores(k, 0, limit - 1, { REV: true });
    return new Map(rows.map((x) => [x.value, x.score]));
  }
  return new Map([...(mem.z.get(k) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }

/**
 * Sign in, or claim a new name. Returns { ok, session, name, created } or { ok:false, error }.
 */
const NAME_ERR = 'Use 2–18 letters or numbers (spaces, dots and dashes are fine).';

/** Free names close to the one asked for, e.g. "John" -> "John R", "John 7", "Johnny". */
async function suggestNames(name, n = 3) {
  const base = name.split(' ')[0].slice(0, 14);
  const letters = 'ABCDEFGHJKLMNPRSTVW';
  const pool = [
    `${base} ${letters[crypto.randomInt(letters.length)]}`, `${base} ${crypto.randomInt(2, 99)}`,
    `${base} ${letters[crypto.randomInt(letters.length)]}`,
    `${base}_${crypto.randomInt(10, 99)}`, `${base} ${crypto.randomInt(100, 999)}`,
  ];
  const out = [];
  for (const c of pool) {
    if (out.length >= n) break;
    if (!NAME_RE.test(c) || out.some((o) => keyOf(o) === keyOf(c))) continue;
    if (!(await get(K.acct(keyOf(c))))) out.push(c);
  }
  return out;
}

/** Live check while someone types: is the name valid, and is it free? */
async function checkName(rawName) {
  const name = cleanName(rawName);
  if (!NAME_RE.test(name)) return { ok: true, valid: false, error: NAME_ERR };
  const key = keyOf(name);
  const acct = await get(K.acct(key));
  if (!acct) return { ok: true, valid: true, available: true, name };
  // a little about the player, so "Welcome back" shows the right person (all of it is on the public leaderboard anyway)
  const wins = await zscore(K.wins(ALL), key), last = (await hgetall(K.last))[key] || null;
  return { ok: true, valid: true, available: false, name: acct.name, wins: Math.round(wins || 0), last, reset: !!acct.reset, suggestions: await suggestNames(acct.name) };
}
async function zscore(k, member) {
  if (r) return (await r.zScore(k, member)) || 0;
  const z = mem.z.get(k); return (z && z.get(member)) || 0;
}

// ---------- feedback: ideas, problems and PIN resets, with admin replies ----------
// lc:fb:<id> holds one thread; lc:fb:all (and lc:fb:u:<account>) list them newest-updated first.
const FB_KEEP = 500;
const FB_KINDS = ['idea', 'problem', 'other', 'pin'];
const FB_STATUS = ['new', 'seen', 'planned', 'fixed', 'wontdo', 'done'];
async function zadd(k, member, score) {
  if (r) return r.zAdd(k, { score, value: member });
  const z = mem.z.get(k) || new Map(); mem.z.set(k, z); z.set(member, score);
}
async function zrem(k, member) { if (r) return r.zRem(k, member); const z = mem.z.get(k); if (z) z.delete(member); }
async function zcard(k) { if (r) return r.zCard(k); const z = mem.z.get(k); return z ? z.size : 0; }
async function fbSave(t) {
  await set('lc:fb:' + t.id, t);
  await zadd('lc:fb:all', t.id, t.updated);
  if (t.key) await zadd('lc:fb:u:' + t.key, t.id, t.updated);
  // what still needs the admin's eye, counted without reading every thread
  if (r) { if (t.adminUnread) await r.sAdd('lc:fb:todo', t.id); else await r.sRem('lc:fb:todo', t.id); }
  else { const s = mem.kv.get('fbtodo') || new Set(); mem.kv.set('fbtodo', s); if (t.adminUnread) s.add(t.id); else s.delete(t.id); }
}
async function fbTodo() { if (r) return r.sCard('lc:fb:todo'); const s = mem.kv.get('fbtodo'); return s ? s.size : 0; }
async function fbCreate({ key, name, kind, text, code, device }) {
  const now = Date.now();
  const t = { id: now.toString(36) + crypto.randomBytes(3).toString('hex'), key: key || null, name, kind: FB_KINDS.includes(kind) ? kind : 'other',
    status: 'new', at: now, updated: now, code: code || null, device: device || null, msgs: [{ from: 'user', text, at: now }], unread: false, adminUnread: true };
  await fbSave(t);
  if ((await zcard('lc:fb:all')) > FB_KEEP) { // drop the oldest
    const old = [...(await zall('lc:fb:all', 100000)).keys()].slice(FB_KEEP);
    for (const id of old) { const o = await get('lc:fb:' + id); await zrem('lc:fb:all', id); if (o && o.key) await zrem('lc:fb:u:' + o.key, id); await del('lc:fb:' + id); if (r) await r.sRem('lc:fb:todo', id); else { const s = mem.kv.get('fbtodo'); if (s) s.delete(id); } }
  }
  return t;
}
async function fbGet(id) { return typeof id === 'string' && /^[a-z0-9]{6,24}$/.test(id) ? get('lc:fb:' + id) : null; }
async function fbList(key, limit = 50) {
  const ids = [...(await zall(key ? 'lc:fb:u:' + key : 'lc:fb:all', limit)).keys()];
  if (!ids.length) return [];
  if (r) return (await r.mGet(ids.map((id) => 'lc:fb:' + id))).map((v) => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } }).filter(Boolean);
  return (await Promise.all(ids.map((id) => get('lc:fb:' + id)))).filter(Boolean);
}
async function fbUpdate(id, fn) {
  const t = await fbGet(id); if (!t) return null;
  if (fn(t) === false) return t;
  t.updated = Date.now(); await fbSave(t);
  return t;
}

// ---------- forgotten PINs ----------
// The admin approves a reset; then the next sign-in with that name picks a new PIN (within a day).
const RESET_MS = 24 * 3600_000;
async function allowPinReset(rawName) {
  const key = keyOf(cleanName(rawName));
  const acct = await get(K.acct(key)); if (!acct) return null;
  acct.reset = Date.now(); await set(K.acct(key), acct);
  return acct.name;
}
async function setNewPin(rawName, pin) {
  const key = keyOf(cleanName(rawName));
  const acct = await get(K.acct(key));
  if (!acct || !acct.reset || Date.now() - acct.reset > RESET_MS) return { ok: false, error: 'This PIN reset has expired. Ask the admin again.' };
  if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, error: 'Your PIN is 4 digits.' };
  acct.salt = crypto.randomBytes(12).toString('hex'); acct.hash = hashPin(pin, acct.salt); delete acct.reset;
  await set(K.acct(key), acct); await del(K.fail(key));
  const session = crypto.randomBytes(24).toString('hex');
  await set(K.sess(session), key, { ex: SESSION_TTL });
  return { ok: true, session, key, name: acct.name, created: false, newPin: true, since: acct.created || 0 };
}

/**
 * mode 'new': claim a name that nobody has (names are unique, ignoring case and extra spaces).
 * mode 'back': sign in to an existing name with its PIN.
 * Returns { ok, session, key, name, created } or { ok:false, error, taken?, notFound?, suggestions? }.
 */
async function login(rawName, pin, mode) {
  const name = cleanName(rawName);
  if (!NAME_RE.test(name)) return { ok: false, error: NAME_ERR };
  if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, error: 'Your PIN is 4 digits.' };
  const key = keyOf(name);
  const fails = (await get(K.fail(key))) || 0;
  if (fails >= LOCK_AFTER) return { ok: false, error: `Too many wrong PINs for ${name}. Try again in 10 minutes.` };
  let acct = await get(K.acct(key));
  let created = false;
  if (mode === 'new') {
    if (acct) return { ok: false, taken: true, error: `“${acct.name}” is already taken. Pick a different name.`, suggestions: await suggestNames(acct.name) };
    const salt = crypto.randomBytes(12).toString('hex');
    const fresh = { name, salt, hash: hashPin(pin, salt), created: Date.now() };
    if (!(await set(K.acct(key), fresh, { nx: true }))) // someone claimed it a moment ago
      return { ok: false, taken: true, error: `“${name}” was just taken. Pick a different name.`, suggestions: await suggestNames(name) };
    acct = fresh; created = true;
  } else if (!acct) {
    return { ok: false, notFound: true, error: `No player called “${name}” yet.` };
  }
  if (!created) {
    const ok = crypto.timingSafeEqual(Buffer.from(hashPin(pin, acct.salt), 'hex'), Buffer.from(acct.hash, 'hex'));
    if (!ok) {
      const n = await incrFail(K.fail(key));
      const left = LOCK_AFTER - n;
      return { ok: false, error: left > 0 ? `Wrong PIN for ${acct.name}. ${left} ${left === 1 ? 'try' : 'tries'} left.` : `Too many wrong PINs for ${acct.name}. Try again in 10 minutes.` };
    }
    await del(K.fail(key));
  }
  const session = crypto.randomBytes(24).toString('hex');
  await set(K.sess(session), key, { ex: SESSION_TTL });
  return { ok: true, session, key, name: acct.name, created, since: acct.created || Date.now() };
}

async function fromSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const key = await get(K.sess(token));
  if (!key) return null;
  const acct = await get(K.acct(key));
  return acct ? { key, name: acct.name, since: acct.created || 0 } : null;
}
async function logout(token) { if (typeof token === 'string' && /^[a-f0-9]{48}$/.test(token)) await del(K.sess(token)); }

/** One finished game: the winner gets a win, everyone who played gets a game played. */
async function recordResult(game, winnerKey, playerKeys) {
  const ps = [...new Set(playerKeys.filter(Boolean))];
  if (ps.length < 2) return false;
  const w = weekId();
  for (const g of [game, ALL]) {
    for (const wk of [null, w]) {
      if (winnerKey) await zincr(K.wins(g, wk), winnerKey, 1);
      for (const p of ps) await zincr(K.played(g, wk), p, 1);
      if (wk) { await expire(K.wins(g, wk), WEEK_TTL); await expire(K.played(g, wk), WEEK_TTL); }
    }
  }
  const now = Date.now();
  for (const p of ps) await hset(K.last, p, now);
  return true;
}

/** Ranked rows for one game ('all' = every game) and period ('week' | 'all'), plus your own row wherever you are. */
async function leaderboard(game, limit = 50, period = 'all', mineKey = null) {
  const g = game || ALL;
  const wk = period === 'week' ? weekId() : null;
  const [wins, played, last] = await Promise.all([zall(K.wins(g, wk), 500), zall(K.played(g, wk), 500), hgetall(K.last)]);
  const keys = [...new Set([...played.keys(), ...wins.keys()])];
  const rows = await Promise.all(keys.map(async (k) => {
    const a = await get(K.acct(k));
    const w = wins.get(k) || 0, p = Math.max(played.get(k) || 0, w);
    return { key: k, name: a ? a.name : k, wins: w, played: p, last: last[k] || null };
  }));
  rows.sort((a, b) => b.wins - a.wins || (b.wins / (b.played || 1)) - (a.wins / (a.played || 1)) || b.played - a.played || a.name.localeCompare(b.name));
  rows.forEach((x, i) => { x.rank = i + 1; });
  const mine = mineKey ? rows.find((x) => x.key === mineKey) || null : null;
  const out = rows.slice(0, limit);
  out.mine = mine;
  return out;
}

// ---------- turn alerts: push subscriptions per account, and the server's VAPID keys ----------
const PUSH_TTL = 180 * 24 * 3600;
const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
async function savePush(acctKey, sub) {
  if (!acctKey || !sub || !sub.endpoint) return false;
  const k = 'lc:push:' + acctKey, f = hashOf(sub.endpoint), v = JSON.stringify(sub);
  if (r) { await r.hSet(k, f, v); await r.expire(k, PUSH_TTL); }
  else { const m = mem.kv.get(k) || {}; m[f] = v; mem.kv.set(k, m); }
  return true;
}
async function pushSubs(acctKey) {
  const k = 'lc:push:' + acctKey;
  const all = r ? await r.hGetAll(k) : mem.kv.get(k) || {};
  return Object.values(all).map((v) => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
}
async function dropPush(acctKey, endpoint) {
  const k = 'lc:push:' + acctKey;
  if (r) await r.hDel(k, hashOf(endpoint)); else { const m = mem.kv.get(k); if (m) delete m[hashOf(endpoint)]; }
}
async function meta(key, make) {
  const k = 'lc:meta:' + key;
  let v = r ? await r.get(k) : mem.kv.get(k);
  if (!v && make) { v = JSON.stringify(make()); if (r) await r.set(k, v, { NX: true }); else mem.kv.set(k, v); v = r ? await r.get(k) : v; }
  return v ? JSON.parse(v) : null;
}
async function setMeta(key, val) {
  const k = 'lc:meta:' + key, v = JSON.stringify(val);
  if (r) await r.set(k, v); else mem.kv.set(k, v);
}

// ---------- recent table chat for the admin screen ----------
// The last 300 messages from every table, kept 14 days, so admins can spot problems and feature asks
// even after a table has closed.
const CHAT_LOG = 'lc:chatlog', CHAT_LOG_MAX = 300, CHAT_LOG_DAYS = 14;
const memChat = [];
async function logChat(m) {
  const v = JSON.stringify({ code: m.code, name: m.name, text: m.text, at: m.at });
  if (r) { await r.lPush(CHAT_LOG, v); await r.lTrim(CHAT_LOG, 0, CHAT_LOG_MAX - 1); await r.expire(CHAT_LOG, CHAT_LOG_DAYS * 86400); }
  else { memChat.unshift(v); memChat.length = Math.min(memChat.length, CHAT_LOG_MAX); }
}
async function chatLog(n = 80) {
  const list = r ? await r.lRange(CHAT_LOG, 0, n - 1) : memChat.slice(0, n);
  const cutoff = Date.now() - CHAT_LOG_DAYS * 86400e3;
  return list.map((v) => { try { return JSON.parse(v); } catch (e) { return null; } }).filter((m) => m && m.at > cutoff);
}

// ---------- usage counters for the admin screen ----------
// Counters per day (India time by default, STATS_TZ_MIN to change) (rounds, deals, signups, practice) plus a set of who played each day.
const TZ_MIN = Number(process.env.STATS_TZ_MIN || 330);
const dayId = (t = Date.now()) => new Date(t + TZ_MIN * 60000).toISOString().slice(0, 10);
const lastDays = (n) => Array.from({ length: n }, (_, i) => dayId(Date.now() - (n - 1 - i) * 864e5));
const STAT_TTL = 120 * 24 * 3600;
async function bumpStat(name, by = 1) {
  const k = 'lc:stat:' + name, d = dayId();
  if (r) { await r.hIncrBy(k, d, by); await r.hIncrBy(k, 'all', by); return; }
  const m = mem.kv.get(k) || {}; m[d] = (m[d] || 0) + by; m.all = (m.all || 0) + by; mem.kv.set(k, m);
}
async function markActive(acctKey) {
  if (!acctKey) return;
  const k = 'lc:stat:active:' + dayId();
  if (r) { await r.sAdd(k, acctKey); await r.expire(k, STAT_TTL); return; }
  const s = mem.kv.get(k) || new Set(); s.add(acctKey); mem.kv.set(k, s);
}
async function stats() {
  const days = lastDays(7), today = days[6], out = { days };
  for (const name of ['rounds', 'deals', 'signups', 'practice']) {
    const all = r ? await r.hGetAll('lc:stat:' + name) : mem.kv.get('lc:stat:' + name) || {};
    const per = days.map((d) => Number(all[d] || 0));
    out[name] = { today: per[6], week: per.reduce((a, b) => a + b, 0), all: Number(all.all || 0), per };
  }
  const sets = days.map((d) => 'lc:stat:active:' + d);
  if (r) {
    out.active = { today: await r.sCard(sets[6]), week: (await r.sUnion(sets)).length };
    out.players = await r.zCard(K.played('all'));
  } else {
    const u = new Set(); sets.forEach((k) => (mem.kv.get(k) || new Set()).forEach((x) => u.add(x)));
    out.active = { today: (mem.kv.get(sets[6]) || new Set()).size, week: u.size };
    out.players = (mem.z.get(K.played('all')) || new Map()).size;
  }
  out.today = today;
  return out;
}

const persistent = () => !!r;
async function close() { if (r) { try { await r.quit(); } catch (e) {} } }

module.exports = { init, login, checkName, fromSession, logout, recordResult, leaderboard, keyOf, persistent, close, savePush, pushSubs, dropPush, meta, setMeta, logChat, chatLog, allowPinReset, setNewPin, fbCreate, fbGet, fbList, fbUpdate, fbTodo, FB_STATUS, bumpStat, markActive, stats, GAMES: { lastcard: 'Last Card' } };
