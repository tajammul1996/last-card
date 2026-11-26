// Feedback threads (send, admin sees, seen/replied/status, player replies) and forgotten-PIN resets.
process.env.PORT = 3995;
process.env.RATE_LIMIT = 100000;
process.env.ADMIN_NAMES = 'Boss';
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3995';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name, pin = '1234', mode = 'new') {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), ev: [] };
  for (const e of ['adminFeedback', 'fbUpdate']) s.on(e, (m) => p.ev.push([e, m]));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); p.login = name ? await p.call('login', { name, pin, mode }) : null; r(); }));
  return p;
}
const got = (p, e) => p.ev.filter(([x]) => x === e).map(([, m]) => m);
(async () => {
  await ready;
  const [boss, ana] = ['Boss', 'Ana'].map((n) => phone(n));
  await Promise.all([boss.ready, ana.ready]);

  // send
  assert(!(await ana.call('fbSend', { kind: 'idea', text: ' ' })).ok, 'empty refused');
  const { code } = await ana.call('create');
  const sent = await ana.call('fbSend', { kind: 'idea', text: 'Can we have a turn timer setting?' });
  assert(sent.ok && sent.item.status === 'new' && sent.item.code === code, 'sent with table code');
  await sleep(60);
  const al = got(boss, 'adminFeedback')[0];
  assert(al && al.id === sent.item.id && /Ana sent an idea/.test(al.head), 'admin hears it');
  assert((await boss.call('adminOverview')).fbTodo === 1, 'inbox count');
  assert(!(await ana.call('adminFb')).ok, 'players cannot read the inbox');

  // admin opens: player sees Seen
  const list = await boss.call('adminFb');
  assert(list.ok && list.items[0].name === 'Ana' && list.items[0].open === true && list.items[0].device, 'admin list with name, open table, device');
  const op = await boss.call('adminFbOpen', { id: sent.item.id });
  assert(op.ok && op.item.status === 'seen', 'opening marks seen');
  await sleep(60);
  assert(got(ana, 'fbUpdate').some((m) => m.status === 'seen' && !m.text), 'player told it was seen');
  assert((await boss.call('adminOverview')).fbTodo === 0, 'nothing left to read');

  // reply + status
  const rp = await boss.call('adminFbReply', { id: sent.item.id, text: 'Good call, coming this week.', status: 'planned' });
  assert(rp.ok && rp.item.status === 'planned', 'reply and status');
  await sleep(60);
  assert(got(ana, 'fbUpdate').some((m) => m.text === 'Good call, coming this week.' && m.status === 'planned'), 'player gets the reply');
  let mine = await ana.call('fbMine');
  assert(mine.unread === 1 && mine.items[0].msgs.some((m) => m.from === 'admin') && mine.items[0].msgs.some((m) => m.from === 'status' && m.text === 'planned'), 'thread shows reply and status change');
  await ana.call('fbRead', { id: sent.item.id });
  mine = await ana.call('fbMine');
  assert(mine.unread === 0, 'read');

  // player replies back
  const back = await ana.call('fbReply', { id: sent.item.id, text: 'Thanks!' });
  assert(back.ok, 'player reply');
  await sleep(60);
  assert(got(boss, 'adminFeedback').some((m) => /Ana replied/.test(m.head)), 'admin hears the reply');
  assert(!(await boss.call('fbReply', { id: sent.item.id, text: 'not mine' })).ok, 'only the sender replies as the player');

  // forgotten PIN
  const guest = phone(null); await guest.ready;
  assert(!(await guest.call('forgotPin', { name: 'Nobody Here' })).ok, 'unknown name');
  assert((await guest.call('forgotPin', { name: 'ana' })).ok, 'reset asked');
  await sleep(60);
  const pinAl = got(boss, 'adminFeedback').find((m) => m.kind === 'pin');
  assert(pinAl && /Ana forgot their PIN/.test(pinAl.head), 'admin hears the PIN request');
  assert((await guest.call('checkName', { name: 'Ana' })).reset === false, 'not reset until the admin says so');
  assert((await boss.call('adminFbPin', { id: pinAl.id })).ok, 'admin allows a new PIN');
  const ck = await guest.call('checkName', { name: 'Ana' });
  assert(ck.reset === true && ck.wins === 0, 'name check shows the reset');
  const nl = await guest.call('login', { name: 'Ana', pin: '9876', mode: 'reset' });
  assert(nl.ok && nl.newPin, 'new PIN saved and signed in ' + JSON.stringify(nl));
  const again = phone('Ana', '9876', 'back'); await again.ready;
  assert(again.login.ok, 'new PIN works');
  const old = phone('Ana', '1234', 'back'); await old.ready;
  assert(!old.login.ok, 'old PIN no longer works');
  assert(!(await guest.call('login', { name: 'Ana', pin: '1111', mode: 'reset' })).ok, 'reset only works once');

  console.log('feedback: send, admin alert, seen, reply + status, unread, player reply · PIN reset: ok');
  for (const p of [boss, ana, guest, again, old]) p.s.close();
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
