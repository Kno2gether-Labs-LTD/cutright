// Claude Video Editor — Electron main process.
// Collapses the old Express server into the main process: project I/O, local media
// serving (custom `cve://` scheme with HTTP-range support), the render job (run in a
// utilityProcess, never here), audio generation, and the node-pty terminal.
//
// Security posture (do not loosen): contextIsolation:true, sandbox:true,
// nodeIntegration:false, a narrow contextBridge (see preload.cjs) and a strict CSP.
import { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, utilityProcess, MessageChannelMain, safeStorage } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, basename, isAbsolute, sep } from 'node:path';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, cpSync, watch, statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

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
function setWorkspace(dir, { fromUser = true } = {}) {
  if (fromUser) openEditorNext = true;
  settings.work = dir;
  settings.recent = [dir, ...settings.recent.filter((r) => r !== dir)].filter((r) => existsSync(r)).slice(0, 8);
  saveSettings(); watchProject();
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
    serviceName: 'cve-newproject', stdio: 'pipe', env: { ...process.env },
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
    return { ok: true, template: t.id, captions: p.captions.defaults };
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
// Remote transcription needs a key. It is encrypted with the OS keychain (safeStorage)
// and only ever leaves main to go to the provider — never to the renderer.
function setApiKey(provider, value) {
  settings.keys = settings.keys || {};
  if (!value) { delete settings.keys[provider]; saveSettings(); return { ok: true, cleared: true }; }
  try {
    settings.keys[provider] = safeStorage.isEncryptionAvailable()
      ? { enc: safeStorage.encryptString(value).toString('base64') }
      : { plain: value };            // no keychain (rare): still works, clearly marked
    saveSettings();
    return { ok: true, encrypted: !!settings.keys[provider].enc };
  } catch (e) { return { ok: false, error: e.message }; }
}
function getApiKey(provider) {
  const k = settings.keys?.[provider];
  if (!k) return process.env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ELEVENLABS_API_KEY'] || '';
  if (k.plain) return k.plain;
  try { return safeStorage.decryptString(Buffer.from(k.enc, 'base64')); } catch { return ''; }
}
const knownKeys = () => ({
  openai: !!getApiKey('openai'), elevenlabs: !!getApiKey('elevenlabs'),
  keychain: safeStorage.isEncryptionAvailable(),
});

// ---------------------------------------------------------------- transcription
function transcribeMedia(webContents, opts = {}) {
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
  child.postMessage({ type: 'transcribe', job: {
    work: settings.work,
    media: opts.media || project?.meta?.graded || 'graded_master.mp4',
    engine,
    model: opts.model || '',
    language: opts.language || '',
    modelPath: opts.modelPath || '',
    rebuildCaptions: opts.rebuildCaptions !== false,
    wordsPerCue: Number(opts.wordsPerCue || 3),
    apiKey: engine === 'openai' ? getApiKey('openai') : engine === 'elevenlabs' ? getApiKey('elevenlabs') : '',
  } });
  return { id };
}

// ---------------------------------------------------------------- analysis (auto-cut)
// Runs in its own utilityProcess: it shells out to ffmpeg, so it must not sit on main.
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
    child.on('message', (m) => {
      if (m?.type === 'result') finish({ ok: true, ...m });
      else if (m?.type === 'error') finish({ error: m.error });
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
    skipHome: (() => { const v = openEditorNext; openEditorNext = false; return v; })(),
    version: app.getVersion(), platform: process.platform, dev: isDev,
  }));

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
    try { writeFileSync(projectPath(), JSON.stringify(data, null, 2)); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
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
      openai: !!getApiKey('openai'), elevenlabs: !!getApiKey('elevenlabs'),
      keys: knownKeys(),
    };
  });
  ipcMain.handle('keys:set', (_e, { provider, value }) => setApiKey(String(provider), String(value || '')));

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
  registerMediaProtocol();
  registerIpc();
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
  }
  if (process.env.CVE_SMOKE) (await import('./smoke.mjs')).run({ win, app, settings, logToApp: (l) => log(l) });
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
