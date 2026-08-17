// Claude Video Editor — Electron main process.
// Collapses the old Express server into the main process: project I/O, local media
// serving (custom `cve://` scheme with HTTP-range support), the render job (run in a
// utilityProcess, never here), audio generation, and the node-pty terminal.
//
// Security posture (do not loosen): contextIsolation:true, sandbox:true,
// nodeIntegration:false, a narrow contextBridge (see preload.cjs) and a strict CSP.
import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, utilityProcess, MessageChannelMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename, isAbsolute, sep } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, watch, statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const isDev = !app.isPackaged;

// ---------------------------------------------------------------- logging
// A packaged app has no terminal, so every launch writes a log we can read after the
// fact ("I just got a black window"). Kept small and always on.
let logPath = null;
function log(...parts) {
  const line = `[${new Date().toISOString()}] ` + parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  try {
    if (!logPath) return;
    if (existsSync(logPath) && statSync(logPath).size > 1_000_000) writeFileSync(logPath, '');
    appendFileSync(logPath, line + '\n');
  } catch {}
}
function initLog() {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, 'main.log');
    log('--- launch', app.getVersion(), process.platform, process.arch, 'packaged=' + app.isPackaged, 'electron=' + process.versions.electron);
  } catch (e) { console.warn('[log] disabled:', e.message); }
}

// fix-path alone is not enough: launched from Finder/launchd it reproduces the *login*
// shell PATH, which on this machine (and many others) still lacks Homebrew — so ffmpeg
// at /opt/homebrew/bin would be invisible and every render would fail. Append the
// standard package-manager locations that actually exist.
function ensureToolPaths() {
  const extra = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin',
       join(app.getPath('home'), '.local/bin'), join(app.getPath('home'), 'bin')];
  const sep2 = process.platform === 'win32' ? ';' : ':';
  const have = new Set((process.env.PATH || '').split(sep2).filter(Boolean));
  const add = extra.filter((p) => !have.has(p) && existsSync(p));
  if (add.length) process.env.PATH = [...have, ...add].join(sep2);
  return add;
}

// ---------------------------------------------------------------- settings
// The "workspace" is the folder holding project.json + graded_master.mp4 + renders.
const DEFAULTS = {
  // No hard-coded workspace: on first run the app asks for one (welcome state).
  work: process.env.WORK || '',
  recent: [],
  // The render/audio engine still lives in the `video-edit` skill (Python, Phase 4 ports it to Node).
  engine: process.env.ENGINE || join(app.getPath('home'), '.claude/skills/video-edit/scripts'),
  python: process.env.PYTHON || 'python3',
};
let settingsPath = null, settings = { ...DEFAULTS };

function loadSettings() {
  settingsPath = join(app.getPath('userData'), 'settings.json');
  try { settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath, 'utf8')) }; } catch { /* first run */ }
  const argWork = process.argv.find((a) => a.startsWith('--cve-work='));
  if (argWork) settings.work = argWork.split('=')[1];
  if (process.env.WORK) settings.work = process.env.WORK;   // env always wins (dev/smoke)
  if (!Array.isArray(settings.recent)) settings.recent = [];
}

