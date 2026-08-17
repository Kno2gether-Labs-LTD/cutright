// Preload — the ONLY bridge between the sandboxed renderer and the main process.
// CommonJS on purpose: sandboxed preloads cannot be ES modules.
// Rule: expose named functions with validated arguments; never expose `ipcRenderer`,
// `require`, or anything that lets the page name an arbitrary channel.
const { contextBridge, ipcRenderer } = require('electron');

const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const str = (v) => (typeof v === 'string' ? v : '');

// Render progress arrives on a MessagePort opened directly between the render
// utilityProcess and this frame — main is not in the data path. The port stays here in
// the isolated world; the page only ever sees plain, structured-cloned events.
const renderListeners = new Set();
const ports = new Map();
ipcRenderer.on('render:port', (e, { id }) => {
  const port = e.ports[0];
  ports.set(id, port);
  port.onmessage = (ev) => {
    const msg = { id, ...ev.data };
    if (msg.type === 'done' || msg.type === 'error') { try { port.close(); } catch {} ports.delete(id); }
    for (const cb of renderListeners) { try { cb(msg); } catch {} }
  };
  port.start();
});

const ptyData = new Set(), ptyExit = new Set();
ipcRenderer.on('pty:data', (_e, d) => { for (const cb of ptyData) { try { cb(String(d)); } catch {} } });
ipcRenderer.on('pty:exit', () => { for (const cb of ptyExit) { try { cb(); } catch {} } });

const projectChanged = new Set(), workspaceChanged = new Set();
ipcRenderer.on('project:changed', () => { for (const cb of projectChanged) { try { cb(); } catch {} } });
ipcRenderer.on('workspace:changed', (_e, w) => { for (const cb of workspaceChanged) { try { cb(String(w)); } catch {} } });

const on = (set) => (cb) => { if (typeof cb === 'function') { set.add(cb); return () => set.delete(cb); } return () => {}; };

// Any uncaught renderer error lands in the app log — a black or half-dead window must
// always leave a trace the user (or we) can read afterwards.
window.addEventListener('error', (e) => ipcRenderer.send('log:renderer', `ERROR ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => ipcRenderer.send('log:renderer', `REJECTION ${e.reason?.message || e.reason}`));

contextBridge.exposeInMainWorld('editor', {
  // --- project / workspace ---
  config: () => ipcRenderer.invoke('config:get'),
  chooseWorkspace: () => ipcRenderer.invoke('workspace:choose'),
  openWorkspace: (dir) => ipcRenderer.invoke('workspace:open', str(dir)),
  getProject: () => ipcRenderer.invoke('project:get'),
  saveProject: (p) => ipcRenderer.invoke('project:save', p),
  onProjectChanged: on(projectChanged),
  onWorkspaceChanged: on(workspaceChanged),
  revealInFolder: (name) => ipcRenderer.invoke('shell:showItem', str(name)),
  checkEnvironment: () => ipcRenderer.invoke('env:check'),
  pickOverlay: () => ipcRenderer.invoke('overlay:pick'),

  // --- media (streamed by the privileged `cve://` scheme, with Range support) ---
  mediaUrl: (nameOrPath, bust) =>
    'cve://media/?p=' + encodeURIComponent(str(nameOrPath)) + (bust ? '&v=' + Date.now() : ''),

  // --- render ---
  render: {
    start: (o = {}) => ipcRenderer.invoke('render:start', {
      out: str(o.out) || 'preview.mp4',
      range: Array.isArray(o.range) && o.range.length === 2 ? [num(o.range[0]), num(o.range[1])] : null,
    }),
    cancel: (id) => ipcRenderer.invoke('render:cancel', str(id)),
    onEvent: on(renderListeners),
  },

  // --- audio generation (ElevenLabs via the engine's audio_agent) ---
  generateAudio: (o = {}) => ipcRenderer.invoke('audio:generate', {
    kind: str(o.kind), text: str(o.text), at: num(o.at),
  }),

  // --- terminal ---
  term: {
    start: () => ipcRenderer.invoke('pty:start'),
    write: (d) => ipcRenderer.send('pty:write', str(d)),
    resize: (cols, rows) => ipcRenderer.send('pty:resize', { cols: num(cols, 80), rows: num(rows, 24) }),
    onData: on(ptyData),
    onExit: on(ptyExit),
  },
});
