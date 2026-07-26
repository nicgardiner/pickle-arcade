/* ──────────────────────────────────────────────────────────────────────────
 * console-pad.js — shared Gamepad helper for the Pickle Arcade CONSOLE build.
 *
 * Loaded into the arcade shell AND every game (right after console-sdk.js).
 * Wraps the standard W3C Gamepad API ("standard" mapping — Xbox controllers
 * in Edge/Chrome report this) and provides:
 *
 *   window.Pad — polling + edge events
 *     Pad.connected            → bool
 *     Pad.pressed(name)        → bool                (held right now)
 *     Pad.axis('lx'|'ly'|'rx'|'ry') → -1..1          (deadzone applied)
 *     Pad.axisRaw(name)        → -1..1               (no deadzone)
 *     Pad.onPress(fn) / Pad.offPress(fn)             fn(name)  — edge down
 *     Pad.onRelease(fn) / Pad.offRelease(fn)         fn(name)  — edge up
 *     Pad.onNav(fn) / Pad.offNav(fn)                 fn('up'|'down'|'left'|'right')
 *         — d-pad OR left-stick flicks, with hold auto-repeat. Use for menus.
 *     Pad.rumble(ms, strong, weak)                   best-effort vibration
 *
 *   Button names: a b x y lb rb lt rt view menu l3 r3 up down left right
 *   (lt/rt fire as buttons at >0.5 pull; analog value via Pad.trigger('lt'))
 *
 *   Events are also dispatched on window as CustomEvents:
 *     'padpress' / 'padrelease' / 'padnav'  with e.detail.btn
 *     'padconnect' / 'paddisconnect'
 *
 *   window.PadNav — spatial DOM menu navigator (for HTML menus/dialogs)
 *     PadNav.start(opts?)  — d-pad/left stick moves a focus ring between
 *        visible interactive elements; A "clicks" the focused one; B clicks
 *        the nearest [data-pad-back] element if one is visible.
 *        opts.selector — override the default interactive-element selector
 *        opts.onBack   — function called on B when no [data-pad-back] visible
 *     PadNav.stop() / PadNav.pause(bool) — suspend while gameplay owns the pad
 *     PadNav.refresh() — rescan now (also auto-rescans on DOM mutations)
 *     Skip elements with class "pad-skip"; force-include with [data-pad].
 *
 *   window.PadGlyph(name) → HTML string for an Xbox button glyph, e.g.
 *     PadGlyph('A')  PadGlyph('B')  PadGlyph('X')  PadGlyph('Y')
 *     PadGlyph('LT') PadGlyph('RT') PadGlyph('LB') PadGlyph('RB')
 *     PadGlyph('LS') PadGlyph('RS') PadGlyph('L3') PadGlyph('R3')
 *     PadGlyph('DPAD') PadGlyph('MENU') PadGlyph('VIEW')
 *   Rendered as styled inline badges (CSS is injected by this file).
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.Pad) return; // double-include guard

  const NAMES = ['a','b','x','y','lb','rb','lt','rt','view','menu','l3','r3','up','down','left','right'];
  const DEAD = 0.25;
  const TRIG_ON = 0.5;

  const held = Object.create(null);
  const axes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  const rawAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
  const trig = { lt: 0, rt: 0 };
  let padIndex = -1;
  let connected = false;

  const pressCbs = [], releaseCbs = [], navCbs = [];
  function fire(list, name) { for (let i = 0; i < list.length; i++) { try { list[i](name); } catch (e) {} } }
  function evt(type, btn) { try { window.dispatchEvent(new CustomEvent(type, { detail: { btn: btn } })); } catch (e) {} }

  function dz(v) { return Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD); }

  // ── nav (d-pad + left stick) auto-repeat ─────────────────────────────────
  const NAV_FIRST = 400, NAV_REPEAT = 150, STICK_ON = 0.55, STICK_OFF = 0.4;
  const navHeld = { up: 0, down: 0, left: 0, right: 0 };   // 0=off else next-fire time
  const stickDir = { up: false, down: false, left: false, right: false };

  function navSet(dir, on, now) {
    if (on && !navHeld[dir]) {
      navHeld[dir] = now + NAV_FIRST;
      fire(navCbs, dir); evt('padnav', dir);
    } else if (!on && navHeld[dir]) {
      navHeld[dir] = 0;
    } else if (on && navHeld[dir] && now >= navHeld[dir]) {
      navHeld[dir] = now + NAV_REPEAT;
      fire(navCbs, dir); evt('padnav', dir);
    }
  }

  function pickPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (padIndex >= 0 && pads[padIndex] && pads[padIndex].connected) return pads[padIndex];
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { padIndex = i; return pads[i]; }
    }
    padIndex = -1;
    return null;
  }

  function poll() {
    const gp = pickPad();
    const now = performance.now();

    if (!gp) {
      if (connected) { connected = false; evt('paddisconnect', null); }
      for (const n of NAMES) if (held[n]) { held[n] = false; fire(releaseCbs, n); evt('padrelease', n); }
      axes.lx = axes.ly = axes.rx = axes.ry = 0;
      rawAxes.lx = rawAxes.ly = rawAxes.rx = rawAxes.ry = 0;
      trig.lt = trig.rt = 0;
      navSet('up', false, now); navSet('down', false, now);
      navSet('left', false, now); navSet('right', false, now);
      requestAnimationFrame(poll);
      return;
    }
    if (!connected) { connected = true; evt('padconnect', null); }

    rawAxes.lx = gp.axes[0] || 0; rawAxes.ly = gp.axes[1] || 0;
    rawAxes.rx = gp.axes[2] || 0; rawAxes.ry = gp.axes[3] || 0;
    axes.lx = dz(rawAxes.lx); axes.ly = dz(rawAxes.ly);
    axes.rx = dz(rawAxes.rx); axes.ry = dz(rawAxes.ry);

    const b = gp.buttons;
    function bv(i) { return b[i] ? (typeof b[i].value === 'number' ? b[i].value : (b[i].pressed ? 1 : 0)) : 0; }
    trig.lt = bv(6); trig.rt = bv(7);

    const down = {
      a: !!(b[0] && b[0].pressed), b: !!(b[1] && b[1].pressed),
      x: !!(b[2] && b[2].pressed), y: !!(b[3] && b[3].pressed),
      lb: !!(b[4] && b[4].pressed), rb: !!(b[5] && b[5].pressed),
      lt: trig.lt > TRIG_ON, rt: trig.rt > TRIG_ON,
      view: !!(b[8] && b[8].pressed), menu: !!(b[9] && b[9].pressed),
      l3: !!(b[10] && b[10].pressed), r3: !!(b[11] && b[11].pressed),
      up: !!(b[12] && b[12].pressed), down: !!(b[13] && b[13].pressed),
      left: !!(b[14] && b[14].pressed), right: !!(b[15] && b[15].pressed),
    };

    for (const n of NAMES) {
      if (down[n] && !held[n]) { held[n] = true; fire(pressCbs, n); evt('padpress', n); }
      else if (!down[n] && held[n]) { held[n] = false; fire(releaseCbs, n); evt('padrelease', n); }
    }

    // nav = d-pad OR left stick (with hysteresis)
    stickDir.up    = stickDir.up    ? rawAxes.ly < -STICK_OFF : rawAxes.ly < -STICK_ON;
    stickDir.down  = stickDir.down  ? rawAxes.ly >  STICK_OFF : rawAxes.ly >  STICK_ON;
    stickDir.left  = stickDir.left  ? rawAxes.lx < -STICK_OFF : rawAxes.lx < -STICK_ON;
    stickDir.right = stickDir.right ? rawAxes.lx >  STICK_OFF : rawAxes.lx >  STICK_ON;
    navSet('up',    down.up    || stickDir.up,    now);
    navSet('down',  down.down  || stickDir.down,  now);
    navSet('left',  down.left  || stickDir.left,  now);
    navSet('right', down.right || stickDir.right, now);

    requestAnimationFrame(poll);
  }
  requestAnimationFrame(poll);

  window.Pad = {
    get connected() { return connected; },
    pressed(n) { return !!held[n]; },
    axis(n) { return axes[n] || 0; },
    axisRaw(n) { return rawAxes[n] || 0; },
    trigger(n) { return trig[n] || 0; },
    onPress(fn) { pressCbs.push(fn); }, offPress(fn) { const i = pressCbs.indexOf(fn); if (i >= 0) pressCbs.splice(i, 1); },
    onRelease(fn) { releaseCbs.push(fn); }, offRelease(fn) { const i = releaseCbs.indexOf(fn); if (i >= 0) releaseCbs.splice(i, 1); },
    onNav(fn) { navCbs.push(fn); }, offNav(fn) { const i = navCbs.indexOf(fn); if (i >= 0) navCbs.splice(i, 1); },
    rumble(ms, strong, weak) {
      try {
        const gp = pickPad();
        const act = gp && (gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]));
        if (act && act.playEffect) {
          act.playEffect('dual-rumble', { duration: ms || 120, strongMagnitude: strong == null ? 0.6 : strong, weakMagnitude: weak == null ? 0.4 : weak });
        }
      } catch (e) {}
    },
  };

  /* ── Xbox button glyphs ──────────────────────────────────────────────────── */
  const GLYPH_CSS = [
    '.xbtn{display:inline-flex;align-items:center;justify-content:center;vertical-align:-0.18em;',
    'min-width:1.5em;height:1.5em;padding:0 .18em;border-radius:50%;font-family:"Segoe UI",Arial,sans-serif;',
    'font-size:.85em;font-weight:800;color:#fff;background:#333;border:.09em solid rgba(255,255,255,.55);',
    'box-shadow:0 .1em .25em rgba(0,0,0,.55),inset 0 -0.15em .2em rgba(0,0,0,.35);line-height:1;margin:0 .12em;}',
    '.xbtn-a{background:#1f7a1f;}.xbtn-b{background:#c22a2a;}.xbtn-x{background:#2a5fc2;}.xbtn-y{background:#c2a12a;color:#221;}',
    '.xbtn-pill{border-radius:.65em;min-width:2.2em;font-size:.78em;background:#3a3a44;}',
    '.xbtn-stick{background:#2c2c34;border-radius:50%;}',
    '.xbtn-flat{background:#3a3a44;border-radius:.3em;min-width:1.5em;}',
  ].join('');
  const GLYPHS = {
    A:    '<span class="xbtn xbtn-a">A</span>',
    B:    '<span class="xbtn xbtn-b">B</span>',
    X:    '<span class="xbtn xbtn-x">X</span>',
    Y:    '<span class="xbtn xbtn-y">Y</span>',
    LB:   '<span class="xbtn xbtn-pill">LB</span>',
    RB:   '<span class="xbtn xbtn-pill">RB</span>',
    LT:   '<span class="xbtn xbtn-pill">LT</span>',
    RT:   '<span class="xbtn xbtn-pill">RT</span>',
    LS:   '<span class="xbtn xbtn-stick">⬤L</span>',
    RS:   '<span class="xbtn xbtn-stick">⬤R</span>',
    L3:   '<span class="xbtn xbtn-stick">L3</span>',
    R3:   '<span class="xbtn xbtn-stick">R3</span>',
    DPAD: '<span class="xbtn xbtn-flat">✚</span>',
    MENU: '<span class="xbtn xbtn-flat">☰</span>',
    VIEW: '<span class="xbtn xbtn-flat">⧉</span>',
  };
  function injectCss(css) {
    const s = document.createElement('style');
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }
  if (document.head) injectCss(GLYPH_CSS);
  else document.addEventListener('DOMContentLoaded', () => injectCss(GLYPH_CSS));
  window.PadGlyph = function (name) { return GLYPHS[String(name).toUpperCase()] || ''; };

  /* ── PadNav: spatial navigator for DOM menus ─────────────────────────────── */
  const NAV_CSS = [
    '.pad-focus{outline:3px solid #6ee7b7 !important;outline-offset:3px;border-radius:6px;',
    'box-shadow:0 0 0 6px rgba(16,185,129,.25),0 0 22px rgba(16,185,129,.55) !important;',
    'transition:box-shadow .12s;z-index:2;}',
  ].join('');
  if (document.head) injectCss(NAV_CSS);
  else document.addEventListener('DOMContentLoaded', () => injectCss(NAV_CSS));

  const DEFAULT_SEL = 'button, a[href], input, select, textarea, [data-pad], [role="button"], [onclick]';
  let navOn = false, navPaused = false, current = null, selector = DEFAULT_SEL, onBackFn = null;
  let observer = null;

  function visible(el) {
    if (!el || el.classList.contains('pad-skip') || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) === 0 || st.pointerEvents === 'none') return false;
    // any hidden ancestor?
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = getComputedStyle(p);
      if (ps.visibility === 'hidden' || ps.display === 'none' || parseFloat(ps.opacity) === 0) return false;
      p = p.parentElement;
    }
    // topmost check at center — element inside a covered/backgrounded layer loses
    const cx = Math.max(1, Math.min(innerWidth - 1, r.left + r.width / 2));
    const cy = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
    const top = document.elementFromPoint(cx, cy);
    if (top && (top === el || el.contains(top) || top.contains(el))) return true;
    return false;
  }

  function candidates() {
    const els = Array.prototype.slice.call(document.querySelectorAll(selector));
    return els.filter(visible);
  }

  function setFocus(el) {
    if (current === el) return;
    if (current) current.classList.remove('pad-focus');
    current = el || null;
    if (current) {
      current.classList.add('pad-focus');
      try { current.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }
  }

  function ensureFocus() {
    if (!navOn || navPaused) return;
    if (current && visible(current)) return;
    const c = candidates();
    setFocus(c.length ? c[0] : null);
  }

  function move(dir) {
    const c = candidates();
    if (!c.length) { setFocus(null); return; }
    if (!current || !visible(current)) { setFocus(c[0]); return; }
    const cr = current.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    let best = null, bestScore = Infinity;
    for (const el of c) {
      if (el === current) continue;
      const r = el.getBoundingClientRect();
      const ex = r.left + r.width / 2, ey = r.top + r.height / 2;
      const dx = ex - cx, dy = ey - cy;
      let fwd, side;
      if (dir === 'up')    { fwd = -dy; side = Math.abs(dx); }
      if (dir === 'down')  { fwd =  dy; side = Math.abs(dx); }
      if (dir === 'left')  { fwd = -dx; side = Math.abs(dy); }
      if (dir === 'right') { fwd =  dx; side = Math.abs(dy); }
      if (fwd < 4) continue; // must actually be in that direction
      const score = fwd + side * 2.2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) setFocus(best);
  }

  function activate(el) {
    if (!el) return;
    const tag = el.tagName;
    if (tag === 'INPUT' && (el.type === 'text' || el.type === 'password' || el.type === 'search' || el.type === 'number') || tag === 'TEXTAREA') {
      el.focus(); // brings up the console virtual keyboard
      return;
    }
    el.focus && el.focus();
    el.click();
  }

  function navHandler(dir) {
    if (!navOn || navPaused) return;
    move(dir);
  }
  function pressHandler(btn) {
    if (!navOn || navPaused) return;
    if (btn === 'a') { ensureFocus(); activate(current); }
    else if (btn === 'b') {
      // blur a focused text field first so B = "done typing"
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) { ae.blur(); return; }
      const backs = Array.prototype.slice.call(document.querySelectorAll('[data-pad-back]')).filter(visible);
      if (backs.length) activate(backs[backs.length - 1]);
      else if (onBackFn) { try { onBackFn(); } catch (e) {} }
    }
  }

  let scanTimer = 0;
  window.PadNav = {
    start(opts) {
      opts = opts || {};
      selector = opts.selector || DEFAULT_SEL;
      onBackFn = opts.onBack || null;
      if (navOn) { this.refresh(); return; }
      navOn = true; navPaused = false;
      window.Pad.onNav(navHandler);
      window.Pad.onPress(pressHandler);
      observer = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(ensureFocus, 60);
      });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'disabled'] });
      ensureFocus();
    },
    stop() {
      if (!navOn) return;
      navOn = false;
      clearTimeout(scanTimer);
      window.Pad.offNav(navHandler);
      window.Pad.offPress(pressHandler);
      if (observer) { observer.disconnect(); observer = null; }
      setFocus(null);
    },
    pause(v) { navPaused = !!v; if (!navPaused) ensureFocus(); },
    get paused() { return navPaused; },
    get active() { return navOn && !navPaused; },
    refresh() { ensureFocus(); },
    focus(el) { setFocus(el); },
    get current() { return current; },
    // Manual drivers — used by the shell's keyboard fallback (arrows/Enter/Esc)
    move(dir) { if (navOn && !navPaused) move(dir); },
    press(btn) { pressHandler(btn); },
  };
})();
