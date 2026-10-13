/* Review page for admins and community leads. Talks to /api/admin/* on the
   same Worker; Cloudflare Access handles sign-in before this page loads.

   Written for non-technical reviewers: each event shows a plain checklist of
   the details it needs, and the actions say exactly what they do. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var ICONS = {
    ok: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#187a3b"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    missing: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#b3261e" stroke-width="2"/><path d="M12 7v6" stroke="#b3261e" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.4" fill="#b3261e"/></svg>',
    optional: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#fff" stroke="#8a8a8a" stroke-width="2" stroke-dasharray="3 3"/></svg>'
  };
  var DECLINE_REASONS = ['Not an ATIHx event', 'Duplicate of another event', 'Missing details', 'Wrong community'];

  var me = null;
  var byId = {};
  var state = { status: 'pending', community: 'all', events: [], editing: null, panel: null }; // panel: {id, kind: 'decline'|'confirm'}

  function api(method, path, body) {
    var init = { method: method, headers: {}, credentials: 'same-origin' };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) { var e = new Error(data.message || 'Something went wrong (' + r.status + '). Please try again.'); e.data = data; e.status = r.status; throw e; }
        return data;
      });
    });
  }

  function flash(msg, isError) {
    var el = $('flash');
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.hidden = false;
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { el.hidden = true; }, 6000);
  }

  function prettyDate(iso) {
    var p = iso.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2]);
    return DAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function prettyTime(t) {
    var h = Number(t.slice(0, 2)), m = t.slice(3, 5);
    return (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  function since(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return mins <= 1 ? 'just now' : mins + ' minutes ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hrs / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }
  function linkHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; }
  }

  /* ---------- the details checklist ---------- */
  function checklist(ev) {
    var where = [ev.venue, ev.address].filter(Boolean).join(' · ');
    return [
      { key: 'when', label: 'Date & time', required: true, ok: !!(ev.date && ev.startTime),
        value: esc(prettyDate(ev.date)) + ' · ' + esc(prettyTime(ev.startTime)) + '–' + esc(prettyTime(ev.endTime)) },
      { key: 'where', label: 'Location', required: true, ok: !!where, value: esc(where) },
      { key: 'host', label: 'Hosted by', required: true, ok: !!(ev.host && ev.host.trim()), value: esc(ev.host) },
      { key: 'description', label: 'Description', required: true, ok: !!(ev.description && ev.description.trim().length >= 20),
        value: ev.description ? '<span class="desc">' + esc(ev.description) + '</span>' : '',
        tooShort: ev.description && ev.description.trim().length < 20 },
      { key: 'url', label: 'Registration link', required: false, ok: !!ev.url,
        value: ev.url ? '<a class="ulink" href="' + esc(ev.url) + '" target="_blank" rel="noopener noreferrer">Open on ' + esc(linkHost(ev.url)) + ' ↗</a>' : '' }
    ];
  }
  function missingItems(ev) {
    return checklist(ev).filter(function (i) { return i.required && !i.ok; });
  }

  function askLink(ev, missing) {
    var c = byId[ev.community] || { short: '' };
    var first = (ev.submitterName || '').split(' ')[0] || 'there';
    var need = missing.length
      ? 'Before we publish it, could you send us:\n' + missing.map(function (m) { return '  • ' + (m.key === 'where' ? 'the location (venue name and address)' : m.key === 'host' ? 'who is hosting or sponsoring it' : m.key === 'description' ? 'a short description of the event' : m.label.toLowerCase()); }).join('\n')
      : 'Before we publish it, we had a quick question:\n\n';
    var body = 'Hi ' + first + ',\n\nThanks for submitting "' + ev.title + '" to the ATIHx Community Calendar. ' + need +
      '\n\nThanks!\nATIHx ' + c.short + ' team';
    return 'mailto:' + encodeURIComponent(ev.submitterEmail) +
      '?subject=' + encodeURIComponent('Your ATIHx event: ' + ev.title) +
      '&body=' + encodeURIComponent(body);
  }

  /* ---------- rendering ---------- */
  function renderFilter() {
    var list = me.communities;
    if (list.length < 2) { $('community-filter').innerHTML = ''; return; }
    var html = '<button type="button" class="chip-btn" data-community="all" aria-pressed="' + (state.community === 'all') + '">All</button>';
    html += list.map(function (c) {
      return '<button type="button" class="chip-btn" data-community="' + esc(c.id) + '" aria-pressed="' + (state.community === c.id) + '">' +
        '<span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.short) + '</button>';
    }).join('');
    $('community-filter').innerHTML = html;
  }

  function renderChecklist(ev) {
    var items = checklist(ev);
    var required = items.filter(function (i) { return i.required; });
    var done = required.filter(function (i) { return i.ok; }).length;
    var html = '<div class="check-head"><h4>Details check</h4><span class="check-score' + (done === required.length ? ' is-complete' : '') + '">' +
      (done === required.length ? 'All details here' : done + ' of ' + required.length + ' details') + '</span></div><ul class="checklist">';
    items.forEach(function (i) {
      var stateCls = i.ok ? 'is-ok' : (i.required ? 'is-missing' : 'is-optional');
      var statusText = i.ok ? 'Complete' : (i.required ? 'Missing' : 'Optional');
      var value = i.ok ? i.value
        : (i.required ? '<span class="missing-text">' + (i.tooShort ? 'Too short: “' + esc(ev.description) + '”' : 'Missing') + '</span>'
          : '<span class="optional-text">No link (optional)</span>');
      html += '<li class="' + stateCls + '"><span class="check-icon">' + (i.ok ? ICONS.ok : (i.required ? ICONS.missing : ICONS.optional)) +
        '<span class="sr-only">' + statusText + ':</span></span><span class="check-label">' + esc(i.label) + '</span><span class="check-value">' + value + '</span></li>';
    });
    return html + '</ul>';
  }

  function renderActions(ev) {
    var b = [];
    var hasEmail = !!ev.submitterEmail;
    if (ev.status === 'pending') {
      b.push('<button type="button" class="btn btn-dark" data-act="approve">Approve and publish</button>');
      b.push('<button type="button" class="btn btn-outline" data-act="edit">Fix details</button>');
      if (hasEmail) b.push('<a class="btn btn-outline" href="' + esc(askLink(ev, missingItems(ev))) + '">Ask submitter</a>');
      b.push('<button type="button" class="btn btn-outline" data-act="decline">Decline</button>');
    } else if (ev.status === 'approved') {
      b.push('<button type="button" class="btn btn-outline" data-act="edit">Fix details</button>');
      b.push('<button type="button" class="btn btn-outline" data-act="unpublish">Take off the calendar</button>');
    } else {
      b.push('<button type="button" class="btn btn-outline" data-act="restore">Move back to review</button>');
    }
    if (me.isAdmin) b.push('<button type="button" class="link-btn danger" data-act="delete">Delete permanently</button>');
    return '<div class="actions">' + b.join('') + '</div>';
  }

  function renderPanel(ev) {
    if (!state.panel || state.panel.id !== ev.id) return '';
    if (state.panel.kind === 'confirm') {
      var NAMES = { when: 'a date and time', where: 'a location', host: 'the hosts', description: 'a description' };
      var missing = missingItems(ev).map(function (m) { return NAMES[m.key] || m.label.toLowerCase(); });
      return '<div class="panel-box warning-box" role="alert"><p><strong>This event is missing ' + esc(missing.join(', ').replace(/, ([^,]*)$/, ' and $1')) + '.</strong> ' +
        'People usually need these to decide whether to come. You can still publish it now and add them later.</p><div class="actions">' +
        '<button type="button" class="btn btn-dark btn-small" data-act="publish-anyway">Publish anyway</button>' +
        '<button type="button" class="btn btn-outline btn-small" data-act="edit">Fix details first</button>' +
        '<button type="button" class="btn btn-outline btn-small" data-act="close-panel">Cancel</button></div></div>';
    }
    return '<div class="panel-box"><label for="note-' + esc(ev.id) + '"><strong>Why are you declining it?</strong> <span class="muted">(optional, only reviewers see this)</span></label>' +
      '<div class="reasons">' + DECLINE_REASONS.map(function (r) { return '<button type="button" class="chip-btn" data-reason="' + esc(r) + '">' + esc(r) + '</button>'; }).join('') + '</div>' +
      '<input id="note-' + esc(ev.id) + '" class="note-input" maxlength="500" placeholder="Add a note">' +
      '<div class="actions"><button type="button" class="btn btn-dark btn-small" data-act="confirm-decline">Decline event</button>' +
      '<button type="button" class="btn btn-outline btn-small" data-act="close-panel">Cancel</button></div></div>';
  }

  function renderCard(ev) {
    var c = byId[ev.community] || { short: ev.community, name: ev.community, color: '#ddd' };
    var html = '<article class="card" data-id="' + esc(ev.id) + '">';
    html += '<div class="card-top"><span class="badge" style="background:' + esc(c.color) + '">' + esc(c.name) + '</span>' +
      '<span class="submitted">Submitted by ' + (esc(ev.submitterName) || 'someone') +
      (ev.submitterEmail ? ' (<a class="ulink" href="mailto:' + esc(ev.submitterEmail) + '">' + esc(ev.submitterEmail) + '</a>)' : '') +
      ' · ' + esc(since(ev.createdAt)) + '</span></div>';
    html += '<h3>' + esc(ev.title) + '</h3>';

    if (ev.possibleDuplicate) {
      var d = ev.possibleDuplicate;
      html += '<div class="warning-box"><strong>Is this a duplicate?</strong> “' + esc(d.title) + '” at ' + esc(prettyTime(d.startTime || '00:00')) +
        ' on the same day is already ' + (d.status === 'approved' ? 'on the calendar' : 'waiting for review') + '. If it’s the same event, decline this one.</div>';
    }

    if (state.editing === ev.id) {
      html += '<div class="edit-slot"></div>';
    } else {
      html += renderChecklist(ev);
      if (ev.status !== 'pending' && ev.reviewedBy) {
        html += '<p class="review-note">' + (ev.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + esc(ev.reviewedBy) +
          (ev.reviewNote ? ' · “' + esc(ev.reviewNote) + '”' : '') + '</p>';
      }
      html += state.panel && state.panel.id === ev.id ? renderPanel(ev) : renderActions(ev);
    }
    return html + '</article>';
  }

  function renderList() {
    var events = state.events.filter(function (e) { return state.community === 'all' || e.community === state.community; });
    if (!events.length) {
      var msg = {
        pending: ['You’re all caught up.', 'New submissions will show up here.'],
        approved: ['Nothing published yet.', 'Approved events will show up here.'],
        rejected: ['Nothing declined.', 'Declined events will show up here.']
      }[state.status];
      $('list').innerHTML = '<div class="empty"><p class="empty-title">' + msg[0] + '</p><p>' + msg[1] + '</p></div>';
      return;
    }
    $('list').innerHTML = events.map(renderCard).join('');
    if (state.editing) {
      var ev = state.events.find(function (e) { return e.id === state.editing; });
      var slot = document.querySelector('.card[data-id="' + CSS.escape(state.editing) + '"] .edit-slot');
      if (ev && slot) mountEditor(slot, ev);
    }
    if (state.panel && state.panel.kind === 'decline') {
      var note = $('note-' + state.panel.id);
      if (note) note.focus();
    }
  }

  function mountEditor(slot, ev) {
    var form = $('edit-template').content.firstElementChild.cloneNode(true);
    form.querySelector('[name="community"]').innerHTML = me.communities.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('');
    ['title', 'community', 'date', 'startTime', 'endTime', 'venue', 'address', 'host', 'description', 'url'].forEach(function (k) {
      form.elements[k].value = ev[k] || '';
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {};
      Array.prototype.forEach.call(form.elements, function (el) { if (el.name) body[el.name] = el.value; });
      var btn = form.querySelector('[type="submit"]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      api('PUT', '/api/admin/events/' + encodeURIComponent(ev.id), body).then(function () {
        state.editing = null;
        flash('Changes saved.');
        load();
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save changes';
        var errEl = form.querySelector('.form-error');
        var fields = err.data && err.data.fields;
        errEl.textContent = fields ? Object.keys(fields).map(function (k) { return fields[k]; }).join(' ') : err.message;
        errEl.hidden = false;
      });
    });
    form.querySelector('[data-cancel]').addEventListener('click', function () { state.editing = null; renderList(); });
    slot.appendChild(form);
    var firstEmpty = ['venue', 'host', 'description'].map(function (k) { return form.elements[k]; }).find(function (el) { return !el.value; });
    (firstEmpty || form.elements.title).focus();
  }

  function renderCounts(counts) {
    ['pending', 'approved', 'rejected'].forEach(function (s) {
      var el = $('count-' + s);
      el.textContent = counts[s] || 0;
      el.classList.toggle('has-items', !!counts[s]);
    });
    var n = counts.pending || 0;
    document.title = (n ? '(' + n + ') ' : '') + 'Review events · ATIHx Community Calendar';
    $('greeting').textContent = n === 0 ? 'No events waiting for review'
      : n === 1 ? '1 event is waiting for review' : n + ' events are waiting for review';
  }

  function load() {
    return api('GET', '/api/admin/events?status=' + state.status).then(function (data) {
      state.events = data.events;
      renderCounts(data.counts || {});
      renderList();
    }).catch(function (err) { flash(err.message, true); });
  }

  /* ---------- actions ---------- */
  function setStatus(id, status, note, okMsg) {
    return api('POST', '/api/admin/events/' + encodeURIComponent(id) + '/status', { status: status, note: note || '' })
      .then(function () { state.panel = null; flash(okMsg); load(); })
      .catch(function (err) { flash(err.message, true); });
  }

  $('list').addEventListener('click', function (e) {
    var reason = e.target.closest('[data-reason]');
    if (reason) {
      var input = reason.closest('.panel-box').querySelector('.note-input');
      input.value = reason.getAttribute('data-reason');
      input.focus();
      return;
    }
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.closest('.card').getAttribute('data-id');
    var ev = state.events.find(function (x) { return x.id === id; });
    switch (btn.getAttribute('data-act')) {
      case 'approve':
        if (missingItems(ev).length) { state.panel = { id: id, kind: 'confirm' }; renderList(); return; }
        btn.disabled = true;
        setStatus(id, 'approved', '', '“' + ev.title + '” is now on the calendar.');
        break;
      case 'publish-anyway':
        btn.disabled = true;
        setStatus(id, 'approved', '', '“' + ev.title + '” is now on the calendar.');
        break;
      case 'decline': state.panel = { id: id, kind: 'decline' }; state.editing = null; renderList(); break;
      case 'confirm-decline': setStatus(id, 'rejected', $('note-' + id).value, '“' + ev.title + '” was declined. It won’t appear on the calendar.'); break;
      case 'close-panel': state.panel = null; renderList(); break;
      case 'unpublish': setStatus(id, 'pending', '', '“' + ev.title + '” was taken off the calendar and moved back to “To review”.'); break;
      case 'restore': setStatus(id, 'pending', '', '“' + ev.title + '” moved back to “To review”.'); break;
      case 'edit': state.editing = id; state.panel = null; renderList(); break;
      case 'delete':
        if (!window.confirm('Delete “' + ev.title + '” permanently? This can’t be undone.')) return;
        api('DELETE', '/api/admin/events/' + encodeURIComponent(id)).then(function () { flash('Deleted.'); load(); })
          .catch(function (err) { flash(err.message, true); });
        break;
    }
  });

  $('list').addEventListener('keydown', function (e) {
    if (e.target.classList && e.target.classList.contains('note-input')) {
      if (e.key === 'Enter') { e.preventDefault(); e.target.closest('.card').querySelector('[data-act="confirm-decline"]').click(); }
      if (e.key === 'Escape') { state.panel = null; renderList(); }
    }
  });

  document.querySelector('.tabs').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-status]');
    if (!btn) return;
    state.status = btn.getAttribute('data-status');
    state.editing = null;
    state.panel = null;
    document.querySelectorAll('.tabs [data-status]').forEach(function (b) { b.setAttribute('aria-selected', String(b === btn)); });
    load();
  });

  $('community-filter').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-community]');
    if (!btn) return;
    state.community = btn.getAttribute('data-community');
    renderFilter();
    renderList();
  });

  /* ---------- admin tools ---------- */
  function loadModerators() {
    return api('GET', '/api/admin/moderators').then(function (data) {
      $('moderators').innerHTML = data.moderators.length ? data.moderators.map(function (m) {
        var c = byId[m.community];
        var role = m.role === 'admin' ? 'Admin (all communities)' : 'Lead · ' + (c ? c.name : m.community);
        var self = m.email === me.email && m.role === 'admin';
        return '<div class="row"><span><strong>' + esc(m.email) + '</strong> <span class="role">' + esc(role) + '</span></span>' +
          (self ? '<span class="role">You</span>' : '<button type="button" class="link-btn danger" data-remove-email="' + esc(m.email) + '" data-remove-community="' + esc(m.community) + '">Remove</button>') +
          '</div>';
      }).join('') : '<div class="row">No moderators yet.</div>';
    }).catch(function (err) { flash(err.message, true); });
  }

  function setupAdminTools() {
    $('admin-tools').hidden = false;
    var all = me.allCommunities || me.communities;
    $('moderator-community').innerHTML = all.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>'; }).join('');
    var form = $('add-moderator');
    var syncRole = function () { form.querySelector('.community-field').hidden = form.elements.role.value === 'admin'; };
    form.elements.role.addEventListener('change', syncRole);
    syncRole();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      api('POST', '/api/admin/moderators', { email: form.elements.email.value, role: form.elements.role.value, community: form.elements.community.value })
        .then(function () { flash('Added ' + form.elements.email.value + '. They can sign in to this page now.'); form.reset(); syncRole(); loadModerators(); })
        .catch(function (err) { flash(err.message, true); });
    });
    $('moderators').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-remove-email]');
      if (!btn) return;
      var email = btn.getAttribute('data-remove-email');
      if (!window.confirm('Remove ' + email + ' as a reviewer?')) return;
      api('DELETE', '/api/admin/moderators', { email: email, community: btn.getAttribute('data-remove-community') })
        .then(function () { flash('Removed ' + email + '.'); loadModerators(); })
        .catch(function (err) { flash(err.message, true); });
    });
    var cform = $('add-community');
    cform.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {};
      Array.prototype.forEach.call(cform.elements, function (el) { if (el.name) body[el.name] = el.value; });
      api('POST', '/api/admin/communities', body).then(function () {
        flash(body.name + ' added. Reloading…');
        setTimeout(function () { location.reload(); }, 900);
      }).catch(function (err) {
        var f = err.data && err.data.fields;
        flash(f ? Object.keys(f).map(function (k) { return f[k]; }).join(' ') : err.message, true);
      });
    });
    loadModerators();
    setupLuma();
  }


  /* ---------- Sent to Luma ---------- */
  var LUMA_LABELS = { queued: 'Waiting to send', working: 'Sending now', submitted: 'Sent to Luma', failed: 'Couldn’t send', needs_login: 'Waiting for sign-in' };
  function loadLuma() {
    return api('GET', '/api/admin/luma-queue').then(function (data) {
      var st = data.status || {};
      var box = $('luma-status');
      var lines = [];
      var bad = false;
      if (!data.hasBrowser) { lines.push('The Browser Rendering connection isn’t set up yet (see SETUP.md).'); bad = true; }
      if (!data.hasSession) { lines.push('The bot isn’t signed in to Luma yet. Add LUMA_SESSION (see SETUP.md).'); bad = true; }
      if (st.signed_in === 'no') { lines.push('<strong>Luma signed the bot out.</strong> Copy a fresh sign-in cookie into LUMA_SESSION (SETUP.md, “Refresh the Luma sign-in”), then click “Retry waiting and failed”.'); bad = true; }
      if (st.last_success) lines.push('Last event sent: ' + since(st.last_success) + '.');
      if (st.last_run) lines.push('Bot last ran ' + since(st.last_run) + '.');
      if (st.last_problem && bad) lines.push('Last problem: ' + esc(st.last_problem));
      if (!lines.length) lines.push('Ready. Nothing has been sent yet.');
      box.innerHTML = lines.join('<br>');
      box.className = 'luma-status ' + (bad ? 'is-bad' : 'is-ok');

      $('luma-queue').innerHTML = data.items.length ? data.items.map(function (it) {
        var p = it.payload || {};
        var title = it.kind === 'external' ? (p.name || it.event_url) : it.event_url;
        var when = it.kind === 'external' && p.date ? prettyDate(p.date) + ', ' + prettyTime(p.startTime) + ' · ' + esc(p.location || '') : 'Existing Luma event';
        return '<div class="row luma-row"><div>' +
          '<strong>' + esc(title) + '</strong> <span class="pill-status ' + esc(it.status) + '">' + esc(LUMA_LABELS[it.status] || it.status) + '</span>' +
          '<div class="meta">' + when + '</div>' +
          '<div class="meta">From ' + (it.submitter_name ? esc(it.submitter_name) : 'a visitor') + (it.submitter_email ? ' (<a class="ulink" href="mailto:' + esc(it.submitter_email) + '">' + esc(it.submitter_email) + '</a>)' : '') + ' · ' + since(it.created_at) +
          ' · <a class="ulink" href="' + esc(it.event_url) + '" target="_blank" rel="noopener">event page ↗</a></div>' +
          (it.last_error && it.status !== 'submitted' ? '<div class="err">' + esc(it.last_error) + '</div>' : '') +
          '</div>' +
          (it.status === 'failed' || it.status === 'needs_login' ? '<button type="button" class="link-btn" data-luma-retry="' + esc(it.id) + '">Retry</button>' : '<span></span>') +
          '</div>';
      }).join('') : '<div class="row">Nothing has been sent from the site yet.</div>';
    }).catch(function (err) { $('luma-status').textContent = err.message; });
  }

  function setupLuma() {
    $('luma-run').addEventListener('click', function () {
      api('POST', '/api/admin/luma-queue/run').then(function (d) { flash(d.message); setTimeout(loadLuma, 45000); }).catch(function (err) { flash(err.message, true); });
    });
    $('luma-retry-all').addEventListener('click', function () {
      api('POST', '/api/admin/luma-queue/retry-waiting').then(function (d) { flash(d.requeued + ' event(s) will be sent again within a few minutes.'); loadLuma(); }).catch(function (err) { flash(err.message, true); });
    });
    $('luma-queue').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-luma-retry]');
      if (!btn) return;
      api('POST', '/api/admin/luma-queue/' + encodeURIComponent(btn.getAttribute('data-luma-retry')) + '/retry')
        .then(function () { flash('It will be sent again within a few minutes.'); loadLuma(); })
        .catch(function (err) { flash(err.message, true); });
    });
    loadLuma();
  }

  /* ---------- start ---------- */
  api('GET', '/api/admin/me').then(function (data) {
    me = data;
    $('loading').hidden = true;
    $('who-email').textContent = me.email;
    if (!me.allowed) {
      $('denied-email').textContent = me.email;
      $('denied').hidden = false;
      return;
    }
    (me.allCommunities || me.communities).forEach(function (c) { byId[c.id] = c; });
    var scope = me.isAdmin ? 'every community' : me.communities.map(function (c) { return c.name; }).join(' and ');
    $('mode-note').textContent = me.autoPublish
      ? 'Events go live as soon as they’re submitted. Anything that looks like a duplicate waits here for a quick check. You’re reviewing ' + scope + '.'
      : 'Nothing goes on the calendar until a reviewer approves it. You’re reviewing ' + scope + '.';
    $('app').hidden = false;
    renderFilter();
    load();
    if (me.isAdmin) setupAdminTools();
  }).catch(function (err) {
    $('loading').textContent = err.status === 401
      ? 'Please sign in to review events.'
      : err.message;
  });
})();
