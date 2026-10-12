// Runs the Worker against a real SQLite database (Node's built-in node:sqlite)
// standing in for Cloudflare D1. No Cloudflare account or network needed.
//
//   node --experimental-sqlite test/run-tests.mjs     (Node 22+)

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { getAccessEmail } from '../src/access.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/* ---------- minimal D1 stand-in ---------- */
function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(root + 'schema.sql', 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    _run: () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      db.exec('BEGIN');
      try { list.forEach((s) => s._run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return [];
    },
  };
}

/* ---------- helpers ---------- */
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const SITE = 'http://localhost:8000';
function call(env, method, path, body, headers = {}) {
  const init = { method, headers: { Origin: SITE, 'CF-Connecting-IP': headers.ip || '203.0.113.7', ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return worker.fetch(new Request('https://api.test' + path, init), env).then(async (r) => {
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  });
}

const inDays = (n) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const base = (over = {}) => ({
  community: 'philly', title: 'Monthly Meetup', date: inDays(10), startTime: '18:30', endTime: '20:30',
  venue: 'WeWork Center City', address: '1900 Market St, Philadelphia, PA', host: 'ATIHx Philly with Code for Philly', url: 'https://lu.ma/example',
  description: 'Lightning talks on responsible AI, then pizza and conversation.', submitterName: 'Ada', submitterEmail: 'ada@example.com', turnstileToken: 'x', ...over,
});

function devEnv(over = {}) {
  return {
    DB: makeD1(), ENVIRONMENT: 'development', ALLOWED_ORIGINS: SITE, AUTO_PUBLISH: 'false',
    IP_HASH_SALT: 'salt', DEV_ADMIN_EMAIL: 'chad@example.com', ...over,
  };
}

/* ---------- tests ---------- */
console.log('Public API');
const env = devEnv();
env.DB.raw.exec(`INSERT INTO moderators (email, role, community_id) VALUES ('chad@example.com','admin',''), ('dclead@example.com','lead','dc')`);
let firstId;

await test('lists communities with no events yet', async () => {
  const r = await call(env, 'GET', '/api/events');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.communities.map((c) => c.id), ['philly', 'dc']); // ordered by name: Philadelphia, Washington
  assert.equal(r.data.events.length, 0);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

await test('accepts a valid submission as pending', async () => {
  const r = await call(env, 'POST', '/api/submissions', base());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'pending');
  assert.equal(r.headers.get('access-control-allow-origin'), SITE);
  firstId = r.data.id;
});

await test('pending events are not public', async () => {
  const r = await call(env, 'GET', '/api/events');
  assert.equal(r.data.events.length, 0);
});

await test('rejects an exact duplicate', async () => {
  const r = await call(env, 'POST', '/api/submissions', base(), { ip: '203.0.113.8' });
  assert.equal(r.status, 409);
  assert.match(r.data.message, /already submitted/);
});

await test('catches duplicates that differ only in case/punctuation', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ title: '  monthly MEETUP!! ' }), { ip: '203.0.113.9' });
  assert.equal(r.status, 409);
});

await test('flags a similar event on the same day for review', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ title: 'October Meetup' }), { ip: '203.0.113.10' });
  assert.equal(r.status, 201);
  const row = env.DB.raw.prepare('SELECT possible_duplicate_of FROM events WHERE id = ?').get(r.data.id);
  assert.equal(row.possible_duplicate_of, firstId);
});

await test('returns field errors for bad input', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ title: 'x', date: '2020-01-01', endTime: '17:00', url: 'javascript:alert(1)', submitterEmail: 'nope' }), { ip: '203.0.113.11' });
  assert.equal(r.status, 422);
  for (const f of ['title', 'date', 'endTime', 'url', 'submitterEmail']) assert.ok(r.data.fields[f], 'missing error for ' + f);
});

await test('requires location, hosts and description on the public form', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ title: 'Thin Event', venue: '', address: '', host: '', description: 'tbd' }), { ip: '203.0.113.15' });
  assert.equal(r.status, 422);
  for (const f of ['venue', 'host', 'description']) assert.ok(r.data.fields[f], 'missing error for ' + f);
  const ok = await call(env, 'POST', '/api/submissions', base({ title: 'Address Only', venue: '', date: inDays(40) }), { ip: '203.0.113.16' });
  assert.equal(ok.status, 201, 'an address alone counts as a location');
});

await test('rejects unknown communities', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ community: 'mars', title: 'Mars Meetup' }), { ip: '203.0.113.12' });
  assert.equal(r.status, 422);
  assert.ok(r.data.fields.community);
});

await test('blocks submissions from other websites', async () => {
  const r = await call(env, 'POST', '/api/submissions', base({ title: 'Spam' }), { Origin: 'https://evil.example', ip: '203.0.113.13' });
  assert.equal(r.status, 403);
});

