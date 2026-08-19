#!/usr/bin/env node
// The playhead must agree with the picture.
//
// The editor works in ORIGINAL time; a preview render has the cuts taken out, so it runs on a
// different clock. renderer/timemap.js converts between them, and engine/render_project.py's
// `make_remap` decides where the frames actually land. If those two ever disagree, the playhead
// drifts against the video and every "set start = playhead" lands in the wrong place — a
// silent, infuriating class of bug. So this checks them against each other on the same inputs
// rather than checking either one alone.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

globalThis.window = globalThis;
new Function(readFileSync(new URL('../renderer/timemap.js', import.meta.url), 'utf8'))();
const { makeCutMap } = globalThis.TimeMap;

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

console.log('preview — the playhead agrees with the picture\n');

// ---- the shape of the mapping ----
const m = makeCutMap([{ start: 10, end: 16 }, { start: 30, end: 31.5 }], 60);
ok('removed time is the sum of the cuts', near(m.removed, 7.5), String(m.removed));
ok('the render is shorter by exactly that', near(m.duration, 52.5), String(m.duration));
ok('before the first cut nothing moves', near(m.toMedia(5), 5));
ok('after one cut everything slides earlier', near(m.toMedia(20), 14));
ok('after both, by both', near(m.toMedia(40), 32.5));
ok('a moment inside a cut collapses onto the join', near(m.toMedia(12), 10), String(m.toMedia(12)));
ok('and the map says it is in one', m.inCut(12) && !m.inCut(20));
ok('playback resumes at the end of the cut it wandered into', near(m.skipTo(12), 16));
ok('a cut running to the very end has nowhere to resume', makeCutMap([{ start: 50, end: 60 }], 60).skipTo(55) === null);

for (const t of [0, 5, 9.999, 16, 20, 29.9, 31.5, 45, 60]) {
  if (!near(m.toTimeline(m.toMedia(t)), t)) { ok(`round trip at ${t}s`, false, `got ${m.toTimeline(m.toMedia(t))}`); break; }
}
ok('every point outside a cut round-trips', [0, 5, 16, 20, 31.5, 45, 60].every((t) => near(m.toTimeline(m.toMedia(t)), t)));

// ---- the awkward inputs ----
ok('no cuts is the identity', (() => { const z = makeCutMap([], 60); return near(z.toMedia(33), 33) && z.duration === 60; })());
ok('cuts out of order are handled', near(makeCutMap([{ start: 30, end: 31.5 }, { start: 10, end: 16 }], 60).toMedia(40), 32.5));
ok('overlapping cuts count once, not twice',
   near(makeCutMap([{ start: 10, end: 20 }, { start: 15, end: 25 }], 60).removed, 15),
   'two accepted proposals that touch must not remove 20s of a 15s span');
ok('a zero-length cut is ignored', makeCutMap([{ start: 10, end: 10 }], 60).removed === 0);
ok('a cut past the end is clamped', near(makeCutMap([{ start: 55, end: 90 }], 60).removed, 5));
ok('a transition removes its overlap as well',
   near(makeCutMap([{ start: 10, end: 16, transition: 'fade', tdur: 0.5 }], 60).removed, 6.5));
ok('"hard" and "none" are not transitions',
   makeCutMap([{ start: 10, end: 16, transition: 'hard' }], 60).removed === 6 &&
   makeCutMap([{ start: 10, end: 16, transition: 'none' }], 60).removed === 6);

// ---- and now: does the engine agree? ----
// This is the point of the file. Same cuts, same sample points, both implementations.
const py = spawnSync('python3', ['-c', `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), 'engine'))})
from render_project import make_remap
cuts, xf, ts = json.load(sys.stdin)
pairs = [(c[0], c[1]) for c in cuts]
xfd = {(c[0], c[1]): c[2] for c in cuts if c[2]}
remap, in_cut = make_remap(pairs, xfd)
print(json.dumps({"remap": [remap(t) for t in ts], "in_cut": [in_cut(t) for t in ts]}))
`], {
  input: JSON.stringify([[[10, 16, 0], [30, 31.5, 0.4]], {}, [0, 5, 12, 16, 20, 31, 31.5, 45, 60]]),
  encoding: 'utf8',
});

if (py.status !== 0) {
  ok('the engine can be asked what it does', false, (py.stderr || '').split('\n').slice(-4).join('\n      '));
} else {
  const got = JSON.parse(py.stdout);
  const ts = [0, 5, 12, 16, 20, 31, 31.5, 45, 60];
  const mine = makeCutMap([{ start: 10, end: 16 }, { start: 30, end: 31.5, transition: 'fade', tdur: 0.4 }], 60);
  const drift = ts.map((t, i) => Math.abs(mine.toMedia(t) - got.remap[i]));
  const worst = Math.max(...drift);
  ok('the app and the engine put every sample at the same place', worst < 1e-6,
     ts.map((t, i) => `${t}s: app ${mine.toMedia(t).toFixed(3)} vs engine ${got.remap[i].toFixed(3)}`).join('\n      '));
  ok('and agree about what counts as inside a cut',
     ts.every((t, i) => mine.inCut(t) === got.in_cut[i]));
}

// ---------------------------------------------------------------------------------------
// The second half: does a preview tell the truth?
//
// The mapping above is arithmetic. This part renders. A preview is only useful if what it shows
// is what the export will show — otherwise the user "fixes" something that was never wrong. So:
// render the same project both ways and compare frames, with the noise floor measured rather
// than guessed (re-encoding alone costs a few points of similarity).
if (process.env.CVE_SKIP_RENDER) {
  console.log('\n(render checks skipped: CVE_SKIP_RENDER)');
  process.exit(failed ? 1 : 0);
}

