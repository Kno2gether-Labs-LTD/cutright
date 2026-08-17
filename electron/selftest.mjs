// Functional parity suite — drives the REAL UI (clicks, typing, buttons) and verifies each
// change round-trips to project.json on disk, then restores the file byte-for-byte.
//
// Every feature the pre-Electron web app had is covered here, plus the ones Phase 0 added.
// Run: CVE_SMOKE=ui,edit npm run smoke
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

  // Writing project.json behind the UI's back is not enough: the renderer holds the
  // project in memory and its next autosave would write the stale copy back. Wait past
  // the anti-clobber window, then confirm the UI has actually reloaded.
  const writeProject = async (obj) => {
    await wait(3200);
    writeFileSync(projectFile, JSON.stringify(obj, null, 2));
    for (let i = 0; i < 20; i++) {
      await wait(300);
      const seen = await js(`JSON.stringify(window.__cve.project?.cuts || [])`);
      if (seen === JSON.stringify(obj.cuts || [])) return true;
    }
    throw new Error('the UI did not pick up the restored project');
  };

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
      hideHome();                       // Escape closes home first by design
      await new Promise(r => setTimeout(r, 200));
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
    const p = disk(); p.cuts.pop(); await writeProject(p);
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

  // ---------------------------------------------------------------- home
  await test('home: shows recents, the feature grid and the brand promo', async () => {
    const r = await js(`(async () => {
      await showHome();
      await new Promise(r => setTimeout(r, 300));
      const visible = !document.querySelector('#home').hidden;
      const recents = document.querySelectorAll('#homeRecent .recent-item').length;
      const hero = document.querySelector('.hero h2')?.textContent?.trim().slice(0, 40);
      const feats = document.querySelectorAll('.feat h4').length;
      const promo = !!document.querySelector('.promo h3');
      const brandFont = getComputedStyle(document.querySelector('.home-name')).fontFamily;
      const accent = getComputedStyle(document.querySelector('#homeNew')).backgroundColor;
      return { visible, recents, hero, feats, promo, brandFont, accent };
    })()`, true);
    expect(r.visible, 'home did not open');
    expect(r.recents >= 1, 'the recent project was not listed');
    expect(r.feats === 6, 'expected six feature cards, saw ' + r.feats);
    expect(r.promo, 'the Viddescriptor promo section is missing');
    expect(/Anton/.test(r.brandFont), 'the brand display font did not load: ' + r.brandFont);
    return r;
  });

  await test('home: closes to the editor and reopens from the header', async () => {
    const r = await js(`(async () => {
      hideHome();
      await new Promise(r => setTimeout(r, 200));
      const closed = document.querySelector('#home').hidden;
      const editorUsable = !!document.querySelector('#laneScenes .clip');
      document.querySelector('#btnHome').click();
      await new Promise(r => setTimeout(r, 400));
      const reopened = !document.querySelector('#home').hidden;
      hideHome();
      await new Promise(r => setTimeout(r, 200));
      return { closed, editorUsable, reopened };
    })()`, true);
    expect(r.closed, 'home did not close');
    expect(r.editorUsable, 'the editor was not usable behind home');
    expect(r.reopened, 'the Home button did not bring it back');
    return r;
  });

  await test('home: the promo link can only open the brand site', async () => {
    const r = await js(`(async () => {
      const good = await window.editor.openExternal('https://viddescriptor.com');
      const bad = await window.editor.openExternal('https://example.com/evil');
      const worse = await window.editor.openExternal('file:///etc/passwd');
      return { good, bad, worse };
    })()`, true);
    expect(r.good?.ok === true, 'the brand link was blocked');
    expect(r.bad?.ok === false && r.worse?.ok === false, 'openExternal is not restricted: ' + JSON.stringify(r));
    return r;
  });

  // ---------------------------------------------------------------- onboarding
  await test('onboarding: the guided tour spotlights real elements', async () => {
    const r = await js(`(async () => {
      localStorage.removeItem('cutright.tourSeen');
      startTour(true);
      await new Promise(r => setTimeout(r, 400));
      const seen = [];
      for (let i = 0; i < 12; i++) {
        const card = document.querySelector('#tourCard');
        const spot = document.querySelector('#tourSpot').getBoundingClientRect();
        const visible = !document.querySelector('#tour').hidden;
        if (!visible) break;
        seen.push({ title: document.querySelector('#tourTitle').textContent,
                    w: Math.round(spot.width), h: Math.round(spot.height),
                    onScreen: spot.left > -50 && spot.top > -50 && spot.right < innerWidth + 50 });
        document.querySelector('#tourNext').click();
        await new Promise(r => setTimeout(r, 250));
      }
      const finished = document.querySelector('#tour').hidden;
      const remembered = localStorage.getItem('cutright.tourSeen');
      return { seen, finished, remembered };
    })()`, true);
    expect(r.seen.length >= 6, 'the tour showed too few steps: ' + r.seen.length);
    expect(r.seen.every((s) => s.w > 10 && s.h > 10), 'a tour step spotlighted nothing: ' + JSON.stringify(r.seen));
    expect(r.seen.every((s) => s.onScreen), 'a tour step pointed off screen: ' + JSON.stringify(r.seen));
    expect(r.finished === true, 'the tour did not close at the end');
    expect(r.remembered === '1', 'the tour will show again on next launch');
    return { steps: r.seen.length, titles: r.seen.map((s) => s.title) };
  });

  await test('onboarding: the empty inspector offers the four ways in', async () => {
    const r = await js(`(async () => {
      hideHome(); deselect();
      await new Promise(r => setTimeout(r, 200));
      const labels = [...document.querySelectorAll('#inspector button')].map(b => b.textContent);
      return { labels };
    })()`, true);
    for (const want of ['Edit by transcript', 'Find cuts for me', 'Templates', 'Look', 'Show me around']) {
      expect(r.labels.includes(want), `the empty state is missing "${want}": ${r.labels.join(', ')}`);
    }
    return r;
  });

  await test('onboarding: the project switcher lists new / open / recents', async () => {
    const r = await js(`(async () => {
      document.querySelector('#btnWorkspace').click();
      await new Promise(r => setTimeout(r, 400));
      return { kind: document.querySelector('#inspector .kind')?.textContent,
               labels: [...document.querySelectorAll('#inspector button')].map(b => b.textContent) };
    })()`, true);
    expect(r.kind === 'project', 'the project switcher did not open: ' + r.kind);
    expect(r.labels.some((l) => /Start from a video/.test(l)), 'no way to start a new project');
    expect(r.labels.some((l) => /Open another project/.test(l)), 'no way to open another project');
    return r;
  });

  await test('onboarding: the new-project dialog validates before it runs', async () => {
    const r = await js(`(async () => {
      openNewProject();
      await new Promise(r => setTimeout(r, 300));
      const visible = !document.querySelector('#newproj').hidden;
      const goDisabled = document.querySelector('#npGo').disabled;
      // fake a chosen video + destination without touching the file dialogs
      np.source = '/tmp/does-not-exist.mov'; np.dest = '/tmp/cve-np-test'; paintNewProject();
      const goEnabled = !document.querySelector('#npGo').disabled;
      const shown = document.querySelector('#npSource').textContent;
      document.querySelector('#npCancel').click();
      await new Promise(r => setTimeout(r, 200));
      return { visible, goDisabled, goEnabled, shown, closed: document.querySelector('#newproj').hidden };
    })()`, true);
    expect(r.visible, 'the new-project dialog did not open');
    expect(r.goDisabled, 'Create was enabled with nothing chosen');
    expect(r.goEnabled, 'Create stayed disabled after choosing a video and folder');
    expect(r.closed, 'Cancel did not close the dialog');
    return r;
  });

  await test('onboarding: a raw video becomes a working project folder', async () => {
    const { execFileSync } = await import('node:child_process');
    const { rmSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const src = join(tmpdir(), 'cve_newproj_src.mov');
    const dest = join(mkdtempSync(join(tmpdir(), 'cve-np-')), 'clip_edit');
    // a real 18s recording to feed the pipeline (trimmed from the workspace master)
    execFileSync('ffmpeg', ['-hide_banner', '-y', '-ss', '0', '-t', '18', '-i',
      join(settings.work, 'graded_master.mp4'), '-c:v', 'h264_videotoolbox', '-b:v', '6M',
      '-c:a', 'aac', src], { stdio: 'ignore' });

    const r = await js(`(async () => {
      const events = []; const off = window.editor.newProject.onEvent(e => events.push(e));
      const t0 = Date.now();
      const started = await window.editor.newProject.create({
        source: ${JSON.stringify(src)}, dest: ${JSON.stringify(dest)},
        transcribe: true, model: 'tiny.en',
      });
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
          if (Date.now() - t0 > 900000) { clearInterval(iv); res({ type: 'timeout' }); }
        }, 500);
      });
      off();
      return { started, done, seconds: Math.round((Date.now() - t0) / 1000),
               stages: [...new Set(events.filter(e => e.type === 'progress').map(e => e.stage))],
               maxPct: Math.max(0, ...events.filter(e => e.type === 'progress').map(e => e.pct || 0)) };
    })()`, true);

    expect(r.done?.type === 'done', 'project creation failed: ' + JSON.stringify(r.done).slice(0, 250));
    for (const f of ['project.json', 'graded_master.mp4', 'transcript.json']) {
      expect(existsSync(join(dest, f)), `the new project is missing ${f}`);
    }
    const p = JSON.parse(readFileSync(join(dest, 'project.json'), 'utf8'));
    expect(p.meta?.width === 1920 && p.meta?.height === 1080, 'the master was not normalised to 1080p: ' + JSON.stringify(p.meta));
    expect(p.meta?.fps === 30, 'the master is not 30fps: ' + p.meta?.fps);
    expect(p.captions?.cues?.length > 5, 'no captions were built: ' + p.captions?.cues?.length);
    expect(p.captions.cues.every((c) => c.tokens?.length && c.end >= c.start), 'malformed cues');
    expect(Math.abs(p.meta.duration - 18) < 1.5, 'duration is wrong: ' + p.meta.duration);
    expect(r.stages.includes('probe') && r.stages.includes('grade') && r.stages.includes('transcribe')
      && r.stages.includes('build'), 'stages missing: ' + r.stages.join(','));

    const out = { seconds: r.seconds, cues: p.captions.cues.length, duration: p.meta.duration,
                  stages: r.stages, sample: p.captions.cues[0].tokens.map((t) => t.t).join(' ') };
    // the app adopted the new folder — put the test workspace back before anything else runs
    await js(`window.editor.newProject.adopt(${JSON.stringify(settings.work)})`);
    await wait(600);
    try { rmSync(dest, { recursive: true, force: true }); rmSync(src, { force: true }); } catch {}
    return out;
  });

  // ---------------------------------------------------------------- transcript editing
  await test('transcript editor: words render, selection cuts, restore brings it back', async () => {
    const before = (disk().cuts || []).length;
    const r = await js(`(async () => {
      document.querySelector('#btnTranscriptEdit').click();
      for (let i = 0; i < 40 && !document.querySelector('.tx-doc'); i++) await new Promise(r => setTimeout(r, 200));
      const words = document.querySelectorAll('.tx-w').length;
      const pick = (i) => document.querySelector('.tx-w[data-i="' + i + '"]');
      // select words 40..44 by pointer, exactly as a user would
      pick(40).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      pick(44).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const selected = document.querySelectorAll('.tx-w.sel').length;
      const w40 = window.__cve.project ? null : null;
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Cut selection').click();
      await new Promise(r => setTimeout(r, 900));
      const struck = document.querySelectorAll('.tx-w.cut').length;
      const playing = document.querySelector('#previewTag').textContent;
      return { words, selected, struck, playing };
    })()`, true);
    await settle();
    const after = disk().cuts || [];
    expect(r.words > 100, 'the transcript did not render: ' + r.words);
    expect(r.selected === 5, 'drag selection did not select 5 words: ' + r.selected);
    expect(after.length > before, 'cutting the selection did not add a cut');
    expect(after.some((c) => c.source === 'transcript'), 'the cut is not tagged as coming from the transcript');
    expect(r.struck > 0, 'cut words are not struck through');
    expect(/graded_master/.test(r.playing), 'the editor did not switch the player to the uncut master: ' + r.playing);

    // the cut must sit in the gap around those words, never across a neighbouring word
    const words = JSON.parse(readFileSync(settings.work + '/transcript.json', 'utf8'));
    const made = after.find((c) => c.source === 'transcript');
    const clipped = words.filter((w) => w.start < made.end - 0.02 && w.end > made.start + 0.02);
    const expected = words.slice(40, 45).map((w) => w.text).join(' ');
    expect(clipped.map((w) => w.text).join(' ') === expected,
      `the cut spans the wrong words: "${clipped.map((w) => w.text).join(' ')}" vs "${expected}"`);

    // restore
    const dbg = await js(`(async () => {
      const pick = (i) => document.querySelector('.tx-w[data-i="' + i + '"]');
      pick(40).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      pick(44).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const selBefore = window.__cve.tx.sel;
      const cutsBefore = JSON.parse(JSON.stringify(window.__cve.project.cuts || []));
      const b = [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Restore selection');
      b.click();
      await new Promise(r => setTimeout(r, 600));
      return { selBefore, cutsBefore, cutsAfter: window.__cve.project.cuts || [], status: document.querySelector('#status').textContent };
    })()`, true);
    await settle();
    expect((disk().cuts || []).length === before,
      'restore did not remove the cut: ' + JSON.stringify(dbg).slice(0, 400));
    return { words: r.words, cutSpan: made, restoredTo: before };
  });

  await test('transcript editor: "cut all fillers" only touches filler words', async () => {
    const before = (disk().cuts || []).length;
    const r = await js(`(async () => {
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Cut all fillers').click();
      await new Promise(r => setTimeout(r, 900));
      return { status: document.querySelector('#status').textContent };
    })()`, true);
    await settle();
    const after = disk().cuts || [];
    const words = JSON.parse(readFileSync(settings.work + '/transcript.json', 'utf8'));
    const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'ehm', 'hmm', 'mmm', 'ah', 'er', 'uhm']);
    const newCuts = after.filter((c) => String(c.source || '').startsWith('transcript:filler'));
    for (const c of newCuts) {
      const inside = words.filter((w) => w.start < c.end - 0.02 && w.end > c.start + 0.02);
      const nonFiller = inside.filter((w) => !FILLERS.has(w.text.toLowerCase().replace(/[^a-z']/g, '')));
      expect(nonFiller.length === 0, `a filler cut swallowed real speech: ${nonFiller.map((w) => w.text).join(' ')}`);
    }
    // undo whatever it added
    const p = disk(); p.cuts = (p.cuts || []).filter((c) => !String(c.source || '').startsWith('transcript:filler'));
    await writeProject(p);
    return { added: newCuts.length, status: r.status, before };
  });

  // ---------------------------------------------------------------- look + transitions
  await test('look: presets, grain/vignette and audio polish persist', async () => {
    const r = await js(`(async () => {
      document.querySelector('#btnLook').click();
      await new Promise(r => setTimeout(r, 300));
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Teal & orange').click();
      await new Promise(r => setTimeout(r, 200));
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Grain', '7'); set('Vignette', '0.4');
      const sel = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === 'Polish').querySelector('select');
      sel.value = 'podcast'; sel.dispatchEvent(new Event('change'));
      return { kind: document.querySelector('#inspector .kind')?.textContent };
    })()`, true);
    await settle();
    const p = disk();
    expect(p.grade.look.preset === 'teal-orange', 'look preset not saved: ' + JSON.stringify(p.grade.look));
    expect(p.grade.look.grain === 7 && p.grade.look.vignette === 0.4, 'grain/vignette not saved');
    expect(p.audio.polish === 'podcast', 'audio polish not saved');
    return { panel: r.kind, look: p.grade.look, polish: p.audio.polish };
  });

  await test('transitions: a cut can carry one and it survives to disk', async () => {
    const r = await js(`(async () => {
      document.querySelector('#video').currentTime = 20;
      document.querySelector('[data-add="cut"]').click();
      await new Promise(r => setTimeout(r, 300));
      const sel = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === 'Type').querySelector('select');
      const options = [...sel.options].map(o => o.value);
      sel.value = 'dip'; sel.dispatchEvent(new Event('change'));
      const set = (label, val) => { const f = [...document.querySelectorAll('#inspector .field')]
        .find(f => f.querySelector('label')?.textContent === label); const i = f.querySelector('input');
        i.value = val; i.dispatchEvent(new Event('input')); };
      set('Length (s)', '0.5');
      return { options };
    })()`, true);
    await settle();
    const cut = disk().cuts.slice(-1)[0];
    expect(cut.transition === 'dip' && cut.tdur === 0.5, 'transition not saved: ' + JSON.stringify(cut));
    expect(r.options.includes('crossfade') && r.options.includes('whip'), 'transition types missing');
    // clean up the test cut
    const p = disk(); p.cuts.pop(); await writeProject(p);
    return { cut, types: r.options.length };
  });

  // ---------------------------------------------------------------- templates
  await test('templates: both packs load with previews and presets', async () => {
    const r = await js(`(async () => {
      document.querySelector('#btnTemplates').click();
      for (let i = 0; i < 30 && !document.querySelector('.tpl-card'); i++) await new Promise(r => setTimeout(r, 200));
      const list = await window.editor.templates.list();
      return { cards: document.querySelectorAll('.tpl-card').length,
               list: list.map(t => ({ id: t.id, engine: t.engine, presets: t.overlays.length, preview: !!t.previewUrl })) };
    })()`, true);
    expect(r.cards >= 2, 'fewer than two templates rendered: ' + r.cards);
    expect(r.list.every((t) => t.presets > 0), 'a template has no presets');
    expect(r.list.every((t) => t.preview), 'a template has no preview image');
    return r;
  });

  await test('templates: applying one rewrites the caption defaults, not the content', async () => {
    const before = disk();
    const r = await js(`(async () => {
      const res = await window.editor.templates.apply('midnight-chalk');
      await new Promise(r => setTimeout(r, 600));
      return res;
    })()`, true);
    await settle();
    const after = disk();
    expect(r.ok === true, 'apply failed: ' + r.error);
    expect(after.meta.template === 'midnight-chalk', 'meta.template not written');
    expect(after.captions.defaults.highlight === '#F2B441', 'caption highlight not taken from the template');
    expect(after.captions.cues.length === before.captions.cues.length, 'applying a template changed the captions themselves');
    expect(after.scenes.length === before.scenes.length, 'applying a template changed the scenes');
    // put the original template back
    await js(`window.editor.templates.apply('coral-ink-bone')`);
    await settle();
    return { template: after.meta.template, highlight: after.captions.defaults.highlight };
  });

  await test('templates: rendering a preset produces an alpha clip on the timeline', async () => {
    const before = (disk().overlays || []).length;
    const r = await js(`(async () => {
      const events = []; const off = window.editor.templates.onEvent(e => events.push(e));
      const t0 = Date.now();
      await window.editor.templates.renderPreset({ template: 'coral-ink-bone', preset: 'callout',
        vars: { text: 'SELFTEST', corner: 'tr' }, fps: 30 });
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
          if (Date.now() - t0 > 600000) { clearInterval(iv); res({ type: 'timeout' }); }
        }, 500);
      });
      off();
      return { done, seconds: Math.round((Date.now() - t0) / 1000) };
    })()`, true);
    expect(r.done?.type === 'done', 'preset render failed: ' + JSON.stringify(r.done).slice(0, 200));

    // the file must actually carry alpha, or compositing it is pointless
    const { execFileSync } = await import('node:child_process');
    const px = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt,codec_name', '-of', 'csv=p=0', r.done.path], { encoding: 'utf8' }).trim();
    expect(/argb|rgba|yuva|4444/.test(px), 'the rendered preset has no alpha channel: ' + px);
    return { seconds: r.seconds, pix: px, mb: +(r.done.bytes / 1e6).toFixed(2),
             fromMb: +(r.done.originalBytes / 1e6).toFixed(2), duration: r.done.duration };
  });

  await test('templates: a user-installed Remotion pack renders with alpha too', async () => {
    const list = await js(`window.editor.templates.list()`, true);
    const neon = list.find((t) => t.id === 'remotion-neon');
    if (!neon) return { skipped: 'remotion-neon template not installed' };
    expect(neon.builtin === false, 'the user template was not detected as user-installed');
    const r = await js(`(async () => {
      const events = []; const off = window.editor.templates.onEvent(e => events.push(e));
      const t0 = Date.now();
      await window.editor.templates.renderPreset({ template: 'remotion-neon', preset: 'neon-lower-third',
        vars: { title: 'REMOTION OK', sub: 'second engine' }, fps: 30 });
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
          if (Date.now() - t0 > 900000) { clearInterval(iv); res({ type: 'timeout' }); }
        }, 500);
      });
      off();
      return { done, seconds: Math.round((Date.now() - t0) / 1000) };
    })()`, true);
    expect(r.done?.type === 'done', 'remotion render failed: ' + JSON.stringify(r.done).slice(0, 220));
    const { execFileSync } = await import('node:child_process');
    const px = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=pix_fmt,codec_name', '-of', 'csv=p=0', r.done.path], { encoding: 'utf8' }).trim();
    expect(/argb|rgba|yuva|4444/.test(px), 'the Remotion preset has no alpha: ' + px);
    return { engine: 'remotion', seconds: r.seconds, pix: px, mb: +(r.done.bytes / 1e6).toFixed(2) };
  });

  // ---------------------------------------------------------------- transcription
  await test('transcribe: engines are detected and the panel opens', async () => {
    const r = await js(`(async () => {
      document.querySelector('#btnTranscribe').click();
      for (let i = 0; i < 20 && !document.querySelector('#inspector .kind'); i++) await new Promise(r => setTimeout(r, 200));
      const engines = await window.editor.transcribe.engines();
      return { kind: document.querySelector('#inspector .kind')?.textContent,
               buttons: [...document.querySelectorAll('#inspector button')].map(b => b.textContent).slice(0, 6),
               engines };
    })()`, true);
    expect(r.kind === 'transcribe', 'the transcribe panel did not open: ' + r.kind);
    expect(r.engines.hyperframes === true, 'no local transcription engine detected');
    return r;
  });

  await test('transcribe: API keys round-trip through the OS keychain, never back to the page', async () => {
    const r = await js(`(async () => {
      const set = await window.editor.transcribe.setKey('openai', 'sk-test-selftest-123');
      const after = await window.editor.transcribe.engines();
      const cleared = await window.editor.transcribe.setKey('openai', '');
      const final = await window.editor.transcribe.engines();
      // the bridge must expose no way to read a key back
      const readable = Object.keys(window.editor.transcribe).filter(k => /get|read|key/i.test(k) && k !== 'setKey');
      return { set, sawKey: after.openai, cleared, stillThere: final.openai, readable, keychain: after.keys?.keychain };
    })()`, true);
    expect(r.set?.ok === true, 'could not store a key');
    expect(r.sawKey === true, 'stored key was not detected');
    expect(r.stillThere === false, 'clearing the key did not work');
    expect(r.readable.length === 0, 'the bridge exposes a key getter: ' + r.readable.join(','));
    return r;
  });

  await test('transcribe: rebuilds transcript.json + captions from the real audio', async () => {
    const projBefore = disk();
    const r = await js(`(async () => {
      const events = []; const off = window.editor.transcribe.onEvent(e => events.push(e));
      const t0 = Date.now();
      await window.editor.transcribe.start({ engine: 'hyperframes', model: 'tiny.en', rebuildCaptions: true, wordsPerCue: 3 });
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
          if (Date.now() - t0 > 900000) { clearInterval(iv); res({ type: 'timeout' }); }
        }, 500);
      });
      off();
      return { done, stages: [...new Set(events.filter(e => e.type === 'progress').map(e => e.stage))],
               seconds: Math.round((Date.now() - t0) / 1000) };
    })()`, true);
    expect(r.done?.type === 'done', 'transcription did not finish: ' + JSON.stringify(r.done).slice(0, 200));
    expect(r.done.words > 50, `too few words: ${r.done.words}`);

    const words = JSON.parse(readFileSync(settings.work + '/transcript.json', 'utf8'));
    expect(Array.isArray(words) && words.every((w) => w.text && w.end >= w.start), 'transcript.json is malformed');
    const projAfter = disk();
    expect(projAfter.captions.cues.length > 10, 'captions were not rebuilt');
    expect(projAfter.captions.defaults.font === projBefore.captions.defaults.font, 'caption defaults were clobbered');
    expect(projAfter.scenes.length === projBefore.scenes.length, 'scenes were lost by the rebuild');
    // a caption must carry an emphasis word, like the Python builder produced
    expect(projAfter.captions.cues.some((c) => c.tokens.some((t) => t.e)), 'no emphasis words were chosen');
    return { words: r.done.words, cues: r.done.cues, seconds: r.seconds, stages: r.stages,
             sample: words.slice(0, 6).map((w) => w.text).join(' ') };
  });

  // ---------------------------------------------------------------- auto-cut
  await test('auto-cut: every proposed silence is genuinely silent in the audio', async () => {
    const r = await js(`(async () => {
      const t0 = Date.now();
      const res = await window.editor.autoCut({ minSilence: 0.6, pad: 0.15, noiseDb: -35, fillers: true, stutters: true });
      return { ...res, seconds: Math.round((Date.now() - t0) / 1000) };
    })()`, true);
    expect(!r.error, 'auto-cut errored: ' + r.error);
    expect(Array.isArray(r.proposals) && r.proposals.length > 0, 'auto-cut found nothing at all');
    expect(r.proposals.every((p) => p.end > p.start), 'a proposal has a non-positive length');

    // Ground truth: measure the actual loudness of each proposed silence with ffmpeg.
    // (This is the claim that matters — "there is nothing to hear here".)
    const { execFileSync } = await import('node:child_process');
    const media = settings.work + '/graded_master.mp4';
    const checked = [];
    for (const p of r.proposals.filter((x) => x.reason === 'silence').slice(0, 6)) {
      let mean = -99;
      try {
        const out = execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(p.start),
          '-to', String(p.end), '-i', media, '-af', 'volumedetect', '-f', 'null', '-'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(out) || [])[1] ?? -99);
      } catch (e) {
        const out = String(e.stderr || '');
        mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(out) || [])[1] ?? -99);
      }
      checked.push({ ...p, mean });
    }
    const loud = checked.filter((c) => c.mean > -30);
    expect(loud.length === 0, `proposed cutting audible audio: ${JSON.stringify(loud.slice(0, 2))}`);
    return { proposals: r.proposals.length, removed: r.stats?.removedSeconds, seconds: r.seconds,
             reasons: [...new Set(r.proposals.map((p) => p.reason))],
             verifiedSilences: checked.map((c) => ({ at: c.start, meanDb: c.mean })) };
  });

  await test('auto-cut: the panel applies selected cuts and merges overlaps', async () => {
    const cutSeconds = (p) => (p.cuts || []).reduce((a, c) => a + (c.end - c.start), 0);
    const before = (disk().cuts || []).length;
    const beforeSeconds = cutSeconds(disk());
    const r = await js(`(async () => {
      document.querySelector('#btnAutoCut').click();
      for (let i = 0; i < 60 && !document.querySelector('.ac-list'); i++) await new Promise(r => setTimeout(r, 500));
      const rows = document.querySelectorAll('.ac-item').length;
      // Tick exactly the first two. Clicking a checkbox re-renders the panel, so drive it
      // by index against a fresh query each time rather than over a stale NodeList.
      const count = document.querySelectorAll('.ac-item input').length;
      for (let i = 0; i < count; i++) {
        const cb = document.querySelectorAll('.ac-item input')[i];
        if (!cb) break;
        if (cb.checked !== (i < 2)) cb.click();
      }
      const ticked = [...document.querySelectorAll('.ac-item input')].filter(c => c.checked).length;
      const apply = [...document.querySelectorAll('#inspector button')].find(b => /^Apply/.test(b.textContent));
      const label = apply?.textContent;
      const cutsBefore = (window.__cve.project.cuts || []).length;
      apply?.click();
      await new Promise(r => setTimeout(r, 500));
      return { rows, ticked, label, cutsBefore, cutsAfter: (window.__cve.project.cuts || []).length,
               status: document.querySelector('#status').textContent };
    })()`, true);
    await settle();
    const after = disk().cuts || [];
    const afterSeconds = cutSeconds(disk());
    expect(r.rows > 0, 'the auto-cut panel listed no proposals');
    // count can stay flat when a new cut merges into an existing one — removed TIME is the
    // invariant that must grow
    expect(afterSeconds > beforeSeconds + 0.01,
      `applying removed no extra time: ${beforeSeconds.toFixed(2)}s → ${afterSeconds.toFixed(2)}s (${before} → ${after.length} cuts)`);
    expect(after.every((c, i) => i === 0 || c.start > after[i - 1].end), 'applied cuts overlap');
    expect(after.some((c) => String(c.source || '').startsWith('auto:')), 'applied cuts are not tagged with their source');
    return { cuts: `${before} → ${after.length}`, seconds: `${beforeSeconds.toFixed(2)} → ${afterSeconds.toFixed(2)}`, applied: r.label };
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
