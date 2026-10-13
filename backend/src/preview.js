// Link preview for the "Add An Event" page.
//
//   GET /api/preview?url=<link>
//
// - A Luma link: looks the event up through Luma's public event lookup (the
//   same data luma.com uses to show an event page) and returns its title, time,
//   place and hosts, like Luma's own "Add" step.
// - Any other link: fetches the page and reads the event details most event
//   sites publish for search engines (schema.org "Event" data: Eventbrite,
//   Meetup, university and organization calendars), like Luma's "Parsing URL…".
//
// Each preview also says whether the place looks like it's in one of our
// communities. That's only a hint for the visitor: the hourly Luma sync makes
// the final call when the event comes back from Luma.

import { canonicalLumaUrl } from './luma-validate.js';

const TZ = 'America/New_York';
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;

/* ------------------------------------------------------------ communities */
// Keep in step with the "luma" rules in data/events.json (used by the sync).
const COMMUNITIES = [
  {
    id: 'dc',
    name: 'the DMV',
    center: [38.9072, -77.0369],
    km: 50,
    zip3: ['200', '201', '202', '203', '204', '205', '206', '207', '208', '209', '220', '221', '222', '223'],
    places: {
      dc: ['washington'],
      md: ['bethesda', 'silver spring', 'rockville', 'gaithersburg', 'college park', 'hyattsville', 'takoma park', 'chevy chase', 'greenbelt', 'bowie', 'laurel', 'germantown', 'potomac', 'kensington', 'wheaton', 'oxon hill', 'national harbor', 'upper marlboro', 'largo', 'lanham', 'riverdale park', 'mount rainier', 'bladensburg', 'landover', 'capitol heights', 'suitland', 'columbia'],
      va: ['arlington', 'alexandria', 'fairfax', 'falls church', 'mclean', 'tysons', 'vienna', 'reston', 'herndon', 'chantilly', 'centreville', 'manassas', 'springfield', 'annandale', 'burke', 'leesburg', 'ashburn', 'sterling', 'dulles', 'merrifield', 'oakton', 'great falls', 'lorton', 'woodbridge', 'mount vernon', 'crystal city', 'rosslyn', 'ballston', 'clarendon', 'pentagon city'],
    },
  },
  {
    id: 'philly',
    name: 'the Philadelphia area',
    center: [39.9526, -75.1652],
    km: 40,
    zip3: ['190', '191', '193', '194'],
    places: { pa: ['philadelphia', 'king of prussia', 'conshohocken', 'bala cynwyd', 'ardmore', 'bryn mawr', 'media', 'norristown', 'wayne', 'radnor'] },
  },
];
const STATE_NAMES = { dc: ['dc', 'district of columbia', 'd.c.'], md: ['md', 'maryland'], va: ['va', 'virginia'], pa: ['pa', 'pennsylvania'] };

function kmBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

// { community, label, sure } — community is null when it's elsewhere or unknown.
export function whereIs({ online = false, point = null, city = '', region = '', text = '' }) {
  if (online) return { community: null, status: 'online', label: 'Online events don’t appear on this calendar.' };
  const lowText = ` ${String(text).toLowerCase()} `;
  const zips = [...lowText.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map((m) => m[1]);
  for (const c of COMMUNITIES) {
    if (point && kmBetween(point, c.center) <= c.km) return ok(c);
  }
  if (point) return elsewhere();
  for (const c of COMMUNITIES) {
    if (zips.some((z) => c.zip3.includes(z.slice(0, 3)))) return ok(c);
  }
  const lowCity = String(city).toLowerCase().trim();
  const lowRegion = String(region).toLowerCase().trim();
  for (const c of COMMUNITIES) {
    for (const [state, cities] of Object.entries(c.places)) {
      const stateOk = (s) => STATE_NAMES[state].some((n) => s === n || s.includes(`, ${n}`) || s.endsWith(` ${n}`));
      if (lowCity && cities.includes(lowCity) && (stateOk(lowRegion) || stateOk(lowText.trim()))) return ok(c);
      if (!lowCity && cities.some((n) => new RegExp(`\\b${n}\\b,?\\s*(${STATE_NAMES[state].map((x) => x.replace('.', '\\.')).join('|')})\\b`).test(lowText))) return ok(c);
    }
  }
  if (zips.length || lowCity) return elsewhere();
  return { community: null, status: 'unknown', label: 'We couldn’t tell where this is. Only in-person DMV and Philadelphia-area events appear on this calendar.' };

  function ok(c) {
    return { community: c.id, status: 'ok', label: `In ${c.name}, so it will appear on this calendar once Luma accepts it.` };
  }
  function elsewhere() {
    return { community: null, status: 'elsewhere', label: 'This looks like it’s outside the DMV and Philadelphia area, so it won’t appear on this calendar.' };
  }
}

/* ---------------------------------------------------------------- helpers */
const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// "2026-11-10T18:00:00-05:00" -> { date: '2026-11-10', time: '18:00' } in Eastern Time.
// Strings without an offset are taken as Eastern wall-clock time already.
export function localParts(value, tz = TZ) {
  const s = String(value ?? '').trim();
  if (!s) return { date: '', time: '' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s, time: '' };
  const naive = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (naive) return { date: naive[1], time: `${naive[2]}:${naive[3]}` };
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return { date: '', time: '' };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null; // no raw IP addresses
  if (u.username || u.password) return null;
  return u;
}

async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ATIHxCommunityCalendar/1.0; +event preview)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const type = res.headers.get('Content-Type') || '';
    if (type && !/html|xml/i.test(type)) return { ok: false, status: 415 };
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return { ok: true, text: (await res.text()).slice(0, MAX_BYTES) };
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size >= MAX_BYTES) { reader.cancel().catch(() => {}); break; }
    }
    const all = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { all.set(c.subarray(0, Math.min(c.byteLength, size - off)), off); off += c.byteLength; if (off >= size) break; }
    return { ok: true, text: new TextDecoder().decode(all) };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------- non-Luma event pages */