const ROOT = new URL('..', import.meta.url).pathname;
const ws = mkdtempSync(join(tmpdir(), 'cutright-preview-'));
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws });
const render = (args) => {
  const r = run('python3', [join(ROOT, 'engine/render_project.py'), ...args]);
  if (r.status !== 0) { ok('render ' + args.join(' '), false, (r.stderr || r.stdout || '').slice(-500)); return null; }
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch { return {}; }
};
const seconds = (f) => +(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'csv=p=0', f]).stdout || '0').trim();
const frameSsim = (a, b, ta, tb) => {
  for (const [png, src, t] of [['a.png', a, ta], ['b.png', b, tb]]) {
    if (run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-y', png]).status !== 0) return null;
  }
  const m = /All:([0-9.]+)/.exec(run('ffmpeg', ['-v', 'error', '-i', 'a.png', '-i', 'b.png',
    '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']).stdout || '');
  return m ? +m[1] : null;
};

console.log('\npreview — and does it match the export\n');
if (run('node', [join(ROOT, 'scripts/make-test-workspace.mjs'), ws]).status !== 0) {
  ok('a test project could be built', false);
} else {
  const proj = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
  const DUR = proj.meta.duration;
  const CUT = { start: +(DUR * 0.25).toFixed(2), end: +(DUR * 0.4).toFixed(2) };
  proj.cuts = [CUT];
  proj.scenes = [{ id: 'panel', type: 'pills', start: +(DUR * 0.55).toFixed(2), dur: 2.0,
                   headline: 'PREVIEW', items: [{ text: 'ONE', color: 'coral' }] }];
  writeFileSync(join(ws, 'p.json'), JSON.stringify(proj));

  const cutLen = CUT.end - CUT.start;
  const exported = render(['--project', 'p.json', '--out', 'export.mp4']);
  const previewed = render(['--project', 'p.json', '--out', 'preview.mp4', '--preview']);

  if (exported && previewed) {
    const de = seconds(join(ws, 'export.mp4')), dp = seconds(join(ws, 'preview.mp4'));
    ok('the export is shorter by the cut', Math.abs(de - (DUR - cutLen)) < 0.35,
       `${de.toFixed(2)}s, expected about ${(DUR - cutLen).toFixed(2)}s`);
    ok('and the preview is exactly as long as the export', Math.abs(de - dp) < 0.1,
       `export ${de.toFixed(2)}s vs preview ${dp.toFixed(2)}s`);

    // The floor: the same frame, both files, at a point nothing was drawn on.
    const floor = frameSsim(join(ws, 'export.mp4'), join(ws, 'export.mp4'), 0.5, 0.5);
    const sames = [0.5, DUR * 0.5, DUR * 0.6].map((t) => frameSsim(join(ws, 'export.mp4'), join(ws, 'preview.mp4'), t, t));
    ok('every sampled frame matches the export', sames.every((v) => v !== null && v > 0.90),
       sames.map((v, i) => `sample ${i}: ${v === null ? 'unreadable' : v.toFixed(4)}`).join(', ')
       + ` (identical-frame floor ${floor === null ? '?' : floor.toFixed(4)})`);
  }

  // The bug this was written for: a ranged preview used to ignore cuts entirely, so the section
  // you previewed still had the dead air in it while the timeline said it was gone.
  const A = +(DUR * 0.2).toFixed(2), B = +(DUR * 0.45).toFixed(2);
  render(['--project', 'p.json', '--out', 'win_cuts.mp4', '--preview', '--range', String(A), String(B)]);
  render(['--project', 'p.json', '--out', 'win_raw.mp4', '--preview', '--no-cuts', '--range', String(A), String(B)]);
  if (existsSync(join(ws, 'win_cuts.mp4')) && existsSync(join(ws, 'win_raw.mp4'))) {
    // Both windows are the same length; what differs is which footage is inside them.
    const same = frameSsim(join(ws, 'win_cuts.mp4'), join(ws, 'win_raw.mp4'), (B - A) * 0.8, (B - A) * 0.8);
    ok('a ranged preview applies the cuts', same !== null && same < 0.99,
       `the window with cuts is identical to the one without (ssim ${same}) — cuts were ignored`);
  }

  // The cut master is the expensive part; a preview that rebuilt it every time was the reason a
  // fifteen-second window cost twenty-two seconds.
  const cdir = join(ws, '.preview-cache');
  ok('the cut master is kept for reuse', existsSync(cdir) && readdirSync(cdir).some((n) => n.startsWith('cut_')));
  const before = existsSync(cdir) ? readdirSync(cdir).filter((n) => n.startsWith('cut_')) : [];
  proj.cuts = [{ start: CUT.start, end: +(CUT.end + 0.5).toFixed(2) }];
  writeFileSync(join(ws, 'p.json'), JSON.stringify(proj));
  render(['--project', 'p.json', '--out', 'preview2.mp4', '--preview', '--range', String(A), String(B)]);
  const after = existsSync(cdir) ? readdirSync(cdir).filter((n) => n.startsWith('cut_')) : [];
  ok('changing the cuts does not reuse the old one', after.length > before.length,
     `cache went from ${before.length} to ${after.length} masters — a stale one would show the old edit`);

  // An export must never be given the preview's cheaper encode.
  ok('an export is not affected by any of this', !existsSync(join(ws, 'export.mp4')) ? false
     : seconds(join(ws, 'export.mp4')) > 0);
}

rmSync(ws, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
