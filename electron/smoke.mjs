// Automated in-app smoke test. Runs inside Electron so we can verify the real window
// (the claude-in-chrome extension cannot reach a local Electron app, and there is no
// dev server to point puppeteer at any more).
//
//   CVE_SMOKE=ui,render,term CVE_SMOKE_OUT=/tmp/smoke npm run dev
//
// Writes <out>.json (assertions) + <out>.png (screenshot) and exits with code 0/1.
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// strip ANSI/OSC so we can assert on terminal text
const strip = (t) => String(t).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

export async function run({ win, app, settings, logToApp = () => {}, overlay = null, recorder = null }) {
  const want = String(process.env.CVE_SMOKE).split(',').map((s) => s.trim());
  const out = process.env.CVE_SMOKE_OUT || '/tmp/cve-smoke';
  try { mkdirSync(dirname(out), { recursive: true }); } catch {}
  const report = { started: new Date().toISOString(), workspace: settings.work, checks: {} };
  const check = (k, v) => { report.checks[k] = v; const line = `[smoke] ${k}: ${JSON.stringify(v)}`;
    console.log(line); try { logToApp(line); } catch {} };

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(2500);   // let boot() finish its IPC round-trips

    check('bridge', await win.webContents.executeJavaScript(`Object.keys(window.editor||{}).sort()`));
    check('project', await win.webContents.executeJavaScript(
      `(() => { const p = window.__cve?.project; return p ? { duration: p.meta.duration, cues: p.captions.cues.length, scenes: p.scenes.length, style: p.meta.style } : { error: window.__cve?.status }; })()`));
    check('timeline', await win.webContents.executeJavaScript(
      `({ sceneBlocks: document.querySelectorAll('#laneScenes .clip').length, capTicks: document.querySelectorAll('#laneCaps .cap').length })`));
    check('video', await win.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('#video'); return { src: (v.currentSrc||v.src).slice(0,60), readyState: v.readyState, duration: Math.round(v.duration||0), error: v.error?.code||null }; })()`));

    // Layout/visibility: DOM tests pass on elements that are covered or display:none, so
    // assert the real UI is actually on screen and nothing is sitting on top of it.
    check('visibility', await win.webContents.executeJavaScript(`(() => {
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'; };
      const at = (sel, dx = 5, dy = 5) => { const t = document.querySelector(sel)?.getBoundingClientRect();
        if (!t) return 'missing'; const el = document.elementFromPoint(t.left + dx, t.top + dy);
        return el ? (el.id || el.className || el.tagName) : 'none'; };
      return { welcomeHidden: !vis(document.querySelector('#welcome')),
               header: vis(document.querySelector('header')), timeline: vis(document.querySelector('#timelinePanel')),
               video: vis(document.querySelector('#video')), terminal: vis(document.querySelector('#terminal')),
               inspector: vis(document.querySelector('#inspector')),
               onTopOfTimeline: at('#laneScenes'), onTopOfVideo: at('#video', 30, 30) };
    })()`));

    if (want.includes('term')) {
      // type an expression into the pty and read it back off the xterm buffer
      const t = await win.webContents.executeJavaScript(`(async () => {
        window.__cve.termLog = '';
        window.editor.term.write('echo SMOKE_$((6*7))\\r');
        await new Promise(r => setTimeout(r, 4000));
        return window.__cve.termLog.slice(-400);
      })()`);
      check('terminal', { sawAnswer: /SMOKE_42/.test(t), tail: t.replace(/\[[0-9;?]*[a-zA-Z]/g, '').slice(-160) });
      // the packaged-app PATH trap: does `claude` resolve inside the login shell we spawn?
      const c = await win.webContents.executeJavaScript(`(async () => {
        window.__cve.termLog = '';
        window.editor.term.write('command -v claude && claude --version\\r');
        await new Promise(r => setTimeout(r, 15000));
        return window.__cve.termLog.slice(-800);
      })()`);
      const clean = strip(c);
      check('claudeCli', {
        resolved: /\/claude\b/.test(clean),
        version: (/(\d+\.\d+\.\d+[^\s]*)\s*\(Claude Code\)/.exec(clean) || [])[1] || null,
        tail: clean.replace(/\s+/g, ' ').slice(-220),
      });
    }

    if (want.includes('claude')) {
      // launch the real TUI and screenshot it — visual proof the agent runs inside the app
      await win.webContents.executeJavaScript(`window.editor.term.write('claude\\r')`);
      await wait(25000);
      try { writeFileSync(out + '-claude.png', (await win.webContents.capturePage()).toPNG()); }
      catch (e) { console.log('[smoke] claude screenshot unavailable:', e.message); }
      check('claudeTui', { screenshot: out + '-claude.png',
        tail: strip(await win.webContents.executeJavaScript(`window.__cve.termLog.slice(-500)`)).replace(/\s+/g,' ').slice(-200) });
      await win.webContents.executeJavaScript(`window.editor.term.write('\\u0003')`);
      await wait(1000);
      await win.webContents.executeJavaScript(`window.editor.term.write('\\u0003')`);
      await wait(1500);
    }

    if (want.includes('reload')) {
      // does a page-initiated location.reload() actually happen, or is will-navigate eating it?
      let fired = false;
      const onLoad = () => { fired = true; };
      win.webContents.on('did-finish-load', onLoad);
      await win.webContents.executeJavaScript('location.reload()').catch(() => {});
      await wait(3000);
      win.webContents.off('did-finish-load', onLoad);
      check('locationReload', { didReload: fired });
    }

    if (want.includes('diag')) {
      // step-by-step trace of the caption edit path, to see exactly where a write is lost
      const trace = await win.webContents.executeJavaScript(`(async () => {
        const out = [];
        const snap = (label) => out.push({ label,
          cue0: JSON.stringify(window.__cve.project.captions.cues[0]).slice(0, 120),
          projectRef: window.__cve.project.__id || 'none' });
        window.__cve.project.__id = 'A' + Date.now();
        snap('start');
        document.querySelectorAll('#laneCaps .cap')[0].click();
        await new Promise(r => setTimeout(r, 300));
        snap('after select');
        const labels = [...document.querySelectorAll('#inspector .field label')].map(l => l.textContent);
        const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
          .find(f => f.querySelector('label')?.textContent === label);
          if (!f) return 'NO FIELD: ' + label;
          const i = f.querySelector('input'); i.value = val; i.dispatchEvent(new Event('input')); return 'ok'; };
        const r1 = set('Y pos', '640');
        await new Promise(r => setTimeout(r, 1200));
        snap('after Y pos + save');
        return { out, labels, r1, status: document.querySelector('#status').textContent,
                 inspectorKind: document.querySelector('#inspector .kind')?.textContent };
      })()`, true);
      const onDisk = JSON.parse(readFileSync(settings.work + '/project.json', 'utf8'));
      check('diag', { ...trace, diskCue0Overrides: onDisk.captions.cues[0].overrides || null });
    }

    if (want.includes('edit')) {
      const { runEditTests } = await import('./selftest.mjs');
      const r = await runEditTests({ win, settings, app });
      check('editSuite', { passed: r.passed, total: r.total, skipped: r.skipped,
        tags: process.env.CVE_TEST_TAGS || 'all',
        failures: r.results.filter((x) => !x.pass).map((x) => `${x.name}: ${x.error}`) });
      report.editResults = r.results;

      // The suite's last test switches to a throwaway project and switches back, and switching
      // reloads the window. Later phases read the workspace, so wait until it is really back —
      // otherwise a render phase runs against a directory that has just been deleted.
      for (let i = 0; i < 40; i++) {
        const live = await win.webContents.executeJavaScript(
          `window.editor.config().then(c => c.work)`, true).catch(() => null);
        if (live === settings.work && existsSync(join(settings.work, 'project.json'))) break;
        await wait(250);
      }
    }

    if (want.includes('export')) {
      // the real Export path: no range, cuts applied, straight through the UI's own call
      const r = await win.webContents.executeJavaScript(`(async () => {
        const events = []; const off = window.editor.render.onEvent(e => events.push(e));
        const t0 = Date.now();
        await window.editor.render.start({ out: 'FINAL_selftest.mp4', range: null });
        const done = await new Promise(res => {
          const iv = setInterval(() => {
            const d = events.find(e => e.type === 'done' || e.type === 'error');
            if (d) { clearInterval(iv); res(d); }
            if (Date.now() - t0 > 1800000) { clearInterval(iv); res({ type: 'timeout' }); }
          }, 500);
        });
        off();
        return { done, seconds: Math.round((Date.now()-t0)/1000),
                 stages: [...new Set(events.filter(e=>e.type==='progress').map(e=>e.stage))] };
      })()`, true);
      const p = JSON.parse(readFileSync(settings.work + '/project.json', 'utf8'));
      // a transition at a seam blends the two sides, so it also shortens the export
      const cutTotal = (p.cuts || []).reduce((a, c) => a + (c.end - c.start), 0);
      const xfadeTotal = (p.cuts || []).reduce((a, c) =>
        a + (c.transition && c.transition !== 'none' ? Number(c.tdur ?? 0.3) : 0), 0);
      const expected = p.meta.duration - cutTotal - xfadeTotal;
      const got = parseFloat(r.done?.result?.duration || 0);
      check('export', { ...r, expectedDuration: +expected.toFixed(2), gotDuration: got,
        rippleExact: Math.abs(got - expected) < 0.1, cutSeconds: +cutTotal.toFixed(2), transitionSeconds: +xfadeTotal.toFixed(2),
        captions: r.done?.result?.captions, scenes: r.done?.result?.scenes, cuts: r.done?.result?.cuts_applied });
    }

    if (want.includes('cancel')) {
      // A full export is minutes long: start it, let it get going, then kill it from the UI.
      const r = await win.webContents.executeJavaScript(`(async () => {
        const events = []; const off = window.editor.render.onEvent(e => events.push(e));
        const t0 = Date.now();
        const { id } = await window.editor.render.start({ out: 'cancel_test.mp4', range: null });
        // wait until it is genuinely working (a progress tick or a log line)
        while (Date.now() - t0 < 60000 && !events.some(e => e.type === 'progress' || e.type === 'log')) {
          await new Promise(r => setTimeout(r, 300));
        }
        const working = events.some(e => e.type === 'progress' || e.type === 'log');
        await window.editor.render.cancel(id);
        const ended = await new Promise(res => {
          const iv = setInterval(() => {
            const d = events.find(e => e.type === 'done' || e.type === 'error');
            if (d) { clearInterval(iv); res(d); }
            if (Date.now() - t0 > 120000) { clearInterval(iv); res({ type: 'timeout' }); }
          }, 300);
        });
        off();
        return { working, ended: ended.type, code: ended.code, seconds: Math.round((Date.now()-t0)/1000) };
      })()`, true);
      // nothing of ours may survive the cancel
      const { execSync } = await import('node:child_process');
      let strays = '';
      try { strays = execSync("ps -ax -o pid,command | grep -i 'render_project.py' | grep -v grep || true", { encoding: 'utf8' }); } catch {}
      check('cancel', { ...r, strayProcesses: strays.trim().split('\n').filter(Boolean).length });
    }

    if (want.includes('audiogen')) {
      // real ElevenLabs call through the engine's audio_agent (costs a few credits)
      const before = JSON.parse(readFileSync(settings.work + '/project.json', 'utf8'));
      const r = await win.webContents.executeJavaScript(
        `window.editor.generateAudio({ kind: 'sfx', text: 'short cinematic whoosh transition', at: 20 })`, true);
      const after = JSON.parse(readFileSync(settings.work + '/project.json', 'utf8'));
      const added = (after.audio?.sfx?.length || 0) - (before.audio?.sfx?.length || 0);
      const layer = after.audio?.sfx?.slice(-1)[0];
      const file = layer && (layer.src.startsWith('/') ? layer.src : settings.work + '/' + layer.src);
      check('audioGen', { ok: !!r?.ok, added, layer, fileExists: !!file && existsSync(file),
        bytes: file && existsSync(file) ? statSync(file).size : 0, error: r?.error?.slice?.(0, 200) });
      writeFileSync(settings.work + '/project.json', JSON.stringify(before, null, 2));  // restore
    }

    if (want.includes('render')) {
      // Clamp to the video actually open. The defaults were written for a long recording and
      // asked for 195-203s of an eight-second fixture — which rendered "successfully" to a file
      // with sound and no pictures, and told nobody.
      const dur = await win.webContents.executeJavaScript(
        `(window.__cve.project?.meta?.duration || 0)`).catch(() => 0);
      let a = Number(process.env.CVE_SMOKE_A ?? 195);
      let b = Number(process.env.CVE_SMOKE_B ?? 203);
      if (dur && (a >= dur - 0.5)) { a = Math.max(0, dur * 0.25); b = Math.min(dur, a + Math.min(8, dur * 0.5)); }
      logToApp(`[smoke] render range ${a.toFixed(2)}-${b.toFixed(2)} of ${dur}s`);
      const r = await win.webContents.executeJavaScript(`(async () => {
        const events = [];
        const off = window.editor.render.onEvent(e => events.push(e));
        const t0 = Date.now();
        const { id } = await window.editor.render.start({ out: 'smoke_preview.mp4', range: [${a}, ${b}] });
        const done = await new Promise(res => {
          const iv = setInterval(() => {
            const d = events.find(e => e.type === 'done' || e.type === 'error');
            if (d) { clearInterval(iv); res(d); }
            if (Date.now() - t0 > 900000) { clearInterval(iv); res({ type: 'timeout' }); }
          }, 500);
        });
        off();
        return { id, done, seconds: Math.round((Date.now()-t0)/1000),
                 progress: events.filter(e => e.type === 'progress').length,
                 stages: [...new Set(events.filter(e=>e.type==='progress').map(e=>e.stage))],
                 lastLog: events.filter(e=>e.type==='log').slice(-1)[0]?.line };
      })()`, true);
      check('render', r);
      if (r?.done?.type === 'done' && r.done.code === 0) {
        await win.webContents.executeJavaScript(`window.__cve.loadVideo('smoke_preview.mp4')`);
        await wait(3000);
        check('previewPlayback', await win.webContents.executeJavaScript(
          `(() => { const v=document.querySelector('#video'); return { duration: +(v.duration||0).toFixed(2), readyState: v.readyState, error: v.error?.code||null }; })()`));
      }
    }

    // CVE_SMOKE_RECORD=1 drives an ACTUAL recording: open the recorder, pick a screen, press
    // Start, let it run, then stop from the overlay exactly as a person would. Everything the
    // user reported — a dead timer, a stop button that does nothing, a pill left on screen —
    // lives in this path and nowhere else.
    if (process.env.CVE_SMOKE_RECORD && recorder) {
      const rw = recorder.open();
      await wait(2500);

      const evalRec = (js) => rw.webContents.executeJavaScript(js).catch((e) => ({ error: String(e).slice(0, 200) }));

      const before = await evalRec(`(async () => {
        const p = await window.rec.permissions();
        const s = await window.rec.sources();
        return { screen: p.screen, mic: p.microphone, denied: !!s.screenCaptureDenied,
                 screens: (s.sources || []).filter(x => x.screen).length,
                 windows: (s.sources || []).filter(x => !x.screen).length };
      })()`);
      check('record:before', before);

      // No displays available? Test the lifecycle anyway with a synthetic stream. The OS capture
      // is the one thing that cannot be checked without permission; everything else can, and
      // everything else is where the bugs were.
      const synthetic = !!(before?.denied || !before?.screens);
      if (synthetic) {
        check('record:mode', { synthetic: true,
          why: 'macOS is not handing over displays — exercising the recorder with a canvas stream' });
        await evalRec(`(() => {
          window.__recTestStream = () => {
            const c = document.createElement('canvas');
            c.width = 640; c.height = 360;
            // A detached canvas is never painted, so captureStream yields no frames. It has to
            // be in the document — parked out of sight rather than hidden, since display:none
            // would stop it painting too.
            c.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(c);
            const ctx = c.getContext('2d');
            let i = 0;
            setInterval(() => {
              i++;
              ctx.fillStyle = 'hsl(' + ((i * 7) % 360) + ',70%,45%)';
              ctx.fillRect(0, 0, 640, 360);
              ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif';
              ctx.fillText('frame ' + i, 40, 200);
            }, 100);
            return c.captureStream(30);
          };
          // A synthetic run must not need a real source picked.
          return true;
        })()`);
      }
      {
        // Pick the first screen and start, exactly as the buttons do.
        const startedAt = Date.now() - 1000;
        const started = await evalRec(`(async () => {
          const list = document.querySelectorAll('.rec-src');
          for (const b of list) { if (${synthetic ? 'true' : '/^Screen/.test(b.textContent)'}) { b.click(); break; } }
          document.querySelector('#useCam').checked = false;
          document.querySelector('#useMic').checked = false;
          document.querySelector('#btnStart').click();
          return true;
        })()`);
        check('record:started', { clicked: started === true });

        // 3s count-in, then let it actually record.
        await wait(9000);
        const mid = await evalRec(`({
          timer: document.querySelector('#timer')?.textContent,
          hidden: document.hidden,
          bar: !document.querySelector('#bar')?.hidden,
          setup: !document.querySelector('#setup')?.hidden,
          review: !document.querySelector('#review')?.hidden,
          recorders: (window.__recDebug?.recorders ?? null),
          captured: (window.__recDebug?.captured ?? null),
          note: document.querySelector('#recNote')?.textContent || null,
          warn: document.querySelector('#permWarn')?.textContent || null,
          startDisabled: document.querySelector('#btnStart')?.disabled,
          chosen: document.querySelectorAll('.rec-src.sel').length,
        })`);
        const ow = overlay?.win?.();
        check('record:while-running', { ...mid,
          overlayOpen: !!(ow && !ow.isDestroyed()),
          overlayBounds: ow && !ow.isDestroyed() ? ow.getBounds() : null,
          recorderVisible: rw.isVisible(), recorderOpacity: rw.getOpacity(),
          recorderBounds: rw.getBounds() });

        // Stop the way the pill does: through main, not by calling the page directly.
        const { ipcMain: _im } = await import('electron');
        rw.webContents.send('rec:remote', 'stop');
        // Finalising writes the file, probes it and builds the review step. Six seconds was
        // enough on an idle machine and not on a busy one, which is the kind of margin that
        // turns a passing test into a flaky one.
        for (let i = 0; i < 20; i++) {
          const done = await evalRec(`!document.querySelector('#review')?.hidden && document.querySelector('#bar')?.hidden`);
          if (done === true) break;
          await wait(1000);
        }
        const after = await evalRec(`({ bar: !document.querySelector('#bar')?.hidden,
                                        review: !document.querySelector('#review')?.hidden,
                                        captured: (window.__recDebug?.captured ?? null) })`);
        const ow2 = overlay?.win?.();
        // The only answer that counts: is there a file, and does it have pictures in it?
        // The session object is cleared once a take finishes, so ask the folder the recordings
        // actually go to for its newest entry.
        let file = null;
        try {
          const { homedir } = await import('node:os');
          const { readdirSync } = await import('node:fs');
          const root = join(homedir(), 'Movies', 'Cutright');
          const since = startedAt;
          const dirs = readdirSync(root).map((n) => join(root, n))
            .filter((d) => existsSync(join(d, 'recording')))
            .filter((d) => { try { return statSync(d).mtimeMs >= since; } catch { return false; } })
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
          const f = dirs[0] ? join(dirs[0], 'recording', 'screen.mp4') : null;
          file = f && existsSync(f) ? { path: f, bytes: statSync(f).size } : { path: f, bytes: 0 };
        } catch (e) { file = { error: e.message }; }
        // Assert, do not merely report. A recording that produces a zero-byte file is exactly
        // what shipped: the take "succeeded", the folder appeared, and the video was empty.
        const bytes = file?.bytes || 0;
        // A synthetic run proves the lifecycle, not the capture: MediaRecorder's MP4 path does not
        // accept a canvas stream, so "no bytes" there says nothing about the app. Only a real
        // capture is allowed to fail this.
        const okRecording = synthetic
          ? (after?.review === true && !after?.bar && !after?.overlayStillOpen)
          : (bytes > 50_000 && after?.review === true && !after?.bar);
        check('record:after-stop', { ...after, overlayStillOpen: !!(ow2 && !ow2.isDestroyed()),
                                     file, ok: okRecording });
        if (!okRecording) {
          check('record:FAILED', {
            synthetic,
            why: synthetic ? 'the recorder did not return to review after stop'
               : bytes === 0 ? 'the capture wrote a zero-byte file — MediaRecorder delivered nothing'
               : bytes <= 50_000 ? `the capture wrote only ${bytes} bytes`
               : 'the recorder did not reach the review step',
          });
        }
      }
    }

    // CVE_SMOKE_OVERLAY=1 photographs the recording overlay in both of its states. It is a
    // transparent, always-on-top window, so the only way to see what it draws is to ask it.
    if (process.env.CVE_SMOKE_OVERLAY && overlay) {
      for (const [mode, extra] of [['count', { n: 3 }], ['controls', {}]]) {
        overlay.show(mode, extra);
        if (mode === 'controls') overlay.state({ elapsed: 87, paused: false });
        await wait(900);
        const w = overlay.win();
        if (w && !w.isDestroyed()) {
          try {
            const img = await w.webContents.capturePage();
            writeFileSync(`${out}-overlay-${mode}.png`, img.toPNG());
            const b = w.getBounds();
            const { screen } = await import('electron');
            const screenSize = screen.getPrimaryDisplay().bounds;
            // What has to be true, not just what it looks like: the count-in covers the screen
            // and lets clicks through; the controls are small and can be clicked.
            const expected = mode === 'count'
              ? b.width >= screenSize.width - 4 && b.height >= screenSize.height - 60
              : b.width < 200 && b.height < 320;
            const drew = (await w.webContents.executeJavaScript(
              `!document.querySelector('${mode === 'count' ? '#count' : '#controls'}').hidden`));
            check(`overlay:${mode}`, { shot: `${out}-overlay-${mode}.png`, size: b,
                                       sizeIsRight: expected, showing: drew,
                                       ok: expected && drew });
          } catch (e) { check(`overlay:${mode}`, { error: e.message }); }
        } else check(`overlay:${mode}`, { error: 'the overlay window did not open' });
      }
      overlay.close();
    }

    // CVE_SMOKE_PANEL=transcript|templates|autocut|look opens a panel before the screenshot
    // (used for documentation shots and for eyeballing a panel after a change)
    if (process.env.CVE_SMOKE_TOUR) {
      await win.webContents.executeJavaScript(`(() => { try { localStorage.removeItem('cutright.tourSeen'); } catch {} startTour(true);
        for (let i = 1; i < ${Number(process.env.CVE_SMOKE_TOUR) || 1}; i++) document.querySelector('#tourNext').click(); })()`);
      await wait(1200);
    }
    if (process.env.CVE_SMOKE_SCROLL) {
      await win.webContents.executeJavaScript(
        `document.querySelector('#home')?.scrollTo({ top: ${Number(process.env.CVE_SMOKE_SCROLL)} })`);
      await wait(700);
    }
    const panel = process.env.CVE_SMOKE_PANEL;
    if (panel) {
      await win.webContents.executeJavaScript('hideHome()').catch(() => {});
      await wait(300);
      // `about` has no toolbar button — it lives in the Help menu and the Home footer — so it is
      // opened by name rather than by click.
      if (panel === 'about') {
        await win.webContents.executeJavaScript('showAbout()').catch(() => {});
        await wait(1200);
      }
      const buttons = { transcript: '#btnTranscriptEdit', templates: '#btnTemplates',
                        autocut: '#btnAutoCut', look: '#btnLook', agent: '#btnAgentPick',
                        history: '#btnHistory', media: '#btnMedia' };
      const sel = buttons[panel];
      if (sel) {
        await win.webContents.executeJavaScript(`document.querySelector('${sel}')?.click()`);
        await wait(panel === 'autocut' ? 12000 : 2500);
      }
    }
    // The screenshot is a diagnostic, not an assertion: capturePage can fail with a
    // compositor error when the window is occluded (common on CI runners), and that must
    // not turn a green suite red.
    try {
      const img = await win.webContents.capturePage();
      writeFileSync(out + '.png', img.toPNG());
      report.screenshot = out + '.png';
    } catch (e) {
      report.screenshotError = e?.message || String(e);
      console.log('[smoke] screenshot unavailable:', report.screenshotError);
    }
  } catch (e) {
    report.error = e?.stack || String(e);
  }

  report.finished = new Date().toISOString();
  // A fresh install legitimately shows the welcome screen and has no project — assert the
  // editor chrome only when a project is actually open.
  const fresh = !!report.checks.project?.error;
  const ok = !report.error
    && (fresh || report.checks.project?.cues > 0)
    && (fresh ? report.checks.visibility?.welcomeHidden === false
              : report.checks.visibility?.welcomeHidden === true)
    && (fresh || (report.checks.visibility?.header === true && report.checks.visibility?.timeline === true
      && report.checks.visibility?.video === true && report.checks.visibility?.terminal === true))
    && (!want.includes('render') || report.checks.render?.done?.code === 0)
    && (!want.includes('export') || (report.checks.export?.done?.code === 0 && report.checks.export?.rippleExact === true))
    && (!want.includes('cancel') || (report.checks.cancel?.working === true && report.checks.cancel?.strayProcesses === 0))
    && (!want.includes('audiogen') || report.checks.audioGen?.ok === true)
    && (!want.includes('edit') || report.checks.editSuite?.failures?.length === 0)
    && (!want.includes('term') || (report.checks.terminal?.sawAnswer === true && report.checks.claudeCli?.resolved === true));
  report.pass = !!ok;
  writeFileSync(out + '.json', JSON.stringify(report, null, 2));
  console.log('[smoke] pass =', ok, '→', out + '.json');
  app.exit(ok ? 0 : 1);
}
