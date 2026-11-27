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
let fbItems = [], fbUnread = 0, fbFrom = 'home', fbView = 'list', fbOpenId = null, fbKind = 'idea', fbDraft = '', fbQueued = null; // feedback
let idleTimer = null, idleAt = 0; // idle-close countdown
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
  setTimeout(() => el.remove(), kind === 'admalert' || kind === 'fbreply' ? 9000 : kind === 'win' ? 4200 : kind === 'chat' ? 4000 : 2800);
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
const SHEETS = ['signin', 'picker', 'menu', 'rules', 'howto', 'practice', 'iosInstall', 'leaveSheet', 'joinSheet', 'startSheet', 'inviteSheet', 'keepSheet', 'admThread'];
function closeSheets(except) { for (const id of SHEETS) if (id !== except) $('#' + id).hidden = true; $('#reactPop').hidden = true; }
function show(v) {
  if (v !== 'game' && practice) endPractice();
  if (v !== 'game' && adminWatching) adminLeave();
  if (v !== 'game' && idleTimer) { clearInterval(idleTimer); idleTimer = null; $('#idleWarn').hidden = true; }
  if (v !== 'admin') clearTimeout(admTimer);
  view = v;
  document.body.classList.toggle('in-game', v === 'game');
  for (const id of ['home', 'invite', 'board', 'game', 'admin', 'feedback']) $('#' + id).hidden = id !== v;
  const tabs = v === 'home' || v === 'board';
  $('#tabbar').hidden = !tabs; document.body.classList.toggle('has-tabs', tabs);
  if (v === 'board') paintTabs('rank');
  if (v !== 'game') { closeSheets('signin'); $('#chat').classList.remove('open'); }
  window.scrollTo(0, 0);
}
function setHash(h) { const want = h ? '#' + h : ''; if (location.hash !== want || location.pathname !== '/') history.replaceState(null, '', '/' + want); }
function pathSlug() { const m = /^\/t\/([^/]{1,60})\/?$/.exec(location.pathname); return m ? m[1] : null; }
function hashCode() { const m = /^#([A-Za-z]{4})$/.exec(location.hash || ''); return m ? m[1].toUpperCase() : null; }
function route() {
  if (!ready) return;
  const code = hashCode(), slug = pathSlug();
  if (slug && !code) openHome(slug);
  else if (code) openTable(code);
  else if (location.hash === '#leaderboard') showBoard(view === 'game' ? 'game' : 'home');
  else if (location.hash === '#admin' && me && me.admin) showAdmin();
  else if (location.hash === '#feedback' && me) showFeedback('home');
  else if (location.hash === '#you') showHome('you');
  else showHome();
}
window.addEventListener('hashchange', route);
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]'); if (c) { $('#' + c.dataset.close).hidden = true; if (c.dataset.close === 'picker') pendingWild = null; }
  const h = e.target.closest('[data-howto]'); if (h) { e.preventDefault(); closeSheets(); $('#howto').hidden = false; }
  for (const id of SHEETS) if (e.target.id === id) $('#' + id).hidden = true; // tap outside a sheet closes it
  if (!e.target.closest('#reactPop,#reactBtn')) $('#reactPop').hidden = true;
});

/* ---------- sign-in ----------
   One flow for everyone: type your name, and the app works out whether you're new or back.
   (The old "I'm new / I've played before" choice made people pick wrong and create a second name.)
   Names used on this phone show as one-tap buttons, and claiming a new name on a phone that
   already played as someone else asks once whether that's you. */
let authStep = 'name', authName = '', authInfo = null, guardOk = false, checkTimer = null, checkSeq = 0, emailOn = false;
const CHEV = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
function knownNames() {
  let k = []; try { k = JSON.parse(load('lc-known') || '[]'); } catch (e) {}
  if (!Array.isArray(k)) k = [];
  const nick = load('lc-nick'); if (nick && !k.some((x) => x.name.toLowerCase() === nick.toLowerCase())) k.push({ name: nick, at: 0 });
  return k.filter((x) => x && typeof x.name === 'string').slice(0, 4);
}
function rememberName(name) {
  const k = knownNames().filter((x) => x.name.toLowerCase() !== name.toLowerCase());
  k.unshift({ name, at: Date.now() }); store('lc-known', JSON.stringify(k.slice(0, 4)));
}
function daysAgo(t) {
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 14 ? `${d} days ago` : new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
}
function resetAuth() { authStep = 'name'; authName = ''; authInfo = null; guardOk = false; }
function renderAuth() {
  const go = $('#siGo'), body = $('#siBody'); go.hidden = false; go.disabled = false; $('#siErr').textContent = '';
  const nm = esc(authName), key = authName.toLowerCase();
  if (authStep === 'name') {
    const known = knownNames();
    body.innerHTML = `${known.length ? `<section class="known" aria-labelledby="knT"><h3 class="known-h" id="knT">Played on this phone</h3>${known.map((k) => `<button type="button" class="known-btn" data-known="${esc(k.name)}">${avatarFor(k.name.toLowerCase(), k.name)}<span class="t"><b>Continue as ${esc(k.name)}</b>${k.at ? `<span>Last here ${daysAgo(k.at)}</span>` : ''}</span>${CHEV}</button>`).join('')}</section><div class="or-line" aria-hidden="true"><span>or someone else</span></div>` : ''}
      <label class="fld" for="siName">${emailOn ? 'Your username, or email' : 'Your username'}
        <input id="siName" class="inp" maxlength="${emailOn ? 254 : 18}" placeholder="${emailOn ? 'sam_k or you@email.com' : 'sam_k'}" autocomplete="username" autocapitalize="none" spellcheck="false" enterkeyhint="next" aria-describedby="siHint" value="${nm}">
      </label>
      <p class="hint" id="siHint" role="status">New here? Pick a username: 3+ letters or numbers, no spaces.</p>
      <div id="siFix"></div>`;
    go.textContent = 'Continue';
    if (authName) liveCheck();
  } else if (authStep === 'emailAsk') {
    const i = authInfo || {};
    const stats = [i.wins ? `${i.wins} win${i.wins === 1 ? '' : 's'}` : '', i.last ? `last played ${daysAgo(i.last)}` : ''].filter(Boolean).join(' · ');
    body.innerHTML = `<div class="who-big">${avatarFor(key, authName, { size: 'lg' })}<div><h3>Welcome back, ${nm}</h3>${stats ? `<p>${esc(stats)}</p>` : ''}</div></div>
      <p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">We’ll email a 6-digit code to <b style="color:var(--ink)">${esc(i.emailHint || 'your email')}</b>.</p>
      <div class="auth-links"><button type="button" class="linkbtn muted" id="siOther">Not ${nm}? Use a different name</button></div>`;
    go.textContent = 'Email me a code';
  } else if (authStep === 'code') {
    const i = authInfo || {};
    body.innerHTML = `<div><h3 style="font-size:24px;margin:0 0 6px">Check your email</h3><p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">We sent a 6-digit code to <b style="color:var(--ink)">${esc(i.to || 'your email')}</b>. It works for 10 minutes.</p></div>
      <label class="fld" for="siCode">6-digit code
        <input id="siCode" class="inp pin-inp" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" placeholder="••••••">
      </label>
      <div class="auth-links"><button type="button" class="linkbtn" id="siResend">Send a new code</button><button type="button" class="linkbtn muted" id="siOther">Use a different name or email</button></div>`;
    go.textContent = 'Sign in';
  } else if (authStep === 'locked') {
    body.innerHTML = `<div class="who-big">${avatarFor(key, authName, { size: 'lg' })}<div><h3>@${nm} is taken</h3></div></div>
      <p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">If it’s yours, open Last Card on the phone you first played on and add your email there. Then you can sign in anywhere.</p>
      <div class="auth-links"><button type="button" class="linkbtn" id="siOther">Pick a different username</button></div>`;
    go.hidden = true;
  } else if (authStep === 'back' || authStep === 'reset') {
    const i = authInfo || {}, reset = authStep === 'reset';
    const stats = [i.wins ? `${i.wins} win${i.wins === 1 ? '' : 's'}` : '', i.last ? `last played ${daysAgo(i.last)}` : ''].filter(Boolean).join(' · ');
    body.innerHTML = `<div class="who-big">${avatarFor(key, authName, { size: 'lg' })}<div><h3>Welcome back, ${nm}</h3>${stats ? `<p>${esc(stats)}</p>` : ''}</div></div>
      <label class="fld" for="siPin">${reset ? 'Choose a new 4-digit PIN' : 'Your 4-digit PIN'}
        <input id="siPin" class="inp pin-inp" maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="${reset ? 'new-password' : 'current-password'}" placeholder="••••" type="password">
      </label>
      ${reset ? '<p class="note" style="margin:0">The admin reset your PIN. Pick a new one and you’re in.</p>' : ''}
      <div class="auth-links">${reset ? '' : '<button type="button" class="linkbtn" id="siForgot">Forgot your PIN? Ask the admin to reset it</button>'}<button type="button" class="linkbtn muted" id="siOther">Not ${nm}? Use a different name</button></div>`;
    go.textContent = reset ? 'Save new PIN and play' : 'Sign in';
  } else if (authStep === 'new') {
    body.innerHTML = `<div class="who-big">${avatarFor(key, authName, { size: 'lg' })}<div><h3>Hi ${nm}, you’re new!</h3><p class="okline">Nobody has this name yet</p></div></div>
      <p class="tipbox">Played before under another name? <button type="button" class="linkbtn" id="siOther">Type that name instead</button> so your wins stay together.</p>
      <label class="fld" for="siPin">Choose a 4-digit PIN
        <input id="siPin" class="inp pin-inp" maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" placeholder="••••" type="password">
      </label>
      <p class="note" style="margin:0">You’ll need it to sign in on another phone. Pick something you’ll remember.</p>`;
    go.textContent = `Make “${authName}” mine`;
  } else if (authStep === 'guard') {
    const other = knownNames().find((k) => k.name.toLowerCase() !== key);
    body.innerHTML = `<div class="who-big">${avatarFor(other.name.toLowerCase(), other.name, { size: 'lg' })}<div><h3>This phone has played as ${esc(other.name)}</h3></div></div>
      <p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">Is that you? Sign in as ${esc(other.name)} to keep your wins in one place. A new name starts from zero.</p>
      <button type="button" class="btn gold block" id="gdYes" data-known="${esc(other.name)}" style="min-height:54px">Yes, I’m ${esc(other.name)}</button>
      <button type="button" class="btn block" id="gdNo" style="min-height:54px">No, I’m ${nm}, someone else</button>
      <p class="note" style="text-align:center;margin:0">Sharing a phone is fine. Each person keeps their own name and PIN.</p>`;
    go.hidden = true;
  }
}
function setHint(kind, text) {
  const h = $('#siHint'), inp = $('#siName'); if (!h) return;
  h.className = 'hint ' + (kind || ''); h.textContent = text || '';
  inp.classList.toggle('bad', kind === 'bad'); inp.setAttribute('aria-invalid', kind === 'bad' ? 'true' : 'false');
}
// while typing: say which way this will go, so nobody is surprised on the next screen
async function liveCheck() {
  const inp = $('#siName'); if (!inp) return;
  const name = inp.value.trim().replace(/^@/, '');
  $('#siFix').innerHTML = '';
  if (emailOn && name.includes('@')) { setHint('', 'We’ll email you a code to sign in.'); return; }
  if (name.length < 2) { setHint('', name ? '' : 'New here? Pick a username: 3+ letters or numbers, no spaces.'); return; }
  const seq = ++checkSeq;
  const r = await send('checkName', { name }, true);
  if (seq !== checkSeq || !r.ok || authStep !== 'name') return;
  if (!r.valid) { setHint('bad', r.error); if (r.fix) { $('#siFix').innerHTML = `<button type="button" class="fixchip" data-fix="${esc(r.fix)}">Use @${esc(r.fix)}</button>`; } }
  else if (r.available) setHint('ok', `@${r.name} is free. Continue to start playing.`);
  else setHint('ok', `@${r.name} has played before. Continue to sign in.`);
}
async function goName(name, picked = false) {
  name = (name || '').trim().replace(/^@/, '');
  if (emailOn && name.includes('@')) { await sendSignInCode(name); return; }
  if (name.length < 2) { $('#siErr').textContent = 'Type a username first.'; const n = $('#siName'); if (n) n.focus(); return; }
  $('#siGo').disabled = true;
  const r = await send('checkName', { name }, true);
  $('#siGo').disabled = false;
  if (!r.ok) { $('#siErr').textContent = 'Couldn’t check that name. Try again.'; return; }
  if (!r.valid) { authName = name; setHint('bad', r.error); track('signin_name_checked', { result: 'invalid', picked_known: picked }); return; }
  track('signin_name_checked', { result: r.available ? 'new' : r.reset ? 'reset' : 'returning', picked_known: picked });
  authName = r.name; authInfo = r;
  if (r.available) {
    // a new username: no PIN, straight in (after checking once if this phone already has a player)
    if (!guardOk && knownNames().some((k) => k.name.toLowerCase() !== r.name.toLowerCase())) { authStep = 'guard'; renderAuth(); const y = $('#gdYes'); if (y) y.focus(); return; }
    await claimUsername(r.name); return;
  }
  authStep = r.reset ? 'reset' : r.protect === 'email' && emailOn ? 'emailAsk' : r.protect === 'none' ? 'locked' : 'back';
  renderAuth();
  setTimeout(() => { const p = $('#siPin'); if (p) p.focus(); }, 30);
}
async function claimUsername(name) {
  $('#siGo').disabled = true;
  const r = await send('login', { name, mode: 'guest', known: knownNames().filter((k) => k.name.toLowerCase() !== name.toLowerCase()).length }, true);
  $('#siGo').disabled = false;
  if (!r.ok) { authStep = 'name'; renderAuth(); setHint('bad', r.error || 'Couldn’t claim that. Try again.'); if (r.fix) $('#siFix').innerHTML = `<button type="button" class="fixchip" data-fix="${esc(r.fix)}">Use @${esc(r.fix)}</button>`; return; }
  finishSignIn(r);
}
async function sendSignInCode(who) {
  $('#siGo').disabled = true;
  const r = await send('emailStart', { purpose: 'signin', who }, true);
  $('#siGo').disabled = false;
  if (!r.ok) { $('#siErr').textContent = r.error || 'Couldn’t send a code. Try again.'; return; }
  authInfo = { ...(authInfo || {}), id: r.id, to: r.to, who }; authStep = 'code'; renderAuth();
  setTimeout(() => { const c = $('#siCode'); if (c) c.focus(); }, 30);
}
function finishSignIn(r) {
  me = { name: r.name, key: r.key, slug: r.slug, protect: r.protect, admin: !!r.admin }; session = r.session; store('lc-session', session); store('lc-nick', r.name); last = r.last || last;
  rememberName(r.name); resetAuth(); loadFb(); phWho();
  $('#signin').hidden = true;
  toast(r.created ? `Welcome, ${r.name}! After a round, add your email to keep your wins.` : r.newPin ? `New PIN saved. Welcome back, ${r.name}!` : `Signed in as ${r.name}`);
  const then = afterSignIn; afterSignIn = null;
  if (then) then(); else rerender();
  if (!r.created) maybeAskOnOpen();
}
$('#siBody').addEventListener('input', (e) => {
  if (e.target.id === 'siName') { authName = e.target.value; clearTimeout(checkTimer); checkTimer = setTimeout(liveCheck, 350); }
  if (e.target.id === 'siPin') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); if (e.target.value.length === 4 && authStep === 'back') $('#siForm').requestSubmit(); }
  if (e.target.id === 'siCode') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) $('#siForm').requestSubmit(); }
});
$('#siBody').addEventListener('click', async (e) => {
  const k = e.target.closest('[data-known]'); if (k) { if (k.id === 'gdYes') track('signin_guard_answered', { answer: 'same_person' }); goName(k.dataset.known, true); return; }
  if (e.target.closest('#siOther')) { authStep = 'name'; authName = ''; authInfo = null; renderAuth(); setTimeout(() => $('#siName').focus(), 30); return; }
  if (e.target.closest('#gdNo')) { track('signin_guard_answered', { answer: 'someone_else' }); guardOk = true; await claimUsername(authName); return; }
  const fx = e.target.closest('[data-fix]'); if (fx) { const n = $('#siName'); n.value = fx.dataset.fix; authName = fx.dataset.fix; liveCheck(); n.focus(); return; }
  if (e.target.closest('#siResend')) { const b = $('#siResend'); b.disabled = true; await sendSignInCode((authInfo && authInfo.who) || authName); toast('New code sent'); return; }
  if (e.target.closest('#siForgot')) {
    const b = $('#siForgot'); b.disabled = true;
    const r = await send('forgotPin', { name: authName }, true);
    b.outerHTML = `<p class="hint ${r.ok ? 'ok' : 'bad'}" role="status">${r.ok ? 'Sent. Once the admin resets it, sign in with your name here and you’ll pick a new PIN.' : esc(r.error || 'Couldn’t send that. Try again.')}</p>`;
  }
});
function openSignIn(then) {
  afterSignIn = then || null;
  closeSheets();
  if (!$('#signin').contains($('#siForm'))) $('#siTitle').after($('#siForm'));
  if (me) {
    $('#siTitle').textContent = 'Your account';
    $('#siBody').innerHTML = `<div class="idchip">${avatarFor(me.name.toLowerCase(), me.name)}<span class="tx">Signed in as<b>${esc(me.name)}</b></span></div>
      ${needsKeep() ? `<div class="keep-card"><span class="t"><b>Keep @${esc(me.name)} yours</b><span>${emailOn ? 'Add your email to sign in on any phone.' : 'Pick a PIN to sign in on another phone.'}</span></span><button type="button" class="btn sm light" id="keepBtn">${emailOn ? 'Add email' : 'Pick a PIN'}</button></div>` : `<p class="note" style="margin:0">${me.protect === 'email' ? 'Signs in with a code to your email.' : 'Signs in with your PIN.'}</p>`}
      <p class="note">Wins from every game you finish signed in go on the leaderboard.</p>`;
    const kb = $('#keepBtn'); if (kb) kb.onclick = () => openKeep('account');
    $('#siGo').hidden = false; $('#siGo').textContent = 'Switch to another name';
  } else { $('#siTitle').textContent = 'Who’s playing?'; resetAuth(); renderAuth(); track('signin_shown', { known_names: knownNames().length, trigger: then ? (curCode || view === 'invite' ? 'join' : 'create') : 'account' }); }
  $('#signin').hidden = false;
  setTimeout(() => { const n = $('#siName'); if (n && !n.value && !knownNames().length) n.focus(); }, 50);
}
$('#siForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (me) { await switchUser(); openSignIn(afterSignIn); return; }
  const err = $('#siErr'); err.textContent = '';
  if (authStep === 'name') { await goName($('#siName').value); return; }
  if (authStep === 'guard' || authStep === 'locked') return;
  if (authStep === 'emailAsk') { await sendSignInCode(authName); return; }
  if (authStep === 'code') {
    const code = $('#siCode').value;
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code from the email.'; $('#siCode').focus(); return; }
    $('#siGo').disabled = true;
    const r = await send('emailVerify', { id: authInfo.id, code, known: knownNames().length }, true);
    $('#siGo').disabled = false;
    if (!r.ok) { err.textContent = r.error || 'That code didn’t work.'; const c = $('#siCode'); c.value = ''; c.focus(); return; }
    finishSignIn(r); return;
  }
  const pin = $('#siPin').value;
  if (!/^\d{4}$/.test(pin)) { err.textContent = authStep === 'back' ? 'Enter your 4-digit PIN.' : 'Choose a 4-digit PIN (numbers only).'; $('#siPin').focus(); return; }
  // a new name on a phone that already has a player: check once that it's really someone else
  if (authStep === 'new' && !guardOk && knownNames().some((k) => k.name.toLowerCase() !== authName.toLowerCase())) { authStep = 'guard'; renderAuth(); const y = $('#gdYes'); if (y) y.focus(); return; }
  $('#siGo').disabled = true;
  const r = await send('login', { name: authName, pin, mode: authStep === 'new' ? 'new' : authStep === 'reset' ? 'reset' : 'back', known: knownNames().filter((k) => k.name.toLowerCase() !== authName.toLowerCase()).length }, true);
  $('#siGo').disabled = false;
  if (!r.ok) {
    if (r.taken) { authStep = 'name'; renderAuth(); setHint('bad', r.error); return; }
    err.textContent = r.error || 'Couldn’t sign in. Try again.';
    const p = $('#siPin'); if (p) { p.value = ''; p.focus(); }
    return;
  }
  finishSignIn(r);
});
async function switchUser() {
  await send('logout', { session }, true);
  if (ph) { try { ph.reset(); phSuper(); } catch (e) {} }
  me = null; session = ''; store('lc-session', ''); last = null;
  if (view === 'game') { curCode = null; G = null; setHash(''); }
  $('#signin').hidden = true;
  route();
}
function needSignIn(then) { if (me) { then(); return; } openSignIn(then); }
function rerender() { if (view === 'admin') showAdmin(); else if (view === 'home') showHome(); else if (view === 'invite' && inviteInfo) showInvite(inviteInfo); else if (view === 'board') showBoard(boardFrom); else render(); }


