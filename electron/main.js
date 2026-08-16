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
import { readFileSync, writeFileSync, existsSync, mkdirSync, watch, statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
const isDev = !app.isPackaged;

// ---------------------------------------------------------------- settings
// The "workspace" is the folder holding project.json + graded_master.mp4 + renders.
const DEFAULTS = {
  work: process.env.WORK || '/Users/avijit/Pre_final_edit',
  // The render/audio engine still lives in the `video-edit` skill (Python, Phase 4 ports it to Node).
  engine: process.env.ENGINE || join(app.getPath('home'), '.claude/skills/video-edit/scripts'),
  python: process.env.PYTHON || 'python3',
};
let settingsPath = null, settings = { ...DEFAULTS };

function loadSettings() {
  settingsPath = join(app.getPath('userData'), 'settings.json');
  try { settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath, 'utf8')) }; } catch { /* first run */ }
  if (process.env.WORK) settings.work = process.env.WORK;   // env always wins (dev/smoke)
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
  win.once('ready-to-show', () => win.show());
  win.loadFile(join(ROOT, 'renderer/index.html'));
  // Never let the renderer navigate away or open arbitrary windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (isDev && process.env.CVE_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; });
  return win;
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
        name: 'xterm-256color', cols: 100, rows: 30, cwd: settings.work, env,
      });
      t.onData((d) => !wc.isDestroyed() && wc.send('pty:data', d));
      t.onExit(() => !wc.isDestroyed() && wc.send('pty:exit'));
      terms.set(wc.id, { kind: 'pty', t });
      return { ok: true, kind: 'pty', shell: shellPath, cwd: settings.work };
    } catch (e) { console.warn('[pty] fork failed → child_process fallback:', e.message); }
  }
  const { spawn } = await import('node:child_process');
  const t = spawn(shellPath, process.platform === 'win32' ? [] : ['-i'], { cwd: settings.work, env });
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
    work: settings.work, project: projectPath(), engine: settings.engine,
    version: app.getVersion(), platform: process.platform, dev: isDev,
  }));

  ipcMain.handle('workspace:choose', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.work });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    settings.work = r.filePaths[0]; saveSettings(); watchProject();
    return { ok: true, work: settings.work };
  });

  ipcMain.handle('project:get', () => {
    const p = projectPath();
    if (!existsSync(p)) return { error: 'no project.json in ' + settings.work };
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch (e) { return { error: 'unreadable project.json: ' + e.message }; }
  });

  ipcMain.handle('project:save', (_e, data) => {
    if (!data || typeof data !== 'object' || !data.meta) return { ok: false, error: 'refusing to save a malformed project' };
    try { writeFileSync(projectPath(), JSON.stringify(data, null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

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
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.stack || e));

app.whenReady().then(async () => {
  // Packaged GUI apps get a bare PATH (/usr/bin:/bin:…) — `claude`, `python3`, `ffmpeg`
  // from Homebrew/nvm would not resolve. Patch it once, before anything spawns.
  try { (await import('fix-path')).default(); } catch (e) { console.warn('[fix-path]', e.message); }
  loadSettings();
  registerMediaProtocol();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  watchProject();
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
        if (!r.canceled && r.filePaths[0]) { settings.work = r.filePaths[0]; saveSettings(); watchProject(); win.webContents.send('workspace:changed', settings.work); }
      } },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]);
}
