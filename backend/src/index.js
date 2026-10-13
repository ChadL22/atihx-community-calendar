// ATIHx Community Calendar API — a Cloudflare Worker backed by a D1 database.
//
// Public
//   GET  /api/health
//   GET  /api/config                 { autoPublish }
//   GET  /api/events                 { communities, events } (approved only)
//   GET  /calendars/<slug>.ics       subscribable feed: all, philly, dc, dc+philly…
//   POST /api/submissions            submit an event (Turnstile protected)
//   POST /api/luma-submissions       send an event to the ATIH calendar on Luma (see luma-queue.js)
//
// Moderators (behind Cloudflare Access)
//   GET    /api/admin/me
//   GET    /api/admin/events?status=pending|approved|rejected
//   POST   /api/admin/events/:id/status   { status, note }
//   PUT    /api/admin/events/:id          edit fields
//   DELETE /api/admin/events/:id          admins only
//   GET    /api/admin/moderators          admins only
//   POST   /api/admin/moderators          admins only { email, role, community }
//   DELETE /api/admin/moderators          admins only { email, community }
//   POST   /api/admin/communities         admins only { id, name, short, color, search }
//   GET    /api/admin/luma-queue          admins only: events sent to Luma, bot status
//   POST   /api/admin/luma-queue/...      admins only: retry, retry-waiting, run
//
// Scheduled (every 2 minutes, see wrangler.toml): the Luma bot submits queued events.
//
// Anything else falls through to the static files in ./public (the review page).

import { buildIcs } from './ics.js';
import { getAccessEmail } from './access.js';
import { validateEvent, dedupeKey } from './validate.js';
import { postLumaSubmission, processQueue, handleLumaAdmin } from './luma-queue.js';

// Loaded only when the bot runs, so tests and local dev don't need the package.
const launchBrowser = async (env) => (await import('./browser.js')).launchBrowser(env);

const SUBMISSIONS_PER_HOUR = 5;

