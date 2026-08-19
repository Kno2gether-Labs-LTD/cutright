// Deciding what to cut by reading the words, not just the waveform.
//
// silencedetect knows when nobody is speaking. It does not know that the first take of a
// sentence was abandoned, that a thirty-second aside went nowhere, or that "let me just find
// that window… no, hang on" is dead weight even though the room was never quiet. Those are the
// cuts that make a tutorial watchable, and they need someone to read the transcript.
//
// A language model can do that. What it must never do is edit the video. Everything here treats
// the model as a source of SUGGESTIONS that are then checked against the transcript we already
// have, because the failure mode of a confident wrong answer — cutting the good take instead of
// the abandoned one — is much worse in an editor than no suggestion at all. So:
//
//   • a proposal outside the chunk the model was shown is thrown away
//   • every boundary is snapped to real word timings, so no cut ever clips a word in half
//   • a chunk where the model wants to remove most of the speech is rejected wholesale
//   • proposals never overlap the acoustic ones; silence stays the authority on silence
//   • nothing is applied — they land in the same review panel, and the user ticks them
//
// The transport lives in llm.mjs. This file is arithmetic and rules, so it can be tested
// without a network and without a key.

// About four characters to a token for English prose. Being wrong here costs a rejected request,
// so the budget is deliberately conservative.
const CHARS_PER_TOKEN = 4;

export function segmentsFrom(words, { gap = 0.6 } = {}) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text ?? w.word ?? '').trim();
    const start = +(w.start ?? w.from), end = +(w.end ?? w.to);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    // A sentence ends at punctuation or at a pause long enough to be one.
    if (!cur || start - cur.end > gap || /[.!?]$/.test(cur.text)) {
      cur = { start, end, text };
      segs.push(cur);
    } else {
      cur.end = end;
      cur.text += ' ' + text;
    }
  }
  return segs;
}

// Split into pieces small enough to send. Chunks carry whole segments so the model never sees
// half a sentence, and overlap by one segment so a cut that spans a boundary can still be seen.
export function chunk(segments, { maxTokens = 2000, overlap = 1 } = {}) {
  const budget = Math.max(400, maxTokens) * CHARS_PER_TOKEN * 0.6;   // leave room for the prompt
  const out = [];
  let cur = [];
  let size = 0;
  for (const s of segments) {
    const cost = s.text.length + 24;                                  // + the timestamp we print
    if (cur.length && size + cost > budget) {
      out.push(cur);
      cur = cur.slice(-overlap);
      size = cur.reduce((n, x) => n + x.text.length + 24, 0);
    }
    cur.push(s);
    size += cost;
  }
  if (cur.length) out.push(cur);
  return out.map((segs) => ({ segs, from: segs[0].start, to: segs[segs.length - 1].end }));
}

export const SYSTEM = [
  'You are helping edit a screen-recorded tutorial. You are given a numbered transcript with',
  'timestamps. Identify passages that should be REMOVED so the video is tighter without losing',
  'anything the viewer needs.',
  '',
  'Remove: abandoned takes and restarts, long tangents that go nowhere, repeated explanations,',
  'thinking-out-loud while looking for something, and apologies for the recording itself.',
  'Keep: anything that teaches, all instructions and results, the intro and the sign-off, and',
  'any statement the viewer would need to follow along. When unsure, KEEP it.',
  '',
  'Reply with JSON only, no prose, in this exact shape:',
  '{"cuts":[{"from":<segment number>,"to":<segment number>,"reason":"<8 words>","confidence":"high|medium|low"}]}',
  'from and to are inclusive segment numbers from the transcript. An empty list is a valid and',
  'often correct answer.',
].join('\n');

export function promptFor(ch) {
  return ch.segs.map((s, i) => `${i + 1}. [${s.start.toFixed(1)}–${s.end.toFixed(1)}] ${s.text}`).join('\n');
}

// Turn whatever came back into cuts we are willing to show — or into nothing.
export function parsePlan(raw, ch, opts = {}) {
  const { minCut = 0.4, maxFraction = 0.5 } = opts;
  let data;
  try {
    // Models wrap JSON in prose and fences no matter what they are told.
    const text = String(raw || '');
    const body = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    data = JSON.parse(body);
  } catch { return { cuts: [], rejected: 'the model did not return JSON' }; }

  const list = Array.isArray(data?.cuts) ? data.cuts : [];
  const span = ch.to - ch.from;
  const cuts = [];
  for (const c of list) {
    const a = Math.round(+c.from), b = Math.round(+c.to);
    // A segment number outside what it was shown means it invented one.
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 1 || b < a || b > ch.segs.length) continue;
    // Snapping to the segments themselves is what makes a half-clipped word impossible.
    const start = ch.segs[a - 1].start;
    const end = ch.segs[b - 1].end;
    if (end - start < minCut) continue;
    if (start < ch.from - 0.01 || end > ch.to + 0.01) continue;
    cuts.push({
      start: +start.toFixed(3), end: +end.toFixed(3), reason: 'ai',
      label: String(c.reason || 'suggested by the model').slice(0, 70),
      confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'low',
    });
  }

  // A model that wants to delete most of what it was shown has misunderstood the job. One bad
  // chunk should not take the whole transcript with it, so the chunk is dropped, not the run.
  const removed = cuts.reduce((n, c) => n + (c.end - c.start), 0);
  if (span > 0 && removed > span * maxFraction) {
    return { cuts: [], rejected: `it wanted to remove ${Math.round((removed / span) * 100)}% of this passage` };
  }
  return { cuts, rejected: null };
}

// Silence is measured; the model is guessing. Where they disagree the measurement wins, and an
// AI proposal that merely restates a silence adds nothing to review.
export function merge(acoustic, ai, { pad = 0.05 } = {}) {
  const out = [...acoustic];
  const hits = (c, d) => c.start < d.end - pad && c.end > d.start + pad;
  for (const c of ai) {
    if (out.some((d) => hits(c, d))) continue;
    out.push(c);
  }
  return out.sort((x, y) => x.start - y.start);
}

export const _internals = { CHARS_PER_TOKEN };
