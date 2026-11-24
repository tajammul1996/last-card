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
  wins: (g) => `lc:lb:${g}:wins`,
  played: (g) => `lc:lb:${g}:played`,
};

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
async function login(rawName, pin) {
  const name = cleanName(rawName);
  if (!NAME_RE.test(name)) return { ok: false, error: 'Use 2–18 letters or numbers for your name.' };
  if (!/^\d{4}$/.test(String(pin || ''))) return { ok: false, error: 'Your PIN is 4 digits.' };
  const key = keyOf(name);
  const fails = (await get(K.fail(key))) || 0;
  if (fails >= LOCK_AFTER) return { ok: false, error: `Too many wrong PINs for ${name}. Try again in 10 minutes.` };
  let acct = await get(K.acct(key));
  let created = false;
  if (!acct) {
    const salt = crypto.randomBytes(12).toString('hex');
    const fresh = { name, salt, hash: hashPin(pin, salt), created: Date.now() };
    if (await set(K.acct(key), fresh, { nx: true })) { acct = fresh; created = true; }
    else acct = await get(K.acct(key)); // someone claimed it a moment ago
  }
  if (!created) {
    const ok = crypto.timingSafeEqual(Buffer.from(hashPin(pin, acct.salt), 'hex'), Buffer.from(acct.hash, 'hex'));
    if (!ok) {
      const n = await incrFail(K.fail(key));
      const left = LOCK_AFTER - n;
      return { ok: false, error: left > 0 ? `That name is taken and the PIN doesn’t match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : `Too many wrong PINs for ${acct.name}. Try again in 10 minutes.` };
    }
    await del(K.fail(key));
  }
  const session = crypto.randomBytes(24).toString('hex');
  await set(K.sess(session), key, { ex: SESSION_TTL });
  return { ok: true, session, key, name: acct.name, created };
}

async function fromSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const key = await get(K.sess(token));
  if (!key) return null;
  const acct = await get(K.acct(key));
  return acct ? { key, name: acct.name } : null;
}
async function logout(token) { if (typeof token === 'string' && /^[a-f0-9]{48}$/.test(token)) await del(K.sess(token)); }

/** One finished game: the winner gets a win, everyone who played gets a game played. */
async function recordResult(game, winnerKey, playerKeys) {
  const ps = [...new Set(playerKeys.filter(Boolean))];
  if (ps.length < 2) return false;
  for (const g of [game, ALL]) {
    if (winnerKey) await zincr(K.wins(g), winnerKey, 1);
    for (const p of ps) await zincr(K.played(g), p, 1);
  }
  return true;
}

async function leaderboard(game, limit = 50) {
  const g = game || ALL;
  const [wins, played] = await Promise.all([zall(K.wins(g), 500), zall(K.played(g), 500)]);
  const keys = [...new Set([...played.keys(), ...wins.keys()])];
  const rows = await Promise.all(keys.map(async (k) => {
    const a = await get(K.acct(k));
    const w = wins.get(k) || 0, p = Math.max(played.get(k) || 0, w);
    return { key: k, name: a ? a.name : k, wins: w, played: p };
  }));
  rows.sort((a, b) => b.wins - a.wins || (b.wins / (b.played || 1)) - (a.wins / (a.played || 1)) || b.played - a.played || a.name.localeCompare(b.name));
  return rows.slice(0, limit);
}

const persistent = () => !!r;
async function close() { if (r) { try { await r.quit(); } catch (e) {} } }

module.exports = { init, login, fromSession, logout, recordResult, leaderboard, keyOf, persistent, close, GAMES: { lastcard: 'Last Card' } };
