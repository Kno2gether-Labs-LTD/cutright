// Template worker — renders a template's motion-graphics preset into an alpha clip.
//
// A preset is authored HTML (HyperFrames) or a React composition (Remotion). Either way
// the output is the same thing the timeline already understands: a clip with an alpha
// channel that the render engine composites over the video (see decisions/0006).
//
//   hyperframes  npx hyperframes render <dir> --composition <file> --format mov --variables '{…}'
//   remotion     npx remotion render <entry> <id> <out> --codec prores --prores-profile 4444 --props '{…}'
const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, statSync, renameSync, unlinkSync } = require('node:fs');
const { join, dirname } = require('node:path');

let port = null;
const post = (m) => { try { port ? port.postMessage(m) : process.parentPort.postMessage(m); } catch {} };
const progress = (detail, pct) => post({ type: 'progress', detail, pct });

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (msg?.type === 'port') { port = e.ports[0]; port.start?.(); return; }
  if (msg?.type !== 'render-preset') return;
  try { post({ type: 'done', ...(await renderPreset(msg.job)) }); }
  catch (err) { post({ type: 'error', error: err?.message || String(err) }); }
  setTimeout(() => process.exit(0), 200);
});

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: process.env, ...opts });
    let tail = '';
    const feed = (d) => {
      const s = String(d); tail = (tail + s).slice(-3000);
      s.split('\n').forEach((line) => {
        const m = /(\d{1,3})%/.exec(line);
        if (m) progress(line.trim().slice(0, 100), Number(m[1]));
        else if (line.trim() && /render|encod|captur|assembl|bundl/i.test(line)) progress(line.trim().slice(0, 100));
      });
    };
    p.stdout?.on('data', feed);
    p.stderr?.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(`${cmd} exited ${code}: ${tail.slice(-400)}`))));
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(Math.round((parseFloat(out) || 0) * 100) / 100));
    p.on('error', () => resolve(0));
  });
}

async function renderPreset(job) {
  const { templateDir, engine, composition, vars = {}, outPath, fps = 30, quality = 'high', remotionEntry, remotionId } = job;
  mkdirSync(dirname(outPath), { recursive: true });

  if (engine === 'remotion') {
    // manifests give a path relative to the template, so always resolve against it
    const rel = remotionEntry || 'remotion/src/index.ts';
    const entry = rel.startsWith('/') ? rel : join(templateDir, rel);
    if (!existsSync(entry)) throw new Error('remotion entry not found: ' + entry);
    progress('bundling the Remotion project');
    // Remotion only writes an alpha channel when the frames are PNG *and* the pixel
    // format is a yuva one — with just --prores-profile 4444 it silently emits opaque
    // yuv422p12le, which would composite as a black rectangle.
    const local = join(dirname(entry), '..', 'node_modules/.bin/remotion');
    const bin = existsSync(local) ? local : 'npx';
    const pre = existsSync(local) ? [] : ['--yes', 'remotion'];
    await run(bin, [...pre, 'render', entry, remotionId || composition, outPath,
      '--codec', 'prores', '--prores-profile', '4444',
      '--image-format', 'png', '--pixel-format', 'yuva444p10le',
      '--props', JSON.stringify(vars)], { cwd: join(dirname(entry), '..') });
  } else {
    const comp = join(templateDir, composition);
    if (!existsSync(comp)) throw new Error('composition not found: ' + comp);
    progress('rendering the composition with HyperFrames');
    await run('npx', ['--yes', 'hyperframes@latest', 'render', templateDir,
      '--composition', composition, '--format', 'mov', '--fps', String(fps),
      '-q', quality, '-o', outPath, '--variables', JSON.stringify(vars)], { cwd: templateDir });
  }

  if (!existsSync(outPath)) throw new Error('the renderer produced no file');

  // ProRes 4444 is the reliable alpha carrier (this ffmpeg drops WebM/VP9 alpha entirely,
  // verified), but it is enormous. QuickTime RLE is also lossless with alpha and much
  // smaller for flat motion-graphics, so transcode when it actually wins.
  const before = statSync(outPath).size;
  try {
    const small = outPath.replace(/\.mov$/, '.rle.mov');
    await run('ffmpeg', ['-hide_banner', '-y', '-i', outPath, '-c:v', 'qtrle', '-pix_fmt', 'argb', small]);
    if (existsSync(small) && statSync(small).size < before * 0.85) {
      renameSync(small, outPath);
      progress(`compressed ${(before / 1e6).toFixed(1)} MB to ${(statSync(outPath).size / 1e6).toFixed(1)} MB`);
    } else if (existsSync(small)) unlinkSync(small);
  } catch (e) { progress('kept the ProRes master (' + e.message.slice(0, 60) + ')'); }

  return { path: outPath, duration: await probeDuration(outPath), bytes: statSync(outPath).size,
           originalBytes: before };
}
