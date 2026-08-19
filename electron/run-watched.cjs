// Spawn a child process that cannot hang the app.
//
// Every long job in Cutright is someone else's binary — ffmpeg, npx fetching a package,
// whisper loading a model — and any of them can stop producing output and never exit. The
// export path has always watched for that; the template, transcription and new-project paths
// did not, and a silent npx once left the whole app waiting on a promise that would never
// settle. There is nothing a user can do with a progress bar that has stopped moving.
//
// So: no passive waiting anywhere. A child that goes quiet for `stallMs` is killed and the
// failure is reported, and no job may run longer than `capMs` whatever it is doing.
const { spawn } = require('node:child_process');

function runWatched(cmd, args, opts = {}) {
  const {
    onLine, onStall,
    stallMs = 180_000,          // no output at all for this long = wedged
    capMs = 45 * 60_000,        // nothing here should ever take three quarters of an hour
    ...spawnOpts
  } = opts;

  return new Promise((resolve, reject) => {
    // Own process group, so killing takes the whole tree with it: npx spawns node, node
    // spawns ffmpeg, and killing only the first would leave the rest running.
    const p = spawn(cmd, args, { env: process.env, detached: true, ...spawnOpts });
    const started = Date.now();
    let last = Date.now(), tail = '', done = false, killedFor = null;

    const feed = (d) => {
      last = Date.now();
      const s = String(d);
      tail = (tail + s).slice(-4000);
      if (onLine) s.split('\n').forEach((l) => { if (l.trim()) onLine(l); });
    };
    p.stdout?.on('data', feed);
    p.stderr?.on('data', feed);

    const stop = () => { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } };

    const watch = setInterval(() => {
      if (done) return;
      const idle = Date.now() - last;
      const cap = capMs >= 60_000 ? `${Math.round(capMs / 60_000)} minutes` : `${Math.round(capMs / 1000)}s`;
      if (Date.now() - started > capMs) { killedFor = `it ran for longer than ${cap}`; stop(); return; }
      if (idle > stallMs) { killedFor = `it produced no output for ${Math.round(idle / 1000)}s`; stop(); return; }
      if (onStall && idle > stallMs / 2) onStall(idle);
    }, 5_000);

    const finish = (fn, arg) => { if (done) return; done = true; clearInterval(watch); fn(arg); };

    p.on('error', (e) => finish(reject, e));
    p.on('close', (code) => {
      if (killedFor) return finish(reject, new Error(`${cmd} was stopped because ${killedFor}: ${tail.slice(-300)}`));
      if (code === 0) return finish(resolve, tail);
      finish(reject, new Error(`${cmd} exited ${code}: ${tail.slice(-400)}`));
    });
  });
}

module.exports = { runWatched };
