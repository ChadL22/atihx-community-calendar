// The queue between the "Add An Event" page and the Luma bot.
//
//   POST /api/luma-submissions        visitors send an event (Turnstile protected)
//   scheduled (every 2 minutes)       the bot submits queued events to Luma
//   GET  /api/admin/luma-queue        admins see what was sent and any problems
//   POST /api/admin/luma-queue/:id/retry
//   POST /api/admin/luma-queue/retry-waiting   after refreshing the Luma sign-in
//   POST /api/admin/luma-queue/run             run the bot now

import { validateLumaSubmission } from './luma-validate.js';
import { submitItem, NeedsLogin } from './luma-bot.js';

const PER_HOUR = 5;          // submissions per visitor per hour
const PER_RUN = 4;           // events the bot handles per run (Free plan: 10 browser-minutes a day)
const MAX_ATTEMPTS = 3;
const STUCK_MINUTES = 15;

const stamp = (d = new Date()) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const minutesAgo = (n) => stamp(new Date(Date.now() - n * 60000));

export function botOptions(env) {
  const calendarUrl = env.LUMA_CALENDAR_URL || 'https://luma.com/AllTechIsHuman';
  return {
    calendarUrl,
    cookieName: env.LUMA_COOKIE_NAME || 'luma.auth-session-key',
    cookieDomain: env.LUMA_COOKIE_DOMAIN || `.${new URL(calendarUrl).hostname.replace(/^www\./, '')}`,
    session: env.LUMA_SESSION || '',
  };
}

