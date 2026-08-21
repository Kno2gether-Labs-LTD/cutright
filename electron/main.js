// Claude Video Editor — Electron main process.
// Collapses the old Express server into the main process: project I/O, local media
// serving (custom `cve://` scheme with HTTP-range support), the render job (run in a
// utilityProcess, never here), audio generation, and the node-pty terminal.
//
// Security posture (do not loosen): contextIsolation:true, sandbox:true,
// nodeIntegration:false, a narrow contextBridge (see preload.cjs) and a strict CSP.
import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, utilityProcess, MessageChannelMain, safeStorage, desktopCapturer, systemPreferences, screen } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, isAbsolute, sep } from 'node:path';
import { makeKeyStore } from './keys.mjs';
import * as mcp from './mcp.mjs';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, cpSync, watch, statSync, createReadStream, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { writeAgentFiles } from './brief.mjs';
import { RecordingSession, newRecordingFolder, defaultRecordingsDir, proposeZooms } from './recording.mjs';
import { listLibrary } from './library.mjs';
import { listAgents, byId as agentById, launchCommand, kickoffPrompt, resolveBin, DEFAULT_AGENT } from './agents.mjs';
import { segmentsFrom, chunk as chunkTranscript, promptFor, parsePlan, merge as mergeCuts, SYSTEM as CUT_SYSTEM } from './cutplan.mjs';
import * as llm from './llm.mjs';
import { snapshot as guardSnapshot, diff as guardDiff, restore as guardRestore } from './guard.mjs';
import { diff as historyDiff, invert as historyInvert, apply as historyApply } from './history.mjs';
import * as media from './media-sources.mjs';
import { isNewer } from './version.mjs';
import { parseSpctl } from './gatekeeper.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '..');
// Anything a child process must *read from disk* (the Python engine, template folders we
// spawn npx in) has to come from app.asar.unpacked — an asar archive is a file, so using a
// path inside it as a cwd fails with ENOTDIR. Both are listed in build.asarUnpack.
const RES = app.isPackaged ? ROOT.replace(/app\.asar(?![.])/, 'app.asar.unpacked') : ROOT;
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
  // The render engine ships with the app (engine/). The video-edit skill keeps its own
  // copy for standalone use; ENGINE= overrides both.
  engine: process.env.ENGINE || join(RES, 'engine'),
  python: process.env.PYTHON || 'python3',
};
let settingsPath = null, settings = { ...DEFAULTS };

// The rename moved userData (Cutwright → Cutright). Carry the old settings, recents and
// installed templates across once, so an existing install does not look factory-fresh.
function migrateOldUserData() {
  try {
    const now = app.getPath('userData');
    const old = join(dirname(now), 'Cutwright');
    if (!existsSync(old) || existsSync(join(now, 'settings.json'))) return;
    mkdirSync(now, { recursive: true });
    for (const name of ['settings.json', 'templates']) {
      const from = join(old, name), to = join(now, name);
      if (existsSync(from) && !existsSync(to)) cpSync(from, to, { recursive: true });
    }
    log('migrated user data from', old);
  } catch (e) { log('user-data migration skipped:', e.message); }
}

function loadSettings() {
  migrateOldUserData();
  settingsPath = join(app.getPath('userData'), 'settings.json');
  try { settings = { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath, 'utf8')) }; } catch { /* first run */ }
  const argWork = process.argv.find((a) => a.startsWith('--cve-work='));
  if (argWork) settings.work = argWork.split('=')[1];
  if (process.env.WORK) settings.work = process.env.WORK;   // env always wins (dev/smoke)
  if (!Array.isArray(settings.recent)) settings.recent = [];
  // whatever we end up opening belongs in Recents, however it was chosen
  if (settings.work && existsSync(join(settings.work, 'project.json'))) {
    settings.recent = [settings.work, ...settings.recent.filter((r) => r !== settings.work)]
      .filter((r) => existsSync(r)).slice(0, 8);
  }
  // a settings file written by an older build can point the engine somewhere that is gone
  if (!settings.engine || !existsSync(join(settings.engine, 'render_project.py'))) {
    settings.engine = DEFAULTS.engine;
  }
}

// Set when the user explicitly picks a project, so the next window load goes straight to
// the editor instead of showing Home again (which reads as "nothing happened").
let openEditorNext = false;

// Remember where the user has been working; the welcome screen offers these.
function refreshAgentBrief() {
  try {
    if (!settings.work || !existsSync(projectPath())) return;
    const p = JSON.parse(readFileSync(projectPath(), 'utf8'));
    const wanted = p?.meta?.template || p?.brief?.template?.id || 'coral-ink-bone';
    const t = listTemplates().find((x) => x.id === wanted) || listTemplates()[0];
    if (!t) return;
    writeAgentFiles({ work: settings.work, template: t, appVersion: app.getVersion(),
      templatesDir: join(RES, 'templates'), enginePath: settings.engine,
      docs: [agentById(settings.agent || DEFAULT_AGENT).doc] });
  } catch (e) { log('brief refresh skipped:', e.message); }
}

