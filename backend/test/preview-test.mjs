// Tests for the link preview (src/preview.js) with made-up pages and Luma answers.
//   node test/preview-test.mjs
import assert from 'node:assert/strict';
import { previewLink, parseEventPage, localParts, whereIs } from '../src/preview.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.log(`  ✗ ${name}\n    ${err.stack}`); process.exitCode = 1; }
}
const page = (html, status = 200) => async () => new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const ld = (obj) => `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body></body></html>`;

const eventbrite = ld({
  '@context': 'https://schema.org', '@type': 'EducationEvent', name: 'AI Red Teaming Workshop',
  startDate: '2026-11-07T13:00:00-05:00', endDate: '2026-11-07T15:00:00-05:00',
  eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
  location: { '@type': 'Place', name: 'Bookhill Gallery', address: { '@type': 'PostalAddress', streetAddress: '1610 Wisconsin Avenue Northwest', addressLocality: 'Washington', addressRegion: 'DC', postalCode: '20007', addressCountry: 'US' } },
  organizer: { '@type': 'Organization', name: 'Respect The Tech' },
});

await test('reads Eventbrite-style event data and spots a DMV address', async () => {
  const r = await previewLink('https://www.eventbrite.com/e/ai-red-teaming-workshop-tickets-1', { fetchImpl: page(eventbrite) });
  assert.equal(r.kind, 'external');
  assert.equal(r.found, true);
  assert.equal(r.name, 'AI Red Teaming Workshop');
  assert.equal(r.date, '2026-11-07');
  assert.equal(r.startTime, '13:00');
  assert.equal(r.endTime, '15:00');
  assert.equal(r.location, 'Bookhill Gallery, 1610 Wisconsin Avenue Northwest, Washington, DC 20007');
  assert.equal(r.host, 'Respect The Tech');
  assert.equal(r.where.community, 'dc');
});

