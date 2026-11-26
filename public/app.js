/* Last Card phone + desktop client. Talks to server.js over Socket.IO; rules come from engine.js. */
(function () {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  share: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  trophy: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffc94a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 6h3v2a3 3 0 0 1-3 3M7 6H4v2a3 3 0 0 0 3 3"/></svg>',
};
const IDLE_SKIP_S = 45;
const isWide = () => matchMedia('(min-width:1024px)').matches;

/* ---------- identity ---------- */
let token = load('lc-token');
if (!/^[a-zA-Z0-9]{16,64}$/.test(token)) { token = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''); store('lc-token', token); }
let session = load('lc-session'), me = null, build = null, last = null, ready = false;

/* ---------- view state ---------- */
let admData = null, admTimer = null, admTab = 'tables', adminWatching = null; // admin (see below)
let view = 'home', curCode = null, G = null, boardFrom = 'home', boardGame = 'all', boardPeriod = 'week';
let armedCall = false, seenV = -1, lastTopV = -1, pendingWild = null, scrollToPlayable = false;
let chatMsgs = [], unread = 0, afterSignIn = null, recorded = null;
// offline the Socket.IO script may be missing: a stand-in keeps the app (and practice) working
const socket = typeof io === 'function' ? io({ transports: ['websocket', 'polling'] }) : { connected: false, on() {}, emit() {}, timeout() { return this; } };

/* ---------- sound (made in the browser, no files) ---------- */
const Snd = {
  ctx: null, on: load('lc-sound') !== 'off',
  unlock() { if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } } if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); },
  tone(f, at, dur, type, vol) {
    const c = this.ctx, t = c.currentTime + at, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(f, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.1, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.05);
  },
  play(name) {
    if (!this.on) return; this.unlock(); if (!this.ctx || this.ctx.state !== 'running') return;
    try {
      if (name === 'turn') { this.tone(659.25, 0, 0.55, 'sine', 0.07); this.tone(987.77, 0.14, 0.8, 'sine', 0.055); }
      else if (name === 'chat') { this.tone(1046.5, 0, 0.12, 'sine', 0.05); this.tone(1318.5, 0.06, 0.14, 'sine', 0.04); }
      else if (name === 'nudge') { this.tone(880, 0, 0.18, 'triangle', 0.08); this.tone(880, 0.22, 0.18, 'triangle', 0.08); }
      else if (name === 'win') { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.12, 0.3, 'triangle', 0.14)); [523.25, 659.25, 783.99, 1046.5].forEach((f) => this.tone(f, 0.55, 1.3, 'triangle', 0.08)); this.tone(1318.5, 0.55, 1.3, 'sine', 0.05); }
      else if (name === 'flick') { this.tone(1900, 0, 0.05, 'triangle', 0.035); }
      else if (name === 'skip') { this.tone(196, 0, 0.2, 'sine', 0.13); this.tone(131, 0.05, 0.25, 'sine', 0.09); }
      else if (name === 'reverse') { [440, 587.33, 783.99].forEach((f, i) => this.tone(f, i * 0.07, 0.22, 'sine', 0.05)); }
      else if (name === 'wild') { [1046.5, 1318.5, 1568, 2093].forEach((f, i) => this.tone(f, i * 0.05, 0.35, 'sine', 0.032)); }
      else if (name === 'thud') { this.tone(82, 0, 0.4, 'sine', 0.2); this.tone(130, 0, 0.16, 'triangle', 0.07); }
      else if (name === 'roundover') { [783.99, 987.77, 1174.66].forEach((f, i) => this.tone(f, i * 0.11, 0.45, 'triangle', 0.09)); }
    } catch (e) {}
  },
};
document.addEventListener('pointerdown', () => Snd.unlock(), { passive: true });
function confetti(n) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cols = ['var(--red)', 'var(--yellow)', 'var(--green)', 'var(--blue)', 'var(--gold)'];
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div'); d.className = 'confetti';
    d.style.left = Math.random() * 100 + 'vw'; d.style.background = cols[i % cols.length];
    d.style.animationDuration = 1.8 + Math.random() * 1.8 + 's'; d.style.animationDelay = Math.random() * 0.6 + 's';
    document.body.appendChild(d); setTimeout(() => d.remove(), 4500);
  }
}
function buzz() { try { navigator.vibrate && navigator.vibrate(60); } catch (e) {} }

/* ---------- small renderers ---------- */
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; }
function avatarFor(key, name, opts) {
  opts = opts || {};
  const dot = opts.online === undefined ? '' : `<i class="dot ${opts.online ? 'on' : ''}"></i>`;
  const bot = opts.bot ? '<i class="botb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/></svg></i>' : '';
  return `<span class="av ${opts.size || ''}" style="background:hsl(${hue(key || name)} 45% 38%)" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase() || '?')}${dot}${bot}</span>`;
}
function playerOf(u) { return G && G.players.find((p) => p.id === u); }
function nameOf(u) { const p = playerOf(u); return p ? p.name : (G && G.gone && G.gone[u]) || 'Player'; }
function isOnline(u) { const p = playerOf(u); return !!(p && p.online); }
function isHost() { return !!G && G.host === G.me; }
function av(u, size, withDot) { const p = playerOf(u); return avatarFor(nameOf(u).toLowerCase(), nameOf(u), { size, online: withDot && !(p && p.bot) ? isOnline(u) : undefined, bot: !!(p && p.bot) }); }
function fmt(msg) {
  const meId = G && G.me, Y = '\u0001';
  let t = String(msg).replace(/\{\{([^}]+)\}\}/g, (_, u) => (u === meId ? Y : nameOf(u)));
  if (!t.includes(Y)) return t;
  t = t.replace(/\u0001 draws (\d+) and is skipped/g, Y + ' draw $1 and are skipped')
    .replace(/\u0001 played their last card and wins/g, Y + ' played your last card and win')
    .replace(/\u0001 is the last one standing and wins/g, Y + ' are the last one standing and win')
    .replace(/\u0001 took too long and was skipped/g, Y + ' took too long and were skipped')
    .replace(/\u0001 (draws|goes|wins)\b/g, (m0, v) => Y + ' ' + v.slice(0, -1).replace(/oe$/, 'o'))
    .replace(/\u0001 is\b/g, Y + ' are').replace(/\u0001 was\b/g, Y + ' were');
  return t.replace(/(^|[.!?·:]\s*)\u0001/g, (m0, p) => p + 'You').replace(/\u0001/g, 'you');
}
function count(u) { return (G.counts && G.counts[u]) || 0; }
function listNames(a) { return a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function ago(ts) {
  if (!ts) return '—';
  const d = Math.floor((Date.now() - ts) / 864e5);
  if (d <= 0) return 'Today'; if (d === 1) return 'Yesterday'; if (d < 7) return new Date(ts).toLocaleDateString([], { weekday: 'short' });
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function toast(msg, kind, html) {
  const el = document.createElement('div'); el.className = 'toast ' + (kind || '');
  if (html) el.innerHTML = html; else el.textContent = msg;
  const box = $('#toasts'); box.appendChild(el);
  while (box.children.length > (view === 'game' ? 2 : 3)) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'admalert' ? 9000 : kind === 'win' ? 4200 : kind === 'chat' ? 4000 : 2800);
}
function cardHTML(c, o) {
  o = o || {};
  const col = cc(c), v = cv(c), wild = col === 'w', lab = label(c), tag = o.tag || 'div', ul = v === '6' || v === '9' ? ' ul' : '';
  const mid = wild ? (v === 'F' ? '+4' : '') : lab;
  return `<${tag} class="card ${o.cls || ''}${col === 'y' ? ' inky' : ''}" style="--w:${typeof o.w === 'string' ? o.w : (o.w || 64) + 'px'};--c:${CVAR[col]}" ${o.attrs || ''} aria-label="${esc(o.aria || cardName(c))}"><span class="face"><span class="ring ${wild ? 'ring-wild' : ''}"></span><span class="mid${wild ? ' mid-wild' : ''}${ul}">${esc(mid)}</span>${wild && v !== 'F' ? '<span class="corner tl"><i class="wdot"></i></span><span class="corner br"><i class="wdot"></i></span>' : `<span class="corner tl${ul}">${esc(lab)}</span><span class="corner br${ul}">${esc(lab)}</span>`}</span></${tag}>`;
}
function backHTML(w, cls) { return `<div class="card back ${cls || ''}" style="--w:${typeof w === 'string' ? w : w + 'px'}"><span class="face"><span class="ring"></span><span class="wordmark">Last<br>Card</span></span></div>`; }

/* ---------- server calls ---------- */
function send(ev, data, quiet) {
  if (practice && curCode === PRACTICE) return Promise.resolve(practiceAct(ev, data || {}));
  // watching as admin is look-only: nothing that would touch the table leaves this phone
  if (adminWatching && !/^(admin|hello|vapid|pushSub|leaderboard|login|logout|checkName)/.test(ev)) return Promise.resolve({ ok: false });
  return new Promise((res) => {
    if (!socket.connected) { if (!quiet) toast('Not connected yet. Hang on a second.'); return res({ ok: false, error: 'Not connected yet. Hang on a second.' }); }
    socket.timeout(8000).emit(ev, data || {}, (err, r) => {
      if (err) { if (!quiet) toast('The server didn’t answer. Try again.'); return res({ ok: false, error: 'The server didn’t answer. Try again.' }); }
      if (r && !r.ok && r.error && !quiet) toast(r.error);
      res(r || { ok: false });
    });
  });
}

/* ---------- screens + routing ---------- */
const SHEETS = ['signin', 'picker', 'menu', 'rules', 'howto', 'practice', 'iosInstall'];
function closeSheets(except) { for (const id of SHEETS) if (id !== except) $('#' + id).hidden = true; $('#reactPop').hidden = true; }
function show(v) {
  if (v !== 'game' && practice) endPractice();
  if (v !== 'game' && adminWatching) adminLeave();
  if (v !== 'admin') clearTimeout(admTimer);
  view = v;
  document.body.classList.toggle('in-game', v === 'game');
  for (const id of ['home', 'invite', 'board', 'game', 'admin']) $('#' + id).hidden = id !== v;
  if (v !== 'game') { closeSheets('signin'); $('#chat').classList.remove('open'); }
  window.scrollTo(0, 0);
}
function setHash(h) { const want = h ? '#' + h : ''; if (location.hash !== want) history.replaceState(null, '', location.pathname + want); }
function hashCode() { const m = /^#([A-Za-z]{4})$/.exec(location.hash || ''); return m ? m[1].toUpperCase() : null; }
function route() {
  if (!ready) return;
  const code = hashCode();
  if (code) openTable(code);
  else if (location.hash === '#leaderboard') showBoard(view === 'game' ? 'game' : 'home');
  else if (location.hash === '#admin' && me && me.admin) showAdmin();
  else showHome();
}
window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]'); if (c) { $('#' + c.dataset.close).hidden = true; if (c.dataset.close === 'picker') pendingWild = null; }
  const h = e.target.closest('[data-howto]'); if (h) { e.preventDefault(); closeSheets(); $('#howto').hidden = false; }
  for (const id of SHEETS) if (e.target.id === id) $('#' + id).hidden = true; // tap outside a sheet closes it
  if (!e.target.closest('#reactPop,#reactBtn')) $('#reactPop').hidden = true;
});

/* ---------- sign-in sheet ---------- */
let authMode = load('lc-nick') ? 'back' : 'new', checkTimer = null, checkSeq = 0, lastCheck = null;
function renderAuth() {
  const isNew = authMode === 'new';
  $('#siBody').innerHTML = `
    <div class="seg" role="group" aria-label="New or returning player">
      <button type="button" data-mode="new" aria-pressed="${isNew}">I’m new</button>
      <button type="button" data-mode="back" aria-pressed="${!isNew}">I’ve played before</button>
    </div>
    <label class="fld" for="siName">${isNew ? 'Pick a name' : 'Your name'}
      <input id="siName" class="inp" maxlength="18" placeholder="Priya" autocomplete="nickname" aria-describedby="siHint" value="${esc(load('lc-nick'))}">
    </label>
    <p class="hint" id="siHint" role="status"></p>
    <div class="sugg" id="siSugg" aria-label="Free names you can take"></div>
    <label class="fld" for="siPin">${isNew ? 'Choose a 4-digit PIN' : 'Your 4-digit PIN'}
      <input id="siPin" class="inp pin-inp" maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="off" placeholder="••••" type="password">
    </label>
    <p class="note">${isNew ? 'Names are unique. Use this name and PIN on any phone to keep your wins.' : 'Use the name and PIN you picked last time.'}</p>`;
  $('#siGo').textContent = isNew ? 'Claim name and play' : 'Sign in';
  $('#siErr').textContent = '';
  runCheck();
}
function setHint(kind, text, sugg) {
  const h = $('#siHint'), inp = $('#siName'); if (!h) return;
  h.className = 'hint ' + (kind || ''); h.textContent = text || '';
  inp.classList.toggle('ok', kind === 'ok'); inp.classList.toggle('bad', kind === 'bad'); inp.setAttribute('aria-invalid', kind === 'bad' ? 'true' : 'false');
  $('#siSugg').innerHTML = (sugg || []).map((n) => `<button type="button" data-sugg="${esc(n)}">${esc(n)}</button>`).join('');
}
async function runCheck() {
  const inp = $('#siName'); if (!inp) return;
  const name = inp.value.trim();
  if (name.length < 2) { lastCheck = null; setHint('', name ? 'Use at least 2 letters or numbers.' : ''); return; }
  const seq = ++checkSeq;
  const r = await send('checkName', { name }, true);
  if (seq !== checkSeq || !r.ok) return;
  lastCheck = r;
  const isNew = authMode === 'new';
  if (!r.valid) setHint('bad', r.error);
  else if (isNew && r.available) setHint('ok', `“${r.name}” is free. It becomes yours once you set a PIN.`);
  else if (isNew) setHint('bad', `“${r.name}” is already taken. Pick a different name${r.suggestions && r.suggestions.length ? ', or tap one of these:' : '.'}`, r.suggestions);
  else if (r.available) setHint('bad', `No player called “${name}” yet. New here? Choose “I’m new”.`);
  else setHint('ok', `Welcome back, ${r.name}. Enter your PIN.`);
}
$('#siBody').addEventListener('input', (e) => { if (e.target.id === 'siName') { clearTimeout(checkTimer); checkTimer = setTimeout(runCheck, 300); } });
$('#siBody').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]');
  if (m) { const keep = $('#siName').value; authMode = m.dataset.mode; renderAuth(); $('#siName').value = keep; runCheck(); return; }
  const sg = e.target.closest('[data-sugg]');
  if (sg) { $('#siName').value = sg.dataset.sugg; runCheck(); $('#siPin').focus(); }
});
function openSignIn(then) {
  afterSignIn = then || null;
  closeSheets();
  if (!$('#signin').contains($('#siForm'))) $('#siTitle').after($('#siForm'));
  if (me) {
    $('#siTitle').textContent = 'Your account';
    $('#siBody').innerHTML = `<div class="idchip">${avatarFor(me.name.toLowerCase(), me.name)}<span class="tx">Signed in as<b>${esc(me.name)}</b></span></div><p class="note">Wins from every game you finish signed in go on the leaderboard.</p>`;
    $('#siGo').textContent = 'Switch to another name';
  } else { $('#siTitle').textContent = 'Who’s playing?'; renderAuth(); }
  $('#signin').hidden = false;
  setTimeout(() => { const n = $('#siName'); if (n && !n.value) n.focus(); }, 50);
}
$('#siForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (me) { await switchUser(); openSignIn(afterSignIn); return; }
  const name = $('#siName').value.trim(), pin = $('#siPin').value, err = $('#siErr');
  err.textContent = '';
  if (name.length < 2) { err.textContent = 'Type your name first.'; $('#siName').focus(); return; }
  if (authMode === 'new' && lastCheck && lastCheck.valid && !lastCheck.available && lastCheck.name.toLowerCase() === name.replace(/\s+/g, ' ').toLowerCase()) { err.textContent = 'That name is taken. Pick a different one.'; $('#siName').focus(); return; }
  if (!/^\d{4}$/.test(pin)) { err.textContent = authMode === 'new' ? 'Choose a 4-digit PIN (numbers only).' : 'Enter your 4-digit PIN.'; $('#siPin').focus(); return; }
  $('#siGo').disabled = true;
  const r = await send('login', { name, pin, mode: authMode }, true);
  $('#siGo').disabled = false;
  if (!r.ok) {
    err.textContent = r.error || 'Couldn’t sign in. Try again.';
    if (r.taken) setHint('bad', 'Pick a different name' + (r.suggestions && r.suggestions.length ? ', or tap one of these:' : '.'), r.suggestions);
    if (r.notFound) setHint('bad', r.error);
    return;
  }
  me = { name: r.name, admin: !!r.admin }; session = r.session; store('lc-session', session); store('lc-nick', r.name); last = r.last || last; authMode = 'back';
  $('#signin').hidden = true;
  toast(r.created ? `Welcome, ${r.name}! Remember your PIN to keep your wins.` : `Signed in as ${r.name}`);
  const then = afterSignIn; afterSignIn = null;
  if (then) then(); else rerender();
});
async function switchUser() {
  await send('logout', { session }, true);
  me = null; session = ''; store('lc-session', ''); last = null;
  if (view === 'game') { curCode = null; G = null; setHash(''); }
  $('#signin').hidden = true;
  route();
}
function needSignIn(then) { if (me) { then(); return; } openSignIn(then); }
function rerender() { if (view === 'admin') showAdmin(); else if (view === 'home') showHome(); else if (view === 'invite' && inviteInfo) showInvite(inviteInfo); else if (view === 'board') showBoard(boardFrom); else render(); }