function setWorkspace(dir, { fromUser = true } = {}) {
  if (fromUser) openEditorNext = true;
  settings.work = dir;
  // A new project means a new baseline; comparing against the last one would record the whole of
  // this project as a change somebody made.
  lastSeenProject = null;
  settings.recent = [dir, ...settings.recent.filter((r) => r !== dir)].filter((r) => existsSync(r)).slice(0, 8);
  saveSettings(); watchProject();
  refreshAgentBrief();
  log('workspace', dir, fromUser ? '(user opened → straight to the editor)' : '');
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
    const want = url.searchParams.get('p') || '';
    let file = null;
    if (url.hostname === 'template') {
      // template assets (preview images) live in the app or user template dirs
      const abs = resolve(want);
      file = templateDirs().some((d) => abs.startsWith(resolve(d) + sep)) ? abs : null;
    } else if (url.hostname === 'media') {
      file = allowedPath(isAbsolute(want) ? want : join(settings.work, want));
    } else return new Response('not found', { status: 404 });
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
  // Block navigation AWAY from the app, but never block the app reloading itself:
  // will-navigate also fires for location.reload(), and preventing it silently broke
  // every project switch (the window kept showing the old project forever).
  const appUrl = pathToFileURL(indexHtml).toString();
  win.webContents.on('will-navigate', (e, url) => {
    const bare = String(url).split(/[?#]/)[0];
    if (bare === appUrl) return;                 // our own page — a reload, allow it
    log('blocked navigation to', url);
    e.preventDefault();
  });
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
      watchTimer = setTimeout(() => {
        // Whoever wrote it, the change gets recorded. If it was our own save the entry is
        // already in, and this finds nothing to add.
        try { recordEdit('agent'); } catch {}
        if (win && !win.isDestroyed()) win.webContents.send('project:changed');
      }, 250);
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
      // Layered export: the same edit written out as picture / graphics / captions / sound as
      // well as the flat file, for review or for finishing somewhere else.
      layers: opts.layers ? 'layers' : '',
      preview: !!opts.preview,
      noCuts: !!opts.noCuts,
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

// ---------------------------------------------------------------- recording
let recWin = null, session = null;

function openRecorder() {
  if (recWin && !recWin.isDestroyed()) { recWin.show(); recWin.focus(); return recWin; }
  recWin = new BrowserWindow({
    width: 460, height: 640, resizable: false, fullscreenable: false,
    title: 'Record', backgroundColor: '#0a0a09', show: false,
    webPreferences: {
      preload: join(__dir, 'recorder-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false,        // a throttled renderer drops recorded frames
    },
  });
  recWin.once('ready-to-show', () => recWin.show());
  // the recorder is a second window: give it the same diagnostics as the main one
  // Electron 4x passes a single event object; older builds passed positional args. Accept both,
  // or the window's errors are invisible.
  recWin.webContents.on('console-message', (a, level, message) => {
    const lvl = typeof a === 'object' && a?.level !== undefined ? a.level : level;
    const msg = typeof a === 'object' && a?.message !== undefined ? a.message : message;
    if (lvl === 'error' || lvl === 'warning' || lvl >= 2) log('recorder-console', `[${lvl}] ${msg}`);
  });
  recWin.webContents.on('did-fail-load', (_e, code, desc) => log('recorder did-fail-load', code, desc));
  recWin.webContents.on('render-process-gone', (_e, d) => log('recorder gone', JSON.stringify(d)));
  recWin.loadFile(join(ROOT, 'renderer/recorder.html'));
  recWin.on('closed', () => { recWin = null; closeOverlay(); });
  return recWin;
}

// ---------------------------------------------------------------- the recording overlay
// A count-in shown inside an opaque window is a window in the shot: it covers what you are about
// to record and looks like an app, not like recording. So the count and the controls live in a
// window with no frame and no background — it draws a number over your screen and gets out of
// the way, and the controls become a small pill you can drag anywhere.
//
// Transparency cannot be turned on after a window exists, which is why this is a SECOND window
// rather than the recorder resizing itself. The recorder window still owns the capture; it just
// stops being seen.
let overlayWin = null;

function openOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const d = screen.getPrimaryDisplay().bounds;
  const w = new BrowserWindow({
    x: d.x, y: d.y, width: d.width, height: d.height,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    skipTaskbar: true, focusable: false, fullscreenable: false,
    backgroundColor: '#00000000', show: false,
    webPreferences: {
      preload: join(__dir, 'overlay-preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWin = w;
  // Keep the controls and the count-in OUT of the recording. macOS honours this by refusing to
  // share the window's surface with any capture — without it the pill sits in the corner of
  // every take, which is exactly what it looked like.
  try { w.setContentProtection(true); } catch {}
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.loadFile(join(ROOT, 'renderer/overlay.html'));
  // Only clear the reference if THIS window is still the current one. Without that check, a
  // window closed a moment ago fires its `closed` event after a replacement has been created and
  // nulls the reference to the replacement — leaving a pill on screen that nothing can update,
  // move or close, and another one next time. That is exactly what happened.
  w.on('closed', () => { if (overlayWin === w) overlayWin = null; });
  return w;
}

// One window for the whole recording, switched between states. It used to be destroyed and
// rebuilt between the count-in and the controls, which is what created the orphans.
function overlayMode(mode, payload = {}) {
  if (mode === 'hidden') {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    return;
  }
  const w = openOverlay();
  if (!w || w.isDestroyed()) return;
  const d = screen.getPrimaryDisplay().bounds;
  if (mode === 'count') {
    // Full screen and click-through: the number must not swallow a click meant for the app
    // underneath, and it must not be something you can accidentally drag.
    w.setBounds({ x: d.x, y: d.y, width: d.width, height: d.height });
    w.setIgnoreMouseEvents(true);
    w.setFocusable(false);
  } else if (mode === 'controls') {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.setBounds({ x: d.x + 26, y: d.y + Math.round(d.height * 0.3), width: 86, height: 236 });
  }
  const send = () => { try { w.webContents.send('overlay:mode', { mode, ...payload }); } catch {} };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
  if (!w.isVisible()) w.showInactive();
}

function overlayState(state) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.webContents.send('overlay:state', state); } catch {}
  }
}

function closeOverlay() {
  const w = overlayWin;
  overlayWin = null;
  // destroy(), not close(): close is a request the page could in principle delay, and a control
  // that outlives the recording it belongs to is worse than no control at all.
  if (w && !w.isDestroyed()) { try { w.destroy(); } catch {} }
}

// While recording, the recorder window goes away entirely and the overlay is all you see.
function setRecorderCompact(on) {
  log('recorder compact', on ? 'on' : 'off', recWin ? (recWin.isDestroyed() ? 'destroyed' : 'ok') : 'no window');
  if (!recWin || recWin.isDestroyed()) return;
  if (on) {
    overlayMode('controls');
    // NOT hide(). A hidden window stops being composited, and Chromium stops delivering
    // MediaRecorder's data events with it — so the capture produced nothing, the four-second
    // "this capture is empty" guard fired, and the recording aborted itself four seconds in.
    // That was the bug: the recording did not fail, it was hidden to death.
    //
    // Moved off the side of the display instead: still a live, composited window as far as the
    // renderer is concerned, and not in the shot.
    // Still on screen and still composited — so Chromium keeps delivering MediaRecorder's data —
    // but drawn at zero opacity and deaf to the mouse, so nobody sees it and nothing can be
    // clicked by accident. Content protection keeps it out of the capture as well.
    recWin.setOpacity(0);
    recWin.setIgnoreMouseEvents(true);
    try { recWin.setContentProtection(true); } catch {}
    win?.minimize();
  } else {
    closeOverlay();
    recWin.setOpacity(1);
    recWin.setIgnoreMouseEvents(false);
    try { recWin.setContentProtection(false); } catch {}
    recWin.setAlwaysOnTop(false);
    recWin.setSize(460, 640);
    recWin.center();
    recWin.show();
    win?.restore();
  }
}

// Will a permission the user grants today still be recognised after the next update?
//
// macOS decides whether an app is "the same app" by matching it against its designated
// requirement. A build signed ad-hoc has the requirement `cdhash H"..."` — a hash of the build
// itself — so every rebuild is a stranger and the Screen Recording tick stops applying to it. A
// build signed with a certificate gets `identifier "..." and certificate ...`, which survives.
//
// Only the TCC permissions, to be clear. Saved API keys are not affected: safeStorage's keychain
// item has no restrictive ACL, and an ad-hoc build was measured reading what a signed build wrote.
//
// Worth telling the user before they go and grant something, rather than after it silently
// stops working. Read once and cached: it cannot change while the app is running.
let stableIdentity = null;
function hasStableIdentity() {
  if (process.platform !== 'darwin') return true;      // only macOS keys grants to the signature
  if (!app.isPackaged) return true;                    // a dev run is not what gets granted
  if (stableIdentity !== null) return stableIdentity;
  try {
    const bundle = app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
    const r = spawnSync('codesign', ['-d', '-r-', bundle], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const line = out.split('\n').find((l) => l.includes('designated =>'));
    // No answer at all is not evidence of a problem — do not cry wolf.
    stableIdentity = line ? !line.includes('cdhash') : true;
  } catch { stableIdentity = true; }
  return stableIdentity;
}

function registerRecordingIpc() {
  ipcMain.handle('rec:sources', async () => {
    const srcs = await desktopCapturer.getSources({
      types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    const list = srcs
      .filter((s) => !/^Cutright$|^Record —/.test(s.name))       // do not offer our own windows
      // An empty NativeImage stringifies to a data URL with no data, which the page renders as
      // a broken-image icon. When the OS withholds the picture, say so with a placeholder.
      .map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'),
                     thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL() }));
    // Every Mac has at least one display. If none come back, macOS is refusing to hand them
    // over — the permission is denied no matter what getMediaAccessStatus claims.
    const denied = process.platform === 'darwin' && !list.some((s) => s.screen);
    return { sources: list, screenCaptureDenied: denied };
  });

  ipcMain.handle('rec:permissions', () => ({
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    stableIdentity: hasStableIdentity(),
  }));
  ipcMain.handle('rec:request', async (_e, kind) => {
    try { return { ok: await systemPreferences.askForMediaAccess(kind) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('rec:start', (_e, opts) => {
    try {
      const base = settings.recordingsDir || defaultRecordingsDir(app);
      mkdirSync(base, { recursive: true });
      const dir = newRecordingFolder(base, opts.name);
      session = new RecordingSession({
        dir, displays: screen.getAllDisplays(),
        screenPoint: () => screen.getCursorScreenPoint(), log,
      });
      session.open('screen');
      if (opts.camera) session.open('camera');
      session.startCursor(60);
      log('recording started →', dir);
      return { ok: true, dir };
    } catch (e) { log('rec:start failed', e.message); return { error: e.message }; }
  });

  ipcMain.handle('rec:chunk', (_e, { track, buffer }) => {
    if (!session) return { error: 'no recording in progress' };
    return { bytes: session.write(track === 'camera' ? 'camera' : 'screen', buffer) };
  });
  ipcMain.handle('rec:pause', () => { session?.pause(); return { ok: true }; });
  ipcMain.handle('rec:resume', () => { session?.resume(); return { ok: true }; });
  ipcMain.handle('rec:mark', (_e, type) => { session?.mark(type || 'mark'); return { ok: true }; });
  ipcMain.handle('rec:compact', (_e, on) => { setRecorderCompact(on); return { ok: true }; });

  // The count-in: a number over the whole screen, not a window in the shot. n <= 0 clears it.
  ipcMain.handle('rec:count', (_e, n) => {
    const num = Number(n) || 0;
    // Hide, do not destroy: the controls are about to use this same window, and rebuilding it
    // between the two is what left orphaned pills on screen.
    if (num > 0) overlayMode('count', { n: num });
    else overlayMode('hidden');
    return { ok: true };
  });
  ipcMain.on('rec:state', (_e, st) => overlayState({
    elapsed: Number(st?.elapsed) || 0, paused: !!st?.paused,
  }));
  // A button on the overlay is a button on the recorder — relayed, because the recorder window
  // is hidden but is still the only thing that can stop a MediaRecorder.
  ipcMain.on('overlay:action', (_e, kind) => {
    if (!recWin || recWin.isDestroyed()) return;
    try { recWin.webContents.send('rec:remote', String(kind || '').slice(0, 16)); } catch {}
  });
  ipcMain.handle('rec:close', () => {
    if (recWin && !recWin.isDestroyed()) recWin.close();
    win?.restore(); win?.focus();
    return { ok: true };
  });

  ipcMain.handle('rec:stop', async () => {
    if (!session) return { error: 'no recording in progress' };
    const summary = await session.finish();
    log('recording finished', JSON.stringify({ dir: summary.dir, duration: summary.duration, samples: summary.samples }));
    return summary;
  });

  // Throwing a take away should throw the FOLDER away too. A capture that produced nothing left
  // a directory containing a zero-byte screen.mp4 behind — two of those are sitting in the
  // Movies folder right now from a failed attempt, and they are worse than useless: they look
  // like recordings.
  ipcMain.handle('rec:discard', () => {
    const dir = session?.dir;
    session = null;
    try {
      if (dir && existsSync(dir)) {
        // Only if there is genuinely nothing worth keeping. Never delete a take that has bytes.
        const rec = join(dir, 'recording');
        const sizes = existsSync(rec)
          ? readdirSync(rec).map((f) => { try { return statSync(join(rec, f)).size; } catch { return 0; } })
          : [];
        const salvage = sizes.reduce((a, b) => a + b, 0);
        if (salvage < 8192) { rmSync(dir, { recursive: true, force: true }); return { ok: true, removed: dir }; }
        return { ok: true, kept: dir, bytes: salvage };
      }
    } catch (e) { log('discard', e.message); }
    return { ok: true };
  });

  // The recording becomes a project: same pipeline as "Start from a video", plus the
  // provenance and the zoom suggestions derived from the cursor track.
  ipcMain.handle('rec:finalize', async (e, opts = {}) => {
    if (!session) return { error: 'nothing to finalise' };
    const rec = session;
    const source = rec.file('screen');
    // A capture the OS silently refused leaves a zero-byte file. Say so plainly rather than
    // failing later inside ffprobe with something the user cannot act on.
    const bytes = (() => { try { return statSync(source).size; } catch { return 0; } })();
    if (bytes < 8192) {
      session = null;
      return { error: 'macOS did not let Cutright capture the screen, so nothing was recorded. '
                    + 'Open System Settings → Privacy & Security → Screen Recording, switch Cutright on '
                    + '(if it is already on, switch it off and on again), then quit and reopen the app.' };
    }
    const send = (m) => { try { e.sender.send('rec:progress', m); } catch {} };

    const child = utilityProcess.fork(join(__dir, 'newproject-worker.cjs'), [], {
      serviceName: 'cve-recording', stdio: 'pipe', env: { ...process.env, CVE_APP_VERSION: app.getVersion() },
    });
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: 'port' }, [port1]);
    port2.on('message', async (ev) => {
      const m = ev.data;
      if (m.type === 'progress') return send(m);
      if (m.type === 'error') { send(m); session = null; return; }
      if (m.type === 'done') {
        try {
          const pPath = join(rec.dir, 'project.json');
          const project = JSON.parse(readFileSync(pPath, 'utf8'));
          const cursor = JSON.parse(readFileSync(join(rec.dir, 'recording', 'cursor.json'), 'utf8'));
          let words = [];
          try { words = JSON.parse(readFileSync(join(rec.dir, 'transcript.json'), 'utf8')); } catch {}

          // The camera is a TRACK, not an attachment: the render composites it over the screen,
          // which is what lets the speaker take the whole frame when the screen has nothing to
          // say. Without this the camera file is just something sitting in a folder.
          if (existsSync(rec.file('camera'))) {
            project.meta = { ...project.meta, tracks: {
              screen: project.meta?.graded || 'graded_master.mp4',
              camera: 'recording/camera.mp4',
              cameraHome: { to: 'corner', shape: 'circle', size: 0.24, corner: 'br', margin: 0.045 },
            } };
          }
          // Provenance, so the library can say where this came from without guessing. The app
          // made this folder; a year later that is not obvious from the files inside it.
          project.meta = { ...project.meta,
            origin: 'recording',
            createdBy: `Cutright ${app.getVersion()}`,
            createdAt: new Date(rec.startedAt).toISOString() };
          project.recording = {
            startedAt: new Date(rec.startedAt).toISOString(),
            screen: 'recording/screen.mp4',
            camera: existsSync(rec.file('camera')) ? 'recording/camera.mp4' : null,
            cursor: 'recording/cursor.json',
            duration: rec.elapsed,
            display: cursor.display || null,
            marks: (cursor.events || []).map((x) => x.t),
          };
          // Suggestions, not edits: the user (or the agent) decides which land.
          project.recording.zoomSuggestions = proposeZooms({
            samples: cursor.samples || [], events: cursor.events || [],
            duration: project.meta?.duration || rec.elapsed, words,
          });
          writeFileSync(pPath, JSON.stringify(project, null, 2));
          setWorkspace(rec.dir);
          refreshAgentBrief();
          send({ type: 'done', ...m, dir: rec.dir,
                 zoomSuggestions: project.recording.zoomSuggestions.length });
          win?.webContents.reload();
        } catch (err) { send({ type: 'error', error: err.message }); }
        session = null;
      }
    });
    port2.start();

    child.postMessage({ type: 'create', job: {
      source, dest: rec.dir, engineDir: settings.engine,
      transcribe: opts.transcribe !== false, model: opts.model || 'small.en',
      language: '', gradeRef: '', targetHeight: 1080, targetFps: 30,
    } });
    return { ok: true, dir: rec.dir };
  });

  // Preprocess: one action that does the structural pass — transcribe, cut, decide who has the
  // frame, apply the pack, size the panels — and writes it all into project.json.
  ipcMain.handle('prepare:start', (e, opts = {}) => {
    if (!settings.work) return { error: 'no project open' };
    const child = utilityProcess.fork(join(__dir, 'prepare-worker.cjs'), [], {
      serviceName: 'cve-prepare', stdio: 'pipe',
      env: { ...process.env, CVE_ENGINE: settings.engine },
    });
    const id = 'prep' + Date.now();
    const { port1, port2 } = new MessageChannelMain();
    child.postMessage({ type: 'port' }, [port1]);
    e.sender.postMessage('prepare:port', { id }, [port2]);
    child.stderr?.on('data', (d) => log('[prepare!]', d.toString().trim().slice(0, 300)));

    const tpl = opts.template ? listTemplates().find((t) => t.id === opts.template) : null;
    child.postMessage({ type: 'prepare', job: {
      work: settings.work, template: tpl || null, options: opts.options || {},
    } });
    // the brief is rewritten once the pass lands, so the agent reads the decisions it just made
    child.on('exit', () => { try { refreshAgentBrief(); } catch {} });
    return { id };
  });

  // The same verifier the agent runs, from the toolbar — one spawn, no worker needed.
  ipcMain.handle('project:verify', async () => {
    if (!settings.work) return { error: 'no project open' };
    return new Promise((resolve) => {
      const py = spawn(settings.python || 'python3',
        [join(settings.engine, 'verify_project.py'), '--project', projectPath(), '--json'],
        { cwd: settings.work, env: process.env });
      let out = '', err = '';
      py.stdout.on('data', (d) => (out += d));
      py.stderr.on('data', (d) => (err += d));
      py.on('error', (e) => resolve({ error: e.message }));
      py.on('close', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ error: (err || out || 'the verifier said nothing').slice(-300) }); }
      });
    });
  });

  ipcMain.handle('rec:privacy', () => {
    // Deep-links straight to Privacy & Security → Screen Recording.
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    } else if (process.platform === 'win32') {
      shell.openExternal('ms-settings:privacy-broadfilesystemaccess');
    }
    return { ok: true };
  });

  ipcMain.handle('rec:open', () => { openRecorder(); return { ok: true }; });
}

// ---------------------------------------------------------------- new project
// The on-ramp: a raw recording in, a workspace out. Without this the app can only open
// folders someone else prepared, which is the single least obvious thing about it.
// Where a file dialog should start when we have no better idea: the user's home on
// macOS/Linux, Documents on Windows (where recordings actually land there).
function defaultBrowseDir() {
  try {
    return process.platform === 'win32' ? app.getPath('documents') : app.getPath('home');
  } catch { return app.getPath('home'); }
}

async function pickVideo() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a recording to edit',
    defaultPath: settings.lastBrowseDir || defaultBrowseDir(),
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'mpg', 'mpeg'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  const src = r.filePaths[0];
  settings.lastBrowseDir = dirname(src); saveSettings();
  const base = basename(src).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
  return { ok: true, source: src, suggestedDest: join(dirname(src), base + '_edit'), name: basename(src) };
}

