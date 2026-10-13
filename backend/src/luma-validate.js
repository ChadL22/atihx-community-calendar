// Checks what visitors send from the "Add An Event" page before it is queued
// for the Luma bot. Returns { value, errors } like validate.js.

const LUMA_LINK = /^https:\/\/(?:www\.)?(?:luma\.com|lu\.ma)\/([A-Za-z0-9_-]{3,80})\/?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function realDate(iso) {
  if (!DATE.test(iso)) return false;
  const d = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

// Accepts "luma.com/abc", "https://lu.ma/abc?tk=…" etc. and returns the
// canonical https://luma.com/<slug>, or '' if it isn't a Luma event link.
export function canonicalLumaUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return ''; }
  const clean = `https://${u.hostname.toLowerCase()}${u.pathname}`.replace(/^https:\/\/www\./, 'https://');
  const m = clean.match(LUMA_LINK);
  if (!m || ['create', 'home', 'discover', 'calendar', 'signin', 'login', 'user', 'event'].includes(m[1].toLowerCase())) return '';
  return `https://luma.com/${m[1]}`;
}

function webUrl(raw) {
  const s = String(raw ?? '').trim();
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.toString().slice(0, 500) : '';
  } catch {
    return '';
  }
}

export function validateLumaSubmission(input, { today }) {
  const errors = {};
  const b = input || {};
  const kind = b.kind === 'existing' || b.kind === 'external' ? b.kind : '';
  if (!kind) errors.kind = 'Choose what kind of event this is.';

  const submitterName = text(b.submitterName, 100);
  const submitterEmail = text(b.submitterEmail, 200).toLowerCase();
  // Name and email are optional; if an email is given it must look real.
  if (submitterEmail && !EMAIL.test(submitterEmail)) errors.submitterEmail = 'That email address doesn’t look right.';

  const value = { kind, submitterName, submitterEmail, payload: {} };

  if (kind === 'existing') {
    value.eventUrl = canonicalLumaUrl(b.url);
    if (!value.eventUrl) errors.url = 'Paste the link to your event on Luma, like https://luma.com/abc123.';
  }

  if (kind === 'external') {
    value.eventUrl = webUrl(b.url);
    if (!value.eventUrl) errors.url = 'Paste the full link to the event page, starting with https://.';
    else if (canonicalLumaUrl(value.eventUrl)) errors.url = 'That’s a Luma link. Choose “An existing Luma event” instead.';

    const p = {
      name: text(b.name, 140),
      host: text(b.host, 200),
      location: text(b.location, 200),
      date: text(b.date, 10),
      endDate: text(b.endDate || b.date, 10),
      startTime: text(b.startTime, 5),
      endTime: text(b.endTime, 5),
    };
    if (!p.name) errors.name = 'Add the event’s name.';
    if (!p.location) errors.location = 'Add the address. Only in-person DMV and Philadelphia-area events appear on the calendar.';
    if (!realDate(p.date)) errors.date = 'Choose the date.';
    else if (today && p.date < today) errors.date = 'This date has already passed.';
    if (!realDate(p.endDate) || p.endDate < p.date) errors.endDate = 'The end date can’t be before the start date.';
    if (!TIME.test(p.startTime)) errors.startTime = 'Choose a start time.';
    if (!TIME.test(p.endTime)) errors.endTime = 'Choose an end time.';
    else if (!errors.startTime && p.endDate === p.date && p.endTime <= p.startTime) errors.endTime = 'The end time needs to be after the start time.';
    value.payload = p;
  }

  return { value, errors };
}
