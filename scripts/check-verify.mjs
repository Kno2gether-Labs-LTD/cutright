// The verifier has to catch the mistakes it claims to catch.
//
//   node scripts/check-verify.mjs
//
// It is the last thing between an agent saying "done" and a twenty-minute render that turns out
// to have silently dropped a scene. A verifier that misses things is worse than none, because it
// is trusted.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-verify-'));
const fail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

// a one-frame file so "the master exists" is true and only the planted faults show up
const mk = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(ws, 'graded_master.mp4')], { encoding: 'utf8' });
if (mk.status !== 0) fail('could not build a fixture: ' + mk.stderr);

const project = {
  version: 1,
  meta: { graded: 'graded_master.mp4', width: 1280, height: 720, fps: 30, duration: 28,
          tracks: { screen: 'graded_master.mp4', camera: 'recording/gone.mp4' } },
  pacing: { minPanel: 2.6, maxPanel: 8.0 },
  grade: {},
  captions: { defaults: {}, cues: [
    { id: 'c1', start: 1.0, end: 2.0, tokens: [{ t: 'hello' }] },
    { id: 'c2', start: 1.5, end: 3.0, tokens: [{ t: 'overlapping' }] },
    { id: 'c3', start: 5.0, end: 4.0, tokens: [{ t: 'backwards' }] }] },
  scenes: [
    { id: 'straddles', type: 'pills', start: 9.0, dur: 3.0, headline: 'X', items: [] },
    { id: 'tooLong', type: 'pills', start: 14.0, dur: 20.0, headline: 'Y', items: [] },
    { id: 'clash', type: 'pills', start: 15.0, dur: 3.0, headline: 'Z', items: [] }],
  overlays: [{ id: 'missing', src: 'overlays/nope.mov', start: 2.0, dur: 2.0 }],
  cuts: [{ start: 10.0, end: 11.0 }, { start: 10.5, end: 12.0 }],
  frames: [{ id: 'f1', start: 10.4, dur: 0.7, to: 'full' },
           { id: 'f2', start: 11.0, dur: 0.7, to: 'corner' }],
  zooms: [{ id: 'z1', start: 3.0, dur: 2.0, scale: 3.2, x: 1.4, y: 0.5 },
          { id: 'z2', start: 3.5, dur: 2.0, scale: 1.3, x: 0.5, y: 0.5 }],
  audio: { loudnessLUFS: -14, sfx: [],
           music: [{ id: 'm1', src: 'audio/gone.wav', start: 0, dur: 10, gain: 6 }] },
};
writeFileSync(join(ws, 'project.json'), JSON.stringify(project, null, 1));

const r = spawnSync('python3', [join(ROOT, 'engine/verify_project.py'),
  '--project', join(ws, 'project.json'), '--json'], { encoding: 'utf8' });
if (!r.stdout) fail('the verifier produced nothing: ' + (r.stderr || '').slice(-300));
const out = JSON.parse(r.stdout);
if (r.status === 0) fail('a project with seven broken things was reported as fine');

const found = out.issues.map((i) => i.what.toLowerCase());
const must = [
  ['the camera track is missing', 'a track pointing at a file that does not exist'],
  ['a scene straddles a cut', 'a scene the engine drops silently at render'],
  ['an overlay file is missing', 'an overlay whose file is not there'],
  ['two panels are on screen at once', 'two panels sharing one card'],
  ['outstays', "a panel longer than the pack's ceiling"],
  ['a framing move sits inside a cut', 'a framing move inside a cut, which can never happen'],
  ['never comes back to full frame', 'a picture left small for the rest of the video'],
  ['not between 0 and 1', 'a zoom centre written in pixels instead of 0..1'],
  ['two captions overlap', 'captions drawing on top of each other'],
  ['a caption ends before it starts', 'a caption with backwards timing'],
  ['a music file is missing', 'an audio layer whose file is not there'],
  ['boosted above unity', 'music mixed louder than the voice'],
  ['two cuts overlap', 'overlapping cuts'],
  ['two zooms land within', 'zooms stacked on top of each other'],
];
const missed = must.filter(([needle]) => !found.some((f) => f.includes(needle)));
if (missed.length)
  fail('the verifier missed:\n' + missed.map(([, human]) => '    · ' + human).join('\n'));

// every issue must say what to do about it — a report nobody can act on is noise
const mute = out.issues.filter((i) => !i.fix || i.fix.length < 8);
if (mute.length) fail(`${mute.length} issue(s) say what is wrong but not what to do`);

// and a clean project must come back clean, or nobody will trust it
delete project.overlays; delete project.frames; delete project.zooms;
project.meta.tracks = { screen: 'graded_master.mp4' };
project.cuts = [{ start: 10.0, end: 11.0 }];
project.scenes = [{ id: 'ok', type: 'pills', start: 14.0, dur: 4.0, headline: 'Y', items: [] }];
project.captions.cues = [{ id: 'c1', start: 1.0, end: 2.0, tokens: [{ t: 'hello' }] }];
project.audio.music = [];
writeFileSync(join(ws, 'clean.json'), JSON.stringify(project, null, 1));
const clean = spawnSync('python3', [join(ROOT, 'engine/verify_project.py'),
  '--project', join(ws, 'clean.json'), '--json'], { encoding: 'utf8' });
const cleanOut = JSON.parse(clean.stdout || '{}');
if (clean.status !== 0)
  fail('a sound project was reported broken: ' + JSON.stringify(cleanOut.issues || []).slice(0, 300));

console.log(`  caught ${out.errors} errors and ${out.warnings} warnings in the broken project`);
console.log(`  passed the sound one with ${cleanOut.warnings} warning(s)`);
rmSync(ws, { recursive: true, force: true });
console.log('✓ verify: catches dropped elements, clashes, impossible timings and missing files');
