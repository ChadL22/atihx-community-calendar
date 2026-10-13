/* Add An Event page.
   1. New Luma event      -> Luma's create page, already set to the ATIH calendar.
   2. Existing Luma event -> paste the link, check the preview, one button.
   3. Non-Luma event      -> paste the link; details are read from the page
                             (editable), one button.
   For 2 and 3 the backend's Luma bot submits the event to the ATIH calendar on
   Luma. Until the backend is connected (apiBase empty in js/config.js), 2 and 3
   show step-by-step instructions for doing it on Luma instead. */
(function () {
  'use strict';

  var CONFIG = window.ATIH_CONFIG || {};
  var API = String(CONFIG.apiBase || '').replace(/\/$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var form = $('luma-form');
  var link = $('event-link');
  var errorBox = $('form-error');
  var button = $('send-button');
  var details = $('details');
  var widgetId = null;
  var kind = '';
  var preview = null;      // last preview result for the current link
  var previewFor = '';     // the link that preview belongs to
  var pending = null;      // in-flight lookup
  var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  var pad = function (n) { return String(n).padStart(2, '0'); };
  var now = new Date();
  var today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  form.elements.date.min = today;
  var LUMA = /^(https?:\/\/)?(www\.)?(luma\.com|lu\.ma)\/[A-Za-z0-9_-]{3,}/i;

  /* ---------- remembered name/email (this browser only) ---------- */
  var store = {
    get: function (k) { try { return localStorage.getItem('atih.' + k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem('atih.' + k, v); } catch (e) { /* private mode */ } }
  };
  form.elements.submitterName.value = store.get('name');
  form.elements.submitterEmail.value = store.get('email');
  if (form.elements.submitterName.value || form.elements.submitterEmail.value) $('about-you').open = true;

  /* ---------- formatting ---------- */
  function prettyTime(t) {
    if (!t) return '';
    var h = Number(t.slice(0, 2));
    return (h % 12 || 12) + ':' + t.slice(3, 5) + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function whenText(p) {
    if (!p.date) return '';
    var d = new Date(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10)));
    var s = DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
    if (p.startTime) s += ' · ' + prettyTime(p.startTime) + (p.endTime ? '–' + prettyTime(p.endTime) : '') + ' ET';
    return s;
  }
  function addHours(t, h) {
    if (!t) return '';
    var m = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + h * 60;
    if (m >= 24 * 60) m = 23 * 60 + 59;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  /* ---------- choosing ---------- */
  function show(k) {
    kind = k;
    $('success').hidden = true;
    $('panel-new').hidden = k !== 'new';
    var formKind = k === 'existing' || k === 'external';
    form.hidden = !formKind || !API;
    $('panel-manual').hidden = !formKind || !!API;
    document.querySelectorAll('[data-manual]').forEach(function (el) {
      el.classList.toggle('is-pick', el.getAttribute('data-manual') === k);
    });
    $('manual-step3').textContent = k === 'external'
      ? 'Paste the event’s link and add the name, address, date and times.'
      : 'Paste your event’s Luma link, click Add, then Submit Event.';
    if (formKind) {
      $('link-label').textContent = k === 'existing' ? 'Paste your Luma event link' : 'Paste the event’s link';
      link.placeholder = k === 'existing' ? 'https://luma.com/abc123' : 'https://www.eventbrite.com/e/…';
      $('link-hint').textContent = k === 'existing'
        ? 'Open your event on Luma and copy the address from your browser.'
        : 'Eventbrite, Meetup, a university or organization page. We’ll read the details from it.';
      resetPreview();
      link.value = '';
    }
    clearErrors();
    if (formKind && API) loadTurnstile();
    try { history.replaceState(null, '', '#' + k); } catch (e) { /* ignore */ }
  }

  $('choices').addEventListener('change', function (e) {
    if (e.target.name !== 'kind') return;
    show(e.target.value);
    var target = kind === 'new' ? $('panel-new') : (API ? form : $('panel-manual'));
    if (target.getBoundingClientRect().top > window.innerHeight * 0.7) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (kind !== 'new' && API) setTimeout(function () { link.focus({ preventScroll: true }); }, 250);
  });

  /* ---------- link preview ---------- */
  function setStatus(text, loading) {
    var el = $('link-status');
    el.textContent = text || '';
    el.classList.toggle('is-loading', !!loading);
  }

  function resetPreview() {
    preview = null;
    previewFor = '';
    $('preview').hidden = true;
    details.hidden = true;
    $('edit-toggle').hidden = true;
    $('details-note').hidden = true;
    ['name', 'location', 'host', 'date', 'startTime', 'endTime'].forEach(function (n) { form.elements[n].value = ''; });
    setStatus('');
    updateButton();
  }

  function renderPreview(p) {
    var d = p.date ? new Date(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, Number(p.date.slice(8, 10))) : null;
    $('pv-date').innerHTML = d ? '<span class="mon">' + MON[d.getMonth()] + '</span><span class="day">' + d.getDate() + '</span>' : '';
    $('pv-date').hidden = !d;
    $('pv-title').textContent = p.name || (kind === 'existing' ? 'Your Luma event' : 'Your event');
    $('pv-when').textContent = whenText(p);
    $('pv-where').textContent = p.location || '';
    $('pv-host').textContent = p.host ? 'Hosted by ' + p.host : '';
    var hint = $('pv-hint');
    hint.textContent = p.where ? p.where.label : (p.message || '');
    hint.className = 'where-hint ' + (p.where && p.where.status === 'ok' ? 'is-ok' : 'is-warn');
    $('preview').hidden = false;
  }

  // Non-Luma: copy what we read into the editable fields; open them if anything's missing.
  function fillDetails(p) {
    form.elements.name.value = p.name || '';
    form.elements.location.value = p.location || '';
    form.elements.host.value = p.host || '';
    form.elements.date.value = p.date || '';
    form.elements.startTime.value = p.startTime || '';
    form.elements.endTime.value = p.endTime || (p.startTime ? addHours(p.startTime, 2) : '');
    var missing = detailsMissing();
    var guessedEnd = !p.endTime && p.startTime;
    $('details-note').textContent = !p.found
      ? (p.message || 'We couldn’t read the details from that page. Please fill them in.')
      : missing.length ? 'Please add what we couldn’t find: ' + missing.join(', ') + '.'
      : guessedEnd ? 'The page didn’t list an end time, so we guessed 2 hours. Change it if needed.' : '';
    $('details-note').hidden = !$('details-note').textContent;
    var open = !p.found || missing.length > 0 || guessedEnd;
    details.hidden = !open;
    $('edit-toggle').hidden = open;
    $('edit-toggle').setAttribute('aria-expanded', String(open));
    $('preview').hidden = !p.found;
  }

  function detailsMissing() {
    var m = [];
    if (!form.elements.name.value.trim()) m.push('the name');
    if (form.elements.location.value.trim().length < 6) m.push('the address');
    if (!form.elements.date.value) m.push('the date');
    if (!form.elements.startTime.value) m.push('the start time');
    if (!form.elements.endTime.value) m.push('the end time');
    return m;
  }

  function lookUp() {
    var raw = link.value.trim();
    if (!raw) { resetPreview(); return; }
    if (raw === previewFor) return;
    if (kind === 'existing' && !LUMA.test(raw)) {
      resetPreview();
      setStatus('');
      if (/^https?:\/\/\S+\.\S+/.test(raw)) showFieldError('url', 'That isn’t a Luma link. Choose “A non-Luma event” for other sites.');
      return;
    }
    if (kind === 'external' && LUMA.test(raw)) {
      resetPreview();
      showFieldError('url', 'That’s a Luma link. Choose “An existing Luma event” instead.');
      return;
    }
    if (kind === 'external' && !/^(https?:\/\/)?[^\s\/]+\.[^\s]+/i.test(raw)) return;
    clearFieldError('url');
    var mine = {};
    pending = mine;
    setStatus(kind === 'existing' ? 'Finding it on Luma…' : 'Reading the page…', true);
    fetch(API + '/api/preview?url=' + encodeURIComponent(raw))
      .then(function (r) { return r.json(); })
      .then(function (p) {
        if (pending !== mine) return; // a newer paste replaced this one
        previewFor = raw;
        preview = p;
        setStatus('');
        if (!p.ok) {
          $('preview').hidden = true;
          details.hidden = true;
          showFieldError('url', p.message || 'We couldn’t use that link.');
        } else if (kind === 'existing') {
          renderPreview(p);
          if (p.partial) { $('pv-title').textContent = 'Luma event link'; $('pv-hint').textContent = p.message; }
        } else {
          renderPreview(p);
          fillDetails(p);
        }
        updateButton();
      })
      .catch(function () {
        if (pending !== mine) return;
        setStatus('');
        previewFor = raw;
        preview = { ok: true, kind: kind, found: false, partial: true, message: 'We couldn’t load a preview right now.' };
        if (kind === 'external') fillDetails(preview);
        else { renderPreview({ name: 'Luma event link', message: 'We couldn’t load a preview right now, but you can still submit the link.' }); }
        updateButton();
      });
  }

  var timer;
  link.addEventListener('input', function () {
    clearTimeout(timer);
    if (link.value.trim() !== previewFor) { preview = null; updateButton(); }
    timer = setTimeout(lookUp, 450);
  });
  link.addEventListener('paste', function () { clearTimeout(timer); setTimeout(lookUp, 0); });
  link.addEventListener('blur', function () { clearTimeout(timer); lookUp(); });

  $('edit-toggle').addEventListener('click', function () {
    details.hidden = false;
    this.hidden = true;
    this.setAttribute('aria-expanded', 'true');
    form.elements.name.focus();
  });

  // Keep the preview card in step with edits to the details.
  details.addEventListener('input', function () {
    if (!preview) return;
    renderPreview({
      name: form.elements.name.value, location: form.elements.location.value, host: form.elements.host.value,
      date: form.elements.date.value, startTime: form.elements.startTime.value, endTime: form.elements.endTime.value,
      where: null, message: preview.where ? '' : ''
    });
    if (!details.hidden && $('preview').hidden && form.elements.name.value) $('preview').hidden = false;
    $('pv-hint').textContent = '';
    updateButton();
  });

  function updateButton() {
    var ready = !!preview && preview.ok && link.value.trim() === previewFor;
    button.disabled = !ready;
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
  function fieldEl(name) { return form.querySelector('[data-field="' + name + '"]'); }
  function clearFieldError(name) {
    var f = fieldEl(name);
    if (!f) return;
    f.classList.remove('has-error');
    var e = f.querySelector('.error');
    if (e) e.remove();
    var input = f.querySelector('input');
    if (input) input.removeAttribute('aria-invalid');
  }
  function showFieldError(name, msg) {
    var f = fieldEl(name);
    if (!f) return null;
    clearFieldError(name);
    f.classList.add('has-error');
    var input = f.querySelector('input');
    var err = document.createElement('span');
    err.className = 'error';
    err.id = 'err-' + name;
    err.textContent = msg;
    f.appendChild(err);
    if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id); }
    return input;
  }
  function clearErrors() {
    errorBox.hidden = true;
    ['url', 'name', 'location', 'host', 'date', 'startTime', 'endTime', 'submitterName', 'submitterEmail'].forEach(clearFieldError);
  }
  function showErrors(fields, message) {
    var first = null;
    Object.keys(fields || {}).forEach(function (n) {
      if (kind === 'existing' && ['name', 'location', 'date', 'startTime', 'endTime'].indexOf(n) !== -1) return;
      if (['name', 'location', 'date', 'startTime', 'endTime', 'host'].indexOf(n) !== -1) { details.hidden = false; $('edit-toggle').hidden = true; }
      if (n === 'submitterEmail') $('about-you').open = true;
      var input = showFieldError(n, fields[n]);
      if (!first) first = input;
    });
    if (message) { errorBox.textContent = message; errorBox.hidden = false; }
    (first || errorBox).focus();
  }
  form.addEventListener('input', function (e) {
    var f = e.target.closest('.form-field');
    if (f && f.classList.contains('has-error') && e.target !== link) clearFieldError(f.getAttribute('data-field'));
  });

  /* ---------- send ---------- */
  function collect() {
    var d = {
      kind: kind,
      url: link.value.trim(),
      submitterName: form.elements.submitterName.value.trim(),
      submitterEmail: form.elements.submitterEmail.value.trim(),
      website: form.elements.website.value
    };
    if (kind === 'external') {
      d.name = form.elements.name.value.trim();
      d.location = form.elements.location.value.trim();
      d.host = form.elements.host.value.trim();
      d.date = form.elements.date.value;
      d.startTime = form.elements.startTime.value;
      d.endTime = form.elements.endTime.value;
    }
    return d;
  }
  function localCheck(d) {
    var f = {};
    if (kind === 'external') {
      if (!d.name) f.name = 'Add the event’s name.';
      if (d.location.length < 6) f.location = 'Add the street address and city.';
      if (!d.date) f.date = 'Choose the date.';
      else if (d.date < today) f.date = 'This date has already passed.';
      if (!d.startTime) f.startTime = 'Choose a start time.';
      if (!d.endTime) f.endTime = 'Choose an end time.';
      else if (d.startTime && d.endTime <= d.startTime) f.endTime = 'The end time needs to be after the start time.';
    }
    if (d.submitterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.submitterEmail)) f.submitterEmail = 'That email address doesn’t look right.';
    return f;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (button.disabled) return;
    clearErrors();
    var data = collect();
    var problems = localCheck(data);
    if (Object.keys(problems).length) { showErrors(problems, 'Please fix the highlighted details.'); return; }
    if (CONFIG.turnstileSiteKey) {
      data.turnstileToken = window.turnstile && widgetId !== null ? window.turnstile.getResponse(widgetId) : '';
      if (!data.turnstileToken) { showErrors({}, 'Please complete the “I’m human” check.'); return; }
    }
    store.set('name', data.submitterName);
    store.set('email', data.submitterEmail);
    button.disabled = true;
    button.textContent = 'Submitting…';
    fetch(API + '/api/luma-submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, body: body }; });
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
      button.textContent = 'Submit to the ATIH calendar';
      updateButton();
    });
  });

  $('add-another').addEventListener('click', function () {
    $('success').hidden = true;
    form.hidden = false;
    show(kind);
    if (window.turnstile && widgetId !== null) window.turnstile.reset(widgetId);
    link.focus();
  });

  var preset = (location.hash || '').replace('#', '');
  if (['new', 'existing', 'external'].indexOf(preset) !== -1) {
    document.querySelector('input[name="kind"][value="' + preset + '"]').checked = true;
    show(preset);
  }
})();