/* ---------- usage analytics (PostHog) ----------
   Only runs when the server has a PostHog key. Started after the first hello, never for admins.
   Replays hide everything typed, plus chat, feedback, pop-ups and the admin page. */
let ph = null, phQueue = [], phStarted = false;
const PH_MASK = '#chat, #msgs, #feedback, #toasts, #admin, #admThread, #fbBody, .ph-mask';
const isStandalone = () => { try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
function platformName() {
  const ua = navigator.userAgent;
  return /iPhone|iPod/.test(ua) ? 'iphone' : /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1) ? 'ipad' : /Android/.test(ua) ? 'android' : /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : /Linux/.test(ua) ? 'linux' : 'other';
}
function track(event, props) {
  if (me && me.admin) return;
  if (ph) { try { ph.capture(event, props || {}); } catch (e) {} } else if (phQueue.length < 40) phQueue.push([event, props || {}]);
}
function phSuper() { if (ph) ph.register({ platform: platformName(), installed: isStandalone(), app_version: build || null }); }
function phWho() {
  if (!ph) return;
  if (me && me.admin) { try { ph.stopSessionRecording(); ph.opt_out_capturing(); } catch (e) {} return; }
  // An admin session on this device opts PostHog out, and PostHog remembers that. Undo it for anyone else.
  try { if (ph.has_opted_out_capturing && ph.has_opted_out_capturing()) { ph.opt_in_capturing(); ph.startSessionRecording && ph.startSessionRecording(); } } catch (e) {}
  if (me && me.key && ph.get_distinct_id() !== me.key) ph.identify(me.key);
}
function startAnalytics(cfg) {
  if (!cfg || phStarted || (me && me.admin)) { if (!cfg) phQueue = []; return; }
  phStarted = true;
  const s = document.createElement('script');
  s.async = true; s.crossOrigin = 'anonymous'; s.src = cfg.assets + '/static/array.js';
  s.onload = () => {
    const p = window.posthog; if (!p || !p.init) return;
    p.init(cfg.key, {
      api_host: cfg.host, autocapture: false, capture_pageview: true, capture_pageleave: false, // one page view per load, so PostHog's setup check and web analytics see the app disable_surveys: true,
      persistence: 'localStorage', person_profiles: 'always', bootstrap: { distinctID: cfg.deviceId },
      session_recording: { maskAllInputs: true, maskTextSelector: PH_MASK },
      loaded: (x) => { ph = x; phSuper(); phWho(); phQueue.splice(0).forEach(([e, pr]) => track(e, pr)); },
    });
  };
  s.onerror = () => { phQueue = []; }; // blocked (ad blocker): the game carries on without it
  document.head.appendChild(s);
}
let openedAt = 0;
function trackOpened() {
  const q = new URLSearchParams(location.search);
  track('app_opened', { from: q.get('src') === 'push' ? 'push' : hashCode() ? 'link' : isStandalone() ? 'home_icon' : 'direct', installed: isStandalone(), signed_in: !!me });
  openedAt = Date.now();
  if (q.get('src')) { try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) {} }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && phStarted && Date.now() - openedAt > 30 * 60000) trackOpened(); });
window.addEventListener('error', (e) => { track('client_error', { message: String((e && e.message) || 'error').slice(0, 120), screen: view }); });

