// Prove the camera framing lands where project.json says, and in the right shape.
//
//   node scripts/check-framing.mjs
//
// The picture is moved by ffmpeg (scale + overlay, evaluated per frame) and its shape is drawn
// by Pillow (a rectangle rounding into a circle — geq can express that but needs minutes per
// second of 1080p). Two halves that have to agree, which is exactly the kind of thing that goes
// quietly wrong: a circle in the right place with the wrong crop still looks fine in a thumbnail.
//
// So this renders against a flat backdrop, finds the picture by colour, and measures it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-frame-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws, ...opts });
const fail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

const W = 1920, H = 1080, SIZE = 0.28, MARGIN = 0.04;
const D = SIZE * W, M = MARGIN * W;

console.log(`building a test project in ${ws}`);
if (run('node', [join(ROOT, 'scripts/make-test-workspace.mjs'), ws]).status !== 0)
  fail('could not build the test workspace');

// Rendered twice, against two different flat backdrops. A pixel that changed between the two is
// backdrop; a pixel that did not is picture. Testing against one colour is not enough — the test
// pattern contains every primary, so a green backdrop "loses" the green bars of the picture.
const p = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
p.captions.cues = []; p.scenes = []; p.overlays = [];
const frames = (backdrop) => ([
  { id: 'f1', start: 1.0, dur: 0.8, to: 'corner', shape: 'circle', size: SIZE,
    corner: 'br', margin: MARGIN, backdrop },
  { id: 'f2', start: 5.0, dur: 0.6, to: 'full' },
]);
for (const [name, colour] of [['a', '#00ff00'], ['b', '#ff00ff']]) {
  writeFileSync(join(ws, `framed_${name}.json`), JSON.stringify({ ...p, frames: frames(colour) }));
  const r = run('python3', [join(ROOT, 'engine/render_project.py'),
    '--project', `framed_${name}.json`, '--out', `framed_${name}.mp4`]);
  if (r.status !== 0) fail(`render failed (${colour}):\n${(r.stderr || r.stdout || '').slice(-700)}`);
}

const measure = (t) => {
  for (const name of ['a', 'b']) {
    const f = run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', `framed_${name}.mp4`,
      '-frames:v', '1', '-y', join(ws, `f_${name}_${t}.png`)]);
    if (f.status !== 0) fail('could not extract a frame at ' + t);
  }
  const out = run('python3', ['-c', `
from PIL import Image
import numpy as np
a = np.array(Image.open(${JSON.stringify(join(ws, 'f_a_'))} + ${JSON.stringify(String(t))} + '.png').convert('RGB')).astype(int)
b = np.array(Image.open(${JSON.stringify(join(ws, 'f_b_'))} + ${JSON.stringify(String(t))} + '.png').convert('RGB')).astype(int)
m = (np.abs(a - b).sum(axis=2) < 30)                 # unchanged between backdrops = the picture
ys, xs = np.where(m)
if len(xs) == 0: print('0 0 0 0 0'); raise SystemExit
print(xs.min(), ys.min(), xs.max(), ys.max(), int(m.sum()))
`]);
  if (out.status !== 0) fail('measurement failed: ' + out.stderr);
  const [x0, y0, x1, y1, area] = out.stdout.trim().split(/\s+/).map(Number);
  return { x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1 };
};

const before = measure(0.4);      // still full frame
const settled = measure(3.0);     // circle, bottom-right
const after = measure(7.0);       // back to full frame

console.log(`  before   ${before.w}x${before.h} at (${before.x0},${before.y0})`);
console.log(`  settled  ${settled.w}x${settled.h} at (${settled.x0},${settled.y0})`);
console.log(`  after    ${after.w}x${after.h} at (${after.x0},${after.y0})`);

const near = (a, b, tol) => Math.abs(a - b) <= tol;

if (!near(before.w, W, 8) || !near(before.h, H, 8))
  fail(`the picture was not full-frame before the move: ${before.w}x${before.h}`);

if (!near(settled.w, D, 12) || !near(settled.h, D, 12))
  fail(`the settled picture is ${settled.w}x${settled.h}, expected about ${Math.round(D)} square`);
if (!near(settled.x1, W - M, 12) || !near(settled.y1, H - M, 12))
  fail(`the settled picture sits at (${settled.x1},${settled.y1}), expected its far edges near `
     + `(${Math.round(W - M)},${Math.round(H - M)}) for a bottom-right corner with a ${MARGIN} margin`);

