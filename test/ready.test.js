// Ready-up between rounds: two players in starts a short countdown, everyone in deals almost at once,
// stepping back cancels, and nobody needs the host.
process.env.PORT = 3991;
process.env.RATE_LIMIT = 100000;
process.env.READY_DEAL_MS = '600';
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { ready } = require('../server.js');
const E = require('../public/engine.js');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3991';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok() };
  s.on('state', (v) => { p.view = v; });
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); await p.call('login', { name, mode: 'guest' }); r(); }));
  return p;
}
async function playOut(ps) {
  const by = Object.fromEntries(ps.map((p) => [p.name, p]));
  for (let i = 0; i < 5000; i++) {
    const v = ps[0].view; if (!v || v.status !== 'playing') return;
    const name = v.players.find((x) => x.id === v.order[v.turn]).name, p = by[name], w = p.view;
    const R = { discard: [w.top], color: w.color, pending: w.pending };
    const ok = w.hand.map((_, k) => k).filter((k) => (!w.drew || k === w.hand.length - 1) && E.canPlay(w.hand[k], R));
    if (ok.length) await p.call('play', { i: ok[0], color: 'g', called: true }); else if (w.drew) await p.call('pass'); else await p.call('draw');
    await sleep(1);
  }
}
(async () => {
  await ready;
  const [a, b, c] = [phone('host_a'), phone('bee'), phone('cee')];
  await Promise.all([a.ready, b.ready, c.ready]);
  const { code } = await a.call('create');
  await b.call('join', { code }); await c.call('join', { code });
  await a.call('start'); await sleep(50);
  await playOut([a, b, c]); await sleep(50);
  assert(a.view.status === 'over' && a.view.round === 1, 'round 1 over');

  // one in: nothing yet; two in (not the host): countdown; one steps back: cancelled
  assert(!(await a.call('ready', { on: true }).then(() => null)), '');
  await sleep(30); assert(a.view.ready.length === 1 && !a.view.dealAt, 'one in, no countdown');
  await a.call('ready', { on: false }); await sleep(30);
  await b.call('ready', { on: true }); await c.call('ready', { on: true }); await sleep(30);
  assert(b.view.ready.length === 2 && b.view.dealAt > Date.now(), 'two in (host not needed): countdown');
  await c.call('ready', { on: false }); await sleep(30);
  assert(!b.view.dealAt, 'stepping back cancels');
  await sleep(700); assert(a.view.status === 'over', 'still waiting');
  await c.call('ready', { on: true }); await sleep(800);
  assert(a.view.status === 'playing' && a.view.round === 2 && a.view.ready.length === 0, 'dealt itself after the countdown');

  // everyone in: deals almost at once
  await playOut([a, b, c]); await sleep(50);
  const t0 = Date.now();
  for (const p of [a, b, c]) await p.call('ready', { on: true });
  while (a.view.status !== 'playing' && Date.now() - t0 < 3000) await sleep(20);
  assert(a.view.status === 'playing' && a.view.round === 3, 'everyone in deals quickly');
  assert(!(await a.call('ready', { on: true })).ok, 'no ready-up mid-round');
  console.log('ready-up: countdown at two, cancel, deals itself, quick when everyone is in, no host needed: ok');
  process.exit(0);
})().catch((e) => { console.error('ready test FAILED:', e.message); process.exit(1); });