/* ---------- connection ---------- */
socket.on('connect', async () => {
  $('#conn').hidden = true;
  const r = await send('hello', { token, session, installed: isStandalone() }, true);
  if (r.build) { if (!build) build = r.build; else if (r.build !== build) $('#updateBar').hidden = false; }
  if (r.ok) { me = r.account || null; emailOn = !!r.emailOn; if (!r.sessionValid) { session = ''; store('lc-session', ''); } last = r.last || null; }
  if (r.ok && !phStarted) { startAnalytics(r.analytics); if (r.analytics) trackOpened(); } else phWho();
  ready = true; $('#homeNote').textContent = '';
  if (view === 'game' && curCode && !hashCode() && !practice && !adminWatching) setHash(curCode);
  setOffline(false);
  syncPush(); loadFb();
  if (adminWatching && me && me.admin) adminWatch(adminWatching);
  else if (!practice) route();
  maybeAskOnOpen();
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
  curCode = null; G = null; setHash(''); closeSheets(); hideIdle(); $('#chat').classList.remove('open'); showHome();
  const meName = me && me.name;
  const el = document.createElement('div'); el.className = 'sheet'; el.style.position = 'fixed'; el.style.zIndex = '50';
  el.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="endT">
    <span class="grab" aria-hidden="true"></span>
    <div><p class="eyebrow">${m.reason === 'idle' ? `Table ${esc(m.code)} closed: nobody played for 10 minutes` : (m.by === meName ? 'You ended the game' : esc(m.by) + ' ended the game') + (m.midRound ? ` during round ${m.rounds}` : ` after ${m.rounds} round${m.rounds === 1 ? '' : 's'}`)}</p><h2 id="endT">${m.standings[0] && m.standings[0].wins ? (m.standings[0].name === meName ? 'You won the game!' : esc(m.standings[0].name) + ' won the game!') : 'Game over'}</h2></div>
    <ol class="standings">${m.standings.map((p) => `<li>${avatarFor(p.name.toLowerCase(), p.name, { size: 'sm' })}<span class="nm">${esc(p.name)}${p.name === meName ? ' (you)' : ''}</span><span class="w">${p.wins} ★</span></li>`).join('')}</ol>
    <button class="btn gold block" style="min-height:54px">Done</button>
  </div>`;
  el.querySelector('button').onclick = () => el.remove();
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  if (m.by !== meName) Snd.play('roundover');
});
// ---------- closing idle tables ----------
function hideIdle() { clearInterval(idleTimer); idleTimer = null; $('#idleWarn').hidden = true; }
socket.on('idleWarn', (m) => {
  if (!m || m.code !== curCode || adminWatching) return;
  if (!m.closesAt) { if (!$('#idleWarn').hidden && m.by && m.by !== (me && me.name)) toast(`${m.by} kept the table open`); hideIdle(); return; }
  idleAt = Date.now() + (m.closesAt - (m.now || Date.now()));
  const tick = () => {
    const left = Math.max(0, Math.round((idleAt - Date.now()) / 1000));
    $('#iwClock').textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    $('#iwClock').setAttribute('aria-label', `${Math.ceil(left / 60)} minute${left > 60 ? 's' : ''} left`);
  };
  $('#iwNote').textContent = G && G.status === 'playing' ? 'Nobody has played or chatted for 8 minutes.' : 'Nobody has dealt or chatted for 8 minutes.';
  tick(); clearInterval(idleTimer); idleTimer = setInterval(tick, 1000);
  $('#idleWarn').hidden = false; buzz();
});
$('#iwKeep').onclick = () => { hideIdle(); send('keepOpen', {}, true); };
$('#iwLeave').onclick = () => { hideIdle(); leaveNow(); };

socket.on('left', (m) => { if (m && m.code === curCode) { toast('You were removed from the table'); curCode = null; G = null; setHash(''); showHome(); } });
socket.on('react', (m) => { if (m && m.code === curCode && view === 'game' && ['😂', '😱', '😤', '👏'].includes(m.e)) floatEmoji(m.e, m.by); });
socket.on('recorded', (m) => { if (m && m.code === curCode) { recorded = m; if (G && G.status === 'over') render(); } });
socket.on('nudged', (m) => { if (m && m.code === curCode) { Snd.play('nudge'); buzz(); toast(`${nameOf(m.by)} is waiting for you to deal`, 'call'); } });
socket.on('presence', (m) => {
  if (!m || m.code !== curCode || !G) return;
  if (m.type === 'looking') {
    if (me && m.name === me.name) return;
    const isNew = !arrivals.has(m.key); arrivals.set(m.key, { name: m.name, at: Date.now() });
    if (G.status === 'lobby' && view === 'game') render();
    if (isNew && view === 'game') toast(`${m.name || 'Someone'} opened your link`, '');
    return;
  }
  if (m.type === 'joined') for (const [k, a] of arrivals) if (a.name === m.name) arrivals.delete(k);
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
async function refreshLast() { const r = await send('hello', { token, session, installed: isStandalone() }, true); if (r.ok) last = r.last || null; }
let homeTab = 'play';
function paintTabs(tab) { $$('#tabbar a').forEach((a) => { if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }); }
$('#tabbar').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-tab]'); if (!a) return; e.preventDefault();
  if (a.dataset.tab === 'rank') showBoard('home'); else showHome(a.dataset.tab);
});
function showHome(tab) {
  homeTab = tab === 'you' ? 'you' : 'play';
  show('home'); setHash(homeTab === 'you' ? 'you' : '');
  paintTabs(homeTab);
  $('#homePlay').hidden = homeTab !== 'play'; $('#homeYou').hidden = homeTab !== 'you';
  if (homeTab === 'you') paintYou();
  const ab = $('#acctBtn');
  if (me) { ab.className = 'acct'; ab.innerHTML = avatarFor(me.name.toLowerCase(), me.name) + esc(me.name); ab.setAttribute('aria-label', 'Your account, ' + me.name); }
  else { ab.className = 'acct out'; ab.textContent = 'Sign in'; ab.removeAttribute('aria-label'); }
  $('#greet').textContent = me ? `Ready for a round, ${me.name}?` : 'Ready for a round?';
  $('#adminBtn').hidden = !(me && me.admin);
  paintFbDots();
  $('#homeErr').textContent = '';
  // signed out: the sign-in form sits right on the page instead of hiding behind a header button
  const authBox = $('#homeAuth');
  authBox.hidden = !!me; $('#newGameBox').hidden = !me;
  if (!me) { $('#homeAuthSlot').appendChild($('#siForm')); renderAuth(); }
  else if (!$('#signin').contains($('#siForm'))) $('#siTitle').after($('#siForm'));
  const box = $('#rejoinBox');
  if (last && me && !last.mine) {
    const others = (last.players || []).filter((n) => n !== me.name);
    const chip = last.status === 'playing' ? (last.yourTurn ? 'Your turn' : `Round ${last.round || 1}`) : last.status === 'over' ? 'Round over' : 'In the lobby';
    const sub = others.length ? (last.status === 'playing' ? `Round ${last.round || 1} with ` : 'With ') + listNames(others.slice(0, 3)) + (others.length > 3 ? ` and ${others.length - 3} more` : '') : 'Just you so far';
    box.innerHTML = `<section class="rejoin2" aria-labelledby="rjT">
      <div class="rj-top"><span id="rjT" class="rj-eye">Your table</span><span class="rj-chip ${last.yourTurn ? 'hot' : ''}">${esc(chip)}</span></div>
      <div class="rj-mid"><span class="rj-code">${esc(last.code)}</span><span class="stack-av" aria-hidden="true">${others.slice(0, 4).map((n) => avatarFor(n.toLowerCase(), n, { size: 'sm' })).join('')}</span></div>
      <p class="rj-sub">${esc(sub)}</p>
      <button class="btn gold block" id="rejoinBtn" style="min-height:52px;font-size:16px">Rejoin table</button>
    </section>`;
    $('#rejoinBtn').onclick = () => openTable(last.code, 'rejoin');
  } else box.innerHTML = '';
  paintInvite();
  paintMyTable();
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
window.addEventListener('appinstalled', () => { track('app_installed', { platform: platformName() }); installEvt = null; store('lc-install', 'done'); paintInstall(); });
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
    const r = await send('pushSub', { sub: sub.toJSON(), fresh: load('lc-push') !== 'on', from: view === 'admin' ? 'admin' : view === 'game' ? (G && G.status === 'over' ? 'round_over' : 'menu') : 'home' }, true);
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
/* ---------- one table, one link: saylastcard.com/t/<you> ---------- */
function slugFor(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ /g, '-'); }
function myLink() { return me ? location.origin + '/t/' + encodeURIComponent(me.slug || slugFor(me.name)) : ''; }
function shareText(host, link) { return `${host}’s Last Card table is open. Tap to sit down: ${link}`; }
function waHref(text) { return 'https://wa.me/?text=' + encodeURIComponent(text); }
function paintMyTable() {
  if (!me) return;
  const link = myLink(), open = !!(last && last.mine);
  $('#myLink').innerHTML = esc(location.host) + '/t/<b>' + esc(me.slug || slugFor(me.name)) + '</b> · same link every time';
  $('#waBtn').href = waHref(shareText(me.name, link));
  const st = $('#mtStatus'); st.classList.toggle('open', open);
  st.lastElementChild.textContent = open ? (last.players && last.players.length ? `Open · ${last.players.length + 1} at the table` : 'Open · waiting for friends') : 'Closed';
  $('#createLbl').textContent = open ? 'Go to your table' : 'Open table';
  paintLastGame();
}
// your last game: the people you played with most recently, one tap from a rematch
async function paintLastGame() {
  const box = $('#lastGameBox');
  if (!me || offline) { box.innerHTML = ''; return; }
  const r = await send('mates', {}, true);
  if (view !== 'home' || !r.ok || !r.list.length) { if (r.ok) box.innerHTML = ''; return; }
  const top = r.list[0].last, group = r.list.filter((m) => top - m.last < 3 * 3600_000).slice(0, 5);
  const here = new Set(last && last.players ? last.players : []);
  if (group.every((m) => here.has(m.name))) { box.innerHTML = ''; return; }
  const names = group.map((m) => m.name);
  box.innerHTML = `<section class="lastgame" aria-labelledby="lgT">
    <div class="lg-top"><h2 class="lg-h" id="lgT">Last game · ${esc(daysAgoText(top))}</h2>${group.some((m) => m.online) ? `<span style="font-size:13px;font-weight:700;color:var(--ok)">${group.filter((m) => m.online).length} online now</span>` : ''}</div>
    <div class="lg-who"><span class="stack" aria-hidden="true">${group.slice(0, 3).map((m) => avatarFor(m.key, m.name)).join('')}</span><b>${esc(listNames(names.slice(0, 3)))}${names.length > 3 ? ` +${names.length - 3}` : ''}</b></div>
    <button class="btn rematch block" id="rematchBtn">Rematch: open table and ping ${group.length === 1 ? esc(names[0]) : 'all ' + group.length}</button>
  </section>`;
  $('#rematchBtn').onclick = async () => {
    const b = $('#rematchBtn'); b.disabled = true;
    track('rematch_tapped', { people: group.length });
    let n = 0; for (const m of group) { const x = await send('ping', { key: m.key }, true); if (x.ok) n++; }
    if (await createTable('rematch')) toast(n ? `Pinged ${n === group.length ? 'everyone' : n}. They’ll get a buzz.` : 'Your table is open.');
  };
}
const YI = {
  fb: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  mail: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  code: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>',
  bot: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>',
  book: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14zM20 17v4H6.5"/></svg>',
  adm: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
};
const CHEV_S = '<svg class="ychev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
function yRow(id, ic, t, sub, extra) { return `<button type="button" id="${id}"><span class="yi">${YI[ic]}</span><span class="yt"><b>${t}</b>${sub ? `<span>${sub}</span>` : ''}</span>${extra || ''}${CHEV_S}</button>`; }
function paintYou() {
  const box = $('#homeYou');
  if (!me) {
    box.innerHTML = `<div class="you-head"><span class="av lg">?</span><div><h1>Not signed in</h1><span>Pick a username to keep your wins.</span></div></div>
      <button class="btn gold block" id="youSignIn" style="min-height:56px">Sign in or pick a username</button>
      <nav class="you-list" aria-label="More">${yRow('youCode', 'code', 'Join with a code', 'For a friend’s 4-letter code')}${yRow('youPractice', 'bot', 'Practice vs computer', 'Any time, even offline')}${yRow('youRules', 'book', 'How to play', '2-minute rules')}</nav>`;
  } else {
    const how = me.protect === 'email' ? 'Signs in with an email code' : me.protect === 'pin' ? 'Signs in with a PIN' : 'Not protected yet';
    box.innerHTML = `<div class="you-head">${avatarFor(me.name.toLowerCase(), me.name, { size: 'lg' })}<div><h1>${esc(me.name)}</h1><span>${how}</span></div></div>
      <nav class="you-list" aria-label="You">
        ${needsKeep() ? yRow('youEmail', 'mail', emailOn ? 'Add your email' : 'Pick a PIN', emailOn ? 'Sign in on any phone with a code' : 'So you can sign in on another phone', '<span class="ydot" aria-label="To do"></span>') : ''}
        ${yRow('youFb', 'fb', 'Ideas & problems', fbUnread ? `${fbUnread} new repl${fbUnread === 1 ? 'y' : 'ies'}` : 'Tell the person who makes Last Card', fbUnread ? '<span class="ydot" aria-label="New"></span>' : '')}
        ${yRow('youCode', 'code', 'Join with a code', 'For a friend’s 4-letter code')}
        ${yRow('youPractice', 'bot', 'Practice vs computer', 'Any time, even offline')}
        ${yRow('youRules', 'book', 'How to play', '2-minute rules')}
        ${me.admin ? yRow('youAdmin', 'adm', 'Admin', 'Tables, numbers, messages') : ''}
      </nav>
      <button class="btn block" id="youSwitch" style="min-height:52px">Switch to another name</button>`;
  }
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('youSignIn', () => openSignIn());
  on('youEmail', () => openKeep('you'));
  on('youFb', () => showFeedback('home'));
  on('youCode', () => $('#joinOpen').click());
  on('youPractice', () => openPracticeSetup());
  on('youRules', () => { closeSheets(); $('#howto').hidden = false; });
  on('youAdmin', () => showAdmin());
  on('youSwitch', async () => { await switchUser(); openSignIn(); });
}
$('#inviteBtn').onclick = () => needSignIn(async () => { if (await createTable('invite')) openInviteSheet(); });
$('#waBtn').onclick = (e) => {
  if (!me) { e.preventDefault(); needSignIn(() => {}); return; }
  track('invite_shared', { method: 'whatsapp', from: 'home' }); createTable('whatsapp');
};
$('#copyMine').onclick = () => needSignIn(() => { track('invite_shared', { method: 'copy', from: 'home' }); copyLink(myLink()); createTable('copy'); });

// the invite sheet: WhatsApp, other apps, copy, QR, and people you've played with
let matesCache = null;
async function openInviteSheet() {
  if (!G) return;
  const link = inviteLink(), host = G.home ? G.home.name : nameOf(G.host), mineTable = G.home && me && G.home.slug === (me.slug || slugFor(me.name));
  const text = shareText(host, link);
  const card = $('#isCard');
  card.innerHTML = `<span class="grab" aria-hidden="true"></span>
    <button class="iconbtn sheet-close" data-close="inviteSheet" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <h2 id="isT">${mineTable ? 'Invite to your table' : `Invite to ${esc(host)}’s table`}</h2>
    <div class="is-msg">${esc(host)}’s Last Card table is open. Tap to sit down: <b>${esc(link.replace(/^https?:\/\//, ''))}</b></div>
    <a class="btn wa block" id="isWa" href="${esc(waHref(text))}" target="_blank" rel="noopener"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/></svg>Send on WhatsApp</a>
    <div class="is-grid">
      <button class="btn" id="isShare" type="button" ${navigator.share ? '' : 'hidden'}>${ICON.share}Other apps</button>
      <button class="btn" id="isCopy" type="button"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>Copy link</button>
      <button class="btn" id="isQrBtn" type="button" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3M21 14v7h-7"/></svg>QR code</button>
    </div>
    <div class="is-qr" id="isQr" hidden><img alt="QR code for ${esc(link)}" src="/qr.svg?u=${encodeURIComponent(link)}"><p class="note" style="margin:0">Friends in the room can point their camera here.</p></div>
    <div id="isMates"></div>`;
  closeSheets(); $('#inviteSheet').hidden = false;
  $('#isWa').onclick = () => track('invite_shared', { method: 'whatsapp', from: 'sheet' });
  $('#isShare').onclick = async () => { try { await navigator.share({ title: 'Last Card', text: `${host}’s Last Card table is open. Tap to sit down.`, url: link }); track('invite_shared', { method: 'share_sheet', from: 'sheet' }); } catch (e) {} };
  $('#isCopy').onclick = () => { track('invite_shared', { method: 'copy', from: 'sheet' }); copyLink(link); };
  $('#isQrBtn').onclick = () => { const q = $('#isQr'); q.hidden = !q.hidden; $('#isQrBtn').setAttribute('aria-expanded', String(!q.hidden)); if (!q.hidden) track('invite_shared', { method: 'qr', from: 'sheet' }); };
  if (!me) return;
  const r = await send('mates', {}, true);
  if (!r.ok || !r.list.length || $('#inviteSheet').hidden) return;
  const here = new Set((G.players || []).map((p) => p.name));
  const list = r.list.filter((m) => !here.has(m.name)).slice(0, 6);
  if (!list.length) return;
  $('#isMates').innerHTML = `<p class="is-h">Played with recently</p><ul class="mates">${list.map((m) => `<li>${avatarFor(m.key, m.name)}<span class="t"><b>${esc(m.name)}</b><span>${m.online ? 'Online now' : 'Played ' + esc(daysAgoText(m.last))}</span></span><button class="ping" type="button" data-ping="${esc(m.key)}">Ping</button></li>`).join('')}</ul>`;
  $$('#isMates [data-ping]').forEach((b) => { b.onclick = async () => {
    b.disabled = true;
    const x = await send('ping', { key: b.dataset.ping });
    if (x.ok) { b.textContent = 'Pinged'; b.classList.add('done'); } else b.disabled = false;
  }; });
}
function daysAgoText(t) { const d = Math.floor((Date.now() - t) / 864e5); return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? d + ' days ago' : d < 14 ? 'last week' : Math.round(d / 7) + ' weeks ago'; }

// someone opened your link or knocked: the lobby lists them live
const arrivals = new Map(); // key -> { name, at }
function arrivalsHTML() {
  const now = Date.now();
  for (const [k, a] of arrivals) if (now - a.at > 5 * 60_000 || (G && G.players.some((p) => a.name && p.name === a.name))) arrivals.delete(k);
  if (!arrivals.size) return '';
  return `<ul class="arrivals" aria-live="polite">${[...arrivals.values()].map((a) => `<li><span class="ghost" aria-hidden="true">${a.name ? esc(a.name[0].toUpperCase()) : '?'}</span><span class="t"><b>${a.name ? esc(a.name) : 'Someone'}</b><span>Opened the link · getting ready</span></span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></li>`).join('')}</ul>`;
}

// a personal link: the owner's table if it's open, otherwise a page to tell them you're here
let knockPoll = null;
async function openHome(slug, via = 'link') {
  clearInterval(knockPoll); knockPoll = null;
  joinVia = via;
  const r = await send('openHome', { slug, via }, true);
  if (!r.ok) { showHome(); toast(r.error || 'Couldn’t open that link.'); return; }
  if (r.unknown) { showHome(); toast('That link doesn’t match a player. Check it with your friend.'); return; }
  if (r.exists && r.seated) { enterGame(r.code); return; }
  if (r.exists) { showInvite(r.info); return; }
  if (r.host.mine) { if (me) { if (!(await createTable('own_link'))) showHome(); } else { showHome(); } return; }
  showKnock(r.host);
}
function showKnock(host) {
  show('invite'); history.replaceState(null, '', '/t/' + encodeURIComponent(host.slug));
  const body = $('#inviteBody');
  body.innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="knock-hero">${avatarFor(host.slug.replace(/-/g, ' '), host.name, { size: 'lg' })}
      <h1>${esc(host.name)}’s table</h1>
      <span class="knock-pill">${host.online ? `${esc(host.name)} is online, not at the table yet` : 'Not open right now'}</span></div>
    <section class="knock-card" aria-labelledby="kcT">
      <p id="kcT" style="font-weight:800;font-size:17px">Up for a game?</p>
      <p class="note" style="font-size:15px;color:var(--soft)" id="kcNote">We’ll tell ${esc(host.name)} you’re here. When the table opens, this page takes you in.</p>
      <button class="btn gold block" id="knockBtn" style="min-height:56px;font-size:17px">Tell ${esc(host.name)} I’m in</button>
    </section>
    <p class="note" style="text-align:center">This link always leads to ${esc(host.name)}’s table. It never expires.</p>
    <div class="inv-foot">
      <button class="linkbtn" id="kPractice" style="align-self:center">Practice while you wait</button>
      <button class="linkbtn" id="kHome" style="align-self:center;color:var(--soft)">${me ? 'Go to my own table' : 'Go to home'}</button>
    </div>`;
  $('#kPractice').onclick = () => { showHome(); openPracticeSetup(); };
  $('#kHome').onclick = () => showHome();
  $('#knockBtn').onclick = async () => {
    const b = $('#knockBtn'); b.disabled = true;
    const r = await send('knock', { slug: host.slug });
    if (!r.ok) { b.disabled = false; return; }
    b.textContent = `${host.name} knows you’re here`;
    $('#kcNote').textContent = `Keep this page open. You’ll go to the table as soon as ${host.name} opens it.`;
    // check every 8 seconds for 10 minutes
    let tries = 0; clearInterval(knockPoll);
    knockPoll = setInterval(async () => {
      if (view !== 'invite' || ++tries > 75) { clearInterval(knockPoll); knockPoll = null; return; }
      const x = await send('openHome', { slug: host.slug, via: 'knock_wait' }, true);
      if (x.ok && x.exists) { clearInterval(knockPoll); knockPoll = null; if (x.seated) enterGame(x.code); else showInvite(x.info); }
    }, 8000);
  };
}
socket.on('knock', (m) => {
  Snd.play('chat'); buzz();
  const who = m && m.name ? esc(m.name) : 'A friend';
  if (view === 'game' && G && G.home && me && G.home.slug === (me.slug || slugFor(me.name))) { toast('', 'admalert', `${who} wants to join. They’re waiting on your link.`); return; }
  toast('', 'admalert', `${who} is at your link and wants to play.<button class="tbtn" data-open-mine="1">Open my table</button>`);
});
socket.on('pinged', (m) => {
  if (!m || !m.slug) return;
  Snd.play('chat'); buzz();
  toast('', 'admalert', `${esc(m.name)} is up for a game.<button class="tbtn" data-goto-home="${esc(m.slug)}">Join</button>`);
});
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open-mine]'); if (a) { a.closest('.toast').remove(); createTable('knock'); }
  const b = e.target.closest('[data-goto-home]'); if (b) { b.closest('.toast').remove(); openHome(b.dataset.gotoHome, 'ping'); }
});

async function createTable(from = 'home') {
  closeSheets();
  $('#createBtn').disabled = true;
  const r = await send('create', { from, hadInvite: !!invitePeek }, true);
  $('#createBtn').disabled = false;
  if (r.ok) { clearInvite(); enterGame(r.code); return true; }
  $('#homeErr').textContent = r.error || 'Couldn’t open your table.';
  return false;
}
// Starting a table while a friend's invite is waiting asks once, because people kept opening a table
// of their own by mistake instead of joining the one they were invited to.
$('#createBtn').onclick = () => needSignIn(() => {
  const inv = invitePeek;
  if (!inv) { createTable(); return; }
  $('#startCard').innerHTML = `<span class="grab" aria-hidden="true"></span>
    <div style="display:flex;align-items:center;gap:12px">${avatarFor(inv.host.toLowerCase(), inv.host)}<h2 id="ssT" style="margin:0">${esc(inv.host)} is waiting for you</h2></div>
    <p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">${esc(inv.host)} invited you to table <b style="color:var(--ink)">${esc(inv.code)}</b>. A new table is a separate game, so you won’t be playing with them.</p>
    <button class="btn gold block" id="ssJoin" style="min-height:54px">Join ${esc(inv.host)}’s table instead</button>
    <button class="btn block" id="ssNew" style="min-height:54px">Open my own table</button>
    <p class="note" style="text-align:center;margin:0">${esc(inv.host)}’s invite stays on your home screen while their table is open.</p>`;
  closeSheets(); $('#startSheet').hidden = false;
  $('#ssJoin').onclick = () => { track('start_while_invited', { choice: 'join_instead' }); closeSheets(); openTable(inv.code, 'invite_card'); };
  $('#ssNew').onclick = () => { track('start_while_invited', { choice: 'own_table' }); createTable('start_confirm'); };
});

// join a friend's table by code, with a preview of whose table it is before you go in
let jsSeq = 0, jsInfo = null;
$('#joinOpen').onclick = () => {
  closeSheets(); $('#codeInp').value = ''; $('#jsRes').innerHTML = ''; $('#jsAct').innerHTML = ''; $('#codeInp').className = 'inp code-big'; jsInfo = null;
  $('#joinSheet').hidden = false; setTimeout(() => $('#codeInp').focus(), 50);
};
const MISS_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
function closedLine(c) {
  if (!c) return '';
  const mins = Math.max(1, Math.round(c.ago / 60000)), when = mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return c.reason === 'idle' ? `It closed ${when} after nobody played for 10 minutes.` : `The game ended ${when}${c.winner ? `, and ${c.winner} won` : ''}.`;
}
async function jsCheck() {
  const inp = $('#codeInp'); const code = inp.value;
  jsInfo = null; $('#jsAct').innerHTML = ''; inp.className = 'inp code-big';
  if (code.length < 4) { $('#jsRes').innerHTML = ''; return; }
  const seq = ++jsSeq;
  $('#jsRes').innerHTML = '<p class="note" style="margin:0">Looking for that table…</p>';
  const r = await send('peek', { code }, true);
  if (seq !== jsSeq) return;
  if (!r.ok) { $('#jsRes').innerHTML = `<p class="err">${esc(r.error || 'Couldn’t check that code. Try again.')}</p>`; return; }
  if (!r.exists) {
    track('join_code_checked', { result: r.closed ? 'closed' : 'not_found' });
    inp.className = 'inp code-big bad';
    $('#jsRes').innerHTML = `<div class="js-miss">${MISS_ICON}<span class="t"><b>${r.closed ? `Table ${esc(code)} has closed` : `No open table called ${esc(code)}`}</b><span>${r.closed ? esc(closedLine(r.closed)) + ' Ask your friend for a new link.' : 'Check the letters with your friend. If their game ended, the table closed and they’ll need to send a new link.'}</span></span></div>`;
    $('#jsAct').innerHTML = '<button type="button" class="btn block" id="jsNew" style="min-height:52px">Open my table instead</button>';
    $('#jsNew').onclick = () => needSignIn(() => createTable('join_sheet'));
    return;
  }
  const i = r.info; jsInfo = i;
  track('join_code_checked', { result: i.full ? 'full' : 'found' });
  inp.className = 'inp code-big ok';
  const host = i.host || 'Someone';
  const st = i.status === 'lobby' ? 'in the lobby' : i.status === 'playing' ? `round ${i.round} is on` : 'between rounds';
  $('#jsRes').innerHTML = `<div class="js-found">${avatarFor(host.toLowerCase(), host)}<span class="t"><b>${esc(host)}’s table</b><span>${i.players.length} player${i.players.length === 1 ? '' : 's'} · ${st}${i.full ? ' · full' : ''}</span></span></div>`;
  $('#jsAct').innerHTML = `<button type="submit" class="btn gold block" style="min-height:56px;font-size:17px" ${i.full ? 'disabled' : ''}>${i.full ? 'This table is full' : r.seated ? `Back to ${esc(host)}’s table` : `Join ${esc(host)}’s table`}</button>`;
}
$('#codeInp').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); jsCheck(); });
$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!jsInfo) { if ($('#codeInp').value.length < 4) $('#jsRes').innerHTML = '<p class="err">Enter all 4 letters of the code.</p>'; return; }
  closeSheets(); openTable(jsInfo.code, 'code');
});

