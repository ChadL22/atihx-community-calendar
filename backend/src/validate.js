// Input checks and duplicate detection for submitted events.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);

function isRealDate(iso) {
  if (!DATE_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Normalizes a title so "Monthly Meetup!" and "monthly  meetup" match. */
export function normalizeTitle(title) {
  return String(title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\batihx?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const dedupeKey = (communityId, date, title) => `${communityId}|${date}|${normalizeTitle(title)}`;

/**
 * Validates a submission or an edit. Returns { value, errors } where errors is
 * an object of field -> message (empty when valid).
 *
 * options.today       'YYYY-MM-DD' used to reject past dates (public form only)
 * options.submission  public form: also require location, hosts, description
 *                     and the submitter's name/email
 */
export function validateEvent(input, communityIds, options = {}) {
  const errors = {};
  const v = {
    community: clean(input.community, 40),
    title: clean(input.title, 140),
    date: clean(input.date, 10),
    startTime: clean(input.startTime, 5),
    endTime: clean(input.endTime, 5),
    venue: clean(input.venue, 140),
    address: clean(input.address, 200),
    host: clean(input.host, 200),
    url: clean(input.url, 500),
    description: clean(input.description, 2000),
    submitterName: clean(input.submitterName, 100),
    submitterEmail: clean(input.submitterEmail, 200).toLowerCase(),
  };

  if (!communityIds.includes(v.community)) errors.community = 'Choose a community.';
  if (v.title.length < 3) errors.title = 'Add a title (at least 3 characters).';

  if (!isRealDate(v.date)) {
    errors.date = 'Choose a valid date.';
  } else if (options.today) {
    if (v.date < options.today) errors.date = 'The date has already passed.';
    const [y, m, d] = options.today.split('-').map(Number);
    const limit = new Date(Date.UTC(y + 2, m - 1, d)).toISOString().slice(0, 10);
    if (v.date > limit) errors.date = 'Events can be added up to two years ahead.';
  }

  if (!TIME_RE.test(v.startTime)) errors.startTime = 'Add a start time.';
  if (!TIME_RE.test(v.endTime)) errors.endTime = 'Add an end time.';
  if (!errors.startTime && !errors.endTime && v.endTime <= v.startTime) {
    errors.endTime = 'The end time must be after the start time.';
  }

  if (v.url) {
    try {
      const u = new URL(v.url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
      v.url = u.href;
    } catch {
      errors.url = 'Use a full link starting with https://';
    }
  }

  if (options.submission) {
    if (!v.venue && !v.address) errors.venue = 'Add where it\u2019s happening (a venue or an address).';
    if (v.host.length < 2) errors.host = 'Add who\u2019s hosting or sponsoring the event.';
    if (v.description.length < 20) errors.description = 'Add a short description (a sentence or two).';
    if (v.submitterName.length < 2) errors.submitterName = 'Add your name.';
    if (!EMAIL_RE.test(v.submitterEmail)) errors.submitterEmail = 'Add an email address so a lead can follow up.';
  } else if (v.submitterEmail && !EMAIL_RE.test(v.submitterEmail)) {
    errors.submitterEmail = 'That email address doesn’t look right.';
  }

  return { value: v, errors };
}
