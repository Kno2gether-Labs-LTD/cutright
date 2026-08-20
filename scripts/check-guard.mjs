#!/usr/bin/env node
// Can the agent lose an edit you made by hand?
//
// The agent rewrites project.json, which is what it is for — so the protection cannot be "do not
// change anything". It has to distinguish the agent doing its job (adding panels, restyling,
// re-timing what it created) from the agent quietly dropping a cut you made yourself. These are
// the cases that separate the two.
import { snapshot, diff, restore, ensureId } from '../electron/guard.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const base = () => ({
  meta: { duration: 60, height: 1080 },
  cuts: [{ id: 'c1', start: 10, end: 14, manual: true }, { id: 'c2', start: 30, end: 31 }],
  zooms: [{ id: 'z1', start: 20, dur: 2, scale: 1.4, manual: true }],
  scenes: [], frames: [], overlays: [],
  captions: { defaults: { cy: 700, fontsize: 60 }, cues: [
    { start: 5, end: 6, tokens: [{ t: 'hello' }], manual: true, overrides: { cy: 400 } },
    { start: 7, end: 8, tokens: [{ t: 'world' }] },
  ] },
});

console.log('guard — an edit you made by hand survives the agent\n');

const before = snapshot(base());
ok('only hand edits are protected, not everything',
   before.count === 3, `snapshot holds ${before.count}, expected 3 (1 cut, 1 zoom, 1 cue)`);
ok('an automatic cut is not in the snapshot',
   !(before.lists.cuts || []).some((c) => c.id === 'c2'));

// The agent doing its job must be silent.
const worked = base();
worked.scenes.push({ id: 's9', start: 12, dur: 3, type: 'pills' });
worked.cuts.push({ id: 'c3', start: 40, end: 42 });
worked.cuts[1].start = 33;                                  // re-timed one of its OWN cuts
worked.captions.cues[1].overrides = { cy: 900 };            // restyled a cue nobody touched
let d = diff(before, worked);
ok('adding panels and cuts raises nothing', d.missing.length === 0 && d.moved.length === 0,
   JSON.stringify(d));

// …and losing a hand edit must not be.
const lost = base();
lost.cuts = lost.cuts.filter((c) => c.id !== 'c1');
d = diff(before, lost);
ok('a hand-made cut that vanished is reported', d.missing.length === 1 && d.missing[0].item.id === 'c1',
   JSON.stringify(d.missing));
ok('and it says which kind it was', d.missing[0].kind === 'cuts');

const nudged = base();
nudged.cuts[0].start = 10.1;
ok('a hand-made cut nudged within tolerance is left alone', diff(before, nudged).moved.length === 0);
nudged.cuts[0].start = 13;
ok('one moved far enough to remove different words is reported', diff(before, nudged).moved.length >= 1);

const shortened = base();
shortened.cuts[0].end = 11;
ok('a cut that kept its name but not its span is reported',
   diff(before, shortened).moved.some((m) => /same span/.test(m.why)));

const zgone = base();
zgone.zooms = [];
ok('a zoom you placed yourself is protected too',
   diff(before, zgone).missing.some((m) => m.kind === 'zooms'));

const restyled = base();
restyled.captions.cues[0].overrides = { cy: 950 };
ok('a caption height you set being overwritten is reported',
   diff(before, restyled).moved.some((m) => m.kind === 'captions'), JSON.stringify(diff(before, restyled).moved));

const cueGone = base();
cueGone.captions.cues = cueGone.captions.cues.slice(1);
ok('a hand-edited cue that disappeared is reported', diff(before, cueGone).missing.some((m) => m.kind === 'captions'));

// Identity has to survive reordering, because the agent reorders.
const shuffled = base();
shuffled.cuts = [shuffled.cuts[1], shuffled.cuts[0]];
shuffled.cuts.unshift({ id: 'cX', start: 1, end: 2 });
ok('protection follows the id, not the position', diff(before, shuffled).missing.length === 0);