// ---------- an invite you haven't acted on yet stays on home ----------
let invitePeek = null; // { code, host, players, status } while that table is open
function rememberInvite(info) { if (info && info.host) store('lc-invite', JSON.stringify({ code: info.code, host: info.host, at: Date.now() })); }
function clearInvite() { invitePeek = null; try { localStorage.removeItem('lc-invite'); } catch (e) {} const b = $('#inviteBox'); if (b) b.innerHTML = ''; }
async function paintInvite() {
  const box = $('#inviteBox');
  let inv = null; try { inv = JSON.parse(load('lc-invite') || 'null'); } catch (e) {}
  if (!inv || !me || offline || Date.now() - inv.at > 6 * 3600_000 || (last && last.code === inv.code)) { invitePeek = null; box.innerHTML = ''; return; }
  const r = await send('peek', { code: inv.code }, true);
  if (view !== 'home') return;
  if (!r.ok || !r.exists || r.seated || r.info.full) { if (r.ok) clearInvite(); return; }
  const i = r.info, host = i.host || inv.host;
  invitePeek = { code: i.code, host };
  const st = i.status === 'lobby' ? 'in the lobby' : i.status === 'playing' ? `round ${i.round} is on` : 'between rounds';
  box.innerHTML = `<section class="inv2" aria-labelledby="ivT">
    <span class="eye" id="ivT">You’re invited</span>
    <button class="x" id="ivX" type="button" aria-label="Dismiss ${esc(host)}’s invite"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <div class="who">${avatarFor(host.toLowerCase(), host)}<div><b>${esc(host)} is waiting for you</b><span>Table ${esc(i.code)} · ${i.players.length} player${i.players.length === 1 ? '' : 's'} · ${st}</span></div></div>
    <button class="btn gold block" id="ivJoin" style="min-height:52px;font-size:16px">Join ${esc(host)}’s table</button>
  </section>`;
  $('#ivJoin').onclick = () => openTable(i.code, 'invite_card');
  $('#ivX').onclick = clearInvite;
}

