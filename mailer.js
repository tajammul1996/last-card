// Sign-in codes by email, sent through Resend (https://resend.com).
// Needs RESEND_API_KEY, plus EMAIL_FROM like "Last Card <codes@saylastcard.com>" on a domain verified in Resend.
// Without a key, email sign-in is switched off and the app offers a PIN instead.
// EMAIL_TEST=1 keeps sent codes in memory instead of sending (for the tests).

const KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.EMAIL_FROM || 'Last Card <codes@saylastcard.com>';
const TEST = process.env.EMAIL_TEST === '1';
const outbox = []; // test mode only

const enabled = () => TEST || !!KEY;

async function sendCode(to, code, name) {
  const subject = `${code} is your Last Card code`;
  const text = `Hi${name ? ' ' + name : ''},\n\nYour Last Card code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.\n`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#0f2a3f">
    <p style="font-size:16px;margin:0 0 12px">Hi${name ? ' ' + escapeHtml(name) : ''},</p>
    <p style="font-size:16px;margin:0 0 16px">Your Last Card code is</p>
    <p style="font-size:36px;font-weight:800;letter-spacing:8px;margin:0 0 16px">${code}</p>
    <p style="font-size:14px;color:#55687a;margin:0">It works for 10 minutes. If you didn't ask for it, you can ignore this email.</p></div>`;
  if (TEST) { outbox.push({ to, code, at: Date.now() }); if (process.env.EMAIL_TEST_LOG) console.log('[email-test]', to, code); return true; }
  if (!KEY) return false;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    });
    if (!r.ok) { console.error('email send failed', r.status, (await r.text().catch(() => '')).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.error('email send failed', e.message); return false; }
  finally { clearTimeout(t); }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

module.exports = { enabled, sendCode, outbox };