// Remember where the user has been working; the welcome screen offers these.
function setWorkspace(dir) {
  settings.work = dir;
  settings.recent = [dir, ...settings.recent.filter((r) => r !== dir)].filter((r) => existsSync(r)).slice(0, 8);
  saveSettings(); watchProject();
  log('workspace', dir);
}
function saveSettings() {
  try { mkdirSync(dirname(settingsPath), { recursive: true }); writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
}
const projectPath = () => join(settings.work, 'project.json');

// ---------------------------------------------------------------- media scheme
// A privileged scheme so the sandboxed renderer can stream local files it is allowed to
// see (the workspace) — with real Range support, which `file://` does not give us.
protocol.registerSchemesAsPrivileged([{
  scheme: 'cve',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Only files inside the current workspace may be served — the renderer cannot ask for /etc/passwd.
function allowedPath(p) {
  if (!settings.work) return null;
  const abs = resolve(p);
  const root = resolve(settings.work) + sep;
  return (abs + sep).startsWith(root) ? abs : null;
}

function registerMediaProtocol() {
  protocol.handle('cve', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'media') return new Response('not found', { status: 404 });
    const want = url.searchParams.get('p') || '';
    const file = allowedPath(isAbsolute(want) ? want : join(settings.work, want));
    if (!file || !existsSync(file)) return new Response('not found', { status: 404 });

    const size = statSync(file).size;
    const type = MIME[file.slice(file.lastIndexOf('.')).toLowerCase()] || 'application/octet-stream';
    const range = request.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(createReadStream(file, { start, end })), {
        status: 206,
        headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
      });
    }
    return new Response(Readable.toWeb(createReadStream(file)), {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  });
}

// ---------------------------------------------------------------- window
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, backgroundColor: '#0b0c10', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // Show immediately: a window that appears only on 'ready-to-show' is invisible while
  // anything goes wrong, and a window that shows but never paints looks like a black box.
  win.show();
  const indexHtml = join(ROOT, 'renderer/index.html');
  log('loadFile', indexHtml, 'exists=' + existsSync(indexHtml));
  win.loadFile(indexHtml).catch((e) => log('loadFile REJECTED', e?.message || String(e)));

  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('did-fail-load', code, desc, url);
    showFatal(`The interface failed to load.\n${desc} (${code})\n${url}`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-process-gone', details);
    if (details.reason !== 'clean-exit') {
      showFatal(`The window crashed (${details.reason}).\nIt has been reloaded — if this repeats, open the log from Help → Open Log Folder.`);
      setTimeout(() => { try { win?.reload(); } catch {} }, 400);
    }
  });
  win.webContents.on('unresponsive', () => log('renderer unresponsive'));
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('renderer-console', `[${level}] ${message} (${sourceId}:${line})`);
  });
  // Never let the renderer navigate away or open arbitrary windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev && process.env.CVE_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  const wcId = win.webContents.id;                       // gone by the time 'closed' fires
  win.on('closed', () => { killTerm(wcId); win = null; });
  return win;
}

