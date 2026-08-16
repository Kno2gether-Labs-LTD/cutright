# legacy/

`server.js` is the retired Express + ws prototype (the pre-Electron web app). It is kept only as a
reference for the handlers that became main-process IPC in Phase 0:

| old HTTP/WS endpoint | now |
|---|---|
| `GET /api/config` | `editor.config()` → `ipcMain.handle('config:get')` |
| `GET /api/project` / `POST /api/project` | `editor.getProject()` / `editor.saveProject()` |
| `GET /api/video?f=` (range) | the privileged `cve://media/?p=` scheme in `electron/main.js` |
| `GET /api/render` (SSE) | `editor.render.start()` → `utilityProcess` + MessagePort events |
| `POST /api/audio` | `editor.generateAudio()` |
| `WS /pty` | `editor.term.*` → node-pty in main |

It no longer runs: `express` and `ws` were dropped from `package.json`, and `renderer/app.js` now talks to
`window.editor` instead of `fetch`. Delete this folder once Phase 1 is signed off.