async function pickFolder(defaultPath, title) {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    defaultPath: defaultPath || settings.lastBrowseDir || defaultBrowseDir(),
    properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Choose',
  });
  return r.canceled || !r.filePaths[0] ? { ok: false } : { ok: true, dir: r.filePaths[0] };
}

function createProject(webContents, opts = {}) {
  const source = String(opts.source || '');
  const dest = String(opts.dest || '');
  if (!source || !existsSync(source)) return { error: 'choose a video first' };
  if (!dest) return { error: 'choose where to put the project' };

  const child = utilityProcess.fork(join(__dir, 'newproject-worker.cjs'), [], {
    serviceName: 'cve-newproject', stdio: 'pipe', env: { ...process.env, CVE_APP_VERSION: app.getVersion() },
  });
  const id = 'np' + Date.now();
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  webContents.postMessage('newproject:port', { id }, [port2]);
  child.stderr?.on('data', (d) => log('[newproject!]', d.toString().trim().slice(0, 300)));
  child.stdout?.on('data', (d) => log('[newproject]', d.toString().trim().slice(0, 200)));

  child.postMessage({ type: 'create', job: {
    source, dest, engineDir: settings.engine,
    transcribe: opts.transcribe !== false,
    model: String(opts.model || 'small.en'),
    language: String(opts.language || ''),
    gradeRef: String(opts.gradeRef || ''),
    targetHeight: Number(opts.targetHeight || 1080),
    targetFps: Number(opts.targetFps || 30),
  } });
  // The port belongs to the renderer now, so it tells us when to adopt the new folder
  // (see editor.newProject.adopt) rather than main trying to listen on a transferred port.
  return { id, dest };
}