// A visible, readable failure beats a black window. Never leaves the user guessing.
function showFatal(message) {
  log('FATAL', message.replace(/\n/g, ' | '));
  if (!win || win.isDestroyed()) return;
  const body = `<!doctype html><meta charset="utf-8">
  <style>body{margin:0;background:#0b0c10;color:#e6e6e6;font:14px/1.6 -apple-system,system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;height:100vh}
  .b{max-width:640px;padding:28px 32px;border:1px solid #333;border-radius:12px;background:#14161c}
  h1{font-size:16px;margin:0 0 10px;color:#e5533d}pre{white-space:pre-wrap;color:#bdbdbd;font-size:12px}
  code{color:#c4d82e}</style>
  <div class="b"><h1>Something went wrong</h1><pre>${message.replace(/[<&]/g, (c) => ({ '<': '&lt;', '&': '&amp;' }[c]))}</pre>
  <pre>Log: <code>${logPath || 'n/a'}</code></pre></div>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(body)).catch(() => {});
}

// ---------------------------------------------------------------- project I/O + watch
let watcher = null, watchTimer = null;
function watchProject() {
  try { watcher?.close(); } catch {}
  watcher = null;
  if (!existsSync(settings.work)) return;
  try {
    watcher = watch(settings.work, (_ev, name) => {
      if (name !== 'project.json') return;
      clearTimeout(watchTimer);
      // debounce: the agent/CLI writes are not atomic
      watchTimer = setTimeout(() => win && !win.isDestroyed() && win.webContents.send('project:changed'), 250);
    });
  } catch (e) { console.warn('[watch] failed:', e.message); }
}

// ---------------------------------------------------------------- render (utilityProcess)
// ffmpeg/python NEVER run on the main thread. Each job gets a utilityProcess that owns the
// child process tree and streams progress straight to the renderer over a MessagePort.
const jobs = new Map();   // id -> utilityProcess

function startRender(webContents, opts) {
  if (!settings.work) return { error: 'no workspace open' };
  const id = opts.id || `r${Date.now()}`;
  const child = utilityProcess.fork(join(__dir, 'render-worker.cjs'), [], {
    serviceName: 'cve-render',
    stdio: 'pipe',
    env: { ...process.env, PATH: process.env.PATH },
  });
  jobs.set(id, child);

  // utility <-> renderer direct channel (main is not in the data path)
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  webContents.postMessage('render:port', { id }, [port2]);

  child.stdout?.on('data', (d) => console.log('[render]', d.toString().trimEnd()));
  child.stderr?.on('data', (d) => console.warn('[render!]', d.toString().trimEnd()));
  child.on('exit', () => jobs.delete(id));

  child.postMessage({
    type: 'start',
    job: {
      id,
      project: projectPath(),
      out: join(settings.work, basename(opts.out || 'preview.mp4')),
      range: opts.range || null,
      work: settings.work,
      engine: settings.engine,
      python: settings.python,
    },
  });
  return { id };
}

function cancelRender(id) {
  const child = jobs.get(id);
  if (!child) return { ok: false };
  child.postMessage({ type: 'cancel' });
  setTimeout(() => { try { child.kill(); } catch {} }, 2000);
  return { ok: true };
}

// ---------------------------------------------------------------- environment preflight
// We deliberately do NOT bundle ffmpeg (see README § licensing): the app is Apache-2.0 and
// shipping a GPL ffmpeg would infect it. So the external tools must be checked up front and
// reported clearly, instead of failing three minutes into a render.
function which(bin) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try { if (existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

async function checkEnvironment() {
  const { spawn } = await import('node:child_process');
  const tools = {
    ffmpeg: which('ffmpeg'),
    ffprobe: which('ffprobe'),
    python: which(settings.python) || which('python3'),
  };
  const engineOk = existsSync(join(settings.engine, 'render_project.py'));
  let pillow = false;
  if (tools.python) {
    pillow = await new Promise((res) => {
      const p = spawn(tools.python, ['-c', 'import PIL'], { env: process.env });
      p.on('error', () => res(false));
      p.on('close', (c) => res(c === 0));
      setTimeout(() => { try { p.kill(); } catch {} res(false); }, 8000);
    });
  }
  const missing = [];
  if (!tools.ffmpeg) missing.push({ tool: 'ffmpeg', hint: process.platform === 'darwin' ? 'brew install ffmpeg' : 'winget install ffmpeg' });
  if (!tools.ffprobe) missing.push({ tool: 'ffprobe', hint: 'ships with ffmpeg' });
  if (!tools.python) missing.push({ tool: 'python3', hint: process.platform === 'darwin' ? 'brew install python' : 'winget install python' });
  else if (!pillow) missing.push({ tool: 'Pillow (python)', hint: `${tools.python} -m pip install --user Pillow` });
  if (!engineOk) missing.push({ tool: 'render engine', hint: 'install the video-edit skill at ' + settings.engine });
  return { ok: missing.length === 0, tools, pillow, engine: settings.engine, engineOk, missing };
}

// ---------------------------------------------------------------- audio generation
function generateAudio({ kind, text, at }) {
  return new Promise((res) => {
    if (!['sfx', 'voice', 'music'].includes(kind)) return res({ ok: false, error: 'bad kind' });
    const script = join(settings.engine, 'audio_agent.py');
    const args = [script, kind, '--project', projectPath()];
    if (kind === 'sfx') args.push('--prompt', text, '--at', String(at), '--dur', '2');
    else if (kind === 'voice') args.push('--text', text, '--at', String(at));
    else args.push('--prompt', text, '--start', String(at), '--dur', '30');
    import('node:child_process').then(({ spawn }) => {
      const py = spawn(settings.python, args, { cwd: settings.work, env: process.env });
      let out = '';
      py.stdout.on('data', (d) => (out += d));
      py.stderr.on('data', (d) => (out += d));
      py.on('error', (e) => res({ ok: false, error: e.message }));
      py.on('close', (code) => {
        try { res(code === 0 ? JSON.parse(out.trim().split('\n').pop()) : { ok: false, error: out.slice(-400) }); }
        catch { res({ ok: code === 0, raw: out.slice(-400) }); }
      });
    });
  });
}

// ---------------------------------------------------------------- terminal (node-pty)
let ptyMod = null, terms = new Map();

async function loadPty() {
  if (ptyMod !== null) return ptyMod;
  try { ptyMod = (await import('node-pty')).default; }
  catch (e) { console.warn('[pty] unavailable:', e.message); ptyMod = false; }
  return ptyMod;
}

// node-pty rejects env objects with non-string values (a cause of `posix_spawnp failed`).
function cleanEnv() {
  const env = { TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' };
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return env;
}

async function startTerm(wc) {
  const pty = await loadPty();
  killTerm(wc.id);
  const env = cleanEnv();
  const shellPath = env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');
  // A LOGIN shell: a packaged GUI app does not inherit the user's PATH, so `claude`
  // would not resolve. fix-path (below, at startup) + `-l` covers both cases.
  const args = process.platform === 'win32' ? [] : ['-l'];
  if (pty) {
    try {
      const t = pty.spawn(shellPath, args, {
        name: 'xterm-256color', cols: 100, rows: 30, cwd: settings.work || app.getPath('home'), env,
      });
      t.onData((d) => !wc.isDestroyed() && wc.send('pty:data', d));
      t.onExit(() => !wc.isDestroyed() && wc.send('pty:exit'));
      terms.set(wc.id, { kind: 'pty', t });
      return { ok: true, kind: 'pty', shell: shellPath, cwd: settings.work };
    } catch (e) { console.warn('[pty] fork failed → child_process fallback:', e.message); }
  }
  const { spawn } = await import('node:child_process');
  const t = spawn(shellPath, process.platform === 'win32' ? [] : ['-i'], { cwd: settings.work || app.getPath('home'), env });
  t.stdout.on('data', (d) => !wc.isDestroyed() && wc.send('pty:data', d.toString()));
  t.stderr.on('data', (d) => !wc.isDestroyed() && wc.send('pty:data', d.toString()));
  t.on('close', () => !wc.isDestroyed() && wc.send('pty:exit'));
  terms.set(wc.id, { kind: 'child', t });
  return { ok: true, kind: 'child', shell: shellPath, cwd: settings.work };
}
function killTerm(id) {
  const h = terms.get(id);
  if (!h) return;
  try { h.kind === 'pty' ? h.t.kill() : h.t.kill('SIGKILL'); } catch {}
  terms.delete(id);
}

// ---------------------------------------------------------------- ipc
function registerIpc() {
  ipcMain.handle('config:get', () => ({
    work: settings.work, project: settings.work ? projectPath() : '', engine: settings.engine,
    recent: settings.recent, hasWorkspace: !!settings.work,
    version: app.getVersion(), platform: process.platform, dev: isDev,
  }));

  ipcMain.handle('workspace:choose', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.work });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    setWorkspace(r.filePaths[0]);
    return { ok: true, work: settings.work };
  });

  ipcMain.handle('workspace:open', (_e, dir) => {
    const d = String(dir || '');
    if (!d || !existsSync(join(d, 'project.json'))) return { ok: false, error: 'no project.json in ' + d };
    setWorkspace(d);
    return { ok: true, work: settings.work };
  });

  ipcMain.handle('project:get', () => {
    if (!settings.work) return { error: 'no workspace open' };
    const p = projectPath();
    if (!existsSync(p)) return { error: 'no project.json in ' + settings.work };
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { return { error: 'unreadable project.json: ' + e.message }; }
  });

  ipcMain.handle('project:save', (_e, data) => {
    if (!settings.work) return { ok: false, error: 'no workspace open' };
    if (!data || typeof data !== 'object' || !data.meta) return { ok: false, error: 'refusing to save a malformed project' };
    try { writeFileSync(projectPath(), JSON.stringify(data, null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('env:check', () => checkEnvironment());

  // Pick an overlay clip (HyperFrames MOV/WebM with alpha, or a PNG sequence's first frame).
  ipcMain.handle('overlay:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose an overlay clip',
      defaultPath: settings.work ? join(settings.work, 'overlays') : undefined,
      properties: ['openFile'],
      filters: [{ name: 'Overlay clips', extensions: ['mov', 'webm', 'mp4', 'png'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const p = r.filePaths[0];
    // relative to the workspace when possible, so projects stay portable
    const rel = settings.work && p.startsWith(resolve(settings.work) + sep) ? p.slice(resolve(settings.work).length + 1) : p;
    let duration = 0;
    try {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' });
      duration = Math.round((parseFloat(out.stdout) || 0) * 100) / 100;
    } catch {}
    return { ok: true, path: rel, duration };
  });
  ipcMain.on('log:renderer', (_e, msg) => log('renderer', String(msg).slice(0, 800)));
  ipcMain.handle('render:start', (e, opts) => startRender(e.sender, opts || {}));
  ipcMain.handle('render:cancel', (_e, id) => cancelRender(id));
  ipcMain.handle('audio:generate', (_e, o) => generateAudio(o || {}));
  ipcMain.handle('pty:start', (e) => startTerm(e.sender));
  ipcMain.on('pty:write', (e, d) => { const h = terms.get(e.sender.id); if (!h) return; h.kind === 'pty' ? h.t.write(d) : h.t.stdin.write(d); });
  ipcMain.on('pty:resize', (e, { cols, rows }) => { const h = terms.get(e.sender.id); if (h?.kind === 'pty') { try { h.t.resize(cols, rows); } catch {} } });
  ipcMain.handle('shell:showItem', (_e, name) => {
    const p = allowedPath(join(settings.work, basename(name || '')));
    if (p && existsSync(p)) shell.showItemInFolder(p);
    return { ok: !!p };
  });
}

// ---------------------------------------------------------------- app lifecycle
process.on('uncaughtException', (e) => { try { log('UNCAUGHT', e?.stack || String(e)); } catch { console.error(e); } });
process.on('unhandledRejection', (e) => { try { log('UNHANDLED-REJECTION', e?.stack || String(e)); } catch {} });

app.whenReady().then(async () => {
  initLog();
  // Packaged GUI apps get a bare PATH (/usr/bin:/bin:…) — `claude`, `python3`, `ffmpeg`
  // from Homebrew/nvm would not resolve. Patch it once, before anything spawns.
  // Never let this block startup: a slow/hanging login shell must not stop the window.
  try {
    await Promise.race([
      import('fix-path').then((m) => m.default()),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch (e) { log('fix-path failed', e.message); }
  ensureToolPaths();
  log('PATH', process.env.PATH?.slice(0, 400));
  loadSettings();
  log('settings', settings);
  registerMediaProtocol();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  watchProject();
  // The self-test can also be driven from a packaged app:
  //   open -a Cutwright.app --args --cve-smoke=ui,term --cve-out=/tmp/x
  const argSmoke = process.argv.find((a) => a.startsWith('--cve-smoke='));
  if (argSmoke) {
    process.env.CVE_SMOKE = argSmoke.split('=')[1];
    const argOut = process.argv.find((a) => a.startsWith('--cve-out='));
    if (argOut) process.env.CVE_SMOKE_OUT = argOut.split('=')[1];
  }
  if (process.env.CVE_SMOKE) (await import('./smoke.mjs')).run({ win, app, settings });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { for (const id of [...terms.keys()]) killTerm(id); for (const [, c] of jobs) { try { c.kill(); } catch {} } });

function buildMenu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.work });
        if (!r.canceled && r.filePaths[0]) { setWorkspace(r.filePaths[0]); win.webContents.send('workspace:changed', settings.work); }
      } },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Open Log Folder', click: () => { try { shell.showItemInFolder(logPath); } catch {} } },
      { label: 'Reload Window', click: () => { try { win?.reload(); } catch {} } },
      { label: 'Check Environment…', click: async () => {
        const env = await checkEnvironment();
        dialog.showMessageBox(win, {
          type: env.ok ? 'info' : 'warning',
          message: env.ok ? 'All required tools found' : 'Missing tools',
          detail: [`ffmpeg:  ${env.tools.ffmpeg || 'NOT FOUND'}`, `ffprobe: ${env.tools.ffprobe || 'NOT FOUND'}`,
            `python:  ${env.tools.python || 'NOT FOUND'}${env.tools.python ? (env.pillow ? ' (Pillow ok)' : ' (Pillow MISSING)') : ''}`,
            `engine:  ${env.engine} ${env.engineOk ? '' : '(NOT FOUND)'}`, '',
            ...env.missing.map((m) => `→ ${m.tool}: ${m.hint}`)].join('\n'),
        });
      } },
    ] },
  ]);
}