// Putting it back.
const wrecked = base();
wrecked.cuts = wrecked.cuts.filter((c) => c.id !== 'c1');
wrecked.zooms = [];
wrecked.captions.cues[0].overrides = { cy: 950 };
const put = restore(wrecked, before);
ok('restoring puts the missing ones back', put >= 3, `restored ${put}`);
ok('and the project is clean afterwards', diff(before, wrecked).missing.length === 0 && diff(before, wrecked).moved.length === 0,
   JSON.stringify(diff(before, wrecked)));
ok('restored items land in time order',
   wrecked.cuts.every((c, i, a) => i === 0 || a[i - 1].start <= c.start), JSON.stringify(wrecked.cuts.map((c) => c.start)));
const again = restore(wrecked, before);
ok('restoring twice does not duplicate anything', wrecked.cuts.filter((c) => c.id === 'c1').length === 1,
   `ran again and put ${again} back`);
ok('the agent\'s own additions are not thrown away by a restore',
   restore(worked, before) >= 0 && worked.scenes.length === 1 && worked.cuts.some((c) => c.id === 'c3'));

// The awkward inputs.
ok('no snapshot at all is not a crash', diff(null, base()).missing.length === 0);
ok('an empty project against a snapshot reports everything missing',
   diff(before, { captions: { cues: [] } }).missing.length === 3);
const el = {};
ok('ids are stamped when missing and kept when present',
   !!ensureId(el, 'cuts', 0) && ensureId(el, 'cuts', 0) === el.id);

// The same rule is enforced twice — here for the app's Check panel, and in
// engine/verify_project.py for the agent, which runs the engine rather than the app. If only one
// of them knew, the agent could break a hand edit and be told everything was fine.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-guard-'));
const verify = (project, handoff) => {
  writeFileSync(join(ws, 'project.json'), JSON.stringify(project));
  mkdirSync(join(ws, '.cutright'), { recursive: true });
  writeFileSync(join(ws, '.cutright', 'handoff.json'), JSON.stringify(handoff));
  const r = spawnSync('python3', [join(ROOT, 'engine/verify_project.py'),
    '--project', join(ws, 'project.json'), '--json'], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return { parseError: (r.stderr || r.stdout || '').slice(-300) }; }
};

console.log('\nguard — and the engine enforces the same rule\n');

const intact = verify(base(), before);
ok('the engine is quiet when nothing was lost',
   !(intact.issues || []).some((i) => /by hand/.test(i.what)), JSON.stringify(intact.issues || intact));

const dropped = base();
dropped.cuts = dropped.cuts.filter((c) => c.id !== 'c1');
const said = verify(dropped, before);
const hand = (said.issues || []).filter((i) => /by hand/.test(i.what));
ok('the engine reports a hand-made cut that was dropped', hand.length === 1, JSON.stringify(said.issues || said));
ok('and calls it an error, not a suggestion', hand[0]?.severity === 'error');
ok('and says what to do about it', /put back|re-add/i.test(hand[0]?.fix || ''), hand[0]?.fix);

const restyled2 = base();
restyled2.captions.cues[0].overrides = { cy: 950 };
const capSaid = verify(restyled2, before);
ok('an overwritten caption height is raised by the engine too',
   (capSaid.issues || []).some((i) => /caption height/.test(i.what)), JSON.stringify(capSaid.issues || capSaid));

// No snapshot means the project was never handed to an agent; that must not become noise.
writeFileSync(join(ws, 'project.json'), JSON.stringify(base()));
rmSync(join(ws, '.cutright'), { recursive: true, force: true });
const noSnap = spawnSync('python3', [join(ROOT, 'engine/verify_project.py'),
  '--project', join(ws, 'project.json'), '--json'], { encoding: 'utf8' });
let parsed = {};
try { parsed = JSON.parse(noSnap.stdout); } catch {}
ok('with no snapshot the engine says nothing about hand edits',
   !((parsed.issues || []).some((i) => /by hand/.test(i.what))));

rmSync(ws, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
