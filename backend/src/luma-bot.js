// The Luma bot: fills in Luma's own "Submit Event" forms on the All Tech Is
// Human calendar page, exactly as a person would, signed in as the
// community's Luma account.
//
// It drives a real (headless) Chrome through Cloudflare Browser Rendering.
// Only a small part of the Puppeteer API is used (goto, evaluate,
// waitForFunction, type, click, keyboard, setCookie, emulateTimezone) so the
// same steps can be tested locally against a stand-in page (test/mock-luma).
//
// If Luma redesigns its page, this is the file to update. Each step names the
// text or field it looks for, and errors say which step failed.

export class NeedsLogin extends Error {
  constructor() {
    super('The Luma account is signed out. An admin needs to refresh LUMA_SESSION (see SETUP.md).');
    this.name = 'NeedsLogin';
  }
}

export class StepFailed extends Error {
  constructor(step, detail = '') {
    super(`Luma bot couldn't ${step}${detail ? `: ${detail}` : ''}`);
    this.name = 'StepFailed';
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-11-10" -> "Nov 10, 2026", the format Luma's date box accepts when typed.
export const lumaDate = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: finds the most specific visible element whose text matches,
// marks it with data-atih-target so Puppeteer can click it with a real mouse.
function markByText(selector, pattern, flags, scope, pick) {
  document.querySelectorAll('[data-atih-target]').forEach((el) => el.removeAttribute('data-atih-target'));
  const re = new RegExp(pattern, flags);
  const root = scope ? [...document.querySelectorAll(scope)].pop() : document;
  if (!root) return false;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const hits = [...root.querySelectorAll(selector)].filter((el) => re.test((el.innerText || el.textContent || '').trim()) && visible(el));
  const el = pick === 'first' ? hits[0] : hits[hits.length - 1];
  if (!el) return false;
  el.setAttribute('data-atih-target', '1');
  return true;
}

async function clickText(page, step, selector, pattern, { scope = null, timeout = 15000 } = {}) {
  const ok = await waitFor(page, markByText, timeout, selector, pattern.source, pattern.flags, scope);
  if (!ok) throw new StepFailed(step, `"${pattern.source}" not found`);
  await page.click('[data-atih-target]');
}

// waitForFunction that returns false on timeout instead of throwing.
async function waitFor(page, fn, timeout, ...args) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 }, ...args);
    return true;
  } catch {
    return false;
  }
}

// Sets a React-controlled input's value the way React notices (used for the
// plain text fields; the address box gets real keystrokes instead).
function setField(selector, value, pressEnter) {
  const el = [...document.querySelectorAll(selector)].pop();
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  el.focus();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (pressEnter) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  el.blur();
  return true;
}

async function fill(page, step, selector, value, { enter = false } = {}) {
  const ok = await page.evaluate(setField, selector, value, enter);
  if (!ok) throw new StepFailed(step, `field ${selector} not found`);
}

const MODAL = '.lux-modal';

// Text of any error the open modal is showing (for the queue's "last error").
function modalErrors(modalSel) {
  const m = [...document.querySelectorAll(modalSel)].pop();
  if (!m) return '';
  const els = m.querySelectorAll('[class*="error"], [role="alert"], .text-danger');
  return [...els].map((e) => (e.innerText || '').trim()).filter(Boolean).join(' · ').slice(0, 300);
}

async function openCalendar(page, { calendarUrl, cookieName, session, cookieDomain }) {
  if (session) {
    await page.setCookie({ name: cookieName, value: session, domain: cookieDomain, path: '/', secure: true, httpOnly: true });
  }
  await page.emulateTimezone('America/New_York');
  await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const ready = await waitFor(page, markByText, 25000, 'button', '^[^A-Za-z0-9]*Submit Event$', '', null);
  if (!ready) throw new StepFailed('open the ATIH calendar on Luma', 'no Submit Event button');
  // Signed out? Luma shows "Sign In" in the top bar.
  const signedOut = await page.evaluate(() =>
    [...document.querySelectorAll('a, button')].some((el) => /^sign in$/i.test((el.innerText || '').trim()))
  );
  if (signedOut) throw new NeedsLogin();
}

async function chooseMenuItem(page, labelPattern) {
  await clickText(page, 'open the Submit Event menu', 'button', /^[^A-Za-z0-9]*Submit Event$/);
  await clickText(page, 'pick the menu option', '.lux-menu-item, [role="menuitem"]', labelPattern);
}

async function submitAndConfirm(page, step) {
  const enabled = await waitFor(
    page,
    (sel) => {
      const m = [...document.querySelectorAll(sel)].pop();
      const b = m && [...m.querySelectorAll('button')].filter((x) => /^(Submit|Add) Event$/.test((x.innerText || '').trim())).pop();
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      document.querySelectorAll('[data-atih-target]').forEach((el) => el.removeAttribute('data-atih-target'));
      b.setAttribute('data-atih-target', '1');
      return true;
    },
    10000,
    MODAL
  );
  if (!enabled) {
    const err = await page.evaluate(modalErrors, MODAL);
    throw new StepFailed(step, err || 'the Submit Event button stayed disabled');
  }
  await page.click('[data-atih-target]');
  // Success = Luma closes the form.
  const closed = await waitFor(page, (sel) => !document.querySelector(sel), 20000, MODAL);
  if (!closed) {
    const err = await page.evaluate(modalErrors, MODAL);
    throw new StepFailed('finish submitting', err || 'the form stayed open after Submit');
  }
}

