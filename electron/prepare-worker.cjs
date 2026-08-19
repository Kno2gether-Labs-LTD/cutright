// Preprocess — the structural pass.
//
// One action that turns a recording into a project an agent can finish: transcribe it, work out
// what to cut, work out when the speaker should have the frame, apply the pack's look and pacing,
// and write every decision into project.json. Nothing is rendered and nothing is destroyed — the
// output is a list of decisions, each with a reason, that the user or the agent can overrule.
//
// It runs here rather than in main because every step shells out to ffmpeg or Whisper, and the
// window must stay alive and cancellable throughout.
const { readFileSync, writeFileSync, existsSync, unlinkSync } = require('node:fs');
const { join, basename } = require('node:path');
const { runWatched } = require('./run-watched.cjs');
const { analyze, analyzeScreen } = require('./analysis-worker.cjs');

let port = null;
const progress = (stage, detail, pct) => port?.postMessage({ type: 'progress', stage, detail, pct });

process.parentPort.on('message', (e) => {
  if (e.data?.type === 'port') { port = e.ports[0]; port.start(); return; }
  if (e.data?.type !== 'prepare') return;
  prepare(e.data.job)
    .then((r) => port?.postMessage({ type: 'done', ...r }))
    .catch((err) => port?.postMessage({ type: 'error', error: err?.message || String(err) }))
    .finally(() => setTimeout(() => process.exit(0), 150));
});

const round = (n) => Math.round(n * 100) / 100;

