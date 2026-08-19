// Recording — the main-process half.
//
// The renderer captures (MediaRecorder is a renderer API) and streams chunks here; this
// module owns everything that touches the disk or the OS: where recordings live, appending
// chunks, sampling the cursor, and turning a finished recording into a project.
//
// Two rules learned the hard way and encoded here:
//   1. Never buffer a recording in memory — chunks are appended as they arrive.
//   2. Never finalise before every pending chunk has landed, or the file has no moov atom
//      and nothing can read it.
import { createWriteStream, mkdirSync, existsSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');

export function defaultRecordingsDir(app) {
  // ~/Movies/Cutright on macOS, Videos elsewhere — where a person expects footage to be.
  try { return join(app.getPath('videos'), 'Cutright'); }
  catch { return join(app.getPath('home'), 'Cutright'); }
}

export function newRecordingFolder(baseDir, name) {
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const safe = String(name || 'Recording').replace(/[^\w \-]+/g, '').trim().slice(0, 40) || 'Recording';
  let dir = join(baseDir, `${stamp} ${safe}`);
  let n = 2;
  while (existsSync(dir)) dir = join(baseDir, `${stamp} ${safe} (${n++})`);
  mkdirSync(join(dir, 'recording'), { recursive: true });
  return dir;
}

export class RecordingSession {
  constructor({ dir, screenPoint, displays, log = () => {} }) {
    this.dir = dir;
    this.log = log;
    this.startedAt = Date.now();
    this.streams = {};                 // track name → write stream
    this.bytes = {};
    this.cursor = [];                  // { t, x, y } with x/y normalised 0..1
    this.events = [];                  // { t, type } — clicks etc. when available
    this.paused = false;
    this.pausedFor = 0;
    this.pausedAt = null;
    this.displays = displays;
    this.screenPoint = screenPoint;    // injected so this stays testable without Electron
    this.timer = null;
  }

  get elapsed() {
    const base = (Date.now() - this.startedAt - this.pausedFor) / 1000;
    return Math.max(0, this.paused && this.pausedAt ? (this.pausedAt - this.startedAt - this.pausedFor) / 1000 : base);
  }

  file(track) { return join(this.dir, 'recording', track === 'camera' ? 'camera.mp4' : 'screen.mp4'); }

  open(track) {
    if (this.streams[track]) return;
    this.streams[track] = createWriteStream(this.file(track));
    this.bytes[track] = 0;
    this.log('recording → ' + this.file(track));
  }

  write(track, buffer) {
    if (!this.streams[track]) this.open(track);
    this.streams[track].write(Buffer.from(buffer));
    this.bytes[track] += buffer.byteLength ?? buffer.length ?? 0;
    return this.bytes[track];
  }

  // Cursor position costs nothing to sample and needs no permission, unlike a global
  // input hook. 60 Hz is plenty to reconstruct dwell and travel later.
  startCursor(hz = 60) {
    const display = this.displays?.[0];
    const w = display?.bounds?.width || display?.size?.width || 1920;
    const h = display?.bounds?.height || display?.size?.height || 1080;
    const ox = display?.bounds?.x || 0, oy = display?.bounds?.y || 0;
    this.timer = setInterval(() => {
      if (this.paused) return;
      try {
        const p = this.screenPoint();
        this.cursor.push({
          t: +this.elapsed.toFixed(3),
          x: +Math.min(1, Math.max(0, (p.x - ox) / w)).toFixed(4),
          y: +Math.min(1, Math.max(0, (p.y - oy) / h)).toFixed(4),
        });
      } catch { /* a sampling hiccup must never stop a recording */ }
    }, Math.round(1000 / hz));
  }

  pause() { if (!this.paused) { this.paused = true; this.pausedAt = Date.now(); } }
  resume() {
    if (this.paused && this.pausedAt) { this.pausedFor += Date.now() - this.pausedAt; }
    this.paused = false; this.pausedAt = null;
  }

  mark(type, at) { this.events.push({ t: at ?? +this.elapsed.toFixed(3), type }); }

  async finish() {
    clearInterval(this.timer);
    const closes = Object.values(this.streams).map((s) => new Promise((r) => s.end(r)));
    await Promise.all(closes);

    const cursorPath = join(this.dir, 'recording', 'cursor.json');
    writeFileSync(cursorPath, JSON.stringify({
      hz: 60, duration: +this.elapsed.toFixed(3),
      display: this.displays?.[0]?.size || null,
      samples: this.cursor, events: this.events,
    }));

    const tracks = {};
    for (const t of Object.keys(this.streams)) {
      const f = this.file(t);
      tracks[t] = existsSync(f) ? { path: f, bytes: statSync(f).size } : null;
    }
    return {
      dir: this.dir, tracks, cursor: cursorPath,
      duration: +this.elapsed.toFixed(3),
      samples: this.cursor.length, events: this.events.length,
    };
  }
}

// Analysis of a finished cursor track → the moments worth zooming into. Pure function so it
// can be tested against synthetic tracks with known dwells.
export function proposeZooms({ samples = [], events = [], duration = 0, words = [] }, opts = {}) {
  const {
    dwellSeconds = 0.9,        // how long the cursor must settle to count as "doing something"
    moveThreshold = 0.012,     // normalised distance that counts as movement
    minGap = 3.0,              // never stack zooms on top of each other
    zoomDur = 3.2,
    scale = 1.8,
    maxZooms = 12,
  } = opts;

  // Collect every candidate first. Spacing them out has to happen in TIME order, not in the
  // order the detectors happen to run, or an early dwell gets rejected for being "too close"
  // to a later click.
  const candidates = [];
  const PRIORITY = { click: 3, dwell: 2, transcript: 1 };
  const push = (p) => candidates.push(p);

  // 1. real clicks, when a hook gave us any — the strongest signal there is
  for (const e of events.filter((e) => e.type === 'click')) {
    const near = samples.reduce((best, s) =>
      Math.abs(s.t - e.t) < Math.abs(best.t - e.t) ? s : best, samples[0] || { x: 0.5, y: 0.5, t: 0 });
    push({ start: Math.max(0, e.t - 0.6), dur: zoomDur, x: near.x, y: near.y, scale,
           source: 'click', why: 'you clicked here' });
  }

  // 2. dwells: the cursor arrives somewhere and stays. In a tutorial that is almost always
  //    the moment worth seeing — typing in a field, hovering the thing being explained.
  let anchor = samples[0];
  let since = samples[0]?.t ?? 0;
  for (const s of samples) {
    if (!anchor) { anchor = s; since = s.t; continue; }
    const moved = Math.hypot(s.x - anchor.x, s.y - anchor.y);
    if (moved > moveThreshold) { anchor = s; since = s.t; continue; }
    const held = s.t - since;
    if (held >= dwellSeconds) {
      push({ start: Math.max(0, since - 0.3), dur: Math.min(zoomDur, Math.max(2, held + 1)),
             x: anchor.x, y: anchor.y, scale, source: 'dwell',
             why: `the cursor settled here for ${held.toFixed(1)}s` });
      anchor = null;                        // wait for the next arrival
    }
  }

  // 3. what the speaker emphasised — "look at this", "notice", "important"
  const CUES = /\b(look at|notice|watch|here you (can )?see|this is the|important|the key|pay attention)\b/i;
  if (words.length) {
    const text = words.map((w) => w.text).join(' ');
    let idx = 0;
    for (const w of words) {
      const window = words.slice(idx, idx + 8).map((x) => x.text).join(' ');
      if (CUES.test(window)) {
        const at = w.start;
        const near = samples.reduce((best, s) =>
          Math.abs(s.t - at) < Math.abs(best.t - at) ? s : best, samples[0]);
        if (near) push({ start: Math.max(0, at - 0.4), dur: zoomDur, x: near.x, y: near.y,
                         scale: 1.6, source: 'transcript', why: `you said “${window.slice(0, 40)}…”` });
      }
      idx++;
    }
    void text;
  }

  const inRange = candidates
    .filter((p) => p.start + 0.5 < (duration || Infinity))
    .sort((a, b) => a.start - b.start);

  // Greedy spacing: when two land within minGap, the stronger signal wins.
  const kept = [];
  for (const p of inRange) {
    const last = kept[kept.length - 1];
    if (!last || p.start - last.start >= minGap) { kept.push(p); continue; }
    if ((PRIORITY[p.source] || 0) > (PRIORITY[last.source] || 0)) kept[kept.length - 1] = p;
  }

  return kept
    .slice(0, maxZooms)
    .map((p, i) => ({ id: `z${i + 1}`, ...p, start: +p.start.toFixed(2), dur: +p.dur.toFixed(2) }));
}
