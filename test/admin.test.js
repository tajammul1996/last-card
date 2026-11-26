// Admin page: only named accounts get it, the overview counts what's live, and watching is silent.
process.env.PORT = 3997;
process.env.RATE_LIMIT = 100000;
process.env.ADMIN_NAMES = 'Boss';
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3997';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), state: null, admin: null, ev: [] };
  s.on('state', (v) => { p.state = v; });
  s.on('adminState', (m) => { p.admin = m; });
  for (const e of ['adminEnded', 'chat', 'adminAlert']) s.on(e, (m) => p.ev.push([e, m]));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); p.login = await p.call('login', { name, pin: '1234', mode: 'new' }); r(); }));
  return p;
}
(async () => {
  await ready;
  const [boss, ana, ben] = ['Boss', 'Ana', 'Ben'].map(phone);
  await Promise.all([boss, ana, ben].map((p) => p.ready));
  assert(boss.login.admin === true && ana.login.admin === false, 'only Boss is an admin');
  assert(!(await ana.call('adminOverview')).ok, 'a player cannot open the admin page');

  const pref = await boss.call('adminPref', {});
  assert(pref.ok && pref.alerts === 'start', 'alerts default to game starts');
  assert(!(await ana.call('adminPref', { alerts: 'open' })).ok, 'players cannot set admin alerts');
  const { code } = await ana.call('create'); await sleep(50);
  assert(!boss.ev.some(([e]) => e === 'adminAlert'), 'no alert for opening a table by default');
  await ben.call('join', { code });
  await ana.call('start'); await sleep(50);
  const al = boss.ev.find(([e]) => e === 'adminAlert');
  assert(al && al[1].code === code && al[1].kind === 'start' && /Ana/.test(al[1].text), 'admin hears a game started');
  boss.s.emit('practiceStat', {}, () => {});
  await sleep(50);

  const o = await boss.call('adminOverview');
  assert(o.ok, 'overview');
  assert(o.live.playing === 1 && o.live.atTables === 2, 'one game, two people at tables');
  assert(o.live.online === 3, 'three signed in');
  const t = o.tables.find((x) => x.code === code);
  assert(t && t.status === 'playing' && t.players.length === 2 && t.players.some((p) => p.turn), 'table row with whose turn it is');
  assert(t.players.every((p) => p.cards === 7), 'card counts');
  assert(o.stats.signups.today === 3 && o.stats.deals.today === 1 && o.stats.practice.today === 1, 'usage counts');
  assert(o.stats.active.today === 3, 'active today');
  assert(o.server && o.server.sockets >= 3, 'server info');

  // watch silently
  assert(!(await ana.call('adminWatch', { code })).ok, 'players cannot watch as admin');
  const w = await boss.call('adminWatch', { code });
  assert(w.ok && w.view.admin && w.view.code === code && w.view.hand.length === 0, 'admin view, no hand');
  assert(w.view.me === null || w.view.me === undefined, 'admin is not a player');
  assert(w.view.players.length === 2, 'admin is not in the player list');
  const curId = ana.state.order[ana.state.turn];
  const cur = curId === ana.state.me ? ana : ben;
  const v0 = boss.admin ? boss.admin.view.v : w.view.v;
  await cur.call('draw'); await sleep(80);
  assert(boss.admin && boss.admin.code === code && boss.admin.view.v > v0, 'admin sees moves live');
  assert(boss.admin.view.hand.length === 0, 'still no hand');
  assert(ana.state.players.length === 2, 'players never see the admin');
  assert(!(await boss.call('draw')).ok, 'admin cannot play');
  await ana.call('chat', { text: 'hi' }); await sleep(50);
  assert(!boss.ev.some(([e]) => e === 'chat'), 'admin is not in the chat room');
  const o2 = await boss.call('adminOverview');
  assert(o2.tables[0].observers === 1, 'overview knows someone is watching');

  // stop watching, then the table closing tells a watching admin
  await boss.call('adminUnwatch');
  const before = boss.admin.view.v;
  await cur.call('pass'); await ana.call('react', { e: '👍' }); await sleep(80);
  assert(boss.admin.view.v === before, 'no updates after unwatch');
  await boss.call('adminWatch', { code });
  await ana.call('endGame'); await sleep(80);
  assert(boss.ev.some(([e, m]) => e === 'adminEnded' && m.code === code), 'admin told the table ended');
  const o3 = await boss.call('adminOverview');
  assert(!o3.tables.some((x) => x.code === code), 'ended table gone');

  // switch to "a table opens"
  assert((await boss.call('adminPref', { alerts: 'open' })).alerts === 'open', 'alert setting saved');
  const n0 = boss.ev.filter(([e]) => e === 'adminAlert').length;
  const { code: c2 } = await ben.call('create'); await sleep(50);
  const a2 = boss.ev.filter(([e]) => e === 'adminAlert');
  assert(a2.length === n0 + 1 && a2[a2.length - 1][1].kind === 'open' && a2[a2.length - 1][1].code === c2, 'admin hears a table opened');
  await boss.call('adminPref', { alerts: 'off' });
  await ana.call('create'); await sleep(50);
  assert(boss.ev.filter(([e]) => e === 'adminAlert').length === n0 + 1, 'off means no alerts');
  console.log('admin alerts: game starts, table opens, off: ok');
  console.log('admin: access, overview, usage counts, silent watch, unwatch, table closed: ok');
  for (const p of [boss, ana, ben]) p.s.close();
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