await test('handles @graph pages, times without an offset, and HTML entities', async () => {
  const html = ld({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage', name: 'Page' }, { '@type': 'Event', name: 'Book Talk &amp; Reception', startDate: '2026-10-28T16:00', location: { '@type': 'Place', name: 'Riggs Library', address: '37th and O Streets NW, Washington, DC 20057' } }] });
  const r = await previewLink('https://events.georgetown.edu/x', { fetchImpl: page(html) });
  assert.equal(r.name, 'Book Talk & Reception');
  assert.equal(r.startTime, '16:00');
  assert.equal(r.endTime, '');
  assert.equal(r.where.community, 'dc');
});

await test('online events are flagged', async () => {
  const html = ld({ '@type': 'Event', name: 'Webinar', startDate: '2026-10-28T12:00:00-04:00', eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode', location: { '@type': 'VirtualLocation', url: 'https://zoom.us/x' } });
  const r = await previewLink('https://example.org/webinar', { fetchImpl: page(html) });
  assert.equal(r.where.status, 'online');
  assert.equal(r.location, '');
});

await test('pages without event data still offer their title', async () => {
  const r = await previewLink('https://example.org/p', { fetchImpl: page('<html><head><meta property="og:title" content="Fall Mixer &amp; Demo Night"></head></html>') });
  assert.equal(r.found, false);
  assert.equal(r.name, 'Fall Mixer & Demo Night');
  assert.match(r.message, /fill them in/);
});

await test('unreadable pages ask for details instead of failing', async () => {
  const r = await previewLink('https://example.org/blocked', { fetchImpl: page('nope', 403) });
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
});

await test('refuses non-web and internal addresses', async () => {
  for (const u of ['http://127.0.0.1/admin', 'http://localhost:8787/', 'ftp://example.org/x', 'http://user:pw@example.org/', 'javascript:alert(1)']) {
    const r = await previewLink(u, { fetchImpl: () => { throw new Error('should not fetch ' + u); } });
    assert.equal(r.ok, false, u);
  }
});

const lumaAnswer = (event, hosts = [{ name: 'Manas Khatore' }], kind = 'event') => async (url) => {
  assert.match(String(url), /^https:\/\/api\.lu\.ma\/url\?url=/);
  return new Response(JSON.stringify({ kind, data: { event, hosts } }), { headers: { 'Content-Type': 'application/json' } });
};

await test('Luma links preview through Luma’s event lookup', async () => {
  const r = await previewLink('lu.ma/e2wrhp46?tk=abc', {
    fetchImpl: lumaAnswer({
      name: 'ATIHx DC: Responsible Tech Happy Hour', start_at: '2026-10-19T22:00:00.000Z', end_at: '2026-10-20T00:00:00.000Z', timezone: 'America/New_York',
      location_type: 'offline', coordinate: { latitude: 38.896, longitude: -77.023 },
      geo_address_info: { mode: 'shown', full_address: 'Teaism Penn Quarter, 400 8th St NW, Washington, DC 20004, USA', city: 'Washington', city_state: 'Washington, DC' },
    }),
  });
  assert.equal(r.kind, 'existing');
  assert.equal(r.url, 'https://luma.com/e2wrhp46');
  assert.equal(r.name, 'ATIHx DC: Responsible Tech Happy Hour');
  assert.equal(r.date, '2026-10-19');
  assert.equal(r.startTime, '18:00');
  assert.equal(r.endTime, '20:00');
  assert.equal(r.location, 'Teaism Penn Quarter, 400 8th St NW, Washington, DC 20004');
  assert.equal(r.host, 'Manas Khatore');
  assert.equal(r.where.community, 'dc');
});

await test('hidden Luma addresses use the city; Philadelphia matches', async () => {
  const r = await previewLink('https://luma.com/g5n0jr1i', {
    fetchImpl: lumaAnswer({ name: 'ATIHx Philadelphia', start_at: '2026-11-18T23:00:00.000Z', end_at: '2026-11-19T01:00:00.000Z', timezone: 'America/New_York', location_type: 'offline', geo_address_info: { mode: 'obfuscated', city: 'Philadelphia', region: 'Pennsylvania', city_state: 'Philadelphia, PA' } }),
  });
  assert.equal(r.location, 'Philadelphia, PA (exact address shared with guests)');
  assert.equal(r.startTime, '18:00', 'November is Eastern Standard Time');
  assert.equal(r.where.community, 'philly');
});

await test('Luma calendars and missing events are explained', async () => {
  let r = await previewLink('https://luma.com/AllTechIsHuman', { fetchImpl: lumaAnswer({}, [], 'calendar') });
  assert.equal(r.ok, false);
  assert.match(r.message, /calendar or profile/);
  r = await previewLink('https://luma.com/zzzzzzzz', { fetchImpl: async () => new Response('{}', { status: 404 }) });
  assert.equal(r.ok, false);
  assert.match(r.message, /couldn’t find/);
  r = await previewLink('https://luma.com/abcd1234', { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(r.ok, true, 'Luma being down never blocks a submission');
  assert.equal(r.partial, true);
});

await test('location hints: DMV, Philly, and elsewhere', async () => {
  assert.equal(whereIs({ text: '4238 Wilson Blvd, Arlington, VA 22203' }).community, 'dc');
  assert.equal(whereIs({ text: '840 1st Ave, King of Prussia, PA 19406' }).community, 'philly');
  assert.equal(whereIs({ text: '1 Pratt St, Baltimore, MD 21201' }).status, 'elsewhere');
  assert.equal(whereIs({ city: 'Arlington', region: 'TX', text: 'Arlington, TX' }).status, 'elsewhere');
  assert.equal(whereIs({ text: 'Silver Spring, MD' }).community, 'dc');
  assert.equal(whereIs({ point: [39.29, -76.61] }).status, 'elsewhere');
  assert.equal(whereIs({ text: 'Somewhere' }).status, 'unknown');
});

await test('times convert to Eastern, including across daylight saving', () => {
  assert.deepEqual(localParts('2026-07-01T22:00:00Z'), { date: '2026-07-01', time: '18:00' });
  assert.deepEqual(localParts('2026-12-01T23:30:00Z'), { date: '2026-12-01', time: '18:30' });
  assert.deepEqual(localParts('2026-11-02T03:00:00Z'), { date: '2026-11-01', time: '22:00' });
});

await test('real-world quirks: CDATA wrappers, end = start, city inside the street line', async () => {
  // Shaped like events.georgetown.edu (Oct 2026)
  const gu = `<script type="application/ld+json">/*<![CDATA[*/\n${JSON.stringify({ '@context': 'http://schema.org/', '@type': 'Event', name: 'Book Talk with Professor danah boyd', startDate: '2026-10-28T20:00:00+00:00', endDate: '2026-10-28T20:00:00+00:00', location: [{ '@type': 'Place', name: 'Copley Formal Lounge', address: { '@type': 'PostalAddress', streetAddress: 'Copley Formal Lounge' } }], organizer: { '@type': 'Organization', name: 'Center for Digital Ethics (Georgetown University)' } })}\n/*]]>*/</script>`;
  let r = parseEventPage(gu);
  assert.equal(r.found, true);
  assert.equal(r.startTime, '16:00');
  assert.equal(r.endTime, '', 'Georgetown repeats the start as the end');
  assert.equal(r.location, 'Copley Formal Lounge');
  assert.equal(r.host, 'Center for Digital Ethics (Georgetown University)');
  // Shaped like eventbrite.com (Oct 2026)
  r = parseEventPage(ld({ '@type': 'EducationEvent', name: 'Impacts of AI', startDate: '2026-09-28T09:00:00-04:00', endDate: '2026-09-28T14:00:00-04:00', location: { '@type': 'Place', name: 'The George Washington University Law School', address: { '@type': 'PostalAddress', addressLocality: 'Washington', addressRegion: 'DC', addressCountry: 'US', streetAddress: '2000 H Street Northwest, Washington, DC 20052' } }, organizer: 'Multiracial Democracy Project' }));
  assert.equal(r.location, 'The George Washington University Law School, 2000 H Street Northwest, Washington, DC 20052');
  assert.equal(r.host, 'Multiracial Democracy Project');
});

console.log(`\n${passed} preview tests passed.`);