// ---------------------------------------------------------------- templates
// A template is data + composition files (see templates/README.md). Two search paths:
// the ones bundled with the app, and the user's own — the user's win on an id clash, so
// a downloaded template can supersede a built-in one.
function templateDirs() {
  return [join(app.getPath('userData'), 'templates'), join(RES, 'templates')];
}
function listTemplates() {
  const found = new Map();
  for (const dir of templateDirs()) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const manifestPath = join(dir, ent.name, 'template.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!m.id || found.has(m.id)) continue;             // first path wins (user dir)
        const preview = join(dir, ent.name, m.preview || 'preview.png');
        found.set(m.id, { ...m, dir: join(dir, ent.name), builtin: dir !== templateDirs()[0],
          previewUrl: existsSync(preview) ? 'cve://template/?p=' + encodeURIComponent(preview) : null });
      } catch (e) { log('template manifest unreadable', manifestPath, e.message); }
    }
  }
  return [...found.values()];
}

function applyTemplate(id) {
  const t = listTemplates().find((x) => x.id === id);
  if (!t) return { ok: false, error: 'unknown template: ' + id };
  if (!settings.work) return { ok: false, error: 'no workspace open' };
  try {
    const p = JSON.parse(readFileSync(projectPath(), 'utf8'));
    p.meta = p.meta || {};
    p.meta.template = t.id;
    p.meta.style = t.id;                                   // the engine reads meta.style
    p.captions = p.captions || { defaults: {}, cues: [] };
    p.captions.defaults = { ...p.captions.defaults, ...(t.captions || {}) };
    writeFileSync(projectPath(), JSON.stringify(p, null, 2));

    // Choosing a template is a briefing act: record what the agent may use and how.
    const briefed = writeAgentFiles({
      work: settings.work, template: t, appVersion: app.getVersion(),
      templatesDir: join(RES, 'templates'), enginePath: settings.engine,
    });
    log('briefed the agent', JSON.stringify(briefed));
    return { ok: true, template: t.id, captions: p.captions.defaults, brief: briefed };
  } catch (e) { return { ok: false, error: e.message }; }
}

function renderPreset(webContents, opts = {}) {
  if (!settings.work) return { error: 'no workspace open' };
  const t = listTemplates().find((x) => x.id === opts.template);
  if (!t) return { error: 'unknown template' };
  const preset = (t.overlays || []).find((o) => o.id === opts.preset);
  if (!preset) return { error: 'unknown preset' };

  const safe = (s) => String(s).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40).toLowerCase();
  const outPath = join(settings.work, 'overlays', `${safe(t.id)}-${safe(preset.id)}-${Date.now()}.mov`);

  const child = utilityProcess.fork(join(__dir, 'template-worker.cjs'), [], {
    serviceName: 'cve-template', stdio: 'pipe', env: { ...process.env },
  });
  const id = 'tpl' + Date.now();
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  webContents.postMessage('template:port', { id }, [port2]);
  child.stderr?.on('data', (d) => log('[template!]', d.toString().trim().slice(0, 300)));

  child.postMessage({ type: 'render-preset', job: {
    templateDir: t.dir, engine: t.engine || 'hyperframes',
    composition: preset.composition, remotionId: preset.remotionId, remotionEntry: preset.remotionEntry,
    vars: opts.vars || {}, outPath, fps: Number(opts.fps || 30), quality: opts.quality || 'high',
  } });
  return { id, out: outPath };
}

