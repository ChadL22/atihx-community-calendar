/* Add An Event page.
   1. New Luma event      -> link to Luma's create page (already set to the ATIH calendar)
   2. Existing Luma event -> our form; the Luma bot submits it with "Submit Existing Luma Event"
   3. Non-Luma event      -> our form; the Luma bot submits it with "Submit External Event"
   Until the backend is connected (apiBase empty in js/config.js), 2 and 3 show
   step-by-step instructions for doing it on Luma instead. */
(function () {
  'use strict';

  var CONFIG = window.ATIH_CONFIG || {};
  var API = String(CONFIG.apiBase || '').replace(/\/$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var form = $('luma-form');
  var errorBox = $('form-error');
  var button = $('send-button');
  var widgetId = null;
  var kind = '';

  var pad = function (n) { return String(n).padStart(2, '0'); };
  var now = new Date();
  var today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  form.elements.date.min = today;

  /* ---------- choosing ---------- */
  function show(k) {
    kind = k;
    $('success').hidden = true;
    $('panel-new').hidden = k !== 'new';
    var formKind = k === 'existing' || k === 'external';
    form.hidden = !formKind || !API;
    $('panel-manual').hidden = !formKind || !!API;
    // Only the chosen kind's fields are active (both kinds have a "url" field).
    form.querySelectorAll('[data-kind]').forEach(function (fs) {
      var on = fs.getAttribute('data-kind') === k;
      fs.hidden = !on;
      fs.querySelectorAll('input').forEach(function (i) { i.disabled = !on; });
    });
    // Manual fallback: highlight the right Luma menu item.
    document.querySelectorAll('[data-manual]').forEach(function (el) {
      el.classList.toggle('is-pick', el.getAttribute('data-manual') === k);
    });
    $('manual-step3').textContent = k === 'external'
      ? 'Paste the event’s link and add the name, address, date and times.'
      : 'Paste your event’s Luma link, click Add, then Submit Event.';
    clearErrors();
    if (formKind && API) loadTurnstile();
    try { history.replaceState(null, '', '#' + k); } catch (e) { /* ignore */ }
  }

  $('choices').addEventListener('change', function (e) {
    if (e.target.name === 'kind') {
      show(e.target.value);
      var target = kind === 'new' ? $('panel-new') : (API ? form : $('panel-manual'));
      if (target.getBoundingClientRect().top > window.innerHeight * 0.75) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  var preset = (location.hash || '').replace('#', '');
  if (['new', 'existing', 'external'].indexOf(preset) !== -1) {
    document.querySelector('input[name="kind"][value="' + preset + '"]').checked = true;
    show(preset);
  }

  /* ---------- Cloudflare Turnstile ("I'm human" check) ---------- */
  function loadTurnstile() {
    if (!CONFIG.turnstileSiteKey || loadTurnstile.started) return;
    loadTurnstile.started = true;
    window.onTurnstileLoad = function () {
      widgetId = window.turnstile.render('#turnstile', { sitekey: CONFIG.turnstileSiteKey, theme: 'light' });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  /* ---------- errors ---------- */
  function clearErrors() {
    errorBox.hidden = true;
    form.querySelectorAll('.form-field').forEach(function (f) {
      f.classList.remove('has-error');
      var e = f.querySelector('.error');
      if (e) e.remove();
      var input = f.querySelector('input');
      if (input) input.removeAttribute('aria-invalid');
    });
  }

  function showErrors(fields, message) {
    var first = null;
    Object.keys(fields || {}).forEach(function (name) {
      var field = form.querySelector('[data-kind="' + kind + '"] [data-field="' + name + '"]') ||
        form.querySelector('.fieldset:not([data-kind]) [data-field="' + name + '"]');
      if (!field) return;
      field.classList.add('has-error');
      var input = field.querySelector('input');
      var err = document.createElement('span');
      err.className = 'error';
      err.id = 'err-' + kind + '-' + name;
      err.textContent = fields[name];
      field.appendChild(err);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id); }
      if (!first) first = input;
    });
    if (message) { errorBox.textContent = message; errorBox.hidden = false; }
    (first || errorBox).focus();
  }

  form.addEventListener('input', function (e) {
    var field = e.target.closest('.form-field');
    if (!field || !field.classList.contains('has-error')) return;
    field.classList.remove('has-error');
    var err = field.querySelector('.error');
    if (err) err.remove();
    e.target.removeAttribute('aria-invalid');
  });

  /* ---------- quick checks (the server checks everything again) ---------- */
  var LUMA = /^(https?:\/\/)?(www\.)?(luma\.com|lu\.ma)\/[A-Za-z0-9_-]{3,}/i;
  function value(name) {
    var el = form.querySelector('[data-kind="' + kind + '"] [name="' + name + '"]') || form.querySelector('.fieldset:not([data-kind]) [name="' + name + '"]');
    return el ? el.value.trim() : '';
  }
  function collect() {
    var d = { kind: kind, url: value('url'), submitterName: value('submitterName'), submitterEmail: value('submitterEmail'), website: form.elements.website.value };
    if (kind === 'external') {
      d.name = value('name'); d.host = value('host'); d.location = value('location');
      d.date = value('date'); d.startTime = value('startTime'); d.endTime = value('endTime');
    }
    return d;
  }
  function localCheck(d) {
    var f = {};
    if (kind === 'existing' && !LUMA.test(d.url)) f.url = 'Paste the link to your event on Luma, like https://luma.com/abc123.';
    if (kind === 'external') {
      if (!/^https?:\/\/\S+\.\S+/.test(d.url)) f.url = 'Paste the full link to the event page, starting with https://.';
      else if (LUMA.test(d.url)) f.url = 'That’s a Luma link. Choose “An existing Luma event” instead.';
      if (!d.name) f.name = 'Add the event’s name.';
      if (d.location.length < 6) f.location = 'Add the street address and city.';
      if (!d.date) f.date = 'Choose the date.';
      else if (d.date < today) f.date = 'This date has already passed.';
      if (!d.startTime) f.startTime = 'Choose a start time.';
      if (!d.endTime) f.endTime = 'Choose an end time.';
      else if (d.startTime && d.endTime <= d.startTime) f.endTime = 'The end time needs to be after the start time.';
    }
    if (!d.submitterName) f.submitterName = 'Add your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.submitterEmail)) f.submitterEmail = 'Add an email address we can reach you at.';
    return f;
  }

  /* ---------- send ---------- */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();
    var data = collect();
    var problems = localCheck(data);
    if (Object.keys(problems).length) { showErrors(problems, 'Please fix the highlighted fields.'); return; }
    if (CONFIG.turnstileSiteKey) {
      data.turnstileToken = window.turnstile && widgetId !== null ? window.turnstile.getResponse(widgetId) : '';
      if (!data.turnstileToken) { showErrors({}, 'Please complete the “I’m human” check.'); return; }
    }
    button.disabled = true;
    button.textContent = 'Sending…';
    fetch(API + '/api/luma-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, status: r.status, body: body }; });
    }).then(function (res) {
      if (res.ok) {
        form.hidden = true;
        $('success-message').textContent = res.body.message || $('success-message').textContent;
        $('success').hidden = false;
        $('success').focus();
        return;
      }
      showErrors(res.body.fields, res.body.message || 'Something went wrong. Please try again.');
      if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    }).catch(function () {
      showErrors({}, 'We couldn’t reach the calendar just now. Check your connection and try again.');
    }).then(function () {
      button.disabled = false;
      button.textContent = 'Send to Luma';
    });
  });

  $('add-another').addEventListener('click', function () {
    form.reset();
    form.elements.date.min = today;
    $('success').hidden = true;
    form.hidden = false;
    show(kind);
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    form.querySelector('[data-kind="' + kind + '"] input').focus();
  });
})();