/* ---------- invite (opened from a link) ---------- */
let inviteInfo = null;
let joinVia = 'link';
async function openTable(code, via = 'link') {
  joinVia = via;
  const r = await send('open', { code, via }, true);
  if (!r.ok) { showHome(); toast(r.error || 'Couldn’t open that table.'); return; }
  if (!r.exists) { showInvite({ code, missing: true, closed: r.closed }); return; }
  if (r.seated) { enterGame(code); return; }
  showInvite(r.info);
}
function showInvite(info) {
  if (curCode && curCode !== info.code) { curCode = null; G = null; }
  inviteInfo = info; show('invite'); setHash(info.code);
  const body = $('#inviteBody');
  if (info.missing) {
    // An old or mistyped link: say what happened, and always offer a way on.
    const c = info.closed;
    if ((load('lc-invite') || '').indexOf('"' + info.code + '"') >= 0) clearInvite();
    body.innerHTML = `<button class="btn sm" id="invHome" style="align-self:flex-start">‹ Home</button>
      <div class="inv-hero"><span class="closed-ic" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M3 20h11V4H3zM10 12h.01"/></svg></span>
        <h1>${c ? `Table ${esc(info.code)} has closed` : `No open table called ${esc(info.code)}`}</h1>
        <p class="note" style="font-size:16px;line-height:1.5">${c ? esc(closedLine(c)) + ' Old links stop working once a table closes.' : 'The link may be old, or a letter may be off. Tables close once a game ends or nobody plays for 10 minutes.'}</p></div>
      ${c && c.players.length ? `<div class="closed-card">${avatarFor((c.winner || c.players[0]).toLowerCase(), c.winner || c.players[0])}<span class="t"><b>${c.winner ? esc(c.winner) + ' won the game' : 'Nobody finished a round'}</b><span>${c.rounds} round${c.rounds === 1 ? '' : 's'} with ${esc(listNames(c.players.slice(0, 4)))}</span></span></div>` : ''}
      <div class="inv-foot">
        <button class="btn light block" id="invHome2" style="min-height:56px;font-size:17px">Go to home</button>
        <button class="btn block" id="invNew" style="min-height:54px">Open my table</button>
        <button class="linkbtn" id="invCode" style="align-self:center;color:var(--soft)">Type a code instead</button>
        <p class="note" style="text-align:center">Ask your friend for their personal link. It never expires.</p>
      </div>`;
    $('#invHome').onclick = $('#invHome2').onclick = () => showHome();
    $('#invNew').onclick = () => { showHome(); needSignIn(() => createTable('closed_page')); };
    $('#invCode').onclick = () => { showHome(); $('#joinOpen').click(); };
    return;
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
      <button class="linkbtn" id="invOwn" style="align-self:center;color:var(--soft)">Not now, go to home</button>
    </div>`;
  rememberInvite(info);
  $('#invOwn').onclick = () => { track('invite_dismissed', { table_code: info.code }); showHome(); };
  const sw = $('#invSwitch'); if (sw) sw.onclick = async () => { await switchUser(); };
  $('#invJoin').onclick = () => needSignIn(async () => {
    const btn = $('#invJoin'); if (btn) btn.disabled = true;
    const r = await send('join', { code: info.code, via: joinVia }, true);
    if (btn) btn.disabled = false;
    if (r.ok) { clearInvite(); enterGame(info.code); }
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
  const r = await send('join', { code: m.code, via: joinVia }, true);
  if (r.ok) { enterGame(m.code); toast(`${m.host} let you in`, 'win'); } else toast(r.error || 'Couldn’t join. Try again.');
});
socket.on('declined', (m) => {
  if (!m || m.code !== waitingFor) return;
  waitingFor = null;
  $('#inviteBody').innerHTML = `<a class="logo" href="/" style="flex-grow:0">Last <span>Card</span></a>
    <div class="inv-hero" style="padding-top:40px"><h1>${esc(m.host)} didn’t let you in this time</h1><p class="note" style="font-size:15px">You can ask again, or start your own table.</p></div>
    <div class="inv-foot"><button class="btn gold block" id="decAgain">Ask again</button><button class="btn block" id="decHome">Open my own table</button></div>`;
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
async function goHomeKeepSeat(why) {
  closeSheets(); curCode = null; G = null;
  await send('away', { why: why === 'break' ? 'break' : 'home' }, true);
  await refreshLast(); showHome();
  if (last) toast('Your seat is saved. Tap Rejoin to go back.');
}
$('#menuBtn').onclick = () => { closeSheets(); menuOpen = null; renderMenu(); $('#menu').hidden = false; };
$('#menuHome').onclick = goHomeKeepSeat;
$('#menuBoard').onclick = () => { closeSheets(); showBoard('game'); };
async function leaveNow() { closeSheets(); hideIdle(); const code = curCode; curCode = null; G = null; last = null; await send('leave', {}, true); toast('You left table ' + code); showHome(); }
// Leaving always asks first. Mid-round you can take a break instead (keep your seat; your turns get skipped).
const LV_ICON = {
  ok: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-11"/></svg>',
  out: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 17l-5-5 5-5M5 12h11M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/></svg>',
  pause: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4zM6 1v3M10 1v3M14 1v3"/></svg>',
};
function openLeave() {
  if (!G || G.practice) { leaveNow(); return; }
  closeSheets();
  const seated = G.order.includes(G.me), others = G.players.filter((p) => p.id !== G.me);
  const nextHost = isHost() && others.length ? (G.order.filter((u) => u !== G.me).find((u) => isOnline(u)) || others[0].id) : null;
  const hostLine = nextHost ? `<p class="note" style="text-align:center;margin:0">${esc(nameOf(nextHost))} becomes the host.</p>` : '';
  const close = '<button class="iconbtn sheet-close" data-close="leaveSheet" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  if (G.status === 'playing' && seated) {
    const n = count(G.me), lastTwo = G.order.length === 2;
    $('#leaveCard').innerHTML = `<span class="grab" aria-hidden="true"></span>${close}
      <div><h2 id="lvTitle">Round ${G.round || 1} is still going</h2><p class="note" style="margin:4px 0 0">You have ${n} card${n === 1 ? '' : 's'}. What would you like to do?</p></div>
      <button class="lv-opt" id="lvBreak" type="button"><span class="ic">${LV_ICON.pause}</span><span class="tx"><b>Take a break</b><span>Keep your seat and cards. Your turns are skipped until you’re back.</span></span></button>
      <button class="lv-opt out" id="lvGo" type="button"><span class="ic">${LV_ICON.out}</span><span class="tx"><b>Leave the table</b><span>${lastTwo ? `${esc(nameOf(G.order.find((u) => u !== G.me)))} is the last one left, so they win this round.` : 'Your cards go back in the deck and the round carries on without you. It doesn’t count as a loss.'}</span></span></button>
      <button class="btn light block" data-close="leaveSheet" style="min-height:52px">Keep playing</button>${hostLine}`;
  } else {
    $('#leaveCard').innerHTML = `<span class="grab" aria-hidden="true"></span>${close}
      <h2 id="lvTitle">Leave table ${esc(G.code || curCode)}?</h2>
      <ul class="lv-list">
        ${G.round ? `<li>${LV_ICON.ok}Your wins stay on the leaderboard.</li>` : ''}
        ${others.length ? `<li>${LV_ICON.ok}The others ${G.status === 'lobby' ? 'can still play' : 'keep playing'} without you.</li>` : `<li>${LV_ICON.ok}You’re the only one here, so the table closes.</li>`}
        ${others.length ? `<li>${LV_ICON.ok}Changed your mind? The same link brings you back while the table is open.</li>` : ''}
      </ul>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><button class="btn" data-close="leaveSheet" style="min-height:54px">Stay</button><button class="btn leave-red" id="lvGo" style="min-height:54px">Leave</button></div>${hostLine}`;
  }
  $('#leaveSheet').hidden = false;
  const go = $('#lvGo'); if (go) go.onclick = leaveNow;
  const br = $('#lvBreak'); if (br) br.onclick = () => goHomeKeepSeat('break');
  setTimeout(() => { const f = $('#leaveCard .lv-opt, #leaveCard [data-close]'); if (f) f.focus({ preventScroll: true }); }, 0);
}
$('#menuLeave').onclick = openLeave;
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
  $('#menuHostH').hidden = !host || pr;
  $('#menuInvite').hidden = pr;
  $('#menuPeopleH').textContent = pr ? 'At the table' : `At the table · ${G.players.length}`;
  $('#approveBtn').setAttribute('aria-pressed', String(!!(G.settings && G.settings.approve)));
  const canAlert = pushSupported() && !pr;
  $('#alertBtn').hidden = !canAlert;
  if (canAlert) {
    const perm = Notification.permission;
    $('#alertBtn').setAttribute('aria-pressed', String(perm === 'granted' && load('lc-push') === 'on'));
    $('#alertNote').textContent = perm === 'denied' ? 'Blocked in your browser settings for this site.' : 'A notification when it’s your turn and the app is closed.';
  }
  $('#menuBoard').hidden = pr; $('#menuLeave').hidden = pr;
  $('#menuHome').textContent = pr ? 'End practice' : 'Back home';
  $('#menuHomeNote').textContent = pr ? 'Practice games don’t count on the leaderboard.' : 'Home keeps your seat while you’re away. Leave table gives it up.';
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
$('#menuInvite').onclick = () => { closeSheets(); openInviteSheet(); };
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
  if (!chatMsgs.length) { box.innerHTML = `<p class="note" style="margin:auto 0 0">${adminWatching ? 'No messages at this table yet.' : 'No messages yet. Say hi, or tap a quick reply below.'}</p>`; return; }
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
$('#quick').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) send('chat', { text: b.dataset.q, quick: true }); });

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
function inviteLink() { return G.home ? location.origin + '/t/' + encodeURIComponent(G.home.slug) : location.origin + '/#' + G.code; }
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
        <h2 id="invh">${ps.length < 2 ? 'Invite your friends' : 'Invite more'}</h2>
        <div class="lk-row"><div class="mt-link"><span>${esc(inviteLink().replace(/^https?:\/\//, ''))}</span></div><button class="btn" id="copyBtn" style="flex:0 0 auto">Copy</button></div>
        <button class="btn gold block" id="shareBtn" style="min-height:52px">${ICON.share}Invite friends</button>
        ${arrivalsHTML()}
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
  $('#shareBtn').onclick = () => openInviteSheet();
  $('#copyBtn').onclick = () => { track('invite_shared', { method: 'copy', from: 'lobby' }); copyLink(inviteLink()); };
  const rb = $('#rulesBtn'); if (rb) rb.onclick = () => { closeSheets(); $('#rules').hidden = false; };
  const sb = $('#startBtn'); if (sb) sb.onclick = () => send('start');
  wireClaim();
}
// ---------- ready-up: everyone taps in, the round deals itself ----------
let readyTick = null, clockSkew = 0;
function readyStatus() {
  const ready = G.ready || [], n = ready.length, all = G.players.filter((p) => p.online).length;
  if (G.dealAt) { const s = Math.max(0, Math.ceil((G.dealAt - (Date.now() + clockSkew)) / 1000)); return { t: s > 0 ? `Dealing in ${s}s` : 'Dealing…', hot: true }; }
  if (n >= 1) return { t: `${n} of ${all} in · needs 2`, hot: false };
  return { t: 'Tap in for the next round', hot: false };
}
function readyHTML() {
  const ready = new Set(G.ready || []), mine = ready.has(G.me), st = readyStatus();
  const ppl = G.players.slice(0, 8).map((p) => `<span class="rd-p ${ready.has(p.id) ? 'in' : ''} ${p.online ? '' : 'off'}">${av(p.id, 'sm')}${ready.has(p.id) ? '<i class="rd-tick" aria-label="in"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></i>' : ''}<em>${p.id === G.me ? 'You' : esc(p.name)}</em></span>`).join('');
  return `<section class="ready-box" aria-labelledby="rdT">
    <div class="rd-top"><h3 id="rdT">Round ${(G.round || 1) + 1}</h3><span id="rdStatus" class="${st.hot ? 'hot' : ''}" role="status">${esc(st.t)}</span></div>
    <div class="rd-ppl">${ppl}</div>
    <button class="btn ${mine ? 'rd-on' : 'gold'} block" id="readyBtn" style="min-height:56px;font-size:17px" aria-pressed="${mine}">${mine ? 'You’re in · tap to wait' : 'I’m in, deal me'}</button>
    ${isHost() && G.players.length >= 2 ? '<button class="linkbtn" id="nextBtn" style="align-self:center;color:var(--soft)">Deal now without waiting</button>' : ''}
  </section>`;
}
function startReadyTick() {
  clearInterval(readyTick); readyTick = null;
  if (!G || G.status !== 'over' || G.practice) return;
  if (G.now) clockSkew = G.now - Date.now();
  readyTick = setInterval(() => {
    const el = $('#rdStatus'); if (!el || !G || G.status !== 'over') { clearInterval(readyTick); readyTick = null; return; }
    const st = readyStatus(); el.textContent = st.t; el.className = st.hot ? 'hot' : '';
  }, 500);
}

// ---------- keep your username: add an email (or a PIN when email is off) ----------
let keepLater = false, keepInfo = null, keepAskedOpen = false, keepRoundAsked = '';
function needsKeep() { return !!me && (me.protect === 'none' || (emailOn && me.protect === 'pin')); }
// ask once when the app opens (not mid-game); then after every finished round until they add one
function maybeAskOnOpen() {
  if (keepAskedOpen || !needsKeep() || view !== 'home' || curCode) return;
  keepAskedOpen = true; setTimeout(() => { if (view === 'home' && needsKeep()) openKeep('open'); }, 900);
}
function maybeAskAfterRound() {
  if (!G || G.practice || G.admin || G.status !== 'over' || !needsKeep() || !G.order.includes(G.me)) return;
  const k = G.code + ':' + G.round; if (keepRoundAsked === k) return; keepRoundAsked = k;
  setTimeout(() => { if (G && G.status === 'over' && needsKeep() && $('#keepSheet').hidden) openKeep('round_over'); }, 1600);
}
function openKeep(from) {
  track('keep_shown', { from, method: emailOn ? 'email' : 'pin' });
  closeSheets();
  const card = $('#keepSheetCard');
  const paint = (step) => {
    const nm = esc(me.name);
    card.innerHTML = `<span class="grab" aria-hidden="true"></span>
      <button class="iconbtn sheet-close" data-close="keepSheet" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      ${step === 'email' ? `<div class="who-big">${avatarFor(me.name.toLowerCase(), me.name, { size: 'lg' })}<div><h3 id="kpT">${from === 'round_over' ? 'Add your email?' : me.protect === 'pin' ? `Keep ${nm} safe` : `Keep @${nm} yours`}</h3><p>${from === 'round_over' ? 'Round done. Takes 10 seconds, then your wins follow you to any phone.' : me.protect === 'pin' ? 'Sign in on any phone with a code. Your name, wins and PIN all stay.' : 'Add your email so your wins follow you to any phone.'}</p></div></div>
        <form id="kpForm" style="display:flex;flex-direction:column;gap:12px"><label class="fld" for="kpEmail">Your email<input id="kpEmail" class="inp" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" maxlength="254"></label>
        <p class="note" style="margin:0">Only used to sign you in on a new phone. Never shown to other players. No newsletters.</p>
        <p class="err" id="kpErr" role="alert"></p><button class="btn gold block" style="min-height:54px">Send me a code</button>
        <button type="button" class="linkbtn" id="kpLater" style="align-self:center;color:var(--soft)">Not now</button>
        <p class="note" style="text-align:center;margin:-8px 0 0">${from === 'round_over' ? 'We’ll ask after each round until you add one.' : 'If you skip, we’ll ask again after your next round.'}</p></form>`
      : step === 'code' ? `<div><h3 id="kpT" style="font-size:24px;margin:0 0 6px">Check your email</h3><p style="margin:0;font-size:16px;line-height:1.45;color:var(--soft)">We sent a 6-digit code to <b style="color:var(--ink)">${esc(keepInfo.to)}</b>. It works for 10 minutes.</p></div>
        <form id="kpForm" style="display:flex;flex-direction:column;gap:12px"><label class="fld" for="kpCode">6-digit code<input id="kpCode" class="inp pin-inp" maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" placeholder="••••••"></label>
        <p class="err" id="kpErr" role="alert"></p><button class="btn gold block" style="min-height:54px">Confirm</button><button type="button" class="linkbtn" id="kpBack" style="align-self:center">Use a different email</button></form>`
      : step === 'pin' ? `<div class="who-big">${avatarFor(me.name.toLowerCase(), me.name, { size: 'lg' })}<div><h3 id="kpT">Keep @${nm} yours</h3><p>Pick a PIN to sign in on another phone.</p></div></div>
        <form id="kpForm" style="display:flex;flex-direction:column;gap:12px"><label class="fld" for="kpPin">Choose a 4-digit PIN<input id="kpPin" class="inp pin-inp" maxlength="4" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" type="password" placeholder="••••"></label>
        <p class="err" id="kpErr" role="alert"></p><button class="btn gold block" style="min-height:54px">Save PIN</button></form>`
      : `<div class="who-big">${avatarFor(me.name.toLowerCase(), me.name, { size: 'lg' })}<div><h3 id="kpT">@${nm} is yours</h3><p>${me.protect === 'email' ? 'Sign in anywhere with a code to ' + esc(keepInfo ? keepInfo.to : 'your email') + '.' : 'Sign in on another phone with your PIN.'}</p></div></div>
        <button class="btn gold block" data-close="keepSheet" style="min-height:54px">Done</button>`}`;
    const f = $('#kpForm'); if (!f) return;
    const err = $('#kpErr');
    if (step === 'email') { $('#kpLater').onclick = () => { track('keep_skipped', { from }); $('#keepSheet').hidden = true; }; setTimeout(() => $('#kpEmail').focus(), 40); f.onsubmit = async (e) => {
      e.preventDefault(); const b = f.querySelector('.btn.gold'); b.disabled = true;
      const r = await send('emailStart', { purpose: 'add', who: $('#kpEmail').value }, true); b.disabled = false;
      if (!r.ok) { err.textContent = r.error || 'Couldn’t send a code.'; return; }
      keepInfo = { id: r.id, to: r.to }; paint('code');
    }; }
    if (step === 'code') {
      setTimeout(() => $('#kpCode').focus(), 40);
      $('#kpBack').onclick = () => paint('email');
      $('#kpCode').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); if (e.target.value.length === 6) f.requestSubmit(); };
      f.onsubmit = async (e) => {
        e.preventDefault(); const b = f.querySelector('.btn.gold'); b.disabled = true;
        const r = await send('emailVerify', { id: keepInfo.id, code: $('#kpCode').value }, true); b.disabled = false;
        if (!r.ok) { err.textContent = r.error || 'That code didn’t work.'; $('#kpCode').value = ''; return; }
        me.protect = 'email'; paint('done'); paintFbDots(); if (G && G.status === 'over') render(); else if (view === 'home') showHome(homeTab);
      };
    }
    if (step === 'pin') {
      setTimeout(() => $('#kpPin').focus(), 40);
      $('#kpPin').oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); };
      f.onsubmit = async (e) => {
        e.preventDefault(); const r = await send('setPin', { pin: $('#kpPin').value }, true);
        if (!r.ok) { err.textContent = r.error || 'Couldn’t save that.'; return; }
        me.protect = 'pin'; paint('done'); if (G && G.status === 'over') render();
      };
    }
  };
  paint(emailOn ? 'email' : 'pin');
  $('#keepSheet').hidden = false;
}

function wireOver() {
  maybeAskAfterRound();
  const ko = $('#keepOpen'); if (ko) ko.onclick = () => openKeep('round_over');
  const rb = $('#readyBtn'); if (rb) rb.onclick = () => { const on = !(G.ready || []).includes(G.me); send('ready', { on }); };
  startReadyTick();
  const ol = $('#overLeave'); if (ol) ol.onclick = openLeave;
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
  const l = $('#wpLeave'); if (l) l.onclick = openLeave;
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
    ${seated ? `<div class="handwrap q ${myTurn ? 'myturn' : ''}" id="handwrap">${myTurn && !G.practice ? `<div class="turnbar" aria-hidden="true"><i id="turnBar" style="width:${Math.round(100 * turnLeft() / IDLE_SKIP_S)}%"></i></div>` : ''}<div class="hbar" role="status">${pill}<div class="actions" id="actions"></div></div><button class="scrollbtn l" id="scrL" aria-label="Scroll hand left" hidden>‹</button><div class="hand" id="hand"></div><button class="scrollbtn r" id="scrR" aria-label="Scroll hand right" hidden>›</button></div>`
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
  const fan = el.classList.contains('fan'), max = el.scrollWidth - el.clientWidth, l = !fan && el.scrollLeft > 4, r = !fan && el.scrollLeft < max - 4;
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
    // phones: up to 8 cards sit in a fan you can see all at once; more than that scroll sideways
    const fan = !wide && n > 1 && n <= 8 && !G.admin;
    const room = fan ? avail - 36 : avail; // the fan's outer cards lean out a little
    let ov = gap; if (n > 1 && n * w + (n - 1) * gap > room) ov = Math.max(-w * (wide ? 0.6 : fan ? 0.62 : 0.4), (room - w) / (n - 1) - w);
    if (fan) ov = Math.min(ov, -w * 0.22);
    el.style.setProperty('--ov', ov + 'px');
    el.classList.toggle('fan', fan);
    if (fan) [...el.children].forEach((c, k) => { const d = k - (n - 1) / 2; c.style.setProperty('--rot', (d * Math.min(4, 20 / (n - 1))).toFixed(1) + 'deg'); c.style.setProperty('--arc', Math.round(d * d * 1.4) + 'px'); });
    if (fan) prevScroll = 0;
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
  const tb = $('#turnBar'); if (tb) { const left = turnLeft(); tb.style.width = Math.round(100 * left / IDLE_SKIP_S) + '%'; tb.classList.toggle('low', left <= 10); }
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
    ${false ? `<div class="keep-card" id="keepCard"><span class="t"><b>Keep @${esc(me.name)} yours</b><span>${emailOn ? 'Add your email so your wins follow you to any phone.' : 'Pick a PIN so you can sign in on another phone.'}</span></span><button class="btn sm light" id="keepOpen">${emailOn ? 'Add email' : 'Pick a PIN'}</button></div>` : ''}
    ${askAlerts && !needsKeep() ? `<div class="alert-ask" id="alertAsk"><span class="t"><b>Get a nudge on your turn?</b><span>Only for your turn and round results.</span></span><button class="btn sm" id="alertNo">Not now</button><button class="btn sm light" id="alertYes">Turn on</button></div>` : ''}
    ${readyHTML()}
    <ol class="standings">${ps.map((u) => `<li>${av(u, 'sm')}<span class="nm">${esc(nameOf(u))}${u === G.me ? ' (you)' : ''}</span><span class="left">${count(u) ? count(u) + ' left' : 'out'}</span><span class="w">${G.wins[u] || 0} ★</span></li>`).join('')}</ol>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">${isHost() ? '<button class="btn" id="endBtn">End game</button>' : ''}<button class="btn light" id="overBoard" ${isHost() ? '' : 'style="grid-column:1/-1"'}>Leaderboard</button></div>
    <button class="btn danger-line block" id="overLeave" style="min-height:50px">${LV_ICON.out.replace('width="22" height="22"', 'width="18" height="18"')} Leave table</button>
  </div></div>`;
}


/* ---------- feedback: ideas and problems, answered by the admin ---------- */
const FB_ICON = {
  idea: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/></svg>',
  problem: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  other: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
};
const FB_KIND = { idea: 'Idea', problem: 'Problem', other: 'Other', pin: 'PIN reset' };
const FB_STAT = { new: 'Sent', seen: 'Seen', planned: 'Planned', fixed: 'Fixed', wontdo: 'Not planned', done: 'Done' };
const kchip = (k) => `<span class="kchip ${k}">${FB_KIND[k] || 'Other'}</span>`;
const schip = (s) => `<span class="schip ${s}">${FB_STAT[s] || s}</span>`;
function whenText(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  return daysAgo(t);
}
function paintFbDots() {
  const on = fbUnread > 0;
  $('#fbBtn').hidden = !me; $('#fbDot').hidden = !on; $('#menuFbDot').hidden = !on;
  $('#youDot').hidden = !(on || needsKeep());
  const md = $('#menuBtnDot'); if (md) md.hidden = !on;
  $('#fbBtn').setAttribute('aria-label', on ? `Feedback, ${fbUnread} new repl${fbUnread === 1 ? 'y' : 'ies'}` : 'Feedback');
}
async function loadFb() {
  if (!me) { fbItems = []; fbUnread = 0; paintFbDots(); return; }
  const r = await send('fbMine', {}, true);
  if (!r.ok) return;
  fbItems = r.items; fbUnread = r.unread; paintFbDots();
  if (view === 'feedback') renderFb();
}
function showFeedback(from, openId) {
  needSignIn(() => {
    fbFrom = from || (view === 'game' ? 'game' : 'home');
    closeSheets(); show('feedback');
    if (fbFrom === 'home') setHash('feedback');
    fbView = openId ? 'thread' : 'list'; fbOpenId = openId || null;
    renderFb(); loadFb();
  });
}
$('#fbBtn').onclick = () => showFeedback('home');
$('#menuFb').onclick = () => showFeedback('game');
$('#fbBack').onclick = () => {
  if (fbView !== 'list') { fbView = 'list'; fbOpenId = null; renderFb(); return; }
  if (fbFrom === 'game' && curCode) { show('game'); setHash(curCode); render(); } else showHome();
};
function renderFb() {
  const body = $('#fbBody'), chip = $('#fbHeadChip'); chip.innerHTML = '';
  if (fbView === 'compose') {
    $('#fbTitle').textContent = 'New message';
    const here = curCode && fbFrom === 'game' ? curCode : null;
    body.innerHTML = `<form id="fbForm" style="display:flex;flex-direction:column;gap:16px">
      <fieldset style="margin:0;padding:0;border:0;display:flex;flex-direction:column;gap:8px"><legend class="fb-h" style="margin-bottom:8px">What is it?</legend>
        <div class="fb-kinds">${['idea', 'problem', 'other'].map((k) => `<button type="button" data-k="${k}" aria-pressed="${k === fbKind}">${FB_ICON[k]}${FB_KIND[k]}</button>`).join('')}</div></fieldset>
      <label class="fld" for="fbText">${fbKind === 'problem' ? 'What happened?' : fbKind === 'idea' ? 'Your idea' : 'Your message'}
        <textarea id="fbText" class="fb-ta" maxlength="1000" placeholder="${fbKind === 'problem' ? 'What were you doing just before?' : fbKind === 'idea' ? 'What would make Last Card better?' : 'Anything at all'}">${esc(fbDraft)}</textarea></label>
      <span class="note" id="fbCount" style="margin-top:-8px">${fbDraft.length} / 1000</span>
      <div class="fb-info"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg><span>Sent as <b>${esc(me ? me.name : '')}</b>${here ? `, with table <b>${esc(here)}</b>` : ''} and your device type, so the admin can look into it. Only the admin sees this.</span></div>
      <p class="err" id="fbErr" role="alert"></p>
      <button class="btn gold block" type="submit" style="min-height:56px;font-size:17px">Send to admin</button>
    </form>`;
    return;
  }
  if (fbView === 'thread') {
    const t = fbItems.find((x) => x.id === fbOpenId);
    if (!t) { $('#fbTitle').textContent = 'Feedback'; body.innerHTML = '<p class="note">Loading…</p>'; return; }
    $('#fbTitle').textContent = 'Your ' + (t.kind === 'pin' ? 'PIN reset' : (FB_KIND[t.kind] || 'message').toLowerCase());
    chip.innerHTML = schip(t.status);
    const order = ['new', 'seen', t.status === 'wontdo' ? 'wontdo' : 'planned', t.status === 'wontdo' ? '' : 'fixed'];
    const idx = { new: 0, seen: 1, planned: 2, wontdo: 2, fixed: 3, done: 3 }[t.status] || 0;
    const steps = t.kind === 'pin' ? '' : `<ol class="fb-steps" aria-label="Progress">${['Sent', 'Seen', t.status === 'wontdo' ? 'Not planned' : 'Planned', 'Fixed'].map((l, i) => `<li class="${i <= idx ? 'on' : ''} ${i === idx ? 'cur' : ''}" ${i === idx ? 'aria-current="step"' : ''}><i></i>${l}</li>`).join('')}</ol>`;
    const msgs = t.msgs.map((m, i) => {
      if (m.from === 'status') return `<p class="sysline">Marked as ${esc(FB_STAT[m.text] || m.text)} · ${whenText(m.at)}</p>`;
      const mine = m.from === 'user';
      return `<div class="bub ${mine ? 'me' : 'them'}">${mine ? '' : '<span class="by">Last Card admin</span>'}${esc(m.text)}</div><span class="bub-t ${mine ? 'r' : ''}">${whenText(m.at)}${i === 0 && t.code ? ' · table ' + esc(t.code) : ''}</span>`;
    }).join('');
    const seenLine = t.status !== 'new' && !t.msgs.some((m) => m.from === 'admin') ? '<p class="sysline">Seen by the admin</p>' : '';
    body.innerHTML = `${steps}<div class="fb-thread">${msgs}${seenLine}</div>
      <form class="fb-replyrow" id="fbReplyForm"><label class="sr" for="fbReply">Reply</label><input id="fbReply" class="inp" maxlength="1000" placeholder="Reply to the admin…" autocomplete="off"><button class="btn gold" type="submit">Send</button></form>`;
    if (t.unread) { t.unread = false; fbUnread = Math.max(0, fbUnread - 1); paintFbDots(); send('fbRead', { id: t.id }, true); }
    return;
  }
  $('#fbTitle').textContent = 'Feedback';
  body.innerHTML = `<section class="fb-intro"><p>Got an idea, or something broke? The person who runs Last Card reads every message and answers here.</p>
      <button class="btn gold block" id="fbNew" style="min-height:52px;font-size:16px">Write a message</button></section>
    ${fbItems.length ? `<h2 class="fb-h">Your messages</h2>` + fbItems.map((t) => {
      const lastAdmin = [...t.msgs].reverse().find((m) => m.from === 'admin');
      const sub = t.unread ? `<span class="sub hot">Admin replied · ${whenText(lastAdmin ? lastAdmin.at : t.updated)}</span>` : lastAdmin ? `<span class="sub">Admin replied · ${whenText(lastAdmin.at)}</span>` : t.status === 'seen' ? '<span class="sub">Seen by the admin</span>' : `<span class="sub">Sent ${whenText(t.at)}</span>`;
      return `<button class="fb-item ${t.unread ? 'unread' : ''}" data-fb="${t.id}"><span class="row">${kchip(t.kind)}${schip(t.status)}${t.unread ? '<span class="udot" aria-label="New reply"></span>' : ''}</span><b>${esc(t.msgs[0].text.length > 90 ? t.msgs[0].text.slice(0, 88) + '…' : t.msgs[0].text)}</b>${sub}</button>`;
    }).join('') : '<p class="note" style="text-align:center">Nothing sent yet. Your messages and the admin’s answers show up here.</p>'}`;
}
$('#fbBody').addEventListener('click', (e) => {
  if (e.target.closest('#fbNew')) { fbView = 'compose'; renderFb(); setTimeout(() => $('#fbText').focus(), 30); return; }
  const it = e.target.closest('[data-fb]'); if (it) { fbView = 'thread'; fbOpenId = it.dataset.fb; renderFb(); window.scrollTo(0, 0); return; }
  const k = e.target.closest('[data-k]'); if (k) { fbDraft = $('#fbText').value; fbKind = k.dataset.k; renderFb(); $('#fbText').focus(); }
});
$('#fbBody').addEventListener('input', (e) => { if (e.target.id === 'fbText') { fbDraft = e.target.value; $('#fbCount').textContent = fbDraft.length + ' / 1000'; } });
$('#fbBody').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.target.id === 'fbForm') {
    const text = $('#fbText').value.trim();
    if (text.length < 2) { $('#fbErr').textContent = 'Write a few words first.'; return; }
    const b = e.target.querySelector('[type=submit]'); b.disabled = true;
    const r = await send('fbSend', { kind: fbKind, text }, true);
    b.disabled = false;
    if (!r.ok) { $('#fbErr').textContent = r.error || 'Couldn’t send. Try again.'; return; }
    fbDraft = ''; fbItems.unshift(r.item); fbView = 'thread'; fbOpenId = r.item.id; renderFb();
    toast('Sent. The admin gets it straight away.');
  } else if (e.target.id === 'fbReplyForm') {
    const inp = $('#fbReply'), text = inp.value.trim(); if (!text) return;
    const r = await send('fbReply', { id: fbOpenId, text }, true);
    if (!r.ok) { toast(r.error || 'Couldn’t send. Try again.'); return; }
    fbItems = fbItems.map((x) => (x.id === r.item.id ? r.item : x)); renderFb();
  }
});
// a reply or status change from the admin: a dot, and a pop-up (held back while it's your turn)
socket.on('fbUpdate', (m) => {
  if (!m) return;
  loadFb();
  if (!m.text) return;
  fbQueued = m; flushFbToast();
});
function flushFbToast() {
  if (!fbQueued) return;
  const myTurnNow = view === 'game' && G && G.status === 'playing' && G.order[G.turn] === G.me;
  if (myTurnNow || view === 'feedback') { if (view === 'feedback') fbQueued = null; else setTimeout(flushFbToast, 2500); return; }
  const m = fbQueued; fbQueued = null;
  Snd.play('chat');
  toast('', 'fbreply', `<span><b>The admin replied</b><br>“${esc(m.text.length > 60 ? m.text.slice(0, 58) + '…' : m.text)}”</span><button class="linkbtn" data-fbopen="${esc(m.id)}">Read</button>`);
}
$('#toasts').addEventListener('click', (e) => { const b = e.target.closest('[data-fbopen]'); if (b) { b.closest('.toast').remove(); showFeedback(view === 'game' ? 'game' : 'home', b.dataset.fbopen); } });

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
  const open = new Set(d.tables.map((t) => t.code));
  $('#admChat').innerHTML = (d.chat || []).length ? d.chat.map((m) => {
    const fb = FEEDBACK.test(m.text);
    const cd = open.has(m.code) ? `<button class="cd" data-watch="${esc(m.code)}" aria-label="Watch table ${esc(m.code)}">${esc(m.code)}</button>` : `<span class="cd">${esc(m.code)}</span>`;
    return `<li class="${fb ? 'fb' : ''}"><span class="h">${cd}<b>${esc(m.name)}</b><span>${ago(d.now - m.at)} ago</span>${fb ? '<span class="fbt">Might be feedback</span>' : ''}</span><span class="x">${esc(m.text)}</span></li>`;
  }).join('') : '<li class="note">No messages yet. Table chat shows up here as people talk.</li>';
  admSetTab(admTab);
  admAlertsUI(d.alerts || 'start');
  paintAdmTodo(d.fbTodo || 0);
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
// words that usually mean someone hit a problem or wants something, so those messages stand out
const FEEDBACK = /\b(bug|bugs|broken|issue|problem|error|crash\w*|stuck|frozen|freez\w*|lag\w*|glitch\w*|not working|doesn'?t work|isn'?t working|can'?t|cannot|won'?t|feature|add|wish|should|please|pls|option|setting|why)\b/i;
$('#admChat').addEventListener('click', (e) => { const b = e.target.closest('[data-watch]'); if (b) adminWatch(b.dataset.watch); });

