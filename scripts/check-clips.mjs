#!/usr/bin/env node
// A second video track — does the footage land where the project says?
//
// Until now a project held exactly one video, so a tutorial (talking head plus screen capture)
// could only be decorated. A clip is another piece of footage placed on the timeline, either
// filling the frame or sitting in a box over it. Both are geometry, so both can be measured
// rather than eyeballed: render, sample the pixels, and check the clip is where it was asked to
// be and nowhere else.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-clips-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws, ...opts });
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};
const bail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

console.log('clips — a second video track lands where the project says\n');
if (run('node', [join(ROOT, 'scripts/make-test-workspace.mjs'), ws]).status !== 0) bail('no test workspace');

// A clip in a colour the SMPTE bars in the fixture do not contain, so "is the clip here?" cannot
// be answered by accident. (A green square would have been indistinguishable from the bars —
// that mistake has been made in this repo before.)
const MARK = [120, 30, 200];
const mk = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi',
  '-i', `color=c=0x${MARK.map((n) => n.toString(16).padStart(2, '0')).join('')}:s=640x360:d=6:r=30`,
  '-c:v', process.env.CVE_VIDEO_ENCODER || 'libx264', '-pix_fmt', 'yuv420p', join(ws, 'broll.mp4')]);
if (mk.status !== 0) bail('could not build the clip: ' + mk.stderr);

const project = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
project.captions.cues = []; project.scenes = []; project.overlays = []; project.cuts = [];
const W = project.meta.width, H = project.meta.height;
const BOX = { x: 0.60, y: 0.08, w: 0.34, h: 0.34 };
project.clips = [
  { id: 'full', src: 'broll.mp4', start: 1.0, dur: 1.5, fit: 'full', fill: 'cover' },
  { id: 'pip', src: 'broll.mp4', start: 4.0, dur: 1.5, fit: 'box', box: BOX },
];
writeFileSync(join(ws, 'clips.json'), JSON.stringify(project, null, 2));

const r = run('python3', [join(ROOT, 'engine/render_project.py'), '--project', 'clips.json', '--out', 'out.mp4']);
if (r.status !== 0) bail(`render failed:\n${(r.stderr || r.stdout || '').slice(-700)}`);

// Sample a pixel from a frame at a given second.
const sample = (t, fx, fy) => {
  const px = run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', 'out.mp4', '-frames:v', '1',
    '-vf', `crop=8:8:${Math.round(fx * W) - 4}:${Math.round(fy * H) - 4},scale=1:1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
  if (px.status !== 0 || !px.stdout || px.stdout.length < 3) return null;
  return [px.stdout[0], px.stdout[1], px.stdout[2]];
};
const near = (got, want, tol = 46) => got && want.every((v, i) => Math.abs(got[i] - v) <= tol);
const show = (p) => (p ? `rgb(${p.join(',')})` : 'unreadable');

// ---- a full-frame clip replaces the picture for its window, and only for its window ----
const during = sample(1.7, 0.5, 0.5);
ok('a full-frame clip fills the frame while it runs', near(during, MARK),
   `centre at 1.7s was ${show(during)}, expected about rgb(${MARK.join(',')})`);
const corner = sample(1.7, 0.08, 0.9);
ok('and fills it right to the edges', near(corner, MARK), `a corner was ${show(corner)}`);
const before = sample(0.4, 0.5, 0.5);
ok('before it starts, the original picture is showing', !near(before, MARK), show(before));
const after = sample(3.2, 0.5, 0.5);
ok('after it ends, the original picture is back', !near(after, MARK), show(after));

// ---- a boxed clip sits exactly where the box says ----
const inBox = sample(4.7, BOX.x + BOX.w / 2, BOX.y + BOX.h / 2);
ok('a boxed clip is inside its box', near(inBox, MARK), `box centre was ${show(inBox)}`);
const outside = sample(4.7, 0.15, 0.8);
ok('and nowhere else', !near(outside, MARK), `outside the box was ${show(outside)}`);
const justOutside = sample(4.7, BOX.x - 0.06, BOX.y + BOX.h / 2);
ok('the left edge of the box is where it was asked for', !near(justOutside, MARK),
   `just left of the box was ${show(justOutside)} — the box is wider than requested`);

// ---- the frame stays a legal size ----
const size = (run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries',
  'stream=width,height', '-of', 'csv=p=0', 'out.mp4']).stdout || '').trim();
ok('the render is still the project’s size', size === `${W},${H}`, size);

// ---- a clip that straddles a cut is dropped, not silently moved ----
const withCut = JSON.parse(readFileSync(join(ws, 'clips.json'), 'utf8'));
withCut.cuts = [{ start: 1.2, end: 1.6 }];
writeFileSync(join(ws, 'cut.json'), JSON.stringify(withCut));
const rc = run('python3', [join(ROOT, 'engine/render_project.py'), '--project', 'cut.json', '--out', 'cut.mp4']);
ok('a project whose clip straddles a cut still renders', rc.status === 0,
   (rc.stderr || '').slice(-300));

// ---- a missing file is skipped rather than failing the render ----
const missing = JSON.parse(readFileSync(join(ws, 'clips.json'), 'utf8'));
missing.clips.push({ id: 'ghost', src: 'not-here.mp4', start: 6, dur: 1 });
writeFileSync(join(ws, 'missing.json'), JSON.stringify(missing));
const rm = run('python3', [join(ROOT, 'engine/render_project.py'), '--project', 'missing.json', '--out', 'missing.mp4']);
ok('a clip whose file is gone does not take the render with it', rm.status === 0,
   (rm.stderr || '').slice(-300));

rmSync(ws, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
