#!/usr/bin/env node
// video-style-match :: color-match.mjs
// Transfer the COLOR LOOK of a reference video onto raw footage (Reinhard-style
// mean/std match in YUV, approximated with ffmpeg eq + colorbalance). This is the
// "grade it like the reference" step — complements grade.mjs (named profiles).
//
//   node color-match.mjs --ref reference.mp4 --in raw.mp4 --out matched.mp4 [--strength 0.8] [--preview 8]
//
// It measures luma avg/range, saturation and chroma cast (U/V) on BOTH clips via
// signalstats, computes the deltas, and nudges the raw toward the reference:
//   brightness/contrast/saturation via eq; warm/cool cast via colorbalance mid/high.
// --strength scales how far toward the reference (0..1, default 0.8) so it stays natural.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2); const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[key] = true;
      else { a[key] = next; i++; }
    }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const JSON_OUT = !!args.json;
const log = (...m) => { if (!JSON_OUT) console.error(...m); };
function die(msg) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error('ERROR:', msg);
  process.exit(1);
}
if (args.help) {
  log(`color-match.mjs — grade raw footage to match a reference's look
  --ref <video>     reference whose look you want
  --in  <video>     raw footage to grade
  --out <video>     output
  --strength <0..1> how far toward the ref (default 0.8)
  --preview <sec>   render first N sec to <out>.preview for a quick look
  --crf <n> (18)  --json`);
  process.exit(0);
}
for (const k of ['ref', 'in', 'out']) if (!args[k] || args[k] === true) die(`need --${k}`);
for (const k of ['ref', 'in']) if (!existsSync(args[k])) die(`not found: ${args[k]}`);
const strength = args.strength !== undefined ? Math.max(0, Math.min(1, parseFloat(args.strength))) : 0.8;

function measure(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-t', '90', '-i', file,
    '-vf', 'fps=1,signalstats,metadata=print:file=-', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const text = (r.stdout || '') + (r.stderr || '');
  const acc = {}, cnt = {};
  for (const m of text.matchAll(/lavfi\.signalstats\.(\w+)=([-\d.]+)/g)) {
    const k = m[1], v = parseFloat(m[2]);
    if (Number.isFinite(v)) { acc[k] = (acc[k] || 0) + v; cnt[k] = (cnt[k] || 0) + 1; }
  }
  const a = {}; for (const k of Object.keys(acc)) a[k] = acc[k] / cnt[k];
  return {
    Y: a.YAVG ?? 128, range: (a.YMAX ?? 235) - (a.YMIN ?? 16),
    sat: a.SATAVG ?? 0, U: a.UAVG ?? 128, V: a.VAVG ?? 128,
  };
}
log('Measuring reference…'); const ref = measure(args.ref);
log('Measuring raw…');       const raw = measure(args.in);

// deltas → eq params, scaled by strength
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const s = strength;
// brightness: luma diff in 0..1 units (eq brightness is -1..1, ~/255)
const brightness = clamp(((ref.Y - raw.Y) / 255) * s, -0.3, 0.3);
// contrast: ratio of dynamic ranges
const contrast = clamp(1 + (((ref.range / (raw.range || 1)) - 1) * s), 0.5, 2);
// saturation: ratio of chroma energy
const saturation = clamp(1 + (((ref.sat / (raw.sat || 1)) - 1) * s), 0.3, 2.5);
// color cast: push U/V toward reference. colorbalance ranges -1..1; chroma delta ~ /112
const dU = clamp(((ref.U - raw.U) / 112) * s, -0.4, 0.4); // + = bluer
const dV = clamp(((ref.V - raw.V) / 112) * s, -0.4, 0.4); // + = redder/warmer
// map U/V deltas to colorbalance: red channel follows V, blue follows -U (approx)
const rMid = clamp(dV, -0.4, 0.4).toFixed(3);
const bMid = clamp(dU, -0.4, 0.4).toFixed(3);
const rHi = clamp(dV * 0.6, -0.3, 0.3).toFixed(3);
const bHi = clamp(dU * 0.6, -0.3, 0.3).toFixed(3);

const vf = `eq=brightness=${brightness.toFixed(4)}:contrast=${contrast.toFixed(4)}:saturation=${saturation.toFixed(4)},` +
  `colorbalance=rm=${rMid}:bm=${bMid}:rh=${rHi}:bh=${bHi}`;

const outFile = (args.preview && args.preview !== true) ? args.out.replace(/(\.\w+)$/, '.preview$1') : args.out;
const ff = ['-y'];
if (args.preview && args.preview !== true) ff.push('-t', String(parseFloat(args.preview)));
ff.push('-i', args.in, '-vf', vf, '-c:v', 'libx264', '-crf', String(args.crf || 18),
  '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'copy', outFile);

log(`\nRef  Y=${ref.Y.toFixed(0)} range=${ref.range.toFixed(0)} sat=${ref.sat.toFixed(1)} U=${ref.U.toFixed(0)} V=${ref.V.toFixed(0)}`);
log(`Raw  Y=${raw.Y.toFixed(0)} range=${raw.range.toFixed(0)} sat=${raw.sat.toFixed(1)} U=${raw.U.toFixed(0)} V=${raw.V.toFixed(0)}`);
log(`Filter: ${vf}`);
const r = spawnSync('ffmpeg', ff, { stdio: JSON_OUT ? 'pipe' : 'inherit', encoding: 'utf8' });
if (r.status !== 0) die(`ffmpeg failed (exit ${r.status})`);
if (JSON_OUT) console.log(JSON.stringify({ ok: true, ref, raw, strength: s, filter: vf, out: outFile }));
else log(`\nDone → ${outFile}`);