/* ---------- connection ---------- */
socket.on('connect', async () => {
  $('#conn').hidden = true;
  const r = await send('hello', { token, session }, true);
  if (r.build) { if (!build) build = r.build; else if (r.build !== build) $('#updateBar').hidden = false; }
  if (r.ok) { me = r.account || null; if (!r.sessionValid) { session = ''; store('lc-session', ''); } last = r.last || null; }
  ready = true; $('#homeNote').textContent = '';
  if (view === 'game' && curCode && !hashCode() && !practice && !adminWatching) setHash(curCode);
  setOffline(false);
  syncPush();
  if (adminWatching && me && me.admin) adminWatch(adminWatching);
  else if (!practice) route();
});
socket.on('disconnect', () => { setTimeout(() => { if (!socket.connected) $('#conn').hidden = false; }, 1500); });
socket.on('connect_error', () => {
  if (ready) return;
  $('#homeNote').textContent = 'Waking up the game server. This can take up to a minute the first time.';
  const w = $('#invWait'); if (w) w.textContent = 'Waking up the game server. This can take up to a minute the first time.';
});
// the server sends a table's state just before it confirms a join, so keep the latest per table
const latest = {}, latestChat = {};
socket.on('state', (s) => { if (!s) return; latest[s.code] = s; if (s.code === curCode) onState(s); });
socket.on('ended', (m) => {
  if (!m || m.code !== curCode) return;
  curCode = null; G = null; setHash(''); closeSheets(); $('#chat').classList.remove('open'); showHome();
  const meName = me && me.name;
  const el = document.createElement('div'); el.className = 'sheet'; el.style.position = 'fixed'; el.style.zIndex = '50';
  el.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="endT">
    <span class="grab" aria-hidden="true"></span>
    <div><p class="eyebrow">${m.by === meName ? 'You ended the game' : esc(m.by) + ' ended the game'}${m.midRound ? ` during round ${m.rounds}` : ` after ${m.rounds} round${m.rounds === 1 ? '' : 's'}`}</p><h2 id="endT">${m.standings[0] && m.standings[0].wins ? (m.standings[0].name === meName ? 'You won the game!' : esc(m.standings[0].name) + ' won the game!') : 'Game over'}</h2></div>
    <ol class="standings">${m.standings.map((p) => `<li>${avatarFor(p.name.toLowerCase(), p.name, { size: 'sm' })}<span class="nm">${esc(p.name)}${p.name === meName ? ' (you)' : ''}</span><span class="w">${p.wins} ★</span></li>`).join('')}</ol>
    <button class="btn gold block" style="min-height:54px">Done</button>
  </div>`;
  el.querySelector('button').onclick = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  if (m.by !== meName) Snd.play('roundover');
});
socket.on('left', (m) => { if (m && m.code === curCode) { toast('You were removed from the table'); curCode = null; G = null; setHash(''); showHome(); } });
socket.on('react', (m) => { if (m && m.code === curCode && view === 'game' && ['😂', '😱', '😤', '👏'].includes(m.e)) floatEmoji(m.e, m.by); });
socket.on('recorded', (m) => { if (m && m.code === curCode) { recorded = m; if (G && G.status === 'over') render(); } });
socket.on('nudged', (m) => { if (m && m.code === curCode) { Snd.play('nudge'); buzz(); toast(`${nameOf(m.by)} is waiting for you to deal`, 'call'); } });
socket.on('presence', (m) => {
  if (!m || m.code !== curCode || !G) return;
  if (m.id === G.me || (me && m.name === me.name)) return;
  const text = m.type === 'joined' ? (m.status === 'playing' ? `${m.name} is watching · dealt in next round` : `${m.name} joined the table${m.status === 'lobby' ? '' : ' · dealt in next round'}`) : `${m.name} left the table`;
  chatMsgs.push({ sys: true, text, at: Date.now() }); if (chatMsgs.length > 60) chatMsgs.shift();
  renderChat();
  if (view === 'game') { toast(text, m.type === 'joined' ? 'win' : ''); if (m.type === 'joined') Snd.play('chat'); }
});
socket.on('chatHistory', (m) => { if (!m) return; latestChat[m.code] = m.list; if (m.code === curCode) { chatMsgs = Array.isArray(m.list) ? m.list.slice(-60) : []; renderChat(); } });
socket.on('chat', (m) => {
  if (!m || m.code !== curCode || !m.text) return;
  chatMsgs.push(m); if (chatMsgs.length > 60) chatMsgs.shift();
  renderChat();
  if (G && m.by !== G.me) {
    Snd.play('chat');
    const visible = isWide() || $('#chat').classList.contains('open');
    if (!visible) { unread++; updateBadge(); toast('', 'chat', `<b>${esc(nameOf(m.by))}:</b> ${esc(m.text)}`); }
  }
});
$('#reloadBtn').onclick = () => location.reload();

/* ---------- home ---------- */
$('#acctBtn').onclick = () => { if (!me && view === 'home' && $('#homeAuthSlot #siName')) $('#siName').focus(); else openSignIn(); };
async function refreshLast() { const r = await send('hello', { token, session }, true); if (r.ok) last = r.last || null; }
function showHome() {
  show('home'); setHash('');
  const ab = $('#acctBtn');
  if (me) { ab.className = 'acct'; ab.innerHTML = avatarFor(me.name.toLowerCase(), me.name) + esc(me.name); ab.setAttribute('aria-label', 'Your account, ' + me.name); }
  else { ab.className = 'acct out'; ab.textContent = 'Sign in'; ab.removeAttribute('aria-label'); }
  $('#greet').textContent = me ? `Ready for a round, ${me.name}?` : 'Ready for a round?';
  $('#adminBtn').hidden = !(me && me.admin);
  $('#homeErr').textContent = '';
  // signed out: the sign-in form sits right on the page instead of hiding behind a header button
  const authBox = $('#homeAuth');
  authBox.hidden = !!me; $('#newGameBox').hidden = !me;
  if (!me) { $('#homeAuthSlot').appendChild($('#siForm')); renderAuth(); }
  else if (!$('#signin').contains($('#siForm'))) $('#siTitle').after($('#siForm'));
  const box = $('#rejoinBox');
  if (last && me) {
    const others = (last.players || []).filter((n) => n !== me.name);
    const chip = last.status === 'playing' ? (last.yourTurn ? 'Your turn' : `Round ${last.round || 1}`) : last.status === 'over' ? 'Round over' : 'In the lobby';
    const sub = others.length ? (last.status === 'playing' ? `Round ${last.round || 1} with ` : 'With ') + listNames(others.slice(0, 3)) + (others.length > 3 ? ` and ${others.length - 3} more` : '') : 'Just you so far';
    box.innerHTML = `<section class="rejoin2" aria-labelledby="rjT">
      <div class="rj-top"><span id="rjT" class="rj-eye">Your table</span><span class="rj-chip ${last.yourTurn ? 'hot' : ''}">${esc(chip)}</span></div>
      <div class="rj-mid"><span class="rj-code">${esc(last.code)}</span><span class="stack-av" aria-hidden="true">${others.slice(0, 4).map((n) => avatarFor(n.toLowerCase(), n, { size: 'sm' })).join('')}</span></div>
      <p class="rj-sub">${esc(sub)}</p>
      <button class="btn gold block" id="rejoinBtn" style="min-height:52px;font-size:16px">Rejoin table</button>
    </section>`;
    $('#rejoinBtn').onclick = () => openTable(last.code);
  } else box.innerHTML = '';
  $('#createBtn').className = 'btn block ' + (last && me ? 'light' : 'gold');
  // offline: only practice is possible
  $('#offlineBox').hidden = !offline;
  $('#lbh').closest('section').hidden = offline;
  if (offline) { $('#homeAuth').hidden = true; $('#newGameBox').hidden = true; box.innerHTML = ''; }
  $('#practiceRow').classList.toggle('hot', offline);
  paintInstall();
  if (!offline) loadHomeBoard();
}
$('#practiceRow').onclick = () => openPracticeSetup();

/* ---------- offline ---------- */
let offline = false;
function setOffline(v) { if (offline === v) return; offline = v; if (view === 'home') showHome(); }
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => { if (socket.connected) setOffline(false); });
setTimeout(() => { if (!socket.connected && (!navigator.onLine || typeof io !== 'function')) { offline = true; if (view === 'home' || !ready) showHome(); } }, 2500);

/* ---------- install as an app ---------- */
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; paintInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; store('lc-install', 'done'); paintInstall(); });
function paintInstall() {
  const show = !standalone() && !load('lc-install') && (!!installEvt || isIOS());
  $('#installBox').hidden = !show;
}
$('#installBtn').onclick = async () => {
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => null); if (r && r.outcome === 'accepted') store('lc-install', 'done'); installEvt = null; paintInstall(); }
  else if (isIOS()) { closeSheets(); $('#iosInstall').hidden = false; }
};
$('#installX').onclick = () => { store('lc-install', 'dismissed'); paintInstall(); };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));

/* ---------- your-turn alerts ---------- */
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && (!isIOS() || standalone()); }
function b64ToBytes(b64) { const p = '='.repeat((4 - (b64.length % 4)) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
async function enablePush() {
  if (!pushSupported()) return false;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    const k = await send('vapid', {}, true);
    if (!k.ok || !k.key) return false;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) }));
    const r = await send('pushSub', { sub: sub.toJSON() }, true);
    if (r.ok) store('lc-push', 'on');
    return !!r.ok;
  } catch (e) { return false; }
}
// keep the server's copy of this phone's alert address up to date (it changes, and accounts can switch)
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted' || load('lc-push') !== 'on' || !me) return;
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) send('pushSub', { sub: sub.toJSON() }, true); else enablePush(); } catch (e) {}
}
$('#alertBtn').onclick = async () => {
  if (load('lc-push') === 'on' && Notification.permission === 'granted') {
    store('lc-push', 'off');
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); } catch (e) {}
  } else if (!(await enablePush())) toast(Notification.permission === 'denied' ? 'Alerts are blocked in your browser settings for this site.' : 'Couldn’t turn on alerts.');
  renderMenu();
};
$('#approveBtn').onclick = () => send('setting', { key: 'approve' });
async function loadHomeBoard() {
  const r = await send('leaderboard', { game: 'all', period: 'all', limit: 5 }, true);
  if (!r.ok) return;
  const mine = r.mine, top = r.rows;
  const lead = top[0];
  $('#myRank').hidden = !mine && (!me || !top.length);
  $('#myRank').innerHTML = mine
    ? `<b>#${mine.rank}</b><span>You · <strong style="color:var(--ink)">${mine.wins} win${mine.wins === 1 ? '' : 's'}</strong> in ${mine.played} game${mine.played === 1 ? '' : 's'}${lead && lead.name !== mine.name ? `<br>${lead.wins - mine.wins === 0 ? 'Level with ' + esc(lead.name) : (lead.wins - mine.wins) + ' behind ' + esc(lead.name)}` : mine.rank === 1 ? '<br>You’re on top' : ''}</span>`
    : `<span>${me ? 'Finish a round to get on the board.' : 'Sign in and finish a round to get on the board.'}</span>`;
  $('#topList').innerHTML = top.length ? top.map((x) => `<li class="${x.me ? 'me' : ''}"><span class="rk">${x.rank}</span><span class="nm">${esc(x.name)}${x.me ? ' (you)' : ''}${x.online ? ONDOT : ''}</span><span class="w">${x.wins}</span></li>`).join('') : `<li><span class="nm" style="color:var(--muted)">No wins yet. ${me ? 'Finish a round to be first.' : 'Sign in and finish a round to be first.'}</span></li>`;
}
$('#createBtn').onclick = () => needSignIn(async () => {
  $('#createBtn').disabled = true;
  const r = await send('create', {}, true);
  $('#createBtn').disabled = false;
  if (r.ok) enterGame(r.code); else $('#homeErr').textContent = r.error || 'Couldn’t start a table.';
});
$('#codeInp').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('#codeInp').value.trim();
  if (c.length !== 4) { $('#homeErr').textContent = 'Enter the 4-letter table code.'; return; }
  $('#homeErr').textContent = '';
  openTable(c);
});

