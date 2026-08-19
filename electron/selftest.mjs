// Functional parity suite — drives the REAL UI (clicks, typing, buttons) and verifies each
// change round-trips to project.json on disk, then restores the file byte-for-byte.
//
// Every feature the pre-Electron web app had is covered here, plus the ones Phase 0 added.
// Run: CVE_SMOKE=ui,edit npm run smoke
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runEditTests({ win, settings, app }) {
  const wc = win.webContents;
  const projectFile = settings.work + '/project.json';
  const backup = readFileSync(projectFile, 'utf8');
  const results = [];
  const disk = () => JSON.parse(readFileSync(projectFile, 'utf8'));
  const DUR = () => disk().meta?.duration || 10;
  const at = (fraction) => +(DUR() * fraction).toFixed(2);      // a time inside any project

  const js = (code) => wc.executeJavaScript(code, true);
  // The UI autosaves 400ms after the last edit. Rather than guessing, wait until it says
  // "Saved" — a fixed sleep is exactly the kind of flake a public CI cannot afford.
  const settle = async (ms = 4000) => {
    const started = Date.now();
    await wait(250);
    while (Date.now() - started < ms) {
      const status = await js(`document.querySelector('#status')?.textContent || ''`).catch(() => '');
      if (!/Unsaved/i.test(status)) { await wait(150); return; }
      await wait(150);
    }
  };
  // Tests that need the network or a model download are tagged `heavy`; everything else is
  // `core` and runs anywhere ffmpeg exists. CI runs core; a full local run does the lot.
  const HEAVY = [/^transcribe:/, /^templates: rendering/, /^templates: a user-installed/,
                 /^onboarding: a raw video/];
  // The synthetic project's audio is a tone: anything that needs real speech must sit out.
  const NEEDS_SPEECH = [/^transcribe: rebuilds/];
  const synthetic = (() => {
    try { return JSON.parse(readFileSync(projectFile, 'utf8')).meta?.source === 'synthetic'; }
    catch { return false; }
  })();
  const wanted = (process.env.CVE_TEST_TAGS || '').split(',').map((t) => t.trim()).filter(Boolean);
  const tagsFor = (name) => (HEAVY.some((re) => re.test(name)) ? ['heavy', 'network'] : ['core']);

  const test = async (name, fn) => {
    const tags = tagsFor(name);
    if (synthetic && NEEDS_SPEECH.some((re) => re.test(name))) {
      results.push({ name, pass: true, skipped: true, tags, reason: 'needs real speech' });
      console.log('[selftest] SKIP', name, '(needs real speech)');
      return;
    }
    if (wanted.length && !tags.some((t) => wanted.includes(t))) {
      results.push({ name, pass: true, skipped: true, tags });
      console.log('[selftest] SKIP', name, `(${tags.join(',')})`);
      return;
    }
    try { const detail = await fn(); results.push({ name, pass: true, detail, tags }); }
    catch (e) {
      // capture what the app looked like at the moment of failure — a bare assertion
      // message is rarely enough to tell a product bug from a test-order accident
      let ctx = {};
      try {
        ctx = await js(`({ inspector: document.querySelector('#inspector .kind')?.textContent || null,
          selection: JSON.stringify(window.__cve.sel || null),
          homeOpen: !document.querySelector('#home')?.hidden,
          status: document.querySelector('#status')?.textContent,
          cues: window.__cve.project?.captions?.cues?.length,
          cuts: JSON.stringify(window.__cve.project?.cuts || []),
          reloads: window.__cve.reloads || 0 })`);
      } catch {}
      results.push({ name, pass: false, error: e?.message || String(e), tags, context: ctx });
    }
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
    await js(`(() => { document.querySelector('#video').currentTime = ${at(0.3)};
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
      set('Cut start', '${at(0.25)}'); set('Cut end', '${at(0.35)}');
      document.querySelector('#video').currentTime = ${at(0.45)};
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Set end = playhead').click();
    })()`);
    await settle();
    const c = disk().cuts[disk().cuts.length - 1];
    expect(Math.abs(c.start - at(0.25)) < 0.05 && Math.abs(c.end - at(0.45)) < 0.2,
      'cut edit not persisted: ' + JSON.stringify(c));
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
      v.currentTime = ${at(0.5)}; key(' '); await new Promise(r => setTimeout(r, 400));
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
    expect(r.recents >= 1, 'the current project was not listed in Recents');
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
    // a real recording to feed the pipeline, trimmed from whatever master this project has
    const sourceDur = Math.min(18, Math.max(4, Math.floor(disk().meta.duration - 0.5)));
    execFileSync('ffmpeg', ['-hide_banner', '-y', '-ss', '0', '-t', String(sourceDur), '-i',
      join(settings.work, 'graded_master.mp4'), '-c:v', 'h264_videotoolbox', '-b:v', '6M',
      '-c:a', 'aac', src], { stdio: 'ignore' });

    const r = await js(`(async () => {
      const events = []; const off = window.editor.newProject.onEvent(e => events.push(e));
      const t0 = Date.now();
      const started = await window.editor.newProject.create({
        source: ${JSON.stringify(src)}, dest: ${JSON.stringify(dest)},
        transcribe: ${JSON.stringify(!synthetic)}, model: 'tiny.en',
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
    // transcript.json only exists when transcription ran (it is skipped for tone-only audio)
    const required = ['project.json', 'graded_master.mp4', ...(synthetic ? [] : ['transcript.json'])];
    for (const f of required) {
      expect(existsSync(join(dest, f)), `the new project is missing ${f}`);
    }
    const p = JSON.parse(readFileSync(join(dest, 'project.json'), 'utf8'));
    expect(p.meta?.width === 1920 && p.meta?.height === 1080, 'the master was not normalised to 1080p: ' + JSON.stringify(p.meta));
    expect(p.meta?.fps === 30, 'the master is not 30fps: ' + p.meta?.fps);
    if (!synthetic) {
      expect(p.captions?.cues?.length > 5, 'no captions were built: ' + p.captions?.cues?.length);
    }
    expect((p.captions?.cues || []).every((c) => c.tokens?.length && c.end >= c.start), 'malformed cues');
    expect(Math.abs(p.meta.duration - sourceDur) < 1.5,
      `duration is wrong: ${p.meta.duration} (source was ${sourceDur}s)`);
    const needStages = ['probe', 'grade', 'build', ...(synthetic ? [] : ['transcribe'])];
    expect(needStages.every((st) => r.stages.includes(st)), 'stages missing: ' + r.stages.join(','));

    const out = { seconds: r.seconds, cues: p.captions?.cues?.length || 0, duration: p.meta.duration,
                  stages: r.stages,
                  sample: p.captions?.cues?.[0]?.tokens?.map((t) => t.t).join(' ') || '(no transcript)' };
    // the app adopted the new folder — put the test workspace back before anything else runs
    await js(`window.editor.newProject.adopt(${JSON.stringify(settings.work)})`);
    await wait(600);
    try { rmSync(dest, { recursive: true, force: true }); rmSync(src, { force: true }); } catch {}
    return out;
  });

  // ---------------------------------------------------------------- transcript editing
  await test('transcript editor: words render, selection cuts, restore brings it back', async () => {
    const before = (disk().cuts || []).length;
    // a five-word window that exists in any transcript, away from both ends
    const allWords = JSON.parse(readFileSync(settings.work + '/transcript.json', 'utf8'));
    const pickA = Math.max(1, Math.floor(allWords.length * 0.35));
    const pickB = Math.min(allWords.length - 2, pickA + 4);
    await js(`(() => { window.__cve.txPickA = ${pickA}; window.__cve.txPickB = ${pickB}; })()`);
    const r = await js(`(async () => {
      document.querySelector('#btnTranscriptEdit').click();
      for (let i = 0; i < 40 && !document.querySelector('.tx-doc'); i++) await new Promise(r => setTimeout(r, 200));
      const words = document.querySelectorAll('.tx-w').length;
      const pick = (i) => document.querySelector('.tx-w[data-i="' + i + '"]');
      const A = window.__cve.txPickA, B = window.__cve.txPickB;   // computed for this project
      // select a five-word phrase by pointer, exactly as a user would
      pick(A).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      pick(B).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const selected = document.querySelectorAll('.tx-w.sel').length;
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Cut selection').click();
      await new Promise(r => setTimeout(r, 900));
      const struck = document.querySelectorAll('.tx-w.cut').length;
      const playing = document.querySelector('#previewTag').textContent;
      return { words, selected, struck, playing };
    })()`, true);
    await settle();
    const after = disk().cuts || [];
    expect(r.words >= 8, 'the transcript did not render: ' + r.words);
    expect(r.selected === pickB - pickA + 1, `drag selection took ${r.selected} words, expected ${pickB - pickA + 1}`);
    expect(after.length > before, 'cutting the selection did not add a cut');
    expect(after.some((c) => c.source === 'transcript'), 'the cut is not tagged as coming from the transcript');
    expect(r.struck > 0, 'cut words are not struck through');
    expect(/graded_master/.test(r.playing), 'the editor did not switch the player to the uncut master: ' + r.playing);

    // the cut must sit in the gap around those words, never across a neighbouring word
    const words = JSON.parse(readFileSync(settings.work + '/transcript.json', 'utf8'));
    const made = after.find((c) => c.source === 'transcript');
    const clipped = words.filter((w) => w.start < made.end - 0.02 && w.end > made.start + 0.02);
    const expected = words.slice(pickA, pickB + 1).map((w) => w.text).join(' ');
    expect(clipped.map((w) => w.text).join(' ') === expected,
      `the cut spans the wrong words: "${clipped.map((w) => w.text).join(' ')}" vs "${expected}"`);

    // restore
    const dbg = await js(`(async () => {
      const pick = (i) => document.querySelector('.tx-w[data-i="' + i + '"]');
      pick(window.__cve.txPickA).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      pick(window.__cve.txPickB).dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
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
      document.querySelector('#video').currentTime = ${at(0.6)};
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

  // ---------------------------------------------------------------- recording
  await test('recording: sources are enumerable and permissions are reported', async () => {
    const r = await js(`(async () => {
      const [listed, perms] = await Promise.all([
        window.editor.rec.sources(), window.editor.rec.permissions() ]);
      const sources = listed.sources;
      return { count: sources.length, hasThumb: sources.every(s => /^data:image/.test(s.thumbnail)),
               names: sources.slice(0,2).map(s => s.name.slice(0,24)),
               denied: listed.screenCaptureDenied, perms };
    })()`, true);
    expect(r.count > 0, 'no capturable sources were found');
    expect(r.hasThumb, 'a source came back without a preview thumbnail');
    // The app must be able to tell that macOS is withholding the displays — a silent empty
    // recording is the one failure a user cannot diagnose for themselves.
    expect(typeof r.denied === 'boolean', 'rec:sources does not report whether capture is blocked');
    expect(['granted','denied','not-determined','restricted','unknown'].includes(r.perms.screen),
      'screen permission not reported: ' + r.perms.screen);
    return r;
  });

  await test('recording: chunks are written to disk and the cursor track is captured', async () => {
    // Drive the main-process side directly with synthetic chunks — no camera, no permission
    // prompts, so this runs anywhere including CI.
    const r = await js(`(async () => {
      const started = await window.editor.rec.start({ name: 'selftest', screenId: 'screen:0:0', camera: false, mic: false });
      if (started.error) return { error: started.error };
      const enc = new TextEncoder();
      let bytes = 0;
      for (let i = 0; i < 5; i++) {
        const res = await window.editor.rec.chunk('screen', enc.encode('chunk-' + i + '-'.repeat(500)).buffer);
        bytes = res.bytes;
        await new Promise(r => setTimeout(r, 120));
      }
      await window.editor.rec.mark('mark');
      const summary = await window.editor.rec.stop();
      return { dir: started.dir, bytes, summary };
    })()`, true);
    expect(!r.error, 'recording did not start: ' + r.error);
    expect(r.bytes > 2000, 'chunks did not accumulate on disk: ' + r.bytes);

    const screenFile = join(r.dir, 'recording', 'screen.mp4');
    expect(existsSync(screenFile), 'no screen file was written');
    expect(statSync(screenFile).size === r.bytes, 'the file size does not match what was streamed');

    const cursor = JSON.parse(readFileSync(join(r.dir, 'recording', 'cursor.json'), 'utf8'));
    expect(cursor.samples.length > 10, 'the cursor track is empty: ' + cursor.samples.length);
    expect(cursor.samples.every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1),
      'cursor samples are not normalised 0..1');
    expect(cursor.events.some((e) => e.type === 'mark'), 'the mark was not recorded');
    expect(cursor.samples[cursor.samples.length - 1].t > 0.4, 'cursor timestamps are not advancing');

    const { rmSync } = await import('node:fs');
    try { rmSync(r.dir, { recursive: true, force: true }); } catch {}
    return { bytes: r.bytes, samples: cursor.samples.length, duration: r.summary.duration };
  });

  await test('recording: pause stops the clock and the cursor track', async () => {
    const r = await js(`(async () => {
      const started = await window.editor.rec.start({ name: 'pausetest', screenId: 'screen:0:0' });
      await new Promise(r => setTimeout(r, 400));
      await window.editor.rec.pause();
      await new Promise(r => setTimeout(r, 900));
      await window.editor.rec.resume();
      await new Promise(r => setTimeout(r, 400));
      const s = await window.editor.rec.stop();
      return { dir: started.dir, duration: s.duration };
    })()`, true);
    // ~0.8s of real recording plus ~0.9s paused: the clock must exclude the pause
    expect(r.duration > 0.5 && r.duration < 1.4,
      `paused time was counted: ${r.duration}s (expected ~0.8s of a ~1.7s wall clock)`);
    const { rmSync } = await import('node:fs');
    try { rmSync(r.dir, { recursive: true, force: true }); } catch {}
    return r;
  });

  // ---------------------------------------------------------------- the agent brief
  await test('brief: choosing a template writes instructions the agent can act on', async () => {
    const r = await js(`window.editor.templates.apply('midnight-chalk')`, true);
    await settle();
    const p = disk();
    expect(r?.ok === true, 'apply failed: ' + r?.error);
    const b = p.brief;
    expect(!!b, 'no brief was written into project.json');
    expect(b.template.id === 'midnight-chalk', 'the brief names the wrong template: ' + b.template?.id);
    expect(b.capabilities.scenes.length > 0, 'the brief lists no scene types');
    expect(b.capabilities.overlays.length > 0, 'the brief lists no motion-graphics presets');
    expect(b.capabilities.overlays.every((o) => /hyperframes render/.test(o.render)),
      'a preset has no render command the agent could run');
    expect(/render_project\.py/.test(b.commands.export), 'no export command in the brief');
    expect(b.handoff.agentShouldDo.length >= 3, 'the brief does not say what the agent should do');
    expect(!!b.capabilities.mediaGeneration, 'no media-generation section (the extension point)');

    // the same content must reach BOTH agent files
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const md = readFileSync(join(settings.work, f), 'utf8');
      expect(/Midnight Chalk/.test(md), `${f} does not mention the chosen template`);
      expect(/project\.json/.test(md) && /edit my video/i.test(md), `${f} is missing the job description`);
      expect(/chalk-lower-third/.test(md), `${f} does not list the presets the agent may render`);
    }
    const a = readFileSync(join(settings.work, 'CLAUDE.md'), 'utf8');
    const c = readFileSync(join(settings.work, 'AGENTS.md'), 'utf8');
    expect(a === c, 'CLAUDE.md and AGENTS.md have drifted apart');

    // put the original template back
    await js(`window.editor.templates.apply('coral-ink-bone')`, true);
    await settle();
    return { template: b.template.id, presets: b.capabilities.overlays.length,
             sceneTypes: b.capabilities.scenes.length, docBytes: a.length };
  });

  await test('brief: the user intent survives a template change', async () => {
    await js(`window.editor.templates.setIntent('punchy two-minute cut, one title card per chapter')`, true);
    await settle();
    expect(/punchy two-minute/.test(disk().brief.intent), 'intent was not saved');
    await js(`window.editor.templates.apply('midnight-chalk')`, true);
    await settle();
    expect(/punchy two-minute/.test(disk().brief.intent), 'changing the template wiped the user intent');
    const md = readFileSync(join(settings.work, 'CLAUDE.md'), 'utf8');
    expect(/punchy two-minute/.test(md), 'the intent never reached the agent doc');
    await js(`window.editor.templates.apply('coral-ink-bone')`, true);
    await js(`window.editor.templates.setIntent('')`, true);
    await settle();
    return { intentSurvived: true };
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

  await test('transcribe: the engine list reports a stored key without unlocking it', async () => {
    // The rule (presence must never decrypt) is enforced and proved in scripts/check-keys.mjs,
    // where safeStorage can be made to scream when touched. What this checks is that the real
    // app is wired to that rule: a key stored through the UI shows up in the panel, and the
    // panel opening does not hang — which is what a keychain dialog behind the window looks like.
    const r = await js(`(async () => {
      const t0 = Date.now();
      await window.editor.transcribe.setKey('openai', 'sk-selftest-presence');
      const listed = await window.editor.transcribe.engines();
      const ms = Date.now() - t0;
      await window.editor.transcribe.setKey('openai', '');
      const after = await window.editor.transcribe.engines();
      return { present: listed.openai, cleared: after.openai, keychain: listed.keys?.keychain, ms };
    })()`, true);
    expect(r.present === true, 'a stored key was not reported as present');
    expect(r.cleared === false, 'clearing the key did not take effect');
    expect(r.ms < 3000, `listing engines took ${r.ms}ms — something blocked main (a keychain dialog?)`);
    // The rule itself — that reporting state never touches the keychain — is enforced and proved
    // in scripts/check-keys.mjs against a safeStorage that counts every access. Here we can only
    // observe the symptom it prevents: on a build whose signature changed since a key was stored,
    // that call has been measured at 584 SECONDS with the whole app frozen behind it.
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
    // union length, not naive sum — merging two overlapping cuts reduces the sum while
    // removing strictly more of the timeline
    const cutSeconds = (p) => {
      const rs = [...(p.cuts || [])].sort((a, b) => a.start - b.start);
      let total = 0, cur = null;
      for (const r of rs) {
        if (!cur || r.start > cur.end) { if (cur) total += cur.end - cur.start; cur = { ...r }; }
        else cur.end = Math.max(cur.end, r.end);
      }
      if (cur) total += cur.end - cur.start;
      return total;
    };
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


  // ---------------------------------------------------------------- zooms (camera moves)
  await test('zooms: the track shows six lanes, aligned and none clipped', async () => {
    const r = await js(`(() => {
      const panel = document.querySelector('.timeline-panel').getBoundingClientRect();
      const lanes = [...document.querySelectorAll('.lane')].map((l) => {
        const b = l.getBoundingClientRect();
        return { id: l.id, top: Math.round(b.top), clipped: b.bottom > panel.bottom + 0.5 };
      });
      const heads = [...document.querySelectorAll('.thead:not(.ruler-head)')]
        .map((h) => Math.round(h.getBoundingClientRect().top));
      return { ids: lanes.map((l) => l.id), clipped: lanes.filter((l) => l.clipped).map((l) => l.id),
               misaligned: lanes.filter((l, i) => Math.abs(l.top - heads[i]) > 2).map((l) => l.id) };
    })()`);
    expect(r.ids.includes('laneZooms'), 'there is no Zooms lane');
    expect(!r.clipped.length, 'lanes fall outside the timeline panel: ' + r.clipped.join(', '));
    expect(!r.misaligned.length, 'lanes do not line up with their headers: ' + r.misaligned.join(', '));
    return r;
  });

  await test('zooms: + adds one at the playhead and the centre picker writes normalised x/y', async () => {
    const before = (disk().zooms || []).length;
    await js(`(() => { document.querySelector('#video').currentTime = ${at(0.4)};
      document.querySelector('[data-add="zoom"]').click(); })()`);
    await settle();
    const added = disk().zooms || [];
    expect(added.length === before + 1, `+ did not add a zoom (${before} → ${added.length})`);

    const picked = await js(`(() => {
      const pad = document.querySelector('.zoom-pad');
      if (!pad) return null;
      const b = pad.getBoundingClientRect();
      pad.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: b.left + b.width * 0.25, clientY: b.top + b.height * 0.75 }));
      return true;
    })()`);
    expect(picked, 'the inspector showed no centre picker for the new zoom');
    await settle();
    const z = (disk().zooms || []).find((x) => x.source === 'manual');
    expect(Math.abs(z.x - 0.25) < 0.03 && Math.abs(z.y - 0.75) < 0.03,
      `centre picker wrote ${z.x}, ${z.y} — expected about 0.25, 0.75`);
    expect(Math.abs(z.start - at(0.4)) < 0.05, `zoom landed at ${z.start}, expected ${at(0.4)}`);

    // and it must be removable again, or the track is a trap
    await js(`document.querySelector('#laneZooms .clip.zoom').click()`);
    await wait(200);
    await js(`[...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Delete')?.click()`);
    await settle();
    expect((disk().zooms || []).length === before, 'deleting the zoom did not remove it from the project');
    return { added: added.length, x: z.x, y: z.y, start: z.start };
  });

  await test('zooms: suggestions from a recording become real zooms when accepted', async () => {
    // stand in for a recording: the review panel reads recording.zoomSuggestions, whatever wrote it
    const p = disk();
    p.recording = {
      screen: 'recording/screen.mp4', cursor: 'recording/cursor.json', marks: [],
      zoomSuggestions: [
        { id: 'zs1', start: at(0.2), dur: 1.8, scale: 1.35, x: 0.3, y: 0.4, source: 'click', confidence: 'high' },
        { id: 'zs2', start: at(0.6), dur: 2.0, scale: 1.25, x: 0.7, y: 0.5, source: 'dwell', confidence: 'medium' },
        { id: 'zs3', start: at(0.8), dur: 2.0, scale: 1.2, x: 0.5, y: 0.5, source: 'transcript', confidence: 'low' },
      ],
    };
    const hadZooms = (p.zooms || []).length;
    await writeProject(p);

    await js(`document.querySelector('#btnZoomSuggest').click()`);
    await wait(400);
    const panel = await js(`(() => ({
      badge: document.querySelector('#selBadge').textContent,
      rows: document.querySelectorAll('.ac-item').length,
      ticked: [...document.querySelectorAll('.ac-item input')].filter(c => c.checked).length,
    }))()`);
    expect(panel.rows === 3, `review panel listed ${panel.rows} suggestions, expected 3`);
    // low confidence starts unticked — suggestions are offered, not imposed
    expect(panel.ticked === 2, `${panel.ticked} suggestions pre-selected, expected 2 (low confidence off)`);

    await js(`[...document.querySelectorAll('#inspector button')].find(b => /^Add /.test(b.textContent))?.click()`);
    await settle();
    const after = disk().zooms || [];
    expect(after.length === hadZooms + 2, `accepted zooms did not land (${hadZooms} → ${after.length})`);
    expect(after.some((z) => z.id === 'zs1' && z.source === 'click'), 'the accepted zoom lost its identity');
    expect(!after.some((z) => z.id === 'zs3'), 'an unticked suggestion was added anyway');

    // accepting again must not duplicate
    await js(`document.querySelector('#btnZoomSuggest').click()`);
    await wait(300);
    const second = await js(`document.querySelectorAll('.ac-item').length`);
    expect(second === 1, `already-accepted suggestions came back (${second} rows, expected 1)`);
    return { accepted: after.length - hadZooms, remaining: second };
  });

  await test('zooms: the agent brief tells Claude how to use them', async () => {
    const briefed = disk().brief;
    if (!briefed) return { skipped: 'no template chosen in this project' };
    expect(briefed.capabilities?.zooms, 'the brief lists no zoom capability');
    expect(/normalised|0\.\.1/.test(JSON.stringify(briefed.capabilities.zooms)),
      'the brief does not say zoom centres are normalised');
    const md = existsSync(settings.work + '/CLAUDE.md') ? readFileSync(settings.work + '/CLAUDE.md', 'utf8') : '';
    expect(/zooms\[\]/.test(md), 'CLAUDE.md never mentions zooms[]');
    return { hasCapability: true, inDoc: /zoomSuggestions/.test(md) };
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

  // ---------------------------------------------------------------- switching projects
  await test('switching projects actually reloads the window onto the new project', async () => {
    // This is the gap that let a broken reload ship: the old tests asserted the IPC
    // returned ok, never that the UI ended up showing the other project.
    const { mkdtempSync, rmSync, cpSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const other = join(mkdtempSync(join(tmpdir(), 'cve-switch-')), 'other_project');
    cpSync(settings.work, other, { recursive: true });
    // make it unmistakably different
    const op = JSON.parse(readFileSync(join(other, 'project.json'), 'utf8'));
    op.meta.title = 'THE OTHER PROJECT';
    op.scenes = (op.scenes || []).slice(0, 1);
    writeFileSync(join(other, 'project.json'), JSON.stringify(op, null, 2));

    const before = await js(`(async () => ({ work: (await window.editor.config()).work,
      scenes: window.__cve.project?.scenes?.length }))()`);
    // reload happens under us, so wait for the page to come back with the new project
    await js(`window.editor.openWorkspace(${JSON.stringify(other)}).then(r => r?.ok && window.editor.reload())`);
    let after = null;
    for (let i = 0; i < 40; i++) {
      await wait(500);
      try {
        after = await js(`(async () => ({ work: (await window.editor.config()).work,
          title: window.__cve.project?.meta?.title,
          scenes: window.__cve.project?.scenes?.length,
          homeCovering: !document.querySelector('#home')?.hidden,
          timelineVisible: !!document.querySelector('#laneScenes .clip'),
          ready: !!window.__cve.project }))()`);
        if (after?.ready && after.work === other && after.title === 'THE OTHER PROJECT') break;
      } catch { /* mid-reload */ }
    }
    expect(after?.work === other, `the app is still on ${after?.work} (wanted ${other})`);
    expect(after?.title === 'THE OTHER PROJECT', 'the window did not reload onto the new project');
    expect(after?.scenes === 1, `the timeline still shows the old project's scenes: ${after?.scenes}`);
    // The bug this catches: the project loads, but Home is still covering the editor, so
    // the click reads as "nothing happened" and the user clicks again and again.
    expect(after?.homeCovering === false,
      'the project opened but Home is still covering the editor');
    expect(after?.timelineVisible === true, 'the timeline is not showing the opened project');

    // Put the original project back and PROVE it: leaving the app pointed at a temp
    // folder would poison everything that runs afterwards.
    let back = null;
    for (let attempt = 0; attempt < 3 && back?.work !== settings.work; attempt++) {
      await js(`(async () => { const r = await window.editor.openWorkspace(${JSON.stringify(settings.work)});
        if (r?.ok) await window.editor.reload(); })()`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        await wait(500);
        try {
          back = await js(`(async () => ({ work: (await window.editor.config()).work,
            ready: !!window.__cve.project }))()`);
          if (back?.ready && back.work === settings.work) break;
        } catch { /* mid-reload */ }
      }
    }
    expect(back?.work === settings.work,
      `could not switch back to ${settings.work} (still on ${back?.work})`);
    try { rmSync(dirname(other), { recursive: true, force: true }); } catch {}
    return { from: before.work, to: other, scenesAfter: after?.scenes, restored: back.work };
  });


  // restore the project exactly as we found it
  writeFileSync(projectFile, backup);
  await wait(500);
  await js(`window.editor.getProject().then(p => { window.__cve.restored = true; })`).catch(() => {});

  return {
    total: results.length,
    passed: results.filter((r) => r.pass && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    results,
  };
}
