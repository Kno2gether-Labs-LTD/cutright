// Transcription worker — runs in a utilityProcess.
//
// Turns the workspace's media into a word-level `transcript.json`, which is what the
// caption builder and the auto-cut analysis both consume. Engines:
//
//   hyperframes  (local, default)  npx hyperframes transcribe — whisper.cpp / Parakeet,
//                                  manages its own models, already used by the video-edit skill
//   whisper-cli  (local)           whisper.cpp directly, when the user has a model file
//   openai       (remote)          /v1/audio/transcriptions with word granularities
//   elevenlabs   (remote)          /v1/speech-to-text (Scribe)
//
// Whatever the engine, the output is normalised to [{ text, start, end }] so nothing
// downstream has to care which one ran.
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync, statSync, copyFileSync, unlinkSync } = require('node:fs');
const { join, basename } = require('node:path');

let port = null;
const post = (m) => { try { port ? port.postMessage(m) : process.parentPort.postMessage(m); } catch {} };
const progress = (stage, detail) => post({ type: 'progress', stage, detail });

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (msg?.type === 'port') { port = e.ports[0]; port.start?.(); return; }
  if (msg?.type !== 'transcribe') return;
  try {
    const result = await transcribe(msg.job);
    post({ type: 'done', ...result });
  } catch (err) {
    post({ type: 'error', error: err?.message || String(err) });
  }
  setTimeout(() => process.exit(0), 200);
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env, ...opts });
    let out = '', err = '';
    p.stdout?.on('data', (d) => { out += d; if (opts.onLine) String(d).split('\n').forEach(opts.onLine); });
    p.stderr?.on('data', (d) => { err += d; if (opts.onLine) String(d).split('\n').forEach(opts.onLine); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err })
      : reject(new Error(`${basename(cmd)} exited ${code}: ${(err || out).slice(-400)}`))));
  });
}

// ---------------------------------------------------------------- audio prep
async function extractAudio(media, outPath, forUpload) {
  const args = ['-hide_banner', '-y', '-i', media, '-vn', '-ac', '1'];
  if (forUpload) args.push('-ar', '16000', '-c:a', 'aac', '-b:a', '48k');
  else args.push('-ar', '16000', '-c:a', 'pcm_s16le');
  args.push(outPath);
  await run('ffmpeg', args);
  return outPath;
}

// ---------------------------------------------------------------- engines
async function viaHyperframes(job, audio) {
  progress('transcribing', 'whisper via hyperframes (local)');
  const args = ['--yes', 'hyperframes@latest', 'transcribe', audio, '--json', '-d', job.work];
  if (job.model) args.push('--model', job.model);
  if (job.language) args.push('--language', job.language);
  if (job.engine === 'parakeet') args.push('--engine', 'parakeet');
  await run('npx', args, { cwd: job.work, onLine: (l) => { if (/%|transcrib/i.test(l)) progress('transcribing', l.trim().slice(0, 120)); } });
  const produced = join(job.work, 'transcript.json');
  if (!existsSync(produced)) throw new Error('hyperframes produced no transcript.json');
  return normalise(JSON.parse(readFileSync(produced, 'utf8')));
}

async function viaWhisperCli(job, audio) {
  progress('transcribing', 'whisper.cpp (local)');
  if (!job.modelPath || !existsSync(job.modelPath)) {
    throw new Error('whisper-cli needs a model file (.bin) — set one in the transcribe panel, or use the hyperframes engine which downloads its own');
  }
  const outBase = join(job.work, '.cve_whisper');
  await run('whisper-cli', ['-m', job.modelPath, '-f', audio, '-oj', '-of', outBase, '-ml', '1',
    ...(job.language ? ['-l', job.language] : [])]);
  const j = JSON.parse(readFileSync(outBase + '.json', 'utf8'));
  try { unlinkSync(outBase + '.json'); } catch {}
  return normalise(j);
}

