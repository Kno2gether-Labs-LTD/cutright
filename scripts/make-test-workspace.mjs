// Build a deterministic test project from nothing but ffmpeg.
//
//   node scripts/make-test-workspace.mjs [dir]        # default: /tmp/cutright-test-ws
//
// Why: the test suite asserts against real media, but a contributor (or CI) has none. This
// generates an 8-second project whose audio deliberately contains two silences at known
// times, with a transcript whose word timings line up with the spoken segments — so the
// auto-cut and transcript tests are exercising the real thing, not a mock.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || '/tmp/cutright-test-ws';
const FPS = 30, W = 1920, H = 1080, DUR = 8;

// speech at 0–2.4s, 3.4–5.2s and 6.2–8s; silence in the two gaps
const SEGMENTS = [
  { start: 0.0, end: 2.4, words: ['welcome', 'to', 'the', 'test', 'project', 'everyone'] },
  { start: 3.4, end: 5.2, words: ['um', 'this', 'part', 'has', 'a', 'filler'] },
  { start: 6.2, end: 8.0, words: ['and', 'this', 'this', 'has', 'a', 'stutter'] },
];

function run(args, label) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`ffmpeg failed (${label}):\n${(r.stderr || '').slice(-800)}`);
    process.exit(1);
  }
}

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// ---- picture + audio. The audio is a tone only during the "spoken" segments, so
// silencedetect finds exactly the two gaps we designed.
const tone = SEGMENTS
  .map((s) => `between(t,${s.start},${s.end})`)
  .join('+');
run(['-hide_banner', '-y',
  '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:rate=${FPS}:duration=${DUR}`,
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${DUR}`,
  '-filter_complex', `[1:a]volume='if(${tone},0.6,0)':eval=frame[a]`,
  '-map', '0:v', '-map', '[a]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-shortest',
  join(dir, 'graded_master.mp4')], 'master');

mkdirSync(join(dir, 'overlays'), { recursive: true });

// ---- a transparent overlay clip so the overlay tests have something real to composite
run(['-hide_banner', '-y', '-f', 'lavfi',
  '-i', `color=c=red@0.0:size=${W}x${H}:rate=${FPS}:duration=2`,
  '-vf', 'format=rgba,drawbox=x=100:y=800:w=600:h=120:color=orange@0.9:t=fill',
  '-c:v', 'qtrle', '-pix_fmt', 'argb',
  join(dir, 'overlays', 'test-lower-third.mov')], 'overlay');

// ---- word-level transcript aligned to the segments
const words = [];
for (const seg of SEGMENTS) {
  const span = (seg.end - seg.start) / seg.words.length;
  seg.words.forEach((w, i) => {
    words.push({
      text: w,
      start: +(seg.start + i * span).toFixed(3),
      end: +(seg.start + (i + 1) * span - 0.02).toFixed(3),
    });
  });
}
writeFileSync(join(dir, 'transcript.json'), JSON.stringify(words, null, 1));

// ---- project.json: captions grouped three-to-a-cue, one scene, one overlay
const cues = [];
for (let i = 0; i < words.length; i += 3) {
  const g = words.slice(i, i + 3);
  cues.push({
    id: `c${String(cues.length + 1).padStart(4, '0')}`,
    start: g[0].start,
    end: Math.max(g[g.length - 1].end, g[0].start + 0.25),
    tokens: g.map((w, n) => ({ t: w.text, e: n === g.length - 1 })),
  });
}
writeFileSync(join(dir, 'project.json'), JSON.stringify({
  version: 1,
  meta: { source: 'synthetic', graded: 'graded_master.mp4', width: W, height: H, fps: FPS,
          duration: DUR, style: 'coral-ink-bone', title: 'Cutright test project' },
  grade: {},
  captions: {
    defaults: { style: 'highlight', font: '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf',
                fontsize: 60, cy: 713, color: '#FFFFFF', highlight: '#E5533D' },
    cues,
  },
  scenes: [{ id: 'intro', type: 'pills', start: 0.5, dur: 1.5, headline: 'A test scene',
             items: [{ text: 'ONE', color: 'coral' }, { text: 'TWO', color: 'lime' }] }],
  overlays: [{ id: 'ov-test', src: 'overlays/test-lower-third.mov', start: 3.0, dur: 2, x: 0, y: 0 }],
  cuts: [],
  audio: { loudnessLUFS: -14, voice: { source: 'graded' }, music: [], sfx: [] },
}, null, 2));

console.log(`test project ready: ${dir}
  ${DUR}s · ${cues.length} caption cues · 1 scene · 1 overlay
  designed silences at 2.4–3.4s and 5.2–6.2s, one filler ("um"), one stutter ("this this")
run the suite against it:
  WORK=${dir} npm run smoke`);