// ---------------------------------------------------------------- API keys
// Every keychain call happens in a throwaway copy of this app, not here.
//
// safeStorage is synchronous and main-process-only, and on macOS it can simply not return: when
// the app's code signature has changed since a key was stored (every rebuild of an app without a
// Developer ID certificate) the system holds the call. Measured at 584 seconds, whole app frozen,
// nothing in the log. There is no timeout to pass and no async variant to await — the only way to
// bound it is to put it in a process we can kill.
function keyOp(op, data = '', timeoutMs = 12_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [app.getAppPath()], {
      env: { ...process.env, CUTRIGHT_KEY_OP: op, CUTRIGHT_KEY_DATA: data,
             ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = (r) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(r); };
    const timer = setTimeout(() => {
      log('keychain', op, `gave up after ${timeoutMs}ms — the OS did not answer`);
      done({ ok: false, error: 'the system keychain did not respond', timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('close', () => {
      const m = /CUTRIGHT_KEY_RESULT(\{.*\})/s.exec(out);
      if (!m) return done({ ok: false, error: 'the keychain helper returned nothing' });
      try { done(JSON.parse(m[1])); } catch (e) { done({ ok: false, error: e.message }); }
    });
  });
}

// Remote transcription needs a key. It is encrypted with the OS keychain (safeStorage) and only
// ever leaves main to go to the provider — never to the renderer. The rules live in keys.mjs
// so they can be tested without an app; the one that matters is that asking whether a key
// exists must not decrypt it (see the note there).
const keyStore = makeKeyStore({ runOp: keyOp, getSettings: () => settings, save: () => saveSettings() });
const setApiKey = (provider, value) => keyStore.set(provider, value);
const getApiKey = (provider) => keyStore.get(provider);       // async: it may unlock the keychain
const hasApiKey = (provider) => keyStore.has(provider);
const knownKeys = () => keyStore.known();

// ---------------------------------------------------------------- transcription
async function transcribeMedia(webContents, opts = {}) {
  if (!settings.work) return { error: 'no workspace open' };
  let project = {};
  try { project = JSON.parse(readFileSync(projectPath(), 'utf8')); } catch { /* a project is optional for transcribing */ }

  const child = utilityProcess.fork(join(__dir, 'transcribe-worker.cjs'), [], {
    serviceName: 'cve-transcribe', stdio: 'pipe', env: { ...process.env },
  });
  const id = 'stt' + Date.now();
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage({ type: 'port' }, [port1]);
  webContents.postMessage('transcribe:port', { id }, [port2]);

  child.stderr?.on('data', (d) => log('[stt!]', d.toString().trim().slice(0, 300)));
  child.stdout?.on('data', (d) => log('[stt]', d.toString().trim().slice(0, 300)));

  const engine = String(opts.engine || 'hyperframes');
  // Unlocking a key can involve the OS keychain, so it is awaited here — at the point of use,
  // with the job already announced to the UI — rather than while drawing anything.
  const apiKey = engine === 'openai' ? await getApiKey('openai')
               : engine === 'elevenlabs' ? await getApiKey('elevenlabs') : '';
  child.postMessage({ type: 'transcribe', job: {
    work: settings.work,
    media: opts.media || project?.meta?.graded || 'graded_master.mp4',
    engine,
    model: opts.model || '',
    language: opts.language || '',
    modelPath: opts.modelPath || '',
    rebuildCaptions: opts.rebuildCaptions !== false,
    wordsPerCue: Number(opts.wordsPerCue || 3),
    apiKey,
  } });
  return { id };
}

// ---------------------------------------------------------------- analysis (auto-cut)
// Runs in its own utilityProcess: it shells out to ffmpeg, so it must not sit on main.
// ---------------------------------------------------------------- cuts, by reading the words
// silencedetect knows when nobody is speaking; it cannot know that a take was abandoned or that
// an aside went nowhere. A model reading the transcript can. It never touches the video: it
// returns segment numbers, cutplan.mjs turns those into spans that already exist in the
// transcript, and they arrive in the same review panel as everything else for the user to tick.
async function planCutsByReading({ words, acoustic, onNote }) {
  const cfg = settings.llm || {};
  if (!cfg.baseUrl || !cfg.model) return { cuts: [], note: 'no endpoint configured' };

  let key = '';
  try { key = await getApiKey('llm'); } catch { key = ''; }

  const segs = segmentsFrom(words);
  if (segs.length < 4) return { cuts: [], note: 'not enough speech to read' };
  const chunks = chunkTranscript(segs, { maxTokens: Number(cfg.maxTokens) || 2000 });

  const found = [];
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    onNote?.({ stage: 'reading', i: i + 1, of: chunks.length });
    const r = await llm.chat({ baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model,
                               system: CUT_SYSTEM, user: promptFor(chunks[i]),
                               timeoutMs: Number(cfg.timeoutMs) || 90_000 });
    if (!r.ok) {
      // One passage failing is not a reason to lose the rest, but the user should hear about it
      // rather than wonder why half the video was considered.
      notes.push(`passage ${i + 1}: ${r.error}`);
      continue;
    }
    const parsed = parsePlan(r.text, chunks[i]);
    if (parsed.rejected) notes.push(`passage ${i + 1}: ${parsed.rejected}`);
    found.push(...parsed.cuts);
  }

  // Overlapping suggestions from the overlapping chunks collapse into one.
  const deduped = [];
  for (const c of found.sort((a, b) => a.start - b.start)) {
    const last = deduped[deduped.length - 1];
    if (last && c.start < last.end - 0.05) { last.end = Math.max(last.end, c.end); continue; }
    deduped.push({ ...c });
  }
  return { cuts: mergeCuts([], deduped).filter((c) => !acoustic.some((a) => c.start < a.end - 0.05 && c.end > a.start + 0.05)),
           note: notes.join('; ') || null, passages: chunks.length };
}

function analyzeCuts(opts = {}) {
  return new Promise((resolve) => {
    if (!settings.work) return resolve({ error: 'no workspace open' });
    let project = {};
    try { project = JSON.parse(readFileSync(projectPath(), 'utf8')); } catch (e) { return resolve({ error: 'no project.json' }); }

    const child = utilityProcess.fork(join(__dir, 'analysis-worker.cjs'), [], {
      serviceName: 'cve-analysis', stdio: 'pipe', env: { ...process.env },
    });
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; try { child.kill(); } catch {} resolve(v); };

    child.stderr?.on('data', (d) => log('[analysis!]', d.toString().trim().slice(0, 300)));
    child.on('message', async (m) => {
      if (m?.type === 'error') return finish({ error: m.error });
      if (m?.type !== 'result') return;
      if (!opts.ai) return finish({ ok: true, ...m });
      // The acoustic pass has already produced the proposals the waveform can justify. The
      // reading pass adds the ones it cannot, and can only ever add: a failure here leaves the
      // user exactly where they would have been without it.
      let words = [];
      try {
        const raw = JSON.parse(readFileSync(join(settings.work, 'transcript.json'), 'utf8'));
        words = Array.isArray(raw) ? raw : (raw.words || raw.transcript || []);
      } catch { return finish({ ok: true, ...m, ai: { cuts: 0, note: 'no transcript to read' } }); }
      try {
        const r = await planCutsByReading({ words, acoustic: m.proposals || [] });
        finish({ ok: true, ...m, proposals: mergeCuts(m.proposals || [], r.cuts),
                 ai: { cuts: r.cuts.length, note: r.note, passages: r.passages } });
      } catch (e) {
        finish({ ok: true, ...m, ai: { cuts: 0, note: String(e?.message || e) } });
      }
    });
    child.on('exit', () => finish({ error: 'analysis worker exited' }));
    setTimeout(() => finish({ error: 'analysis timed out' }), 10 * 60 * 1000);

    child.postMessage({ type: 'analyze', job: {
      work: settings.work,
      media: project?.meta?.graded || 'graded_master.mp4',
      transcript: 'transcript.json',
      duration: project?.meta?.duration || 0,
      noiseDb: Number(opts.noiseDb ?? -32),
      minSilence: Number(opts.minSilence ?? 0.7),
      pad: Number(opts.pad ?? 0.12),
      minCut: Number(opts.minCut ?? 0.35),
      fillers: opts.fillers !== false,
      stutters: opts.stutters !== false,
      softFillers: !!opts.softFillers,
    } });
  });
}

// ---------------------------------------------------------------- audio generation
async function generateAudio({ kind, text, at, dur }) {
  // A key saved in the app was never reaching the generator, which only read the environment —
  // so "saved" keys silently did nothing here. Unlock it at the point of use and pass it down.
  const elevenlabs = await getApiKey('elevenlabs');
  return new Promise((res) => {
    if (!['sfx', 'voice', 'music'].includes(kind)) return res({ ok: false, error: 'bad kind' });
    const script = join(settings.engine, 'audio_agent.py');
    const args = [script, kind, '--project', projectPath()];
    // the panel asks for a length; fall back to what each kind usually wants
    const seconds = Number(dur) > 0 ? String(Number(dur)) : (kind === 'music' ? '30' : '2');
    if (kind === 'sfx') args.push('--prompt', text, '--at', String(at), '--dur', seconds);
    else if (kind === 'voice') args.push('--text', text, '--at', String(at));
    else args.push('--prompt', text, '--start', String(at), '--dur', seconds);
    import('node:child_process').then(({ spawn }) => {
      const py = spawn(settings.python, args, {
        cwd: settings.work,
        env: { ...process.env, ...(elevenlabs ? { ELEVENLABS_API_KEY: elevenlabs } : {}) },
      });
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
  // `.mcp.json` refers to ${ELEVENLABS_API_KEY} rather than carrying the key, so the shell Claude
  // runs in is where the value has to appear. Unlocking touches the keychain, which is bounded
  // (see keys.mjs) — and a terminal that opens a moment later is better than a key on disk.
  for (const [provider, server] of Object.entries(mcp.SERVERS)) {
    if (!hasApiKey(provider)) continue;
    try {
      const v = await getApiKey(provider);
      if (v) env[server.envVar] = v;
    } catch (e) { log('mcp env', provider, e.message); }
  }
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
// ---------------------------------------------------------------- the edit ledger
// Every change to project.json becomes an entry: what moved, and who moved it. Both halves come
// from the same place — we compare the file against the last version we saw — so an edit made in
// the app and an edit made by the agent are recorded identically. The only difference is the
// name on it, and that is decided by whether we were the ones who just wrote.
const HISTORY_MAX = 300;
const historyFile = () => join(settings.work, '.cutright', 'history.json');
let lastSeenProject = null;

function readHistory() {
  try { const h = JSON.parse(readFileSync(historyFile(), 'utf8')); return Array.isArray(h) ? h : []; }
  catch { return []; }
}
function writeHistory(list) {
  try {
    mkdirSync(dirname(historyFile()), { recursive: true });
    writeFileSync(historyFile(), JSON.stringify(list.slice(-HISTORY_MAX), null, 1));
  } catch (e) { log('history', e.message); }
}
function currentProject() {
  try { return JSON.parse(readFileSync(projectPath(), 'utf8')); } catch { return null; }
}

// Called after anything writes project.json. The first call after opening a project only takes a
// baseline: there is nothing to compare against yet, and inventing an entry for "the project
// exists" would put noise at the top of every history.
function recordEdit(by) {
  if (!settings.work) return null;
  const cur = currentProject();
  if (!cur) return null;
  if (!lastSeenProject) { lastSeenProject = cur; return null; }
  let d;
  try { d = historyDiff(lastSeenProject, cur); } catch (e) { log('history diff', e.message); lastSeenProject = cur; return null; }
  lastSeenProject = cur;
  if (!d.changes.length) return null;
  const entry = { id: 'h' + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36),
                  at: new Date().toISOString(), by, summary: d.summary, changes: d.changes };
  const list = readHistory();
  list.push(entry);
  writeHistory(list);
  try { win?.webContents.send('history:changed'); } catch {}
  return entry;
}

function registerHistoryIpc() {
  ipcMain.handle('history:list', () => {
    if (!settings.work) return { entries: [] };
    // Newest first, and without the full before/after payloads — the list only needs to say what
    // happened; the detail is fetched when a row is opened.
    return { entries: readHistory().slice().reverse().map((e) => ({
      id: e.id, at: e.at, by: e.by, summary: e.summary, count: e.changes.length,
      changes: e.changes.map((c) => ({ kind: c.kind, id: c.id, op: c.op, at: c.at,
                                       what: c.what, fields: c.fields || [] })),
    })) };
  });

  ipcMain.handle('history:revert', (_e, o = {}) => {
    if (!settings.work) return { error: 'no workspace open' };
    const entry = readHistory().find((x) => x.id === o.id);
    if (!entry) return { error: 'that entry is not in the history any more' };
    // Either the whole entry, or the specific changes the user ticked.
    const wanted = Array.isArray(o.changes) && o.changes.length
      ? entry.changes.filter((c) => o.changes.includes(`${c.kind}:${c.id}`))
      : entry.changes;
    if (!wanted.length) return { error: 'nothing selected to take back' };
    const project = currentProject();
    if (!project) return { error: 'could not read project.json' };
    let out;
    try { out = historyApply(project, wanted.map(historyInvert), { force: !!o.force }); }
    catch (e) { return { error: e.message }; }
    if (!out.applied.length) {
      return { ok: true, applied: 0, conflicts: out.conflicts.map((c) => ({ what: c.change.what, why: c.why })) };
    }
    writeFileSync(projectPath(), JSON.stringify(project, null, 2));
    // Reverting is itself an edit, and shows up in the history as one.
    recordEdit('you');
    return { ok: true, applied: out.applied.length,
             conflicts: out.conflicts.map((c) => ({ what: c.change.what, why: c.why })) };
  });
}

// ---------------------------------------------------------------- about, and updates
// Two questions a user should never have to guess at: what am I running, and is there a newer
// one? The first is knowable for certain; the second is answered honestly rather than
// automatically — see docs/UPDATES.md for why nothing installs itself yet.
let buildFactsCache = null;
function buildFacts() {
  if (buildFactsCache) return buildFactsCache;
  const bundle = process.platform === 'darwin' && app.isPackaged
    ? app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '') : null;
  let identity = null, notarized = null, gate = null;
  if (bundle) {
    try {
      const r = spawnSync('codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8', timeout: 5000 });
      const out = (r.stdout || '') + (r.stderr || '');
      identity = (out.split('\n').find((l) => l.startsWith('Authority=')) || '').replace('Authority=', '') || null;
    } catch {}
    try {
      // Gatekeeper's own verdict is the honest source. Reading it is fussier than it looks: an
      // un-notarised build says "source=Unnotarized Developer ID", so a naive match for
      // "notarized" finds it inside "Unnotarized" and reports a REJECTED build as fine. That
      // shipped once; gatekeeper.mjs exists so it cannot again.
      const r = spawnSync('spctl', ['-a', '-vv', bundle], { encoding: 'utf8', timeout: 8000 });
      gate = parseSpctl((r.stdout || '') + (r.stderr || ''));
      notarized = gate.notarized;
    } catch {}
  }
  buildFactsCache = {
    name: app.getName(), version: app.getVersion(),
    packaged: app.isPackaged, platform: process.platform, arch: process.arch,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    identity, notarized, gatekeeper: gate ? gate.plain : null, accepted: gate ? gate.accepted : null,
    engine: settings.engine || null,
    settingsFile: settingsPath,
    logFile: (() => { try { return logPath; } catch { return null; } })(),
  };
  return buildFactsCache;
}

const UPDATE_FEED = 'https://api.github.com/repos/Kno2gether-Labs-LTD/cutright/releases/latest';

async function checkForUpdate() {
  const current = app.getVersion();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(UPDATE_FEED, {
      signal: ctl.signal,
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Cutright/${current}` },
    });
    // 404 is the normal answer while every release is still a draft — say that plainly rather
    // than reporting a failure the user cannot act on.
    if (r.status === 404) return { ok: true, current, latest: null, newer: false, none: true };
    if (!r.ok) return { ok: false, current, error: `the update feed answered ${r.status}` };
    const j = await r.json();
    const latest = String(j.tag_name || j.name || '').trim();
    return {
      ok: true, current, latest, newer: isNewer(latest, current),
      url: j.html_url || 'https://github.com/Kno2gether-Labs-LTD/cutright/releases',
      notes: String(j.body || '').slice(0, 1200),
      publishedAt: j.published_at || null,
    };
  } catch (e) {
    return { ok: false, current,
             error: e?.name === 'AbortError' ? 'the update check timed out' : String(e?.message || e) };
  } finally { clearTimeout(timer); }
}

function registerIpc() {
  ipcMain.handle('config:get', () => ({
    work: settings.work, project: settings.work ? projectPath() : '', engine: settings.engine,
    recent: settings.recent, hasWorkspace: !!settings.work,
    skipHome: (() => { const v = openEditorNext; openEditorNext = false; return v; })(),
    version: app.getVersion(), platform: process.platform, dev: isDev,
    // Automated runs must not kick off background renders on every edit: it burns the machine
    // and swaps the player's source underneath tests that are checking something else.
    testing: !!process.env.CVE_SMOKE,
  }));

  // Anything edited by hand is stamped in the project; this keeps a copy of those next to it, so
  // that after the agent has rewritten everything there is something to compare against. Written
  // when the agent is handed the project, which is the moment the risk starts.
  const guardFile = () => join(settings.work, '.cutright', 'handoff.json');
  const readGuard = () => { try { return JSON.parse(readFileSync(guardFile(), 'utf8')); } catch { return null; } };
  const readProject = () => JSON.parse(readFileSync(projectPath(), 'utf8'));

  ipcMain.handle('guard:snapshot', () => {
    if (!settings.work) return { error: 'no workspace open' };
    try {
      const snap = guardSnapshot(readProject());
      mkdirSync(dirname(guardFile()), { recursive: true });
      writeFileSync(guardFile(), JSON.stringify(snap, null, 2));
      return { ok: true, count: snap.count, at: snap.at };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('guard:check', () => {
    if (!settings.work) return { error: 'no workspace open' };
    const before = readGuard();
    if (!before) return { ok: true, none: true, missing: [], moved: [], checked: 0 };
    try {
      const d = guardDiff(before, readProject());
      return { ok: true, at: before.at, ...d };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('guard:restore', () => {
    if (!settings.work) return { error: 'no workspace open' };
    const before = readGuard();
    if (!before) return { error: 'nothing was recorded to restore from' };
    try {
      const p = readProject();
      const put = guardRestore(p, before);
      writeFileSync(projectPath(), JSON.stringify(p, null, 2));
      return { ok: true, restored: put };
    } catch (e) { return { error: e.message }; }
  });

  // The endpoint that reads the transcript and suggests cuts. Only the OpenAI-compatible shape
  // is supported, which is not a limitation so much as the point: Ollama, LM Studio, llama.cpp
  // and vLLM all speak it, so "run a model on my own machine" and "use a hosted one" are the
  // same code path, and nothing has to ship a model or an inference runtime inside a video editor.
  ipcMain.handle('llm:status', async () => ({
    baseUrl: settings.llm?.baseUrl || '', model: settings.llm?.model || '',
    hasKey: hasApiKey('llm'),
    local: await llm.detectLocal(),
  }));
  ipcMain.handle('llm:set', (_e, o = {}) => {
    settings.llm = { ...(settings.llm || {}),
      baseUrl: llm.normaliseBase(o.baseUrl), model: String(o.model || '').slice(0, 120) };
    saveSettings();
    return { ok: true, ...settings.llm };
  });
  ipcMain.handle('llm:models', async (_e, o = {}) => {
    const base = llm.normaliseBase(o.baseUrl || settings.llm?.baseUrl);
    let key = '';
    try { key = await getApiKey('llm'); } catch {}
    return llm.listModels({ baseUrl: base, apiKey: key });
  });
  // Ask it something trivial, so "is this set up?" is answered by the endpoint rather than by
  // the first real run failing halfway through a transcript.
  ipcMain.handle('llm:test', async () => {
    const cfg = settings.llm || {};
    let key = ''; try { key = await getApiKey('llm'); } catch {}
    const r = await llm.chat({ baseUrl: cfg.baseUrl, apiKey: key, model: cfg.model,
      system: 'Reply with JSON only.', user: 'Reply with exactly {"ok":true}', timeoutMs: 20_000 });
    if (!r.ok) return r;
    return { ok: true, text: String(r.text).slice(0, 120), usage: r.usage };
  });

  // Where to get footage, stills and sound you are allowed to use. We host nothing and download
  // nothing — this is a directory, and the part that earns its place is the licence on each entry.
  ipcMain.handle('media:sources', (_e, o = {}) => ({
    sources: media.list(join(RES, 'data'), {
      kind: ['video', 'image', 'audio'].includes(o.kind) ? o.kind : '',
      commercialOnly: !!o.commercialOnly,
    }),
  }));

  // Recorded at the moment the material is taken. Working out afterwards which of forty sounds
  // needed crediting is a job nobody does.
  ipcMain.handle('media:credit', (_e, o = {}) => {
    if (!settings.work) return { error: 'no workspace open' };
    const src = media.byId(join(RES, 'data'), String(o.source || ''));
    if (!src) return { error: 'unknown source' };
    try {
      const p = JSON.parse(readFileSync(projectPath(), 'utf8'));
      p.credits = p.credits || [];
      const entry = media.creditFor(src, { title: o.title, author: o.author, url: o.url });
      p.credits.push(entry);
      writeFileSync(projectPath(), JSON.stringify(p, null, 2));
      return { ok: true, credit: entry, total: p.credits.length };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle('app:about', () => buildFacts());
  ipcMain.handle('app:checkUpdate', () => checkForUpdate());

  // Which coding agent does the editing. Everything the app writes is agent-neutral — the brief
  // goes into AGENTS.md as well as CLAUDE.md — so this is a choice, not a port.
  ipcMain.handle('agents:list', () => ({
    agents: listAgents({ env: process.env, selected: settings.agent || DEFAULT_AGENT }),
    selected: settings.agent || DEFAULT_AGENT,
  }));
  ipcMain.handle('agents:set', (_e, id) => {
    const a = agentById(String(id || ''));
    settings.agent = a.id;
    saveSettings();
    refreshAgentBrief();                       // the new agent may read a different filename
    return { ok: true, id: a.id, launch: launchCommand(a.id), doc: a.doc };
  });
  ipcMain.handle('agents:launch', () => {
    const id = settings.agent || DEFAULT_AGENT;
    const a = agentById(id);
    // Report whether it is actually there. Typing a command for a missing binary would put a
    // "command not found" in the terminal and leave the user to work out why.
    return { id, command: launchCommand(id), kickoff: kickoffPrompt(id), doc: a.doc,
             name: a.name, available: !!resolveBin(a.bin, process.env), install: a.install };
  });

  // What the Home screen lists: projects the user has opened, plus recordings the app made and
  // put in ~/Movies/Cutright, which would otherwise only be findable in Finder.
  ipcMain.handle('library:list', () => {
    try {
      return { items: listLibrary({ recent: settings.recent || [],
                                    recordingsDir: defaultRecordingsDir(app) }) };
    } catch (e) { log('library', e.message); return { items: [], error: e.message }; }
  });

  ipcMain.handle('workspace:choose', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'],
      defaultPath: settings.work || defaultBrowseDir(), title: 'Open a Cutright project folder' });
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

  // the word-level transcript backs the transcript editor and the auto-cut analysis
  ipcMain.handle('transcript:get', () => {
    if (!settings.work) return { error: 'no workspace open' };
    const p = join(settings.work, 'transcript.json');
    if (!existsSync(p)) return { error: 'no transcript.json — run Transcribe first' };
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      const list = Array.isArray(raw) ? raw : (raw.words || raw.transcript || []);
      const words = list.map((w) => ({
        text: String(w.text ?? w.word ?? '').trim(),
        start: Number(w.start ?? w.from), end: Number(w.end ?? w.to),
      })).filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
      return { words };
    } catch (e) { return { error: 'unreadable transcript.json: ' + e.message }; }
  });

  // Renderer-initiated reloads are subject to the navigation guard; this one is not.
  ipcMain.handle('shell:revealFolder', (_e, dir) => {
    const d = String(dir || '');
    if (d && existsSync(d)) { shell.openPath(d); return { ok: true }; }
    return { ok: false };
  });

  ipcMain.handle('app:reload', () => { try { win?.webContents.reload(); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; } });

  ipcMain.handle('media:exists', (_e, name) => {
    if (!settings.work) return false;
    const p = allowedPath(join(settings.work, basename(String(name || ''))));
    return !!p && existsSync(p);
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
    try {
      writeFileSync(projectPath(), JSON.stringify(data, null, 2));
      recordEdit('you');
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('env:check', () => checkEnvironment());
  ipcMain.handle('analysis:autocut', (_e, o) => analyzeCuts(o || {}));
  ipcMain.handle('shell:openExternal', (_e, url) => {
    const u = String(url || '');
    // only ever open a normal web link, and only one we recognise
    if (/^https:\/\/(www\.)?(viddescriptor\.com|viddescriptor\.kno2gether\.com|kno2gether\.com)(\/|$)/.test(u)) {
      shell.openExternal(u);
      return { ok: true };
    }
    return { ok: false, error: 'blocked: ' + u };
  });
  ipcMain.handle('shell:openGuide', () => {
    const guide = join(RES, 'docs/GETTING_STARTED.md');
    if (existsSync(guide)) { shell.openPath(guide); return { ok: true }; }
    return { ok: false };
  });
  ipcMain.handle('shell:openLogs', () => { try { shell.showItemInFolder(logPath); } catch {} return { ok: true }; });
  ipcMain.handle('project:pickVideo', () => pickVideo());
  ipcMain.handle('project:pickFolder', (_e, o) => pickFolder(o?.defaultPath, o?.title));
  ipcMain.handle('project:create', (e, o) => createProject(e.sender, o || {}));
  ipcMain.handle('project:adopt', (_e, dir) => {
    const d = String(dir || '');
    if (!d || !existsSync(join(d, 'project.json'))) return { ok: false, error: 'no project.json in ' + d };
    setWorkspace(d);
    return { ok: true, work: settings.work };
  });

  ipcMain.handle('templates:list', () => listTemplates().map((t) => ({
    id: t.id, name: t.name, description: t.description, version: t.version, engine: t.engine,
    author: t.author, license: t.license, builtin: t.builtin, previewUrl: t.previewUrl,
    tokens: t.tokens, overlays: (t.overlays || []).map((o) => ({ id: o.id, name: o.name, duration: o.duration, vars: o.vars || [] })),
  })));
  ipcMain.handle('templates:apply', (_e, id) => applyTemplate(String(id)));
  ipcMain.handle('brief:setIntent', (_e, text) => {
    try {
      const p = JSON.parse(readFileSync(projectPath(), 'utf8'));
      p.brief = p.brief || {};
      p.brief.intent = String(text || '').slice(0, 500);
      writeFileSync(projectPath(), JSON.stringify(p, null, 2));
      refreshAgentBrief();
      return { ok: true, intent: p.brief.intent };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('brief:get', () => {
    try { return JSON.parse(readFileSync(projectPath(), 'utf8')).brief || null; }
    catch { return null; }
  });
  ipcMain.handle('templates:renderPreset', (e, o) => renderPreset(e.sender, o || {}));
  ipcMain.handle('templates:openFolder', () => {
    const dir = join(app.getPath('userData'), 'templates');
    mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  });
  ipcMain.handle('stt:start', (e, o) => transcribeMedia(e.sender, o || {}));
  ipcMain.handle('stt:engines', async () => {
    const has = (b) => !!which(b);
    return {
      hyperframes: has('npx'), 'whisper-cli': has('whisper-cli'),
      openai: hasApiKey('openai'), elevenlabs: hasApiKey('elevenlabs'),
      keys: knownKeys(),
    };
  });
  ipcMain.handle('keys:set', async (_e, { provider, value }) => {
    const p = String(provider);
    const r = await setApiKey(p, String(value || ''));
    // Saving a key is the whole setup step: it also gives the agent the matching MCP server, so
    // "paste key, press save" ends with Claude able to make sound. Clearing it takes it back.
    if (r?.ok && settings.work && mcp.SERVERS[p]) {
      try {
        const m = value ? mcp.register(settings.work, p) : mcp.unregister(settings.work, p);
        log('mcp', p, JSON.stringify(m));
        r.mcp = m;
        refreshAgentBrief();
      } catch (e) { r.mcp = { ok: false, error: e.message }; }
    }
    return r;
  });

  ipcMain.handle('keys:status', (_e, provider) => {
    if (!settings.work) return { known: false, error: 'no project open' };
    return mcp.status(settings.work, String(provider), { hasKey: hasApiKey(String(provider)), which });
  });

  // Pick an overlay clip (HyperFrames MOV/WebM with alpha, or a PNG sequence's first frame).
  // A clip is ordinary footage — b-roll, a screen recording, a cutaway — not an alpha overlay,
  // so it gets its own picker with its own default folder and filters.
  ipcMain.handle('clip:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a clip to place on the timeline',
      defaultPath: settings.work || undefined,
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const p = r.filePaths[0];
    const rel = settings.work && p.startsWith(resolve(settings.work) + sep)
      ? p.slice(resolve(settings.work).length + 1) : p;
    let duration = 0;
    try {
      const { spawnSync } = await import('node:child_process');
      const out = spawnSync('ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p], { encoding: 'utf8' });
      duration = Math.round((parseFloat(out.stdout) || 0) * 100) / 100;
    } catch {}
    return { ok: true, path: rel, duration };
  });

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

// ---------------------------------------------------------------- keychain helper mode
// Launched by keyOp() below: this same binary, started with one job, no window and no lock.
// It exists so a keychain call that never returns can be killed. See keyOp().
if (process.env.CUTRIGHT_KEY_OP) {
  app.dock?.hide();
  app.whenReady().then(() => {
    const op = process.env.CUTRIGHT_KEY_OP;
    const data = process.env.CUTRIGHT_KEY_DATA || '';
    let out;
    try {
      if (op === 'available') out = { ok: true, value: safeStorage.isEncryptionAvailable() };
      else if (op === 'encrypt') out = { ok: true, value: safeStorage.encryptString(data).toString('base64') };
      else if (op === 'decrypt') out = { ok: true, value: safeStorage.decryptString(Buffer.from(data, 'base64')) };
      else out = { ok: false, error: 'unknown key operation: ' + op };
    } catch (e) { out = { ok: false, error: e?.message || String(e) }; }
    process.stdout.write('CUTRIGHT_KEY_RESULT' + JSON.stringify(out));
    app.exit(0);
  });
} else {

// One instance per user-data directory. Two windows on the same project would fight over
// project.json — each would save its own in-memory copy over the other's edits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });
}

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
  // Keep the agent brief current for whatever project we are opening, however it was chosen.
  refreshAgentBrief();
  registerMediaProtocol();
  registerIpc();
  registerRecordingIpc();
  registerHistoryIpc();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  watchProject();
  // The self-test can also be driven from a packaged app:
  //   open -a Cutright.app --args --cve-smoke=ui,term --cve-out=/tmp/x
  const argSmoke = process.argv.find((a) => a.startsWith('--cve-smoke='));
  if (argSmoke) {
    process.env.CVE_SMOKE = argSmoke.split('=')[1];
    const argOut = process.argv.find((a) => a.startsWith('--cve-out='));
    if (argOut) process.env.CVE_SMOKE_OUT = argOut.split('=')[1];
    // Launched with `open -a`, so macOS attributes screen capture to Cutright rather than to
    // whichever terminal started it. Environment variables do not survive that, so the flags
    // that matter have argument forms too.
    if (process.argv.some((a) => a === '--cve-record')) process.env.CVE_SMOKE_RECORD = '1';
    if (process.argv.some((a) => a === '--cve-overlay')) process.env.CVE_SMOKE_OVERLAY = '1';
    const argWork = process.argv.find((a) => a.startsWith('--cve-work='));
    if (argWork) { process.env.WORK = argWork.split('=')[1]; settings.work = process.env.WORK; }
  }
  if (process.env.CVE_E2E) (await import(process.env.CVE_E2E)).run({ win, app, settings, logToApp: (l) => log(l) });
  else if (process.env.CVE_SMOKE) (await import('./smoke.mjs')).run({ win, app, settings, logToApp: (l) => log(l),
    // The recording overlay is its own window, so the smoke run needs a handle on it to be able
    // to look at what it draws.
    overlay: { show: overlayMode, state: overlayState, close: closeOverlay, win: () => overlayWin },
    // Driving a REAL recording is the only way to find out whether recording works. Photographing
    // the overlay proved only that the overlay draws.
    recorder: { open: openRecorder, win: () => recWin, session: () => session } });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
// An always-on-top frameless window has no title bar and no dock icon of its own. If it ever
// outlives the app that owns it, the only way out is Force Quit — so it goes first.
app.on('before-quit', () => { try { closeOverlay(); } catch {} for (const id of [...terms.keys()]) killTerm(id); for (const [, c] of jobs) { try { c.kill(); } catch {} } });

function buildMenu() {
  const mac = process.platform === 'darwin';
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New Recording…', accelerator: 'CmdOrCtrl+Shift+R', click: () => openRecorder() },
      { label: 'Open Workspace…', accelerator: 'CmdOrCtrl+O', click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'],
          defaultPath: settings.work || defaultBrowseDir() });
        if (!r.canceled && r.filePaths[0]) { setWorkspace(r.filePaths[0]); win.webContents.send('workspace:changed', settings.work); }
      } },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'About Cutright', click: () => win?.webContents.send('about:show') },
      { label: 'Check for Updates…', click: () => win?.webContents.send('about:show', { check: true }) },
      { type: 'separator' },
      { label: 'Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => win?.webContents.send('home:show') },
      { label: 'Show Me Around (guided tour)', click: () => win?.webContents.send('tour:show') },
      { label: 'Getting Started Guide', click: () => {
        const guide = join(RES, 'docs/GETTING_STARTED.md');
        if (existsSync(guide)) shell.openPath(guide);
        else dialog.showMessageBox(win, { message: 'Guide not found', detail: guide });
      } },
      { type: 'separator' },
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

}   // end of normal (non-helper) startup
