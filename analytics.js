// Usage analytics (PostHog). Off unless POSTHOG_KEY is set, so local runs and tests send nothing.
//
// Who is who: a signed-in person is their account key ("ravi"); before sign-in they are their device,
// "dev_" + a hash of the device token. The phone uses the same device id and links it to the account
// when someone signs in, so a funnel can follow one person from opening a link to their first round.
//
// Never sent: chat or feedback text, PINs, sessions, push addresses. Admin accounts are not counted.
const crypto = require('crypto');

const KEY = process.env.POSTHOG_KEY || '';
const HOST = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
// the browser loads PostHog's script from its asset host (us.i.posthog.com -> us-assets.i.posthog.com)
const ASSETS = (process.env.POSTHOG_ASSETS || HOST.replace('.i.posthog.com', '-assets.i.posthog.com')).replace(/\/+$/, '');

let client = null;
const memory = []; // tests: ANALYTICS_MEMORY=1 keeps events here instead of sending them
if (KEY && process.env.ANALYTICS_MEMORY !== '1') {
  try {
    const { PostHog } = require('posthog-node');
    client = new PostHog(KEY, { host: HOST, flushAt: 20, flushInterval: 10000 });
    client.on && client.on('error', (e) => console.error('analytics:', e && e.message));
  } catch (e) { console.error('analytics off:', e.message); }
}
const enabled = () => !!(client || (KEY && process.env.ANALYTICS_MEMORY === '1'));

const deviceId = (token) => 'dev_' + crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);

// property names that must never leave the server, whatever a caller passes
const BANNED = /^(text|message_text|chat|pin|session|token|sub|subscription|endpoint|body|email|code|who)$/i;
function clean(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (BANNED.test(k) || v === undefined) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
  }
  return out;
}

function capture(distinctId, event, props) {
  if (!enabled() || !distinctId) return;
  const properties = clean(props);
  if (client) client.capture({ distinctId, event, properties });
  else memory.push({ distinctId, event, properties });
}

// link a device to the account it just signed in as (server side too, in case the phone script is blocked)
function link(account, token) {
  if (!enabled() || !account || !token) return;
  if (client) client.alias({ distinctId: account, alias: deviceId(token) });
  else memory.push({ distinctId: account, event: '$create_alias', properties: { alias: deviceId(token) } });
}

// what the phone needs to start PostHog itself (all of it is public by design)
function clientConfig(token) {
  return enabled() ? { key: KEY, host: HOST, assets: ASSETS, deviceId: deviceId(token) } : null;
}

async function shutdown() { if (client) { try { await client.shutdown(); } catch (e) {} } }

module.exports = { capture, link, clientConfig, deviceId, shutdown, enabled, memory };