/* ------------------------------------------------------------------ helpers */

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function todayIn(timezone = 'America/New_York') {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

const isTrue = (v) => String(v).toLowerCase() === 'true';

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

function corsHeaders(request, env, { publicRead = false } = {}) {
  const origin = request.headers.get('Origin');
  if (publicRead) return { 'Access-Control-Allow-Origin': '*' };
  if (origin && allowedOrigins(env).includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }
  return {};
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const newId = () => crypto.randomUUID();

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- data access */

async function loadCommunities(env, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM communities ORDER BY name'
    : 'SELECT * FROM communities WHERE active = 1 ORDER BY name';
  const { results } = await env.DB.prepare(sql).all();
  return results;
}

const publicCommunity = (c) => ({
  id: c.id,
  name: c.name,
  short: c.short,
  color: c.color,
  timezone: c.timezone,
  search: c.search,
});

function publicEvent(row, communitiesById) {
  return {
    id: row.id,
    community: row.community_id,
    title: row.title,
    start: row.start_local,
    end: row.end_local,
    timezone: communitiesById[row.community_id]?.timezone || 'America/New_York',
    venue: row.venue,
    address: row.address,
    host: row.host,
    url: row.url,
    description: row.description,
  };
}

function adminEvent(row) {
  return {
    id: row.id,
    community: row.community_id,
    title: row.title,
    date: row.event_date,
    startTime: row.start_local.slice(11, 16),
    endTime: row.end_local.slice(11, 16),
    venue: row.venue,
    address: row.address,
    host: row.host,
    url: row.url,
    description: row.description,
    status: row.status,
    submitterName: row.submitter_name,
    submitterEmail: row.submitter_email,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    possibleDuplicate: row.dup_id
      ? { id: row.dup_id, title: row.dup_title, status: row.dup_status, startTime: (row.dup_start || '').slice(11, 16) }
      : null,
  };
}

/** Finds an event on the same day in the same community that looks similar. */
async function findSimilar(env, { community, date, url, excludeId = '' }) {
  return env.DB.prepare(
    `SELECT id FROM events
      WHERE community_id = ?1 AND event_date = ?2 AND status != 'rejected' AND id != ?3
      ORDER BY CASE WHEN ?4 != '' AND url = ?4 THEN 0 ELSE 1 END, created_at
      LIMIT 1`
  )
    .bind(community, date, excludeId, url || '')
    .first();
}

/* ------------------------------------------------------------ public routes */

async function getEvents(env) {
  const communities = await loadCommunities(env);
  const byId = Object.fromEntries(communities.map((c) => [c.id, c]));
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE status = 'approved' ORDER BY start_local`
  ).all();
  return {
    communities: communities.map(publicCommunity),
    events: results.filter((r) => byId[r.community_id]).map((r) => publicEvent(r, byId)),
  };
}

async function getFeed(env, slug) {
  const { communities, events } = await getEvents(env);
  const byId = Object.fromEntries(communities.map((c) => [c.id, c]));
  let name = 'ATIHx Community Calendar';
  let list = events;
  if (slug !== 'all') {
    const ids = [...new Set(slug.split('+'))];
    if (!ids.length || ids.some((id) => !byId[id])) return null;
    name = 'ATIHx ' + ids.map((id) => byId[id].short).join(' + ');
    list = events.filter((e) => ids.includes(e.community));
  }
  return buildIcs(name, list, byId);
}

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET) {
    // Only allowed while developing locally.
    return env.ENVIRONMENT === 'development';
  }
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile check failed:', err.message);
    return false;
  }
}

async function postSubmission(request, env) {
  const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins(env).includes(origin)) {
    return json({ error: 'forbidden', message: 'Submissions aren’t accepted from this site.' }, 403);
  }

  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request', message: 'Send the form as JSON.' }, 400);

  // Honeypot: a field real people never see or fill in.
  if (body.website) return json({ ok: true, status: 'pending' }, 202);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(body.turnstileToken, ip, env))) {
    return json({ error: 'captcha', message: 'Please complete the “I’m human” check and try again.' }, 400);
  }

  // Rate limit by salted IP hash.
  const ipHash = await sha256Hex(`${env.IP_HASH_SALT || 'dev-salt'}|${ip}`);
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM submission_log WHERE ip_hash = ?1 AND created_at > ?2'
  )
    .bind(ipHash, hourAgo)
    .first();
  if (recent && recent.n >= SUBMISSIONS_PER_HOUR) {
    return json({ error: 'rate_limited', message: 'That’s a lot of submissions in a short time. Please try again in an hour.' }, 429);
  }

  const communities = await loadCommunities(env);
  const community = communities.find((c) => c.id === body.community);
  const { value, errors } = validateEvent(body, communities.map((c) => c.id), {
    today: todayIn(community?.timezone),
    submission: true,
  });
  if (Object.keys(errors).length) {
    return json({ error: 'invalid', message: 'Please fix the highlighted fields.', fields: errors }, 422);
  }

  const key = dedupeKey(value.community, value.date, value.title);
  const existing = await env.DB.prepare(
    `SELECT title, status FROM events WHERE dedupe_key = ?1 AND status != 'rejected'`
  )
    .bind(key)
    .first();
  if (existing) {
    const message =
      existing.status === 'approved'
        ? 'This event is already on the calendar. Thanks for checking!'
        : 'Someone has already submitted this event and it’s waiting for review.';
    return json({ error: 'duplicate', message, existingStatus: existing.status }, 409);
  }

  const similar = await findSimilar(env, { community: value.community, date: value.date, url: value.url });
  const autoPublish = isTrue(env.AUTO_PUBLISH) && !similar; // anything that looks like a duplicate still gets a human look
  const status = autoPublish ? 'approved' : 'pending';
  const id = newId();
  const stampNow = nowIso();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (id, community_id, title, start_local, end_local, event_date, venue, address, url,
                             description, status, dedupe_key, possible_duplicate_of, submitter_name, submitter_email,
                             reviewed_by, reviewed_at, created_at, updated_at, host)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18, ?19)`
      ).bind(
        id,
        value.community,
        value.title,
        `${value.date}T${value.startTime}`,
        `${value.date}T${value.endTime}`,
        value.date,
        value.venue,
        value.address,
        value.url,
        value.description,
        status,
        key,
        similar ? similar.id : null,
        value.submitterName,
        value.submitterEmail,
        autoPublish ? 'auto-publish' : '',
        autoPublish ? stampNow : null,
        stampNow,
        value.host
      ),
      env.DB.prepare('INSERT INTO submission_log (ip_hash) VALUES (?1)').bind(ipHash),
      env.DB.prepare('DELETE FROM submission_log WHERE created_at < ?1').bind(
        new Date(Date.now() - 86400 * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
      ),
    ]);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      return json({ error: 'duplicate', message: 'Someone has already submitted this event.' }, 409);
    }
    throw err;
  }

  return json(
    {
      ok: true,
      id,
      status,
      message: autoPublish
        ? 'Thanks! Your event is on the calendar.'
        : 'Thanks! A community lead will review your event shortly.',
    },
    201
  );
}

