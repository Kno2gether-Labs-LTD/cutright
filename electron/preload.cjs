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

// transcription progress rides its own MessagePort, like renders do
const sttListeners = new Set();
const sttPorts = new Map();
ipcRenderer.on('transcribe:port', (e, { id }) => {
  const port = e.ports[0];
  sttPorts.set(id, port);
  port.onmessage = (ev) => {
    const msg = { id, ...ev.data };
    if (msg.type === 'done' || msg.type === 'error') { try { port.close(); } catch {} sttPorts.delete(id); }
    for (const cb of sttListeners) { try { cb(msg); } catch {} }
  };
  port.start();
});

const npListeners = new Set();
ipcRenderer.on('newproject:port', (e, { id }) => {
  const port = e.ports[0];
  port.onmessage = (ev) => {
    const msg = { id, ...ev.data };
    if (msg.type === 'done' || msg.type === 'error') { try { port.close(); } catch {} }
    for (const cb of npListeners) { try { cb(msg); } catch {} }
  };
  port.start();
});

const tplListeners = new Set();
ipcRenderer.on('template:port', (e, { id }) => {
  const port = e.ports[0];
  port.onmessage = (ev) => {
    const msg = { id, ...ev.data };
    if (msg.type === 'done' || msg.type === 'error') { try { port.close(); } catch {} }
    for (const cb of tplListeners) { try { cb(msg); } catch {} }
  };
  port.start();
});

const ptyData = new Set(), ptyExit = new Set();
ipcRenderer.on('pty:data', (_e, d) => { for (const cb of ptyData) { try { cb(String(d)); } catch {} } });
ipcRenderer.on('pty:exit', () => { for (const cb of ptyExit) { try { cb(); } catch {} } });

const homeShow = new Set();
ipcRenderer.on('home:show', () => { for (const cb of homeShow) { try { cb(); } catch {} } });

const tourShow = new Set();
ipcRenderer.on('tour:show', () => { for (const cb of tourShow) { try { cb(); } catch {} } });

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
  listLibrary: () => ipcRenderer.invoke('library:list'),
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    set: (id) => ipcRenderer.invoke('agents:set', str(id)),
    launch: () => ipcRenderer.invoke('agents:launch'),
  },
  openWorkspace: (dir) => ipcRenderer.invoke('workspace:open', str(dir)),
  reload: () => ipcRenderer.invoke('app:reload'),
  revealFolder: (dir) => ipcRenderer.invoke('shell:revealFolder', str(dir)),
  openRecorder: () => ipcRenderer.invoke('rec:open'),
  rec: {
    sources: () => ipcRenderer.invoke('rec:sources'),
    permissions: () => ipcRenderer.invoke('rec:permissions'),
    start: (o = {}) => ipcRenderer.invoke('rec:start', {
      name: str(o.name), screenId: str(o.screenId), camera: !!o.camera, mic: !!o.mic }),
    chunk: (track, buffer) => ipcRenderer.invoke('rec:chunk', { track: str(track), buffer }),
    pause: () => ipcRenderer.invoke('rec:pause'),
    resume: () => ipcRenderer.invoke('rec:resume'),
    mark: (type) => ipcRenderer.invoke('rec:mark', str(type)),
    stop: () => ipcRenderer.invoke('rec:stop'),
  },
  newProject: {
    pickVideo: () => ipcRenderer.invoke('project:pickVideo'),
    pickFolder: (o = {}) => ipcRenderer.invoke('project:pickFolder', { defaultPath: str(o.defaultPath), title: str(o.title) }),
    create: (o = {}) => ipcRenderer.invoke('project:create', {
      source: str(o.source), dest: str(o.dest), transcribe: o.transcribe !== false,
      model: str(o.model), language: str(o.language), gradeRef: str(o.gradeRef),
      targetHeight: num(o.targetHeight, 1080), targetFps: num(o.targetFps, 30),
    }),
    adopt: (dir) => ipcRenderer.invoke('project:adopt', str(dir)),
    onEvent: on(npListeners),
  },
  getProject: () => ipcRenderer.invoke('project:get'),
  getTranscript: () => ipcRenderer.invoke('transcript:get'),
  saveProject: (p) => ipcRenderer.invoke('project:save', p),
  onProjectChanged: on(projectChanged),
  onShowTour: on(tourShow),
  onShowHome: on(homeShow),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', str(url)),
  openGuide: () => ipcRenderer.invoke('shell:openGuide'),
  openLogs: () => ipcRenderer.invoke('shell:openLogs'),
  onWorkspaceChanged: on(workspaceChanged),
  revealInFolder: (name) => ipcRenderer.invoke('shell:showItem', str(name)),
  checkEnvironment: () => ipcRenderer.invoke('env:check'),
  pickOverlay: () => ipcRenderer.invoke('overlay:pick'),
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    apply: (id) => ipcRenderer.invoke('templates:apply', str(id)),
    getBrief: () => ipcRenderer.invoke('brief:get'),
    setIntent: (text) => ipcRenderer.invoke('brief:setIntent', str(text)),
    renderPreset: (o = {}) => ipcRenderer.invoke('templates:renderPreset', {
      template: str(o.template), preset: str(o.preset),
      vars: o.vars && typeof o.vars === 'object' ? o.vars : {},
      fps: num(o.fps, 30), quality: str(o.quality) || 'high',
    }),
    openFolder: () => ipcRenderer.invoke('templates:openFolder'),
    onEvent: on(tplListeners),
  },
  transcribe: {
    start: (o = {}) => ipcRenderer.invoke('stt:start', {
      engine: str(o.engine), model: str(o.model), language: str(o.language),
      modelPath: str(o.modelPath), rebuildCaptions: o.rebuildCaptions !== false,
      wordsPerCue: num(o.wordsPerCue, 3), media: str(o.media),
    }),
    engines: () => ipcRenderer.invoke('stt:engines'),
    setKey: (provider, value) => ipcRenderer.invoke('keys:set', { provider: str(provider), value: str(value) }),
    onEvent: on(sttListeners),
  },
  // the structural pass — see prepare-worker.cjs
  prepare: {
    start: (opts) => ipcRenderer.invoke('prepare:start', opts),
    onEvent: (fn) => {
      const onPort = (e) => { const p = e.ports[0]; p.onmessage = (m) => fn(m.data); p.start(); };
      ipcRenderer.on('prepare:port', onPort);
      return () => ipcRenderer.removeListener('prepare:port', onPort);
    },
  },
  verify: () => ipcRenderer.invoke('project:verify'),
  // what an integration needs, and whether it is wired up
  integrationStatus: (provider) => ipcRenderer.invoke('keys:status', provider),
  autoCut: (o = {}) => ipcRenderer.invoke('analysis:autocut', {
    noiseDb: num(o.noiseDb, -32), minSilence: num(o.minSilence, 0.7), pad: num(o.pad, 0.12),
    minCut: num(o.minCut, 0.35), fillers: o.fillers !== false, stutters: o.stutters !== false,
    softFillers: !!o.softFillers,
  }),

  // --- media (streamed by the privileged `cve://` scheme, with Range support) ---
  mediaExists: (name) => ipcRenderer.invoke('media:exists', str(name)),
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
