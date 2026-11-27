// Usernames (3+ characters, no spaces; older names keep working), playing with just a username,
// adding an email with a code, and signing in on another phone by username or email.
process.env.PORT = 3992;
process.env.RATE_LIMIT = 100000;
process.env.EMAIL_TEST = '1';
delete process.env.REDIS_URL; delete process.env.STORE_URL;
const { server, ready } = require('../server.js');
const Mailer = require('../mailer');
const { io } = require('socket.io-client');
const URL = 'http://localhost:3992';
const tok = () => Math.random().toString(36).slice(2).padEnd(12, 'x') + Math.random().toString(36).slice(2, 10);
const assert = (c, m) => { if (!c) throw new Error(m); };
function phone() {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  const p = { s, token: tok() };
  p.call = (ev, d) => new Promise((r) => s.emit(ev, d || {}, r));
  p.ready = new Promise((r) => s.on('connect', async () => { p.hello = await p.call('hello', { token: p.token }); r(); }));
  return p;
}
const lastCode = (to) => Mailer.outbox.filter((m) => m.to === to).slice(-1)[0].code;
(async () => {
  await ready;
  const a = phone(), b = phone(), c = phone();
  await Promise.all([a.ready, b.ready, c.ready]);
  assert(a.hello.emailOn === true, 'email switched on in test mode');

  // username rules
  let r = await a.call('checkName', { name: 'sam k' });
  assert(!r.valid && /No spaces/.test(r.error) && r.fix === 'sam_k', 'spaces refused with a fix: ' + JSON.stringify(r));
  assert(!(await a.call('checkName', { name: 'al' })).valid, 'too short');
  assert((await a.call('checkName', { name: 'sam_k' })).available, 'sam_k free');
  assert(!(await a.call('login', { name: 'sam k', mode: 'guest' })).ok, 'guest refuses spaces');

  // play with just a username
  r = await a.call('login', { name: 'sam_k', mode: 'guest' });
  assert(r.ok && r.created && r.protect === 'none' && r.slug === 'sam_k', 'username-only account: ' + JSON.stringify(r));
  assert((await a.call('create')).ok, 'can open a table straight away');
  r = await b.call('checkName', { name: 'SAM_K' });
  assert(!r.available && r.protect === 'none', 'taken, unprotected');
  assert(!(await b.call('login', { name: 'sam_k', mode: 'guest' })).ok, 'cannot claim a taken username');
  assert(!(await b.call('login', { name: 'sam_k', pin: '1234', mode: 'back' })).ok, 'no PIN sign-in for an unprotected username');

  // add an email
  assert(!(await b.call('emailStart', { purpose: 'add', who: 'x@y.co' })).ok, 'adding needs sign-in');
  r = await a.call('emailStart', { purpose: 'add', who: 'Sam@Example.com' });
  assert(r.ok && r.to === 's•••m@example.com', 'code sent to masked address: ' + JSON.stringify(r));
  const wrong = await a.call('emailVerify', { id: r.id, code: '000000' === lastCode('sam@example.com') ? '111111' : '000000' });
  assert(!wrong.ok && /tries left/.test(wrong.error), 'wrong code counted');
  const ok = await a.call('emailVerify', { id: r.id, code: lastCode('sam@example.com') });
  assert(ok.ok && ok.added && ok.protect === 'email', 'email added');
  assert(!(await a.call('emailVerify', { id: r.id, code: lastCode('sam@example.com') })).ok, 'a code works once');
  assert((await b.call('checkName', { name: 'sam_k' })).protect === 'email', 'now protected by email');

  // sign in on another phone, by username and by email
  r = await b.call('emailStart', { purpose: 'signin', who: '@sam_k' });
  assert(r.ok && r.to === 's•••m@example.com', 'sign-in code by username');
  let si = await b.call('emailVerify', { id: r.id, code: lastCode('sam@example.com') });
  assert(si.ok && si.session && si.name === 'sam_k' && si.protect === 'email', 'signed in by code');
  r = await c.call('emailStart', { purpose: 'signin', who: 'SAM@example.com ' });
  si = await c.call('emailVerify', { id: r.id, code: lastCode('sam@example.com') });
  assert(si.ok && si.name === 'sam_k', 'signed in by email address');
  assert(!(await c.call('emailStart', { purpose: 'signin', who: 'nobody@example.com' })).ok, 'unknown email');

  // one email, one username
  const d = phone(); await d.ready;
  await d.call('login', { name: 'dee', mode: 'guest' });
  assert(!(await d.call('emailStart', { purpose: 'add', who: 'sam@example.com' })).ok, 'email already used');

  // older names with spaces and PINs keep working; PIN fallback for username-only accounts
  const e = phone(); await e.ready;
  // made the old way (the server still accepts the old 'new' mode for names that fit the new rule, and older names exist already)
  assert((await e.call('setPin', { pin: '1234' })).needLogin, 'setPin needs sign-in');
  await e.call('login', { name: 'pinny', mode: 'guest' });
  assert((await e.call('setPin', { pin: '4321' })).ok, 'pick a PIN instead of email');
  assert(!(await e.call('setPin', { pin: '1111' })).ok, 'only once');
  const f = phone(); await f.ready;
  assert((await f.call('login', { name: 'pinny', pin: '4321', mode: 'back' })).ok, 'sign in with that PIN');

  // too many codes
  for (let i = 0; i < 3; i++) await b.call('emailStart', { purpose: 'signin', who: 'sam_k' });
  assert(!(await b.call('emailStart', { purpose: 'signin', who: 'sam_k' })).ok, 'code sending is limited');

  console.log('email: username rules, username-only play, add email, code sign-in by name or email, one email per name, PIN fallback, limits: ok');
  process.exit(0);
})().catch((err) => { console.error('email test FAILED:', err.message); process.exit(1); });