async function prepare(job) {
  const { work, template = null, options = {} } = job;
  const projectFile = join(work, 'project.json');
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  const did = [];

  // ---------------------------------------------------------------- 1. words
  let words = [];
  const transcriptFile = join(work, 'transcript.json');
  if (existsSync(transcriptFile)) {
    words = JSON.parse(readFileSync(transcriptFile, 'utf8'));
    progress('transcribe', `${words.length} words already transcribed`, 12);
  } else if (options.transcribe !== false) {
    progress('transcribe', 'listening to the audio — this runs on your machine', 5);
    const media = join(work, project.meta?.graded || 'graded_master.mp4');
    const wav = join(work, '.cve_prepare.wav');
    await runWatched('ffmpeg', ['-hide_banner', '-y', '-i', media, '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', wav], { stallMs: 180_000 });
    try {
      await runWatched('npx', ['--yes', 'hyperframes@latest', 'transcribe', wav, '--json', '-d', work,
        '--model', options.model || 'small.en'], {
        cwd: work, stallMs: 420_000,
        onLine: (l) => { if (/%/.test(l)) progress('transcribe', l.trim().slice(0, 80), 18); },
      });
      words = JSON.parse(readFileSync(transcriptFile, 'utf8'));
      did.push(`transcribed ${words.length} words`);
    } catch (e) {
      progress('transcribe', 'no speech found — carrying on without a transcript', 20);
      did.push('no speech found, so no transcript');
    } finally { try { unlinkSync(wav); } catch {} }
  }

  // ---------------------------------------------------------------- 2. what to cut
  let cutProposals = [];
  if (options.cuts !== false) {
    progress('cuts', 'reading the waveform and the transcript', 30);
    const r = await analyze({ work, media: project.meta?.graded || 'graded_master.mp4', ...(options.cut || {}) });
    cutProposals = r.proposals || [];
    // Confident proposals become cuts; the doubtful ones stay on the table. Auto-cut has always
    // shown its working, and preprocess is not the place to start hiding it.
    const take = cutProposals.filter((p) => p.confidence !== 'low');
    if (take.length) {
      project.cuts = mergeCuts([...(project.cuts || []),
        ...take.map((p) => ({ start: p.start, end: p.end, source: 'auto:' + p.reason }))]);
      did.push(`cut ${take.length} of ${cutProposals.length} proposals `
             + `(${round(take.reduce((a, p) => a + p.end - p.start, 0))}s)`);
    }
    project.proposals = { cuts: cutProposals.filter((p) => p.confidence === 'low') };
  }

  // ---------------------------------------------------------------- 3. who gets the frame
  const camera = project.meta?.tracks?.camera;
  if (camera && options.framing !== false) {
    progress('framing', 'looking for stretches where nothing changes on screen', 55);
    const screen = project.meta?.tracks?.screen || project.meta?.graded || 'graded_master.mp4';
    let sr = { proposals: [], stats: {} };
    try { sr = await analyzeScreen({ work, media: screen, ...(options.screen || {}) }); }
    catch (e) { progress('framing', 'could not measure the screen: ' + e.message.slice(0, 80), 60); }

    const home = project.meta?.tracks?.cameraHome
      || { to: 'corner', shape: 'circle', size: 0.24, corner: 'br', margin: 0.045 };
    const frames = [];
    for (const p of sr.proposals || []) {
      // the speaker takes the frame while the screen has nothing to say, then hands it back
      frames.push({ id: 'fs' + Math.round(p.start * 100), start: round(p.start), dur: 0.7,
                    to: 'full', ease: 'inout', source: 'screen-static', why: p.label });
      frames.push({ id: 'fc' + Math.round(p.end * 100), start: round(p.end), dur: 0.7,
                    ...home, ease: 'inout', source: 'screen-static' });
    }
    if (frames.length) {
      project.frames = [...(project.frames || []).filter((f) => f.source !== 'screen-static'), ...frames]
        .sort((a, b) => a.start - b.start);
      did.push(`gave the speaker the frame for ${sr.proposals.length} quiet stretch(es)`);
    }
    project.proposals = { ...(project.proposals || {}), screen: sr.stats };
  }

  // ---------------------------------------------------------------- 4. the pack's look and pace
  if (template) {
    progress('template', `applying ${template.name || template.id}`, 75);
    project.meta = { ...project.meta, template: template.id, style: template.id };
    if (template.captions) {
      project.captions = project.captions || { defaults: {}, cues: [] };
      project.captions.defaults = { ...project.captions.defaults, ...template.captions };
    }
    if (template.grade && options.grade !== false) {
      project.grade = { ...(project.grade || {}), look: {
        preset: template.grade.look, grain: template.grade.grain,
        vignette: template.grade.vignette, bloom: template.grade.bloom ?? 0 } };
      project.audio = { ...(project.audio || {}), polish: template.grade.audioPolish || 'voice' };
      did.push(`graded "${template.grade.look}" with ${template.grade.audioPolish || 'voice'} audio`);
    }
    project.pacing = template.pacing || project.pacing;
  }

  // ---------------------------------------------------------------- 5. how long panels stay up
  if ((project.scenes || []).length && options.pacing !== false) {
    progress('pacing', 'sizing the panels to what they say', 88);
    const paced = await pacePanels(work, project, words);
    project.scenes = paced.scenes;
    if (paced.changed) did.push(`re-timed ${paced.changed} panel(s) to their content`);
  }

  project.meta = { ...project.meta, preparedAt: new Date().toISOString() };
  writeFileSync(projectFile, JSON.stringify(project, null, 2));
  progress('done', 'ready for the agent', 100);

  return {
    did,
    cuts: (project.cuts || []).length,
    frames: (project.frames || []).length,
    stillOnTheTable: (project.proposals?.cuts || []).length,
    words: words.length,
  };
}

// A panel is up for as long as what it says is worth reading, and no longer. The rules live in
// engine/pacing.py so the agent and the app agree on them.
async function pacePanels(work, project, words) {
  const { spawnSync } = require('node:child_process');
  const engine = process.env.CVE_ENGINE || join(__dirname, '..', 'engine');
  const payload = JSON.stringify({ scenes: project.scenes, words, pacing: project.pacing || {} });
  const r = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(engine)})
from pacing import panel_duration
job = json.load(sys.stdin)
out = []
for sc in job["scenes"]:
    dur, why = panel_duration(sc, job.get("words"), job.get("pacing"))
    out.append({**sc, "dur": dur, "durWhy": why})
print(json.dumps(out))
`], { input: payload, encoding: 'utf8' });
  if (r.status !== 0) return { scenes: project.scenes, changed: 0 };
  try {
    const scenes = JSON.parse(r.stdout.trim().split('\n').pop());
    const changed = scenes.filter((s, i) => Math.abs(s.dur - (project.scenes[i]?.dur ?? 0)) > 0.05).length;
    return { scenes, changed };
  } catch { return { scenes: project.scenes, changed: 0 }; }
}

function mergeCuts(cuts) {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end);
    else out.push({ ...c });
  }
  return out;
}
