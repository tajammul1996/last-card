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
let view = 'home', curCode = null, G = null, boardFrom = 'home', boardGame = 'all', boardPeriod = 'week';
let armedCall = false, seenV = -1, lastTopV = -1, pendingWild = null, scrollToPlayable = false;
let chatMsgs = [], unread = 0, afterSignIn = null, recorded = null;
const socket = io({ transports: ['websocket', 'polling'] });

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
  return `<span class="av ${opts.size || ''}" style="background:hsl(${hue(key || name)} 45% 38%)" aria-hidden="true">${esc(String(name || '?').trim().charAt(0).toUpperCase() || '?')}${dot}</span>`;
}
function playerOf(u) { return G && G.players.find((p) => p.id === u); }
function nameOf(u) { const p = playerOf(u); return p ? p.name : (G && G.gone && G.gone[u]) || 'Player'; }
function isOnline(u) { const p = playerOf(u); return !!(p && p.online); }
function isHost() { return !!G && G.host === G.me; }
function av(u, size, withDot) { return avatarFor(nameOf(u).toLowerCase(), nameOf(u), { size, online: withDot ? isOnline(u) : undefined }); }
function fmt(msg) { return String(msg).replace(/\{\{([^}]+)\}\}/g, (_, u) => nameOf(u)); }
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
  setTimeout(() => el.remove(), kind === 'win' ? 4200 : kind === 'chat' ? 4000 : 2800);
}
function cardHTML(c, o) {
  o = o || {};
  const col = cc(c), v = cv(c), wild = col === 'w', lab = label(c), tag = o.tag || 'div', ul = v === '6' || v === '9' ? ' ul' : '';
  const mid = wild ? (v === 'F' ? '+4' : '') : lab;
  return `<${tag} class="card ${o.cls || ''}" style="--w:${o.w || 64}px;--c:${CVAR[col]}" ${o.attrs || ''} aria-label="${esc(o.aria || cardName(c))}"><span class="face"><span class="oval ${wild ? 'oval-wild' : ''}"></span><span class="mid${wild ? ' mid-wild' : ''}${ul}">${esc(mid)}</span>${wild && v !== 'F' ? '<span class="corner tl"><i class="wdot"></i></span><span class="corner br"><i class="wdot"></i></span>' : `<span class="corner tl${ul}">${esc(lab)}</span><span class="corner br${ul}">${esc(lab)}</span>`}</span></${tag}>`;
}
function backHTML(w, cls) { return `<div class="card back ${cls || ''}" style="--w:${w}px"><span class="face"><span class="oval"></span><span class="wordmark">Last<br>Card</span></span></div>`; }

