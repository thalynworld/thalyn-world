/* ============================================================================
   THALYN — shared site behaviour
   Loaded by every page. Respects prefers-reduced-motion throughout.
   ============================================================================ */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════════
     SITE_CONFIG — the only place you edit when your Steam page and demo
     worlds are ready. Everything across the site reads from here.
     ══════════════════════════════════════════════════════════════════════ */
  var SITE_CONFIG = {
    // ── DROP-IN SLOT 1 — STEAM ──────────────────────────────────────────
    // LIVE since 2026-08-11 (store page posted as Coming Soon → Early Access,
    // September 2026). Every .cta-steam button now reads "Wishlist on Steam"
    // and points here; the static hrefs in the pages match, so it works
    // without JS too. Set back to '' to fall the whole site back to Discord.
    steamUrl: 'https://store.steampowered.com/app/4581800/Thalyn/',
    steamFallbackUrl: 'https://discord.gg/UH9ukaR5Ew',

    // ── DROP-IN SLOT 2 — DEMO WORLDS (.glb) ─────────────────────────────
    // Paths are pre-wired to /demo/worlds/<id>_web.glb. To make a world live:
    //   1. Drop the OPTIMISED export (the "_web" .glb — KTX2 + meshopt) at that path
    //      in thalyn-world/demo/worlds/  (NEVER a raw export — a browser can't open a
    //      .glb over ~2 GB; and GitHub rejects any single file over 100 MB, so host
    //      large scenes on https/R2 and paste the full URL instead).
    //   2. Flip available:false → true for that world.
    // Each world goes live independently. The /demo/ page reads this list; nothing
    // else needs touching. (Card titles/descriptions already live in /demo/index.html.)
    demoWorlds: [
      { id: 'serene',    label: 'Serene',    url: '/demo/worlds/serene_web.glb',     available: false },
      { id: 'joyful',    label: 'Joyful',    url: '/demo/worlds/joyful_web.glb',     available: false },
      { id: 'oppressive',label: 'Oppressive',url: '/demo/worlds/oppressive_web.glb', available: false },
      { id: 'desolate',  label: 'Desolate',  url: '/demo/worlds/desolate_web.glb',   available: false },
      { id: 'eerie',     label: 'Eerie',     url: '/demo/worlds/eerie_web.glb',      available: false },
      { id: 'chaotic',   label: 'Chaotic',   url: '/demo/worlds/chaotic_web.glb',    available: false }
    ],

    // ── DROP-IN SLOT 3 — EMAIL CAPTURE (launch notify list) ─────────────
    // Paste a static-form-service endpoint here once a provider is chosen, e.g.
    // Buttondown's embeddable-form action:
    //   'https://buttondown.com/api/emails/embed-subscribe/YOUR-USERNAME'
    // Leave '' until then. While empty, every .email-capture-form falls back
    // to a plain mailto: (opens the visitor's mail app, pre-addressed and
    // pre-filled) — it still works, it just isn't a managed list yet. Once a
    // real endpoint is set, the form POSTs there instead and no other change
    // is needed.
    formEndpoint: '',

    discordUrl: 'https://discord.gg/UH9ukaR5Ew'
  };
  window.SITE_CONFIG = SITE_CONFIG; // so the demo page can read the world list

  var reduced = window.matchMedia('(prefers-reduced-motion:reduce)').matches;

  /* ── Steam CTAs: wire href + label from config (the one-line drop-in) ── */
  function wireSteamCtas() {
    var live = !!SITE_CONFIG.steamUrl;
    document.querySelectorAll('.cta-steam').forEach(function (el) {
      el.href = live ? SITE_CONFIG.steamUrl : SITE_CONFIG.steamFallbackUrl;
      var label = live ? el.dataset.labelSteam : el.dataset.labelPending;
      if (label) el.textContent = label;
      if (!live) el.setAttribute('data-pending', 'true');
    });
  }

  /* ── Cookieless analytics — no-ops until a real snippet defines
       window.plausible or window.goatcounter (paste it at the
       ANALYTICS_SNIPPET marker in _build/build.py's meta_html, then
       rebuild). Safe to call anywhere; never loads a script itself. ── */
  function trackEvent(name, props) {
    try {
      if (window.plausible) window.plausible(name, props ? { props: props } : undefined);
      else if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true });
    } catch (e) {}
  }
  window.ThalynTrack = trackEvent; // so page-specific inline scripts (e.g. /demo/) can log events too

  /* ── Click tracking: Discord + Steam CTAs ─────────────────────────────── */
  function initClickTracking() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (!a) return;
      if (a.classList.contains('cta-steam')) trackEvent(SITE_CONFIG.steamUrl ? 'Steam Wishlist Click' : 'Discord Click');
      else if (/discord\.gg/.test(a.href || '')) trackEvent('Discord Click');
    });
  }

  /* ── Email capture: mailto: fallback until SITE_CONFIG.formEndpoint is set.
       Markup contract: <form class="email-capture-form"> containing an
       input[type=email], with a sibling .email-capture-status for feedback. ── */
  function initEmailForms() {
    document.querySelectorAll('.email-capture-form').forEach(function (form) {
      var status = form.parentElement && form.parentElement.querySelector('.email-capture-status');
      if (SITE_CONFIG.formEndpoint) { form.action = SITE_CONFIG.formEndpoint; form.method = 'post'; }
      form.addEventListener('submit', function (e) {
        var input = form.querySelector('input[type="email"]');
        var email = input && input.value.trim();
        if (!email) return; // let native required/type=email validation handle it
        trackEvent('Email Signup');
        if (SITE_CONFIG.formEndpoint) return; // real endpoint set — let the form POST natively
        e.preventDefault();
        var subject = encodeURIComponent('Notify me when Thalyn launches');
        var body = encodeURIComponent('Add me to the launch list: ' + email);
        window.location.href = 'mailto:hello@thalyn.world?subject=' + subject + '&body=' + body;
        if (status) { status.hidden = false; status.textContent = 'Opening your email app to confirm — thank you.'; }
        form.reset();
      });
    });
  }

  /* ── Mobile nav toggle ──────────────────────────────────────────────── */
  function initNav() {
    var nav = document.querySelector('.site-nav');
    var toggle = nav && nav.querySelector('.nav-toggle');
    if (!nav || !toggle) return;
    toggle.addEventListener('click', function () {
      var open = nav.getAttribute('data-open') === 'true';
      nav.setAttribute('data-open', String(!open));
      toggle.setAttribute('aria-expanded', String(!open));
    });
    nav.querySelectorAll('.nav-links a').forEach(function (a) {
      a.addEventListener('click', function () {
        nav.setAttribute('data-open', 'false');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ── Ember particles ────────────────────────────────────────────────── */
  function initEmbers() {
    var canvas = document.getElementById('ember-canvas');
    if (!canvas || reduced) return;
    var ctx = canvas.getContext('2d');
    var GOLD = '#E8C66A', GREEN = '#78b45a';  /* warmed toward the gild ramp */
    var W, H, embers = [], COUNT = 42;
    function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize); resize();
    function mk() {
      var g = Math.random() > 0.38;
      return { x: Math.random() * W, y: H + Math.random() * 60, r: 0.8 + Math.random() * 2.2,
        vy: -(0.22 + Math.random() * 0.55), vx: (Math.random() - 0.5) * 0.38,
        a: 0.55 + Math.random() * 0.45, da: -(0.0008 + Math.random() * 0.0012),
        col: g ? GOLD : GREEN, halo: g ? 'rgba(232,198,106,' : 'rgba(120,180,90,' };
    }
    for (var i = 0; i < COUNT; i++) { var e = mk(); e.y = Math.random() * H; embers.push(e); }
    function tick() {
      ctx.clearRect(0, 0, W, H);
      embers.forEach(function (e, i) {
        e.y += e.vy; e.x += e.vx; e.a += e.da;
        ctx.save();
        var gr = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * 5);
        gr.addColorStop(0, e.halo + (e.a * 0.45).toFixed(3) + ')');
        gr.addColorStop(1, e.halo + '0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = e.a; ctx.fillStyle = e.col;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        if (e.a <= 0 || e.y < -20) embers[i] = mk();
      });
      raf = requestAnimationFrame(tick);
    }
    var raf = null;
    function start() { if (!raf) raf = requestAnimationFrame(tick); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }
    // Don't burn CPU/battery animating an invisible tab.
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
    start();
  }

  /* ── Typewriter — CLS-safe. A hidden ghost of the longest phrase holds
       the box open; the live line never changes layout below it. ───────── */
  function initTypewriter() {
    document.querySelectorAll('.tw-target').forEach(function (el) {
      var phrases;
      try { phrases = JSON.parse(el.dataset.phrases || '[]'); } catch (ex) { return; }
      if (!phrases.length) return;
      el.setAttribute('aria-hidden', 'true'); // decorative kinetic text — don't spam screen readers

      // Reserve space: insert a ghost (longest phrase) as a sibling in the grid cell.
      var wrap = el.closest('.tw-wrap');
      if (wrap && !wrap.querySelector('.tw-ghost')) {
        var longest = phrases.reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
        var ghost = document.createElement('span');
        ghost.className = 'tw-ghost' + (el.className ? ' ' + el.className : '');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.textContent = longest;
        wrap.insertBefore(ghost, el);
      }

      el.textContent = phrases[0];
      if (reduced) return; // static first phrase, no animation

      var pi = 0, ci = 0, del = false, paused = false;
      function step() {
        var word = phrases[pi];
        if (paused) { paused = false; del = true; setTimeout(step, 28); return; }
        if (!del) {
          el.textContent = word.slice(0, ci + 1); ci++;
          if (ci === word.length) { paused = true; setTimeout(step, 2200); return; }
          setTimeout(step, 55);
        } else {
          el.textContent = word.slice(0, ci - 1); ci--;
          if (ci === 0) { del = false; pi = (pi + 1) % phrases.length; setTimeout(step, 320); return; }
          setTimeout(step, 28);
        }
      }
      setTimeout(step, 600);
    });
  }

  /* ── Scroll reveal ──────────────────────────────────────────────────── */
  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var sibs = Array.prototype.slice.call(el.parentElement.querySelectorAll('.reveal'));
        el.style.transitionDelay = (sibs.indexOf(el) * 120) + 'ms';
        el.classList.add('is-visible');
        obs.unobserve(el);
      });
    }, { threshold: 0.12 });
    els.forEach(function (el) { obs.observe(el); });
  }

  function init() { wireSteamCtas(); initNav(); initEmbers(); initTypewriter(); initReveal(); initEmailForms(); initClickTracking(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
