// Which H.264 encoder this machine can actually use.
//
// The mirror of pick_encoder() in engine/render_project.py, for the places that shell out to
// ffmpeg from JavaScript. Same reasoning: every Mac with real hardware has VideoToolbox and it is
// much the fastest, but a virtualised one does not — and there the encoder is LISTED and then
// fails on first use with "Could not open encoder before EOF", which reads like a broken input
// rather than a missing GPU. So probe by encoding a frame, once, and remember the answer.
const { spawnSync } = require('node:child_process');

let chosen = null;

function pickEncoder() {
  if (chosen) return chosen;
  if (process.env.CVE_VIDEO_ENCODER) { chosen = process.env.CVE_VIDEO_ENCODER; return chosen; }

  const listed = (spawnSync('ffmpeg', ['-hide_banner', '-encoders'],
    { encoding: 'utf8', timeout: 20_000 }).stdout) || '';
  for (const name of ['h264_videotoolbox', 'libx264', 'libopenh264']) {
    if (!listed.includes(name)) continue;
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1', '-c:v', name, '-f', 'null', '-'],
      { encoding: 'utf8', timeout: 30_000 });
    if (r.status === 0) {
      if (name !== 'h264_videotoolbox') console.warn(`[encoder] videotoolbox unavailable, using ${name}`);
      chosen = name;
      return chosen;
    }
  }
  // Say which one it is going to fail with rather than returning something meaningless.
  chosen = 'h264_videotoolbox';
  console.warn('[encoder] no encoder passed the probe; falling back to h264_videotoolbox');
  return chosen;
}

module.exports = { pickEncoder };
