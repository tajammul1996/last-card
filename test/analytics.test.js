// Analytics: the right events fire with the shared properties, nothing private is sent, admins are skipped.
process.env.PORT = 3994;
process.env.RATE_LIMIT = 100000;
process.env.ADMIN_NAMES = 'Boss';
process.env.POSTHOG_KEY = 'phc_test';
process.env.ANALYTICS_MEMORY = '1';
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const Analytics = require('../analytics');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3994';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true, extraHeaders: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } });
  const p = { s, name, token: tok(), state: null };
  s.on('state', (v) => { p.state = v; });
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { p.hello = await p.call('hello', { token: p.token, installed: true }); if (name) p.login = await p.call('login', { name, pin: '1234', mode: 'new', known: 1 }); r(); }));
  return p;
}
const ev = (name, who) => Analytics.memory.filter((e) => e.event === name && (!who || e.distinctId === who));
(async () => {
  await ready;
  const [ana, ben, boss] = ['Ana', 'Ben', 'Boss'].map(phone);
  await Promise.all([ana.ready, ben.ready, boss.ready]);

  assert(ana.hello.analytics && ana.hello.analytics.key === 'phc_test' && /^dev_[0-9a-f]{16}$/.test(ana.hello.analytics.deviceId), 'phone gets the key and its device id');
  const si = ev('signed_in', 'ana')[0];
  assert(si && si.properties.method === 'new' && si.properties.known_on_device === 1 && si.properties.platform === 'iphone' && si.properties.installed === true && si.properties.new_player === true, 'signed_in with shared props');
  assert(Analytics.memory.some((e) => e.event === '$create_alias' && e.distinctId === 'ana' && e.properties.alias === ana.hello.analytics.deviceId), 'device linked to account');
  assert(!Analytics.memory.some((e) => e.distinctId === 'boss'), 'admins are never counted');

  const wrong = phone(null); await wrong.ready;
  await wrong.call('login', { name: 'Ana', pin: '9999', mode: 'back' });
  const failed = ev('signin_failed').find((e) => e.distinctId.startsWith('dev_'));
  assert(failed && failed.properties.reason === 'wrong_pin', 'failed sign-in by device with a reason');

  const { code } = await ana.call('create', { from: 'home', hadInvite: false });
  assert(ev('table_created', 'ana')[0].properties.table_code === code, 'table_created');
  await ben.call('open', { code, via: 'link' });
  const op = ev('invite_opened', 'ben')[0];
  assert(op && op.properties.table_exists && op.properties.via === 'link' && op.properties.table_status === 'lobby', 'invite_opened');
  await ben.call('join', { code, via: 'link' });
  assert(ev('table_joined', 'ben')[0].properties.via === 'link', 'table_joined');

  await ana.call('chat', { text: 'my secret plan 1234' });
  await ben.call('chat', { text: 'Your turn! ⏰', quick: true });
  const chats = ev('chat_sent');
  assert(chats.length === 2 && chats.some((e) => e.properties.quick_reply === true), 'chat_sent, quick flagged');

  await ana.call('start'); await sleep(50);
  assert(ev('round_started').length === 2, 'round_started per player');
  // play the round out: whoever's turn draws and passes, until someone can play out
  for (let n = 0; n < 400 && ana.state.status === 'playing'; n++) {
    const cur = ana.state.order[ana.state.turn] === ana.state.me ? ana : ben;
    const s = cur.state, top = s.top;
    const i = s.hand.findIndex((x) => x[0] === s.color || x[1] === top[1] || x[0] === 'w');
    const r = i >= 0 && !s.pending ? await cur.call('play', { i, color: 'r', called: s.hand.length === 2 }) : { ok: false };
    if (!r.ok) { await cur.call('draw'); await cur.call('pass'); }
    await sleep(5);
  }
  await sleep(50);
  const fin = ev('round_finished');
  assert(fin.length === 2 && fin.filter((e) => e.properties.won).length === 1 && fin[0].properties.plays > 0 && fin[0].properties.seconds >= 0, 'round_finished per player with stats');

  // not your turn
  ana.state.status === 'over' && await ana.call('start'); await sleep(30);
  const notMe = ana.state.order[ana.state.turn] === ana.state.me ? ben : ana;
  await notMe.call('play', { i: 0, color: 'r' });
  assert(ev('action_refused').some((e) => e.properties.error === 'not_your_turn'), 'action_refused with a reason');

  await ben.call('leave');
  assert(ev('player_left', 'ben')[0].properties.when === 'mid_round', 'player_left mid-round');
  await ana.call('fbSend', { kind: 'idea', text: 'please add a timer' });
  assert(ev('feedback_sent', 'ana')[0].properties.kind === 'idea', 'feedback_sent');
  await ana.call('endGame');
  assert(ev('table_closed')[0].properties.reason === 'ended', 'table_closed');

  // nothing private ever leaves
  const all = JSON.stringify(Analytics.memory);
  for (const secret of ['my secret plan', 'please add a timer', '1234"', ana.token, ana.login.session]) assert(!all.includes(secret), 'leaked: ' + secret);

  console.log(`analytics: ${new Set(Analytics.memory.map((e) => e.event)).size} event types, shared props, device linking, admins skipped, nothing private sent: ok`);
  for (const p of [ana, ben, boss, wrong]) p.s.close();
  server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