async function setStatus(env, values) {
  const stmts = Object.entries(values).map(([k, v]) =>
    env.DB.prepare(
      `INSERT INTO bot_status (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(k, String(v ?? ''), stamp())
  );
  if (stmts.length) await env.DB.batch(stmts);
}

/* ------------------------------------------------------------ public route */

export async function postLumaSubmission(request, env, h) {
  const origin = request.headers.get('Origin');
  if (origin && !h.allowedOrigins(env).includes(origin)) {
    return h.json({ error: 'forbidden', message: 'Submissions aren’t accepted from this site.' }, 403);
  }
  const body = await h.readJson(request);
  if (!body) return h.json({ error: 'bad_request', message: 'Send the form as JSON.' }, 400);
  if (body.website) return h.json({ ok: true, status: 'queued' }, 202); // honeypot

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await h.verifyTurnstile(body.turnstileToken, ip, env))) {
    return h.json({ error: 'captcha', message: 'Please complete the “I’m human” check and try again.' }, 400);
  }

  const ipHash = await h.sha256Hex(`${env.IP_HASH_SALT || 'dev-salt'}|${ip}`);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM submission_log WHERE ip_hash = ?1 AND created_at > ?2')
    .bind(ipHash, minutesAgo(60))
    .first();
  if (recent && recent.n >= PER_HOUR) {
    return h.json({ error: 'rate_limited', message: 'That’s a lot of submissions in a short time. Please try again in an hour.' }, 429);
  }

  const { value, errors } = validateLumaSubmission(body, { today: h.todayIn('America/New_York') });
  if (Object.keys(errors).length) {
    return h.json({ error: 'invalid', message: 'Please fix the highlighted fields.', fields: errors }, 422);
  }

  const already = await env.DB.prepare(
    `SELECT status FROM luma_queue WHERE event_url = ?1 AND status != 'failed' AND created_at > ?2 LIMIT 1`
  )
    .bind(value.eventUrl, minutesAgo(60 * 24 * 60))
    .first();
  if (already) {
    return h.json(
      {
        error: 'duplicate',
        message:
          already.status === 'submitted'
            ? 'This event has already been sent to Luma and is waiting for the calendar admins.'
            : 'This event is already on its way to Luma.',
      },
      409
    );
  }

  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO luma_queue (id, kind, event_url, payload, submitter_name, submitter_email) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(id, value.kind, value.eventUrl, JSON.stringify(value.payload), value.submitterName, value.submitterEmail),
    env.DB.prepare('INSERT INTO submission_log (ip_hash) VALUES (?1)').bind(ipHash),
  ]);

  return h.json(
    {
      ok: true,
      id,
      message:
        'Thanks! We’re sending your event to All Tech Is Human’s calendar on Luma now. Once Luma’s admins accept it, it will appear here automatically.',
    },
    202
  );
}

/* --------------------------------------------------------------- the bot */

// launch(env) must return a Puppeteer-style browser ({ newPage, close }).
export async function processQueue(env, launch, { limit = PER_RUN } = {}) {
  await env.DB.prepare(`UPDATE luma_queue SET status = 'queued', updated_at = ?1 WHERE status = 'working' AND updated_at < ?2`)
    .bind(stamp(), minutesAgo(STUCK_MINUTES))
    .run();

  const { results: items } = await env.DB.prepare(
    `SELECT * FROM luma_queue WHERE status = 'queued' ORDER BY created_at LIMIT ?1`
  )
    .bind(limit)
    .all();
  if (!items.length) return { processed: 0 };

  const opts = botOptions(env);
  if (!opts.session) {
    await setStatus(env, { last_run: stamp(), last_problem: 'LUMA_SESSION is not set, so the bot can’t sign in to Luma yet.' });
    return { processed: 0, skipped: 'no session' };
  }

  let browser;
  try {
    browser = await launch(env);
  } catch (err) {
    await setStatus(env, { last_run: stamp(), last_problem: `Couldn’t start the browser: ${err.message}` });
    return { processed: 0, error: err.message };
  }

  const summary = { processed: 0, submitted: 0, failed: 0, needsLogin: false };
  try {
    for (const item of items) {
      await env.DB.prepare(`UPDATE luma_queue SET status = 'working', attempts = attempts + 1, updated_at = ?1 WHERE id = ?2`)
        .bind(stamp(), item.id)
        .run();
      summary.processed++;
      const page = await browser.newPage();
      try {
        await submitItem(page, item, opts);
        await env.DB.prepare(`UPDATE luma_queue SET status = 'submitted', last_error = '', submitted_at = ?1, updated_at = ?1 WHERE id = ?2`)
          .bind(stamp(), item.id)
          .run();
        summary.submitted++;
        await setStatus(env, { last_success: stamp(), signed_in: 'yes' });
      } catch (err) {
        if (err instanceof NeedsLogin) {
          // Park everything until an admin refreshes the sign-in; doesn't count as an attempt.
          await env.DB.prepare(
            `UPDATE luma_queue SET status = 'needs_login', attempts = MAX(attempts - 1, 0), last_error = ?1, updated_at = ?2
             WHERE id = ?3 OR status = 'queued'`
          )
            .bind(err.message, stamp(), item.id)
            .run();
          summary.needsLogin = true;
          await setStatus(env, { signed_in: 'no', last_problem: err.message });
          break;
        }
        const attempts = (item.attempts || 0) + 1;
        const next = attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
        await env.DB.prepare(`UPDATE luma_queue SET status = ?1, last_error = ?2, updated_at = ?3 WHERE id = ?4`)
          .bind(next, String(err.message || err).slice(0, 500), stamp(), item.id)
          .run();
        if (next === 'failed') summary.failed++;
        await setStatus(env, { last_problem: String(err.message || err).slice(0, 300) });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await setStatus(env, { last_run: stamp() });
  }
  return summary;
}

/* ---------------------------------------------------------- admin routes */

export async function handleLumaAdmin(request, env, ctx, path, mod, h, launch) {
  if (!mod.isAdmin) return h.json({ error: 'forbidden', message: 'Only admins can see the Luma queue.' }, 403);

  if (path === '/luma-queue' && request.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT id, kind, event_url, payload, submitter_name, submitter_email, status, attempts, last_error, created_at, submitted_at
       FROM luma_queue ORDER BY created_at DESC LIMIT 60`
    ).all();
    const { results: st } = await env.DB.prepare('SELECT key, value, updated_at FROM bot_status').all();
    const status = Object.fromEntries(st.map((r) => [r.key, r.value]));
    return h.json({
      configured: !!env.LUMA_SESSION && !!env.BROWSER,
      hasSession: !!env.LUMA_SESSION,
      hasBrowser: !!env.BROWSER,
      calendarUrl: botOptions(env).calendarUrl,
      status,
      items: results.map((r) => ({ ...r, payload: JSON.parse(r.payload || '{}') })),
    });
  }

  if (path === '/luma-queue/retry-waiting' && request.method === 'POST') {
    const res = await env.DB.prepare(
      `UPDATE luma_queue SET status = 'queued', attempts = 0, updated_at = ?1 WHERE status IN ('needs_login', 'failed')`
    )
      .bind(stamp())
      .run();
    return h.json({ ok: true, requeued: res.meta.changes });
  }

  if (path === '/luma-queue/run' && request.method === 'POST') {
    const job = processQueue(env, launch);
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    else await job;
    return h.json({ ok: true, message: 'The Luma bot is running. Refresh in a minute to see the results.' }, 202);
  }

  const m = path.match(/^\/luma-queue\/([\w-]+)\/retry$/);
  if (m && request.method === 'POST') {
    const res = await env.DB.prepare(`UPDATE luma_queue SET status = 'queued', attempts = 0, updated_at = ?1 WHERE id = ?2`)
      .bind(stamp(), m[1])
      .run();
    return res.meta.changes ? h.json({ ok: true }) : h.json({ error: 'not_found' }, 404);
  }

  return h.json({ error: 'not_found' }, 404);
}
