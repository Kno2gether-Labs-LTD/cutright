// Panels you can resize, and that remember how you left them.
//
// An editor is somewhere people sit for hours, and everyone works differently: one person wants
// the timeline tall and the terminal a sliver, the next wants the opposite. Sizes that reset on
// every launch are a small insult repeated daily, so this persists them.
//
// Splitters are declared in the markup rather than wired up one at a time in code:
//
//   <div class="vsplit" data-panel="rail" data-target="#rail"
//        data-axis="x" data-min="260" data-reserve="520"></div>
//
//   data-panel    the name it is remembered under
//   data-target   what actually changes size
//   data-axis     x resizes width, y resizes height
//   data-min      never smaller than this
//   data-reserve  leave at least this much for everything else, so a panel cannot be dragged
//                 wide enough to swallow the thing it sits next to
//
// Which way the drag goes is worked out from the DOM, not configured: a panel AFTER its splitter
// grows when you drag towards the start, one BEFORE it grows when you drag towards the end.
// Getting that backwards is the classic resizer bug and it should not be something a caller can
// get wrong.
(function (root, doc) {
  'use strict';

  const KEY = (name) => `cutright.layout.${name}`;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const px = (v) => Math.round(v) + 'px';

  const read = (name) => {
    try { const v = parseFloat(localStorage.getItem(KEY(name))); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  };
  const write = (name, v) => { try { localStorage.setItem(KEY(name), String(Math.round(v))); } catch {} };
  const forget = (name) => { try { localStorage.removeItem(KEY(name)); } catch {} };

  const panels = [];

  function spec(handle) {
    const target = doc.querySelector(handle.dataset.target);
    if (!target) return null;
    const axis = handle.dataset.axis === 'y' ? 'y' : 'x';
    // Does the panel sit after the handle, or before it?
    const after = !!(handle.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      handle, target, axis, after,
      name: handle.dataset.panel,
      min: parseFloat(handle.dataset.min) || 80,
      reserve: parseFloat(handle.dataset.reserve) || 200,
      size: () => (axis === 'x' ? target.getBoundingClientRect().width : target.getBoundingClientRect().height),
      // The most this panel may take: whatever its container has, less what must stay for the rest.
      max: () => {
        const box = target.parentElement?.getBoundingClientRect();
        const whole = axis === 'x' ? (box?.width || root.innerWidth) : (box?.height || root.innerHeight);
        return Math.max(parseFloat(handle.dataset.min) || 80, whole - (parseFloat(handle.dataset.reserve) || 200));
      },
      apply(v) {
        const val = clamp(v, this.min, this.max());
        target.style[axis === 'x' ? 'width' : 'height'] = px(val);
        // flex-basis matters when the panel lives in a flex row and has flex:1 — without it the
        // width is advisory and the drag appears to do nothing.
        if (axis === 'x') target.style.flex = '0 0 ' + px(val);
        return val;
      },
    };
  }

  function announce(name) {
    root.dispatchEvent(new CustomEvent('layout:resize', { detail: { panel: name } }));
  }

  function attach(handle) {
    const s = spec(handle);
    if (!s || !s.name) return;
    panels.push(s);

    // Reachable without a mouse, and it says what it is to a screen reader.
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', s.axis === 'x' ? 'vertical' : 'horizontal');
    handle.setAttribute('tabindex', '0');
    if (!handle.title) handle.title = 'Drag to resize · double-click to reset · arrow keys when focused';

    const saved = read(s.name);
    if (saved != null) s.apply(saved);

    let dragging = false;
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      dragging = true;
      // Capture keeps the drag alive when the pointer leaves the 6px handle, but it is a
      // nicety: setPointerCapture throws for an unknown pointerId, and letting that escape
      // would abort the handler before the move listener is registered — a resize that does
      // nothing at all, for a convenience.
      try { handle.setPointerCapture?.(ev.pointerId); } catch { /* drag without capture */ }
      doc.body.classList.add(s.axis === 'x' ? 'resizing-x' : 'resizing-y');
      let last = s.axis === 'x' ? ev.clientX : ev.clientY;
      const move = (e) => {
        const now = s.axis === 'x' ? e.clientX : e.clientY;
        const delta = s.after ? last - now : now - last;
        last = now;
        s.apply(s.size() + delta);
        announce(s.name);
      };
      const up = () => {
        dragging = false;
        doc.body.classList.remove('resizing-x', 'resizing-y');
        root.removeEventListener('pointermove', move);
        root.removeEventListener('pointerup', up);
        write(s.name, s.size());
        announce(s.name);
      };
      root.addEventListener('pointermove', move);
      root.addEventListener('pointerup', up);
    });

    // Double-click puts it back to whatever the stylesheet says, which is the quickest way out of
    // a layout you have dragged into a mess.
    handle.addEventListener('dblclick', () => {
      s.target.style.removeProperty(s.axis === 'x' ? 'width' : 'height');
      s.target.style.removeProperty('flex');
      forget(s.name);
      announce(s.name);
    });

    handle.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 40 : 12;
      const grow = s.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      const shrink = s.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      if (ev.key !== grow && ev.key !== shrink) return;
      ev.preventDefault();
      const dir = (ev.key === grow ? 1 : -1) * (s.after ? -1 : 1);
      write(s.name, s.apply(s.size() + dir * step));
      announce(s.name);
    });
  }

  // A window that got smaller must not leave a panel wider than the room it is in.
  function reclamp() {
    for (const s of panels) {
      const now = s.size();
      const want = clamp(now, s.min, s.max());
      if (Math.abs(want - now) > 0.5) { s.apply(want); announce(s.name); }
    }
  }

  root.Panels = {
    init() {
      doc.querySelectorAll('[data-panel][data-target]').forEach(attach);
      root.addEventListener('resize', reclamp);
      return panels.length;
    },
    reset(name) {
      for (const s of panels) {
        if (name && s.name !== name) continue;
        s.target.style.removeProperty(s.axis === 'x' ? 'width' : 'height');
        s.target.style.removeProperty('flex');
        forget(s.name);
        announce(s.name);
      }
    },
    resetAll() { root.Panels.reset(null); },
    sizes() { return Object.fromEntries(panels.map((s) => [s.name, Math.round(s.size())])); },
    _internals: { KEY, clamp, read, write },
  };
})(typeof window !== 'undefined' ? window : globalThis, typeof document !== 'undefined' ? document : null);
