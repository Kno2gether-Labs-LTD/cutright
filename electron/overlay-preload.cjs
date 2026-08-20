// The overlay can do exactly three things: be told what to show, be told the clock, and report a
// button press. It has no access to the recording, the project, or the filesystem.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onMode: (cb) => ipcRenderer.on('overlay:mode', (_e, payload) => cb(payload || {})),
  onState: (cb) => ipcRenderer.on('overlay:state', (_e, payload) => cb(payload || {})),
  action: (kind) => ipcRenderer.send('overlay:action', String(kind || '').slice(0, 16)),
});
