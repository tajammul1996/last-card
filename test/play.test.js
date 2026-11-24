// Plays full games through the real server with simulated phones, plus sign-in, link switching and the leaderboard.
process.env.PORT = 3999;
process.env.RATE_LIMIT = 100000;
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, tables, ready } = require('../server.js');
const { io } = require('socket.io-client');
const E = require('../public/engine.js');
const URL = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };

function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), state: null, states: [] };
  s.on('state', (v) => { p.state = v; p.states.push(v.code); assert(!('hands' in v), 'leaked hands'); });
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); r(); }));
  return p;
}

(async () => {
  await ready;
  const names = ['Ravi', 'Priya', 'Arjun', 'Meera', 'Zoya'];
  const phones = names.map(phone);
  await Promise.all(phones.map((p) => p.ready));

  // ---- accounts ----
  const noAcct = await phones[0].call('create');
  assert(noAcct.needLogin, 'create without sign-in should ask to sign in');
  for (const p of phones) { const r = await p.call('login', { name: p.name, pin: '1234' }); assert(r.ok && r.created, 'login ' + r.error); p.session = r.session; }
  const thief = phone('Thief'); await thief.ready;
  let bad; for (let i = 0; i < 5; i++) bad = await thief.call('login', { name: 'ravi', pin: '9999' });
  const locked = await thief.call('login', { name: 'Ravi', pin: '1234' });
  console.log('wrong PIN rejected:', bad.ok === false, '| locked after 5 tries:', /Too many/.test(locked.error));
  const weird = await thief.call('login', { name: '<b>', pin: '12' });
  console.log('bad name/PIN rejected:', weird.ok === false);
  thief.s.close();

  // ---- table + invite peek ----
  const c = await phones[0].call('create');
  const peek = await phones[1].call('open', { code: c.code });
  console.log('invite peek:', JSON.stringify({ seated: peek.seated, host: peek.info.host, players: peek.info.players }));
  for (const p of phones.slice(1)) { const r = await p.call('join', { code: c.code }); assert(r.ok, 'join ' + r.error); }
  const ns = await phones[2].call('setting', { key: 'drawUntil' }); assert(!ns.ok, 'non-host changed setting');
  const no = await phones[1].call('start'); assert(!no.ok, 'non-host started');

  // ---- play rounds ----
  let rounds = 0, moves = 0;
  while (rounds < 15) {
    assert((await phones[0].call('start')).ok, 'start failed');
    await sleep(30);
    let guard = 0;
    while (phones[0].state.status === 'playing' && guard++ < 3000) {
      const v0 = phones[0].state;
      if (v0.unsafe && Math.random() < 0.4) { await phones.find((p) => p.state.me !== v0.unsafe).call('catch'); await sleep(3); continue; }
      const cur = phones.find((p) => p.state.me === v0.order[v0.turn]);
      const v = cur.state; const R = { discard: [v.top], color: v.color, pending: v.pending };
      const ok = v.hand.map((x, i) => i).filter((i) => (!v.drew || i === v.hand.length - 1) && E.canPlay(v.hand[i], R));
      let r;
      if (ok.length) r = await cur.call('play', { i: ok[Math.floor(Math.random() * ok.length)], color: 'rygb'[moves % 4], called: Math.random() < 0.6 });
      else if (v.drew) r = await cur.call('pass');
      else r = await cur.call('draw');
      assert(r.ok, 'move refused ' + JSON.stringify(r));
      moves++; await sleep(2);
    }
    rounds++;
  }
  await sleep(100);
  const lb = await phones[0].call('leaderboard', { game: 'all' });
  const totalWins = lb.rows.reduce((a, x) => a + x.wins, 0);
  console.log('rounds', rounds, '| leaderboard wins add up:', totalWins === rounds, '| everyone has', lb.rows.map((x) => x.played).join(','), 'games');
  const lc = await phones[0].call('leaderboard', { game: 'lastcard' });
  console.log('Last Card tab matches all-games tab:', JSON.stringify(lc.rows) === JSON.stringify(lb.rows));

  // ---- opening a new link while seated in a running game ----
  await phones[0].call('start'); await sleep(30);
  const zoya = phones[4];
  const other = phone('Kabir'); await other.ready;
  await other.call('login', { name: 'Kabir', pin: '4321' });
  const t2 = await other.call('create');
  const open2 = await zoya.call('open', { code: t2.code });
  console.log('new link shows invite (not seated):', open2.exists && !open2.seated);
  const j2 = await zoya.call('join', { code: t2.code });
  await sleep(50);
  zoya.states = [];
  await phones[0].call('chat', { text: 'still here?' });
  await phones[1].call('react', { e: '😂' });
  // make a move at table 1 and check Zoya does not hear it
  const v0 = phones[0].state; const cur = phones.slice(0, 4).find((p) => p.state.me === v0.order[v0.turn]);
  if (cur) await cur.call('draw'); else await phones[0].call('chat', { text: 'your turn Zoya' });
  await sleep(80);
  console.log('joined new table:', j2.ok, '| no updates from old table:', zoya.states.every((code) => code === t2.code));
  console.log('old seat kept (game running):', tables.get(c.code).s.order.includes(phones[0].state.order.find((id) => tables.get(c.code).players.get(id)?.account === 'zoya')));
  const back = await zoya.call('open', { code: c.code });
  console.log('old link puts her straight back in her seat:', back.seated === true);

  // ---- same account on a second phone gets the same seat ----
  const ravi2 = phone('Ravi'); await ravi2.ready;
  await ravi2.call('hello', { token: ravi2.token, session: phones[0].session });
  const o3 = await ravi2.call('open', { code: c.code }); await sleep(50);
  console.log('second phone, same account, same seat:', o3.seated && ravi2.state.me === phones[0].state.me);

  // ---- static ----
  const html = await (await fetch(URL + '/')).text();
  const trav = (await fetch(URL + '/../server.js')).status;
  console.log('index ok:', html.includes('<title>Last Card</title>'), '| traversal blocked:', trav === 404);
  [...phones, other, ravi2].forEach((p) => p.s.close()); server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