/* ---------- invite (opened from a link) ---------- */
let inviteInfo = null;
async function openTable(code) {
  const r = await send('open', { code }, true);
  if (!r.ok) { showHome(); toast(r.error || 'Couldn’t open that table.'); return; }
  if (!r.exists) { showInvite({ code, missing: true }); return; }
  if (r.seated) { enterGame(code); return; }
  showInvite(r.info);
}
function showInvite(info) {
  if (curCode && curCode !== info.code) { curCode = null; G = null; }
  inviteInfo = info; show('invite'); setHash(info.code);
  const body = $('#inviteBody');
  if (info.missing) {
    body.innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
      <div class="inv-hero"><p class="eyebrow">Table ${esc(info.code)}</p><h1>This table isn’t open anymore</h1><p class="note" style="font-size:15px">Tables close a few hours after everyone leaves. Ask your friend for a fresh link, or start your own.</p></div>
      <div class="inv-foot"><button class="btn gold block" id="invOwn">Start my own table</button></div>`;
    $('#invOwn').onclick = () => showHome(); return;
  }
  const host = info.host || 'Someone';
  const live = info.status === 'playing';
  const status = info.status === 'lobby' ? 'waiting in the lobby' : live ? `round ${info.round} is on` : 'between rounds';
  const joinLabel = info.full ? 'This table is full' : info.approve ? (live ? `Ask ${host} to let you watch` : `Ask ${host} to let you in`) : live ? 'Watch now, join next round' : `Join ${host}’s table`;
  const joinNote = info.full ? '' : info.approve ? `${host} lets people in. They’ll see your request.` : live ? 'You’ll see the table, not anyone’s cards. You’re dealt in when this round ends.' : '';
  const seatsShown = info.players.slice(0, info.full ? 8 : 7);
  body.innerHTML = `
    <a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="inv-hero">
      <p class="note" style="font-size:15px;color:var(--soft)">You’re invited to play Last Card</p>
      <h1>${esc(host)}’s table</h1>
      <span class="inv-code">${esc(info.code)}</span>
    </div>
    <section class="inv-seats" aria-labelledby="invAt">
      <h2 id="invAt">At the table · ${info.players.length}</h2>
      <ul>${seatsShown.map((n) => `<li>${avatarFor(n.toLowerCase(), n)}<span class="nm">${esc(n)}</span><em>${n === host ? 'Host' : ''}</em></li>`).join('')}${info.full ? '' : `<li class="you"><span class="av openseat">${me ? esc(me.name[0].toUpperCase()) : '?'}</span><span class="nm">You</span><em>${live ? 'Next round' : 'Joining'}</em></li>`}</ul>
      <p class="inv-status">${esc(status[0].toUpperCase() + status.slice(1))}</p>
    </section>
    <div class="inv-foot">
      ${me ? `<div class="idchip">${avatarFor(me.name.toLowerCase(), me.name, { size: 'sm' })}<span class="tx">Joining as<b>${esc(me.name)}</b></span><button class="linkbtn" id="invSwitch">Not you?</button></div>` : ''}
      <button class="btn gold block" id="invJoin" style="min-height:58px;font-size:18px" ${info.full ? 'disabled' : ''}>${esc(joinLabel)}</button>
      ${joinNote ? `<p class="note" style="text-align:center">${esc(joinNote)}</p>` : ''}
      <p class="err" id="invErr" role="alert"></p>
      <button class="linkbtn" id="invOwn" style="align-self:center;color:var(--muted)">Start my own table instead</button>
    </div>`;
  $('#invOwn').onclick = () => showHome();
  const sw = $('#invSwitch'); if (sw) sw.onclick = async () => { await switchUser(); };
  $('#invJoin').onclick = () => needSignIn(async () => {
    const btn = $('#invJoin'); if (btn) btn.disabled = true;
    const r = await send('join', { code: info.code }, true);
    if (btn) btn.disabled = false;
    if (r.ok) enterGame(info.code);
    else if (r.waiting) showWaiting(info, r.host);
    else if (r.needLogin) { me = null; openSignIn(() => $('#invJoin').click()); }
    else if ($('#invErr')) $('#invErr').textContent = r.error || 'Couldn’t join. Try again.';
  });
}

// waiting for the host to let you in
let waitingFor = null;
function showWaiting(info, host) {
  waitingFor = info.code;
  $('#inviteBody').innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="inv-hero" style="padding-top:40px">
      ${avatarFor(host.toLowerCase(), host, { size: 'lg' })}
      <h1>Asked ${esc(host)} to let you in</h1>
      <p class="note" style="font-size:15px">Table <b style="color:var(--ink);letter-spacing:.12em">${esc(info.code)}</b>. Keep this page open, you’ll go straight in.</p>
      <div class="wait-dots" aria-hidden="true"><i></i><i></i><i></i></div>
    </div>
    <div class="inv-foot"><button class="btn block" id="waitCancel">Cancel</button></div>`;
  $('#waitCancel').onclick = async () => { waitingFor = null; await send('cancelJoin', { code: info.code }, true); showInvite(info); };
}
socket.on('admitted', async (m) => {
  if (!m || m.code !== waitingFor) return;
  waitingFor = null;
  const r = await send('join', { code: m.code }, true);
  if (r.ok) { enterGame(m.code); toast(`${m.host} let you in`, 'win'); } else toast(r.error || 'Couldn’t join. Try again.');
});
socket.on('declined', (m) => {
  if (!m || m.code !== waitingFor) return;
  waitingFor = null;
  $('#inviteBody').innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="inv-hero" style="padding-top:40px"><h1>${esc(m.host)} didn’t let you in this time</h1><p class="note" style="font-size:15px">You can ask again, or start your own table.</p></div>
    <div class="inv-foot"><button class="btn gold block" id="decAgain">Ask again</button><button class="btn block" id="decHome">Start my own table</button></div>`;
  $('#decAgain').onclick = () => openTable(m.code);
  $('#decHome').onclick = () => showHome();
});

/* ---------- leaderboard ---------- */
const ONDOT = '<i class="ondot" title="Online now"></i><span class="sr"> (online now)</span>';
async function showBoard(from) {
  boardFrom = from || 'home'; show('board');
  if (boardFrom === 'home') setHash('leaderboard');
  $$('#lbPeriod button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === boardPeriod)));
  $('#lbRows').innerHTML = '<li class="lbrow"><span></span><span class="nm"><b>Loading…</b></span><span></span></li>';
  const r = await send('leaderboard', { game: boardGame, period: boardPeriod, limit: 50 }, true);
  if (view !== 'board') return;
  if (!r.ok) { $('#lbRows').innerHTML = '<li class="lbrow"><span></span><span class="nm"><b>Couldn’t load the leaderboard. Try again.</b></span><span></span></li>'; return; }
  const games = Object.assign({ all: 'All games' }, r.games || {});
  $('#lbGames').hidden = Object.keys(games).length <= 2;
  $('#lbGames').innerHTML = Object.entries(games).map(([k, v]) => `<button data-g="${esc(k)}" aria-pressed="${k === r.game}">${esc(v)}</button>`).join('');
  const pct = (x) => (x.played ? Math.round((100 * x.wins) / x.played) : 0) + '%';
  const nm = (x) => esc(x.name) + (x.me ? ' (you)' : '') + (x.online ? ONDOT : '');
  const top = r.rows.slice(0, 3);
  const order = top.length === 3 && !isWide() ? [1, 0, 2] : top.map((_, i) => i);
  $('#podium').innerHTML = order.map((i) => {
    const x = top[i];
    return `<div class="pod p${i + 1}"><span class="rkn">${i + 1}</span>${avatarFor(x.name.toLowerCase(), x.name, { size: i === 0 ? 'md' : '', online: x.online || undefined })}<span class="nm">${nm(x)}</span><span class="dnm"><b>${nm(x)}</b><small>${x.played} games · ${pct(x)} won</small></span><span class="dw">${x.wins}</span><div class="blk"><b>${x.wins}</b><small>win${x.wins === 1 ? '' : 's'}</small></div></div>`;
  }).join('');
  const row = (x) => `<span class="rk">${x.rank}</span><span class="nm"><b>${nm(x)}</b><small>${x.played} game${x.played === 1 ? '' : 's'} · ${pct(x)} won</small></span><span class="w">${x.wins}</span><span class="xc">${x.played}</span><span class="xc">${pct(x)}</span><span class="xc last">${ago(x.last)}</span>`;
  const rest = isWide() ? r.rows : r.rows.slice(3);
  $('#lbRows').innerHTML = rest.length ? rest.map((x) => `<li class="lbrow ${x.me ? 'me' : ''}">${row(x)}</li>`).join('')
    : (r.rows.length ? '' : `<li class="lbrow"><span></span><span class="nm"><b>No wins ${boardPeriod === 'week' ? 'this week' : 'yet'}</b><small>Finish a round while signed in and you’ll show up here.</small></span><span></span></li>`);
  $('#lbRows').setAttribute('start', isWide() ? '1' : '4');
  const showMine = r.mine && (!isWide() || r.mine.rank > 8);
  $('#mineBar').hidden = !showMine;
  if (showMine) $('#mineRow').innerHTML = `<span class="rk" style="color:var(--gold)">#${r.mine.rank}</span><span class="nm"><b>You · ${esc(r.mine.name)}</b><small>${r.mine.played} games · ${pct(r.mine)} won</small></span><span class="w">${r.mine.wins}</span><span class="xc">${r.mine.played}</span><span class="xc">${pct(r.mine)}</span><span class="xc last">${ago(r.mine.last)}</span>`;
  $('#lbNote').textContent = (me ? '' : 'Sign in to get on the board. ') + 'A round counts when someone wins by playing their last card.';
}
$('#lbGames').addEventListener('click', (e) => { const b = e.target.closest('[data-g]'); if (b) { boardGame = b.dataset.g; showBoard(boardFrom); } });
$('#lbPeriod').addEventListener('click', (e) => { const b = e.target.closest('[data-period]'); if (b) { boardPeriod = b.dataset.period; showBoard(boardFrom); } });
$('#boardBack').onclick = () => { if (boardFrom === 'game' && curCode) { show('game'); setHash(curCode); render(); } else showHome(); };

/* ---------- game shell ---------- */
function enterGame(code) {
  if (curCode !== code) {
    curCode = code; G = null; seenV = -1; lastTopV = -1; armedCall = false; chatMsgs = []; unread = 0; recorded = null; updateBadge(); renderChat();
    $('#gMain').innerHTML = '<div class="center"><p class="note">Loading the table…</p></div>';
  }
  show('game'); setHash(code); $('#gCode').textContent = code;
  if (!G && latest[code]) {
    if (latestChat[code]) { chatMsgs = latestChat[code].slice(-60); renderChat(); }
    onState(latest[code]);
  } else if (G) render();
}
async function goHomeKeepSeat() {
  closeSheets(); curCode = null; G = null;
  await send('away', {}, true);
  await refreshLast(); showHome();
  if (last) toast('Your seat is saved. Tap Rejoin to go back.');
}
$('#menuBtn').onclick = () => { closeSheets(); menuOpen = null; renderMenu(); $('#menu').hidden = false; };
$('#menuHome').onclick = goHomeKeepSeat;
$('#menuBoard').onclick = () => { closeSheets(); showBoard('game'); };
$('#menuLeave').onclick = async () => { closeSheets(); const code = curCode; curCode = null; G = null; last = null; await send('leave', {}, true); toast('You left table ' + code); showHome(); };
$('#soundBtn').onclick = () => { Snd.on = !Snd.on; store('lc-sound', Snd.on ? 'on' : 'off'); $('#soundBtn').setAttribute('aria-pressed', String(Snd.on)); if (Snd.on) Snd.play('turn'); };
$('#reactBtn').onclick = () => { const p = $('#reactPop'); p.hidden = !p.hidden; $('#reactBtn').setAttribute('aria-expanded', String(!p.hidden)); };
$('#reactPop').addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (b) { send('react', { e: b.dataset.e }); $('#reactPop').hidden = true; } });
function floatEmoji(e, by) {
  const el = document.createElement('div'); el.className = 'floater';
  el.style.left = 15 + Math.random() * 60 + '%'; el.textContent = e;
  const s = document.createElement('small'); s.textContent = by ? nameOf(by) : ''; el.appendChild(s);
  document.body.appendChild(el); setTimeout(() => el.remove(), 2300);
}
$('#rules').addEventListener('click', (e) => { const b = e.target.closest('[data-set]'); if (b) send('setting', { key: b.dataset.set }); });

function renderMenu() {
  if (!G) return;
  const host = isHost(), pr = !!G.practice;
  $('#menuTitle').textContent = pr ? 'Practice' : 'Table ' + G.code;
  $('#approveBtn').hidden = !host || pr;
  $('#approveBtn').setAttribute('aria-pressed', String(!!(G.settings && G.settings.approve)));
  const canAlert = pushSupported() && !pr;
  $('#alertBtn').hidden = !canAlert;
  if (canAlert) {
    const perm = Notification.permission;
    $('#alertBtn').setAttribute('aria-pressed', String(perm === 'granted' && load('lc-push') === 'on'));
    $('#alertNote').textContent = perm === 'denied' ? 'Blocked in your browser settings for this site.' : 'A notification when it’s your turn and the app is closed.';
  }
  $('#menuBoard').hidden = pr; $('#menuLeave').hidden = pr;
  $('#menuHome').textContent = pr ? 'End practice' : 'Back to home';
  $('#menuHomeNote').textContent = pr ? 'Practice games don’t count on the leaderboard.' : 'Back to home keeps your seat. Leave table gives it up.';
  $('#soundBtn').setAttribute('aria-pressed', String(Snd.on));
  $('#menuNote').textContent = host ? 'You’re the host: you deal each round and can remove players.' : 'You can remove players who have gone offline so the game keeps moving.';
  const canEnd = !pr && (host || !isOnline(G.host));
  const eb = $('#menuEnd'); eb.hidden = !canEnd;
  if (canEnd && !eb.dataset.wired) { eb.dataset.wired = '1'; wireEnd(eb); }
  $('#menuEndNote').hidden = !canEnd;
  $('#menuEndNote').textContent = host ? 'Ends the game for everyone, even mid-round. Wins so far are kept on the leaderboard.' : `${nameOf(G.host)} (host) is offline, so you can end the game for everyone.`;
  $('#menuNote').hidden = pr;
  $('#menuPlayers').innerHTML = G.players.map((p) => {
    if (pr) return `<li>${av(p.id, '')}<span class="nm">${esc(p.name)}${p.id === G.me ? ' (you)' : ' <small style="color:var(--muted);font-weight:600">computer</small>'}<br><small style="color:var(--muted);font-weight:500">${count(p.id)} cards</small></span></li>`;
    const inRound = G.status !== 'lobby' && G.order.includes(p.id);
    const btns = [];
    // one quiet options button per player; the actions show only when you ask for them
    if (p.id !== G.me && host && menuOpen === p.id) btns.push(`<button class="btn sm" data-host="${esc(p.id)}">Make host</button>`, `<button class="btn sm" data-rm="${esc(p.id)}">Remove</button>`);
    else if (p.id !== G.me && host) btns.push(`<button class="iconbtn more" data-more="${esc(p.id)}" aria-label="Options for ${esc(p.name)}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>`);
    else if (p.id !== G.me && !p.online) btns.push(`<button class="btn sm" data-rm="${esc(p.id)}">Remove</button>`);
    return `<li>${av(p.id, '', true)}<span class="nm">${esc(p.name)}${p.id === G.me ? ' (you)' : ''}${p.id === G.host ? ' · host' : ''}<br><small style="color:var(--muted);font-weight:500">${p.online ? 'Online' : 'Offline'} · ${inRound ? count(p.id) + ' cards' : 'Waiting for next round'}${p.signedIn ? '' : ' · not signed in'}</small></span>${btns.join('')}</li>`;
  }).join('');
}
let menuOpen = null;
$('#menuPlayers').addEventListener('click', (e) => {
  const mo = e.target.closest('[data-more]'); if (mo) { menuOpen = mo.dataset.more; renderMenu(); return; }
  const rm = e.target.closest('[data-rm]'); if (rm) { rm.disabled = true; send('remove', { id: rm.dataset.rm }); return; }
  const mh = e.target.closest('[data-host]'); if (mh) { mh.disabled = true; send('makeHost', { id: mh.dataset.host }); }
});

