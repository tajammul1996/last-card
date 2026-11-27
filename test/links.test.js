// One table, one link: your own table is reused, /t/<name> finds it, people looking show up live,
// knocking and pinging reach the right person, and the link page carries a preview.
process.env.PORT = 3993;
process.env.RATE_LIMIT = 100000;
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const { io } = require('socket.io-client');
const http = require('http');
const URL = 'http://localhost:3993';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone(name) {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, name, token: tok(), ev: [] };
  for (const e of ['presence', 'knock', 'pinged']) s.on(e, (m) => p.ev.push([e, m]));
  s.on('state', (v) => { p.view = v; });
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { await p.call('hello', { token: p.token }); p.login = name ? await p.call('login', { name, pin: '1234', mode: 'new' }) : null; r(); }));
  return p;
}
const got = (p, e) => p.ev.filter(([x]) => x === e).map(([, m]) => m);
const get = (path) => new Promise((res) => http.get(URL + path, { headers: { host: 'saylastcard.com' } }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b, type: r.headers['content-type'] })); }));
(async () => {
  await ready;
  const [taj, ravi, ana, anon] = [phone('Tajammul'), phone('Ravi K'), phone('ana_b'), phone(null)];
  await Promise.all([taj.ready, ravi.ready, ana.ready, anon.ready]);
  assert(taj.login.slug === 'tajammul' && ravi.login.slug === 'ravi-k', 'slugs: ' + taj.login.slug + ' ' + ravi.login.slug);

  // closed: the link says whose it is, and knocking reaches them
  const closed = await anon.call('openHome', { slug: 'tajammul' });
  assert(closed.ok && !closed.exists && closed.host.name === 'Tajammul' && closed.host.online, 'closed link knows the owner');
  assert((await anon.call('openHome', { slug: 'nobody-here' })).unknown, 'unknown link');
  assert((await anon.call('knock', { slug: 'tajammul' })).ok, 'knock'); await sleep(50);
  assert(got(taj, 'knock').length === 1, 'host hears the knock');
  assert((await anon.call('knock', { slug: 'tajammul' })).again, 'knock is not repeated within 2 minutes');

  // your table: made once, reused while it's open
  const c1 = await taj.call('create');
  const c2 = await taj.call('create');
  assert(c1.ok && c2.ok && c1.code === c2.code && c2.again, 'create reuses your own table');
  const own = await taj.call('openHome', { slug: 'tajammul' });
  assert(own.exists && own.seated && own.code === c1.code, 'your own link sits you back down');

  // a friend opens the link: the host sees them looking, then joining
  const look = await ravi.call('openHome', { slug: 'TAJAMMUL' });
  assert(look.exists && !look.seated && look.info.host === 'Tajammul' && look.host.name === 'Tajammul', 'friend sees the table');
  await sleep(50);
  const lk = got(taj, 'presence').find((m) => m.type === 'looking');
  assert(lk && lk.name === 'Ravi K', 'host sees who opened the link');
  assert((await ravi.call('join', { code: c1.code })).ok, 'friend joins');
  // legacy names with spaces work through their dashed link
  assert((await anon.call('openHome', { slug: 'ravi-k' })).host.name === 'Ravi K', 'dashed link for a name with a space');

  // play one round so they count as "played with", then ping
  assert((await ana.call('join', { code: c1.code })).ok, 'third player');
  assert((await taj.call('start')).ok, 'deal');
  const E = require('../public/engine.js');
  const players = { [taj.name]: taj, [ravi.name]: ravi, [ana.name]: ana };
  const views = new Proxy({}, { get: (_, n) => (players[n] || {}).view });
  await sleep(100);
  for (let i = 0; i < 4000; i++) {
    const v = views.Tajammul; if (!v || v.status !== 'playing') break;
    const turnId = v.order[v.turn]; const name = v.players.find((x) => x.id === turnId).name; const p = players[name]; const w = views[name];
    if (!w) { await sleep(5); continue; }
    const R = { discard: [w.top], color: w.color, pending: w.pending };
    const ok = w.hand.map((_, k) => k).filter((k) => (!w.drew || k === w.hand.length - 1) && E.canPlay(w.hand[k], R));
    if (ok.length) await p.call('play', { i: ok[0], color: 'r', called: true }); else if (w.drew) await p.call('pass'); else await p.call('draw');
    await sleep(2);
  }
  assert(views.Tajammul.status === 'over', 'round finished');
  await sleep(100);
  const ms = await ana.call('mates');
  assert(ms.ok && ms.list.map((m) => m.name).sort().join() === 'Ravi K,Tajammul', 'played-with list: ' + JSON.stringify(ms.list));
  assert(!(await anon.call('ping', { key: 'tajammul' })).ok, 'signed-out phones cannot ping');
  const stranger = phone('zed'); await stranger.ready;
  assert(!(await stranger.call('ping', { key: 'tajammul' })).ok, 'strangers cannot ping');
  assert((await ana.call('ping', { key: 'tajammul' })).ok, 'ping a mate'); await sleep(50);
  const pg = got(taj, 'pinged')[0];
  assert(pg && pg.name === 'ana_b' && pg.slug === 'ana_b', 'mate hears the ping with a link back');

  // the link page carries a preview naming the player; the QR code only draws our own links
  const page = await get('/t/tajammul');
  assert(page.status === 200 && /og:title" content="Tajammul’s Last Card table"/.test(page.body) && /<title>Tajammul’s Last Card table<\/title>/.test(page.body) && /og:image" content="https:\/\/saylastcard.com\/og.png"/.test(page.body), 'preview tags');
  const plain = await get('/'); assert(/og:title" content="Last Card"/.test(plain.body), 'home page keeps the plain preview');
  const qr = await get('/qr.svg?u=' + encodeURIComponent('https://saylastcard.com/t/tajammul'));
  assert(qr.status === 200 && /svg/.test(qr.type) && /<svg/.test(qr.body), 'QR for our link');
  assert((await get('/qr.svg?u=' + encodeURIComponent('https://evil.example/x'))).status === 400, 'no QR for other sites');

  // when the table closes, the link goes back to "not open"
  await taj.call('endGame').catch(() => {});
  for (const p of [taj, ravi, ana]) await p.call('leave').catch(() => {});
  await sleep(100);
  const after = await anon.call('openHome', { slug: 'tajammul' });
  console.log('links: own table reused, /t/ link, looking, knock, played-with + ping, preview, QR' + (after.exists ? ' (table still open after leaving)' : ', closes cleanly') + ': ok');
  process.exit(0);
})().catch((e) => { console.error('links test FAILED:', e.message); process.exit(1); });
