/* ATIHx Community Calendar
   Plain JavaScript, no build step.
   - With an API configured in js/config.js, events come live from the
     Cloudflare backend (approved submissions).
   - Without one, events come from data/events.js (static sample data). */
(function () {
  'use strict';

  var CONFIG = window.ATIH_CONFIG || {};
  var API = String(CONFIG.apiBase || '').replace(/\/$/, '');
  var STATIC_DATA = window.ATIH_DATA || { communities: [], events: [] };

  if (API) {
    fetch(API + '/api/events')
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(boot)
      .catch(function (err) {
        console.warn('Could not load live events, showing saved data instead.', err);
        boot(STATIC_DATA);
      });
  } else {
    boot(STATIC_DATA);
  }

  function boot(DATA) {
  var COMMUNITIES = DATA.communities.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
  var BY_ID = {};
  COMMUNITIES.forEach(function (c) { BY_ID[c.id] = c; });
  var EVENTS = DATA.events
    .filter(function (e) { return BY_ID[e.community]; })
    .sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var TZ_ABBR = { 'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Los_Angeles': 'PT' };
  var PAGE_SIZE = 6;

  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };

  var now = new Date();
  var TODAY = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  var TODAY_INDEX = now.getFullYear() * 12 + now.getMonth();

  // Months you can page through: every month with events, plus the current month.
  var monthIndex = function (iso) { return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1; };
  var MIN_INDEX = TODAY_INDEX, MAX_INDEX = TODAY_INDEX;
  EVENTS.forEach(function (e) {
    var k = monthIndex(e.start);
    if (k < MIN_INDEX) MIN_INDEX = k;
    if (k > MAX_INDEX) MAX_INDEX = k;
  });

  var state = {
    selected: [],          // community ids; empty means all
    query: '',
    open: false,
    active: 0,             // highlighted suggestion
    tab: 'upcoming',
    limit: PAGE_SIZE,
    month: TODAY_INDEX,
    subscribeOpen: false
  };

  /* ---------- helpers ---------- */
  function visibleEvents() {
    if (!state.selected.length) return EVENTS;
    return EVENTS.filter(function (e) { return state.selected.indexOf(e.community) !== -1; });
  }

  function formatTime(iso) {
    var h = Number(iso.slice(11, 13)), m = iso.slice(14, 16);
    var suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return { text: h + ':' + m, suffix: suffix };
  }

  function timeRange(ev) {
    var a = formatTime(ev.start);
    var tz = TZ_ABBR[ev.timezone] ? ' ' + TZ_ABBR[ev.timezone] : '';
    if (!ev.end) return a.text + ' ' + a.suffix + tz;
    var b = formatTime(ev.end);
    var first = a.suffix === b.suffix ? a.text : a.text + ' ' + a.suffix;
    return first + '–' + b.text + ' ' + b.suffix + tz;
  }

  /* ---------- calendar grid ---------- */
  function renderCalendar() {
    var y = Math.floor(state.month / 12), m = state.month % 12;
    $('month-title').textContent = MONTHS[m] + ' ' + y;
    $('prev-month').disabled = state.month <= MIN_INDEX;
    $('next-month').disabled = state.month >= MAX_INDEX;

    var byDate = {};
    visibleEvents().forEach(function (e) {
      var d = e.start.slice(0, 10);
      (byDate[d] = byDate[d] || []).push(e);
    });

    var first = new Date(y, m, 1);
    var lead = (first.getDay() + 6) % 7;           // weeks start on Monday
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var cells = Math.ceil((lead + daysInMonth) / 7) * 7;
    var html = '';
    for (var i = 0; i < cells; i++) {
      var d = new Date(y, m, 1 - lead + i);
      var iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var cls = ['cell'];
      if (d.getMonth() !== m) cls.push('is-outside');
      else if (i % 7 >= 5) cls.push('is-weekend');
      if (iso === TODAY) cls.push('is-today');
      html += '<div class="' + cls.join(' ') + '">';
      html += '<div class="daynum"' + (iso === TODAY ? ' aria-label="Today"' : '') + '>' + pad(d.getDate()) + '</div>';
      (byDate[iso] || []).forEach(function (e) {
        var c = BY_ID[e.community];
        var label = esc(e.title + ' · ' + c.name + ' · ' + timeRange(e) + (e.host ? ' · Hosted by ' + e.host : ''));
        var tag = e.url ? 'a href="' + esc(e.url) + '"' : 'span';
        html += '<' + tag + ' class="chip" style="background:' + esc(c.color) + '" title="' + label + '">' + esc(e.title) + '</' + tag.split(' ')[0] + '>';
      });
      html += '</div>';
    }
    $('grid').innerHTML = html;
  }

  function renderLegend() {
    var html = COMMUNITIES.map(function (c) {
      return '<span><span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.name.replace(', PA', '')) + '</span>';
    }).join('');
    html += '<span><span class="today-swatch"></span>Today</span>';
    $('legend').innerHTML = html;
  }

  /* ---------- upcoming / past list ---------- */
  function renderList() {
    var evs = visibleEvents();
    var upcoming = evs.filter(function (e) { return e.start.slice(0, 10) >= TODAY; });
    var past = evs.filter(function (e) { return e.start.slice(0, 10) < TODAY; }).reverse();
    var list = state.tab === 'upcoming' ? upcoming : past;

    $('tab-upcoming').setAttribute('aria-selected', String(state.tab === 'upcoming'));
    $('tab-past').setAttribute('aria-selected', String(state.tab === 'past'));

    if (!list.length) {
      var scope = state.selected.length ? ' for ' + state.selected.map(function (id) { return BY_ID[id].short; }).join(' or ') : '';
      $('event-list').innerHTML = '<div class="list-empty">No ' + state.tab + ' events' + scope + ' yet.</div>';
      return;
    }
    var html = list.slice(0, state.limit).map(function (e) {
      var c = BY_ID[e.community];
      var d = new Date(Number(e.start.slice(0, 4)), Number(e.start.slice(5, 7)) - 1, Number(e.start.slice(8, 10)));
      var title = e.url
        ? '<a class="event-title" href="' + esc(e.url) + '">' + esc(e.title) + '</a>'
        : '<div class="event-title">' + esc(e.title) + '</div>';
      var where = e.venue || 'Venue TBA';
      return '<article class="event">' +
        '<div class="event-date"><span class="mon">' + MON[d.getMonth()] + '</span><span class="day">' + d.getDate() + '</span><span class="dow">' + DOW[d.getDay()] + '</span></div>' +
        '<div class="event-body">' + title +
        '<div class="event-meta">' + esc(timeRange(e)) + ' · ' + esc(where) + '</div>' +
        (e.host ? '<div class="event-meta">Hosted by ' + esc(e.host) + '</div>' : '') +
        '<div><span class="badge" style="background:' + esc(c.color) + '">' + esc(c.name) + '</span></div>' +
        '</div></article>';
    }).join('');
    if (list.length > state.limit) {
      html += '<div class="list-empty"><button type="button" class="btn btn-outline btn-small" id="show-more">Show more</button></div>';
    }
    $('event-list').innerHTML = html;
  }

  /* ---------- community filter ---------- */
  function suggestions() {
    var q = state.query.trim().toLowerCase();
    return COMMUNITIES.filter(function (c) {
      if (state.selected.indexOf(c.id) !== -1) return false;
      return (c.name + ' ' + c.short + ' ' + (c.search || '')).toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderFilter() {
    $('tags').innerHTML = state.selected.map(function (id) {
      var c = BY_ID[id];
      return '<span class="tag"><span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.short) +
        '<button type="button" data-remove="' + esc(id) + '" aria-label="Remove ' + esc(c.name) + '">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button></span>';
    }).join('');

    var input = $('community-search');
    input.placeholder = state.selected.length ? 'Add another community' : 'All communities · search by city';
    $('clear-filter').hidden = !state.selected.length;

    var list = suggestions();
    if (state.active >= list.length) state.active = Math.max(0, list.length - 1);
    $('suggestions').hidden = !state.open;
    input.setAttribute('aria-expanded', String(state.open));
    if (!state.open) { input.removeAttribute('aria-activedescendant'); return; }

    if (!list.length) {
      var q = state.query.trim();
      $('community-list').innerHTML = '<div class="empty-note">' +
        (q ? 'No communities match “' + esc(q) + '”.' : 'All communities are selected.') + '</div>';
      input.removeAttribute('aria-activedescendant');
      return;
    }
    $('community-list').innerHTML = list.map(function (c, i) {
      return '<button type="button" role="option" id="opt-' + esc(c.id) + '" class="option' + (i === state.active ? ' is-active' : '') + '"' +
        ' aria-selected="' + (i === state.active) + '" data-add="' + esc(c.id) + '" tabindex="-1">' +
        '<span class="dot" style="background:' + esc(c.color) + '"></span>' + esc(c.name) + '</button>';
    }).join('');
    input.setAttribute('aria-activedescendant', 'opt-' + list[state.active].id);
  }

  function setSelected(ids) {
    state.selected = ids;
    state.limit = PAGE_SIZE;
    renderAll();
  }

  /* ---------- subscribe ---------- */
  function feedsForSelection() {
    var sel = state.selected.slice().sort();
    if (!sel.length || sel.length === COMMUNITIES.length) {
      return [{ slug: 'all', name: 'ATIHx Community Calendar', label: 'ATIHx Community' }];
    }
    var label = sel.map(function (id) { return BY_ID[id].short; }).join(' + ');
    if (API || COMMUNITIES.length <= 5) { // the live API builds any combination on request
      return [{ slug: sel.join('+'), name: 'ATIHx ' + label, label: 'ATIHx ' + label }];
    }
    return sel.map(function (id) {
      return { slug: id, name: 'ATIHx ' + BY_ID[id].short, label: 'ATIHx ' + BY_ID[id].short };
    });
  }

  function renderSubscribe() {
    var panel = $('subscribe-panel');
    panel.hidden = !state.subscribeOpen;
    $('subscribe-toggle').setAttribute('aria-expanded', String(state.subscribeOpen));
    if (!state.subscribeOpen) return;

    var feeds = feedsForSelection();
    $('feed-label').textContent = feeds.map(function (f) { return f.label; }).join(', ');
    var isLocal = !API && location.protocol === 'file:';
    var feedBase = API ? API + '/calendars/' : new URL('calendars/', location.href).href;

    $('feeds').innerHTML = feeds.map(function (f, i) {
      var https = feedBase + f.slug + '.ics';
      var webcal = https.replace(/^https?:/, 'webcal:');
      var google = 'https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(webcal);
      var outlook = 'https://outlook.live.com/calendar/0/addfromweb?url=' + encodeURIComponent(https) + '&name=' + encodeURIComponent(f.name);
      var id = 'feed-url-' + i;
      return '<div class="feed">' +
        (feeds.length > 1 ? '<div class="feed-name">' + esc(f.label) + '</div>' : '') +
        '<div class="feed-apps">' +
        '<a class="btn btn-outline btn-small" href="' + esc(google) + '" target="_blank" rel="noopener">Google Calendar</a>' +
        '<a class="btn btn-outline btn-small" href="' + esc(webcal) + '">Apple Calendar</a>' +
        '<a class="btn btn-outline btn-small" href="' + esc(outlook) + '" target="_blank" rel="noopener">Outlook</a>' +
        '</div>' +
        '<div class="feed-copy">' +
        '<label for="' + id + '">Or copy the calendar feed link (.ics)<input id="' + id + '" type="text" readonly value="' + esc(https) + '"></label>' +
        '<button type="button" class="btn btn-dark btn-small" data-copy="' + id + '">Copy link</button>' +
        '</div></div>';
    }).join('') +
      (isLocal ? '<p class="empty-note" style="padding:0">Subscribe links start working once the site is published online (for example on GitHub Pages).</p>' : '');
  }

  function copyFrom(inputId, button) {
    var input = $(inputId);
    var done = function () {
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = 'Copy link'; }, 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
    } else {
      input.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* user can copy manually */ }
    }
  }

  function renderAll() {
    renderFilter();
    renderCalendar();
    renderList();
    renderSubscribe();
  }

  /* ---------- events ---------- */
  function addCommunity(id) {
    state.query = '';
    $('community-search').value = '';
    state.open = false;
    setSelected(state.selected.concat(id));
  }

  $('community-search').addEventListener('focus', function () { state.open = true; renderFilter(); });
  $('community-search').addEventListener('input', function (e) {
    state.query = e.target.value; state.open = true; state.active = 0; renderFilter();
  });
  $('community-search').addEventListener('keydown', function (e) {
    var list = suggestions();
    if (e.key === 'ArrowDown') { e.preventDefault(); state.open = true; state.active = Math.min(state.active + 1, list.length - 1); renderFilter(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); state.active = Math.max(state.active - 1, 0); renderFilter(); }
    else if (e.key === 'Enter') { if (state.open && list[state.active]) { e.preventDefault(); addCommunity(list[state.active].id); } }
    else if (e.key === 'Escape') { state.open = false; renderFilter(); }
    else if (e.key === 'Backspace' && !e.target.value && state.selected.length) { setSelected(state.selected.slice(0, -1)); }
  });
  $('community-list').addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep focus in the input
  $('community-list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-add]');
    if (btn) addCommunity(btn.getAttribute('data-add'));
  });
  $('tags').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-remove]');
    if (!btn) return;
    var id = btn.getAttribute('data-remove');
    setSelected(state.selected.filter(function (x) { return x !== id; }));
    $('community-search').focus();
  });
  $('clear-filter').addEventListener('click', function () {
    state.query = ''; $('community-search').value = ''; state.open = false; setSelected([]);
  });
  document.addEventListener('click', function (e) {
    if (state.open && !$('filter').contains(e.target)) { state.open = false; state.query = ''; $('community-search').value = ''; renderFilter(); }
    var dd = document.querySelector('.dropdown');
    if (dd && !dd.contains(e.target)) { dd.classList.remove('is-open'); dd.querySelector('.dropdown-toggle').setAttribute('aria-expanded', 'false'); }
  });

  $('prev-month').addEventListener('click', function () { if (state.month > MIN_INDEX) { state.month--; renderCalendar(); } });
  $('next-month').addEventListener('click', function () { if (state.month < MAX_INDEX) { state.month++; renderCalendar(); } });
  $('today').addEventListener('click', function () { state.month = TODAY_INDEX; renderCalendar(); });

  $('tab-upcoming').addEventListener('click', function () { state.tab = 'upcoming'; state.limit = PAGE_SIZE; renderList(); });
  $('tab-past').addEventListener('click', function () { state.tab = 'past'; state.limit = PAGE_SIZE; renderList(); });
  $('event-list').addEventListener('click', function (e) {
    if (e.target.id === 'show-more') { state.limit += PAGE_SIZE; renderList(); }
  });

  $('subscribe-toggle').addEventListener('click', function () { state.subscribeOpen = !state.subscribeOpen; renderSubscribe(); });
  $('subscribe-close').addEventListener('click', function () { state.subscribeOpen = false; renderSubscribe(); $('subscribe-toggle').focus(); });
  $('feeds').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (btn) copyFrom(btn.getAttribute('data-copy'), btn);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.subscribeOpen && !state.open) { state.subscribeOpen = false; renderSubscribe(); }
  });

  // Slack menu: opens on hover, focus, or tap.
  var dropdown = document.querySelector('.dropdown');
  if (dropdown) {
    dropdown.querySelector('.dropdown-toggle').addEventListener('click', function () {
      var open = dropdown.classList.toggle('is-open');
      this.setAttribute('aria-expanded', String(open));
    });
  }

  /* ---------- photo carousel ---------- */
  (function carousel() {
    var root = $('carousel');
    if (!root) return;
    var slides = Array.prototype.slice.call(root.querySelectorAll('.carousel-frame img'));
    var dots = $('carousel-dots');
    var city = $('carousel-city');
    var current = 0, timer = null, paused = false;
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    dots.innerHTML = slides.map(function (img, i) {
      return '<button type="button" data-slide="' + i + '" aria-label="Show photo ' + (i + 1) + ': ' + esc(img.getAttribute('data-city')) + '"><span></span></button>';
    }).join('');

    function show(i) {
      current = (i + slides.length) % slides.length;
      slides.forEach(function (img, k) {
        img.classList.toggle('is-active', k === current);
        if (k === current) img.removeAttribute('aria-hidden'); else img.setAttribute('aria-hidden', 'true');
      });
      Array.prototype.forEach.call(dots.children, function (b, k) { b.setAttribute('aria-current', String(k === current)); });
      city.textContent = slides[current].getAttribute('data-city');
    }
    function start() {
      clearInterval(timer);
      if (!reduceMotion && slides.length > 1) timer = setInterval(function () { if (!paused) show(current + 1); }, 5000);
    }
    dots.addEventListener('click', function (e) {
      var b = e.target.closest('[data-slide]');
      if (b) { show(Number(b.getAttribute('data-slide'))); start(); }
    });
    root.addEventListener('mouseenter', function () { paused = true; });
    root.addEventListener('mouseleave', function () { paused = false; });
    root.addEventListener('focusin', function () { paused = true; });
    root.addEventListener('focusout', function () { paused = false; });
    show(0);
    start();
  })();

  renderLegend();
  renderAll();
  }
})();