/* ---------- chat ---------- */
function updateBadge() { refreshPeek(); const b = $('#chatBadge'); b.hidden = !unread; b.textContent = unread > 9 ? '9+' : String(unread); $('#chatBtn').setAttribute('aria-label', unread ? `Open chat, ${unread} unread` : 'Open chat'); }
function chatName(m) { return playerOf(m.by) ? nameOf(m.by) : m.name || nameOf(m.by); }
function renderChat() {
  const box = $('#msgs');
  if (!chatMsgs.length) { box.innerHTML = '<p class="note" style="margin:auto 0 0">No messages yet. Say hi, or tap a quick reply below.</p>'; return; }
  const mine = G && G.me;
  box.innerHTML = chatMsgs.map((m) => {
    if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
    const hh = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<div class="msg ${m.by === mine ? 'mine' : ''}">${m.by === mine ? '' : `<span class="who">${esc(chatName(m))}</span>`}<span class="txt">${esc(m.text)}</span><time>${esc(hh)}</time></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function openChat() { closeSheets(); $('#chat').classList.add('open'); unread = 0; updateBadge(); renderChat(); setTimeout(() => { $('#msgs').scrollTop = 1e6; $('#chatInp').focus({ preventScroll: true }); }, 0); }
$('#chatBtn').onclick = openChat;
// on the round-over sheet: the newest message, so people can sort out "one more?" without hunting for chat
const ICON_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>';
function chatPeekHTML() {
  const last = chatMsgs.filter((m) => !m.sys).slice(-1)[0];
  const text = last ? `<b>${esc(last.by === (G && G.me) ? 'You' : chatName(last))}:</b> ${esc(last.text)}` : 'One more round? Ask the table';
  return `<button class="chatpeek" id="overChat" aria-label="Open chat">${ICON_CHAT}<span class="tx">${text}</span><span class="go">Chat${unread ? ` <i>${unread > 9 ? '9+' : unread}</i>` : ''}</span></button>`;
}
function refreshPeek() { const p = $('#overChat'); if (p) { p.outerHTML = chatPeekHTML(); const q = $('#overChat'); if (q) q.onclick = openChat; } }
$('#chatClose').onclick = () => $('#chat').classList.remove('open');
$('#chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('#chatInp'), text = inp.value.trim(); if (!text) return;
  const r = await send('chat', { text }); if (r.ok) inp.value = '';
});
$('#quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) send('chat', { text: b.dataset.q }); });

/* ---------- game state ---------- */
function onState(s) {
  const prev = G; G = s; G.clockSkew = Date.now() - s.now;
  if (!prev) renderChat(); // names in chat history need the player list
  const lg = (G.log || []).slice(-1)[0];
  if (view === 'game' && seenV >= 0 && lg && lg.v > seenV && ['call', 'catch', 'win'].includes(lg.kind)) toast(fmt(lg.msg), lg.kind);
  seenV = G.v || 0;
  const mine = G.status === 'playing' && G.order[G.turn] === G.me;
  const wasMine = prev && prev.status === 'playing' && prev.order[prev.turn] === prev.me && prev.round === G.round;
  if (prev && mine && !wasMine) { buzz(); Snd.play('turn'); scrollToPlayable = true; }
  if (G.status === 'playing') recorded = null;
  flipRing = !!(prev && prev.status === 'playing' && G.status === 'playing' && prev.round === G.round && prev.dir !== G.dir);
  if (flipRing) revMark = { round: G.round, turnAt: G.turnAt };
  const sameRound = !!(prev && prev.status === 'playing' && G.status === 'playing' && prev.round === G.round);
  qAdvance = sameRound && !flipRing && prev.turn !== G.turn;
  const fx = sameRound ? fxFrom(prev) : null;
  const from = fx && fx.played ? playedFromRect(fx.by) : null;
  fxFlying = !!from && !reducedMotion();
  if (prev && prev.status === 'playing' && G.status === 'over') { if (G.winner === G.me) { Snd.play('win'); confetti(90); } else { Snd.play('roundover'); confetti(40); } }
  render();
  fxFlying = false;
  if (fx && view === 'game') runFx(fx, from);
}
function render() {
  if (view !== 'game' || !G) return;
  const st = G.settings || {};
  document.body.classList.toggle('practice', !!G.practice);
  if (G.practice) {
    $('#gCode').textContent = 'Practice';
    const n = G.players.length - 1;
    $('#gSub').textContent = `vs ${n} computer${n === 1 ? '' : 's'} · ${G.practice.level[0].toUpperCase() + G.practice.level.slice(1)} · round ${G.round || 1}`;
    renderTable(); renderWatchers(); renderRequests();
    if (!$('#menu').hidden) renderMenu();
    coachUpdate();
    return;
  }
  if (G.admin) {
    $('#gSub').textContent = (G.status === 'lobby' ? 'Lobby' : 'Round ' + (G.round || 1)) + ' · admin view';
    renderWatchers();
    if (G.status === 'lobby') renderAdminLobby(); else renderTable();
    return;
  }
  renderWatchers(); renderRequests();
  $('#gSub').textContent = G.status === 'lobby' ? 'Lobby · ' + (isHost() ? 'you’re the host' : 'hosted by ' + nameOf(G.host)) : 'Round ' + (G.round || 1) + ' · ' + (st.stack ? 'stacking on' : 'no stacking') + (st.drawUntil ? ' · draw until you can play' : '');
  if (G.status === 'lobby') renderLobby(); else renderTable();
  if (!$('#menu').hidden) renderMenu();
  $$('#rules [data-set]').forEach((b) => b.setAttribute('aria-pressed', String(!!st[b.dataset.set])));
}

/* ---------- lobby ---------- */
function inviteLink() { return location.origin + location.pathname + '#' + G.code; }
function copyLink(link) { try { navigator.clipboard.writeText(link).then(() => toast('Link copied. Paste it in your group chat.'), () => toast(link)); } catch (e) { toast(link); } }
function hostWaitHTML(what) {
  const hn = esc(nameOf(G.host));
  return isOnline(G.host) ? `<p class="note">Waiting for <b style="color:var(--ink)">${hn}</b> (host) to ${what}</p>`
    : `<p class="note">${hn} (host) looks offline.</p><button class="btn gold" data-claim="1">Take over as host</button>`;
}
function renderLobby() {
  const ps = G.players, st = G.settings || {}, host = isHost();
  const ruleText = `${st.stack ? 'stacking +2/+4 on' : 'no stacking'} · ${st.drawUntil ? 'draw until you can play' : 'draw one card'}`;
  $('#gMain').innerHTML = `
    <div class="lobby">
      <section class="card-box gold-box invite-card" aria-labelledby="invh" style="padding:16px;border-radius:20px">
        <h2 id="invh">Invite your friends</h2>
        <p class="note" style="color:var(--soft)">They open the link, tap Join and land right here.</p>
        <input class="inp linkbox" readonly value="${esc(inviteLink())}" aria-label="Invite link" style="font-size:15px">
        <div class="row"><button class="btn light" id="shareBtn">${ICON.share}Share link</button><button class="btn" id="copyBtn" style="flex:0 0 auto">Copy</button></div>
      </section>
      <section aria-labelledby="plh" style="display:flex;flex-direction:column;gap:8px">
        <h2 id="plh" style="font-size:18px">At the table · ${ps.length} of 10</h2>
        <ul class="plist">${ps.map((p) => `<li>${av(p.id, '', true)}<span class="nm">${esc(p.name)}${p.id === G.me ? ' (you)' : ''}</span><span class="tag">${p.id === G.host ? 'Host' : p.online ? (p.signedIn ? 'Ready' : 'Not signed in') : 'Away'}</span></li>`).join('')}</ul>
      </section>
    </div>
    <div class="dealbar">
      <div class="dealrules"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/></svg><span>${esc(ruleText[0].toUpperCase() + ruleText.slice(1))}</span>${host ? '<button class="linkbtn" id="rulesBtn">Change rules</button>' : ''}</div>
      ${host ? `<p class="note">${ps.length < 2 ? 'You need at least 2 players to deal.' : 'Anyone who joins later is dealt in next round.'}</p><button class="btn gold" id="startBtn" ${ps.length < 2 ? 'disabled' : ''}>${ps.length < 2 ? 'Waiting for players' : `Deal cards · ${ps.length} players`}</button>` : hostWaitHTML('deal the cards')}
    </div>`;
  $('#shareBtn').onclick = async () => {
    const link = inviteLink();
    if (navigator.share) { try { await navigator.share({ title: 'Last Card', text: `Join my Last Card table! Code ${G.code}`, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    copyLink(link);
  };
  $('#copyBtn').onclick = () => copyLink(inviteLink());
  const rb = $('#rulesBtn'); if (rb) rb.onclick = () => { closeSheets(); $('#rules').hidden = false; };
  const sb = $('#startBtn'); if (sb) sb.onclick = () => send('start');
  wireClaim();
}
function wireOver() {
  const ps = $('#prSetup'); if (ps) ps.onclick = () => openPracticeSetup();
  const ph = $('#prHome'); if (ph) ph.onclick = () => { endPractice(); showHome(); };
  const ay = $('#alertYes'); if (ay) ay.onclick = async () => { store('lc-push-asked', '1'); $('#alertAsk').remove(); const ok = await enablePush(); toast(ok ? 'Turn alerts are on' : 'Alerts are off. You can turn them on from the menu.'); };
  const an = $('#alertNo'); if (an) an.onclick = () => { store('lc-push-asked', '1'); $('#alertAsk').remove(); };
}

/* ---------- watching ---------- */
function watchers() { return G && G.status === 'playing' && !G.practice ? G.players.filter((p) => !G.order.includes(p.id)) : []; }
function watchPanelHTML() {
  if (G.admin) return adminPanelHTML();
  const others = watchers().filter((p) => p.id !== G.me).map((p) => p.name);
  return `<section class="watch-panel" aria-label="You’re watching">
    <div class="wtop"><span class="pill" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Watching</span>${others.length ? `<span class="note">with ${esc(listNames(others.slice(0, 3)))}</span>` : ''}</div>
    <p>You’re dealt in when this round ends. You can see the table and chat, but not anyone’s cards.</p>
    <div class="row2"><button class="btn light" id="wpChat">Say hi in chat</button><button class="btn" id="wpLeave">Leave table</button></div>
  </section>`;
}
function wireWatchPanel() {
  const c = $('#wpChat'); if (c) c.onclick = () => (isWide() ? $('#chatInp').focus() : openChat());
  const l = $('#wpLeave'); if (l) l.onclick = () => $('#menuLeave').click();
  const ab = $('#wpAdmBack'); if (ab) ab.onclick = () => showAdmin();
  const nx = $('#wpNext'); if (nx) nx.onclick = () => adminNext();
}
function renderWatchers() {
  const w = watchers(), b = $('#watchBtn');
  b.hidden = !w.length;
  $('#watchN').textContent = w.length;
  b.setAttribute('aria-label', `${w.length} watching`);
  const pop = $('#watchPop');
  if (!w.length) { pop.hidden = true; return; }
  pop.innerHTML = `<h3>Watching · dealt in next round</h3>${w.map((p) => `<span class="w">${avatarFor(p.name.toLowerCase(), p.name, { size: 'sm' })}${esc(p.name)}${p.id === G.me ? ' (you)' : ''}</span>`).join('')}`;
}
$('#watchBtn').onclick = (e) => { e.stopPropagation(); const p = $('#watchPop'); p.hidden = !p.hidden; $('#watchBtn').setAttribute('aria-expanded', String(!p.hidden)); };
document.addEventListener('click', (e) => { if (!e.target.closest('#watchPop,#watchBtn')) $('#watchPop').hidden = true; });

/* ---------- join requests (host) ---------- */
function renderRequests() {
  const bar = $('#reqBar'), reqs = (G && !G.practice && G.requests) || [];
  bar.hidden = !reqs.length;
  bar.innerHTML = reqs.map((r) => `<div class="req"><span class="t"><b>${esc(r.name)}</b> wants to join</span><button class="btn sm" data-admit="${esc(r.key)}" data-ok="0">Not now</button><button class="btn gold sm" data-admit="${esc(r.key)}" data-ok="1">Let in</button></div>`).join('');
}
$('#reqBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-admit]'); if (!b) return;
  b.disabled = true; send('admit', { key: b.dataset.admit, allow: b.dataset.ok === '1' });
});
socket.on('joinRequest', (m) => { if (m && m.code === curCode) { Snd.play('chat'); buzz(); } });

function wireClaim() { $$('#gMain [data-claim]').forEach((b) => { b.onclick = () => send('claimHost'); }); }

/* ---------- table ---------- */
function turnLeft() { if (G && G.practice) return IDLE_SKIP_S; return Math.max(0, IDLE_SKIP_S - Math.floor((Date.now() - G.clockSkew - (G.turnAt || 0)) / 1000)); }
function clockText(sec) { return G && G.practice ? '' : '0:' + String(sec).padStart(2, '0'); }
function renderTable() {
  const prevScroll = $('#hand') ? $('#hand').scrollLeft : 0;
  const meId = G.me, seated = G.order.includes(meId), hand = G.hand || [];
  const myTurn = G.status === 'playing' && G.order[G.turn] === meId;
  if (hand.length !== 2 || !myTurn) armedCall = false;
  const top = G.top, cur = CVAR[G.color] || 'transparent', curU = G.order[G.turn];
  let pill, hint = '';
  if (G.status === 'over') { pill = `<span class="pill">${esc(nameOf(G.winner))} wins!</span>`; }
  else if (myTurn) {
    pill = `<span class="pill mine">Your turn <span class="clock" id="turnClock">${clockText(turnLeft())}</span></span>`;
    hint = G.pending > 0 ? `Stack a ${cv(top) === 'D' ? '+2 or +4' : '+4'}, or tap the pile to draw ${G.pending}.` : G.drew ? 'Play the card you drew, or pass.' : (isWide() ? 'Click a glowing card or press its number. Press D to draw.' : 'Play a glowing card, or tap the pile to draw.');
  } else {
    pill = `<span class="pill">${esc(nameOf(curU))}’s turn <span class="clock" id="turnClock">${clockText(turnLeft())}</span></span>`;
    const n = G.order.length, step = G.dir || 1;
    const who = (u) => (u === meId ? 'you' : nameOf(u));
    const n1 = G.order[mod(G.turn + step, n)], n2 = G.order[mod(G.turn + 2 * step, n)];
    const upNext = n < 3 || n2 === curU ? `${who(n1)[0].toUpperCase() + who(n1).slice(1)} ${n1 === meId ? 'are' : 'is'} next` : `${who(n1)[0].toUpperCase() + who(n1).slice(1)} ${n1 === meId ? 'are' : 'is'} next, then ${who(n2)}`;
    hint = G.pending > 0 ? `${nameOf(curU)} must stack or draw ${G.pending}.` : isOnline(curU) ? upNext : `${nameOf(curU)} seems to be offline.`;
  }
  const R = { discard: [top], color: G.color, pending: G.pending };
  const playable = myTurn ? hand.filter((c, i) => (!G.drew || i === hand.length - 1) && canPlay(c, R)).length : 0;
  const wide = isWide(), small = window.innerHeight < 760;
  if (!wide) { renderPhoneTable({ prevScroll, seated, hand, myTurn, hint, R, small }); return; }
  const ring = ringHTML(myTurn);
  lastTopV = G.v; flipRing = false;
  $('#gMain').innerHTML = `
    <div class="center" style="gap:8px;padding-top:4px">
      ${ring}
      <div class="status wstatus" style="min-height:0"><div class="srow" role="status">${pill}<div class="actions" id="actions"></div></div><span class="hint2">${esc(hint)}</span><p class="lastmove" aria-live="polite">${esc(lastMoveText())}</p></div>
    </div>
    ${seated ? `<div class="handwrap" id="handwrap"><div class="handlabel"><span>Your hand · ${hand.length}</span><span id="swipeHint">${myTurn && G.status === 'playing' ? `<span class="play">${playable} playable</span>` : G.wins[meId] ? G.wins[meId] + '★ wins' : ''}</span></div><button class="scrollbtn l" id="scrL" aria-label="Scroll hand left" hidden>‹</button><div class="hand" id="hand"></div><button class="scrollbtn r" id="scrR" aria-label="Scroll hand right" hidden>›</button></div>`
      : watchPanelHTML()}
    ${G.status === 'over' && !G.admin ? overHTML() : ''}`;
  renderActions();
  if (seated) renderHand(hand, myTurn, prevScroll, R);
  $('#drawPile').onclick = doDraw;
  const nb = $('#nextBtn'); if (nb) nb.onclick = () => send('start');
  wireOver();
  const ob = $('#overBoard'); if (ob) ob.onclick = () => showBoard('game');
  wireEnd();
  const nu = $('#nudgeBtn'); if (nu) nu.onclick = async () => { const r = await send('nudge'); if (r.ok) toast(`Nudged ${nameOf(G.host)}`); };
  wireClaim();
}
/* ---------- phone table: an "Up next" queue on top, the piles in the middle, your hand below ---------- */
const ORD = (k) => (k === 1 ? 'next' : k === 2 ? '2nd' : k === 3 ? '3rd' : k + 'th');
function upNextOrder() {
  const n = G.order.length, step = G.dir === -1 ? -1 : 1, ups = [];
  for (let i = 1; i < n; i++) ups.push(G.order[mod(G.turn + i * step, n)]);
  return ups;
}
function lastMoveText() {
  const lg = (G.log || []).slice(-1)[0];
  if (!lg) return '';
  return fmt(lg.msg).replace(/ · play now goes (anti)?clockwise/, ' · order reversed');
}
// Everyone sits in one fixed row, left to right in play order; only the highlight moves.
// A Reverse flips the row once so left to right is still the order of play. No scrolling: up to 10 fit.
function queueHTML(myTurn) {
  const n = G.order.length, playing = G.status === 'playing', curU = G.order[G.turn];
  const seats = G.dir === -1 ? G.order.slice().reverse() : G.order.slice();
  const nextU = playing ? G.order[mod(G.turn + (G.dir === -1 ? -1 : 1), n)] : null;
  const tier = n <= 5 ? 'l' : n <= 7 ? 'm' : 's';
  const revTag = playing && n > 2 && revMark && revMark.round === G.round && revMark.turnAt === G.turnAt;
  const arrow = '<svg width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 5h13M10 1l4 4-4 4"/></svg>';
  const sep = '<li class="qsep" aria-hidden="true"><svg width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l4 4-4 4"/></svg></li>';
  const items = seats.map((u, i) => {
    const isCur = playing && u === curU, me = u === G.me, c = count(u), off = !isOnline(u);
    const label = me ? 'You' : nameOf(u);
    let sub = '', subCls = '';
    if (isCur) { sub = me ? 'Your turn' : G.practice ? 'thinking…' : off ? 'Offline' : `<span id="turnClock">${clockText(turnLeft())}</span>`; subCls = 'now'; }
    else if (off) sub = 'Offline';
    else if (playing && u === nextU && n > 2) sub = 'next';
    else if (playing && c === 1) { sub = 'Last card'; subCls = 'warn'; }
    const aria = `${esc(label)}, ${c} card${c === 1 ? '' : 's'}${isCur ? ', playing now' : u === nextU && n > 2 ? ', next' : ''}${off ? ', offline' : ''}`;
    return `<li class="${isCur ? 'cur' : ''} ${me ? 'me' : ''} ${off ? 'off' : ''}" data-u="${esc(u)}" aria-label="${aria}"${isCur ? ' aria-current="true"' : ''}><span class="qavw">${av(u, '', false)}<span class="qct ${c === 1 ? 'one' : ''}" aria-hidden="true">${c}</span></span><span class="qn">${esc(label)}</span><span class="qs ${subCls}">${sub}</span></li>` + (tier !== 's' && i < n - 1 ? sep : '');
  }).join('');
  const right = revTag ? '<span class="qrev">⇄ Order reversed</span>' : n === 2 ? '<span class="qhint2">1 vs 1</span>' : tier === 's' ? `<span class="qhint2">${n} players</span>` : '<span class="qhint2">then back to the start ↩</span>';
  return `<section class="qstrip t-${tier}" aria-label="Turn order, left to right">
    <div class="qlabels"><span class="l1">Turn order${tier === 's' ? ' ' + arrow : ''}</span>${right}</div>
    <ol class="qlist ${flipRing ? 'flip' : qAdvance ? 'adv' : ''}">${items}</ol>
  </section>`;
}
function renderPhoneTable({ prevScroll, seated, hand, myTurn, hint, R, small }) {
  const top = G.top, cur = CVAR[G.color] || 'transparent', curU = G.order[G.turn], playing = G.status === 'playing';
  const cw = small ? 84 : 96, dw = small ? 74 : 84;
  let pill = '', note = '';
  if (G.status === 'over') pill = `<span class="pill">${G.winner === G.me ? 'You win!' : esc(nameOf(G.winner)) + ' wins!'}</span>`;
  else if (myTurn) pill = `<span class="pill mine">Your turn <span class="clock" id="turnClock">${clockText(turnLeft())}</span></span>`;
  else if (seated) {
    const place = upNextOrder().indexOf(G.me) + 1;
    pill = `<span class="pill ${place === 1 ? 'soon' : ''}">${place === 1 ? 'You’re next' : 'You’re ' + ORD(place) + ' in line'}</span>`;
  }
  if (!myTurn && playing) note = G.pending > 0 ? `${nameOf(curU)} must stack or draw ${G.pending}` : !isOnline(curU) ? `${nameOf(curU)} seems to be offline` : '';
  const line = myTurn ? hint.replace('tap the pile to draw', 'tap Draw').replace(/\.$/, '') : note;
  const fresh = lastTopV !== G.v;
  $('#gMain').innerHTML = `
    ${queueHTML(myTurn)}
    <div class="center qcenter">
      <div class="piles">
        <div class="pilecol">
          <button class="drawpile ${myTurn && !G.drew ? 'can' : ''}" id="drawPile" aria-label="Draw a card, ${G.deckCount} left" style="width:${dw + 6}px;height:${Math.round(dw * 1.52) + 6}px">${backHTML(dw, 'shadow')}${backHTML(dw)}</button>
          <span class="pilelbl ${myTurn && !G.drew ? 'go' : ''}">Draw · ${G.deckCount}</span>
        </div>
        <div class="pilecol discard-wrap">
          ${G.pending > 0 ? `<span class="stackb">+${G.pending}</span>` : ''}
          <div class="discard" style="--cur:${cur}">${top ? cardHTML(top, { w: cw, cls: fresh && !fxFlying ? 'pop' : '' }) : ''}</div>
          <span class="curcol pilelbl" style="--cur:${cur}"><i></i>${COLORS[G.color] ? COLORS[G.color] + ' to match' : ''}</span>
        </div>
      </div>
      <p class="lastmove ${fresh ? 'new' : ''}" aria-live="polite">${esc(lastMoveText())}</p>
      ${line ? `<p class="qhint ${myTurn ? 'mine' : ''}">${esc(line)}</p>` : ''}
    </div>
    ${seated ? `<div class="handwrap q" id="handwrap"><div class="hbar" role="status">${pill}<div class="actions" id="actions"></div></div><button class="scrollbtn l" id="scrL" aria-label="Scroll hand left" hidden>‹</button><div class="hand" id="hand"></div><button class="scrollbtn r" id="scrR" aria-label="Scroll hand right" hidden>›</button></div>`
      : watchPanelHTML()}
    ${G.status === 'over' && !G.admin ? overHTML() : ''}`;
  lastTopV = G.v; flipRing = false; qAdvance = false;
  wireWatchPanel();
  renderActions();
  if (seated) renderHand(hand, myTurn, prevScroll, R);
  $('#drawPile').onclick = doDraw;
  const nb = $('#nextBtn'); if (nb) nb.onclick = () => send('start');
  wireOver();
  const ob = $('#overBoard'); if (ob) ob.onclick = () => showBoard('game');
  wireEnd();
  const nu = $('#nudgeBtn'); if (nu) nu.onclick = async () => { const r = await send('nudge'); if (r.ok) toast(`Nudged ${nameOf(G.host)}`); };
  wireClaim();
}
/* ---------- card effects ----------
   Worked out from what changed between two states, so they look the same for everyone.
   Every played card flies from the player to the pile; Skip, Reverse, Wild, +2 and +4 add one move that
   shows who it hits. Each plays once, never blocks a tap, and is skipped when the phone asks for less motion. */
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function fxFrom(prev) {
  const played = (G.pile || 0) > (prev.pile || 0);
  const by = prev.order[prev.turn];
  const draws = {};
  for (const u of G.order) { const d = ((G.counts || {})[u] || 0) - ((prev.counts || {})[u] || 0); if (d > 0 && !(played && u === by)) draws[u] = d; }
  const n = prev.order.length, step = prev.dir === -1 ? -1 : 1;
  return { played, by, card: played ? G.top : null, draws, next: prev.order[mod(prev.turn + step, n)] };
}
function avEl(u) { return $(`#gMain [data-u="${CSS.escape(u)}"] .av`); }
function centerOf(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
function playedFromRect(u) {
  if (u === G.me) {
    if (lastTap && Date.now() - lastTap.at < 20000) return lastTap.rect;
    const h = $('#hand'); return h ? h.getBoundingClientRect() : null;
  }
  const a = avEl(u); return a ? a.getBoundingClientRect() : null;
}
// where cards for player u should land: your hand for you, otherwise their picture
function targetRect(u) {
  if (u === G.me) { const h = $('#hand'); if (h) { const r = h.getBoundingClientRect(); return { left: r.right - 90, top: r.top + 10, width: 70, height: r.height - 20 }; } }
  const a = avEl(u); return a ? a.getBoundingClientRect() : null;
}
function fxLayer(html, x, y, w, h) {
  const el = document.createElement('div'); el.className = 'fxl'; el.innerHTML = html || '';
  Object.assign(el.style, { left: x - w / 2 + 'px', top: y - h / 2 + 'px', width: w + 'px', height: h + 'px' });
  document.body.appendChild(el); return el;
}
function runFx(fx, from) {
  if (reducedMotion() || !document.body.animate) return;
  const pile = $('#gMain .discard .card'), drawEl = $('#drawPile');
  const v = fx.card ? cv(fx.card) : '', wild = fx.card ? cc(fx.card) === 'w' : false, heavy = v === 'F';
  const land = fx.played && pile && from ? 420 : 0;
  if (fx.played && pile && from) flyIn(pile, from, heavy);
  if (fx.played && pile) {
    setTimeout(() => {
      const p = $('#gMain .discard .card') || pile; const c = centerOf(p.getBoundingClientRect());
      if (heavy) { shakeTable(); Snd.play('thud'); }
      if (v === 'S') { shock(c, CVAR[cc(fx.card)]); stampOn(fx.next, c); Snd.play('skip'); }
      else if (v === 'R') {
        p.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(180deg)' }], { duration: 450, easing: 'ease-in-out' });
        if (G.order.length > 2) orbit(c); else stampOn(fx.next, c);
        Snd.play(G.order.length > 2 ? 'reverse' : 'skip');
      }
      if (wild) {
        const o = p.querySelector('.ring');
        if (o) o.animate([{ transform: 'translate(-50%,-50%) rotate(0deg)' }, { transform: 'translate(-50%,-50%) rotate(720deg)' }], { duration: 800, easing: 'cubic-bezier(.2,.6,.2,1)' });
        setTimeout(() => wash(c, CVAR[G.color]), heavy ? 120 : 520);
        if (!heavy) Snd.play('wild');
      }
    }, land);
  }
  // cards drawn: fly backs from the draw pile to whoever took them
  const after = fx.played && (v === 'D' || v === 'F') ? land + (heavy ? 650 : 250) : land;
  Object.entries(fx.draws).forEach(([u, k]) => {
    const hit = fx.played && (v === 'D' || v === 'F') && u === fx.next;
    tossTo(u, k, drawEl, after, () => {
      bump(u);
      if (hit) { stampOn(u, null); if (u === G.me) buzz(); }
    });
  });
}
function flyIn(pile, from, heavy) {
  const r = pile.getBoundingClientRect();
  const ghost = pile.cloneNode(true);
  Object.assign(ghost.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', margin: '0', zIndex: '40', pointerEvents: 'none' });
  document.body.appendChild(ghost); pile.style.visibility = 'hidden';
  const a0 = centerOf(from), b0 = centerOf(r), s0 = Math.max(0.3, Math.min(1, from.width / r.width));
  const a = ghost.animate([
    { transform: `translate(${a0.x - b0.x}px,${a0.y - b0.y}px) scale(${s0}) rotate(-18deg)`, opacity: 0.7 },
    { transform: `scale(${heavy ? 1.14 : 1.05})`, opacity: 1, offset: 0.8 },
    { transform: 'none', opacity: 1 }], { duration: heavy ? 480 : 420, easing: 'cubic-bezier(.2,.7,.3,1)' });
  const done = () => { ghost.remove(); pile.style.visibility = ''; };
  a.onfinish = done; a.oncancel = done;
}
function shakeTable() {
  const m = $('#gMain'); if (!m) return;
  m.animate([{ transform: 'none' }, { transform: 'translate(-6px,3px)' }, { transform: 'translate(6px,-3px)' }, { transform: 'translate(-4px,2px)' }, { transform: 'translate(3px,-1px)' }, { transform: 'none' }], { duration: 280, easing: 'linear' });
}
function shock(c, color) {
  const el = fxLayer('', c.x, c.y, 150, 150); el.classList.add('fx-shock'); el.style.borderColor = color;
  el.animate([{ transform: 'scale(.35)', opacity: 0.95 }, { transform: 'scale(2)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => el.remove();
}
function orbit(c) {
  const el = fxLayer(`<svg viewBox="0 0 200 200" width="100%" height="100%"><path d="M 104 8 A 92 92 0 0 1 192 100" fill="none" stroke="#ffc94a" stroke-width="4" stroke-linecap="round"/><polygon points="90,8 105,0 105,16" fill="#ffc94a"/><path d="M 96 192 A 92 92 0 0 1 8 100" fill="none" stroke="#ffc94a" stroke-width="4" stroke-linecap="round"/><polygon points="110,192 95,184 95,200" fill="#ffc94a"/></svg>`, c.x, c.y, 200, 200);
  el.animate([{ transform: 'rotate(0)', opacity: 0 }, { opacity: 1, offset: 0.12 }, { transform: 'rotate(-300deg)', opacity: 1, offset: 0.8 }, { transform: 'rotate(-360deg)', opacity: 0 }], { duration: 750, easing: 'ease-in-out' }).onfinish = () => el.remove();
}
function wash(c, color) {
  const el = fxLayer('', c.x, c.y, 200, 200); el.classList.add('fx-wash'); el.style.setProperty('--wc', color);
  el.animate([{ transform: 'scale(.2)', opacity: 0.6 }, { transform: 'scale(5)', opacity: 0 }], { duration: 700, easing: 'ease-out' }).onfinish = () => el.remove();
}
// a red ⊘ lands on the player who misses their turn, and they grey out for a moment
function stampOn(u, fromC) {
  const own = avEl(u), alt = u === G.me ? $('.hbar .pill') : null;
  const tr = own ? own.getBoundingClientRect() : alt ? alt.getBoundingClientRect() : null; if (!tr) return;
  const t = own ? centerOf(tr) : { x: tr.right + 22, y: tr.top + tr.height / 2 };
  const el = fxLayer('<span class="fx-stamp"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M5 15L15 5"/></svg></span><span class="fx-skipped">Skipped</span>', t.x, t.y, 34, 34);
  const f = fromC || { x: t.x, y: t.y - 40 };
  el.animate([{ transform: `translate(${f.x - t.x}px,${f.y - t.y}px) scale(1.8)`, opacity: 0 }, { opacity: 1, offset: 0.15 }, { transform: 'scale(.9)', opacity: 1, offset: 0.8 }, { transform: 'none', opacity: 1 }], { duration: fromC ? 420 : 300, easing: 'cubic-bezier(.2,.7,.3,1)' });
  const a = avEl(u); if (a) a.classList.add('fx-dim');
  setTimeout(() => {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 }).onfinish = () => el.remove();
    const b = avEl(u); if (b) b.classList.remove('fx-dim');
  }, 1500);
}
function tossTo(u, k, drawEl, delay, onDone) {
  if (!drawEl) return;
  const n = Math.min(k, 6);
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const tr = targetRect(u), src = drawEl.getBoundingClientRect(); if (!tr) return;
      const a0 = centerOf(src), b0 = centerOf(tr);
      const el = fxLayer('<span class="fx-back"><i></i></span>', a0.x, a0.y, 30, 45);
      Snd.play('flick');
      el.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${b0.x - a0.x}px,${b0.y - a0.y}px) scale(.6) rotate(14deg)`, opacity: 1, offset: 0.9 }, { transform: `translate(${b0.x - a0.x}px,${b0.y - a0.y}px) scale(.5) rotate(14deg)`, opacity: 0 }], { duration: 380, easing: 'cubic-bezier(.3,.6,.3,1)' }).onfinish = () => { el.remove(); if (i === n - 1 && onDone) onDone(); };
    }, delay + i * 110);
  }
}
function bump(u) {
  const b = $(`#gMain [data-u="${CSS.escape(u)}"] .qct`) || $(`#gMain [data-u="${CSS.escape(u)}"] .ct`);
  if (b && b.animate) b.animate([{ transform: 'scale(1)', background: 'var(--red)', color: '#fff' }, { transform: 'scale(1.45)', background: 'var(--red)', color: '#fff', offset: 0.3 }, { transform: 'scale(1)' }], { duration: 650, easing: 'ease-out' });
}
function wireEnd(b) {
  b = b || $('#endBtn');
  const peek = $('#overChat'); if (peek) peek.onclick = openChat;
  if (!b) return;
  let armed = false, timer = null; const label = b.textContent;
  b.onclick = async () => {
    if (!armed) { armed = true; b.textContent = 'Tap again to end for everyone'; b.classList.add('call'); timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('call'); }, 3000); return; }
    clearTimeout(timer); b.disabled = true;
    const r = await send('endGame');
    armed = false; b.disabled = false; b.textContent = label; b.classList.remove('call');
    if (!r.ok) toast(r.error || 'Couldn’t end the game');
  };
}
function doDraw() {
  if (!G || G.status !== 'playing') return;
  if (G.order[G.turn] !== G.me) { toast('Wait for your turn'); return; }
  if (G.drew) { toast('You already drew. Play it or pass.'); return; }
  send('draw');
}
function updateHandEdges() {
  const el = $('#hand'), wrap = $('#handwrap'); if (!el || !wrap) return;
  const max = el.scrollWidth - el.clientWidth, l = el.scrollLeft > 4, r = el.scrollLeft < max - 4;
  wrap.classList.toggle('more-l', l); wrap.classList.toggle('more-r', r);
  $('#scrL').hidden = !l; $('#scrR').hidden = !r;
}
let handOrder = [], flipRing = false, revMark = null, qAdvance = false, fxFlying = false, lastTap = null;
/* Seats sit on an ellipse in play order, you at the bottom. Seats never move when play reverses;
   only the flow of the ring and the arrow towards the next player change direction. */
// On a computer the ring fills whatever height is left between the header and your hand (CSS),
// and the cards in the middle size themselves to the ring so no seat ever sits on top of them.
function ringHTML(myTurn) {
  const n = G.order.length, mi = G.order.indexOf(G.me), base = mi < 0 ? 0 : mi;
  const playing = G.status === 'playing', curU = G.order[G.turn];
  const nextU = playing ? G.order[mod(G.turn + (G.dir || 1), n)] : null;
  const RX = 44, RY = 41;
  const pos = (k) => { const a = Math.PI / 2 + (k * 2 * Math.PI) / n; return { x: 50 + RX * Math.cos(a), y: 50 + RY * Math.sin(a), a }; };
  const seats = G.order.map((u, idx) => {
    const k = mod(idx - base, n), p = pos(k), c = count(u), isMe = u === G.me;
    const cls = ['seat', playing && u === curU ? 'turn' : '', playing && u === nextU && u !== curU ? 'next' : '', playing && c === 1 ? 'one' : '', !isOnline(u) ? 'off' : '', isMe ? 'me' : ''].join(' ');
    const sub = !isOnline(u) ? 'Offline' : playing && u === curU ? (isMe ? 'Your turn' : 'Playing') : playing && u === nextU ? 'Next' : playing && c === 1 ? 'Last card!' : G.wins[u] ? G.wins[u] + '★' : '';
    return `<div class="${cls}" data-u="${esc(u)}" style="left:${p.x.toFixed(2)}%;top:${p.y.toFixed(2)}%"><span class="avw">${av(u, '', false)}<span class="ct" aria-label="${c} cards">${c}</span></span><span class="nm">${isMe ? 'You' : esc(nameOf(u))}</span><span class="sub">${esc(sub)}</span></div>`;
  }).join('');
  let chev = '';
  if (playing && n > 1) {
    // an arrow on the ring between the current player and the next one, pointing the way play goes
    const kc = mod(G.order.indexOf(curU) - base, n), step = G.dir === -1 ? -1 : 1;
    const a = Math.PI / 2 + ((kc + step / 2) * 2 * Math.PI) / n;
    const x = 50 + RX * Math.cos(a), y = 50 + RY * Math.sin(a);
    const tangent = (Math.atan2(RY * Math.cos(a), -RX * Math.sin(a)) * 180) / Math.PI + (step === 1 ? 0 : 180);
    chev = `<span class="chev" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;--r:${tangent.toFixed(1)}deg" aria-hidden="true"></span>`;
  }
  const cur = CVAR[G.color] || 'transparent', top = G.top;
  const revTag = playing && revMark && revMark.round === G.round && revMark.turnAt === G.turnAt;
  return `<div class="ringwrap ${flipRing ? 'flip' : ''}" role="group" aria-label="Players in turn order, play goes ${G.dir === 1 ? 'clockwise' : 'anticlockwise'}">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><ellipse class="ring-path ${playing ? (G.dir === 1 ? 'cw' : 'ccw') : 'idle'}" cx="50" cy="50" rx="${RX}" ry="${RY}" pathLength="100"/></svg>
    ${chev}${seats}
    <div class="ring-center">
      ${revTag ? '<span class="revtag">⇄ Direction reversed</span>' : ''}
      <div class="piles">
        <button class="drawpile ${myTurn && !G.drew ? 'can' : ''}" id="drawPile" aria-label="Draw a card${isWide() ? ' (D)' : ''}, ${G.deckCount} left" style="width:calc(var(--dw) + 6px);height:calc(var(--dw) * 1.52 + 6px)">${backHTML('var(--dw)', 'shadow')}${backHTML('var(--dw)')}</button>
        <div class="discard-wrap">
          ${G.pending > 0 ? `<span class="stackb">+${G.pending}</span>` : ''}
          <div class="discard" style="--cur:${cur}">${top ? cardHTML(top, { w: 'var(--cw)', cls: lastTopV !== G.v && !fxFlying ? 'pop' : '' }) : ''}</div>
        </div>
      </div>
      <span class="dirlbl"><span class="curcol" style="--cur:${cur}"><i></i>${COLORS[G.color] || ''}</span>· ${G.dir === 1 ? '↻ clockwise' : '↺ anticlockwise'}</span>
    </div>
  </div>`;
}
function renderHand(hand, myTurn, prevScroll, R) {
  const el = $('#hand');
  let idx = hand.map((c, i) => i).sort((a, b) => CORD.indexOf(cc(hand[a])) - CORD.indexOf(cc(hand[b])) || VORD.indexOf(cv(hand[a])) - VORD.indexOf(cv(hand[b])));
  if (myTurn && G.drew) { const li = hand.length - 1; idx.splice(idx.indexOf(li), 1); idx.unshift(li); }
  else if (myTurn && G.status === 'playing') {
    const ok = idx.filter((i) => canPlay(hand[i], R));
    idx = ok.concat(idx.filter((i) => !ok.includes(i)));
  }
  handOrder = idx;
  const wide = isWide(), w = wide ? (window.innerHeight < 820 ? 74 : 88) : window.innerWidth < 370 || window.innerHeight < 760 ? 70 : 80;
  el.innerHTML = idx.map((i, k) => {
    const c = hand[i]; let cls = '';
    const ok = myTurn && G.status === 'playing' && (!G.drew || i === hand.length - 1) && canPlay(c, R);
    if (myTurn && G.status === 'playing') cls = ok ? 'ok' : 'no';
    if (myTurn && G.drew && i === hand.length - 1) cls += ' fresh';
    return `<div class="hcard ${cls}">${cardHTML(c, { w, tag: 'button', attrs: `data-i="${i}"`, aria: cardName(c) + (ok ? ', playable' : '') + (wide && k < 9 ? `, key ${k + 1}` : '') })}${k < 9 ? `<kbd>${k + 1}</kbd>` : ''}</div>`;
  }).join('');
  {
    const gap = wide ? 10 : 6, avail = el.clientWidth - (wide ? 40 : 32), n = idx.length;
    let ov = gap; if (n > 1 && n * w + (n - 1) * gap > avail) ov = Math.max(-w * (wide ? 0.6 : 0.4), (avail - w) / (n - 1) - w);
    el.style.setProperty('--ov', ov + 'px');
  }
  el.style.scrollBehavior = 'auto'; el.scrollLeft = prevScroll; el.style.scrollBehavior = '';
  if (scrollToPlayable && myTurn) {
    scrollToPlayable = false;
    const first = el.querySelector('.hcard.ok');
    if (first && (first.offsetLeft < el.scrollLeft || first.offsetLeft + w > el.scrollLeft + el.clientWidth)) el.scrollLeft = Math.max(0, first.offsetLeft - 24);
  }
  el.onscroll = updateHandEdges; updateHandEdges();
  $('#scrL').onclick = () => { el.scrollLeft -= el.clientWidth * 0.7; };
  $('#scrR').onclick = () => { el.scrollLeft += el.clientWidth * 0.7; };
  el.onclick = (e) => { const b = e.target.closest('.card'); if (b) tryPlay(+b.dataset.i, b); };
}
function tryPlay(i, el) {
  if (!G || G.status !== 'playing') return;
  const hand = G.hand || [], c = hand[i]; if (!c) return;
  if (G.order[G.turn] !== G.me) { toast('Wait for your turn'); return; }
  const ok = (!G.drew || i === hand.length - 1) && canPlay(c, { discard: [G.top], color: G.color, pending: G.pending });
  if (!ok) {
    if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
    toast(G.drew ? 'You can only play the card you just drew' : G.pending > 0 ? 'Stack a draw card or take the cards' : 'That card doesn’t match'); return;
  }
  if (el) lastTap = { rect: el.getBoundingClientRect(), at: Date.now() };
  if (cc(c) === 'w') {
    pendingWild = { i }; closeSheets();
    const held = { r: 0, y: 0, g: 0, b: 0 }; hand.forEach((x, k) => { if (k !== i && held[cc(x)] !== undefined) held[cc(x)]++; });
    const most = Math.max(...Object.values(held));
    $$('#picker button[data-col]').forEach((b) => { const k = held[b.dataset.col]; b.querySelector('small').textContent = k ? `You hold ${k}${k === most ? ' · most' : ''}` : 'You hold none'; b.classList.toggle('most', k > 0 && k === most); });
    $('#picker').hidden = false; $('#picker button[data-col]').focus(); return; }
  doPlay(i, null);
}
async function doPlay(i, col) { const r = await send('play', { i, color: col, called: armedCall }); if (r.ok) armedCall = false; }
$('#picker').addEventListener('click', (e) => { const b = e.target.closest('button[data-col]'); if (b && pendingWild) { const p = pendingWild; pendingWild = null; $('#picker').hidden = true; doPlay(p.i, b.dataset.col); } });

function renderActions() {
  const el = $('#actions'); if (!el || !G) return;
  if (G.status !== 'playing' || G.admin) { el.innerHTML = ''; return; }
  const meId = G.me, hand = G.hand || [], myTurn = G.order[G.turn] === meId, seated = G.order.includes(meId);
  const b = [];
  if (myTurn && G.drew) b.push('<button class="btn" data-a="pass">Pass</button>');
  if (myTurn && hand.length === 2) b.push(`<button class="btn call ${armedCall ? 'armed' : ''}" data-a="arm" aria-pressed="${armedCall}">${armedCall ? 'Last card! ✓' : 'Last card!'}${isWide() ? ' (L)' : ''}</button>`);
  if (G.unsafe === meId) b.push('<button class="btn call" data-a="late">Say Last card!</button>');
  if (seated && G.unsafe && G.unsafe !== meId) b.push(`<button class="btn catch" data-a="catch">Catch ${esc(nameOf(G.unsafe))} · +2</button>`);
  if (seated && !myTurn && turnLeft() === 0) b.push(`<button class="btn sm" data-a="skip">Skip ${esc(nameOf(G.order[G.turn]))}</button>`);
  el.innerHTML = b.join('');
  el.onclick = (e) => {
    const t = e.target.closest('button'); if (!t) return; const a = t.dataset.a;
    if (a === 'arm') toggleCall();
    else if (a === 'late') send('lateCall');
    else send(a);
  };
}
function toggleCall() { if (!G) return; const myTurn = G.order[G.turn] === G.me; if (!myTurn || (G.hand || []).length !== 2) return; armedCall = !armedCall; renderActions(); if (armedCall) toast('Called! Now play your card.', 'call'); }
setInterval(() => {
  if (view !== 'game' || !G || G.status !== 'playing') return;
  const c = $('#turnClock'); if (c) c.textContent = clockText(turnLeft());
  const hadSkip = !!$('#actions [data-a="skip"]'), needSkip = G.order.includes(G.me) && G.order[G.turn] !== G.me && turnLeft() === 0;
  if (hadSkip !== needSkip) renderActions();
}, 1000);

function overHTML() {
  const ps = G.order.slice().sort((a, b) => (G.wins[b] || 0) - (G.wins[a] || 0) || count(a) - count(b));
  if (G.practice) {
    const close = ps.find((u) => u !== G.winner && count(u) === 1);
    return `<div class="sheet" style="position:fixed"><div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="winT">
    <span class="grab" aria-hidden="true"></span>
    <div class="over-head">${av(G.winner, 'md')}<div><p class="eyebrow">Practice · round ${G.round || 1}</p><h2 id="winT">${G.winner === G.me ? 'You win!' : esc(nameOf(G.winner)) + ' wins!'}</h2>${close ? `<p class="note">${close === G.me ? 'You were' : esc(nameOf(close)) + ' was'} one card away</p>` : ''}</div></div>
    <ol class="standings">${ps.map((u) => `<li>${av(u, 'sm')}<span class="nm">${u === G.me ? 'You' : esc(nameOf(u)) + ' <small style="color:var(--muted);font-weight:600">computer</small>'}</span><span class="left">${count(u) ? count(u) + ' left' : 'out'}</span><span class="w">${G.wins[u] || 0} ★</span></li>`).join('')}</ol>
    <p class="note">Practice wins stay here. They don’t go on the leaderboard.</p>
    <button class="btn gold block" id="nextBtn" style="min-height:54px">Play again</button>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn light" id="prSetup">Change setup</button><button class="btn" id="prHome">Home</button></div>
  </div></div>`;
  }
  const askAlerts = pushSupported() && Notification.permission === 'default' && !load('lc-push-asked');
  const rec = recorded && recorded.round === G.round ? recorded : null;
  return `<div class="sheet" style="position:fixed"><div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="winT">
    <span class="grab" aria-hidden="true"></span>
    <div class="over-head">${av(G.winner, 'md')}<div><p class="eyebrow">Round ${G.round || 1} is over</p><h2 id="winT">${G.winner === G.me ? 'You win!' : esc(nameOf(G.winner)) + ' wins!'}</h2></div></div>
    ${rec ? `<div class="gold-box" style="display:flex;align-items:center;gap:10px;font-size:14px">${ICON.trophy}<span>+1 win for ${G.winner === G.me ? 'you' : esc(nameOf(G.winner))}${rec.rank ? ` · now <b>#${rec.rank}</b> on the leaderboard` : ''}</span></div>` : ''}
    ${chatPeekHTML()}
    ${askAlerts ? `<div class="alert-ask" id="alertAsk"><span class="t"><b>Get a nudge on your turn?</b><span>Only for your turn and round results.</span></span><button class="btn sm" id="alertNo">Not now</button><button class="btn sm light" id="alertYes">Turn on</button></div>` : ''}
    <ol class="standings">${ps.map((u) => `<li>${av(u, 'sm')}<span class="nm">${esc(nameOf(u))}${u === G.me ? ' (you)' : ''}</span><span class="left">${count(u) ? count(u) + ' left' : 'out'}</span><span class="w">${G.wins[u] || 0} ★</span></li>`).join('')}</ol>
    ${isHost() ? `<button class="btn gold block" id="nextBtn" style="min-height:54px">Deal round ${(G.round || 1) + 1}</button><p class="note" style="text-align:center">Anyone who joined meanwhile gets dealt in.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="endBtn">End game</button><button class="btn light" id="overBoard">Leaderboard</button></div>`
      : `${isOnline(G.host) ? `<p class="note" style="text-align:center;color:var(--soft)">Waiting for <b style="color:var(--ink)">${esc(nameOf(G.host))}</b> (host) to deal the next round</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="nudgeBtn">Nudge ${esc(nameOf(G.host))}</button><button class="btn light" id="overBoard">Leaderboard</button></div>` : `${hostWaitHTML('deal')}<button class="btn" id="overBoard">Leaderboard</button>`}`}
  </div></div>`;
}


/* ---------- admin ----------
   Only accounts named in ADMIN_NAMES on the server get this. Watching is silent: the server keeps
   admins out of the table's room and player list, and sends them the same view a watcher gets. */
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); return h < 48 ? h + 'h ' + (m % 60) + 'm' : Math.floor(h / 24) + 'd';
}
function showAdmin() {
  if (!me || !me.admin) { showHome(); return; }
  show('admin'); setHash('admin');
  if (admData) renderAdmin();
  admPoll();
}
async function admPoll() {
  clearTimeout(admTimer);
  if (view !== 'admin') return;
  const r = await send('adminOverview', {}, true);
  if (view !== 'admin') return;
  $('#admLive').classList.toggle('stale', !r.ok);
  $('#admLive span').textContent = r.ok ? 'Live · updates every 5 seconds' : 'Reconnecting…';
  if (r.ok) { admData = r; renderAdmin(); }
  else if (r.error === 'Not allowed.') { me.admin = false; showHome(); return; }
  admTimer = setTimeout(admPoll, 5000);
}
function admTableHTML(t) {
  const chip = t.status === 'playing' ? 'Round ' + t.round : t.status === 'over' ? 'Between rounds' : 'Lobby';
  const ps = t.players.map((p) => {
    const sub = t.status === 'playing' && !p.watching ? `${p.cards} card${p.cards === 1 ? '' : 's'}` : p.watching ? 'watching' : p.host ? 'host' : '';
    return `<li class="${p.turn ? 'turn' : ''}${p.watching ? ' w' : ''}">${avatarFor(p.name.toLowerCase(), p.name, { size: 'sm', online: p.online })}${esc(p.name)}${sub ? ` <small>${sub}</small>` : ''}</li>`;
  }).join('');
  let line;
  if (t.status === 'playing') {
    const tp = t.players.find((p) => p.turn);
    line = [tp ? `${esc(tp.name)}’s turn for ${ago(t.turnFor)}` : '', t.pending ? `+${t.pending} stacked` : '', `${t.deck} in deck`].filter(Boolean).join(' · ');
  } else if (t.status === 'over') line = `${esc(t.winner || 'Someone')} won round ${t.round} · waiting for ${esc(t.host)} to deal`;
  else line = `Hosted by ${esc(t.host)} · ${t.players.length} of 10 seated`;
  const meta = [`Open ${ago(t.openFor)}`, `Last move ${ago(t.idleFor)} ago`, t.requests ? `${t.requests} waiting to join` : '', t.approve ? 'Host approves joiners' : ''].filter(Boolean);
  return `<article class="adm-t" aria-label="Table ${esc(t.code)}">
    <div class="tc"><span class="code">${esc(t.code)}</span><span class="adm-chip s-${t.status}">${chip}</span></div>
    <div class="tm"><ul class="adm-ps" aria-label="Players">${ps}</ul><p class="line" style="margin:0">${line}</p>${t.last ? `<p class="line" style="margin:0;color:var(--muted)">${esc(fmt(t.last))}</p>` : ''}</div>
    <div class="ta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    <button class="btn light" data-watch="${esc(t.code)}" aria-label="Watch table ${esc(t.code)}">Watch</button>
  </article>`;
}
function renderAdmin() {
  const d = admData; if (!d) return;
  const L = d.live, S = d.stats;
  const card = (n, l, sub, hot) => `<div class="adm-card${hot ? ' hot' : ''}"><b>${n}</b><span>${l}</span><small>${sub || '&nbsp;'}</small></div>`;
  $('#admCards').innerHTML = card(L.playing, 'Games playing', L.over ? `${L.over} between rounds` : '', L.playing > 0)
    + card(L.lobby, 'In a lobby', 'waiting to deal')
    + card(L.online, 'Online now', 'signed in, app open')
    + card(L.atTables, 'At tables', L.watching ? `${L.watching} watching` : '')
    + card(L.waiting, 'Waiting to join', L.waiting ? 'needs the host’s OK' : '')
    + card(S ? S.rounds.today : '–', 'Rounds today', S ? `${S.rounds.week} this week` : '');
  $('#admTN').textContent = d.tables.length ? `${d.tables.length} open · busiest first` : '';
  $('#admTables').innerHTML = d.tables.length ? d.tables.map(admTableHTML).join('')
    : '<p class="adm-empty">No tables open right now. They show up here as soon as someone creates one.</p>';
  if (S) {
    const row = (l, o, all) => `<tr><th scope="row">${l}</th><td>${o.today}</td><td>${o.week}</td><td>${all === undefined ? o.all : all}</td></tr>`;
    const max = Math.max(1, ...S.rounds.per);
    const bars = S.days.map((day, i) => {
      const n = S.rounds.per[i], isToday = i === S.days.length - 1;
      const lab = isToday ? 'Today' : new Date(day + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
      return `<div class="${isToday ? 'today' : ''}"><b>${n}</b><i style="height:${Math.round((n / max) * 80)}%"></i><small>${lab}</small></div>`;
    }).join('');
    $('#admUsage').innerHTML = `<table class="adm-use"><thead><tr><th scope="col"><span class="sr">Metric</span></th><th scope="col">Today</th><th scope="col">7 days</th><th scope="col">All time</th></tr></thead><tbody>
      ${row('Rounds finished', S.rounds)}${row('Rounds dealt', S.deals)}${row('Active players', S.active, Math.max(S.players, S.active.week))}${row('New players', S.signups)}${row('Practice games', S.practice)}
      </tbody></table>
      <p class="note" style="margin:14px 0 0">Rounds finished, last 7 days</p>
      <div class="adm-bars" role="img" aria-label="Rounds finished per day: ${S.rounds.per.join(', ')}">${bars}</div>`;
  } else $('#admUsage').innerHTML = '<p class="note">Usage numbers need the account store. It isn’t reachable right now.</p>';
  $('#admTop').innerHTML = (d.top || []).length ? d.top.map((x, i) => `<li><span class="r">${i + 1}</span>${avatarFor(x.name.toLowerCase(), x.name, { size: 'sm' })}<span class="n">${esc(x.name)}</span><span>${x.wins} win${x.wins === 1 ? '' : 's'}</span></li>`).join('')
    : '<li class="note">No wins yet this week.</li>';
  const sv = d.server;
  $('#admServer').innerHTML = `<p>Up ${ago(sv.uptime * 1000)} · build ${esc(String(sv.build || '').slice(0, 10))}</p><p>Memory ${Math.round(sv.mem / 1048576)} MB · ${sv.sockets} connection${sv.sockets === 1 ? '' : 's'}</p><p>Tables ${sv.saved ? 'saved to Key Value' : 'in memory only'} · accounts ${sv.accounts ? 'saved' : 'in memory only'}</p>`;
  admSetTab(admTab);
  admAlertsUI(d.alerts || 'start');
}
function admAlertsUI(v) {
  $$('.adm-alerts [data-alert]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.alert === v)));
  const pushOn = pushSupported() && Notification.permission === 'granted' && load('lc-push') === 'on';
  $('#admAlertNote').textContent = v === 'off' ? 'No alerts about new games.'
    : pushOn ? 'A pop-up while the app is open, a phone alert when it isn’t.'
    : pushSupported() ? 'Pop-ups only while the app is open. Tap your choice again to allow phone alerts.'
    : 'Pop-ups only while the app is open. Install the app to get phone alerts.';
}
$('.adm-alerts').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-alert]'); if (!b) return;
  const v = b.dataset.alert; admAlertsUI(v);
  const r = await send('adminPref', { alerts: v });
  if (r.ok && admData) admData.alerts = r.alerts;
  if (v !== 'off' && pushSupported() && !(Notification.permission === 'granted' && load('lc-push') === 'on')) await enablePush();
  admAlertsUI(r.ok ? r.alerts : v);
});
socket.on('adminAlert', (m) => {
  if (!m || !me || !me.admin) return;
  if (view === 'admin') admPoll();
  Snd.play('chat');
  toast('', 'admalert', `<span>${esc(m.text)}</span><button class="linkbtn" data-adm-watch="${esc(m.code)}">Watch</button>`);
});
$('#toasts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-adm-watch]'); if (!b) return;
  b.closest('.toast').remove();
  if (practice) endPractice();
  else if (curCode && curCode !== adminWatching) send('away', {}, true);
  adminWatch(b.dataset.admWatch);
});
function admSetTab(tab) {
  admTab = tab;
  $$('.adm-tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('#admin .adm-sec').forEach((s) => s.classList.toggle('on', s.dataset.sec === tab));
}
$('.adm-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) admSetTab(b.dataset.tab); });
$('#admTables').addEventListener('click', (e) => { const b = e.target.closest('[data-watch]'); if (b) adminWatch(b.dataset.watch); });
$('#admBack').onclick = () => showHome();
$('#adminBtn').onclick = () => showAdmin();
$('#gAdmBack').onclick = () => showAdmin();

async function adminWatch(code) {
  const r = await send('adminWatch', { code });
  if (!r.ok) { if (view === 'admin') admPoll(); else showAdmin(); return; }
  clearTimeout(admTimer);
  adminWatching = r.code;
  curCode = r.code; G = null; seenV = -1; lastTopV = -1; armedCall = false; chatMsgs = []; unread = 0; recorded = null; updateBadge();
  show('game'); setHash('admin');
  document.body.classList.add('adminwatch'); $('#gAdmBack').hidden = false; $('#gAdmTag').hidden = false;
  $('#gCode').textContent = r.code;
  onState(r.view);
}
function adminLeave() {
  if (!adminWatching) return;
  adminWatching = null; curCode = null; G = null;
  send('adminUnwatch', {}, true);
  document.body.classList.remove('adminwatch'); $('#gAdmBack').hidden = true; $('#gAdmTag').hidden = true;
}
function adminNext() {
  const list = ((admData && admData.tables) || []).filter((t) => t.code !== adminWatching);
  const next = list.find((t) => t.status === 'playing') || list[0];
  if (next) adminWatch(next.code); else toast('No other tables are open.');
}
socket.on('adminState', (m) => { if (m && adminWatching && m.code === adminWatching && view === 'game') onState(m.view); });
socket.on('adminEnded', (m) => { if (m && m.code === adminWatching) { toast(`Table ${m.code} closed`); showAdmin(); } });
function adminPanelHTML() {
  const w = watchers();
  const ps = G.order.slice().sort((a, b) => (G.wins[b] || 0) - (G.wins[a] || 0) || count(a) - count(b));
  const top = G.status === 'over'
    ? `<p><b style="color:var(--ink)">${esc(nameOf(G.winner))}</b> won round ${G.round || 1}. Waiting for ${esc(nameOf(G.host))} to deal the next one.</p>
       <ol class="standings">${ps.map((u) => `<li>${av(u, 'sm')}<span class="nm">${esc(nameOf(u))}</span><span class="left">${count(u) ? count(u) + ' left' : 'out'}</span><span class="w">${G.wins[u] || 0} ★</span></li>`).join('')}</ol>`
    : '<p>Nobody at this table can see you. You see what a watcher sees: the table, card counts and every move, but not anyone’s cards.</p>';
  return `<section class="watch-panel adm-view" aria-label="Admin view">
    <div class="wtop"><span class="pill" role="status"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10 10 0 0 1 12 19c-6.4 0-10-7-10-7a18 18 0 0 1 4.1-5M9.9 5.2A9 9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-2.2 3.2M2 2l20 20"/></svg>Admin view</span><span class="note">${G.order.length} playing${w.length ? ` · ${w.length} watching` : ''}</span></div>
    ${top}
    <div class="row2"><button class="btn light" id="wpAdmBack">Back to admin</button><button class="btn" id="wpNext">Next table</button></div>
  </section>`;
}
function renderAdminLobby() {
  const ps = G.players;
  $('#gMain').innerHTML = `<div class="adm-lob">
    <section class="watch-panel adm-view" aria-labelledby="admLobH">
      <div class="wtop"><span class="pill" role="status">Lobby</span><span class="note">${ps.length} of 10 seated</span></div>
      <h2 id="admLobH" style="margin:0;font-size:18px">Waiting for ${esc(nameOf(G.host))} to deal</h2>
      <ul class="plist">${ps.map((p) => `<li>${av(p.id, '', true)}<span class="nm">${esc(p.name)}</span><span class="tag">${p.id === G.host ? 'Host' : p.online ? 'Ready' : 'Away'}</span></li>`).join('')}</ul>
      <p class="note">The round shows here as soon as it starts. Nobody can see you.</p>
      <div class="row2"><button class="btn light" id="wpAdmBack">Back to admin</button><button class="btn" id="wpNext">Next table</button></div>
    </section></div>`;
  wireWatchPanel();
}

/* ---------- practice vs computer ----------
   The whole game runs here on the phone with the same rules engine as the server, so it works
   offline and never touches the leaderboard. Computer players think for a moment before playing. */
const PRACTICE = 'PRACTICE';
// engine.js puts its rules on the page as plain functions; gather the ones practice needs
const E = { dealRound, applyPlay, applyDraw, applyPass, applyCatch, applyLateCall, applySkipIdle, canPlay, cc, cv, nextUid };
const BOT_NAMES = ['Pixel', 'Bolt', 'Echo', 'Nova', 'Ziggy'];
const LEVEL_NOTE = {
  easy: 'Plays the first card it can. Sometimes forgets to call Last card.',
  normal: 'Saves its Wilds and +4s for when they matter, and remembers to call Last card.',
  sharp: 'Like Normal, and goes after whoever is close to winning. Catches you if you forget to call.',
};
let practice = null;
let prOpts = (() => { try { return Object.assign({ n: 3, level: 'normal', stack: true, drawUntil: false, coach: !load('lc-coach-done') }, JSON.parse(load('lc-practice') || '{}')); } catch (e) { return { n: 3, level: 'normal', stack: true, drawUntil: false, coach: true }; } })();
if (!load('lc-coach-done') && prOpts.coach === false) prOpts.coach = false;
function openPracticeSetup() {
  closeSheets();
  const paint = () => {
    $('#prN').textContent = prOpts.n;
    $('#prBots').innerHTML = BOT_NAMES.slice(0, prOpts.n).map((n) => avatarFor(n.toLowerCase(), n, { size: 'sm' })).join('');
    $$('#prLevel [data-lv]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lv === prOpts.level)));
    $('#prLvNote').textContent = LEVEL_NOTE[prOpts.level];
    $$('#practice [data-pr]').forEach((b) => b.setAttribute('aria-pressed', String(!!prOpts[b.dataset.pr])));
    $('#prMinus').disabled = prOpts.n <= 1; $('#prPlus').disabled = prOpts.n >= 5;
  };
  $('#prMinus').onclick = () => { prOpts.n = Math.max(1, prOpts.n - 1); paint(); };
  $('#prPlus').onclick = () => { prOpts.n = Math.min(5, prOpts.n + 1); paint(); };
  $('#prLevel').onclick = (e) => { const b = e.target.closest('[data-lv]'); if (b) { prOpts.level = b.dataset.lv; paint(); } };
  $$('#practice [data-pr]').forEach((b) => { b.onclick = () => { prOpts[b.dataset.pr] = !prOpts[b.dataset.pr]; paint(); }; });
  $('#prStart').onclick = () => { store('lc-practice', JSON.stringify(prOpts)); closeSheets(); startPractice(); };
  paint();
  $('#practice').hidden = false;
}
// practice runs on the phone; just tell the server a game happened so the admin page can count it
function practiceStat() { try { if (socket.connected) socket.emit('practiceStat', {}, () => {}); } catch (e) {} }
function startPractice() {
  adminLeave();
  if (curCode && curCode !== PRACTICE) send('away', {}, true);
  const bots = BOT_NAMES.slice(0, prOpts.n).map((name, i) => ({ id: 'bot' + i, name }));
  const s = { code: PRACTICE, host: 'you', status: 'lobby', settings: { stack: !!prOpts.stack, drawUntil: !!prOpts.drawUntil }, v: 0, wins: {}, round: 0, order: [], hands: {}, deck: [], discard: [], log: [] };
  practice = { s, bots, level: prOpts.level, coach: !!prOpts.coach, seen: new Set(), hint: null, timer: null, extra: [] };
  curCode = PRACTICE; G = null; seenV = -1; lastTopV = -1; armedCall = false; chatMsgs = []; unread = 0; recorded = null;
  show('game'); setHash(''); $('#gCode').textContent = 'Practice';
  E.dealRound(s, ['you', ...bots.map((b) => b.id)]); s.v++;
  practiceStat();
  practiceEmit();
}
function endPractice() {
  if (!practice) return;
  clearTimeout(practice.timer); practice.extra.forEach(clearTimeout);
  practice = null; hideCoach();
  if (curCode === PRACTICE) { curCode = null; G = null; }
}
function practiceView() {
  const s = practice.s, counts = {};
  for (const [u, h] of Object.entries(s.hands)) counts[u] = h.length;
  return {
    code: PRACTICE, me: 'you', host: 'you', status: s.status, settings: s.settings, round: s.round, v: s.v,
    players: [{ id: 'you', name: me ? me.name : 'You', online: true }, ...practice.bots.map((b) => ({ id: b.id, name: b.name, online: true, bot: true }))],
    gone: {}, order: s.order.slice(), turn: s.turn, dir: s.dir, pending: s.pending || 0, drew: !!s.drew, color: s.color,
    top: s.discard[s.discard.length - 1] || null, pile: s.discard.length, deckCount: s.deck.length, counts, hand: (s.hands.you || []).slice(),
    unsafe: s.unsafe || null, turnAt: s.turnAt || 0, winner: s.winner || null, wins: Object.assign({}, s.wins), log: s.log.slice(-6),
    now: Date.now(), requests: [], practice: { level: practice.level },
  };
}
function practiceEmit() {
  if (!practice) return;
  onState(practiceView());
  practiceSchedule();
}
function practiceAct(ev, d) {
  if (!practice) return { ok: false };
  const s = practice.s;
  let ok = false;
  if (ev === 'play') ok = E.applyPlay(s, 'you', d.i, d.color, !!d.called);
  else if (ev === 'draw') ok = E.applyDraw(s, 'you');
  else if (ev === 'pass') ok = E.applyPass(s, 'you');
  else if (ev === 'lateCall') ok = E.applyLateCall(s, 'you', s.unsafeV);
  else if (ev === 'catch') ok = !!s.unsafe && s.unsafe !== 'you' && E.applyCatch(s, 'you', s.unsafe, s.unsafeV);
  else if (ev === 'start') { if (s.status !== 'playing') { E.dealRound(s, ['you', ...practice.bots.map((b) => b.id)]); ok = true; practiceStat(); } }
  else if (ev === 'away' || ev === 'leave') { endPractice(); return { ok: true }; }
  else return { ok: false };
  if (ok) { s.v++; practiceEmit(); }
  return { ok: !!ok };
}
// what a computer player does on its turn
function botChoose(id) {
  const s = practice.s, h = s.hands[id], lvl = practice.level;
  const idx = h.map((c, i) => i).filter((i) => (!s.drew || i === h.length - 1) && E.canPlay(h[i], s));
  if (!idx.length) return null;
  if (lvl === 'easy') return idx[Math.floor(Math.random() * idx.length)];
  const next = E.nextUid(s), nextLeft = (s.hands[next] || []).length;
  const v = (i) => E.cv(h[i]), wild = (i) => E.cc(h[i]) === 'w';
  const score = (i) => {
    let sc = 0;
    if (wild(i)) sc -= h.length > 3 ? 30 : 5;                       // keep Wilds for later
    if ('SRD'.includes(v(i))) sc += lvl === 'sharp' && nextLeft <= 2 ? 40 : 8;
    if (v(i) === 'F') sc += lvl === 'sharp' && nextLeft <= 2 ? 45 : 0;
    if (/\d/.test(v(i))) sc += Number(v(i));                         // shed high numbers first
    if (E.cc(h[i]) === s.color) sc += 3;
    return sc + Math.random();
  };
  return idx.sort((a, b) => score(b) - score(a))[0];
}
function botColour(id, playIdx) {
  const h = practice.s.hands[id], n = { r: 0, y: 0, g: 0, b: 0 };
  h.forEach((c, i) => { if (i !== playIdx && n[E.cc(c)] !== undefined) n[E.cc(c)]++; });
  const best = Object.keys(n).sort((a, b) => n[b] - n[a])[0];
  return practice.level === 'easy' && Math.random() < 0.4 ? 'rygb'[Math.floor(Math.random() * 4)] : best;
}
function botMove(id) {
  if (!practice) return;
  const s = practice.s;
  if (s.status !== 'playing' || s.order[s.turn] !== id) return;
  const i = botChoose(id);
  let ok;
  if (i === null) ok = s.drew ? E.applyPass(s, id) : E.applyDraw(s, id);
  else {
    const h = s.hands[id];
    const willCall = h.length === 2 && (practice.level !== 'easy' || Math.random() < 0.6);
    ok = E.applyPlay(s, id, i, E.cc(h[i]) === 'w' ? botColour(id, i) : undefined, willCall);
  }
  if (!ok) ok = E.applyDraw(s, id) || E.applyPass(s, id) || E.applySkipIdle(s, id);
  s.v++; practiceEmit();
}
function practiceSchedule() {
  if (!practice) return;
  clearTimeout(practice.timer);
  const s = practice.s;
  if (s.status !== 'playing') return;
  const cur = s.order[s.turn];
  if (cur !== 'you') practice.timer = setTimeout(() => botMove(cur), (s.drew ? 500 : 850) + Math.random() * 650);
  // someone forgot to call Last card: computers catch you (or fix their own slip) after a moment
  if (s.unsafe && !practice.extra.unsafeTag) {
    const tag = s.unsafe + ':' + s.unsafeV; practice.extra.unsafeTag = tag;
    const who = s.unsafe, v = s.unsafeV, lvl = practice.level;
    const chance = who === 'you' ? { easy: 0.25, normal: 0.6, sharp: 0.95 }[lvl] : 0.5;
    const wait = who === 'you' ? (lvl === 'sharp' ? 2200 : 3500) : 4500;
    practice.extra.push(setTimeout(() => {
      practice && (practice.extra.unsafeTag = null);
      if (!practice || practice.s.unsafe !== who || practice.s.unsafeV !== v || Math.random() > chance) return;
      const st = practice.s;
      const ok = who === 'you' ? E.applyCatch(st, practice.bots[Math.floor(Math.random() * practice.bots.length)].id, who, v) : E.applyLateCall(st, who, v);
      if (ok) { st.v++; practiceEmit(); }
    }, wait));
  }
}

/* ---------- practice coach: one short tip at a time, each only once ---------- */
const COACH = [
  ['late', (G, my) => G.unsafe === G.me, () => 'You didn’t call! Tap “Say Last card!” quickly, before someone catches you.'],
  ['catch', (G) => G.unsafe && G.unsafe !== G.me, (G) => `${nameOf(G.unsafe)} forgot to call Last card! Tap Catch to give them 2 cards.`],
  ['stack', (G, my) => my && G.pending > 0, (G) => `A +${G.pending} is coming at you. Play your own +2 or +4 to pass it on, or tap Draw to take them.`],
  ['last', (G, my) => my && G.hand.length === 2 && !armedCall, () => 'Two cards left! Tap “Last card!” first, then play. Forget, and you can be caught for +2.'],
  ['drawn', (G, my) => my && G.drew, () => 'You drew a card. Play it if it glows, or tap Pass to keep it.'],
  ['draw', (G, my, ok) => my && !G.drew && !G.pending && !ok, () => 'Nothing matches the pile. Tap Draw to take a card.'],
  ['match', (G, my, ok) => my && ok, () => 'Match the pile’s colour or number. The glowing cards are the ones you can play.'],
  ['wild', (G, my, ok) => my && G.hand.some((c) => E.cc(c) === 'w') && ok, () => 'Wild cards go on anything. You’ll pick the next colour.'],
];
function hideCoach() { const c = $('#coach'); if (c) c.hidden = true; }
function coachUpdate() {
  if (!practice || !practice.coach || !G || G.status !== 'playing' || view !== 'game') { hideCoach(); return; }
  const my = G.order[G.turn] === G.me;
  const R = { discard: [G.top], color: G.color, pending: G.pending };
  const ok = (G.hand || []).some((c, i) => (!G.drew || i === G.hand.length - 1) && E.canPlay(c, R));
  const cur = practice.hint && COACH.find((h) => h[0] === practice.hint);
  if (cur && cur[1](G, my, ok)) return placeCoach();
  practice.hint = null;
  const next = COACH.find((h) => !practice.seen.has(h[0]) && h[1](G, my, ok));
  if (!next) { hideCoach(); if (practice.seen.size >= 5) store('lc-coach-done', '1'); return; }
  practice.hint = next[0]; practice.seen.add(next[0]);
  $('#coachText').textContent = next[2](G);
  $('#coach').hidden = false; placeCoach();
}
function placeCoach() {
  const hw = $('#handwrap'), c = $('#coach');
  if (!c) return;
  if (!hw) { c.style.bottom = '24px'; return; }
  const r = hw.getBoundingClientRect();
  c.style.bottom = Math.max(8, window.innerHeight - r.top + 10) + 'px';
  if (isWide()) { c.style.left = r.left + 'px'; c.style.right = 'auto'; c.style.maxWidth = Math.min(520, r.width) + 'px'; } else { c.style.left = '12px'; c.style.right = '12px'; c.style.maxWidth = ''; }
}
$('#coachOk').onclick = () => { hideCoach(); if (practice) practice.hint = null; };

/* ---------- keyboard (desktop) ---------- */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSheets(); $('#chat').classList.remove('open'); pendingWild = null; return; }
  if (view !== 'game' || !G || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (SHEETS.some((id) => !$('#' + id).hidden)) return;
  const k = e.key.toLowerCase();
  if (k === 'c') { e.preventDefault(); if (isWide()) $('#chatInp').focus(); else $('#chatBtn').click(); }
  if (G.status !== 'playing') return;
  if (/^[1-9]$/.test(k)) { const i = handOrder[Number(k) - 1]; if (i !== undefined) { const el = $(`#hand .card[data-i="${i}"]`); tryPlay(i, el); } }
  else if (k === 'd') doDraw();
  else if (k === 'l') toggleCall();
  else if (k === 'p' && G.drew && G.order[G.turn] === G.me) send('pass');
});
let lastWide = isWide();
window.addEventListener('resize', () => { const w = isWide(); if (w !== lastWide) { lastWide = w; if (view === 'board') showBoard(boardFrom); } if (view === 'game' && G && G.status !== 'lobby') render(); });

/* ---------- first paint ---------- */
if (hashCode()) {
  show('invite');
  $('#inviteBody').innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a><div class="inv-hero"><p class="eyebrow">You’re invited</p><h1 style="letter-spacing:.14em">${esc(hashCode())}</h1><p class="note" id="invWait">Opening the table…</p></div>`;
} else {
  $('#acctBtn').className = 'acct out'; $('#acctBtn').textContent = 'Sign in';
}
})();
