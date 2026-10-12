/* Top menu, shared by every page.
   - Desktop: a normal row of links; the Slack menu opens on hover, focus or click.
   - Phones: the menu becomes a single row you swipe sideways, like a ticker
     with a clear start and end. Soft fades show when there's more to either side. */
(function () {
  'use strict';

  var nav = document.querySelector('.nav');
  if (!nav) return;
  var dropdown = nav.querySelector('.dropdown');
  var toggle = dropdown && dropdown.querySelector('.dropdown-toggle');
  var menu = dropdown && dropdown.querySelector('.dropdown-menu');
  var phone = window.matchMedia('(max-width: 640px)');

  /* ---------- ticker edges ---------- */
  function updateEdges() {
    var max = nav.scrollWidth - nav.clientWidth;
    nav.classList.toggle('can-scroll-left', nav.scrollLeft > 2);
    nav.classList.toggle('can-scroll-right', nav.scrollLeft < max - 2);
  }
  nav.addEventListener('scroll', function () {
    updateEdges();
    if (dropdown && dropdown.classList.contains('is-open') && phone.matches) closeMenu();
  }, { passive: true });
  window.addEventListener('resize', updateEdges);
  window.addEventListener('load', updateEdges);
  updateEdges();

  // Keep the current page's link in view on phones.
  var current = nav.querySelector('[aria-current="page"]');
  if (current && phone.matches) {
    nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2;
    updateEdges();
  }

  /* ---------- Slack menu ---------- */
  if (!dropdown) return;

  function placeMenu() {
    if (!phone.matches) return;
    // On phones the menu row scrolls sideways (and fades at its edges), which
    // would clip a dropdown inside it. So while it's open, the Slack list is
    // moved to the page itself and pinned just under the button.
    var r = toggle.getBoundingClientRect();
    var width = Math.min(260, window.innerWidth - 32);
    var left = Math.max(16, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 16));
    menu.style.cssText = 'display:block;position:fixed;z-index:50;top:' + Math.round(r.bottom + 6) + 'px;left:' + Math.round(left) + 'px;right:auto;width:' + width + 'px;transform:none;';
  }
  function openMenu() {
    dropdown.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    if (phone.matches) { document.body.appendChild(menu); placeMenu(); }
  }
  function closeMenu() {
    dropdown.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (menu.parentNode !== dropdown) { menu.style.cssText = ''; dropdown.appendChild(menu); }
  }

  toggle.addEventListener('click', function (e) {
    e.stopPropagation();
    if (dropdown.classList.contains('is-open')) closeMenu(); else openMenu();
  });
  document.addEventListener('click', function (e) {
    if (!dropdown.contains(e.target) && !menu.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dropdown.classList.contains('is-open')) { closeMenu(); toggle.focus(); }
  });
  window.addEventListener('scroll', function () { if (phone.matches) closeMenu(); }, { passive: true });
  window.addEventListener('resize', function () { if (dropdown.classList.contains('is-open')) closeMenu(); });
})();
