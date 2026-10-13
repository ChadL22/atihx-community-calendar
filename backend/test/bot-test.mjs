// End-to-end test for the Luma bot, with no Cloudflare account and no real Luma:
//   - the Worker accepts submissions through POST /api/luma-submissions,
//   - processQueue() drives a real local Chromium (Playwright),
//   - against test/mock-luma.html, a stand-in for Luma's calendar page.
//
//   node --experimental-sqlite --no-warnings test/bot-test.mjs
//
// Needs Playwright installed (any version). Real Luma can differ from the mock;
// this checks the bot's logic, not Luma's current page.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { processQueue } from '../src/luma-queue.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/usr/local/lib/node_modules', '/usr/lib/node_modules'] })));
}

const root = fileURLToPath(new URL('..', import.meta.url));
const MOCK_PORT = 8799;
const GOOD = 'good-session';

/* ---------------- stand-in Luma site ---------------- */
const received = [];
const mockHtml = readFileSync(new URL('./mock-luma.html', import.meta.url), 'utf8');
const mock = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/__submitted') {
    let body = '';
    for await (const c of req) body += c;
    received.push(JSON.parse(body));
    res.writeHead(204).end();
    return;
  }
  if (req.url.startsWith('/AllTechIsHuman')) {
    const signedIn = (req.headers.cookie || '').includes(`luma.auth-session-key=${GOOD}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(mockHtml.replace('__AUTH__', signedIn ? '<span>Create Event</span>' : '<button>Sign In</button>'));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

/* ---------------- D1 stand-in ---------------- */
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  _run: () => db.prepare(sql).run(...args),
});
const DB = {
  prepare: (sql) => stmt(sql),
  batch: async (list) => { db.exec('BEGIN'); try { list.forEach((s) => s._run()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } return []; },
};

/* ---------------- Puppeteer-style wrapper around Playwright ---------------- */
// The bot only uses a few Puppeteer calls; map them onto Playwright.
const spread = (fn) => new Function('args', `return (${fn.toString()})(...args)`);
async function launch() {
  const browser = await chromium.launch();
  return {
    async newPage() {
      const context = await browser.newContext({ timezoneId: 'America/New_York' });
      const page = await context.newPage();
      return {
        setCookie: (c) => context.addCookies([{ name: c.name, value: c.value, domain: 'localhost', path: '/', secure: false, httpOnly: true }]),
        emulateTimezone: async () => {},
        goto: (url, o) => page.goto(url, { waitUntil: o?.waitUntil || 'load', timeout: o?.timeout }),
        evaluate: (fn, ...args) => page.evaluate(spread(fn), args),
        waitForFunction: (fn, o, ...args) => page.waitForFunction(spread(fn), args, { timeout: o?.timeout, polling: o?.polling }),
        type: (sel, text, o) => page.type(sel, text, o),
        click: (sel) => page.click(sel),
        keyboard: { press: (k) => page.keyboard.press(k) },
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
  };
}

/* ---------------- helpers ---------------- */
const SITE = 'http://localhost:8000';
const env = {
  DB,
  ENVIRONMENT: 'development',
  ALLOWED_ORIGINS: SITE,
  IP_HASH_SALT: 't',
  LUMA_CALENDAR_URL: `http://localhost:${MOCK_PORT}/AllTechIsHuman`,
  LUMA_COOKIE_DOMAIN: 'localhost',
  LUMA_SESSION: GOOD,
};
let ipCounter = 1;
const submit = (body, e = env) =>
  worker.fetch(
    new Request('http://api.test/api/luma-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE, 'CF-Connecting-IP': `10.0.0.${ipCounter++}` },
      body: JSON.stringify(body),
    }),
    e,
    {}
  );
