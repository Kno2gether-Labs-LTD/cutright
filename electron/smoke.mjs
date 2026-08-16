// Automated in-app smoke test. Runs inside Electron so we can verify the real window
// (the claude-in-chrome extension cannot reach a local Electron app, and there is no
// dev server to point puppeteer at any more).
//
//   CVE_SMOKE=ui,render,term CVE_SMOKE_OUT=/tmp/smoke npm run dev
//
// Writes <out>.json (assertions) + <out>.png (screenshot) and exits with code 0/1.
import { writeFileSync } from 'node:fs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// strip ANSI/OSC so we can assert on terminal text
const strip = (t) => String(t).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

export async function run({ win, app, settings }) {
  const want = String(process.env.CVE_SMOKE).split(',').map((s) => s.trim());
  const out = process.env.CVE_SMOKE_OUT || '/tmp/cve-smoke';
  const report = { started: new Date().toISOString(), workspace: settings.work, checks: {} };
  const check = (k, v) => { report.checks[k] = v; console.log(`[smoke] ${k}:`, JSON.stringify(v)); };

  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await wait(2500);   // let boot() finish its IPC round-trips

    check('bridge', await win.webContents.executeJavaScript(`Object.keys(window.editor||{}).sort()`));
    check('project', await win.webContents.executeJavaScript(
      `(() => { const p = window.__cve?.project; return p ? { duration: p.meta.duration, cues: p.captions.cues.length, scenes: p.scenes.length, style: p.meta.style } : { error: window.__cve?.status }; })()`));
    check('timeline', await win.webContents.executeJavaScript(
      `({ sceneBlocks: document.querySelectorAll('#laneScenes .block').length, capTicks: document.querySelectorAll('#laneCaps .cap').length })`));
    check('video', await win.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('#video'); return { src: (v.currentSrc||v.src).slice(0,60), readyState: v.readyState, duration: Math.round(v.duration||0), error: v.error?.code||null }; })()`));

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
      writeFileSync(out + '-claude.png', (await win.webContents.capturePage()).toPNG());
      check('claudeTui', { screenshot: out + '-claude.png',
        tail: strip(await win.webContents.executeJavaScript(`window.__cve.termLog.slice(-500)`)).replace(/\s+/g,' ').slice(-200) });
      await win.webContents.executeJavaScript(`window.editor.term.write('\\u0003')`);
      await wait(1000);
      await win.webContents.executeJavaScript(`window.editor.term.write('\\u0003')`);
      await wait(1500);
    }

    if (want.includes('render')) {
      const a = Number(process.env.CVE_SMOKE_A ?? 195);
      const b = Number(process.env.CVE_SMOKE_B ?? 203);
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

    const img = await win.webContents.capturePage();
    writeFileSync(out + '.png', img.toPNG());
    report.screenshot = out + '.png';
  } catch (e) {
    report.error = e?.stack || String(e);
  }

  report.finished = new Date().toISOString();
  const ok = !report.error
    && report.checks.project?.cues > 0
    && (!want.includes('render') || report.checks.render?.done?.code === 0)
    && (!want.includes('term') || (report.checks.terminal?.sawAnswer === true && report.checks.claudeCli?.resolved === true));
  report.pass = !!ok;
  writeFileSync(out + '.json', JSON.stringify(report, null, 2));
  console.log('[smoke] pass =', ok, '→', out + '.json');
  app.exit(ok ? 0 : 1);
}
