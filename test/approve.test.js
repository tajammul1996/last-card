// Host approval for joiners, watching mid-round, and the turn-alert endpoints.
process.env.PORT = 3998;
process.env.RATE_LIMIT = 100000;
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3998';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), state: null, ev: [] };
  s.on('state', (v) => { p.state = v; });
  for (const e of ['admitted', 'declined', 'joinRequest']) s.on(e, (m) => p.ev.push([e, m]));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); await p.call('login', { name, pin: '1234', mode: 'new' }); r(); }));
  return p;
}
(async () => {
  await ready;
  const [host, ana, ben, cal] = ['Hosta', 'Ana', 'Ben', 'Cal'].map(phone);
  await Promise.all([host, ana, ben, cal].map((p) => p.ready));
  const { code } = await host.call('create');
  assert((await host.call('setting', { key: 'approve' })).ok, 'turn on approval');
  await sleep(50);
  assert(host.state.settings.approve === true, 'approve setting on');
  const peek = await ana.call('open', { code });
  assert(peek.info.approve === true, 'invite page knows approval is on');

  // Ana asks, host lets her in
  const a1 = await ana.call('join', { code });
  assert(!a1.ok && a1.waiting && a1.host === 'Hosta', 'join waits for the host');
  await sleep(50);
  assert(host.ev.some(([e]) => e === 'joinRequest'), 'host is told');
  assert(host.state.requests.length === 1 && host.state.requests[0].name === 'Ana', 'host sees the request');
  const key = host.state.requests[0].key;
  assert((await host.call('admit', { key, allow: true })).ok, 'admit');
  await sleep(50);
  assert(ana.ev.some(([e]) => e === 'admitted'), 'Ana hears she can come in');
  const a2 = await ana.call('join', { code });
  assert(a2.ok, 'Ana joins after being let in'); await sleep(50);
  assert(host.state.requests.length === 0 && host.state.players.length === 2, 'request cleared, Ana seated');

  // Ben asks, host says no; a non-host can't decide
  const b1 = await ben.call('join', { code });
  assert(b1.waiting, 'Ben waits');
  await sleep(50);
  const bkey = host.state.requests[0].key;
  const notHost = await ana.call('admit', { key: bkey, allow: true });
  assert(!notHost.ok, 'only the host decides');
  await host.call('admit', { key: bkey, allow: false });
  await sleep(50);
  assert(ben.ev.some(([e]) => e === 'declined'), 'Ben hears no');
  const b2 = await ben.call('join', { code });
  assert(b2.waiting, 'saying no once does not let him in later');
  await ben.call('cancelJoin', { code }); await sleep(50);
  assert(host.state.requests.length === 0, 'cancel clears the request');

  // approval off: Cal joins mid-round and watches
  await host.call('setting', { key: 'approve' });
  await host.call('start'); await sleep(50);
  const c1 = await cal.call('join', { code });
  assert(c1.ok, 'join without approval');
  await sleep(50);
  assert(cal.state.status === 'playing' && !cal.state.order.includes(cal.state.me) && cal.state.hand.length === 0, 'Cal watches, no cards');
  assert(host.state.players.some((p) => p.name === 'Cal') && !host.state.order.includes(cal.state.me), 'players see a watcher');

  // turn alerts: the app can get the public key and save a subscription
  const v = await ana.call('vapid');
  assert(v.ok && typeof v.key === 'string' && v.key.length > 40, 'vapid key');
  const sub = await ana.call('pushSub', { sub: { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } } });
  assert(sub.ok, 'subscription saved');

  console.log('approval: waits, host sees it, let in, said no, cancel: ok');
  console.log('watching mid-round: ok · turn alerts endpoints: ok');
  for (const p of [host, ana, ben, cal]) p.s.close();
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
