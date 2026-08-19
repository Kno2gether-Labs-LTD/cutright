// Prove a zoom lands exactly where project.json says it should.
//
//   node scripts/check-zoom-geometry.mjs
//
// Why this exists: zoompan's expression context is nothing like the usual filter one (no `t`,
// no between()), so a zoom can render plausibly while pointing at the wrong part of the frame.
// "It looked zoomed" is not a test. This one reconstructs the expected window by cropping the
// unzoomed render, and asserts the real output matches it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-zoom-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws, ...opts });
const fail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

// a zoom the UI could have written: 1.6× on the lower-left quadrant
const Z = { id: 'z1', start: 2.0, dur: 2.0, scale: 1.6, x: 0.25, y: 0.75, source: 'manual' };
const W = 1920, H = 1080;
const winW = Math.round(W / Z.scale), winH = Math.round(H / Z.scale);
const offX = Math.round((W - winW) * Z.x), offY = Math.round((H - winH) * Z.y);

console.log(`building a test project in ${ws}`);
if (run('node', [join(ROOT, 'scripts/make-test-workspace.mjs'), ws]).status !== 0)
  fail('could not build the test workspace');

const base = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
base.captions.cues = []; base.scenes = []; base.overlays = [];   // isolate the zoom
writeFileSync(join(ws, 'plain.json'), JSON.stringify(base));
writeFileSync(join(ws, 'zoomed.json'), JSON.stringify({ ...base, zooms: [Z] }));

const engine = join(ROOT, 'engine/render_project.py');
for (const [proj, out] of [['plain.json', 'plain.mp4'], ['zoomed.json', 'zoomed.mp4']]) {
  const r = run('python3', [engine, '--project', proj, '--range', '2.5', '3.5', '--out', out]);
  if (r.status !== 0) fail(`render failed for ${proj}:\n${(r.stderr || '').slice(-600)}`);
}

// mid-zoom, past the half-second ramp, so the window is exactly the one computed above
const ff = (args) => { const r = run('ffmpeg', ['-v', 'error', ...args]); if (r.status !== 0) fail('ffmpeg: ' + r.stderr); };
ff(['-ss', '0.5', '-i', 'plain.mp4', '-vf', `crop=${winW}:${winH}:${offX}:${offY},scale=${W}:${H}`, '-frames:v', '1', '-y', 'expected.png']);
ff(['-ss', '0.5', '-i', 'plain.mp4', '-frames:v', '1', '-y', 'unzoomed.png']);
ff(['-ss', '0.5', '-i', 'zoomed.mp4', '-frames:v', '1', '-y', 'actual.png']);

const ssim = (a, b) => {
  const r = run('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']);
  const m = /All:([0-9.]+)/.exec(r.stdout || '');
  if (!m) fail('could not measure similarity between ' + a + ' and ' + b);
  return +m[1];
};

const size = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=width,height', '-of', 'csv=p=0', 'zoomed.mp4']).stdout.trim();
const matches = ssim('expected.png', 'actual.png');
const differs = ssim('unzoomed.png', 'actual.png');

console.log(`  output size      ${size}`);
console.log(`  vs the expected window   ${matches.toFixed(3)}  (want > 0.85 — the zoom is where it should be)`);
console.log(`  vs the unzoomed frame    ${differs.toFixed(3)}  (want < 0.80 — something actually happened)`);

if (size !== `${W},${H}`) fail(`a zoom changed the output size to ${size}`);
if (matches < 0.85) fail(`the zoom did not land on (${Z.x}, ${Z.y}) at ${Z.scale}× — similarity ${matches.toFixed(3)}`);
if (differs > 0.80) fail(`the zoom barely changed the picture — similarity ${differs.toFixed(3)}`);

rmSync(ws, { recursive: true, force: true });
console.log('✓ zoom geometry is exact');
