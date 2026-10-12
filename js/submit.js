/* Submit-an-event form. Posts to the Cloudflare Worker configured in js/config.js. */
(function () {
  'use strict';

  var CONFIG = window.ATIH_CONFIG || {};
  var API = String(CONFIG.apiBase || '').replace(/\/$/, '');
  var form = document.getElementById('submit-form');
  var errorBox = document.getElementById('form-error');
  var button = document.getElementById('submit-button');
  var widgetId = null;

  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Slack menu (same behaviour as the calendar page).
  var dropdown = document.querySelector('.dropdown');
  if (dropdown) {
    var toggle = dropdown.querySelector('.dropdown-toggle');
    toggle.addEventListener('click', function () {
      toggle.setAttribute('aria-expanded', String(dropdown.classList.toggle('is-open')));
    });
    document.addEventListener('click', function (e) {
      if (!dropdown.contains(e.target)) { dropdown.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); }
    });
  }

  // Earliest allowed date is today.
  var now = new Date();
  var pad = function (n) { return String(n).padStart(2, '0'); };
  form.elements.date.min = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());

  function fillCommunities(list) {
    var select = document.getElementById('community');
    var keep = select.value;
    select.innerHTML = '<option value="">Choose a community</option>' + list
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; })
      .join('');
    select.value = keep;
    var preset = new URLSearchParams(location.search).get('community');
    if (preset && !keep) select.value = preset;
  }

  fillCommunities((window.ATIH_DATA && window.ATIH_DATA.communities) || []);

  if (!API) {
    document.getElementById('offline-note').hidden = false;
  } else {
    fetch(API + '/api/events').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.communities) fillCommunities(d.communities);
    }).catch(function () { /* keep the saved list */ });
    fetch(API + '/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      if (cfg.autoPublish) {
        document.getElementById('review-line').textContent =
          'Events go on the calendar as soon as you submit them. Anything that looks like a duplicate gets a quick check from a community lead first.';
      }
    }).catch(function () {});
  }

  // Cloudflare Turnstile ("I'm human" check), loaded only when configured.
  if (CONFIG.turnstileSiteKey) {
    window.onTurnstileLoad = function () {
      widgetId = window.turnstile.render('#turnstile', { sitekey: CONFIG.turnstileSiteKey, theme: 'light' });
    };
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }

  function clearErrors() {
    errorBox.hidden = true;
    errorBox.className = 'form-message is-error';
    form.querySelectorAll('.form-field').forEach(function (f) {
      f.classList.remove('has-error');
      var e = f.querySelector('.error');
      if (e) e.remove();
      var input = f.querySelector('input, select, textarea');
      if (input) input.removeAttribute('aria-invalid');
    });
  }

  function showErrors(fields, message) {
    var first = null;
    Object.keys(fields || {}).forEach(function (name) {
      var field = form.querySelector('[data-field="' + name + '"]');
      if (!field) return;
      field.classList.add('has-error');
      var input = field.querySelector('input, select, textarea');
      var err = document.createElement('span');
      err.className = 'error';
      err.id = 'err-' + name;
      err.textContent = fields[name];
      field.appendChild(err);
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id); }
      if (!first) first = input;
    });
    if (message) { errorBox.textContent = message; errorBox.hidden = false; }
    (first || errorBox).focus();
  }

  // Clear a field's error as soon as someone starts fixing it.
  form.addEventListener('input', function (e) {
    var field = e.target.closest('.form-field');
    if (!field || !field.classList.contains('has-error')) return;
    field.classList.remove('has-error');
    var err = field.querySelector('.error');
    if (err) err.remove();
    e.target.removeAttribute('aria-invalid');
  });

  // Quick checks in the browser so people get instant feedback; the server
  // checks everything again.
  function localCheck(data) {
    var f = {};
    if (data.title.trim().length < 3) f.title = 'Add a title (at least 3 characters).';
    if (!data.community) f.community = 'Choose a community.';
    if (!data.date) f.date = 'Choose a date.';
    else if (data.date < form.elements.date.min) f.date = 'The date has already passed.';
    if (!data.startTime) f.startTime = 'Add a start time.';
    if (!data.endTime) f.endTime = 'Add an end time.';
    if (data.startTime && data.endTime && data.endTime <= data.startTime) f.endTime = 'The end time must be after the start time.';
    if (!data.venue.trim() && !data.address.trim()) f.venue = 'Add where it\u2019s happening (a venue or an address).';
    if (data.host.trim().length < 2) f.host = 'Add who\u2019s hosting or sponsoring the event.';
    if (data.description.trim().length < 20) f.description = 'Add a short description (a sentence or two).';
    if (data.url && !/^https?:\/\/\S+\.\S+/.test(data.url)) f.url = 'Use a full link starting with https://';
    if (data.submitterName.trim().length < 2) f.submitterName = 'Add your name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.submitterEmail)) f.submitterEmail = 'Add an email address so a lead can follow up.';
    return f;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();
    var data = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) data[el.name] = el.value; });

    var problems = localCheck(data);
    if (Object.keys(problems).length) { showErrors(problems, 'Please fix the highlighted fields.'); return; }

    if (!API) {
      errorBox.className = 'form-message is-info';
      showErrors({}, 'Looks good! Submissions will work once the backend is connected (add apiBase in js/config.js).');
      return;
    }

    if (window.turnstile && widgetId !== null) {
      data.turnstileToken = window.turnstile.getResponse(widgetId) || '';
      if (!data.turnstileToken) { showErrors({}, 'Please complete the “I’m human” check.'); return; }
    }

    button.disabled = true;
    button.textContent = 'Sending…';
    fetch(API + '/api/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, status: r.status, body: body }; }); })
      .then(function (res) {
        if (res.ok) {
          form.hidden = true;
          document.querySelector('.submit-aside').hidden = true;
          document.getElementById('success-title').textContent =
            res.body.status === 'approved' ? 'Your event is on the calendar!' : 'Thanks for sharing!';
          document.getElementById('success-message').textContent = res.body.message;
          var done = document.getElementById('success');
          done.hidden = false;
          done.focus();
          return;
        }
        showErrors(res.body.fields, res.body.message || 'Something went wrong. Please try again.');
        if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
      })
      .catch(function () {
        showErrors({}, 'We couldn’t reach the calendar right now. Please try again in a minute.');
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = 'Add event';
      });
  });

  document.getElementById('submit-another').addEventListener('click', function () {
    var keep = {
      community: form.elements.community.value,
      submitterName: form.elements.submitterName.value,
      submitterEmail: form.elements.submitterEmail.value
    };
    form.reset();
    Object.keys(keep).forEach(function (k) { form.elements[k].value = keep[k]; });
    clearErrors();
    form.hidden = false;
    document.querySelector('.submit-aside').hidden = false;
    document.getElementById('success').hidden = true;
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    form.elements.title.focus();
  });
})();