// a circle fills pi/4 of its bounding box; a rounded rectangle noticeably more
const circleArea = Math.PI * (settled.w / 2) * (settled.h / 2);
const ratio = settled.area / circleArea;
console.log(`  circle check  filled ${settled.area}px vs ${Math.round(circleArea)} for a true circle (${ratio.toFixed(3)})`);
if (ratio < 0.94 || ratio > 1.06)
  fail(`the settled shape is not a circle — it fills ${(settled.area / (settled.w * settled.h) * 100).toFixed(0)}% `
     + 'of its bounding box (a circle fills 79%, a rectangle 100%)');

if (!near(after.w, W, 8) || !near(after.h, H, 8))
  fail(`the picture did not return to full frame: ${after.w}x${after.h}`);

// ---------------------------------------------------------------- the scene card
// A scene leaves a portrait card empty on the right and the picture slides into it. That is the
// layout the info-point templates are built around, so it gets measured too: the card's position
// is defined once in scenes_png.py, and if the picture animates into a hole that is no longer
// there, nobody notices until a render looks wrong.
const card = (() => {
  const out = run('python3', ['-c',
    `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'engine'))});
from scenes_png import CARD; print(CARD['x'], CARD['y'], CARD['w'], CARD['h'])`]);
  if (out.status !== 0) fail('could not read the scene card geometry: ' + out.stderr);
  const [x, y, w, h] = out.stdout.trim().split(/\s+/).map(Number);
  return { x, y, w, h };
})();

const sc = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
sc.captions.cues = []; sc.overlays = []; sc.frames = [];
sc.scenes = [{ id: 'card', type: 'pills', start: 3.0, dur: 2.5, headline: 'FRAMING',
               items: [{ text: 'ONE', color: 'coral' }] }];
writeFileSync(join(ws, 'scene.json'), JSON.stringify(sc));
const sr = run('python3', [join(ROOT, 'engine/render_project.py'), '--project', 'scene.json', '--out', 'scene.mp4']);
if (sr.status !== 0) fail(`scene render failed:\n${(sr.stderr || sr.stdout || '').slice(-700)}`);

// The honest test of "it slid into the card" is that it ENDS in the layout the original static
// path produces. So render the same scene both ways and compare a frame from the middle of it:
// same picture, same card, same graphics — the only difference should be how it got there.
sc.scenes[0].enter = 'cut';
writeFileSync(join(ws, 'scene_cut.json'), JSON.stringify(sc));
const cr = run('python3', [join(ROOT, 'engine/render_project.py'), '--project', 'scene_cut.json', '--out', 'scene_cut.mp4']);
if (cr.status !== 0) fail(`static scene render failed:\n${(cr.stderr || cr.stdout || '').slice(-700)}`);

for (const [file, tag] of [['scene.mp4', 'slid'], ['scene_cut.mp4', 'cut']]) {
  const f = run('ffmpeg', ['-v', 'error', '-ss', '4.2', '-i', file, '-frames:v', '1', '-y', `card_${tag}.png`]);
  if (f.status !== 0) fail('could not extract a scene frame from ' + file);
}
const sim = (() => {
  const r = run('ffmpeg', ['-v', 'error', '-i', 'card_slid.png', '-i', 'card_cut.png',
    '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']);
  const m = /All:([0-9.]+)/.exec(r.stdout || '');
  if (!m) fail('could not compare the two scene renders');
  return +m[1];
})();
console.log(`  scene card  mid-scene frame matches the static layout at ${sim.toFixed(3)} (want > 0.95)`);
if (sim < 0.95)
  fail(`the slide does not end in the same layout the static path produces (${sim.toFixed(3)}) — `
     + 'the picture is settling somewhere other than the scene card');

// and it must have been full-frame a second before the scene, which the static path never is
const beforeScene = (() => {
  run('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', 'scene.mp4', '-frames:v', '1', '-y', 'pre_slid.png']);
  run('ffmpeg', ['-v', 'error', '-ss', '1.5', '-i', 'scene_cut.mp4', '-frames:v', '1', '-y', 'pre_cut.png']);
  const r = run('ffmpeg', ['-v', 'error', '-i', 'pre_slid.png', '-i', 'pre_cut.png',
    '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']);
  const m = /All:([0-9.]+)/.exec(r.stdout || '');
  return m ? +m[1] : 0;
})();
console.log(`  before it   both paths show the untouched frame (${beforeScene.toFixed(3)})`);
if (beforeScene < 0.95)
  fail('the picture is already moved a second and a half before the scene — the slide starts too early');

rmSync(ws, { recursive: true, force: true });
console.log('✓ framing: corner circle and scene card both land where the project says');
