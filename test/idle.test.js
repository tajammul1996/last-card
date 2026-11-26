// Idle tables: a warning before closing, "Keep it open" resets it, then the table closes with reason 'idle'.
process.env.PORT = 3996;
process.env.RATE_LIMIT = 100000;
process.env.IDLE_CLOSE_MS = 3000;
process.env.IDLE_SWEEP_MS = 100;
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3996';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), ev: [] };
  for (const e of ['idleWarn', 'ended']) s.on(e, (m) => p.ev.push([e, m]));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); await p.call('login', { name, pin: '1234', mode: 'new' }); r(); }));
  return p;
}
(async () => {
  await ready;
  const [a, b] = ['Ana', 'Ben'].map(phone);
  await Promise.all([a.ready, b.ready]);
  const { code } = await a.call('create');
  await b.call('join', { code });

  await sleep(2600);
  const w = a.ev.find(([e, m]) => e === 'idleWarn' && m.closesAt);
  assert(w && w[1].code === code, 'warned before closing');
  assert(!a.ev.some(([e]) => e === 'ended'), 'not closed yet');
  await b.call('keepOpen');
  await sleep(100);
  assert(a.ev.some(([e, m]) => e === 'idleWarn' && m.closesAt === null && m.by === 'Ben'), 'keep open clears the warning for everyone');

  await sleep(2000);
  assert(!a.ev.some(([e]) => e === 'ended'), 'keep open bought more time');
  await a.call('chat', { text: 'still here' }); // chatting counts as activity too
  await sleep(2000);
  assert(!a.ev.some(([e]) => e === 'ended'), 'chat bought more time');

  await sleep(1500);
  const end = a.ev.find(([e]) => e === 'ended');
  assert(end && end[1].reason === 'idle' && end[1].code === code && end[1].standings.length === 2, 'closed as idle with standings');
  assert(b.ev.some(([e]) => e === 'ended'), 'everyone told');
  assert(!(await b.call('join', { code })).ok, 'closed table cannot be joined');

  // nobody online: closes even though it was just active
  const { code: c2 } = await a.call('create');
  a.s.disconnect(); b.s.disconnect();
  await sleep(3400);
  const c = phone('Cal'); await c.ready;
  assert(!(await c.call('join', { code: c2 })).ok, 'empty table closed');

  console.log('idle: warning, keep open, chat counts, closes as idle, empty tables close: ok');
  c.s.close();
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
