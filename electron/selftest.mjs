// Functional parity suite — drives the REAL UI (clicks, typing, buttons) and verifies each
// change round-trips to project.json on disk, then restores the file byte-for-byte.
//
// Every feature the pre-Electron web app had is covered here, plus the ones Phase 0 added.
// Run: CVE_SMOKE=ui,edit npm run smoke
import { readFileSync, writeFileSync } from 'node:fs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runEditTests({ win, settings }) {
  const wc = win.webContents;
  const projectFile = settings.work + '/project.json';
  const backup = readFileSync(projectFile, 'utf8');
  const results = [];
  const disk = () => JSON.parse(readFileSync(projectFile, 'utf8'));

  const js = (code) => wc.executeJavaScript(code, true);
  // The UI autosaves 400ms after the last edit; give it room, then read the real file.
  const settle = () => wait(900);
  const test = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, pass: true, detail }); }
    catch (e) { results.push({ name, pass: false, error: e?.message || String(e) }); }
    console.log('[selftest]', results[results.length - 1].pass ? 'PASS' : 'FAIL', name,
      results[results.length - 1].error || '');
  };
  const expect = (cond, msg) => { if (!cond) throw new Error(msg); return true; };

  // ---------------------------------------------------------------- selection
  await test('select a scene → inspector + playhead', async () => {
    const r = await js(`(() => {
      document.querySelector('#laneScenes .clip').click();
      const h = document.querySelector('#inspector h3 .kind')?.textContent || '';
      return { head: h, time: document.querySelector('#video').currentTime,
               sceneStart: window.__cve.project.scenes[0].start };
    })()`);
    expect(/^scene$/i.test(r.head.trim()), 'inspector did not show the scene kind: ' + r.head);
    expect(Math.abs(r.time - r.sceneStart) < 0.6, `playhead ${r.time} != scene start ${r.sceneStart}`);
    return r;
  });

  await test('scene: edit headline → saved to disk', async () => {
    const marker = 'SELFTEST HEADLINE';
    await js(`(() => {
      const inp = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === 'Headline').querySelector('input');
      inp.value = ${JSON.stringify(marker)}; inp.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    expect(disk().scenes[0].headline === marker, 'headline not persisted');
    return { headline: disk().scenes[0].headline };
  });

  await test('scene: edit duration (number field) → saved', async () => {
    await js(`(() => {
      const inp = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === 'Duration').querySelector('input');
      inp.value = '6.5'; inp.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    expect(disk().scenes[0].dur === 6.5, 'scene dur not persisted: ' + disk().scenes[0].dur);
    return { dur: 6.5 };
  });

  // ---------------------------------------------------------------- captions
  await test('caption: select + toggle a word highlight → saved', async () => {
    const before = disk().captions.cues[0].tokens.map((t) => !!t.e);
    await js(`document.querySelectorAll('#laneCaps .cap')[0].click()`);
    await wait(150);
    await js(`document.querySelector('#inspector .tokens .tok').click()`);
    await settle();
    const after = disk().captions.cues[0].tokens.map((t) => !!t.e);
    expect(after[0] !== before[0], `token emphasis did not flip: ${before} → ${after}`);
    return { before, after };
  });

  await test('caption: edit full text → tokens rebuilt + saved', async () => {
    await js(`(() => {
      const inp = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === 'Full text').querySelector('input');
      inp.value = 'selftest caption words'; inp.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    const toks = disk().captions.cues[0].tokens.map((t) => t.t).join(' ');
    expect(toks === 'selftest caption words', 'caption text not persisted: ' + toks);
    return { tokens: toks };
  });

  await test('caption: per-cue overrides (Y pos / size / highlight) → saved', async () => {
    await js(`(() => {
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Y pos', '640'); set('Size', '52'); set('Highlight', '#00A3FF');
    })()`);
    await settle();
    const o = disk().captions.cues[0].overrides || {};
    expect(o.cy === 640 && o.fontsize === 52 && o.highlight === '#00A3FF', 'overrides not persisted: ' + JSON.stringify(o));
    return o;
  });

  await test('caption: global defaults (all captions) → saved', async () => {
    await js(`(() => {
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('All Y pos', '700'); set('All size', '58');
    })()`);
    await settle();
    const d = disk().captions.defaults;
    expect(d.cy === 700 && d.fontsize === 58, 'defaults not persisted: ' + JSON.stringify(d));
    return { cy: d.cy, fontsize: d.fontsize };
  });

  await test('caption: start/end timing fields → saved', async () => {
    await js(`(() => {
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Start', '0.5'); set('End', '1.9');
    })()`);
    await settle();
    const c = disk().captions.cues[0];
    expect(c.start === 0.5 && c.end === 1.9, 'cue timing not persisted: ' + JSON.stringify([c.start, c.end]));
    return { start: c.start, end: c.end };
  });

  // ---------------------------------------------------------------- cuts
  await test('cut: "+ cut at playhead" adds a cut → saved', async () => {
    const before = (disk().cuts || []).length;
    await js(`(() => { document.querySelector('#video').currentTime = 12;
      document.querySelector('[data-add="cut"]').click(); })()`);
    await settle();
    const after = disk().cuts.length;
    expect(after === before + 1, `cuts ${before} → ${after}`);
    return { before, after, cut: disk().cuts[after - 1] };
  });

  await test('cut: edit start/end + "Set end = playhead" → saved', async () => {
    await js(`(() => {
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Cut start', '11'); set('Cut end', '13');
      document.querySelector('#video').currentTime = 15.25;
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Set end = playhead').click();
    })()`);
    await settle();
    const c = disk().cuts[disk().cuts.length - 1];
    expect(c.start === 11 && Math.abs(c.end - 15.25) < 0.2, 'cut edit not persisted: ' + JSON.stringify(c));
    return c;
  });

  await test('cut: Delete removes it → saved', async () => {
    const before = disk().cuts.length;
    await js(`[...document.querySelectorAll('#inspector h3 button')].find(b => b.textContent === 'Delete').click()`);
    await settle();
    expect(disk().cuts.length === before - 1, 'cut not deleted');
    return { before, after: disk().cuts.length };
  });

  // ---------------------------------------------------------------- audio layers
  await test('audio: "+ music" adds a layer → saved', async () => {
    await js(`document.querySelector('[data-add="music"]').click()`);
    await settle();
    const m = disk().audio.music;
    expect(m.length === 1, 'music layer not added');
    return m[0];
  });

  await test('audio: edit src/gain/fades → saved', async () => {
    await js(`(() => {
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Source path', 'music/bed.mp3'); set('Gain dB', '-22'); set('Fade in', '2'); set('Fade out', '3');
    })()`);
    await settle();
    const m = disk().audio.music[0];
    expect(m.src === 'music/bed.mp3' && m.gain === -22 && m.fadeIn === 2 && m.fadeOut === 3,
      'audio fields not persisted: ' + JSON.stringify(m));
    return m;
  });

  await test('audio: "+ sfx" adds an sfx layer, Delete removes both → saved', async () => {
    await js(`document.querySelector('[data-add="sfx"]').click()`);
    await settle();
    expect(disk().audio.sfx.length === 1, 'sfx not added');
    await js(`[...document.querySelectorAll('#inspector h3 button')].find(b => b.textContent === 'Delete').click()`);
    await settle();
    expect(disk().audio.sfx.length === 0, 'sfx not deleted');
    await js(`(() => { document.querySelectorAll('#laneAudio .clip')[0].click(); })()`);
    await wait(150);
    await js(`[...document.querySelectorAll('#inspector h3 button')].find(b => b.textContent === 'Delete').click()`);
    await settle();
    expect(disk().audio.music.length === 0, 'music not deleted');
    return { music: 0, sfx: 0 };
  });

  // ---------------------------------------------------------------- overlays (new in Phase 0)
  await test('overlay: track renders + disable/enable round-trips', async () => {
    const has = await js(`document.querySelectorAll('#laneOverlays .clip').length`);
    if (!has) return { skipped: 'no overlays in this project' };
    await js(`document.querySelector('#laneOverlays .clip').click()`);
    await wait(150);
    await js(`[...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Disable').click()`);
    await settle();
    expect(disk().overlays[0].enabled === false, 'overlay disable not persisted');
    await js(`[...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Enable').click()`);
    await settle();
    expect(disk().overlays[0].enabled === true, 'overlay enable not persisted');
    return { overlays: disk().overlays.length };
  });

  // ---------------------------------------------------------------- timeline controls
  await test('timeline: zoom in/out and Fit change the scale', async () => {
    const r = await js(`(async () => {
      const z0 = window.__cve.zoom;
      document.querySelector('#btnZoomIn').click(); const z1 = window.__cve.zoom;
      document.querySelector('#btnZoomIn').click();
      document.querySelector('#btnZoomIn').click(); const z2 = window.__cve.zoom;
      const wideLabels = document.querySelectorAll('#laneCaps .cap.wide').length;
      document.querySelector('#btnFit').click(); const z3 = window.__cve.zoom;
      return { z0, z1, z2, z3, wideLabels };
    })()`);
    expect(r.z1 > r.z0 && r.z2 > r.z1, `zoom in did not increase scale: ${JSON.stringify(r)}`);
    expect(Math.abs(r.z3 - r.z0) < r.z0 * 0.2, `Fit did not restore the fitted scale: ${JSON.stringify(r)}`);
    expect(r.wideLabels > 0, 'zooming in did not switch captions to labelled blocks');
    return r;
  });

  await test('keyboard: space plays, S cuts at the playhead, Esc deselects', async () => {
    const before = (disk().cuts || []).length;
    const r = await js(`(async () => {
      const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      const v = document.querySelector('#video');
      v.currentTime = 30; key(' '); await new Promise(r => setTimeout(r, 400));
      const playing = !v.paused; key(' '); await new Promise(r => setTimeout(r, 200));
      key('s'); await new Promise(r => setTimeout(r, 100));
      const selectedAfterS = !!document.querySelector('#inspector h3');
      key('Escape'); await new Promise(r => setTimeout(r, 100));
      return { playing, paused: v.paused, selectedAfterS, deselected: !document.querySelector('#inspector h3') };
    })()`);
    await settle();
    expect(r.playing && r.paused, 'space did not toggle playback');
    expect(disk().cuts.length === before + 1, 'S did not add a cut');
    expect(r.deselected, 'Escape did not clear the selection');
    // undo the test cut
    const p = disk(); p.cuts.pop(); writeFileSync(projectFile, JSON.stringify(p, null, 2));
    await wait(300);
    return r;
  });

  await test('panels: the rail and timeline splitters resize', async () => {
    const r = await js(`(async () => {
      const rail = document.querySelector('#rail');
      const w0 = rail.getBoundingClientRect().width;
      const h = document.querySelector('#splitRail');
      h.dispatchEvent(new PointerEvent('pointerdown', { clientX: 900, clientY: 400, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 820, clientY: 400, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      return { w0, w1: rail.getBoundingClientRect().width };
    })()`);
    expect(r.w1 > r.w0 + 40, `rail did not widen: ${JSON.stringify(r)}`);
    return r;
  });

  // ---------------------------------------------------------------- agent loop
  await test('auto-reload: an external edit to project.json reaches the UI', async () => {
    const p = disk();
    p.meta.title = 'EXTERNAL EDIT ' + Date.now();
    await wait(3200);                       // clear the "don't clobber a fresh local edit" guard
    writeFileSync(projectFile, JSON.stringify(p, null, 2));
    for (let i = 0; i < 20; i++) {
      const t = await js(`window.__cve.project?.meta?.title || ''`);
      if (t === p.meta.title) return { title: t };
      await wait(400);
    }
    throw new Error('UI did not pick up the external project.json edit');
  });

  // ---------------------------------------------------------------- playback / seeking
  await test('ruler click seeks the playhead', async () => {
    const r = await js(`(() => {
      const ruler = document.querySelector('#ruler');
      const box = ruler.getBoundingClientRect();
      ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: box.left + box.width * 0.5, clientY: box.top + 5, bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return { time: document.querySelector('#video').currentTime, dur: window.__cve.project.meta.duration };
    })()`);
    expect(r.time > r.dur * 0.3 && r.time < r.dur * 0.7, `seek landed at ${r.time} for duration ${r.dur}`);
    return r;
  });

  // ---------------------------------------------------------------- security
  await test('security: cve:// refuses a path outside the workspace', async () => {
    const r = await js(`(async () => {
      const v = document.createElement('video');
      v.src = 'cve://media/?p=' + encodeURIComponent('/etc/hosts');
      document.body.appendChild(v);
      await new Promise(res => { v.onerror = res; v.onloadedmetadata = res; setTimeout(res, 2500); });
      const err = !!v.error; v.remove(); return { blocked: err };
    })()`);
    expect(r.blocked, 'cve:// served a file outside the workspace!');
    return r;
  });

  await test('security: renderer has no Node access', async () => {
    const r = await js(`({ require: typeof require, process: typeof process, module: typeof module,
      ipc: typeof window.editor?.send, keys: Object.keys(window.editor).length })`);
    expect(r.require === 'undefined' && r.process === 'undefined' && r.module === 'undefined',
      'Node primitives are reachable from the page: ' + JSON.stringify(r));
    return r;
  });

  // restore the project exactly as we found it
  writeFileSync(projectFile, backup);
  await wait(500);
  await js(`window.editor.getProject().then(p => { window.__cve.restored = true; })`).catch(() => {});

  return { total: results.length, passed: results.filter((r) => r.pass).length, results };
}
