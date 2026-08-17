#!/usr/bin/env node
// precision-video-edit :: grade.mjs
// Color grading by VIDEO TYPE. Four built-in look profiles, each a standard
// ffmpeg filter chain (eq / curves / colorbalance / vignette / unsharp).
// Also supports a .cube LUT via lut3d. Audio is passed through untouched.
//
//   node grade.mjs --in clip.mp4 --profile tutorial|cinematic|vlog|product --out graded.mp4
//   node grade.mjs --in clip.mp4 --lut looks/myfilm.cube --out graded.mp4
//   node grade.mjs --list
//   node grade.mjs --in clip.mp4 --profile cinematic --strength 0.6 --preview 8   # 8s test render
//
// Credible basis: ffmpeg lut3d/eq/curves/colorbalance (the standard grading stack,
// same primitives the FFmpeg color-grading Claude skill and agentic-color-grader use).

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

// ---- profiles: eq params lerp with --strength; extras applied as-is (s>0) ----
// Each profile: { eq:{contrast,saturation,brightness,gamma}, extra:[filters], note }
const PROFILES = {
  tutorial: {
    note: 'Neutral, high-legibility. Protects on-screen UI/text — minimal saturation, light sharpen.',
    eq: { contrast: 1.04, saturation: 1.03, brightness: 0.01, gamma: 1.00 },
    extra: ['unsharp=3:3:0.3:3:3:0.0'],
  },
  cinematic: {
    note: 'Teal-orange, lifted contrast, gentle vignette — dramatic story look.',
    eq: { contrast: 1.12, saturation: 1.12, brightness: 0.00, gamma: 0.98 },
    // push shadows toward teal (blue up / red down in lows), warm the highlights
    extra: [
      "curves=r='0/0.00 0.25/0.22 0.75/0.80 1/1':b='0/0.06 0.5/0.5 1/0.94'",
      'colorbalance=rs=-0.06:bs=0.06:rh=0.06:bh=-0.06',
      'vignette=PI/5',
    ],
  },
  vlog: {
    note: 'Warm, flattering skin tones, soft contrast — talking-head / lifestyle.',
    eq: { contrast: 1.05, saturation: 1.08, brightness: 0.015, gamma: 1.02 },
    extra: ['colorbalance=rm=0.04:gm=0.01:bh=-0.03'],
  },
  product: {
    note: 'Punchy, clean, vivid-but-accurate — product / demo clarity.',
    eq: { contrast: 1.08, saturation: 1.14, brightness: 0.01, gamma: 1.00 },
    extra: ['unsharp=5:5:0.5:5:5:0.0'],
  },
};

if (args.list || args.help) {
  if (JSON_OUT) { console.log(JSON.stringify({ ok: true, profiles: PROFILES }, null, 2)); process.exit(0); }
  log('grade.mjs — color grade by video type\n');
  for (const [k, p] of Object.entries(PROFILES)) log(`  ${k.padEnd(10)} ${p.note}`);
  log(`\n  --in <file> --profile <name> --out <file>
  --lut <file.cube>     apply a 3D LUT (before/instead of a profile's grade)
  --strength <0..2>     scale the grade intensity (default 1; 0 = passthrough)
  --preview <sec>       render only the first N seconds as <out>.preview.mp4 for a quick look
  --crf <n> (18)  --json`);
  process.exit(0);
}

if (!args.in) die('need --in <file>');
if (!existsSync(args.in)) die(`input not found: ${args.in}`);
if (!args.out) die('need --out <file>');
const useLut = args.lut && args.lut !== true;
if (!args.profile && !useLut) die('need --profile <tutorial|cinematic|vlog|product> or --lut <file.cube>');
if (args.profile && args.profile !== true && !PROFILES[args.profile]) die(`unknown profile: ${args.profile} (try --list)`);

const s = args.strength !== undefined ? Math.max(0, parseFloat(args.strength)) : 1;
const lerp = (neutral, target) => (neutral + (target - neutral) * s);

const chain = [];
if (useLut) {
  if (!existsSync(args.lut)) die(`LUT not found: ${args.lut}`);
  chain.push(`lut3d='${args.lut.replace(/'/g, "\\'")}'`);
}
if (args.profile && args.profile !== true && s > 0) {
  const p = PROFILES[args.profile];
  const eq = p.eq;
  const eqStr = `eq=contrast=${lerp(1, eq.contrast).toFixed(4)}:saturation=${lerp(1, eq.saturation).toFixed(4)}` +
    `:brightness=${lerp(0, eq.brightness).toFixed(4)}:gamma=${lerp(1, eq.gamma).toFixed(4)}`;
  chain.push(eqStr, ...p.extra);
}
if (!chain.length) {
  log('strength=0 and no LUT — nothing to grade; copying through.');
}
const vf = chain.join(',');

const outFile = (args.preview && args.preview !== true) ? args.out.replace(/(\.\w+)$/, '.preview$1') : args.out;
const ff = ['-y'];
if (args.preview && args.preview !== true) ff.push('-t', String(parseFloat(args.preview)));
ff.push('-i', args.in);
if (vf) ff.push('-vf', vf);
ff.push('-c:v', 'libx264', '-crf', String(args.crf || 18), '-preset', args.preset || 'medium',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'copy', outFile);

log(`Grading (${useLut ? 'LUT ' : ''}${args.profile && args.profile !== true ? args.profile : ''}, strength=${s})…`);
if (vf) log('  filter:', vf);
log('  $ ffmpeg', ff.join(' '));
const r = spawnSync('ffmpeg', ff, { stdio: JSON_OUT ? 'pipe' : 'inherit', encoding: 'utf8' });
if (r.status !== 0) die(`ffmpeg failed (exit ${r.status})`);

if (JSON_OUT) console.log(JSON.stringify({ ok: true, profile: args.profile || null, lut: useLut ? args.lut : null, strength: s, filter: vf, out: outFile }));
else log(`\nDone → ${outFile}`);