function* walkJsonLd(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walkJsonLd(n); return; }
  if (!node || typeof node !== 'object') return;
  yield node;
  if (node['@graph']) yield* walkJsonLd(node['@graph']);
  if (node.mainEntity) yield* walkJsonLd(node.mainEntity);
  if (Array.isArray(node.subEvent)) yield* walkJsonLd(node.subEvent);
}
const isEventType = (t) => [].concat(t || []).some((x) => /Event$/i.test(String(x)) && !/^(Offer|Action)/i.test(String(x)));

function addressText(addr) {
  if (!addr) return { text: '', city: '', region: '' };
  if (typeof addr === 'string') return { text: clean(addr), city: '', region: '' };
  const a = Array.isArray(addr) ? addr[0] : addr;
  const street = clean(a.streetAddress);
  const low = street.toLowerCase();
  // Some sites (Eventbrite) already put the city and ZIP inside streetAddress.
  const locality = a.addressLocality && !low.includes(String(a.addressLocality).toLowerCase()) ? a.addressLocality : '';
  const tail = [a.addressRegion, a.postalCode].filter((x) => x && !low.includes(String(x).toLowerCase())).join(' ');
  const parts = [street, locality, tail].map((x) => clean(x)).filter(Boolean);
  return { text: parts.join(', '), city: clean(a.addressLocality), region: clean(a.addressRegion) };
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  return decodeEntities((tag.match(/content=["']([^"']*)["']/i) || [])[1] || '');
}

// Pulls event details out of a page's HTML. Exported for tests.
export function parseEventPage(html) {
  const out = { name: '', date: '', startTime: '', endDate: '', endTime: '', venue: '', location: '', host: '', online: false, city: '', region: '', point: null, found: false };
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let data;
    const body = raw.replace(/\/\*\s*<!\[CDATA\[\s*\*\/|\/\*\s*\]\]>\s*\*\/|<!\[CDATA\[|\]\]>/g, '').trim(); // some CMSs wrap it in CDATA comments
    try { data = JSON.parse(body); } catch { try { data = JSON.parse(decodeEntities(body)); } catch { continue; } }
    for (const node of walkJsonLd(data)) {
      if (!isEventType(node['@type']) || !node.startDate) continue;
      const start = localParts(node.startDate);
      const end = localParts(node.endDate || '');
      const loc = [].concat(node.location || [])[0] || {};
      const isVirtual = /VirtualLocation/i.test(String(loc['@type'] || '')) || /OnlineEventAttendanceMode/i.test(String(node.eventAttendanceMode || ''));
      const addr = addressText(loc.address);
      const org = [].concat(node.organizer || [])[0];
      const geo = loc.geo || {};
      Object.assign(out, {
        found: true,
        name: clean(decodeEntities(node.name), 140),
        date: start.date,
        startTime: start.time,
        endDate: end.date || start.date,
        endTime: end.time && !(end.date === start.date && end.time === start.time) ? end.time : '', // same as start = no end given
        venue: isVirtual ? '' : clean(decodeEntities(loc.name), 140),
        location: isVirtual ? '' : [clean(decodeEntities(loc.name), 140), addr.text].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ').slice(0, 200),
        host: clean(decodeEntities(typeof org === 'string' ? org : org && org.name), 200),
        online: isVirtual && !addr.text,
        city: addr.city,
        region: addr.region,
        point: geo.latitude && geo.longitude ? [Number(geo.latitude), Number(geo.longitude)] : null,
      });
      return out;
    }
  }
  // No structured data: at least offer the page title.
  out.name = clean(metaContent(html, 'og:title') || decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''), 140);
  return out;
}

