// Protecting the edits a person made by hand.
//
// The agent rewrites project.json. That is the whole point of it — but it means a section you
// cut yourself, or a zoom you placed, can quietly not be there any more when the render comes
// out. You would not notice until you watched the finished video, which is the worst possible
// moment to find out.
//
// Advice does not solve this. Telling the agent "do not remove the user's edits" in the brief
// helps and is worth doing, but it is not a guarantee, and the thing being protected is somebody's
// afternoon. So this is a check with teeth:
//
//   1. anything edited by hand in the UI is stamped `manual: true` and given an id
//   2. before the agent is handed the project, a snapshot of those is written beside it
//   3. afterwards the two are compared — by id, not by position, because everything moves
//   4. whatever went missing can be put back
//
// The comparison is deliberately narrow. The agent is *supposed* to add, restyle, re-time and
// rewrite; complaining about all of that would make the check noise, and a noisy check gets
// ignored. It only reports a manual element that has VANISHED, or that has been moved far enough
// that it is no longer doing the job it was placed to do.

const LISTS = ['cuts', 'zooms', 'frames', 'scenes', 'overlays'];

// Position is not identity: the agent inserts and reorders. An id is, so manual items get one.
export function ensureId(el, kind, i) {
  if (!el.id) el.id = `${kind[0]}${Date.now().toString(36)}${i}${Math.floor(Math.random() * 1e4).toString(36)}`;
  return el.id;
}

// Captions are the exception: there can be hundreds, they are generated from the transcript, and
// giving every one an id would bloat the file. A hand-edited cue is identified by when it starts
// and what it says, which is stable enough — the agent may restyle a cue but rarely rewrites it.
const cueKey = (c) => `${(+c.start || 0).toFixed(2)}|${(c.tokens || []).map((t) => t.t).join(' ').slice(0, 40)}`;

export function snapshot(project) {
  const out = { at: new Date().toISOString(), lists: {}, captions: [] };
  for (const kind of LISTS) {
    out.lists[kind] = (project?.[kind] || [])
      .filter((el) => el && el.manual)
      .map((el) => ({ ...el }));
  }
  out.captions = (project?.captions?.cues || [])
    .filter((c) => c && c.manual)
    .map((c) => ({ key: cueKey(c), start: c.start, end: c.end,
                   cy: c.overrides?.cy ?? null, fontsize: c.overrides?.fontsize ?? null,
                   text: (c.tokens || []).map((t) => t.t).join(' ') }));
  out.count = Object.values(out.lists).reduce((n, a) => n + a.length, 0) + out.captions.length;
  return out;
}

// How far something may drift before it is no longer the edit that was made. A cut is the strict
// one: half a second either way and it is removing different words.
const TOLERANCE = { cuts: 0.25, zooms: 1.0, frames: 1.0, scenes: 1.5, overlays: 1.5 };

export function diff(before, project) {
  const missing = [];
  const moved = [];
  if (!before) return { missing, moved, checked: 0 };

  for (const kind of LISTS) {
    const now = project?.[kind] || [];
    for (const was of before.lists?.[kind] || []) {
      const still = now.find((el) => el && el.id === was.id);
      if (!still) { missing.push({ kind, item: was, why: 'it is not in the project any more' }); continue; }
      const drift = Math.abs((+still.start || 0) - (+was.start || 0));
      const tol = TOLERANCE[kind] ?? 1.0;
      if (drift > tol) {
        moved.push({ kind, item: was, now: still, drift: +drift.toFixed(2),
                     why: `it moved ${drift.toFixed(2)}s, past the ${tol}s this kind is allowed` });
      }
      // A cut that survived but no longer removes the same span is a missing cut wearing its name.
      if (kind === 'cuts' && Math.abs((+still.end || 0) - (+was.end || 0)) > tol) {
        moved.push({ kind, item: was, now: still, drift: +Math.abs((+still.end || 0) - (+was.end || 0)).toFixed(2),
                     why: 'it still exists but no longer removes the same span' });
      }
    }
  }

  const cues = project?.captions?.cues || [];
  for (const was of before.captions || []) {
    const still = cues.find((c) => cueKey(c) === was.key);
    if (!still) { missing.push({ kind: 'captions', item: was, why: 'that cue is gone' }); continue; }
    const cy = still.overrides?.cy ?? null, fs = still.overrides?.fontsize ?? null;
    if ((was.cy != null && cy !== was.cy) || (was.fontsize != null && fs !== was.fontsize)) {
      moved.push({ kind: 'captions', item: was, now: { cy, fontsize: fs },
                   why: 'the height or size you set was overwritten' });
    }
  }

  return { missing, moved, checked: before.count || 0 };
}

// Put back what vanished. Restoring is additive and idempotent: an item already present by id is
// left exactly as it is, so this can be run twice without doubling anything up.
export function restore(project, before) {
  let put = 0;
  for (const kind of LISTS) {
    const now = (project[kind] = project[kind] || []);
    for (const was of before?.lists?.[kind] || []) {
      if (now.some((el) => el && el.id === was.id)) continue;
      now.push({ ...was });
      put++;
    }
    now.sort((a, b) => (+a.start || 0) - (+b.start || 0));
  }
  const cues = project?.captions?.cues || [];
  for (const was of before?.captions || []) {
    const still = cues.find((c) => cueKey(c) === was.key);
    if (!still) continue;                      // the cue itself is gone; the transcript owns those
    still.overrides = still.overrides || {};
    if (was.cy != null) still.overrides.cy = was.cy;
    if (was.fontsize != null) still.overrides.fontsize = was.fontsize;
    still.manual = true;
    put++;
  }
  return put;
}

export const _internals = { cueKey, LISTS, TOLERANCE };
