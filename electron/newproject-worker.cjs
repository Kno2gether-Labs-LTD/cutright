// New-project worker — turns a raw recording into a workspace the editor can open.
//
// This is the on-ramp: pick a video, get a folder containing graded_master.mp4,
// transcript.json and project.json. Every later feature (captions, auto-cut, transcript
// editing, scenes) reads those three files.
//
// Steps: probe → normalise/grade → transcribe → build project.json
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } = require('node:fs');
const { join, basename, extname } = require('node:path');

let port = null;
const post = (m) => { try { port ? port.postMessage(m) : process.parentPort.postMessage(m); } catch {} };
const progress = (stage, detail, pct) => post({ type: 'progress', stage, detail, pct });

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (msg?.type === 'port') { port = e.ports[0]; port.start?.(); return; }
  if (msg?.type !== 'create') return;
  try { post({ type: 'done', ...(await create(msg.job)) }); }
  catch (err) { post({ type: 'error', error: err?.message || String(err) }); }
  setTimeout(() => process.exit(0), 200);
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env, ...opts });
    let tail = '';
    const feed = (d) => {
      const s = String(d); tail = (tail + s).slice(-4000);
      if (opts.onLine) s.split('\n').forEach(opts.onLine);
    };
    p.stdout?.on('data', feed);
    p.stderr?.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(tail)
      : reject(new Error(`${basename(cmd)} failed (${code}): ${tail.slice(-400)}`))));
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height,r_frame_rate:format=duration', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', () => {
      try {
        const j = JSON.parse(out); const st = j.streams[0];
        const [n, d] = (st.r_frame_rate || '30/1').split('/');
        resolve({ width: +st.width, height: +st.height, fps: Math.round(+n / (+d || 1)),
                  duration: parseFloat(j.format.duration) });
      } catch (e) { reject(new Error('could not read that video: ' + e.message)); }
    });
  });
}

const hms = (s) => { const m = /(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

async function create(job) {
  const { source, dest, transcribe = true, model = 'small.en', language = '',
          gradeRef = '', engineDir, targetHeight = 1080, targetFps = 30 } = job;

  if (!existsSync(source)) throw new Error('that video no longer exists: ' + source);
  mkdirSync(dest, { recursive: true });

  progress('probe', 'reading the recording', 2);
  const meta = await probe(source);
  progress('probe', `${meta.width}x${meta.height} · ${meta.fps} fps · ${Math.round(meta.duration)}s`, 5);

  // ---- grade: normalise to 1080p, even fps, broadcast loudness ----
  // Optionally colour-match a reference video (the same tool the video-edit skill uses).
  let filter = '';
  if (gradeRef && existsSync(gradeRef)) {
    progress('grade', 'matching the colour of your reference video', 8);
    try {
      const out = await run('node', [join(engineDir, 'color-match.mjs'), '--ref', gradeRef,
        '--in', source, '--out', join(dest, '_probe.mp4'), '--preview', '6', '--json']);
      const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      const j = JSON.parse(line);
      filter = j.filter || '';
      writeFileSync(join(dest, 'grade.json'), JSON.stringify(j, null, 2));
      try { unlinkSync(join(dest, '_probe.preview.mp4')); } catch {}
    } catch (e) { progress('grade', 'colour match skipped: ' + e.message.slice(0, 80)); }
  }

  const h = Math.min(targetHeight, 1080);
  const w = Math.round((h * 16) / 9 / 2) * 2;
  const vf = [`scale=${w}:${h}:force_original_aspect_ratio=decrease`,
              `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`, filter].filter(Boolean).join(',');
  const graded = join(dest, 'graded_master.mp4');
  progress('grade', 'building the master (hardware encode)', 10);
  await run('ffmpeg', ['-hide_banner', '-y', '-i', source, '-vf', vf, '-r', String(targetFps),
    '-c:v', 'h264_videotoolbox', '-b:v', '14M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', graded], {
      onLine: (l) => {
        const t = /time=\s*([\d:.]+)/.exec(l);
        if (t) {
          const secs = hms(t[1]);
          if (secs != null && meta.duration) {
            progress('grade', `${Math.round(secs)}s of ${Math.round(meta.duration)}s`,
              10 + Math.min(45, (secs / meta.duration) * 45));
          }
        }
      },
    });

  // ---- transcript (drives captions, auto-cut and the transcript editor) ----
  if (transcribe) {
    progress('transcribe', 'listening to the audio (this runs on your machine)', 58);
    const wav = join(dest, '.cve_stt.wav');
    await run('ffmpeg', ['-hide_banner', '-y', '-i', graded, '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', wav]);
    const args = ['--yes', 'hyperframes@latest', 'transcribe', wav, '--json', '-d', dest, '--model', model];
    if (language) args.push('--language', language);
    try {
      await run('npx', args, { cwd: dest, onLine: (l) => { if (/%/.test(l)) progress('transcribe', l.trim().slice(0, 90), 70); } });
    } finally { try { unlinkSync(wav); } catch {} }
    if (!existsSync(join(dest, 'transcript.json'))) throw new Error('transcription produced no transcript.json');
    progress('transcribe', 'done', 85);
  }

  // ---- project.json ----
  progress('build', 'writing project.json', 90);
  const projectPath = join(dest, 'project.json');
  if (transcribe && existsSync(join(dest, 'transcript.json'))) {
    await run('python3', [join(engineDir, 'build_project.py'), '--work', dest,
      '--source', source, '--out', projectPath]);
  } else {
    // no transcript: still give the editor a valid, empty project to open
    const g = await probe(graded);
    writeFileSync(projectPath, JSON.stringify({
      version: 1,
      meta: { source, graded: 'graded_master.mp4', width: g.width, height: g.height, fps: g.fps,
              duration: Math.round(g.duration * 1000) / 1000, style: 'coral-ink-bone' },
      grade: filter ? { filter } : {},
      captions: { defaults: { style: 'highlight',
        font: '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf',
        fontsize: Math.round(g.height * 0.056), cy: Math.round(g.height * 0.66),
        color: '#FFFFFF', highlight: '#E5533D' }, cues: [] },
      scenes: [], overlays: [], cuts: [],
      audio: { loudnessLUFS: -14, voice: { source: 'graded' }, music: [], sfx: [] },
    }, null, 2));
  }

  const project = JSON.parse(readFileSync(projectPath, 'utf8'));
  progress('build', 'ready', 100);
  return {
    work: dest, project: projectPath,
    cues: project.captions?.cues?.length || 0,
    duration: project.meta?.duration || 0,
    graded,
  };
}