/* ---------- server calls ---------- */
function send(ev, data, quiet) {
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
const SHEETS = ['signin', 'picker', 'menu', 'rules', 'howto'];
function closeSheets(except) { for (const id of SHEETS) if (id !== except) $('#' + id).hidden = true; $('#reactPop').hidden = true; }
function show(v) {
  view = v;
  document.body.classList.toggle('in-game', v === 'game');
  for (const id of ['home', 'invite', 'board', 'game']) $('#' + id).hidden = id !== v;
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
  me = { name: r.name }; session = r.session; store('lc-session', session); store('lc-nick', r.name); last = r.last || last; authMode = 'back';
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
function rerender() { if (view === 'home') showHome(); else if (view === 'invite' && inviteInfo) showInvite(inviteInfo); else if (view === 'board') showBoard(boardFrom); else render(); }

/* ---------- connection ---------- */
socket.on('connect', async () => {
  $('#conn').hidden = true;
  const r = await send('hello', { token, session }, true);
  if (r.build) { if (!build) build = r.build; else if (r.build !== build) $('#updateBar').hidden = false; }
  if (r.ok) { me = r.account || null; if (!r.sessionValid) { session = ''; store('lc-session', ''); } last = r.last || null; }
  ready = true; $('#homeNote').textContent = '';
  if (view === 'game' && curCode && !hashCode()) setHash(curCode);
  route();
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
  const text = m.type === 'joined' ? `${m.name} joined the table${m.status === 'lobby' ? '' : ' · dealt in next round'}` : `${m.name} left the table`;
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
$('#acctBtn').onclick = () => openSignIn();
async function refreshLast() { const r = await send('hello', { token, session }, true); if (r.ok) last = r.last || null; }
function showHome() {
  show('home'); setHash('');
  const ab = $('#acctBtn');
  if (me) { ab.className = 'acct'; ab.innerHTML = avatarFor(me.name.toLowerCase(), me.name) + esc(me.name); ab.setAttribute('aria-label', 'Your account, ' + me.name); }
  else { ab.className = 'acct out'; ab.textContent = 'Sign in'; ab.removeAttribute('aria-label'); }
  $('#greet').textContent = me ? `Ready for a round, ${me.name}?` : 'Ready for a round?';
  $('#homeErr').textContent = '';
  const box = $('#rejoinBox');
  if (last) {
    const what = last.status === 'playing' ? (last.yourTurn ? 'It’s your turn' : `Round ${last.round || 1} in progress`) : last.status === 'over' ? 'Round over' : 'Waiting in the lobby';
    const sub = last.players && last.players.length ? 'with ' + listNames(last.players.slice(0, 3)) + (last.players.length > 3 ? ` +${last.players.length - 3}` : '') : 'Just you so far';
    box.innerHTML = `<button class="rejoin" id="rejoinBtn"><span class="mini" aria-hidden="true"><i>7</i></span><span class="tx"><small>${last.status === 'lobby' ? 'Your table' : 'Game in progress'} · ${esc(last.code)}</small><b>${esc(what)}</b><span>${esc(sub)}</span></span><span class="go">Rejoin →</span></button>`;
    $('#rejoinBtn').onclick = () => openTable(last.code);
  } else box.innerHTML = '';
  loadHomeBoard();
}
async function loadHomeBoard() {
  const r = await send('leaderboard', { game: 'all', period: 'all', limit: 5 }, true);
  if (!r.ok) return;
  const mine = r.mine, top = r.rows;
  const lead = top[0];
  $('#myRank').innerHTML = mine
    ? `<b>#${mine.rank}</b><span>You · <strong style="color:var(--ink)">${mine.wins} win${mine.wins === 1 ? '' : 's'}</strong> in ${mine.played} game${mine.played === 1 ? '' : 's'}${lead && lead.name !== mine.name ? `<br>${lead.wins - mine.wins === 0 ? 'Level with ' + esc(lead.name) : (lead.wins - mine.wins) + ' behind ' + esc(lead.name)}` : mine.rank === 1 ? '<br>You’re on top' : ''}</span>`
    : `<span>${me ? 'Finish a round to get on the board.' : 'Sign in and finish a round to get on the board.'}</span>`;
  $('#topList').innerHTML = top.length ? top.map((x) => `<li class="${x.me ? 'me' : ''}"><span class="rk">${x.rank}</span><span class="nm">${esc(x.name)}${x.me ? ' (you)' : ''}</span><span class="w">${x.wins}</span></li>`).join('') : '<li><span class="nm" style="color:var(--muted)">No wins yet. Be the first.</span></li>';
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
  const status = info.status === 'lobby' ? 'waiting in the lobby' : info.status === 'playing' ? `round ${info.round} in progress, you’ll join next round` : 'between rounds';
  const others = info.players.filter((n) => n !== host);
  body.innerHTML = `
    <a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="inv-hero">
      <span class="host">${avatarFor(host.toLowerCase(), host, { size: 'lg' })}<em>Host</em></span>
      <h1>${esc(host)} invited you<br>to play Last Card</h1>
      <p class="note" style="font-size:15px">Table <b style="color:var(--ink);letter-spacing:.12em">${esc(info.code)}</b> · ${esc(status)}</p>
    </div>
    <div class="inv-who">
      <div class="stack-av">${info.players.slice(0, 6).map((n) => avatarFor(n.toLowerCase(), n)).join('')}</div>
      <p class="note" style="font-size:15px;color:var(--soft)">${info.players.length === 1 ? `${esc(host)} is at the table` : `${esc(listNames(info.players.slice(0, 4)))}${info.players.length > 4 ? ` and ${info.players.length - 4} more` : ''} are at the table`}</p>
    </div>
    <div class="inv-foot">
      ${me ? `<div class="idchip">${avatarFor(me.name.toLowerCase(), me.name, { size: 'sm' })}<span class="tx">Joining as<b>${esc(me.name)}</b></span><button class="linkbtn" id="invSwitch">Not you?</button></div>` : ''}
      <button class="btn gold block" id="invJoin" style="min-height:58px;font-size:18px" ${info.full ? 'disabled' : ''}>${info.full ? 'This table is full' : `Join ${esc(host)}’s table`}</button>
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
    else if (r.needLogin) { me = null; openSignIn(() => $('#invJoin').click()); }
    else if ($('#invErr')) $('#invErr').textContent = r.error || 'Couldn’t join. Try again.';
  });
}

/* ---------- leaderboard ---------- */
async function showBoard(from) {
  boardFrom = from || 'home'; show('board');
  if (boardFrom === 'home') setHash('leaderboard');
  $$('#lbPeriod button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.period === boardPeriod)));
  $('#lbRows').innerHTML = '<li class="lbrow"><span></span><span class="nm"><b>Loading…</b></span><span></span></li>';
  const r = await send('leaderboard', { game: boardGame, period: boardPeriod, limit: 50 }, true);
  if (view !== 'board') return;
  if (!r.ok) { $('#lbRows').innerHTML = '<li class="lbrow"><span></span><span class="nm"><b>Couldn’t load the leaderboard. Try again.</b></span><span></span></li>'; return; }
  const games = Object.assign({ all: 'All games' }, r.games || {});
  $('#lbGames').innerHTML = Object.entries(games).map(([k, v]) => `<button data-g="${esc(k)}" aria-pressed="${k === r.game}">${esc(v)}</button>`).join('');
  const pct = (x) => (x.played ? Math.round((100 * x.wins) / x.played) : 0) + '%';
  const nm = (x) => esc(x.name) + (x.me ? ' (you)' : '');
  const top = r.rows.slice(0, 3);
  const order = top.length === 3 && !isWide() ? [1, 0, 2] : top.map((_, i) => i);
  $('#podium').innerHTML = order.map((i) => {
    const x = top[i];
    return `<div class="pod p${i + 1}"><span class="rkn">${i + 1}</span>${avatarFor(x.name.toLowerCase(), x.name, { size: i === 0 ? 'md' : '' })}<span class="nm">${nm(x)}</span><span class="dnm"><b>${nm(x)}</b><small>${x.played} games · ${pct(x)} won</small></span><span class="dw">${x.wins}</span><div class="blk"><b>${x.wins}</b><small>win${x.wins === 1 ? '' : 's'}</small></div></div>`;
  }).join('');
  const row = (x) => `<span class="rk">${x.rank}</span><span class="nm"><b>${nm(x)}</b><small>${x.played} game${x.played === 1 ? '' : 's'} · ${pct(x)} won</small></span><span class="w">${x.wins}</span><span class="xc">${x.played}</span><span class="xc">${pct(x)}</span><span class="xc last">${ago(x.last)}</span>`;
  const rest = isWide() ? r.rows : r.rows.slice(3);
  $('#lbRows').innerHTML = rest.length ? rest.map((x) => `<li class="lbrow ${x.me ? 'me' : ''}">${row(x)}</li>`).join('')
    : (r.rows.length ? '' : `<li class="lbrow"><span></span><span class="nm"><b>No wins ${boardPeriod === 'week' ? 'this week' : 'yet'}</b><small>Finish a round while signed in and you’ll show up here.</small></span><span></span></li>`);
  $('#lbRows').setAttribute('start', isWide() ? '1' : '4');
  const showMine = r.mine && (!isWide() || r.mine.rank > 8);
  $('#mineBar').hidden = !showMine;
  if (showMine) $('#mineRow').innerHTML = `<span class="rk" style="color:var(--gold)">#${r.mine.rank}</span><span class="nm"><b>You · ${esc(r.mine.name)}</b><small>${r.mine.played} games · ${pct(r.mine)} won</small></span><span class="w">${r.mine.wins}</span><span class="xc">${r.mine.played}</span><span class="xc">${pct(r.mine)}</span><span class="xc last">${ago(r.mine.last)}</span>`;
  $('#lbNote').textContent = (me ? '' : 'Sign in to get on the board. ') + 'A round counts when someone wins by playing their last card.' + (r.persistent ? '' : ' The leaderboard isn’t saved permanently yet, so it may reset.');
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
$('#menuBtn').onclick = () => { closeSheets(); renderMenu(); $('#menu').hidden = false; };
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
  const host = isHost();
  $('#menuTitle').textContent = 'Table ' + G.code;
  $('#soundBtn').setAttribute('aria-pressed', String(Snd.on));
  $('#menuNote').textContent = host ? 'You’re the host: you deal each round and can remove players.' : 'You can remove players who have gone offline so the game keeps moving.';
  const canEnd = host || !isOnline(G.host);
  const eb = $('#menuEnd'); eb.hidden = !canEnd;
  if (canEnd && !eb.dataset.wired) { eb.dataset.wired = '1'; wireEnd(eb); }
  $('#menuEndNote').hidden = !canEnd;
  $('#menuEndNote').textContent = host ? 'Ends the game for everyone, even mid-round. Wins so far are kept on the leaderboard.' : `${nameOf(G.host)} (host) is offline, so you can end the game for everyone.`;
  $('#menuPlayers').innerHTML = G.players.map((p) => {
    const inRound = G.status !== 'lobby' && G.order.includes(p.id);
    const btns = [];
    if (p.id !== G.me && host) btns.push(`<button class="btn sm" data-host="${esc(p.id)}">Make host</button>`);
    if (p.id !== G.me && (host || !p.online)) btns.push(`<button class="btn sm" data-rm="${esc(p.id)}">Remove</button>`);
    return `<li>${av(p.id, '', true)}<span class="nm">${esc(p.name)}${p.id === G.me ? ' (you)' : ''}${p.id === G.host ? ' · host' : ''}<br><small style="color:var(--muted);font-weight:500">${p.online ? 'Online' : 'Offline'} · ${inRound ? count(p.id) + ' cards' : 'Waiting for next round'}${p.signedIn ? '' : ' · not signed in'}</small></span>${btns.join('')}</li>`;
  }).join('');
}
$('#menuPlayers').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]'); if (rm) { rm.disabled = true; send('remove', { id: rm.dataset.rm }); return; }
  const mh = e.target.closest('[data-host]'); if (mh) { mh.disabled = true; send('makeHost', { id: mh.dataset.host }); }
});

/* ---------- chat ---------- */
function updateBadge() { refreshPeek(); const b = $('#chatBadge'); b.hidden = !unread; b.textContent = unread > 9 ? '9+' : String(unread); $('#chatBtn').setAttribute('aria-label', unread ? `Open chat, ${unread} unread` : 'Open chat'); }
function renderChat() {
  const box = $('#msgs');
  if (!chatMsgs.length) { box.innerHTML = '<p class="note" style="margin:auto 0 0">No messages yet. Say hi, or tap a quick reply below.</p>'; return; }
  const mine = G && G.me;
  box.innerHTML = chatMsgs.map((m) => {
    if (m.sys) return `<div class="msg sys">${esc(m.text)}</div>`;
    const hh = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<div class="msg ${m.by === mine ? 'mine' : ''}">${m.by === mine ? '' : `<span class="who">${esc(nameOf(m.by))}</span>`}<span class="txt">${esc(m.text)}</span><time>${esc(hh)}</time></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function openChat() { closeSheets(); $('#chat').classList.add('open'); unread = 0; updateBadge(); renderChat(); setTimeout(() => { $('#msgs').scrollTop = 1e6; $('#chatInp').focus({ preventScroll: true }); }, 0); }
$('#chatBtn').onclick = openChat;
// on the round-over sheet: the newest message, so people can sort out "one more?" without hunting for chat
const ICON_CHAT = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>';
function chatPeekHTML() {
  const last = chatMsgs.filter((m) => !m.sys).slice(-1)[0];
  const text = last ? `<b>${esc(last.by === (G && G.me) ? 'You' : nameOf(last.by))}:</b> ${esc(last.text)}` : 'One more round? Ask the table';
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
  const lg = (G.log || []).slice(-1)[0];
  if (view === 'game' && seenV >= 0 && lg && lg.v > seenV && (isWide() || ['call', 'catch', 'win'].includes(lg.kind))) toast(fmt(lg.msg), lg.kind);
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
  $('#gSub').textContent = (G.status === 'lobby' ? 'Lobby' : 'Round ' + (G.round || 1)) + ' · ' + (st.stack ? 'stacking on' : 'no stacking') + (st.drawUntil ? ' · draw until you can play' : '');
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
      <p class="eyebrow">${host ? 'Lobby · you’re the host' : 'Lobby · hosted by ' + esc(nameOf(G.host))}</p>
      <section class="card-box gold-box invite-card" aria-labelledby="invh" style="padding:16px;border-radius:20px">
        <h2 id="invh">Invite your friends</h2>
        <p class="note" style="color:var(--soft)">They open the link, tap Join and land right here.</p>
        <input class="inp linkbox" readonly value="${esc(inviteLink())}" aria-label="Invite link" style="font-size:15px">
        <div class="row"><button class="btn gold" id="shareBtn">${ICON.share}Share link</button><button class="btn" id="copyBtn" style="flex:0 0 auto">Copy</button></div>
      </section>
      <section aria-labelledby="plh" style="display:flex;flex-direction:column;gap:8px">
        <h2 id="plh" style="font-size:18px">At the table · ${ps.length} of 10</h2>
        <ul class="plist">${ps.map((p) => `<li>${av(p.id, '', true)}<span class="nm">${esc(p.name)}${p.id === G.me ? ' (you)' : ''}</span><span class="tag">${p.id === G.host ? 'Host' : p.online ? (p.signedIn ? 'Ready' : 'Not signed in') : 'Away'}</span></li>`).join('')}</ul>
      </section>
      <div class="rulesrow"><span><b style="color:var(--ink)">House rules:</b> ${esc(ruleText)}</span>${host ? '<button class="linkbtn" id="rulesBtn">Change</button>' : ''}</div>
    </div>
    <div class="dealbar">
      ${host ? `<p class="note">${ps.length < 2 ? 'You need at least 2 players to deal.' : 'Anyone who joins later is dealt in next round.'}</p><button class="btn light" id="startBtn" ${ps.length < 2 ? 'disabled' : ''}>${ps.length < 2 ? 'Waiting for players' : `Deal cards · ${ps.length} players`}</button>` : hostWaitHTML('deal the cards')}
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
function wireClaim() { $$('#gMain [data-claim]').forEach((b) => { b.onclick = () => send('claimHost'); }); }

/* ---------- table ---------- */
function turnLeft() { return Math.max(0, IDLE_SKIP_S - Math.floor((Date.now() - G.clockSkew - (G.turnAt || 0)) / 1000)); }
function clockText(sec) { return '0:' + String(sec).padStart(2, '0'); }
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
  const cw = wide ? 104 : small ? 62 : 72, dw = wide ? 92 : small ? 54 : 62;
  const ring = ringHTML(cw, dw, myTurn);
  lastTopV = G.v; flipRing = false;
  $('#gMain').innerHTML = `
    <div class="center" style="gap:8px;padding-top:4px">
      ${ring}
      <div class="status" role="status" style="min-height:0">${pill}<span class="hint2">${esc(hint)}</span></div>
    </div>
    <div class="actions" id="actions"></div>
    ${seated ? `<div class="handwrap" id="handwrap"><div class="handlabel"><span>Your hand · ${hand.length}</span><span id="swipeHint">${myTurn && G.status === 'playing' ? `<span class="play">${playable} playable</span>` : G.wins[meId] ? G.wins[meId] + '★ wins' : ''}</span></div><button class="scrollbtn l" id="scrL" aria-label="Scroll hand left" hidden>‹</button><div class="hand" id="hand"></div><button class="scrollbtn r" id="scrR" aria-label="Scroll hand right" hidden>›</button></div>`
      : '<div class="spect">You’re watching this round. You’ll be dealt in when the next round starts.</div>'}
    ${G.status === 'over' ? overHTML() : ''}`;
  renderActions();
  if (seated) renderHand(hand, myTurn, prevScroll, R);
  $('#drawPile').onclick = doDraw;
  const nb = $('#nextBtn'); if (nb) nb.onclick = () => send('start');
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
function queueHTML(myTurn) {
  const n = G.order.length, playing = G.status === 'playing', curU = G.order[G.turn];
  const ups = upNextOrder();
  const slots = Math.max(3, Math.floor((Math.min(window.innerWidth, 520) - 140) / 50));
  const shown = queueAll || ups.length <= slots ? ups : ups.slice(0, slots - 1);
  const more = ups.length - shown.length;
  const revTag = playing && n > 2 && revMark && revMark.round === G.round && revMark.turnAt === G.turnAt;
  const badge = (u) => `<span class="qct ${count(u) === 1 ? 'one' : ''}" aria-label="${count(u)} cards">${count(u)}</span>`;
  const sub = (u) => (!isOnline(u) ? 'Offline' : count(u) === 1 && playing ? 'Last card' : '');
  const items = shown.map((u) => `<li class="${u === G.me ? 'me' : ''} ${!isOnline(u) ? 'off' : ''}" data-u="${esc(u)}" aria-label="${u === G.me ? 'You' : esc(nameOf(u))}, ${count(u)} cards"><span class="qavw">${av(u, '', false)}${badge(u)}</span><span class="qn">${u === G.me ? 'You' : esc(nameOf(u))}</span><span class="qs ${count(u) === 1 ? 'warn' : ''}">${esc(sub(u))}</span></li>`).join('');
  const chip = more > 0 ? `<li class="chipli"><button class="qmore" id="qMore" aria-label="Show all ${n} players">+${more}</button></li>`
    : queueAll && ups.length > slots ? `<li class="chipli"><button class="qmore" id="qMore" aria-label="Show fewer">Less</button></li>` : '';
  const anim = flipRing ? 'flip' : qAdvance ? 'adv' : '';
  return `<section class="qstrip" aria-label="Turn order">
    <div class="qlabels"><span class="l1">Now</span><span class="l2">${n === 2 ? 'Then' : 'Up next'}</span>${revTag ? '<span class="qrev">⇄ Order reversed</span>' : ''}</div>
    <div class="qrow ${anim}">
      <div class="qnow ${!isOnline(curU) ? 'off' : ''}" id="qNow" data-u="${esc(curU)}"><span class="qavw">${av(curU, '', false)}${badge(curU)}</span><span class="qn">${curU === G.me ? 'You' : esc(nameOf(curU))}</span><span class="qs">${playing ? (myTurn ? 'Your turn' : isOnline(curU) ? `<span id="turnClock">${clockText(turnLeft())}</span> left` : 'Offline') : ''}</span></div>
      <span class="qsep" aria-hidden="true"><svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2l6 6-6 6"/></svg></span>
      <ol class="qlist">${items}${chip}</ol>
    </div>
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
      : '<div class="spect">You’re watching this round. You’ll be dealt in when the next round starts.</div>'}
    ${G.status === 'over' ? overHTML() : ''}`;
  lastTopV = G.v; flipRing = false; qAdvance = false;
  renderActions();
  if (seated) renderHand(hand, myTurn, prevScroll, R);
  $('#drawPile').onclick = doDraw;
  const qm = $('#qMore'); if (qm) qm.onclick = () => { queueAll = !queueAll; render(); };
  const nb = $('#nextBtn'); if (nb) nb.onclick = () => send('start');
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
        const o = p.querySelector('.oval');
        if (o) o.animate([{ transform: 'rotate(26deg) scaleX(.86)' }, { transform: 'rotate(746deg) scaleX(.86)' }], { duration: 800, easing: 'cubic-bezier(.2,.6,.2,1)' });
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
let handOrder = [], flipRing = false, revMark = null, qAdvance = false, queueAll = false, fxFlying = false, lastTap = null;
/* Seats sit on an ellipse in play order, you at the bottom. Seats never move when play reverses;
   only the flow of the ring and the arrow towards the next player change direction. */
function ringHTML(cw, dw, myTurn) {
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
        <button class="drawpile ${myTurn && !G.drew ? 'can' : ''}" id="drawPile" aria-label="Draw a card${isWide() ? ' (D)' : ''}, ${G.deckCount} left" style="width:${dw + 6}px;height:${Math.round(dw * 1.52) + 6}px">${backHTML(dw, 'shadow')}${backHTML(dw)}</button>
        <div class="discard-wrap">
          ${G.pending > 0 ? `<span class="stackb">+${G.pending}</span>` : ''}
          <div class="discard" style="--cur:${cur}">${top ? cardHTML(top, { w: cw, cls: lastTopV !== G.v && !fxFlying ? 'pop' : '' }) : ''}</div>
        </div>
      </div>
      <span class="dirlbl"><span class="curcol" style="--cur:${cur}"><i></i>${COLORS[G.color] || ''}</span>· ${G.dir === 1 ? '↻ clockwise' : '↺ anticlockwise'}</span>
    </div>
  </div>`;
}
function renderHand(hand, myTurn, prevScroll, R) {
  const el = $('#hand');
  const idx = hand.map((c, i) => i).sort((a, b) => CORD.indexOf(cc(hand[a])) - CORD.indexOf(cc(hand[b])) || VORD.indexOf(cv(hand[a])) - VORD.indexOf(cv(hand[b])));
  if (myTurn && G.drew) { const li = hand.length - 1; idx.splice(idx.indexOf(li), 1); idx.unshift(li); }
  handOrder = idx;
  const wide = isWide(), w = wide ? 88 : window.innerWidth < 370 || window.innerHeight < 760 ? 70 : 80;
  el.innerHTML = idx.map((i, k) => {
    const c = hand[i]; let cls = '';
    const ok = myTurn && G.status === 'playing' && (!G.drew || i === hand.length - 1) && canPlay(c, R);
    if (myTurn && G.status === 'playing') cls = ok ? 'ok' : 'no';
    if (myTurn && G.drew && i === hand.length - 1) cls += ' fresh';
    return `<div class="hcard ${cls}">${cardHTML(c, { w, tag: 'button', attrs: `data-i="${i}"`, aria: cardName(c) + (ok ? ', playable' : '') + (wide && k < 9 ? `, key ${k + 1}` : '') })}${k < 9 ? `<kbd>${k + 1}</kbd>` : ''}</div>`;
  }).join('');
  if (!wide) {
    const avail = el.clientWidth - 32, n = idx.length;
    let ov = 6; if (n > 1 && n * w + (n - 1) * 6 > avail) ov = Math.max(-w * 0.4, (avail - w) / (n - 1) - w);
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
  if (cc(c) === 'w') { pendingWild = { i }; closeSheets(); $('#picker').hidden = false; $('#picker button[data-col]').focus(); return; }
  doPlay(i, null);
}
async function doPlay(i, col) { const r = await send('play', { i, color: col, called: armedCall }); if (r.ok) armedCall = false; }
$('#picker').addEventListener('click', (e) => { const b = e.target.closest('button[data-col]'); if (b && pendingWild) { const p = pendingWild; pendingWild = null; $('#picker').hidden = true; doPlay(p.i, b.dataset.col); } });

function renderActions() {
  const el = $('#actions'); if (!el || !G) return;
  if (G.status !== 'playing') { el.innerHTML = ''; return; }
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
  const rec = recorded && recorded.round === G.round ? recorded : null;
  return `<div class="sheet" style="position:fixed"><div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="winT">
    <span class="grab" aria-hidden="true"></span>
    <div class="over-head">${av(G.winner, 'md')}<div><p class="eyebrow">Round ${G.round || 1} is over</p><h2 id="winT">${G.winner === G.me ? 'You win!' : esc(nameOf(G.winner)) + ' wins!'}</h2></div></div>
    ${rec ? `<div class="gold-box" style="display:flex;align-items:center;gap:10px;font-size:14px">${ICON.trophy}<span>+1 win for ${G.winner === G.me ? 'you' : esc(nameOf(G.winner))}${rec.rank ? ` · now <b>#${rec.rank}</b> on the leaderboard` : ''}</span></div>` : ''}
    ${chatPeekHTML()}
    <ol class="standings">${ps.map((u) => `<li>${av(u, 'sm')}<span class="nm">${esc(nameOf(u))}${u === G.me ? ' (you)' : ''}</span><span class="left">${count(u) ? count(u) + ' left' : 'out'}</span><span class="w">${G.wins[u] || 0} ★</span></li>`).join('')}</ol>
    ${isHost() ? `<button class="btn gold block" id="nextBtn" style="min-height:54px">Deal the next round</button><p class="note" style="text-align:center">Anyone who joined meanwhile gets dealt in.</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="endBtn">End game</button><button class="btn light" id="overBoard">Leaderboard</button></div>`
      : `${isOnline(G.host) ? `<p class="note" style="text-align:center;color:var(--soft)">Waiting for <b style="color:var(--ink)">${esc(nameOf(G.host))}</b> (host) to deal the next round</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><button class="btn" id="nudgeBtn">Nudge ${esc(nameOf(G.host))}</button><button class="btn light" id="overBoard">Leaderboard</button></div>` : `${hostWaitHTML('deal')}<button class="btn" id="overBoard">Leaderboard</button>`}`}
  </div></div>`;
}

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
