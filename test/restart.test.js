// Starts the server with Redis, plays, restarts it (like a Render deploy) and checks the game survived.
const { spawn, execSync } = require('child_process');
const { io } = require('socket.io-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 4111, URL = 'http://localhost:' + PORT;
const env = { ...process.env, PORT, REDIS_URL: 'redis://127.0.0.1:6390', RATE_LIMIT: 1000 };
const start = () => new Promise((res) => {
  const p = spawn('node', ['server.js'], { env, cwd: __dirname + '/..' });
  p.stdout.on('data', (d) => { const s = String(d); process.stdout.write('  [server] ' + s); if (s.includes('listening')) res(p); });
  p.stderr.on('data', (d) => process.stdout.write('  [server!] ' + d));
});
function phone(token) {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnectionDelay: 200 });
  const p = { s, token, state: null, hellos: 0, chat: [] };
  s.on('state', (v) => { p.state = v; });
  s.on('chatHistory', (h) => { p.chat = h; });
  s.on('connect', () => s.emit('hello', { token }, (r) => { p.hellos++; p.last = r; }));
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  return p;
}
(async () => {
  execSync('redis-server --port 6390 --daemonize yes --save "" --appendonly no');
  await sleep(300); execSync('redis-cli -p 6390 flushall');
  let srv = await start();
  const a = phone('aaaaaaaaaaaaaaaaaaaa1'), b = phone('bbbbbbbbbbbbbbbbbbbb2');
  await sleep(300);
  const { code } = await a.call('create', { name: 'Ravi' });
  await b.call('join', { code, name: 'Priya' });
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
  // host offline -> other player can take over
  a.s.close(); await sleep(200);
  const c = await b.call('claimHost'); console.log('claim host when host offline:', c.ok, 'host now Priya:', b.state.host === b.state.me);
  b.s.close(); srv.kill('SIGTERM'); await sleep(300);
  execSync('redis-cli -p 6390 shutdown nosave || true');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
