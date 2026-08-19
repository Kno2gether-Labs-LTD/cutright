// Timeline time vs media time.
//
// Everything the editor shows — the ruler, every element's start, "set start = playhead" — is in
// ORIGINAL time: where it sits in the footage you recorded. That is the only clock the user
// thinks in, and the only one project.json stores.
//
// The player does not always show original time. A preview render has the cuts taken out, so a
// clip that reads 40s on the timeline is at 34s in that file if six seconds were removed before
// it. Mixing the two up is how a playhead ends up lying about where it is, so the conversion
// lives here, in one place, with a test.
//
// This mirrors `make_remap` in engine/render_project.py deliberately. If the two disagree the
// playhead drifts against the picture, so they are kept to the same rule: a cut removes
// [start, end), and time after it slides earlier by the length removed.
(function (root) {
  'use strict';

  // Overlapping or out-of-order cuts are not a user error worth refusing — they happen when two
  // proposals are accepted that touch. Merge them, because the removed span is what matters.
  // A cut that carries a transition costs more than the span it removes: an xfade of `tdur`
  // seconds overlaps the two sides, so everything after the seam slides a further `tdur` earlier.
  // engine/render_project.py treats "", "none" and "hard" as no transition; match that exactly.
  const xdurOf = (c) => {
    const name = String(c.transition || '').toLowerCase();
    if (name === '' || name === 'none' || name === 'hard') return 0;
    return Math.max(0, +c.tdur || 0.3);
  };

  function normalise(cuts, dur) {
    const out = [];
    (cuts || [])
      .map((c) => [Math.max(0, +c.start || 0), Math.min(dur, +c.end || 0), xdurOf(c)])
      .filter(([a, b]) => b > a)
      .sort((p, q) => p[0] - q[0])
      .forEach(([a, b, x]) => {
        const last = out[out.length - 1];
        // Merging keeps the larger overlap: two touching cuts collapse to one seam.
        if (last && a <= last[1]) { last[1] = Math.max(last[1], b); last[2] = Math.max(last[2], x); }
        else out.push([a, b, x]);
      });
    return out;
  }

  function makeCutMap(cuts, dur) {
    const spans = normalise(cuts, dur || 0);
    const removed = spans.reduce((n, [a, b, x]) => n + (b - a) + x, 0);

    // Original time → time in a render with the cuts applied. A moment inside a cut does not
    // exist in that render, so it collapses onto the join — which is where playback resumes.
    const toMedia = (t) => {
      let out = t;
      for (const [a, b, x] of spans) {
        if (t >= b) out -= (b - a) + x;
        else if (t > a) { out -= (t - a); break; }
        else break;
      }
      return Math.max(0, out);
    };

    // …and back, for showing where the playhead is while a cut-applied render plays.
    const toTimeline = (m) => {
      let out = m;
      for (const [a, b, x] of spans) {
        if (out >= a) out += (b - a) + x; else break;
      }
      return out;
    };

    const cutAt = (t) => spans.find(([a, b]) => t >= a && t < b) || null;

    return {
      spans, removed,
      duration: Math.max(0, (dur || 0) - removed),
      toMedia, toTimeline,
      inCut: (t) => !!cutAt(t),
      // Where playback should continue from when it wanders into a removed span. Null when the
      // cut runs to the end — there is nothing after it to jump to.
      skipTo: (t) => { const c = cutAt(t); return c ? (c[1] >= (dur || 0) ? null : c[1]) : null; },
    };
  }

  root.TimeMap = { makeCutMap, normalise };
})(typeof window !== 'undefined' ? window : globalThis);
