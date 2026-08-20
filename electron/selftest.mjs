// Functional parity suite — drives the REAL UI (clicks, typing, buttons) and verifies each
// change round-trips to project.json on disk, then restores the file byte-for-byte.
//
// Every feature the pre-Electron web app had is covered here, plus the ones Phase 0 added.
// Run: CVE_SMOKE=ui,edit npm run smoke
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
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
  // Wait for the edit to actually be on disk. This asks the page whether a write is still
  // pending rather than reading the status line: any setStatus() after save() wiped "Unsaved…",
  // so a test could sail past a debounced write and read the previous value — which is exactly
  // what happened on a slower CI runner while it passed every time locally.
  const settle = async (ms = 4000) => {
    const started = Date.now();
    // Keep the initial pause generous. settle() is used after UI actions as well as saves, and
    // shortening it to 120ms was enough to make a panel-render test read an empty inspector.
    await wait(250);
    while (Date.now() - started < ms) {
      const pending = await js(`(() => {
        if (window.__cve && 'saving' in window.__cve) return window.__cve.saving;
        return /Unsaved/i.test(document.querySelector('#status')?.textContent || '');
      })()`).catch(() => false);
      if (!pending) { await wait(150); return; }
      await wait(100);
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
      // A thumbnail is either real image data or an honest null — never an empty data URL,
      // which the page would render as a broken-image icon.
      const shapes = sources.map(s => s.thumbnail === null ? 'none'
        : (s.thumbnail.startsWith('data:image/') && s.thumbnail.length > 128) ? 'image' : 'broken');
      return { count: sources.length, shapes: [...new Set(shapes)],
               names: sources.slice(0,2).map(s => s.name.slice(0,24)),
               denied: listed.screenCaptureDenied, perms };
    })()`, true);
    expect(r.count > 0, 'no capturable sources were found');
    expect(!r.shapes.includes('broken'),
      'a source came back with an unusable thumbnail — the picker would show a broken image');
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
      const t0 = Date.now();
      const set = await window.editor.transcribe.setKey('openai', 'sk-test-selftest-123');
      const saveMs = Date.now() - t0;
      const after = await window.editor.transcribe.engines();
      const cleared = await window.editor.transcribe.setKey('openai', '');
      const final = await window.editor.transcribe.engines();
      // the bridge must expose no way to read a key back
      const readable = Object.keys(window.editor.transcribe).filter(k => /get|read|key/i.test(k) && k !== 'setKey');
      return { set, saveMs, sawKey: after.openai, cleared, stillThere: final.openai, readable };
    })()`, true);
    expect(r.readable.length === 0, 'the bridge exposes a key getter: ' + r.readable.join(','));

    // A machine can legitimately refuse: an ad-hoc signed build whose signature changed since a
    // key was stored makes macOS hold the keychain indefinitely. What must never happen is the
    // app waiting with it, or a secret being written somewhere unencrypted as a consolation.
    expect(r.saveMs < 20000, `saving a key took ${r.saveMs}ms — the keychain call is not bounded`);
    if (r.set?.ok !== true) {
      expect(/keychain/i.test(r.set?.error || ''), 'saving failed for an unexplained reason: ' + r.set?.error);
      const settingsFile = join(app.getPath('userData'), 'settings.json');
      const raw = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '';
      expect(!raw.includes('sk-test-selftest-123'), 'the key was written in the clear after encryption failed!');
      return { refusedCleanly: true, error: r.set.error, saveMs: r.saveMs };
    }

    expect(r.sawKey === true, 'stored key was not detected');
    expect(r.stillThere === false, 'clearing the key did not work');
    return r;
  });

  await test('transcribe: the engine list reports a stored key without unlocking it', async () => {
    // The rule (presence must never decrypt) is enforced and proved in scripts/check-keys.mjs,
    // where safeStorage can be made to scream when touched. What this checks is that the real
    // app is wired to that rule: a key stored through the UI shows up in the panel, and the
    // panel opening does not hang — which is what a keychain dialog behind the window looks like.
    const r = await js(`(async () => {
      const saved = await window.editor.transcribe.setKey('openai', 'sk-selftest-presence');
      const t0 = Date.now();
      const listed = await window.editor.transcribe.engines();
      const ms = Date.now() - t0;                       // the part that must never touch the keychain
      await window.editor.transcribe.setKey('openai', '');
      const after = await window.editor.transcribe.engines();
      return { saved, present: listed.openai, cleared: after.openai, keychain: listed.keys?.keychain, ms };
    })()`, true);
    // Listing must be instant whether or not the key could be stored — that is the whole point.
    expect(r.ms < 3000, `listing engines took ${r.ms}ms — something blocked main (the keychain?)`);
    if (r.saved?.ok !== true) return { keychainRefused: r.saved?.error, listMs: r.ms };
    expect(r.present === true, 'a stored key was not reported as present');
    expect(r.cleared === false, 'clearing the key did not take effect');
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

  await test('captions: several can be selected together and moved with the keyboard', async () => {
    const cues = disk().captions?.cues || [];
    if (cues.length < 3) return { skipped: 'not enough cues in this project' };

    // Click the first, then shift-click the third: the range in between comes with it.
    await js(`(() => { const c = document.querySelectorAll('#laneCaps .cap'); c[0].click(); })()`);
    await wait(120);
    await js(`(() => { const c = document.querySelectorAll('#laneCaps .cap');
      c[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); })()`);
    await wait(200);
    const picked = await js(`(() => ({
      badge: document.querySelector('#selBadge').textContent,
      lit: document.querySelectorAll('#laneCaps .cap.multi').length,
    }))()`);
    expect(/3 captions/.test(picked.badge), `the inspector says "${picked.badge}", expected 3 captions`);
    expect(picked.lit >= 3, `${picked.lit} cues are lit up, expected at least 3`);

    const before = (disk().captions.cues || []).slice(0, 3).map((c) => c.overrides?.cy ?? disk().captions.defaults.cy);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
    await settle();
    const after = (disk().captions.cues || []).slice(0, 3).map((c) => c.overrides?.cy ?? disk().captions.defaults.cy);
    expect(after.every((v, i) => v === before[i] - 8),
      `arrow up should raise all three by 8: ${before.join(',')} → ${after.join(',')}`);

    // …and a cue that was NOT selected must not have moved.
    if (cues.length > 3) {
      const d = disk();
      const untouched = d.captions.cues[3].overrides?.cy;
      expect(untouched === undefined || untouched === before[0],
        'a caption that was not selected moved anyway');
    }

    // Size, and the marking that protects it from the agent later.
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true }))`);
    await settle();
    const d2 = disk();
    const sized = d2.captions.cues.slice(0, 3);
    expect(sized.every((c) => c.manual === true), 'hand-edited cues were not marked as such');

    // Put it back the way it was.
    const restore = disk();
    restore.captions.cues.slice(0, 4).forEach((c) => { delete c.overrides; delete c.manual; });
    await writeProject(restore);
    await settle();
    await js(`window.__cve.deselect ? window.__cve.deselect() : document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    return { selected: picked.lit, movedBy: before[0] - after[0] };
  });

  await test('guard: an edit made by hand is missed when it disappears', async () => {
    // The promise this makes to the user is that the agent cannot quietly drop something they
    // did themselves. Prove it by doing exactly that and checking it is caught.
    const p = disk();
    const kept = p.cuts || [];
    p.cuts = [...kept, { id: 'guard-test', start: at(0.55), end: at(0.62), manual: true }];
    await writeProject(p);
    await settle();

    const snap = await js(`(async () => await window.editor.guard.snapshot())()`, true);
    expect(snap.count >= 1, `nothing was recorded to protect (count ${snap.count})`);

    // Now be the agent, and lose it.
    const wrecked = disk();
    wrecked.cuts = (wrecked.cuts || []).filter((c) => c.id !== 'guard-test');
    await writeProject(wrecked);
    await settle();

    const check = await js(`(async () => await window.editor.guard.check())()`, true);
    expect((check.missing || []).length === 1,
      `losing a hand-made cut was not noticed (${JSON.stringify(check.missing)})`);
    expect(check.missing[0].kind === 'cuts', 'it was reported as the wrong kind');

    const back = await js(`(async () => await window.editor.guard.restore())()`, true);
    expect(back.restored >= 1, 'restoring put nothing back');
    const after = disk();
    expect((after.cuts || []).some((c) => c.id === 'guard-test'), 'the cut was not actually restored');
    const clean = await js(`(async () => await window.editor.guard.check())()`, true);
    expect((clean.missing || []).length === 0, 'still reported as missing after restoring it');

    const final = disk();
    final.cuts = kept;
    await writeProject(final);
    await settle();
    return { recorded: snap.count, noticed: 1, restored: back.restored };
  });

  await test('cuts: a model reading the transcript adds suggestions, unticked and reasoned', async () => {
    // A fake OpenAI-compatible endpoint, so the whole path is exercised with no key, no network
    // and no bill. What is being tested is the wiring and the guardrails, not the model.
    // The fixture transcript is a single sentence, which the planner correctly declines to spend
    // a request on. Give it something with structure, and put it back afterwards.
    const tPath = join(settings.work, 'transcript.json');
    const tBackup = existsSync(tPath) ? readFileSync(tPath, 'utf8') : null;
    const spoken = ['this is the first thing.', 'and here is a false start.',
                    'let me try that again.', 'the actual explanation goes here.',
                    'one more point to make.', 'that is everything, thanks.'];
    const madeWords = [];
    let clock = 0.1;
    for (const line of spoken) {
      for (const word of line.split(' ')) {
        madeWords.push({ text: word, start: +clock.toFixed(2), end: +(clock + 0.18).toFixed(2) });
        clock += 0.22;
      }
      clock += 0.05;                      // sentences end on a full stop, not only on a pause
    }
    writeFileSync(tPath, JSON.stringify(madeWords));

    let asked = null;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.url.endsWith('/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'fake' }] }));
        }
        asked = JSON.parse(body || '{}');
        // Ask for the second sentence, plus one segment that does not exist — the invented one
        // must be dropped rather than becoming a cut somewhere arbitrary.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: {
          content: '{"cuts":[{"from":2,"to":2,"reason":"abandoned take","confidence":"high"},'
                 + '{"from":99,"to":99,"reason":"invented","confidence":"high"}]}' } }] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/v1`;

    try {
      await js(`(async () => await window.editor.llm.set({ baseUrl: '${base}', model: 'fake' }))()`, true);
      const st = await js(`(async () => await window.editor.llm.status())()`, true);
      expect(st.model === 'fake', 'the endpoint was not saved: ' + JSON.stringify(st));

      const plain = await js(`(async () => await window.editor.autoCut({ ai: false }))()`, true);
      const read = await js(`(async () => await window.editor.autoCut({ ai: true }))()`, true);
      expect(!read.error, 'auto-cut with reading failed: ' + read.error);
      expect(asked, 'the endpoint was never asked anything');
      expect(/segment number/i.test(asked.messages?.[0]?.content || ''),
        'the model was not told what shape to answer in');

      const ai = (read.proposals || []).filter((p) => p.reason === 'ai');
      expect(ai.length >= 1, `reading the transcript added nothing (${read.proposals.length} proposals total)`);
      expect(ai.length === 1, `an invented segment number became a cut (${ai.length} ai cuts)`);
      expect(/abandoned take/.test(ai[0].label || ''), 'the reason was not carried through: ' + ai[0].label);

      // It may only ever add. Losing a measured silence to an opinion would be the worst outcome.
      const acoustic = (read.proposals || []).filter((p) => p.reason !== 'ai');
      expect(acoustic.length === (plain.proposals || []).length,
        `reading changed the acoustic proposals: ${(plain.proposals || []).length} → ${acoustic.length}`);

      // And every suggestion has to sit on real word boundaries, never inside a word.
      const onBoundary = (t) => madeWords.some((w) => Math.abs(w.start - t) < 0.02 || Math.abs(w.end - t) < 0.02);
      expect(onBoundary(ai[0].start) && onBoundary(ai[0].end),
        `a suggested cut clips a word: ${ai[0].start}–${ai[0].end}`);

      return { aiCuts: ai.length, acoustic: acoustic.length, label: ai[0].label };
    } finally {
      server.close();
      await js(`(async () => await window.editor.llm.set({ baseUrl: '', model: '' }))()`, true);
      if (tBackup != null) writeFileSync(tPath, tBackup);
    }
  });

  await test('preview: a cut is skipped as you play, without waiting for a render', async () => {
    // The complaint this answers: accept an auto-cut, the timeline redraws, and the player keeps
    // playing the removed seconds. A cut needs no render to be honoured — it is a span the
    // player can skip — so it must work the moment the cut exists.
    const p = disk();
    const before = p.cuts || [];
    p.cuts = [{ start: at(0.30), end: at(0.45) }];
    await writeProject(p);
    await settle();

    const removed = await js(`window.__cve.preview.removed`);
    expect(Math.abs(removed - (at(0.45) - at(0.30))) < 0.05,
      `the player thinks ${removed}s was removed, expected ${(at(0.45) - at(0.30)).toFixed(2)}s`);

    // Land inside the cut and let a frame or two go by.
    await js(`window.__cve.seek(${at(0.35)})`);
    await wait(400);
    const landed = await js(`window.__cve.now()`);
    expect(landed >= at(0.45) - 0.05,
      `the playhead sat at ${landed.toFixed(2)}s, inside a cut that ends at ${at(0.45).toFixed(2)}s`);

    // …and a moment outside the cut is left exactly where it was.
    await js(`window.__cve.seek(${at(0.6)})`);
    await wait(250);
    const kept = await js(`window.__cve.now()`);
    expect(Math.abs(kept - at(0.6)) < 0.15, `a moment outside the cut moved: ${kept} vs ${at(0.6)}`);

    p.cuts = before;
    await writeProject(p);
    await settle();
    return { removed: +removed.toFixed(2), skippedTo: +landed.toFixed(2) };
  });

  await test('preview: an edit marks the preview out of date rather than letting it lie', async () => {
    // The failure this guards against is the quiet one: you change the edit, the player carries
    // on showing the previous render, and nothing says the two have parted company.
    const states = new Set();
    await js(`(() => { window.__cve.previewProbe = []; })()`);
    const p = disk();
    p.zooms = [...(p.zooms || []), { id: 'pv' + Date.now(), start: at(0.5), dur: 1, scale: 1.2, x: 0.5, y: 0.5 }];
    await writeProject(p);
    await settle();
    const after = await js(`window.__cve.preview`);
    states.add(after.state);
    expect(after.state !== 'live',
      `after an edit the player still claims the preview is current (${after.state})`);
    expect(['none', 'stale', 'building', 'failed'].includes(after.state), 'unknown preview state: ' + after.state);
    // Auto rebuilding is off under the harness, so nothing should be rendering in the background.
    expect(after.auto === false, 'the test run is spawning preview renders');

    p.zooms = (p.zooms || []).filter((z) => !String(z.id).startsWith('pv'));
    await writeProject(p);
    await settle();
    return { state: after.state, auto: after.auto };
  });

  await test('agent: the picker lists what is installed and greys out the rest', async () => {
    await js(`document.querySelector('#btnAgentPick').click()`);
    await wait(500);
    const seen = await js(`(() => ({
      rows: document.querySelectorAll('.agent-row').length,
      disabled: document.querySelectorAll('.agent-row:disabled').length,
      selected: document.querySelector('.agent-row.sel .ag-name')?.textContent || null,
      label: document.querySelector('#btnAgentPick').textContent,
      installHints: document.querySelectorAll('.agent-row.off .ag-install').length,
    }))()`);
    expect(seen.rows >= 4, `the picker listed ${seen.rows} agents`);
    // Claude Code is the default and is what this machine builds against, so it must be usable.
    expect(seen.selected === 'Claude Code', `selected agent is ${seen.selected}, expected Claude Code`);
    expect(/Claude Code/.test(seen.label), 'the header button does not name the agent in use');
    // Whatever is greyed out must say how to get it — a dead end is worse than no option.
    expect(seen.disabled === seen.installHints,
      `${seen.disabled} agents are unavailable but ${seen.installHints} say how to install`);
    return seen;
  });

  await test('agent: choosing another agent writes the file that agent reads', async () => {
    const before = readFileSync(join(settings.work, 'CLAUDE.md'), 'utf8');
    const agents = await js(`(async () => (await window.editor.agents.list()).agents)()`, true);
    const other = (agents || []).find((a) => a.available && a.id !== 'claude');
    if (!other) return { skipped: 'no second agent installed on this machine' };

    await js(`(async () => { await window.editor.agents.set('${other.id}'); })()`, true);
    await settle();
    // The brief must land in the file the chosen agent opens by itself, or it starts up blind.
    const doc = join(settings.work, other.doc);
    expect(existsSync(doc), `${other.doc} was not written after choosing ${other.name}`);
    expect(readFileSync(doc, 'utf8') === before, `${other.doc} does not carry the same brief`);
    // and the launch line is the agent's own, not Claude's
    const launch = await js(`(async () => (await window.editor.agents.launch()))()`, true);
    expect(launch.command.startsWith(other.bin), `launch command was ${launch.command}`);
    expect(launch.kickoff.includes(other.doc), `kickoff points at the wrong file: ${launch.kickoff}`);

    await js(`(async () => { await window.editor.agents.set('claude'); })()`, true);
    await settle();
    return { switchedTo: other.id, doc: other.doc, command: launch.command };
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
    // Wait for the window to pick the change up. Without this the click below can land before
    // the suggestions exist in the page, the panel silently declines to open, and every query
    // after it reads whichever panel happened to be open already.
    await settle();

    await js(`document.querySelector('#btnZoomSuggest').click()`);
    await wait(400);
    // `.ac-item` is the review-row class shared by auto-cut, sound and this panel, so scope every
    // query to the inspector AND check which panel is in it. Not doing that is how this test
    // spent a while counting the auto-cut panel's rows and clicking its button.
    const panel = await js(`(() => ({
      badge: document.querySelector('#selBadge').textContent,
      rows: document.querySelectorAll('#inspector .ac-item').length,
      ticked: [...document.querySelectorAll('#inspector .ac-item input')].filter(c => c.checked).length,
    }))()`);
    expect(panel.badge === 'zoom suggestions',
      `the zoom review panel did not open — the inspector is showing "${panel.badge}"`);
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
    const second = await js(`document.querySelectorAll('#inspector .ac-item').length`);
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


  // ---------------------------------------------------------------- framing
  await test('framing: + adds a move to the corner and the inspector drives it', async () => {
    const before = (disk().frames || []).length;
    await js(`(() => { document.querySelector('#video').currentTime = ${at(0.3)};
      document.querySelector('[data-add="frame"]').click(); })()`);
    await settle();
    const added = disk().frames || [];
    expect(added.length === before + 1, `+ did not add a framing move (${before} → ${added.length})`);
    const f = added[added.length - 1];
    // the default has to be the thing people actually want, not an empty form
    expect(f.to === 'corner' && f.shape === 'circle' && f.corner === 'br',
      'the default move is not "shrink to a circle in the bottom-right": ' + JSON.stringify(f));

    // drive it through the real controls: side, then left, then a blurred backdrop
    const clicked = await js(`(() => {
      const hit = (label) => { const b = [...document.querySelectorAll('#inspector button')]
        .find(x => x.textContent === label); if (b) { b.click(); return true; } return false; };
      return { side: hit('To the side') };
    })()`);
    expect(clicked.side, 'the inspector offers no "To the side" control');
    await settle();
    expect((disk().frames || []).slice(-1)[0].to === 'side', 'switching to the side did not persist');

    await js(`(() => { const b = [...document.querySelectorAll('#inspector button')]
      .find(x => x.textContent === 'Left'); b && b.click(); })()`);
    await settle();
    expect((disk().frames || []).slice(-1)[0].side === 'left', 'choosing the left side did not persist');

    await js(`(() => { const b = [...document.querySelectorAll('#inspector button')]
      .find(x => x.textContent === 'Blurred frame'); b && b.click(); })()`);
    await settle();
    expect((disk().frames || []).slice(-1)[0].backdrop === 'blur', 'choosing a backdrop did not persist');

    // and it must come off the timeline again
    await js(`document.querySelector('#laneFrames .clip.frame').click()`);
    await wait(200);
    await js(`[...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Delete')?.click()`);
    await settle();
    expect((disk().frames || []).length === before, 'deleting the framing move did not remove it');
    return { defaulted: f.to + '/' + f.shape + '/' + f.corner };
  });

  await test('framing: the corner picker sets the corner it points at', async () => {
    await js(`(() => { document.querySelector('#video').currentTime = ${at(0.2)};
      document.querySelector('[data-add="frame"]').click(); })()`);
    await settle();
    const picked = await js(`(() => {
      const cells = [...document.querySelectorAll('.corner-cell')];
      if (cells.length !== 4) return null;
      cells[0].click();                                  // top-left
      return cells.map(c => c.title);
    })()`);
    expect(picked && picked.join(',') === 'TL,TR,BL,BR', 'the corner picker is not a 2x2 of corners: ' + picked);
    await settle();
    expect((disk().frames || []).slice(-1)[0].corner === 'tl', 'the corner picker did not set the corner');

    await js(`document.querySelector('#laneFrames .clip.frame').click()`);
    await wait(200);
    await js(`[...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Delete')?.click()`);
    await settle();
    return { corners: picked };
  });

  await test('framing: seven lanes, still aligned and nothing clipped', async () => {
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
    expect(r.ids.includes('laneFrames'), 'there is no Framing lane');
    expect(!r.clipped.length, 'lanes fall outside the timeline panel: ' + r.clipped.join(', '));
    expect(!r.misaligned.length, 'lanes do not line up with their headers: ' + r.misaligned.join(', '));
    return r;
  });


  // ---------------------------------------------------------------- preprocess
  await test('prepare: one action transcribes, cuts, frames and applies the pack', async () => {
    const before = disk();
    const r = await js(`(async () => {
      const events = [];
      const off = window.editor.prepare.onEvent(e => events.push(e));
      const started = await window.editor.prepare.start({ template: 'coral-ink-bone',
        options: { transcribe: false } });
      if (started?.error) { off(); return { error: started.error }; }
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
        }, 300);
        setTimeout(() => { clearInterval(iv); res({ type: 'timeout' }); }, 240000);
      });
      off();
      return { done, stages: [...new Set(events.filter(e => e.type === 'progress').map(e => e.stage))] };
    })()`, true);
    expect(!r.error, 'prepare refused to start: ' + r.error);
    expect(r.done?.type === 'done', 'prepare did not finish: ' + JSON.stringify(r.done).slice(0, 200));
    expect(r.stages.includes('cuts'), 'prepare never looked for cuts: ' + r.stages.join(','));

    await settle();
    const after = disk();
    // it must show its working — a decision with no reason is not reviewable
    expect(Array.isArray(r.done.did), 'prepare reported no decisions');
    expect(after.meta?.preparedAt, 'prepare did not record that it ran');
    expect(after.grade?.look?.preset, 'the pack’s grade was not applied');
    expect(after.audio?.polish, 'the pack’s audio polish was not applied');
    // and it must never quietly bin the doubtful ones
    expect(after.proposals, 'prepare kept no record of what it did not do');
    return { did: r.done.did, cuts: r.done.cuts, stages: r.stages };
  });

  await test('prepare: panels are sized to what they say, with the reason recorded', async () => {
    const p = disk();
    p.scenes = [
      { id: 'short', type: 'pills', start: at(0.15), dur: 9, headline: 'WHY', items: [{ text: 'ONE' }] },
      { id: 'wordy', type: 'pills', start: at(0.55), dur: 1,
        headline: 'THE THREE REASONS THIS MATTERS MORE THAN YOU MIGHT THINK',
        items: [{ text: 'PRIVACY BY DEFAULT' }, { text: 'CONTROL OF YOUR OWN DATA' }, { text: 'COST OVER TIME' }] },
    ];
    await writeProject(p);

    const r = await js(`(async () => {
      const events = [];
      const off = window.editor.prepare.onEvent(e => events.push(e));
      await window.editor.prepare.start({ options: { transcribe: false, cuts: false } });
      const done = await new Promise(res => {
        const iv = setInterval(() => {
          const d = events.find(e => e.type === 'done' || e.type === 'error');
          if (d) { clearInterval(iv); res(d); }
        }, 300);
        setTimeout(() => { clearInterval(iv); res({ type: 'timeout' }); }, 120000);
      });
      off(); return done;
    })()`, true);
    expect(r?.type === 'done', 'prepare did not finish: ' + JSON.stringify(r).slice(0, 160));

    await settle();
    const scenes = disk().scenes;
    const short = scenes.find((s) => s.id === 'short'), wordy = scenes.find((s) => s.id === 'wordy');
    expect(short.durWhy && wordy.durWhy, 'no reason was recorded for the durations chosen');
    expect(wordy.dur > short.dur,
      `a panel with four times the text is not on screen longer (${wordy.dur}s vs ${short.dur}s)`);
    expect(short.dur < 9, `a three-word panel kept its arbitrary 9s (${short.dur}s)`);
    return { short: [short.dur, short.durWhy], wordy: [wordy.dur, wordy.durWhy] };
  });


  await test('check: the verifier finds what a render would silently drop', async () => {
    const p = disk();
    const keepScenes = p.scenes;
    // plant one fault of each kind the engine punishes silently
    p.cuts = [...(p.cuts || []), { start: at(0.5), end: at(0.6) }];
    p.scenes = [{ id: 'straddler', type: 'pills', start: at(0.48), dur: at(0.2),
                  headline: 'DROPPED', items: [] }];
    p.zooms = [{ id: 'badz', start: at(0.1), dur: 1, scale: 1.3, x: 2.5, y: 0.5 }];
    await writeProject(p);

    const bad = await js(`window.editor.verify()`, true);
    expect(bad && !bad.error, 'the verifier would not run: ' + bad?.error);
    expect(bad.ok === false, 'a project with a scene inside a cut was reported as fine');
    const kinds = bad.issues.map((i) => i.what.toLowerCase()).join(' | ');
    expect(/straddles a cut/.test(kinds), 'it missed the scene the render would drop: ' + kinds);
    expect(/not between 0 and 1/.test(kinds), 'it missed the zoom centre written in pixels: ' + kinds);
    expect(bad.issues.every((i) => i.fix && i.fix.length > 8),
      'an issue says what is wrong but not what to do about it');

    // the panel must show them, not just the count
    await js(`document.querySelector('#btnVerify').click()`);
    await wait(700);
    const shown = await js(`(() => ({ badge: document.querySelector('#selBadge').textContent,
      rows: document.querySelectorAll('#inspector .ac-item').length }))()`);
    expect(shown.badge === 'check' && shown.rows >= 2,
      'the check panel did not list the problems: ' + JSON.stringify(shown));

    // Put the planted faults back and confirm they are gone. Not "zero issues": earlier tests
    // leave their own cuts and scenes in this workspace, and some of those genuinely do clash —
    // asserting a clean bill of health here would be asserting something untrue.
    p.cuts = (p.cuts || []).filter((c) => c.start !== at(0.5));
    p.scenes = keepScenes; delete p.zooms;
    await writeProject(p);
    const good = await js(`window.editor.verify()`, true);
    const still = good.issues.map((i) => `${i.what} ${i.detail}`).join(' | ');
    expect(!/straddler/.test(still), 'the straddling scene is still reported after being removed');
    expect(!/badz|not between 0 and 1/.test(still), 'the bad zoom is still reported after being removed');
    return { caught: bad.errors, warnings: bad.warnings, rows: shown.rows, leftOver: good.errors };
  });


  // ---------------------------------------------------------------- sound
  await test('sound: saving an ElevenLabs key wires the MCP server without writing the key down', async () => {
    const mcpFile = join(settings.work, '.mcp.json');
    const before = existsSync(mcpFile) ? readFileSync(mcpFile, 'utf8') : null;

    const saved = await js(`window.editor.transcribe.setKey('elevenlabs', 'sk-selftest-elevenlabs-key')`, true);
    await wait(600);
    if (saved?.ok !== true) {
      // an OS that will not answer for the keychain is not this test's business
      expect(/keychain/i.test(saved?.error || ''), 'saving failed for an unexplained reason: ' + saved?.error);
      return { keychainRefused: saved.error };
    }

    expect(existsSync(mcpFile), 'saving the key did not write .mcp.json');
    const doc = JSON.parse(readFileSync(mcpFile, 'utf8'));
    const entry = doc.mcpServers?.elevenlabs;
    expect(entry, '.mcp.json has no elevenlabs server: ' + JSON.stringify(doc).slice(0, 160));
    expect(entry.command === 'uvx' && entry.args?.includes('elevenlabs-mcp'),
      'the server entry does not run the ElevenLabs MCP: ' + JSON.stringify(entry));

    // The point of the env-var indirection: a project folder gets zipped, synced and sometimes
    // committed. The key must not be in it.
    const raw = readFileSync(mcpFile, 'utf8');
    expect(!raw.includes('sk-selftest-elevenlabs-key'), 'THE KEY WAS WRITTEN INTO .mcp.json');
    expect(/\$\{ELEVENLABS_API_KEY\}/.test(raw), '.mcp.json does not reference the environment variable');

    const status = await js(`window.editor.integrationStatus('elevenlabs')`, true);
    expect(status.registered === true && status.hasKey === true,
      'the app does not report the integration as wired: ' + JSON.stringify(status));
    expect(Array.isArray(status.tools) && status.tools.includes('text_to_sound_effects'),
      'the status does not say what the agent gains: ' + JSON.stringify(status.tools));

    // clearing takes it away again, and leaves nothing behind
    await js(`window.editor.transcribe.setKey('elevenlabs', '')`);
    await wait(600);
    const after = existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, 'utf8')) : null;
    expect(!after?.mcpServers?.elevenlabs, 'clearing the key left the MCP server behind');

    if (before !== null) writeFileSync(mcpFile, before);
    return { tools: status.tools.length, uvx: status.toolPath ? 'found' : 'missing' };
  });

  await test('sound: the panel offers effects, music and voice without a blocking dialog', async () => {
    const r = await js(`(() => {
      document.querySelector('[data-gen]').click();
      const buttons = [...document.querySelectorAll('#inspector button')].map(b => b.textContent);
      return { badge: document.querySelector('#selBadge').textContent, buttons,
               hasInput: !!document.querySelector('#inspector input') };
    })()`);
    expect(r.badge === 'sound', 'the sound panel did not open: ' + r.badge);
    expect(r.buttons.includes('Effect') && r.buttons.includes('Music bed') && r.buttons.includes('Voiceover'),
      'the panel does not offer the three kinds: ' + r.buttons.join(','));
    expect(r.buttons.includes('Generate'), 'there is no way to generate anything');
    expect(r.buttons.some((b) => /Claude/.test(b)), 'the panel does not offer to hand it to the agent');
    expect(r.hasInput, 'there is nowhere to describe the sound');

    // switching kind must change what it asks for, not just the label
    const music = await js(`(() => {
      [...document.querySelectorAll('#inspector button')].find(b => b.textContent === 'Music bed').click();
      const f = [...document.querySelectorAll('#inspector .field label')].map(l => l.textContent);
      return { fields: f, hint: document.querySelector('#inspector .hint')?.textContent || '' };
    })()`);
    expect(music.fields.some((f) => /music/i.test(f)), 'choosing music did not change the question: ' + music.fields);
    expect(/duck/i.test(music.hint), 'the panel never mentions that music ducks under the voice');
    return { buttons: r.buttons.length };
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
    // Copy the path NOW. `settings` is main's live object: opening another project rewrites
    // settings.work, so restoring "to settings.work" would restore to the temp project and the
    // assertion would compare it with itself and pass — leaving every later phase pointed at a
    // directory this test then deletes. That is exactly what it did.
    const home = String(settings.work);
    const other = join(mkdtempSync(join(tmpdir(), 'cve-switch-')), 'other_project');
    cpSync(home, other, { recursive: true });
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
    for (let attempt = 0; attempt < 3 && back?.work !== home; attempt++) {
      await js(`(async () => { const r = await window.editor.openWorkspace(${JSON.stringify(home)});
        if (r?.ok) await window.editor.reload(); })()`).catch(() => {});
      for (let i = 0; i < 40; i++) {
        await wait(500);
        try {
          back = await js(`(async () => ({ work: (await window.editor.config()).work,
            ready: !!window.__cve.project }))()`);
          if (back?.ready && back.work === home) break;
        } catch { /* mid-reload */ }
      }
    }
    expect(back?.work === home, `could not switch back to ${home} (still on ${back?.work})`);
    try { rmSync(dirname(other), { recursive: true, force: true }); } catch {}
    return { from: home, to: other, scenesAfter: after?.scenes, restored: back.work };
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
