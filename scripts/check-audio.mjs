// Music has to step back under the voice.
//
//   node scripts/check-audio.mjs
//
// A fixed gain cannot do this: a bed that works in the gaps is too loud under a sentence, and one
// that works under a sentence is inaudible in the gaps. So each music layer is side-chained to the
// voice. Whether that is actually happening is not something you can see in a filter graph — it
// has to be measured, and measured in a band the voice cannot reach, or its own harmonics
// contaminate the reading and hide the effect. (They did, the first time: a 300 Hz voice put its
// third harmonic straight into the 880 Hz band being measured.)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ws = mkdtempSync(join(tmpdir(), 'cutright-audio-'));
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', cwd: ws, ...opts });
const fail = (m) => { console.error('✗ ' + m); rmSync(ws, { recursive: true, force: true }); process.exit(1); };

mkdirSync(join(ws, 'audio'), { recursive: true });

// a voice at 120 Hz that speaks from 2s to 6s, and a bed at 2 kHz — far enough apart that the
// voice's harmonics do not land in the band we measure
const v = run('ffmpeg', ['-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=10',
  '-f', 'lavfi', '-i', 'sine=frequency=120:duration=10',
  '-filter_complex', "[1:a]volume='if(between(t,2,6),0.9,0)':eval=frame[a]",
  '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'graded_master.mp4']);
if (v.status !== 0) fail('could not build the fixture: ' + v.stderr);
run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=2000:duration=10',
  '-c:a', 'pcm_s16le', 'audio/bed.wav']);

const base = {
  version: 1,
  meta: { graded: 'graded_master.mp4', width: 640, height: 360, fps: 30, duration: 10 },
  grade: {}, captions: { defaults: {}, cues: [] }, scenes: [], overlays: [], cuts: [],
  audio: { loudnessLUFS: -16, sfx: [],
           music: [{ id: 'bed', src: 'audio/bed.wav', start: 0, dur: 10, gain: -10 }] },
};
writeFileSync(join(ws, 'ducked.json'), JSON.stringify(base));
writeFileSync(join(ws, 'flat.json'), JSON.stringify({ ...base, audio: { ...base.audio, duck: false } }));

for (const name of ['flat', 'ducked']) {
  const r = run('python3', [join(ROOT, 'engine/render_project.py'),
    '--project', `${name}.json`, '--out', `${name}.mp4`]);
  if (r.status !== 0) fail(`${name} render failed:\n${(r.stderr || r.stdout || '').slice(-600)}`);
}

const band = (file, t0, t1) => {
  const r = run('ffmpeg', ['-hide_banner', '-ss', String(t0), '-t', String(t1 - t0), '-i', file,
    '-af', 'highpass=f=1700,lowpass=f=2300,volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(r.stderr || '');
  if (!m) fail('could not measure ' + file);
  return +m[1];
};

const read = (name) => {
  const gap = band(`${name}.mp4`, 7.0, 9.5);        // nobody talking
  const under = band(`${name}.mp4`, 3.0, 5.5);      // someone talking
  console.log(`  ${name.padEnd(7)} bed in the gap ${gap.toFixed(1)} dB · under speech ${under.toFixed(1)} dB `
            + `· steps back ${(gap - under).toFixed(1)} dB`);
  return gap - under;
};

const flat = read('flat');
const ducked = read('ducked');

if (flat > 2)
  fail(`the bed already changes by ${flat.toFixed(1)} dB with ducking off — the measurement is `
     + 'picking up something other than the bed');
if (ducked < 4)
  fail(`the bed only steps back ${ducked.toFixed(1)} dB under speech — that is not audible ducking`);
if (ducked - flat < 3)
  fail(`ducking made almost no difference (${ducked.toFixed(1)} dB against ${flat.toFixed(1)} dB off)`);

// and the bed must come back up afterwards, or it is just a quieter bed
const gapDucked = band('ducked.mp4', 7.0, 9.5), gapFlat = band('flat.mp4', 7.0, 9.5);
if (gapDucked < gapFlat - 3)
  fail(`the bed never recovers in the gaps (${gapDucked.toFixed(1)} dB vs ${gapFlat.toFixed(1)} dB unducked)`);

rmSync(ws, { recursive: true, force: true });
console.log('✓ audio: music steps back under the voice and comes up again in the gaps');