// ---------- admin inbox: feedback threads, replies, statuses, PIN resets ----------
let admFb = [], admFbFilter = 'needs', admFbTodo = -1, admFbOpenId = null, admFbStatus = null;
const needsReply = (t) => t.adminUnread || (t.kind === 'pin' ? t.status === 'new' : ['new', 'seen'].includes(t.status) && t.msgs[t.msgs.length - 1].from === 'user');
async function loadAdmFb() {
  const r = await send('adminFb', {}, true);
  if (!r.ok) return;
  admFb = r.items; renderAdmInbox();
  if (admFbOpenId && !$('#admThread').hidden) renderAdmThread(admFb.find((x) => x.id === admFbOpenId));
}
function paintAdmTodo(n) {
  const b = $('#admTabN'); b.hidden = !n; b.textContent = n;
  $('#admIN').textContent = n ? `${n} need${n === 1 ? 's' : ''} you` : '';
  if (n !== admFbTodo) { const first = admFbTodo < 0; admFbTodo = n; if (!first || !admFb.length) loadAdmFb(); }
}
function renderAdmInbox() {
  const F = { needs: ['Needs reply', needsReply], planned: ['Planned', (t) => t.status === 'planned'], fixed: ['Fixed', (t) => t.status === 'fixed' || t.status === 'done'], all: ['All', () => true] };
  $('#admIFilt').innerHTML = Object.entries(F).map(([k, [l, f]]) => `<button type="button" data-ff="${k}" aria-pressed="${k === admFbFilter}">${l} · ${admFb.filter(f).length}</button>`).join('');
  const list = admFb.filter(F[admFbFilter][1]);
  $('#admInbox').innerHTML = list.length ? list.map((t) => `<button class="fb-item ${needsReply(t) ? 'todo' : ''}" data-fbadm="${t.id}">
      <span class="row">${kchip(t.kind)}${avatarFor(t.name.toLowerCase(), t.name, { size: 'sm' })}<b style="font-size:14px">${esc(t.name)}</b><span class="sub">${whenText(t.updated)}${t.code ? ' · ' + esc(t.code) : ''}</span>${t.adminUnread ? '<span class="newb">New</span>' : `<span style="margin-left:auto">${schip(t.status)}</span>`}</span>
      <span style="font-size:15px;line-height:1.45">${esc(t.msgs[t.msgs.length - 1].from === 'status' ? t.msgs[0].text : [...t.msgs].reverse().find((m) => m.from !== 'status').text)}</span>
      ${t.msgs.length > 1 ? `<span class="sub">${t.msgs.filter((m) => m.from !== 'status').length} messages</span>` : ''}
    </button>`).join('') : `<p class="adm-empty">${admFbFilter === 'needs' ? 'All caught up. New ideas and problems land here.' : 'Nothing here yet.'}</p>`;
}
$('#admIFilt').addEventListener('click', (e) => { const b = e.target.closest('[data-ff]'); if (b) { admFbFilter = b.dataset.ff; renderAdmInbox(); } });
$('#admInbox').addEventListener('click', (e) => { const b = e.target.closest('[data-fbadm]'); if (b) openAdmThread(b.dataset.fbadm); });
async function openAdmThread(id) {
  admFbOpenId = id; admFbStatus = null;
  const t0 = admFb.find((x) => x.id === id);
  closeSheets(); $('#admThread').hidden = false;
  $('#admThreadCard').innerHTML = '';
  renderAdmThread(t0 || null);
  const r = await send('adminFbOpen', { id }, true);
  if (!r.ok) { $('#admThreadCard').innerHTML = `<p class="err">${esc(r.error || 'Couldn’t open that.')}</p>`; return; }
  admFb = admFb.some((x) => x.id === id) ? admFb.map((x) => (x.id === id ? r.item : x)) : [r.item, ...admFb];
  renderAdmInbox(); renderAdmThread(r.item);
}
function renderAdmThread(t) {
  const card = $('#admThreadCard');
  const draft = $('#atText') ? $('#atText').value : '', hadFocus = document.activeElement && document.activeElement.id === 'atText'; // keep what you were typing
  if (!t) { card.innerHTML = '<span class="grab" aria-hidden="true"></span><p class="note">Loading…</p>'; return; }
  const close = '<button class="iconbtn sheet-close" data-close="admThread" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
  const msgs = t.msgs.map((m) => m.from === 'status' ? `<p class="sysline">Marked as ${esc(FB_STAT[m.text] || m.text)} · ${whenText(m.at)}</p>`
    : `<div class="bub ${m.from === 'admin' ? 'me' : 'them'}">${m.from === 'admin' ? '' : `<span class="by">${esc(t.name)}</span>`}${esc(m.text)}</div><span class="bub-t ${m.from === 'admin' ? 'r' : ''}">${whenText(m.at)}</span>`).join('');
  const st = admFbStatus || t.status;
  const meta = [FB_KIND[t.kind], t.code ? 'table ' + t.code : 'from home', t.device, whenText(t.at)].filter(Boolean).join(' · ');
  let actions;
  if (t.kind === 'pin') {
    actions = t.status === 'new'
      ? `<button class="btn gold block" id="atPin" style="min-height:54px">Allow ${esc(t.name)} a new PIN</button>
         <p class="note" style="margin:0">The next sign-in as ${esc(t.name)} within a day picks a new PIN. Check it’s really them first, for example in your group chat.</p>`
      : `<p class="note" style="margin:0">Done. ${esc(t.name)} can pick a new PIN when they next sign in (for a day).</p>`;
  } else {
    actions = `<div><p class="fb-h" style="margin:0 0 8px">Status ${esc(t.name)} sees</p><div class="at-stat" role="group" aria-label="Status">${['seen', 'planned', 'fixed', 'wontdo'].map((k) => `<button type="button" data-st="${k}" aria-pressed="${k === st}">${FB_STAT[k]}</button>`).join('')}</div></div>
      <div class="at-quick" aria-label="Quick replies">${['Thanks, looking into it', 'Fixed now, give it another go', 'Good idea, it’s on the list', 'Thanks! Not planning this one for now'].map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <label class="sr" for="atText">Reply to ${esc(t.name)}</label>
      <textarea id="atText" class="fb-ta" style="min-height:100px" maxlength="1000" placeholder="Reply to ${esc(t.name)}…"></textarea>
      <p class="err" id="atErr" role="alert"></p>
      <button class="btn gold block" id="atSend" style="min-height:54px">Send reply</button>
      <p class="note" style="margin:0;text-align:center">${esc(t.name)} gets a pop-up, or a phone alert if the app is closed.</p>`;
  }
  card.innerHTML = `<span class="grab" aria-hidden="true"></span>${close}
    <div class="at-head">${avatarFor(t.name.toLowerCase(), t.name)}<span class="t"><b id="atT">${esc(t.name)}</b><span>${esc(meta)}</span></span></div>
    <div class="fb-thread">${msgs}</div>
    ${t.open ? `<button class="btn block" id="atWatch" style="min-height:44px">Watch ${esc(t.code)} (still open)</button>` : ''}
    ${actions}`;
  const ta = $('#atText'); if (ta && draft) { ta.value = draft; if (hadFocus) ta.focus(); }
  paintAtSend(t);
}
function paintAtSend(t) {
  const b = $('#atSend'); if (!b) return;
  const text = ($('#atText').value || '').trim(), st = admFbStatus && admFbStatus !== t.status ? admFbStatus : null;
  b.textContent = text && st ? `Send reply and mark ${FB_STAT[st]}` : text ? 'Send reply' : st ? `Mark as ${FB_STAT[st]}` : 'Send reply';
}
$('#admThreadCard').addEventListener('click', async (e) => {
  const t = admFb.find((x) => x.id === admFbOpenId); if (!t) return;
  const s = e.target.closest('[data-st]'); if (s) { admFbStatus = s.dataset.st; $$('#admThreadCard [data-st]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.st === admFbStatus))); paintAtSend(t); return; }
  const q = e.target.closest('[data-q]'); if (q) { const ta = $('#atText'); ta.value = q.dataset.q; if (/Fixed now/.test(q.dataset.q)) admFbStatus = 'fixed'; else if (/on the list/.test(q.dataset.q)) admFbStatus = 'planned'; else if (/Not planning/.test(q.dataset.q)) admFbStatus = 'wontdo'; $$('#admThreadCard [data-st]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.st === (admFbStatus || t.status)))); paintAtSend(t); ta.focus(); return; }
  if (e.target.closest('#atWatch')) { closeSheets(); adminWatch(t.code); return; }
  if (e.target.closest('#atPin')) { const r = await send('adminFbPin', { id: t.id }, true); if (r.ok) { admFb = admFb.map((x) => (x.id === t.id ? r.item : x)); renderAdmThread(r.item); renderAdmInbox(); toast(`${t.name} can pick a new PIN now`); } else toast(r.error || 'Couldn’t do that.'); return; }
  if (e.target.closest('#atSend')) {
    const text = $('#atText').value.trim(), st = admFbStatus && admFbStatus !== t.status ? admFbStatus : null;
    if (!text && !st) { $('#atErr').textContent = 'Write a reply or pick a status.'; return; }
    const b = $('#atSend'); b.disabled = true;
    const r = await send('adminFbReply', { id: t.id, text, status: st || undefined }, true);
    b.disabled = false;
    if (!r.ok) { $('#atErr').textContent = r.error || 'Couldn’t send.'; return; }
    admFb = admFb.map((x) => (x.id === t.id ? r.item : x)); admFbStatus = null;
    renderAdmThread(r.item); renderAdmInbox(); toast(text ? `Sent to ${t.name}` : `Marked as ${FB_STAT[r.item.status]}`);
  }
});
$('#admThreadCard').addEventListener('input', (e) => { if (e.target.id === 'atText') { const t = admFb.find((x) => x.id === admFbOpenId); if (t) paintAtSend(t); } });
socket.on('adminFeedback', (m) => {
  if (!m || !me || !me.admin) return;
  Snd.play('chat');
  toast('', 'admalert', `<span><b>${esc(m.head)}:</b> ${esc(m.text.length > 60 ? m.text.slice(0, 58) + '…' : m.text)}</span><button class="linkbtn" data-fbadmin="${esc(m.id)}">Open</button>`);
  if (view === 'admin') loadAdmFb();
});
$('#toasts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-fbadmin]'); if (!b) return;
  b.closest('.toast').remove();
  const id = b.dataset.fbadmin;
  if (view !== 'admin') showAdmin();
  admSetTab('inbox'); loadAdmFb().then(() => openAdmThread(id));
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
  chatMsgs = Array.isArray(r.chat) ? r.chat.slice(-60) : []; renderChat();
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
  practiceStat(); track('practice_started', { bots: bots.length, first_time: !load('lc-coach-done') });
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
  if (practice.s.status === 'over' && practice.anOver !== practice.s.round) { practice.anOver = practice.s.round; track('practice_round_finished', { won: practice.s.winner === 'you', coach_on: !!practice.coach, bots: practice.bots.length }); }
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