const rows = () => db.prepare('SELECT * FROM luma_queue ORDER BY created_at, rowid').all();
const future = (() => { const d = new Date(Date.now() + 20 * 864e5); return d.toISOString().slice(0, 10); })();
const person = { submitterName: 'Test Person', submitterEmail: 'test@example.com' };

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.stack || err.message}`); process.exitCode = 1; }
}

/* ---------------- tests ---------------- */
await test('the form endpoint validates and queues both kinds', async () => {
  let r = await submit({ kind: 'existing', url: 'https://example.com/x', ...person });
  assert.equal(r.status, 422);
  assert.ok((await r.json()).fields.url);

  r = await submit({ kind: 'existing', url: 'lu.ma/abcd1234?tk=xyz', ...person });
  assert.equal(r.status, 202, await r.clone().text());

  r = await submit({ kind: 'existing', url: 'https://luma.com/abcd1234', ...person });
  assert.equal(r.status, 409, 'same Luma event twice is caught');

  r = await submit({
    kind: 'external', url: 'https://www.eventbrite.com/e/ai-night-123', name: 'AI Policy Night', host: 'DC Tech Friends',
    location: '400 8th St NW', date: future, startTime: '18:30', endTime: '20:45', ...person,
  });
  assert.equal(r.status, 202, await r.clone().text());

  const q = rows();
  assert.equal(q.length, 2);
  assert.equal(q[0].event_url, 'https://luma.com/abcd1234');
  assert.deepEqual(q.map((x) => x.status), ['queued', 'queued']);
});

await test('the bot submits both events through the Luma forms', async () => {
  const result = await processQueue(env, launch);
  assert.equal(result.submitted, 2, JSON.stringify({ result, rows: rows().map((r) => [r.status, r.last_error]) }));
  assert.deepEqual(rows().map((r) => r.status), ['submitted', 'submitted']);

  const ex = received.find((x) => x.kind === 'existing');
  assert.deepEqual(ex.slugs, ['abcd1234']);

  const ext = received.find((x) => x.kind === 'external');
  assert.equal(ext.url, 'https://www.eventbrite.com/e/ai-night-123');
  assert.equal(ext.name, 'AI Policy Night', 'our name replaces what Luma parsed from the URL');
  assert.equal(ext.host, 'DC Tech Friends');
  assert.equal(ext.location, '400 8th St NW (Washington, DC, USA)', 'picks the first address suggestion');
  assert.equal(ext.startDate, future);
  assert.equal(ext.endDate, future);
  assert.equal(ext.startTime, '18:30');
  assert.equal(ext.endTime, '20:45');
});

await test('an empty queue does not start a browser', async () => {
  let launched = false;
  const r = await processQueue(env, async () => { launched = true; return launch(); });
  assert.equal(r.processed, 0);
  assert.equal(launched, false);
});

await test('a signed-out Luma account parks the queue as "needs sign-in"', async () => {
  await submit({ kind: 'existing', url: 'https://luma.com/zzzz9999', ...person });
  await submit({ kind: 'existing', url: 'https://luma.com/yyyy8888', ...person });
  const r = await processQueue({ ...env, LUMA_SESSION: 'expired' }, launch);
  assert.equal(r.needsLogin, true);
  const waiting = rows().filter((x) => x.status === 'needs_login');
  assert.equal(waiting.length, 2);
  assert.ok(waiting.every((x) => x.attempts === 0), 'sign-in problems do not use up attempts');
  const st = db.prepare("SELECT value FROM bot_status WHERE key = 'signed_in'").get();
  assert.equal(st.value, 'no');
});

await test('after the sign-in is refreshed, "retry waiting" sends them', async () => {
  db.prepare("UPDATE luma_queue SET status = 'queued' WHERE status = 'needs_login'").run();
  const r = await processQueue(env, launch);
  assert.equal(r.submitted, 2);
});

await test('an event Luma rejects is retried, then marked failed with the reason', async () => {
  await submit({ kind: 'existing', url: 'https://luma.com/Not-An-Event', ...person });
  for (let i = 0; i < 3; i++) await processQueue(env, launch);
  const bad = rows().find((x) => x.event_url.endsWith('Not-An-Event'));
  assert.equal(bad.status, 'failed');
  assert.equal(bad.attempts, 3);
  assert.match(bad.last_error, /Event not found/);
});

await test('missing LUMA_SESSION leaves events queued and says why', async () => {
  await submit({ kind: 'existing', url: 'https://luma.com/wwww7777', ...person });
  const r = await processQueue({ ...env, LUMA_SESSION: '' }, launch);
  assert.equal(r.skipped, 'no session');
  assert.equal(rows().find((x) => x.event_url.endsWith('wwww7777')).status, 'queued');
});

mock.close();
console.log(`\n${passed} bot tests passed.`);
