// Analysis worker — runs in a utilityProcess (never the main thread).
//
// Produces CUT PROPOSALS for a talking-head edit by combining two independent signals:
//   1. audio  — ffmpeg `silencedetect` finds real dead air (the truth about the waveform)
//   2. text   — the word-level transcript finds fillers ("um"), stutters ("the the")
//               and, crucially, tells us where speech actually is
//
// The rule that keeps it safe: ffmpeg measured the waveform, so silencedetect decides
// what is audible — every silence cut is shrunk by `pad` at both ends so a breath and the
// attack of the next word survive, and anything shorter than `minCut` is dropped. Word
// timings are used for fillers/stutters and to flag (not veto) an odd-looking silence,
// because Whisper routinely stretches a word across the pause that follows it.
const { spawn } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'ehm', 'hmm', 'mmm', 'ah', 'er', 'uhm']);
// Only ever cut these when they stand alone between pauses — they are real words too.
const SOFT_FILLERS = new Set(['like', 'basically', 'actually', 'literally', 'right']);

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (msg?.type !== 'analyze' && msg?.type !== 'screen') return;
  try {
    const result = msg.type === 'screen' ? await analyzeScreen(msg.job) : await analyze(msg.job);
    process.parentPort.postMessage({ type: 'result', ...result });
  } catch (err) {
    process.parentPort.postMessage({ type: 'error', error: err?.message || String(err) });
  }
  setTimeout(() => process.exit(0), 100);
});

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env });
    let out = '';
    const feed = (d) => { const s = d.toString(); out += s; if (onLine) s.split('\n').forEach(onLine); };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function analyze(job) {
  const {
    work, media, transcript,
    noiseDb = -32,           // what counts as "silent"
    minSilence = 0.7,        // ignore shorter gaps
    pad = 0.12,              // leave this much silence either side of speech
    minCut = 0.35,           // never propose a cut shorter than this
    fillers = true,
    stutters = true,
    softFillers = false,
    duration = 0,
  } = job;

  const mediaPath = media.startsWith('/') ? media : join(work, media);
  if (!existsSync(mediaPath)) throw new Error('media not found: ' + mediaPath);

  // ---- 1. audio: where is it actually silent? ----
  const silences = [];
  let pendingStart = null;
  await run('ffmpeg', ['-hide_banner', '-nostats', '-i', mediaPath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, '-f', 'null', '-'], (line) => {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (s) pendingStart = parseFloat(s[1]);
    if (e && pendingStart != null) { silences.push([Math.max(0, pendingStart), parseFloat(e[1])]); pendingStart = null; }
  });
  // a trailing silence that runs to the end of the file
  if (pendingStart != null && duration) silences.push([pendingStart, duration]);

  // ---- 2. text: word timings (speech we must never clip) ----
  let words = [];
  const tPath = transcript && (transcript.startsWith('/') ? transcript : join(work, transcript));
  if (tPath && existsSync(tPath)) {
    try {
      const raw = JSON.parse(readFileSync(tPath, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.words || raw.transcript || []);
      words = list
        .map((w) => ({ text: String(w.text ?? w.word ?? '').trim(), start: +(w.start ?? w.from), end: +(w.end ?? w.to) }))
        .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end))
        .sort((a, b) => a.start - b.start);
    } catch { /* transcript optional */ }
  }

  const proposals = [];

  // Silence → cut. ffmpeg measured the actual waveform, so it is the authority on what
  // is audible; Whisper word timings routinely stretch across a pause and must NOT be
  // used to veto a silence (doing so drops every real cut). We only shrink by `pad` so a
  // breath and the attack of the next word survive.
  for (const [s0, e0] of silences) {
    const s = s0 + pad, e = e0 - pad;
    if (e - s < minCut) continue;
    const inSpeech = words.length
      ? words.some((w) => w.start < e - 0.15 && w.end > s + 0.15 && (w.end - w.start) < (e - s))
      : false;
    proposals.push({
      start: round(s), end: round(e), reason: 'silence',
      label: `${(e - s).toFixed(1)}s of silence`,
      // a whole word living inside the "silence" is the one case worth a second look
      confidence: inSpeech ? 'low' : (e - s > 1.2 ? 'high' : 'medium'),
    });
  }

  // Dead air at the top and tail of the recording (the "3, 2, 1…" and the walk-back).
  if (words.length && duration) {
    const firstWord = words[0].start, lastWord = words[words.length - 1].end;
    if (firstWord - pad > minCut) {
      proposals.push({ start: 0, end: round(firstWord - pad), reason: 'silence',
        label: `${(firstWord - pad).toFixed(1)}s before the first word`, confidence: 'high' });
    }
    if (duration - lastWord - pad > minCut) {
      proposals.push({ start: round(lastWord + pad), end: round(duration), reason: 'silence',
        label: `${(duration - lastWord - pad).toFixed(1)}s after the last word`, confidence: 'high' });
    }
  }

  // filler words → cut the word plus the hesitation around it
  if (words.length) {
    const gapBefore = (i) => (i > 0 ? words[i].start - words[i - 1].end : 9);
    const gapAfter = (i) => (i < words.length - 1 ? words[i + 1].start - words[i].end : 9);
    words.forEach((w, i) => {
      const clean = w.text.toLowerCase().replace(/[^a-z']/g, '');
      const isFiller = fillers && FILLERS.has(clean);
      const isSoft = softFillers && SOFT_FILLERS.has(clean) && gapBefore(i) > 0.25 && gapAfter(i) > 0.25;
      if (!isFiller && !isSoft) return;
      const s = w.start - Math.min(0.12, gapBefore(i) / 2);
      const e = w.end + Math.min(0.12, gapAfter(i) / 2);
      if (e - s >= 0.12) {
        proposals.push({ start: round(s), end: round(e), reason: 'filler',
          label: `filler “${w.text}”`, confidence: isFiller ? 'high' : 'low' });
      }
    });

    // stutters / immediate repeats: "the the", "I I", "we we would"
    if (stutters) {
      for (let i = 1; i < words.length; i++) {
        const a = words[i - 1].text.toLowerCase().replace(/[^a-z']/g, '');
        const b = words[i].text.toLowerCase().replace(/[^a-z']/g, '');
        if (!a || a !== b) continue;
        if (words[i].start - words[i - 1].end > 0.6) continue;      // a deliberate repeat, not a stutter
        proposals.push({ start: round(words[i - 1].start), end: round(words[i].start - 0.02), reason: 'stutter',
          label: `stutter “${a} ${a}”`, confidence: 'medium' });
      }
    }
  }

  // merge overlaps, keep it sorted, and report what we found
  proposals.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const p of proposals) {
    const last = merged[merged.length - 1];
    if (last && p.start <= last.end + 0.05) {
      last.end = Math.max(last.end, p.end);
      last.label = `${last.label} + ${p.label}`;
      last.reason = last.reason === p.reason ? last.reason : 'mixed';
    } else merged.push({ ...p });
  }

  const removed = merged.reduce((a, p) => a + (p.end - p.start), 0);
  return {
    proposals: merged,
    stats: {
      silences: silences.length, words: words.length, proposals: merged.length,
      removedSeconds: round(removed),
      newDuration: duration ? round(duration - removed) : null,
    },
  };
}

const round = (n) => Math.round(n * 100) / 100;


// ---------------------------------------------------------------- screen activity
// When a screen recording stops changing — the presenter is talking through an idea, not
// demonstrating anything — the screen is the least interesting thing on it. Those stretches are
// where the speaker should have the frame.
//
// Measured, not guessed: consecutive frames are differenced (tblend) and the mean brightness of
// that difference is the activity score. A cursor drifting registers near zero; typing, scrolling
// and window changes do not. Sampled at 4 fps, which is enough to see a paragraph of typing and
// cheap enough to run on a half-hour recording.
async function analyzeScreen(job) {
  const {
    media, work,
    fps = 4,
    quietScore = 1.2,      // mean frame-to-frame difference below this is "nothing is happening"
    minQuiet = 6,          // shorter than this and cutting to the speaker is just a twitch
    maxQuiet = 45,         // longer than this and the speaker outstays their welcome too
    lead = 0.6,            // let the screen settle before leaving it
  } = job;

  const src = media.startsWith('/') ? media : join(work, media);
  if (!existsSync(src)) throw new Error('no screen recording at ' + src);

  const scores = [];
  await run('ffmpeg', ['-hide_banner', '-nostats', '-i', src,
    '-vf', `fps=${fps},scale=320:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    '-an', '-f', 'null', '-'], (line) => {
    const m = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (m) scores.push(+m[1]);
  });
  if (!scores.length) throw new Error('could not measure the screen (no frames analysed)');

  // a word-level transcript tells us whether anyone is actually talking through the quiet bit
  let words = [];
  try { words = JSON.parse(readFileSync(join(work, 'transcript.json'), 'utf8')); } catch {}
  const talking = (from, to) => {
    if (!words.length) return true;                      // no transcript: do not veto anything
    const spoken = words.filter((w) => +w.end > from && +w.start < to)
      .reduce((a, w) => a + Math.min(to, +w.end) - Math.max(from, +w.start), 0);
    return spoken > (to - from) * 0.45;                  // mostly talking, not mostly silence
  };

  const t = (i) => i / fps;
  const windows = [];
  let run0 = null;
  scores.forEach((v, i) => {
    if (v < quietScore) { if (run0 === null) run0 = i; return; }
    if (run0 !== null) { windows.push([t(run0), t(i)]); run0 = null; }
  });
  if (run0 !== null) windows.push([t(run0), t(scores.length)]);

  const proposals = [];
  for (const [s0, e0] of windows) {
    const start = s0 + lead, end = Math.min(e0 - lead * 0.5, s0 + lead + maxQuiet);
    if (end - start < minQuiet) continue;
    if (!talking(start, end)) continue;                  // silence that auto-cut will remove anyway
    const inWindow = scores.slice(Math.round(s0 * fps), Math.round(e0 * fps));
    proposals.push({
      start: round(start), end: round(end),
      reason: 'screen-static',
      confidence: end - start > minQuiet * 2 ? 'high' : 'medium',
      label: `nothing changing on screen for ${(e0 - s0).toFixed(0)}s`,
      activity: round(inWindow.reduce((a, b) => a + b, 0) / Math.max(1, inWindow.length)),
    });
  }

  const busy = scores.filter((v) => v >= quietScore).length / scores.length;
  return {
    proposals,
    stats: {
      sampled: scores.length, seconds: round(scores.length / fps),
      busyFraction: round(busy), quietWindows: windows.length,
      words: words.length,
    },
  };
}

// Also required directly by the preprocess pass, which runs the same analyses in order without
// a round trip through the UI. Harmless when this file is forked as a worker.
module.exports = { analyze, analyzeScreen };
