// Plays full games through the real server with simulated phones.
process.env.PORT = 3999;
process.env.RATE_LIMIT = 100000;
const { server, tables, ready } = require('../server.js');
const { io } = require('socket.io-client');
const E = require('../public/engine.js');
const URL = 'http://localhost:3999';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);

function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), state: null };
  s.on('state', (v) => { p.state = v; if (v.hand && Object.keys(v).includes('hands')) throw new Error('leaked hands'); });
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); r(); }));
  return p;
}

(async () => {
  await ready;
  const names = ['Ravi', 'Priya', 'Arjun', 'Meera', 'Zoya'];
  const phones = names.map(phone);
  await Promise.all(phones.map((p) => p.ready));
  const c = await phones[0].call('create', { name: 'Ravi' });
  for (const p of phones.slice(1)) { const r = await p.call('join', { code: c.code, name: p.name }); if (!r.ok) throw new Error('join ' + r.error); }
  const bad = await phones[1].call('join', { code: 'ZZZZ', name: 'x' });
  console.log('table', c.code, 'bad join msg:', bad.error);
  const ns = await phones[2].call('setting', { key: 'drawUntil' }); if (ns.ok) throw new Error('non-host changed setting');
  await phones[0].call('setting', { key: 'drawUntil' });
  // chat
  let heard = null; phones[3].s.on('chat', (m) => { heard = m; });
  await phones[1].call('chat', { text: '  hello <b>table</b>  ' }); await sleep(30);
  console.log('chat delivered:', JSON.stringify(heard && heard.text));
  let rounds = 0, moves = 0, catches = 0;
  while (rounds < 25) {
    if (rounds === 0) { const no = await phones[1].call('start'); if (no.ok) throw new Error('non-host started'); console.log('non-host start blocked:', no.error); }
    const st = await phones[0].call('start');
    if (!st.ok) throw new Error('start failed');
    await sleep(30);
    let guard = 0;
    while (phones[0].state.status === 'playing' && guard++ < 3000) {
      const v0 = phones[0].state;
      // privacy check: nobody's view has another player's cards
      for (const p of phones) if (p.state.hand.length !== p.state.counts[p.state.me]) throw new Error('hand/count mismatch');
      if (v0.unsafe && Math.random() < 0.4) {
        const catcher = phones.find((p) => p.state.me !== v0.unsafe);
        const r = await catcher.call('catch'); if (r.ok) catches++; await sleep(5); continue;
      }
      const cur = phones.find((p) => p.state.me === v0.order[v0.turn]);
      const v = cur.state; const R = { discard: [v.top], color: v.color, pending: v.pending };
      const ok = v.hand.map((c, i) => i).filter((i) => (!v.drew || i === v.hand.length - 1) && E.canPlay(v.hand[i], R));
      let r;
      if (ok.length) { const i = ok[Math.floor(Math.random() * ok.length)]; r = await cur.call('play', { i, color: 'rygb'[moves % 4], called: Math.random() < .6 }); }
      else if (v.drew) r = await cur.call('pass');
      else r = await cur.call('draw');
      if (!r.ok) throw new Error('move refused ' + JSON.stringify(r));
      // out-of-turn move must be refused
      const ts = tables.get(c.code).s; const other = phones.find((p) => p.state.me !== ts.order[ts.turn] && ts.order.includes(p.state.me));
      const rr = await other.call('play', { i: 0, color: 'r' }); if (rr.ok && ts.status==='playing') throw new Error('out of turn accepted');
      moves++;
      await sleep(2);
    }
    const t = tables.get(c.code).s;
    const tot = t.deck.length + t.discard.length + Object.values(t.hands).reduce((a, h) => a + h.length, 0);
    if (tot !== 108) throw new Error('card total ' + tot);
    rounds++;
  }
  console.log({ rounds, moves, catches, wins: phones[0].state.wins });
  // reconnect keeps the seat
  const p = phones[3]; const me = p.state.me; p.s.disconnect(); await sleep(50);
  console.log('offline shown:', phones[0].state.players.find((x) => x.id === me).online === false);
  const back = io(URL, { transports: ['websocket'], forceNew: true });
  const r = await new Promise((res) => back.on('connect', () => back.emit('hello', { token: p.token }, res)));
  console.log('rejoined same table:', r.code === c.code);
  // host goes offline: someone else can take over
  const claimEarly = await phones[2].call('claimHost'); console.log('claim while host online blocked:', !claimEarly.ok);
  // remove a player mid-round
  await phones[0].call('start'); await sleep(30);
  const victim = phones[4].state.me;
  await phones[0].call('remove', { id: victim }); await sleep(30);
  console.log('removed from order:', !phones[0].state.order.includes(victim), 'players now', phones[0].state.players.length);
  // static files
  const html = await (await fetch(URL + '/')).text();
  const eng = await (await fetch(URL + '/engine.js')).status;
  const trav = await (await fetch(URL + '/../server.js')).status;
  console.log('index ok:', html.includes('<title>Last Card</title>'), 'engine:', eng, 'traversal:', trav);
  back.close(); phones.forEach((p) => p.s.close()); server.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