/* ------------------------------------------------------------- Luma events */
async function previewLuma(link, fetchImpl) {
  const slug = link.split('/').pop();
  let data;
  try {
    const res = await fetchImpl(`https://api.lu.ma/url?url=${encodeURIComponent(slug)}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return { ok: false, kind: 'existing', url: link, message: 'We couldn’t find that event on Luma. Check the link and try again.' };
    if (!res.ok) throw new Error(`Luma answered ${res.status}`);
    data = await res.json();
  } catch {
    return { ok: true, kind: 'existing', url: link, partial: true, message: 'We couldn’t load a preview from Luma right now, but you can still submit the link.' };
  }
  if (data.kind && data.kind !== 'event') {
    return { ok: false, kind: 'existing', url: link, message: 'That link is a Luma calendar or profile, not an event. Open the event itself and copy its link.' };
  }
  const d = data.data || {};
  const ev = d.event || {};
  if (!ev.name) return { ok: false, kind: 'existing', url: link, message: 'We couldn’t find that event on Luma. Check the link and try again.' };
  const tz = ev.timezone || TZ;
  const start = localParts(ev.start_at, tz);
  const end = localParts(ev.end_at || '', tz);
  const g = ev.geo_address_info || {};
  const online = ev.location_type === 'online';
  const hidden = g.mode === 'obfuscated' || !g.full_address;
  const coord = ev.coordinate || g.place_coordinate;
  const point = coord && coord.latitude != null ? [Number(coord.latitude), Number(coord.longitude)] : null;
  const where = whereIs({ online, point, city: g.city || (g.city_state || '').split(',')[0], region: g.region || (g.city_state || '').split(',')[1] || '', text: `${g.full_address || ''} ${g.city_state || ''}` });
  return {
    ok: true,
    kind: 'existing',
    url: link,
    name: clean(ev.name, 140),
    date: start.date,
    startTime: start.time,
    endDate: end.date || start.date,
    endTime: end.time,
    timezone: tz,
    location: online ? 'Online' : hidden ? `${g.city_state || g.city || ''}${g.city_state || g.city ? ' (exact address shared with guests)' : ''}` : clean(g.full_address).replace(/,\s*(USA|United States)$/, ''),
    host: (d.hosts || []).map((h) => h.name).filter(Boolean).join(', ').slice(0, 200),
    image: ev.cover_url || '',
    where,
  };
}

/* ------------------------------------------------------------------ route */
export async function previewLink(rawUrl, { fetchImpl = fetch } = {}) {
  const raw = String(rawUrl ?? '').trim();
  if (!raw) return { ok: false, message: 'Paste a link to preview.' };
  const luma = canonicalLumaUrl(raw);
  if (luma) return previewLuma(luma, fetchImpl);

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const u = isPublicHttpUrl(withScheme);
  if (!u) return { ok: false, kind: 'external', message: 'That doesn’t look like a web link. Paste the full address, starting with https://.' };

  const page = await fetchText(u.toString(), fetchImpl);
  if (!page.ok) {
    return { ok: true, kind: 'external', url: u.toString(), found: false, message: 'We couldn’t read that page, so please fill in the details below.' };
  }
  const ev = parseEventPage(page.text);
  return {
    ok: true,
    kind: 'external',
    url: u.toString(),
    found: ev.found,
    name: ev.name,
    date: ev.date,
    startTime: ev.startTime,
    endDate: ev.endDate,
    endTime: ev.endTime,
    location: ev.location,
    host: ev.host,
    where: ev.found ? whereIs({ online: ev.online, point: ev.point, city: ev.city, region: ev.region, text: ev.location }) : null,
    message: ev.found ? '' : 'We couldn’t find event details on that page, so please fill them in below.',
  };
}
