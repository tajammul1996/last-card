// Starts the server with Redis, plays, restarts it (like a Render deploy) and checks the game survived.
const { spawn, execSync } = require('child_process');
const { io } = require('socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4111, URL = 'http://localhost:' + PORT;
const env = { ...process.env, PORT, REDIS_URL: 'redis://127.0.0.1:6390', STORE_URL: 'redis://127.0.0.1:6391', RATE_LIMIT: 1000 };
const start = () => new Promise((res) => {
  const p = spawn('node', ['server.js'], { env, cwd: __dirname + '/..' });
  p.stdout.on('data', (d) => { const s = String(d); process.stdout.write('  [server] ' + s); if (s.includes('listening')) res(p); });
  p.stderr.on('data', (d) => process.stdout.write('  [server!] ' + d));
});
function phone(token) {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnectionDelay: 200 });
  const p = { s, token, state: null, hellos: 0, chat: [], session: null, code: null };
  s.on('state', (v) => { p.state = v; });
  s.on('chatHistory', (h) => { p.chat = h.list; });
  // like the real page: say hello with the saved session, then reopen the table from the link
  s.on('connect', () => s.emit('hello', { token, session: p.session }, (r) => { p.hellos++; p.last = r; if (p.code) s.emit('open', { code: p.code }, () => {}); }));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  return p;
}
(async () => {
  execSync('redis-server --port 6390 --daemonize yes --save "" --appendonly no');
  execSync('redis-server --port 6391 --daemonize yes --save "" --appendonly no');
  await sleep(300); execSync('redis-cli -p 6390 flushall'); execSync('redis-cli -p 6391 flushall');
  let srv = await start();
  const a = phone('aaaaaaaaaaaaaaaaaaaa1'), b = phone('bbbbbbbbbbbbbbbbbbbb2');
  await sleep(300);
  a.session = (await a.call('login', { name: 'Ravi', pin: '1111', mode: 'new' })).session;
  b.session = (await b.call('login', { name: 'Priya', pin: '2222', mode: 'new' })).session;
  const { code } = await a.call('create');
  await b.call('join', { code });
  a.code = b.code = code;
  await a.call('chat', { text: 'before restart' });
  await a.call('start'); await sleep(100);
  const before = { round: a.state.round, hand: a.state.hand.join(','), top: a.state.top, v: a.state.v, host: a.state.host };
  srv.kill('SIGTERM'); await new Promise((r) => srv.on('exit', r));
  console.log('server stopped; keys in store:', execSync('redis-cli -p 6390 keys "lc:t:*"').toString().trim());
  srv = await start();
  await sleep(1500); // phones reconnect on their own
  const after = { round: a.state.round, hand: a.state.hand.join(','), top: a.state.top, v: a.state.v, host: a.state.host };
  console.log('same game after restart:', JSON.stringify(before) === JSON.stringify(after), 'reconnected hellos:', a.hellos, b.hellos);
  console.log('chat kept:', a.chat.map((m) => m.text));
  const cur = a.state.order[a.state.turn] === a.state.me ? a : b;
  const r = await cur.call('draw'); console.log('can keep playing:', r.ok);
  // finish the round so a win is recorded, restart again, and check accounts + leaderboard survived
  const E = require('../public/engine.js');
  for (let i = 0; i < 4000 && a.state.status === 'playing'; i++) {
    const p = a.state.order[a.state.turn] === a.state.me ? a : b; const v = p.state;
    const R = { discard: [v.top], color: v.color, pending: v.pending };
    const ok = v.hand.map((x, j) => j).filter((j) => (!v.drew || j === v.hand.length - 1) && E.canPlay(v.hand[j], R));
    if (ok.length) await p.call('play', { i: ok[0], color: 'r', called: true }); else if (v.drew) await p.call('pass'); else await p.call('draw');
  }
  await sleep(200);
  srv.kill('SIGTERM'); await new Promise((r) => srv.on('exit', r));
  srv = await start(); await sleep(1500);
  const lb = await a.call('leaderboard', { game: 'all' });
  console.log('leaderboard kept after restart:', JSON.stringify(lb.rows.map((x) => [x.name, x.wins, x.played])));
  const relog = await a.call('login', { name: 'ravi', pin: '1111', mode: 'back' });
  console.log('account kept after restart (sign in again works):', relog.ok && !relog.created);
  // host offline -> other player can take over
  a.s.close(); await sleep(200);
  const c = await b.call('claimHost'); console.log('claim host when host offline:', c.ok, 'host now Priya:', b.state.host === b.state.me);
  b.s.close(); srv.kill('SIGTERM'); await sleep(300);
  execSync('redis-cli -p 6390 shutdown nosave || true'); execSync('redis-cli -p 6391 shutdown nosave || true');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
