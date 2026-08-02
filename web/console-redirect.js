/* ──────────────────────────────────────────────────────────────────────────
 * console-redirect.js — routes console / controller visitors from the Pickle
 * Arcade WEBSITE to the gamepad-native Console Edition at xbox/.
 *
 * build-site.mjs injects this as the FIRST script in <head> of site/index.html
 * (right after <meta charset>), so a console visitor never sees a flash of the
 * mouse-and-keyboard launcher before being moved across.
 *
 * Four ways a visitor ends up on the Console Edition, in priority order:
 *   1. ?console=1        — explicit, and remembered from then on
 *   2. remembered choice — localStorage gl_edition === 'console'
 *   3. user agent        — Xbox / PlayStation / Nintendo / smart-TV browsers
 *   4. a gamepad appears — a banner offers to switch, auto-accepting after a
 *                          countdown (never a silent redirect: a desktop user
 *                          with a controller plugged in can decline, and the
 *                          decline is remembered)
 *
 * Escape hatches:  ?noconsole=1 here or at xbox/?noconsole=1  →  stay on the
 * desktop site for good.  ?ua=1 prints the browser's user agent on screen,
 * which is how you find out what a console actually calls itself.
 *
 * DO NOT add Electron/Node references here — this runs on GitHub Pages.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var CONSOLE_PATH = 'xbox/';
  var PREF_KEY     = 'gl_edition';   // 'console' | 'web'
  var COUNTDOWN    = 7;              // seconds before the gamepad banner accepts

  // Consoles and TV browsers that say so in their user agent. Kept deliberately
  // loose (no \b) — some builds bolt the token onto other words.
  var CONSOLE_UA = /Xbox|PlayStation|PLAYSTATION|Nintendo|NX\/|SmartTV|SMART-TV|Smart-TV|AppleTV|Tizen|Web0S|WebOS|HbbTV|CrKey|GoogleTV|BRAVIA/i;

  function flag(name) { return new RegExp('[?&]' + name + '(?![a-z0-9_-])', 'i').test(location.search); }
  function pref()     { try { return localStorage.getItem(PREF_KEY); } catch (e) { return null; } }
  function setPref(v) { try { localStorage.setItem(PREF_KEY, v); } catch (e) {} }
  function go()       { try { location.replace(CONSOLE_PATH); } catch (e) { location.href = CONSOLE_PATH; } }

  var optedOut = false;

  /* ── 1–3: decisions we can make before the page paints ──────────────────── */
  if (flag('noconsole')) {
    setPref('web');
    optedOut = true;
  } else if (flag('console')) {
    setPref('console'); go(); return;
  } else if (pref() === 'console') {
    go(); return;
  } else if (pref() === 'web') {
    optedOut = true;
  } else if (CONSOLE_UA.test(navigator.userAgent || '')) {
    setPref('console'); go(); return;
  }

  /* ── DOM-dependent bits: diagnostics, the manual link, the gamepad offer ─── */
  function onReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var CSS = [
    '#pa-console-pill{position:fixed;right:16px;bottom:16px;z-index:2147483000;',
    'display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:999px;',
    'font:600 13px/1 system-ui,"Segoe UI",Arial,sans-serif;color:#dffbe9;text-decoration:none;',
    'background:rgba(16,32,24,.86);border:1px solid rgba(110,231,183,.45);',
    'box-shadow:0 6px 22px rgba(0,0,0,.45);backdrop-filter:blur(6px);cursor:pointer;}',
    '#pa-console-pill:hover{background:rgba(22,52,38,.95);border-color:rgba(110,231,183,.8);}',

    '#pa-console-ask{position:fixed;inset:0;z-index:2147483600;display:flex;',
    'align-items:center;justify-content:center;background:rgba(3,8,6,.82);',
    'font:400 16px/1.5 system-ui,"Segoe UI",Arial,sans-serif;}',
    '#pa-console-ask .box{width:min(680px,88vw);padding:34px 34px 26px;border-radius:18px;',
    'text-align:center;color:#eafff4;background:#0e1a15;border:1px solid rgba(110,231,183,.35);',
    'box-shadow:0 24px 70px rgba(0,0,0,.7);}',
    '#pa-console-ask h2{margin:0 0 10px;font-size:30px;letter-spacing:.4px;}',
    '#pa-console-ask p{margin:0 0 22px;color:#9fd8bf;font-size:17px;}',
    '#pa-console-ask .row{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;}',
    '#pa-console-ask button{font:700 17px/1 system-ui,"Segoe UI",Arial,sans-serif;',
    'padding:14px 26px;border-radius:11px;cursor:pointer;border:1px solid transparent;}',
    '#pa-console-ask .yes{background:#1f7a4d;color:#fff;border-color:#37c98a;}',
    '#pa-console-ask .no{background:transparent;color:#9fd8bf;border-color:rgba(159,216,191,.4);}',
    '#pa-console-ask .cd{margin-top:16px;font-size:13px;color:#6ea78f;letter-spacing:.6px;}',

    '#pa-ua-box{position:fixed;left:12px;top:12px;right:12px;z-index:2147483600;padding:14px 16px;',
    'border-radius:12px;background:#0b1310;color:#cdebdd;border:1px solid rgba(110,231,183,.4);',
    'font:400 13px/1.6 ui-monospace,Consolas,monospace;word-break:break-all;}',
  ].join('');

  function styles() {
    if (document.getElementById('pa-console-css')) return;
    var s = document.createElement('style');
    s.id = 'pa-console-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  /* ── ?ua=1 — read the console's real user agent off the screen ───────────── */
  function uaReadout() {
    styles();
    var pads = [];
    try {
      var gp = navigator.getGamepads ? navigator.getGamepads() : [];
      for (var i = 0; i < gp.length; i++) if (gp[i]) pads.push(gp[i].id + ' [' + gp[i].mapping + ']');
    } catch (e) {}
    var d = document.createElement('div');
    d.id = 'pa-ua-box';
    d.textContent =
      'userAgent: ' + navigator.userAgent +
      '\n\nplatform: ' + (navigator.platform || '?') +
      '   screen: ' + screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1) +
      '\ngamepads: ' + (pads.length ? pads.join(' | ') : 'none yet — press a button') +
      '\nremembered edition: ' + (pref() || 'none');
    d.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(d);
    setInterval(function () {
      try {
        var g = navigator.getGamepads ? navigator.getGamepads() : [], list = [];
        for (var i = 0; i < g.length; i++) if (g[i]) list.push(g[i].id + ' [' + g[i].mapping + ']');
        d.textContent = d.textContent.replace(/\ngamepads: .*/, '\ngamepads: ' + (list.length ? list.join(' | ') : 'none yet — press a button'));
      } catch (e) {}
    }, 1000);
  }

  /* ── Always-available manual link ────────────────────────────────────────── */
  function pill() {
    styles();
    if (document.getElementById('pa-console-pill')) return;
    var a = document.createElement('a');
    a.id = 'pa-console-pill';
    a.href = CONSOLE_PATH;
    a.className = 'pad-skip';
    a.innerHTML = '<span>🎮</span><span>Console Edition</span>';
    document.body.appendChild(a);
  }

  /* ── Gamepad offer ───────────────────────────────────────────────────────── */
  var asked = false;
  function ask() {
    if (asked) return;
    asked = true;
    styles();

    var wrap = document.createElement('div');
    wrap.id = 'pa-console-ask';
    wrap.innerHTML =
      '<div class="box">' +
        '<h2>🎮 Controller detected</h2>' +
        '<p>Pickle Arcade has a Console Edition built for a gamepad and a TV.<br>Want to switch to it?</p>' +
        '<div class="row">' +
          '<button class="yes" id="pa-ask-yes">Open Console Edition&nbsp;&nbsp;(A)</button>' +
          '<button class="no" id="pa-ask-no">Stay on this version&nbsp;&nbsp;(B)</button>' +
        '</div>' +
        '<div class="cd" id="pa-ask-cd"></div>' +
      '</div>';
    document.body.appendChild(wrap);

    var left = COUNTDOWN;
    var cd = document.getElementById('pa-ask-cd');
    function tick() {
      cd.textContent = 'Opening automatically in ' + left + 's…';
      if (left-- <= 0) { clearInterval(timer); accept(); }
    }
    var timer = setInterval(tick, 1000);
    tick();

    function cleanup() {
      clearInterval(timer);
      document.removeEventListener('keydown', onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }
    function accept()  { cleanup(); setPref('console'); go(); }
    function decline() { cleanup(); setPref('web'); optedOut = true; }

    document.getElementById('pa-ask-yes').addEventListener('click', accept);
    document.getElementById('pa-ask-no').addEventListener('click', decline);

    function onKey(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); accept(); }
      else if (e.key === 'Escape') { e.preventDefault(); decline(); }
    }
    document.addEventListener('keydown', onKey, true);

    // A accepts, B declines — read straight off the pad, no library needed.
    var wasA = false, wasB = false;
    (function padLoop() {
      if (!wrap.parentNode) return;
      try {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (var i = 0; i < pads.length; i++) {
          var p = pads[i];
          if (!p || !p.buttons) continue;
          var a = !!(p.buttons[0] && p.buttons[0].pressed);
          var b = !!(p.buttons[1] && p.buttons[1].pressed);
          if (a && !wasA) { accept(); return; }
          if (b && !wasB) { decline(); return; }
          wasA = a; wasB = b;
        }
      } catch (e) {}
      requestAnimationFrame(padLoop);
    })();
  }

  // Polling (not just the gamepadconnected event) is what actually wakes the
  // Gamepad API up in Chromium — the same rAF pattern console-pad.js uses.
  function watchForPad() {
    var start = Date.now();
    (function loop() {
      if (asked || optedOut) return;
      try {
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (var i = 0; i < pads.length; i++) {
          if (pads[i] && pads[i].connected) { ask(); return; }
        }
      } catch (e) {}
      // Give up after 10 minutes so an idle tab isn't polling forever.
      if (Date.now() - start < 600000) requestAnimationFrame(loop);
    })();
    window.addEventListener('gamepadconnected', function () { if (!optedOut) ask(); });
  }

  onReady(function () {
    if (flag('ua')) uaReadout();
    pill();
    if (!optedOut) watchForPad();
  });
})();
