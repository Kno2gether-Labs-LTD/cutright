// Bridge for the recorder window only. Same rule as the editor's preload: named functions
// with validated arguments, no ipcRenderer, no require reachable from the page.
const { contextBridge, ipcRenderer } = require('electron');
const str = (v) => (typeof v === 'string' ? v : '');
const bool = (v) => !!v;

const progress = new Set();
ipcRenderer.on('rec:progress', (_e, m) => { for (const cb of progress) { try { cb(m); } catch {} } });

// The overlay's buttons arrive here: the recorder window is hidden while recording, but it is
// still the thing that owns MediaRecorder, so it has to be the thing that acts.
const remote = new Set();
ipcRenderer.on('rec:remote', (_e, kind) => { for (const cb of remote) { try { cb(kind); } catch {} } });

contextBridge.exposeInMainWorld('rec', {
  sources: () => ipcRenderer.invoke('rec:sources'),
  privacy: () => ipcRenderer.invoke('rec:privacy'),
  permissions: () => ipcRenderer.invoke('rec:permissions'),
  request: (kind) => ipcRenderer.invoke('rec:request', str(kind)),
  start: (o = {}) => ipcRenderer.invoke('rec:start', {
    name: str(o.name), screenId: str(o.screenId), camera: bool(o.camera), mic: bool(o.mic),
  }),
  chunk: (track, buffer) => ipcRenderer.invoke('rec:chunk', { track: str(track), buffer }),
  pause: () => ipcRenderer.invoke('rec:pause'),
  resume: () => ipcRenderer.invoke('rec:resume'),
  mark: (type) => ipcRenderer.invoke('rec:mark', str(type)),
  stop: () => ipcRenderer.invoke('rec:stop'),
  finalize: (o = {}) => ipcRenderer.invoke('rec:finalize', { transcribe: o.transcribe !== false, model: str(o.model) }),
  discard: () => ipcRenderer.invoke('rec:discard'),
  compact: (on) => ipcRenderer.invoke('rec:compact', bool(on)),
  // Drive the transparent overlay: the count-in, and the clock on the control pill.
  count: (n) => ipcRenderer.invoke('rec:count', Number(n) || 0),
  state: (o = {}) => ipcRenderer.send('rec:state', { elapsed: Number(o.elapsed) || 0, paused: bool(o.paused) }),
  onRemote: (cb) => { if (typeof cb === 'function') { remote.add(cb); return () => remote.delete(cb); } return () => {}; },
  close: () => ipcRenderer.invoke('rec:close'),
  onProgress: (cb) => { if (typeof cb === 'function') { progress.add(cb); return () => progress.delete(cb); } return () => {}; },
});