await test('silently drops honeypot submissions', async () => {
  const before = env.DB.raw.prepare('SELECT COUNT(*) n FROM events').get().n;
  const r = await call(env, 'POST', '/api/submissions', base({ title: 'Bot Event', website: 'http://spam' }), { ip: '203.0.113.14' });
  assert.equal(r.status, 202);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM events').get().n, before);
});

await test('rate limits a single visitor after 5 submissions an hour', async () => {
  const ip = '198.51.100.1';
  for (let i = 0; i < 5; i++) {
    const r = await call(env, 'POST', '/api/submissions', base({ community: 'dc', title: 'DC Event ' + i, date: inDays(20 + i) }), { ip });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const r = await call(env, 'POST', '/api/submissions', base({ community: 'dc', title: 'DC Event 6', date: inDays(30) }), { ip });
  assert.equal(r.status, 429);
});

await test('stores a salted hash, never the raw IP', async () => {
  const rows = env.DB.raw.prepare('SELECT ip_hash FROM submission_log').all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.ip_hash)));
});

console.log('Review (admin)');
await test('identifies the signed-in admin', async () => {
  const r = await call(env, 'GET', '/api/admin/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.isAdmin, true);
  assert.equal(r.data.communities.length, 2);
});

await test('lists the pending queue with duplicate hints and contact info', async () => {
  const r = await call(env, 'GET', '/api/admin/events?status=pending');
  assert.equal(r.status, 200);
  assert.equal(r.data.counts.pending, 8);
  const flagged = r.data.events.find((e) => e.title === 'October Meetup');
  assert.equal(flagged.possibleDuplicate.id, firstId);
  assert.equal(flagged.submitterEmail, 'ada@example.com');
});

await test('approving makes an event public and adds it to the feeds', async () => {
  const r = await call(env, 'POST', `/api/admin/events/${firstId}/status`, { status: 'approved' });
  assert.equal(r.status, 200);
  const pub = await call(env, 'GET', '/api/events');
  assert.equal(pub.data.events.length, 1);
  assert.equal(pub.data.events[0].start.slice(11), '18:30');
  assert.equal(pub.data.events[0].submitterEmail, undefined, 'contact info must stay private');
  assert.equal(pub.data.events[0].host, 'ATIHx Philly with Code for Philly');
  const ics = await call(env, 'GET', '/calendars/philly.ics');
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(ics.data, /SUMMARY:Monthly Meetup · ATIHx Philly/);
  assert.match(ics.data.replace(/\r\n /g, ''), /DESCRIPTION:Hosted by ATIHx Philly with Code for Philly/);
  assert.match(ics.data, /DTSTART;TZID=America\/New_York:\d{8}T183000/);
  const dc = await call(env, 'GET', '/calendars/dc.ics');
  assert.doesNotMatch(dc.data, /VEVENT/);
  const both = await call(env, 'GET', '/calendars/dc+philly.ics');
  assert.match(both.data, /X-WR-CALNAME:ATIHx DC \+ Philly|X-WR-CALNAME:ATIHx DC \\\+ Philly/);
  assert.equal((await call(env, 'GET', '/calendars/mars.ics')).status, 404);
});

await test('submitting an approved event again says it is already on the calendar', async () => {
  const r = await call(env, 'POST', '/api/submissions', base(), { ip: '203.0.113.20' });
  assert.equal(r.status, 409);
  assert.match(r.data.message, /already on the calendar/);
});

await test('editing an event re-checks duplicates', async () => {
  const pending = (await call(env, 'GET', '/api/admin/events?status=pending')).data.events;
  const oct = pending.find((e) => e.title === 'October Meetup');
  const clash = await call(env, 'PUT', `/api/admin/events/${oct.id}`, { ...oct, title: 'Monthly Meetup' });
  assert.equal(clash.status, 409);
  const ok = await call(env, 'PUT', `/api/admin/events/${oct.id}`, { ...oct, title: 'October Social', venue: 'New venue' });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

await test('rejecting frees the slot for a corrected resubmission', async () => {
  const pending = (await call(env, 'GET', '/api/admin/events?status=pending')).data.events;
  const ev = pending.find((e) => e.title === 'DC Event 0');
  await call(env, 'POST', `/api/admin/events/${ev.id}/status`, { status: 'rejected', note: 'Wrong time' });
  const r = await call(env, 'POST', '/api/submissions', base({ community: 'dc', title: 'DC Event 0', date: ev.date }), { ip: '203.0.113.21' });
  assert.equal(r.status, 201);
});

await test('admins can manage moderators and communities', async () => {
  let r = await call(env, 'POST', '/api/admin/moderators', { email: 'Philly.Lead@Example.com', role: 'lead', community: 'philly' });
  assert.equal(r.status, 201);
  r = await call(env, 'GET', '/api/admin/moderators');
  assert.ok(r.data.moderators.some((m) => m.email === 'philly.lead@example.com' && m.community === 'philly'));
  r = await call(env, 'DELETE', '/api/admin/moderators', { email: 'chad@example.com', community: '' });
  assert.equal(r.status, 403, 'cannot remove own admin access');
  r = await call(env, 'POST', '/api/admin/communities', { id: 'boston', name: 'Boston/Cambridge, MA', short: 'Boston', color: '#8a6cff' });
  assert.equal(r.status, 201);
  r = await call(env, 'GET', '/api/events');
  assert.ok(r.data.communities.some((c) => c.id === 'boston'));
});

console.log('Community lead permissions');
const leadEnv = { ...env, DEV_ADMIN_EMAIL: 'dclead@example.com' };
await test('a lead only sees their own community', async () => {
  const r = await call(leadEnv, 'GET', '/api/admin/events?status=pending');
  assert.equal(r.status, 200);
  assert.ok(r.data.events.length > 0);
  assert.ok(r.data.events.every((e) => e.community === 'dc'));
  const me = await call(leadEnv, 'GET', '/api/admin/me');
  assert.equal(me.data.isAdmin, false);
});

await test('a lead cannot approve another community or manage moderators', async () => {
  const philly = env.DB.raw.prepare(`SELECT id FROM events WHERE community_id='philly' AND status='pending' LIMIT 1`).get();
  let r = await call(leadEnv, 'POST', `/api/admin/events/${philly.id}/status`, { status: 'approved' });
  assert.equal(r.status, 403);
  r = await call(leadEnv, 'GET', '/api/admin/moderators');
  assert.equal(r.status, 403);
  r = await call(leadEnv, 'DELETE', `/api/admin/events/${philly.id}`);
  assert.equal(r.status, 403);
});

await test('someone not on the list is turned away', async () => {
  const r = await call({ ...env, DEV_ADMIN_EMAIL: 'stranger@example.com' }, 'GET', '/api/admin/events');
  assert.equal(r.status, 403);
});

console.log('Production safeguards');
const prod = devEnv({ ENVIRONMENT: 'production', DEV_ADMIN_EMAIL: 'chad@example.com', ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', ACCESS_AUD: 'aud123' });
prod.DB.raw.exec(`INSERT INTO moderators (email, role, community_id) VALUES ('chad@example.com','admin','')`);
await test('the dev sign-in shortcut is ignored in production', async () => {
  const r = await call(prod, 'GET', '/api/admin/me');
  assert.equal(r.status, 401);
});

await test('submissions require the bot check in production', async () => {
  const r = await call(prod, 'POST', '/api/submissions', base());
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'captcha');
});

await test('auto-publish puts clean submissions live but still holds lookalikes', async () => {
  const e2 = devEnv({ AUTO_PUBLISH: 'true' });
  const a = await call(e2, 'POST', '/api/submissions', base());
  assert.equal(a.data.status, 'approved');
  const b = await call(e2, 'POST', '/api/submissions', base({ title: 'Different name, same night' }), { ip: '203.0.113.30' });
  assert.equal(b.data.status, 'pending');
});

await test('verifies real Cloudflare Access tokens and rejects tampered ones', async () => {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://team.cloudflareaccess.com/cdn-cgi/access/certs');
    return new Response(JSON.stringify({ keys: [jwk] }));
  };
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const sign = async (payload) => {
    const head = b64({ alg: 'RS256', kid: 'k1' }) + '.' + b64(payload);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(head));
    return head + '.' + Buffer.from(sig).toString('base64url');
  };
  const now = Math.floor(Date.now() / 1000);
  const good = await sign({ aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', email: 'Chad@Example.com', exp: now + 600 });
  const req = (t) => new Request('https://api.test/api/admin/me', { headers: { 'Cf-Access-Jwt-Assertion': t } });
  try {
    assert.equal(await getAccessEmail(req(good), prod), 'chad@example.com');
    const wrongAud = await sign({ aud: ['other'], iss: 'https://team.cloudflareaccess.com', email: 'x@y.z', exp: now + 600 });
    assert.equal(await getAccessEmail(req(wrongAud), prod), null);
    const expired = await sign({ aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', email: 'x@y.z', exp: now - 10 });
    assert.equal(await getAccessEmail(req(expired), prod), null);
    const parts = good.split('.');
    const tampered = parts[0] + '.' + b64({ aud: ['aud123'], iss: 'https://team.cloudflareaccess.com', email: 'evil@x.com', exp: now + 600 }) + '.' + parts[2];
    assert.equal(await getAccessEmail(req(tampered), prod), null);
    // and end to end through the router
    const r = await worker.fetch(req(good), prod);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).isAdmin, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}.`);
