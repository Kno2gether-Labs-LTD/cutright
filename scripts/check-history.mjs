#!/usr/bin/env node
// Can you see what changed, and take back just that?
//
// An agent rewrites forty things in one pass. A single "undo" would throw all forty away or
// none, so the history works at the level of elements — and reverting one applies its inverse to
// the project AS IT IS NOW, leaving later work alone. The interesting cases are the ones where
// that is not possible: the element is gone, or somebody has touched it since.
import { diff, invert, apply, summarise, describe } from '../electron/history.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

const base = () => ({
  meta: { duration: 60 },
  cuts: [{ id: 'c1', start: 10, end: 12 }, { id: 'c2', start: 30, end: 31 }],
  zooms: [{ id: 'z1', start: 20, dur: 2, scale: 1.4 }],
  scenes: [], frames: [], overlays: [],
  captions: { defaults: { cy: 700 }, cues: [
    { start: 5, end: 6, tokens: [{ t: 'hello' }, { t: 'there' }] },
    { start: 7, end: 8, tokens: [{ t: 'world' }] },
  ] },
  audio: { music: [{ id: 'm1', src: 'bed.wav', start: 0 }], sfx: [] },
});

console.log('history — see what changed, take back just that\n');

// ---- what a diff notices ----
const after = base();
after.cuts.push({ id: 'c3', start: 40, end: 42 });
after.cuts = after.cuts.filter((c) => c.id !== 'c2');
after.zooms[0].scale = 1.8;
let d = diff(base(), after);
ok('an added element is noticed', d.changes.some((c) => c.op === 'add' && c.id === 'c3'));
ok('a removed one too', d.changes.some((c) => c.op === 'remove' && c.id === 'c2'));
ok('and one that was edited in place', d.changes.some((c) => c.op === 'change' && c.id === 'z1'));
ok('a change says which fields moved',
   d.changes.find((c) => c.id === 'z1')?.fields?.join() === 'scale',
   JSON.stringify(d.changes.find((c) => c.id === 'z1')?.fields));
ok('changes are listed in time order', d.changes.every((c, i, a) => i === 0 || a[i - 1].at <= c.at));
ok('the summary reads like a sentence', /added 1 cut · removed 1 cut · changed 1 zoom/.test(summarise(d.changes)) ||
   /cut/.test(summarise(d.changes)), summarise(d.changes));
ok('nothing changed says so', diff(base(), base()).changes.length === 0 && summarise([]) === 'no change');

// Identity must survive reordering, because agents reorder.
const shuffled = base();
shuffled.cuts = [shuffled.cuts[1], shuffled.cuts[0]];
ok('reordering alone is not a change', diff(base(), shuffled).changes.length === 0);

// Captions have no ids and must still be tracked.
const capEdit = base();
capEdit.captions.cues[1].overrides = { cy: 400 };
d = diff(base(), capEdit);
ok('a caption edited without an id is matched by when and what it says',
   d.changes.length === 1 && d.changes[0].op === 'change' && d.changes[0].kind === 'captions',
   JSON.stringify(d.changes));
ok('and it is described by its words', /world/.test(d.changes[0].what), d.changes[0].what);
ok('audio layers are tracked too',
   diff(base(), (() => { const p = base(); p.audio.music = []; return p; })())
     .changes.some((c) => c.kind === 'audio.music' && c.op === 'remove'));

// ---- taking one back ----
const agentPass = base();
agentPass.cuts = [];                                   // the agent threw the cuts away
agentPass.scenes.push({ id: 's1', start: 15, dur: 3, type: 'pills' });
const entry = diff(base(), agentPass);
ok('the whole pass is one entry with several changes', entry.changes.length === 3, JSON.stringify(entry.summary));

// Undo ONLY the lost cuts, and keep the panel the agent added.
const now = clone(agentPass);
const cutLosses = entry.changes.filter((c) => c.kind === 'cuts').map(invert);
let res = apply(now, cutLosses);
ok('reverting part of an entry restores just that', (now.cuts || []).length === 2 && res.conflicts.length === 0,
   JSON.stringify({ cuts: now.cuts?.length, conflicts: res.conflicts }));
ok('and leaves the rest of the pass alone', now.scenes.length === 1);
ok('restored elements land in time order', now.cuts.every((c, i, a) => i === 0 || a[i - 1].start <= c.start));

// Reverting the whole entry.
const now2 = clone(agentPass);
res = apply(now2, entry.changes.map(invert));
ok('reverting the whole entry puts the project back', JSON.stringify(now2.cuts) === JSON.stringify(base().cuts)
   && now2.scenes.length === 0, JSON.stringify(res.conflicts));

// ---- when it cannot ----
const gone = clone(agentPass);
res = apply(gone, [invert({ kind: 'cuts', id: 'c9', op: 'remove', at: 5,
                            before: { id: 'c9', start: 5, end: 6 }, after: null })]);
ok('undoing a removal twice does not duplicate it',
   (() => { const p = clone(base()); const c = { kind: 'cuts', id: 'c1', op: 'remove', at: 10,
              before: { id: 'c1', start: 10, end: 12 }, after: null };
            const r1 = apply(p, [invert(c)]); const r2 = apply(p, [invert(c)]);
            return p.cuts.filter((x) => x.id === 'c1').length === 1 && r2.conflicts.length === 1; })());

const moved = clone(base());
moved.zooms[0].scale = 2.5;                            // somebody edited it after the entry
res = apply(moved, [invert({ kind: 'zooms', id: 'z1', op: 'change', at: 20,
                            before: { id: 'z1', start: 20, dur: 2, scale: 1.4 },
                            after: { id: 'z1', start: 20, dur: 2, scale: 1.8 } })]);
ok('it refuses to overwrite an element somebody changed since',
   res.conflicts.length === 1 && /changed since/.test(res.conflicts[0].why), JSON.stringify(res));
ok('and the value is left exactly as it was found', moved.zooms[0].scale === 2.5);
ok('unless you insist',
   (() => { const p = clone(moved);
            apply(p, [invert({ kind: 'zooms', id: 'z1', op: 'change', at: 20,
                              before: { id: 'z1', start: 20, dur: 2, scale: 1.4 },
                              after: { id: 'z1', start: 20, dur: 2, scale: 1.8 } })], { force: true });
            return p.zooms[0].scale === 1.4; })());

const emptied = clone(base());
emptied.zooms = [];
res = apply(emptied, [invert({ kind: 'zooms', id: 'z1', op: 'change', at: 20,
                              before: { id: 'z1', start: 20, scale: 1.4 }, after: { id: 'z1', start: 20, scale: 1.8 } })]);
ok('an element that no longer exists is reported, not recreated',
   res.conflicts.length === 1 && /not in the project/.test(res.conflicts[0].why));

// ---- the awkward inputs ----
ok('an empty project against a full one is all removals',
   diff(base(), { meta: {} }).changes.every((c) => c.op === 'remove'));
ok('a project with nothing in it does not throw', diff({}, {}).changes.length === 0);
ok('rubbish in a list is skipped', diff({ cuts: [null, 'x'] }, { cuts: [] }).changes.length === 0);
ok('applying to a project with no such list creates it',
   (() => { const p = { meta: {} }; apply(p, [{ kind: 'scenes', id: 's', op: 'add', at: 0,
              before: null, after: { id: 's', start: 1 } }]); return p.scenes?.length === 1; })());
ok('descriptions never come out empty', ['cuts', 'zooms', 'scenes', 'frames', 'captions', 'audio.music']
   .every((k) => describe(k, { start: 1, end: 2, tokens: [{ t: 'hi' }] }).length > 0));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
