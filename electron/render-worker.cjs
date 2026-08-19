// Render worker — runs in an Electron `utilityProcess` (its own OS process).
// It owns the whole child tree (python render engine → ffmpeg) so a hung or crashed
// render can never touch the main thread or the window. Progress is pushed straight to
// the renderer over a MessagePort handed to us by main.
//
// Phase 4 will replace the Python engine with a Node/Skia one; the contract here
// (start / progress / done) is engine-agnostic on purpose.
const { spawn } = require('node:child_process');
const { readFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, openSync, readSync, closeSync } = require('node:fs');
const { join } = require('node:path');

const IDLE_KILL_MS = 20 * 60 * 1000;   // no output at all for 20 min → assume hung
const STALL_WARN_MS = 90 * 1000;       // tell the UI we look stalled
const HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000;

let port = null, child = null, job = null, tmpDir = null;

// Keep the most recent few failed-render directories and drop the rest.
function pruneRenderTmp(root, keep) {
  try {
    const dirs = readdirSync(root)
      .map((n) => ({ n, p: join(root, n) }))
      .map((d) => { try { return { ...d, t: statSync(d.p).mtimeMs }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(keep)) { try { rmSync(d.p, { recursive: true, force: true }); } catch {} }
  } catch { /* nothing to prune */ }
}

let lastActivity = Date.now(), warned = false, ticker = null, finished = false, cancelled = false;

const post = (m) => { try { port?.postMessage(m); } catch {} };

process.parentPort.on('message', (e) => {
  const msg = e.data;
  if (msg?.type === 'port') { port = e.ports[0]; port.start?.(); return; }
  if (msg?.type === 'start') return start(msg.job);
  if (msg?.type === 'cancel') return cancel();
});

// --- stage model: each ffmpeg pass writes its own log in tmp; we tail the newest one ---
const STAGES = [
  [/^seg_\d+\.log$/, 'cuts'],
  [/^cut_concat\.log$/, 'cuts'],
  [/^base\.log$/, 'captions'],
  [/^clip_.*\.log$/, 'scenes'],
  [/^scenes_overlay\.log$/, 'scenes'],
  [/^audio_mix\.log$/, 'audio'],
];
const stageOf = (f) => (STAGES.find(([re]) => re.test(f)) || [, 'render'])[1];
const ORDER = ['cuts', 'captions', 'scenes', 'audio'];

function tail(file, bytes = 8192) {
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
const hms = (s) => { const m = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

let best = { pct: 0, stage: null, stageIdx: -1 };

function pollProgress(span) {
  if (!tmpDir || !existsSync(tmpDir)) return;
  let newest = null, mtime = 0;
  for (const f of readdirSync(tmpDir)) {
    if (!f.endsWith('.log')) continue;
    try { const st = statSync(join(tmpDir, f)); if (st.mtimeMs > mtime) { mtime = st.mtimeMs; newest = f; } } catch {}
  }
  if (!newest) return;
  const txt = tail(join(tmpDir, newest));
  const times = txt.match(/time=\s*([\d:.]+)/g);
  if (!times) return;
  const t = hms(times[times.length - 1]);
  if (t == null) return;
  const stage = stageOf(newest);
  const stageIdx = ORDER.indexOf(stage);
  if (stageIdx >= 0 && stageIdx < best.stageIdx) return;   // stages only move forward
  // % is within the current stage: each ffmpeg pass walks the same 0→span timeline
  const pct = span > 0 ? Math.min(100, Math.round((t / span) * 100)) : 0;
  if (stage === best.stage && pct === best.pct) return;    // nothing new to say
  best = { pct, stage, stageIdx };
  lastActivity = Date.now(); warned = false;
  post({ type: 'progress', stage, pct, t, span });
}

function start(j) {
  job = j; finished = false; best = { pct: 0, stage: null, stageIdx: -1 };
  const engineScript = join(job.engine, 'render_project.py');
  if (!existsSync(engineScript)) return done({ type: 'error', error: 'render engine not found: ' + engineScript });
  if (!existsSync(job.project)) return done({ type: 'error', error: 'no project.json: ' + job.project });

  // how long is the thing we are rendering? (drives the % + the watchdog)
  let span = 0;
  try {
    const P = JSON.parse(readFileSync(job.project, 'utf8'));
    span = job.range ? Math.max(0.1, job.range[1] - job.range[0]) : (P?.meta?.duration || 0);
  } catch {}

  tmpDir = join(job.work, '.cve_render', job.id);
  try { mkdirSync(tmpDir, { recursive: true }); } catch (e) { return done({ type: 'error', error: 'tmp dir: ' + e.message }); }

  const args = [engineScript, '--project', job.project, '--out', job.out, '--tmp', tmpDir];
  if (job.range) args.push('--range', String(job.range[0]), String(job.range[1]));
  if (job.layers) args.push('--layers', job.layers);
  // A preview is a cheaper encode that keeps the cut master between runs, so rebuilding one
  // after every edit costs seconds rather than most of a minute. It is never used for an export.
  if (job.preview) args.push('--preview');
  if (job.noCuts) args.push('--no-cuts');

  post({ type: 'start', id: job.id, out: job.out, range: job.range, span, args: args.slice(1) });

  // detached → we can kill the whole tree (python + its ffmpeg children) on cancel
  child = spawn(job.python || 'python3', args, { cwd: job.work, env: process.env, detached: true });
  let buf = '';
  const onOut = (d) => {
    const s = d.toString(); buf = (buf + s).slice(-4000); lastActivity = Date.now(); warned = false;
    const line = s.trim(); if (line) post({ type: 'log', line: line.slice(-500) });
  };
  child.stdout.on('data', onOut);
  child.stderr.on('data', onOut);
  child.on('error', (e) => done({ type: 'error', error: e.message }));
  child.on('close', (code) => {
    let result = null;
    try { result = JSON.parse(buf.trim().split('\n').pop()); } catch {}
    // keep the tmp dir only when it can still be useful: a genuine failure to debug
    if (code === 0 || cancelled) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    // A failed render keeps its working files, because they are the only way to find out why.
    // Keeping ALL of them is how a project folder quietly fills up — each is a few hundred
    // megabytes, and a preview now rebuilds whenever the edit settles.
    else pruneRenderTmp(join(job.work, '.cve_render'), 3);
    done({ type: 'done', code, out: job.out, result, tail: buf.slice(-800) });
  });

  const started = Date.now();
  ticker = setInterval(() => {
    pollProgress(span);
    const idle = Date.now() - lastActivity;
    if (idle > STALL_WARN_MS && !warned) { warned = true; post({ type: 'stall', idleMs: idle, stage: best.stage }); }
    if (idle > IDLE_KILL_MS) { post({ type: 'log', line: `watchdog: no output for ${Math.round(idle / 1000)}s — killing` }); cancel(); }
    if (Date.now() - started > HARD_TIMEOUT_MS) { post({ type: 'log', line: 'watchdog: hard timeout' }); cancel(); }
  }, 1000);
}

function cancel() {
  cancelled = true;
  if (!child) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

function done(msg) {
  if (finished) return;
  finished = true;
  clearInterval(ticker);
  post(msg);
  setTimeout(() => process.exit(0), 150);
}
