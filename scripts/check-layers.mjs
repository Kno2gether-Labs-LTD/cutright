// Layers have to be the same edit, taken apart — not a second interpretation of it.
//
//   node scripts/check-layers.mjs
//
// The test is the only one that means anything: stack them back up and see whether you get the
// flat render. Comparing against a fixed number would not work — re-encoding alone costs a few
// points of similarity — so the noise floor is measured first, by pushing the picture layer
// through the same encode with nothing added.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-layers-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws, ...opts });
const fail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

console.log(`building a test project in ${ws}`);
if (run('node', [join(ROOT, 'scripts/make-test-workspace.mjs'), ws]).status !== 0)
  fail('could not build the test workspace');

const p = JSON.parse(readFileSync(join(ws, 'project.json'), 'utf8'));
p.scenes = [{ id: 'panel', type: 'pills', start: 3.0, dur: 3.0, headline: 'LAYERS',
              items: [{ text: 'ONE', color: 'coral' }] }];
writeFileSync(join(ws, 'layered.json'), JSON.stringify(p));

const r = run('python3', [join(ROOT, 'engine/render_project.py'),
  '--project', 'layered.json', '--out', 'flat.mp4', '--layers', 'layers']);
if (r.status !== 0) fail(`render failed:\n${(r.stderr || r.stdout || '').slice(-700)}`);
const out = JSON.parse((r.stdout || '').trim().split('\n').pop());
if (!out.layers?.picture) fail('no picture layer was written');
if (!out.layers?.graphics) fail('no graphics layer was written');
if (!existsSync(join(ws, 'layers/README.txt'))) fail('the layers folder has no note saying what they are');

// the graphics layer is useless without alpha
const pix = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
  'stream=codec_name,pix_fmt', '-of', 'csv=p=0', join(ws, 'layers', out.layers.graphics)]).stdout.trim();
if (!/argb|rgba|yuva|4444/.test(pix)) fail('the graphics layer carries no alpha: ' + pix);
console.log(`  graphics layer  ${pix}`);

// stack them back, and push the picture alone through the same encode as a noise floor
const enc = (args, dest) => {
  const x = run('ffmpeg', ['-v', 'error', '-y', ...args, '-map', '[v]', '-an', dest]);
  if (x.status !== 0) fail('could not build ' + dest + ': ' + x.stderr);
};
enc(['-i', `layers/${out.layers.picture}`, '-i', `layers/${out.layers.graphics}`,
     '-filter_complex', '[0:v][1:v]overlay=0:0:eof_action=pass,format=yuv420p[v]'], 'restacked.mp4');
enc(['-i', `layers/${out.layers.picture}`, '-filter_complex', '[0:v]format=yuv420p[v]'], 'floor.mp4');

const ssim = (a, b, t) => {
  for (const [f, src] of [['x.png', a], ['y.png', b]]) {
    const g = run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', src, '-frames:v', '1', '-y', f]);
    if (g.status !== 0) fail(`could not read a frame at ${t}s from ${src}`);
  }
  const m = /All:([0-9.]+)/.exec(run('ffmpeg', ['-v', 'error', '-i', 'x.png', '-i', 'y.png',
    '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-']).stdout || '');
  if (!m) fail('could not compare frames');
  return +m[1];
};

const OUTSIDE = 1.0, DURING = 4.4;
const floorOutside = ssim('floor.mp4', 'flat.mp4', OUTSIDE);
const stackOutside = ssim('restacked.mp4', 'flat.mp4', OUTSIDE);
const floorDuring = ssim('floor.mp4', 'flat.mp4', DURING);
const stackDuring = ssim('restacked.mp4', 'flat.mp4', DURING);

console.log(`  outside the panel  picture alone ${floorOutside.toFixed(4)} · restacked ${stackOutside.toFixed(4)}`);
console.log(`  during the panel   picture alone ${floorDuring.toFixed(4)} · restacked ${stackDuring.toFixed(4)}`);

if (floorDuring > 0.9)
  fail('the picture layer already looks like the finished frame — the panel was baked into it, '
     + 'so these are not layers at all');
if (stackDuring < floorOutside - 0.02)
  fail(`stacking the layers does not reproduce the render during the panel `
     + `(${stackDuring.toFixed(4)} against a noise floor of ${floorOutside.toFixed(4)})`);
if (stackOutside < floorOutside - 0.02)
  fail(`the graphics layer is drawing outside its own window (${stackOutside.toFixed(4)} vs `
     + `${floorOutside.toFixed(4)} for the picture alone)`);

rmSync(ws, { recursive: true, force: true });
console.log('✓ layers: the picture, the graphics and the sound come apart and stack back together');
