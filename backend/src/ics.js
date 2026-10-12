// Builds iCalendar (.ics) feeds that Google Calendar, Apple Calendar and
// Outlook can subscribe to.

const VTIMEZONES = {
  'America/New_York': ['-0500', '-0400', 'EST', 'EDT'],
  'America/Chicago': ['-0600', '-0500', 'CST', 'CDT'],
  'America/Denver': ['-0700', '-0600', 'MST', 'MDT'],
  'America/Los_Angeles': ['-0800', '-0700', 'PST', 'PDT'],
};

function vtimezone(tz) {
  const rules = VTIMEZONES[tz];
  if (!rules) return [];
  const [std, dst, stdName, dstName] = rules;
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:DAYLIGHT',
    `TZOFFSETFROM:${std}`,
    `TZOFFSETTO:${dst}`,
    `TZNAME:${dstName}`,
    'DTSTART:19700308T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${dst}`,
    `TZOFFSETTO:${std}`,
    `TZNAME:${stdName}`,
    'DTSTART:19701101T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];
}

const escapeText = (s) =>
  String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 bytes must be folded (RFC 5545 §3.1).
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const decoder = new TextDecoder();
  const parts = [];
  let start = 0;
  let limit = 75;
  while (bytes.length - start > limit) {
    let cut = start + limit;
    while ((bytes[cut] & 0xc0) === 0x80) cut--; // don't split a UTF-8 character
    parts.push(decoder.decode(bytes.slice(start, cut)));
    start = cut;
    limit = 74; // continuation lines start with a space
  }
  parts.push(decoder.decode(bytes.slice(start)));
  return parts.join('\r\n ');
}

const stamp = (local) => local.replace(/[-:]/g, '').slice(0, 13) + '00'; // 2026-10-13T18:00 -> 20261013T180000

export function buildIcs(name, events, communitiesById) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const zones = new Set(events.map((e) => e.timezone || 'America/New_York'));
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ATIHx Community Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  zones.forEach((tz) => lines.push(...vtimezone(tz)));

  for (const ev of events) {
    const community = communitiesById[ev.community] || { short: '' };
    const tz = ev.timezone || 'America/New_York';
    const location = [ev.venue, ev.address].filter(Boolean).join(', ');
    const description = [ev.host ? `Hosted by ${ev.host}` : '', ev.description, ev.url].filter(Boolean).join('\n\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.id}@atihx-community-calendar`,
      `DTSTAMP:${now}`,
      `DTSTART;TZID=${tz}:${stamp(ev.start)}`,
      `DTEND;TZID=${tz}:${stamp(ev.end)}`,
      `SUMMARY:${escapeText(`${ev.title} · ATIHx ${community.short}`)}`
    );
    if (location) lines.push(`LOCATION:${escapeText(location)}`);
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (ev.url) lines.push(`URL:${ev.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
