/* Moving to the new address without signing anyone out.
   Each web address keeps its own saved sign-in, so on the old onrender.com address we hand this
   phone's saved keys to the server for two minutes, jump to the new address with a one-time code,
   and the new address collects them. Then the app loads as usual. */
(function () {
  const KEYS = ['lc-token', 'lc-session', 'lc-nick', 'lc-known', 'lc-sound', 'lc-coach-done', 'lc-practice', 'lc-invite'];
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const post = (url, body) => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null)).finally(() => clearTimeout(t));
  };
  function boot() {
    for (const src of ['/socket.io/socket.io.js', '/engine.js', '/app.js']) {
      const s = document.createElement('script'); s.src = src; s.async = false; document.body.appendChild(s);
    }
  }

  // 1. Old address: send this phone to the new one, carrying its sign-in along.
  async function leaveOld() {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    const cfg = await fetch('/move.json', { cache: 'no-store', signal: ctl.signal }).then((r) => r.json()).finally(() => clearTimeout(t));
    if (!cfg || !cfg.to || cfg.to === location.host) return false;
    const data = {}; for (const k of KEYS) { const v = get(k); if (v) data[k] = v; }
    const back = location.hash;
    let code = '';
    if (Object.keys(data).length) { const r = await post('/handoff', { data }); code = (r && r.code) || ''; }
    const src = /src=push/.test(location.search) ? '?src=push' : '';
    location.replace('https://' + cfg.to + '/' + src + (code ? '#handoff=' + code + (back ? '&back=' + encodeURIComponent(back) : '') : back));
    return true;
  }

  // 2. New address: collect the sign-in, unless this phone already has one here.
  async function arriveNew() {
    const m = /^#handoff=([a-f0-9]{32})(?:&back=(.*))?$/.exec(location.hash);
    if (!m) return;
    const back = m[2] ? decodeURIComponent(m[2]) : '';
    history.replaceState(null, '', location.pathname + location.search + (/^#[A-Za-z0-9-]*$/.test(back) ? back : ''));
    const r = await post('/handoff/redeem', { code: m[1] }).catch(() => null);
    if (!r || !r.data) return;
    if (get('lc-session')) return; // already signed in at the new address: keep that
    for (const k of KEYS) if (typeof r.data[k] === 'string' && r.data[k].length < 4000) set(k, r.data[k]);
  }

  (async () => {
    try {
      if (/\.onrender\.com$/.test(location.hostname)) { if (await leaveOld()) return; }
      else await arriveNew();
    } catch (e) { /* any trouble: just open the app where we are */ }
    boot();
  })();
})();
