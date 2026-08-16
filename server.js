#!/usr/bin/env node
// Claude Video Editor — local backend.
// Serves the UI, the project.json (edit-as-data), the rendered video (range requests),
// a render endpoint (spawns render_project.py with SSE progress), and a PTY websocket
// that runs a shell / `claude` for the side terminal.
import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { createReadStream, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import http from 'node:http';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4599;
// The edit "workspace" (holds project.json + graded_master.mp4 + renders). Override with WORK=.
const WORK = process.env.WORK || '/Users/avijit/Pre_final_edit';
const PROJECT = join(WORK, 'project.json');
// The render/audio engine lives in the `video-edit` skill (single source of truth,
// shared with standalone skill use). Override with ENGINE=… if you relocate it.
const ENGINE = process.env.ENGINE || '/Users/avijit/.claude/skills/video-edit/scripts';
const RENDER = join(ENGINE, 'render_project.py');

const app = express();
app.use(express.json({ limit: '64mb' }));
app.use(express.static(join(__dir, 'public')));

// ---- project.json read/write ----
app.get('/api/project', (req, res) => {
  if (!existsSync(PROJECT)) return res.status(404).json({ error: 'no project.json in ' + WORK });
  res.json(JSON.parse(readFileSync(PROJECT, 'utf8')));
});
app.post('/api/project', (req, res) => {
  writeFileSync(PROJECT, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});
app.get('/api/config', (req, res) => res.json({ work: WORK, project: PROJECT }));

// ---- serve a video file from WORK with HTTP range support ----
app.get('/api/video', (req, res) => {
  const name = basename(req.query.f || 'FINAL.mp4');
  const p = join(WORK, name);
  if (!existsSync(p)) return res.status(404).end('not found: ' + name);
  const size = statSync(p).size;
  const range = req.headers.range;
  res.setHeader('Content-Type', 'video/mp4');
  if (range) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = parseInt(s, 10), end = e ? parseInt(e, 10) : size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    createReadStream(p, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(p).pipe(res);
  }
});

// ---- render (SSE progress) ----
app.get('/api/render', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  const out = basename(req.query.out || 'preview.mp4');
  const args = [RENDER, '--project', PROJECT, '--out', join(WORK, out)];
  if (req.query.a && req.query.b) args.push('--range', req.query.a, req.query.b);
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  send({ type: 'start', out, args: args.slice(1) });
  const py = spawn('python3', args, { cwd: WORK });
  let buf = '';
  const onData = (d) => { buf += d.toString(); const t = d.toString().match(/time=([\d:.]+)/g); if (t) send({ type: 'progress', t: t[t.length - 1] }); };
  py.stdout.on('data', onData); py.stderr.on('data', onData);
  py.on('close', (code) => { send({ type: 'done', code, out, tail: buf.slice(-500) }); res.end(); });
  req.on('close', () => py.kill());
});

// ---- generate audio via ElevenLabs (audio_agent.py) → adds a layer to project.json ----
app.post('/api/audio', (req, res) => {
  const { kind, text, at } = req.body || {};
  if (!['sfx', 'voice', 'music'].includes(kind)) return res.json({ ok: false, error: 'bad kind' });
  const script = join(ENGINE, 'audio_agent.py');
  const args = [script, kind, '--project', PROJECT];
  if (kind === 'sfx') args.push('--prompt', text, '--at', String(at), '--dur', '2');
  else if (kind === 'voice') args.push('--text', text, '--at', String(at));
  else args.push('--prompt', text, '--start', String(at), '--dur', '30');
  const py = spawn('python3', args, { cwd: WORK });
  let out = ''; py.stdout.on('data', d => out += d); py.stderr.on('data', d => out += d);
  py.on('close', (code) => { try { res.json(code === 0 ? JSON.parse(out.trim().split('\n').pop()) : { ok: false, error: out.slice(-400) }); } catch { res.json({ ok: code === 0, raw: out.slice(-400) }); } });
});

const server = http.createServer(app);

// never let a terminal hiccup crash the whole editor
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message || e));

// ---- PTY terminal websocket (side terminal → shell / claude) ----
const wss = new WebSocketServer({ server, path: '/pty' });
let pty = null;
try { pty = (await import('node-pty')).default; } catch { console.warn('[pty] node-pty not available — using basic shell fallback'); }
// node-pty rejects env objects with non-string values (a cause of posix_spawnp failed)
const cleanEnv = { TERM: 'xterm-256color' };
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') cleanEnv[k] = v;
const SHELL = cleanEnv.SHELL || '/bin/zsh';

function makeTerm() {
  if (pty) {
    try {
      const t = pty.spawn(SHELL, ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: WORK, env: cleanEnv });
      return { kind: 'pty', t };
    } catch (e) { console.warn('[pty] fork failed → child_process fallback:', e.message); }
  }
  const t = spawn(SHELL, ['-i'], { cwd: WORK, env: cleanEnv });
  return { kind: 'child', t };
}

wss.on('connection', (ws) => {
  let h; try { h = makeTerm(); } catch (e) { try { ws.send(JSON.stringify({ t: 'out', d: '\r\n[terminal failed: ' + e.message + ']\r\n' })); } catch {} return; }
  const { kind, t } = h;
  const send = (o) => { try { ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} };
  if (kind === 'pty') { t.onData((d) => send({ t: 'out', d })); t.onExit(() => send({ t: 'exit' })); }
  else { t.stdout.on('data', (d) => send({ t: 'out', d: d.toString() })); t.stderr.on('data', (d) => send({ t: 'out', d: d.toString() })); t.on('error', (e) => send({ t: 'out', d: '\r\n[' + e.message + ']\r\n' })); }
  ws.on('message', (m) => { try { const { t: mt, d, cols, rows } = JSON.parse(m.toString());
    if (mt === 'in') { kind === 'pty' ? t.write(d) : t.stdin.write(d); }
    else if (mt === 'resize' && kind === 'pty') { try { t.resize(cols, rows); } catch {} } } catch {} });
  ws.on('close', () => { try { t.kill(); } catch {} });
});

server.listen(PORT, () => console.log(`\n  Claude Video Editor → http://localhost:${PORT}\n  workspace: ${WORK}\n`));