/* --------------------------------------------------------- moderator routes */

async function getModerator(request, env) {
  const email = await getAccessEmail(request, env);
  if (!email) return null;
  const { results } = await env.DB.prepare('SELECT role, community_id FROM moderators WHERE email = ?1')
    .bind(email)
    .all();
  if (!results.length) return { email, isAdmin: false, communities: [], allowed: false };
  const isAdmin = results.some((r) => r.role === 'admin');
  let communities;
  if (isAdmin) {
    communities = (await loadCommunities(env, { includeInactive: true })).map((c) => c.id);
  } else {
    communities = results.filter((r) => r.role === 'lead').map((r) => r.community_id);
  }
  return { email, isAdmin, communities, allowed: true };
}

const canReview = (mod, communityId) => mod.isAdmin || mod.communities.includes(communityId);

async function loadEventRow(env, id) {
  return env.DB.prepare('SELECT * FROM events WHERE id = ?1').bind(id).first();
}

async function adminListEvents(env, mod, url) {
  const status = url.searchParams.get('status') || 'pending';
  if (!['pending', 'approved', 'rejected'].includes(status)) return json({ error: 'bad_request' }, 400);
  if (!mod.communities.length) return json({ events: [] });

  const placeholders = mod.communities.map((_, i) => `?${i + 2}`).join(', ');
  const order = status === 'pending' ? 'e.event_date ASC, e.start_local ASC' : 'e.event_date DESC, e.start_local DESC';
  const { results } = await env.DB.prepare(
    `SELECT e.*, d.id AS dup_id, d.title AS dup_title, d.status AS dup_status, d.start_local AS dup_start
       FROM events e
       LEFT JOIN events d ON d.id = e.possible_duplicate_of
      WHERE e.status = ?1 AND e.community_id IN (${placeholders})
      ORDER BY ${order}
      LIMIT 500`
  )
    .bind(status, ...mod.communities)
    .all();

  const counts = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM events WHERE community_id IN (${mod.communities.map((_, i) => `?${i + 1}`).join(', ')}) GROUP BY status`
  )
    .bind(...mod.communities)
    .all();

  return json({
    events: results.map(adminEvent),
    counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
  });
}

async function adminSetStatus(request, env, mod, id) {
  const row = await loadEventRow(env, id);
  if (!row) return json({ error: 'not_found' }, 404);
  if (!canReview(mod, row.community_id)) return json({ error: 'forbidden' }, 403);
  const body = (await readJson(request)) || {};
  if (!['pending', 'approved', 'rejected'].includes(body.status)) return json({ error: 'bad_request' }, 400);
  try {
    await env.DB.prepare(
      `UPDATE events SET status = ?1, review_note = ?2, reviewed_by = ?3, reviewed_at = ?4, updated_at = ?4 WHERE id = ?5`
    )
      .bind(body.status, String(body.note || '').slice(0, 500), mod.email, nowIso(), id)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      return json({ error: 'duplicate', message: 'Another event with the same title is already on that day. Reject one of them instead.' }, 409);
    }
    throw err;
  }
  return json({ ok: true });
}

async function adminEditEvent(request, env, mod, id) {
  const row = await loadEventRow(env, id);
  if (!row) return json({ error: 'not_found' }, 404);
  if (!canReview(mod, row.community_id)) return json({ error: 'forbidden' }, 403);
  const body = await readJson(request);
  if (!body) return json({ error: 'bad_request' }, 400);
  if (!canReview(mod, body.community)) return json({ error: 'forbidden', message: 'You can only move events into communities you review.' }, 403);

  const communities = await loadCommunities(env, { includeInactive: true });
  const { value, errors } = validateEvent(body, communities.map((c) => c.id));
  if (Object.keys(errors).length) return json({ error: 'invalid', message: 'Please fix the highlighted fields.', fields: errors }, 422);

  const key = dedupeKey(value.community, value.date, value.title);
  const similar = await findSimilar(env, { community: value.community, date: value.date, url: value.url, excludeId: id });
  try {
    await env.DB.prepare(
      `UPDATE events SET community_id = ?1, title = ?2, start_local = ?3, end_local = ?4, event_date = ?5,
              venue = ?6, address = ?7, url = ?8, description = ?9, dedupe_key = ?10,
              possible_duplicate_of = ?11, updated_at = ?12, host = ?14
        WHERE id = ?13`
    )
      .bind(
        value.community,
        value.title,
        `${value.date}T${value.startTime}`,
        `${value.date}T${value.endTime}`,
        value.date,
        value.venue,
        value.address,
        value.url,
        value.description,
        key,
        similar ? similar.id : null,
        nowIso(),
        id,
        value.host
      )
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) {
      return json({ error: 'duplicate', message: 'Another event with that title is already on that day.' }, 409);
    }
    throw err;
  }
  return json({ ok: true });
}

async function adminDeleteEvent(env, mod, id) {
  if (!mod.isAdmin) return json({ error: 'forbidden', message: 'Only admins can delete events. Reject it instead.' }, 403);
  await env.DB.prepare('UPDATE events SET possible_duplicate_of = NULL WHERE possible_duplicate_of = ?1').bind(id).run();
  const res = await env.DB.prepare('DELETE FROM events WHERE id = ?1').bind(id).run();
  return res.meta.changes ? json({ ok: true }) : json({ error: 'not_found' }, 404);
}

async function adminModerators(request, env, mod) {
  if (!mod.isAdmin) return json({ error: 'forbidden' }, 403);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT email, role, community_id AS community, added_by AS addedBy, created_at AS createdAt FROM moderators ORDER BY role, community_id, email'
    ).all();
    return json({ moderators: results });
  }

  const body = (await readJson(request)) || {};
  const email = String(body.email || '').trim().toLowerCase();
  const community = body.role === 'admin' ? '' : String(body.community || '');

  if (request.method === 'POST') {
    if (!EMAIL_RE.test(email)) return json({ error: 'invalid', message: 'Enter a valid email.' }, 422);
    if (!['admin', 'lead'].includes(body.role)) return json({ error: 'invalid', message: 'Choose a role.' }, 422);
    if (body.role === 'lead') {
      const exists = await env.DB.prepare('SELECT id FROM communities WHERE id = ?1').bind(community).first();
      if (!exists) return json({ error: 'invalid', message: 'Choose a community.' }, 422);
    }
    await env.DB.prepare(
      'INSERT OR IGNORE INTO moderators (email, role, community_id, added_by) VALUES (?1, ?2, ?3, ?4)'
    )
      .bind(email, body.role, community, mod.email)
      .run();
    return json({ ok: true }, 201);
  }

  if (request.method === 'DELETE') {
    if (email === mod.email && community === '') {
      return json({ error: 'forbidden', message: 'You can’t remove your own admin access.' }, 403);
    }
    await env.DB.prepare('DELETE FROM moderators WHERE email = ?1 AND community_id = ?2').bind(email, String(body.community || '')).run();
    return json({ ok: true });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

async function adminAddCommunity(request, env, mod) {
  if (!mod.isAdmin) return json({ error: 'forbidden' }, 403);
  const b = (await readJson(request)) || {};
  const id = String(b.id || '').trim().toLowerCase();
  const fields = {};
  if (!/^[a-z0-9-]{2,30}$/.test(id)) fields.id = 'Use 2–30 lowercase letters, numbers or dashes.';
  if (!String(b.name || '').trim()) fields.name = 'Add a name.';
  if (!String(b.short || '').trim()) fields.short = 'Add a short name.';
  if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color || ''))) fields.color = 'Use a hex color like #8a6cff.';
  if (Object.keys(fields).length) return json({ error: 'invalid', fields }, 422);
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO communities (id, name, short, color, timezone, search) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  )
    .bind(id, b.name.trim().slice(0, 80), b.short.trim().slice(0, 30), b.color, b.timezone || 'America/New_York', String(b.search || '').slice(0, 200))
    .run();
  return res.meta.changes ? json({ ok: true }, 201) : json({ error: 'duplicate', message: 'That community id already exists.' }, 409);
}

async function handleAdmin(request, env, url, ctx) {
  const mod = await getModerator(request, env);
  if (!mod) return json({ error: 'unauthorized', message: 'Sign in through Cloudflare Access.' }, 401);
  const path = url.pathname.replace(/^\/api\/admin/, '');

  if (path === '/me') {
    const communities = await loadCommunities(env, { includeInactive: true });
    return json({
      email: mod.email,
      allowed: mod.allowed,
      isAdmin: mod.isAdmin,
      communities: communities.filter((c) => mod.communities.includes(c.id)).map(publicCommunity),
      allCommunities: mod.isAdmin ? communities.map(publicCommunity) : undefined,
      autoPublish: isTrue(env.AUTO_PUBLISH),
    });
  }
  if (!mod.allowed) return json({ error: 'forbidden', message: 'Your email isn’t on the moderator list yet. Ask an admin to add you.' }, 403);

  if (path === '/events' && request.method === 'GET') return adminListEvents(env, mod, url);

  let m = path.match(/^\/events\/([\w-]+)\/status$/);
  if (m && request.method === 'POST') return adminSetStatus(request, env, mod, m[1]);

  m = path.match(/^\/events\/([\w-]+)$/);
  if (m && request.method === 'PUT') return adminEditEvent(request, env, mod, m[1]);
  if (m && request.method === 'DELETE') return adminDeleteEvent(env, mod, m[1]);

  if (path === '/moderators') return adminModerators(request, env, mod);
  if (path === '/communities' && request.method === 'POST') return adminAddCommunity(request, env, mod);
  if (path.startsWith('/luma-queue')) return handleLumaAdmin(request, env, ctx, path, mod, helpers, env.LAUNCH_BROWSER || launchBrowser);

  return json({ error: 'not_found' }, 404);
}

/* ------------------------------------------------------------------- router */

const helpers = { json, allowedOrigins, readJson, verifyTurnstile, sha256Hex, todayIn };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }

      if (pathname === '/api/health') return json({ ok: true }, 200, corsHeaders(request, env, { publicRead: true }));

      if (pathname === '/api/config' && request.method === 'GET') {
        return json({ autoPublish: isTrue(env.AUTO_PUBLISH) }, 200, corsHeaders(request, env, { publicRead: true }));
      }

      if (pathname === '/api/events' && request.method === 'GET') {
        return json(await getEvents(env), 200, {
          ...corsHeaders(request, env, { publicRead: true }),
          'Cache-Control': 'public, max-age=30',
        });
      }

      const feed = pathname.match(/^\/calendars\/([a-z0-9+-]+)\.ics$/);
      if (feed && request.method === 'GET') {
        const ics = await getFeed(env, decodeURIComponent(feed[1]));
        if (!ics) return new Response('Calendar not found', { status: 404 });
        return new Response(ics, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `inline; filename="${feed[1]}.ics"`,
            'Cache-Control': 'public, max-age=900',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      if (pathname === '/api/submissions' && request.method === 'POST') {
        const res = await postSubmission(request, env);
        const headers = new Headers(res.headers);
        Object.entries(corsHeaders(request, env)).forEach(([k, v]) => headers.set(k, v));
        return new Response(res.body, { status: res.status, headers });
      }

      if (pathname === '/api/luma-submissions' && request.method === 'POST') {
        const res = await postLumaSubmission(request, env, helpers);
        const headers = new Headers(res.headers);
        Object.entries(corsHeaders(request, env)).forEach(([k, v]) => headers.set(k, v));
        return new Response(res.body, { status: res.status, headers });
      }

      if (pathname.startsWith('/api/admin/')) {
        const res = await handleAdmin(request, env, url, ctx);
        res.headers.set('Cache-Control', 'no-store');
        return res;
      }

      if (pathname.startsWith('/api/')) return json({ error: 'not_found' }, 404);

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
    }
  },

  // Cron trigger: let the Luma bot work through the queue.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      processQueue(env, env.LAUNCH_BROWSER || launchBrowser).then((r) => {
        if (r.processed) console.log('Luma bot:', JSON.stringify(r));
      })
    );
  },
};