// "Submit Existing Luma Event": paste the link, click Add, submit.
export async function submitExisting(page, item, opts) {
  await openCalendar(page, opts);
  await chooseMenuItem(page, /^(Submit|Add) Existing Luma Event$/);
  const input = `${MODAL} input[type="url"]`;
  if (!(await waitFor(page, (s) => !!document.querySelector(s), 10000, input))) {
    throw new StepFailed('open the "Submit Luma Event" form');
  }
  await page.click(input);
  await page.type(input, item.event_url, { delay: 15 });
  await clickText(page, 'add the event link', 'button', /^Add$/, { scope: MODAL, timeout: 5000 });
  // Luma looks the event up and lists it above "Suggested Events".
  await sleep(1500);
  await submitAndConfirm(page, 'submit the Luma event');
}

// "Submit External Event": URL first (Luma pre-fills from it), then our values.
export async function submitExternal(page, item, opts) {
  const p = typeof item.payload === 'string' ? JSON.parse(item.payload || '{}') : item.payload || {};
  await openCalendar(page, opts);
  await chooseMenuItem(page, /^(Submit|Add) External Event$/);
  const urlInput = `${MODAL} input[name="url"]`;
  if (!(await waitFor(page, (s) => !!document.querySelector(s), 10000, urlInput))) {
    throw new StepFailed('open the "Submit External Event" form');
  }
  await page.click(urlInput);
  await page.type(urlInput, item.event_url, { delay: 10 });
  // Give Luma's "Parsing URL..." a moment; it may fill fields we then overwrite.
  await sleep(3500);

  await fill(page, 'enter the event name', `${MODAL} input[name="name"]`, p.name);
  if (p.host) await fill(page, 'enter the host', `${MODAL} input[name="host"]`, p.host);

  // Dates and times: Luma's boxes are [start date, start time, end date, end time].
  const dt = `${MODAL} input.dt-input`;
  const count = await page.evaluate((s) => document.querySelectorAll(s).length, dt);
  if (count < 4) throw new StepFailed('find the date and time boxes', `found ${count}`);
  await page.evaluate((s) => document.querySelectorAll(s).forEach((el, i) => el.setAttribute('data-atih-dt', String(i))), dt);
  await fill(page, 'set the start date', `${MODAL} [data-atih-dt="0"]`, lumaDate(p.date), { enter: true });
  await fill(page, 'set the start time', `${MODAL} [data-atih-dt="1"]`, p.startTime);
  await fill(page, 'set the end date', `${MODAL} [data-atih-dt="2"]`, lumaDate(p.endDate || p.date), { enter: true });
  await fill(page, 'set the end time', `${MODAL} [data-atih-dt="3"]`, p.endTime);

  // Address: real keystrokes so Luma's place search runs, then pick the first match.
  if (p.location) {
    const addrMarked = await page.evaluate((m) => {
      const el = [...document.querySelectorAll(`${m} input`)].find((i) => /address/i.test(i.placeholder || ''));
      if (!el) return false;
      el.setAttribute('data-atih-addr', '1');
      return true;
    }, MODAL);
    if (!addrMarked) throw new StepFailed('find the address box');
    const addr = '[data-atih-addr="1"]';
    await page.click(addr);
    await page.type(addr, p.location, { delay: 25 });
    const picked = await waitFor(page, markByText, 8000, '.lux-menu .lux-menu-item', '\\S', '', null, 'first'); // Luma's best match
    if (picked) await page.click('[data-atih-target]');
    else await page.keyboard.press('Enter');
    await sleep(800);
  }

  // Confirm what Luma now shows before submitting.
  const shown = await page.evaluate((m) => {
    const modal = [...document.querySelectorAll(m)].pop();
    const v = (sel) => (modal.querySelector(sel) || {}).value || '';
    return { name: v('input[name="name"]'), dates: [...modal.querySelectorAll('input.dt-input')].map((i) => i.value) };
  }, MODAL);
  if (!shown.name) throw new StepFailed('enter the event name', 'Luma cleared it');
  if (shown.dates[1] !== p.startTime || shown.dates[3] !== p.endTime) {
    throw new StepFailed('set the times', `Luma shows ${shown.dates.join(' ')}`);
  }

  await submitAndConfirm(page, 'submit the external event');
}

export async function submitItem(page, item, opts) {
  if (item.kind === 'existing') return submitExisting(page, item, opts);
  if (item.kind === 'external') return submitExternal(page, item, opts);
  throw new StepFailed('submit', `unknown kind ${item.kind}`);
}