async function viaOpenAI(job, audio) {
  progress('uploading', 'OpenAI ' + (job.model || 'whisper-1'));
  const bytes = readFileSync(audio);
  const form = new FormData();
  form.append('file', new Blob([bytes]), basename(audio));
  form.append('model', job.model || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (job.language) form.append('language', job.language);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${job.apiKey}` }, body: form,
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return normalise(await res.json());
}

async function viaElevenLabs(job, audio) {
  progress('uploading', 'ElevenLabs Scribe');
  const bytes = readFileSync(audio);
  const form = new FormData();
  form.append('file', new Blob([bytes]), basename(audio));
  form.append('model_id', job.model || 'scribe_v1');
  if (job.language) form.append('language_code', job.language);
  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST', headers: { 'xi-api-key': job.apiKey }, body: form,
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return normalise(await res.json());
}

// ---------------------------------------------------------------- normalisation
// Every engine has its own shape; downstream only ever sees [{text,start,end}].
function normalise(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (Array.isArray(raw.words)) list = raw.words;
  else if (Array.isArray(raw.transcript)) list = raw.transcript;
  else if (Array.isArray(raw.segments)) {
    list = raw.segments.flatMap((s) => (Array.isArray(s.words) && s.words.length ? s.words : [s]));
  }
  const words = list.map((w) => ({
    text: String(w.text ?? w.word ?? '').trim(),
    start: Number(w.start ?? w.from ?? w.offsets?.from / 1000),
    end: Number(w.end ?? w.to ?? w.offsets?.to / 1000),
  })).filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  if (!words.length) throw new Error('the engine returned no word timings');
  return words.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- caption building
// Port of build_project.py's grouping so a re-transcribe does not need Python.
const STOP = new Set(('the a an and or but of to in on for is it i you that this so we my your are be do if at ' +
  'as was with have not it\'s how would will can just they them he she from all get got up out').split(' '));
const cleanWord = (t) => t.toLowerCase().replace(/[^a-z0-9'$%.-]/g, '');

function buildCues(words, perCue = 3) {
  const groups = [];
  let cur = [];
  words.forEach((w, i) => {
    cur.push(w);
    const ends = /[.!?]/.test(w.text);
    const gap = i + 1 < words.length ? words[i + 1].start - w.end : 9;
    if (cur.length >= perCue || ends || gap > 0.5) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  return groups.map((g, n) => {
    let ei = -1, best = 1;
    g.forEach((w, i) => { const c = cleanWord(w.text); if (!STOP.has(c) && c.length > best) { best = c.length; ei = i; } });
    return {
      id: `c${String(n + 1).padStart(4, '0')}`,
      start: round(g[0].start),
      end: round(Math.max(g[g.length - 1].end, g[0].start + 0.25)),
      tokens: g.map((w, i) => ({ t: w.text, e: i === ei })),
    };
  });
}
const round = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- main
async function transcribe(job) {
  const media = job.media.startsWith('/') ? job.media : join(job.work, job.media);
  if (!existsSync(media)) throw new Error('media not found: ' + media);

  // Back up the existing transcript FIRST: some engines (hyperframes) write
  // transcript.json themselves, so a copy taken afterwards would back up the new file.
  const tPath = join(job.work, 'transcript.json');
  if (existsSync(tPath)) { try { copyFileSync(tPath, join(job.work, 'transcript.prev.json')); } catch {} }

  const remote = job.engine === 'openai' || job.engine === 'elevenlabs';
  progress('extracting', 'pulling a mono 16 kHz track out of the video');
  const audio = await extractAudio(media, join(job.work, remote ? '.cve_stt.m4a' : '.cve_stt.wav'), remote);
  const sizeMb = statSync(audio).size / 1e6;
  if (remote && sizeMb > 24) throw new Error(`audio is ${sizeMb.toFixed(1)} MB — over the 25 MB upload limit; use a local engine for long videos`);

  let words;
  try {
    if (job.engine === 'openai') words = await viaOpenAI(job, audio);
    else if (job.engine === 'elevenlabs') words = await viaElevenLabs(job, audio);
    else if (job.engine === 'whisper-cli') words = await viaWhisperCli(job, audio);
    else words = await viaHyperframes(job, audio);
  } finally {
    try { unlinkSync(audio); } catch {}
  }

  writeFileSync(tPath, JSON.stringify(words, null, 1));
  progress('writing', `${words.length} words`);

  let cues = null;
  if (job.rebuildCaptions) {
    const pPath = join(job.work, 'project.json');
    const project = JSON.parse(readFileSync(pPath, 'utf8'));
    cues = buildCues(words, job.wordsPerCue || 3);
    project.captions = project.captions || {};
    project.captions.cues = cues;
    copyFileSync(pPath, join(job.work, 'project.prev.json'));
    writeFileSync(pPath, JSON.stringify(project, null, 2));
    progress('captions', `${cues.length} cues`);
  }

  return {
    words: words.length, cues: cues ? cues.length : null,
    duration: round(words[words.length - 1].end),
    engine: job.engine || 'hyperframes',
  };
}
