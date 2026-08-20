// What changed, who changed it, and how to take it back.
//
// The edit is data, so a change to it can be described rather than merely undone. That matters
// here more than in a normal editor: an agent can rewrite forty things in one pass, and "undo"
// as a single step would either throw all forty away or none. So this works at the level of
// ELEMENTS — this cut, that caption — and every entry in the history can be reverted whole or
// picked apart.
//
// Reverting is not a rollback. It applies the inverse of one entry to the CURRENT project, so
// work done afterwards survives. Where that is impossible — the element is already gone, or
// somebody has since changed it — it says so instead of guessing.

const LISTS = [
  ['cuts', 'cut'], ['zooms', 'zoom'], ['frames', 'framing move'],
  ['scenes', 'panel'], ['overlays', 'overlay'],
];
const AUDIO = [['music', 'music'], ['sfx', 'sound effect']];

const num = (v) => (Number.isFinite(+v) ? +v : 0);
const r2 = (v) => Math.round(num(v) * 100) / 100;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const cueText = (c) => (c?.tokens || []).map((t) => t.t).join(' ');

// Identity has to survive reordering, because an agent reorders. An id when there is one;
// otherwise the thing about the element that does not change when it is edited.
const idOf = (kind, el, i) => {
  if (kind === 'captions') return `t${r2(el.start)}|${cueText(el).slice(0, 40)}`;
  if (el?.id) return String(el.id);
  return `${kind}@${r2(el?.start)}#${i}`;
};

function collect(project) {
  const out = new Map();                                  // "kind:id" -> {kind, id, el, at}
  const put = (kind, arr) => (arr || []).forEach((el, i) => {
    if (!el || typeof el !== 'object') return;
    const id = idOf(kind, el, i);
    out.set(`${kind}:${id}`, { kind, id, el, at: num(el.start) });
  });
  for (const [kind] of LISTS) put(kind, project?.[kind]);
  put('captions', project?.captions?.cues);
  for (const [k] of AUDIO) put(`audio.${k}`, project?.audio?.[k]);
  return out;
}

const LABEL = Object.fromEntries([...LISTS, ...AUDIO.map(([k, l]) => [`audio.${k}`, l]), ['captions', 'caption']]);

// A phrase a person can read in a list, without opening anything.
export function describe(kind, el) {
  const t = (v) => `${Math.floor(num(v) / 60)}:${String(Math.floor(num(v) % 60)).padStart(2, '0')}`;
  if (kind === 'captions') return `“${cueText(el).slice(0, 34) || '(empty)'}”`;
  if (kind === 'cuts') return `${t(el.start)}–${t(el.end)}`;
  if (kind === 'scenes') return `${el.type || 'panel'} at ${t(el.start)}`;
  if (kind === 'zooms') return `${(+el.scale || 1.3).toFixed(2)}× at ${t(el.start)}`;
  if (kind === 'frames') return `to ${el.to || 'full'} at ${t(el.start)}`;
  if (String(kind).startsWith('audio.')) return `${(el.src || '').split('/').pop() || 'clip'} at ${t(el.start)}`;
  return `at ${t(el.start)}`;
}

// Which fields actually moved, so "changed" can say what it changed.
function fieldsChanged(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((k) => k !== 'id' && !same(a?.[k], b?.[k]));
}

export function diff(before, after) {
  const A = collect(before), B = collect(after);
  const changes = [];

  for (const [key, cur] of B) {
    const was = A.get(key);
    if (!was) {
      changes.push({ kind: cur.kind, id: cur.id, op: 'add', at: cur.at,
                     before: null, after: cur.el, what: describe(cur.kind, cur.el) });
    } else if (!same(was.el, cur.el)) {
      changes.push({ kind: cur.kind, id: cur.id, op: 'change', at: cur.at,
                     before: was.el, after: cur.el, what: describe(cur.kind, cur.el),
                     fields: fieldsChanged(was.el, cur.el) });
    }
  }
  for (const [key, was] of A) {
    if (!B.has(key)) {
      changes.push({ kind: was.kind, id: was.id, op: 'remove', at: was.at,
                     before: was.el, after: null, what: describe(was.kind, was.el) });
    }
  }

  changes.sort((x, y) => x.at - y.at);
  return { changes, summary: summarise(changes) };
}

export function summarise(changes) {
  if (!changes.length) return 'no change';
  const counts = new Map();
  for (const c of changes) {
    const key = `${c.op}|${c.kind}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const verb = { add: 'added', remove: 'removed', change: 'changed' };
  return [...counts.entries()]
    .map(([key, n]) => {
      const [op, kind] = key.split('|');
      const one = LABEL[kind] || kind;
      return `${verb[op]} ${n} ${n === 1 ? one : one + 's'}`;
    })
    .join(' · ');
}

export const invert = (c) => ({
  ...c,
  op: c.op === 'add' ? 'remove' : c.op === 'remove' ? 'add' : 'change',
  before: c.after, after: c.before,
});

function listFor(project, kind) {
  if (kind === 'captions') {
    project.captions = project.captions || { cues: [] };
    return (project.captions.cues = project.captions.cues || []);
  }
  if (String(kind).startsWith('audio.')) {
    const k = kind.slice(6);
    project.audio = project.audio || {};
    return (project.audio[k] = project.audio[k] || []);
  }
  return (project[kind] = project[kind] || []);
}

// Apply a set of changes to a project as it is NOW. Returns what it managed and what it would
// not do — never a partial element, never a guess.
export function apply(project, changes, { force = false } = {}) {
  const applied = [], conflicts = [];
  for (const c of changes) {
    const list = listFor(project, c.kind);
    const at = list.findIndex((el, i) => idOf(c.kind, el, i) === c.id);

    if (c.op === 'add') {
      if (at >= 0) { conflicts.push({ change: c, why: 'it is already there' }); continue; }
      list.push(JSON.parse(JSON.stringify(c.after)));
      list.sort((x, y) => num(x.start) - num(y.start));
      applied.push(c);
    } else if (c.op === 'remove') {
      if (at < 0) { conflicts.push({ change: c, why: 'it is already gone' }); continue; }
      list.splice(at, 1);
      applied.push(c);
    } else {
      if (at < 0) { conflicts.push({ change: c, why: 'it is not in the project any more' }); continue; }
      // Somebody has touched it since this entry was recorded; putting the old value back would
      // throw their work away without saying so.
      if (!force && !same(list[at], c.before)) {
        conflicts.push({ change: c, why: 'it has been changed since' }); continue;
      }
      list[at] = JSON.parse(JSON.stringify(c.after));
      list.sort((x, y) => num(x.start) - num(y.start));
      applied.push(c);
    }
  }
  return { applied, conflicts };
}

export const _internals = { collect, idOf, LABEL, same };
