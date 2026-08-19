// Cutright — renderer.
// Runs sandboxed (no Node, no network). Everything that touches disk, ffmpeg or a shell
// goes through `window.editor`, the narrow contextBridge API in electron/preload.cjs.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const E = window.editor;

let project = null, dur = 1, fps = 30, sel = null, WORK = '', job = null;
let zoom = 10;                 // pixels per second
const MIN_ZOOM = 0.2, MAX_ZOOM = 400;
const video = $('#video');

// debug surface for the in-app tests (page data only)
window.__cve = {
  get project() { return project; }, get status() { return $('#status').textContent; },
  get zoom() { return zoom; }, get tx() { return { sel: tx.sel, open: tx.open, words: tx.words.length }; },
  get sel() { return sel; }, reloads: 0,
  loadVideo: (n, s) => loadVideo(n, s), termLog: '',
};

// ---------------------------------------------------------------- boot
async function boot() {
  const cfg = await E.config();
  WORK = cfg.work;
  $('#work').textContent = cfg.work ? cfg.work.replace(/^.*\//, '') : 'no project';
  $('#btnWorkspace').title = cfg.work || 'Choose a project';
  initNewProject();

  // No project yet → home is the whole app. With one, home sits on top until dismissed,
  // so opening the app never dumps you into an edit you did not ask for.
  if (!cfg.hasWorkspace) { await showHome(); initTerminal(); return; }
  if (!cfg.skipHome) await showHome();

  await loadProject();
  loadPreferredVideo();
  initTerminal();
  initSplitters();
  initKeys();
  initTimelineInteraction();
  checkEnv();

  window.addEventListener('resize', () => { renderTimeline(); });
  requestAnimationFrame(tick);
  E.onProjectChanged(reloadIfChanged);
  E.onWorkspaceChanged(async (w) => {
    WORK = w; $('#work').textContent = w.replace(/^.*\//, ''); sel = null;
    await loadProject(); loadPreferredVideo();
  });
  initTour();
  $('#btnHome').onclick = () => showHome();
  $('#btnRecord').onclick = () => E.openRecorder();
  $('#btnWorkspace').onclick = () => openProjectMenu();
}

// The header chip is the project switcher: new, open, recent, reveal in Finder.
async function openProjectMenu() {
  const cfg = await E.config();
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'project';
  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'project';
  title.append(kind);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const cur = document.createElement('div'); cur.className = 'ac-summary';
  cur.textContent = cfg.work || 'no folder open';
  box.appendChild(cur);

  box.appendChild(btnRow(
    btn('Home', () => showHome()),
    btn('Start from a video…', () => openNewProject(), 'primary'),
    btn('Open another project…', () => E.chooseWorkspace().then((r) => r?.ok && E.reload())),
    btn('Reveal in Finder', () => E.revealInFolder('project.json')),
  ));

  if ((cfg.recent || []).length > 1) {
    box.appendChild(sep());
    box.appendChild(sechead('Recent projects'));
    const list = document.createElement('div'); list.className = 'wrecent';
    cfg.recent.filter((d) => d !== cfg.work).forEach((dir) => {
      const b = btn(dir.replace(/^.*\//, '') + '  —  ' + dir, async () => {
        const r = await E.openWorkspace(dir);
        if (r?.ok) E.reload(); else setStatus(r?.error || 'could not open that folder', 'error');
      });
      list.appendChild(b);
    });
    box.appendChild(list);
  }
  box.appendChild(hint('A project is just a folder. Everything the editor knows about your video lives in project.json inside it.'));
}

function showWelcome(cfg) {
  $('#welcome').hidden = false;
  $('#wNew').onclick = () => openNewProject();
  $('#wOpen').onclick = () => E.chooseWorkspace().then((r) => r?.ok && E.reload());
  const box = $('#wRecent'); box.innerHTML = '';
  (cfg.recent || []).forEach((dir) => {
    const b = document.createElement('button');
    b.textContent = dir;
    b.onclick = () => E.openWorkspace(dir).then((r) => r?.ok && E.reload());
    box.appendChild(b);
  });
}

async function loadProject() {
  project = await E.getProject();
  if (project.error) { setStatus(project.error, 'error'); project = null; return; }
  dur = project.meta.duration || 1;
  fps = project.meta.fps || 30;
  $('#tcDur').textContent = fmt(dur);
  fitZoom();
  renderTimeline();
  renderInspector();
}

async function reloadIfChanged() {
  if (Date.now() - lastEdit < 3000) return;         // don't clobber a fresh local edit
  const p = await E.getProject();
  if (p.error || JSON.stringify(p) === JSON.stringify(project)) return;
  project = p; dur = p.meta.duration || 1; fps = p.meta.fps || 30;
  window.__cve.reloads++;
  $('#tcDur').textContent = fmt(dur);
  renderTimeline(); renderInspector();
  setStatus('Project reloaded — edited on disk', 'ok');
}

// A project only has FINAL.mp4 after its first export; before that the graded master is
// the thing to show. Falling back keeps a brand-new project from opening on a dead player.
async function loadPreferredVideo() {
  const master = project?.meta?.graded || 'graded_master.mp4';
  const candidates = ['FINAL.mp4', master];
  for (const name of candidates) {
    if (await E.mediaExists(name)) { loadVideo(name); return; }
  }
  loadVideo(master);
}

function loadVideo(name, seek) {
  $('#previewTag').textContent = name;
  video.src = E.mediaUrl(WORK + '/' + name, true);
  if (seek != null) video.addEventListener('loadedmetadata', () => { video.currentTime = seek; }, { once: true });
}

function setStatus(t, kind) {
  const el = $('#status');
  el.textContent = t || 'Ready';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

// The app does not bundle ffmpeg (Apache-2.0), so missing tools must be loud and early.
async function checkEnv() {
  const env = await E.checkEnvironment();
  window.__cve.env = env;
  const bar = $('#envbar');
  if (env.ok) { bar.hidden = true; $('main').classList.remove('has-envbar'); return; }
  bar.hidden = false; $('main').classList.add('has-envbar');
  bar.textContent = 'Missing: ' + env.missing.map((m) => `${m.tool} — ${m.hint}`).join('   ·   ');
}

// ---------------------------------------------------------------- timeline
const t2x = (t) => t * zoom;
const x2t = (x) => x / zoom;
const laneWidth = () => Math.max($('#tlScroll').clientWidth, dur * zoom);

function fitZoom() {
  const w = $('#tlScroll').clientWidth || 900;
  zoom = clamp((w - 8) / Math.max(dur, 0.1), MIN_ZOOM, MAX_ZOOM);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function setZoom(next, anchorClientX) {
  const scroll = $('#tlScroll');
  const rect = scroll.getBoundingClientRect();
  const anchorX = anchorClientX == null ? rect.width / 2 : anchorClientX - rect.left;
  const tAtAnchor = x2t(scroll.scrollLeft + anchorX);
  zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
  renderTimeline();
  scroll.scrollLeft = Math.max(0, t2x(tAtAnchor) - anchorX);
}

// nice ruler steps, chosen so labels never collide
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
function rulerStep() {
  const minPx = 68;
  return STEPS.find((s) => s * zoom >= minPx) || STEPS[STEPS.length - 1];
}

function renderTimeline() {
  if (!project) return;
  const W = laneWidth();
  $('#tlInner').style.width = W + 'px';

  // ruler
  const r = $('#ruler'); r.innerHTML = '';
  const step = rulerStep();
  for (let t = 0; t <= dur + 0.001; t += step) {
    const d = document.createElement('div');
    d.className = 'tick'; d.style.left = t2x(t) + 'px';
    d.textContent = step < 1 ? t.toFixed(1) + 's' : fmt(t);
    r.appendChild(d);
  }

  // scenes
  fillLane('#laneScenes', (project.scenes || []).map((s, i) => ({
    i, start: s.start, dur: s.dur, cls: 'clip scene ' + (s.type || ''),
    label: s.headline || s.type, title: `${s.type} · ${fmt(s.start)} → ${fmt(s.start + s.dur)}`,
  })), 'scene');

  // overlays
  fillLane('#laneOverlays', (project.overlays || []).map((o, i) => ({
    i, start: o.start || 0, dur: o.dur || 3, cls: 'clip overlay' + (o.enabled === false ? ' disabled' : ''),
    label: (o.src || '').split('/').pop(), title: `${o.src} · ${fmt(o.start || 0)}`,
  })), 'overlay');

  // captions — blocks with text when zoomed in, thin ticks when zoomed out
  const lc = $('#laneCaps'); lc.innerHTML = '';
  const cues = project.captions?.cues || [];
  const wide = zoom > 20;
  const frag = document.createDocumentFragment();
  let lastX = -99;
  cues.forEach((c, i) => {
    const x = t2x(c.start), w = Math.max(wide ? 14 : 2, t2x((c.end || c.start + 0.4) - c.start));
    if (!wide && x - lastX < 1.2 && !(sel?.kind === 'caption' && sel.index === i)) return;  // don't stack ticks
    lastX = x;
    const el = document.createElement('div');
    el.className = 'cap' + (c.tokens?.some((t) => t.e) ? ' emph' : '') + (wide ? ' wide' : '');
    el.style.left = x + 'px'; el.style.width = w + 'px';
    if (wide) el.textContent = (c.tokens || []).map((t) => t.t).join(' ');
    el.title = (c.tokens || []).map((t) => t.t).join(' ') + ` · ${fmt(c.start)}`;
    if (sel?.kind === 'caption' && sel.index === i) el.classList.add('selected');
    el.onclick = (ev) => { ev.stopPropagation(); select('caption', i); };
    frag.appendChild(el);
  });
  lc.appendChild(frag);

  // cuts
  fillLane('#laneCuts', (project.cuts || []).map((c, i) => ({
    i, start: c.start, dur: Math.max(0.05, c.end - c.start), cls: 'clip cut', minW: 46,
    label: `−${(c.end - c.start).toFixed(1)}s`, title: `cut ${fmt(c.start)} → ${fmt(c.end)} (removed on export)`,
  })), 'cut');

  // framing — where the picture goes and what shape it takes
  const FRAME_LABEL = (f) => f.to === 'full' ? 'full frame'
    : f.to === 'side' ? `side ${f.side || 'right'}`
    : `${f.shape || 'circle'} ${(f.corner || 'br').toUpperCase()}`;
  fillLane('#laneFrames', (project.frames || []).map((f, i) => ({
    i, start: f.start, dur: Math.max(0.3, f.dur || 0.8), cls: 'clip frame', minW: 92,
    label: FRAME_LABEL(f),
    title: `${FRAME_LABEL(f)} · moves over ${(f.dur || 0.8).toFixed(1)}s from ${fmt(f.start)}`
         + (f.to === 'full' ? '' : ` · ${Math.round((f.size || 0.26) * 100)}% of the width`),
  })), 'frame');

  // zooms — a push-in is a scale plus a centre, so show both at a glance
  fillLane('#laneZooms', (project.zooms || []).map((z, i) => ({
    i, start: z.start, dur: Math.max(0.2, z.dur || 1), cls: 'clip zoom', minW: 44,
    label: `${(z.scale || 1.3).toFixed(2)}×`,
    title: `zoom ${(z.scale || 1.3).toFixed(2)}× on (${(z.x ?? 0.5).toFixed(2)}, ${(z.y ?? 0.5).toFixed(2)})`
         + ` · ${fmt(z.start)} → ${fmt(z.start + (z.dur || 1))}${z.source ? ' · ' + z.source : ''}`,
  })), 'zoom');

  // audio (music + sfx share one lane, tagged)
  const la = $('#laneAudio'); la.innerHTML = '';
  const audio = project.audio || {};
  [['music', audio.music], ['sfx', audio.sfx]].forEach(([kind, arr]) => (arr || []).forEach((L, i) => {
    const el = document.createElement('div');
    el.className = 'clip audio';
    el.style.left = t2x(L.start || 0) + 'px';
    el.style.width = Math.max(16, t2x(L.dur || 3)) + 'px';
    el.textContent = (kind === 'music' ? '♪ ' : '✳ ') + ((L.src || '').split('/').pop() || 'empty');
    el.title = `${kind} · ${L.src || 'no source'} · ${fmt(L.start || 0)}`;
    if (sel?.kind === kind && sel.index === i) el.classList.add('selected');
    el.onclick = (ev) => { ev.stopPropagation(); select(kind, i); };
    la.appendChild(el);
  }));

  positionPlayhead();
}

function fillLane(laneSel, items, kind) {
  const lane = $(laneSel); lane.innerHTML = '';
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = it.cls;
    el.style.left = t2x(it.start) + 'px';
    el.style.width = Math.max(it.minW || 10, t2x(it.dur)) + 'px';
    el.textContent = it.label || '';
    el.title = it.title || '';
    if (sel?.kind === kind && sel.index === it.i) el.classList.add('selected');
    el.onclick = (ev) => { ev.stopPropagation(); select(kind, it.i); };
    lane.appendChild(el);
  });
}

function positionPlayhead() {
  const t = video.currentTime || 0;
  $('#playhead').style.left = t2x(t) + 'px';
  $('#tcNow').textContent = fmtMs(t);
}

let lastT = -1;
function tick() {
  const t = video.currentTime || 0;
  if (t !== lastT) {
    lastT = t;
    positionPlayhead();
    if (tx.open) highlightSpokenWord(t);
    // keep the playhead in view while playing
    const scroll = $('#tlScroll'), x = t2x(t);
    if (!video.paused && (x < scroll.scrollLeft + 20 || x > scroll.scrollLeft + scroll.clientWidth - 40)) {
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35);
    }
  }
  requestAnimationFrame(tick);
}

function initTimelineInteraction() {
  const scroll = $('#tlScroll');
  // click anywhere empty (or the ruler) → move the playhead
  const seekFrom = (ev) => {
    const rect = $('#tlInner').getBoundingClientRect();
    video.currentTime = clamp(x2t(ev.clientX - rect.left), 0, dur);
    positionPlayhead();
  };
  $('#ruler').addEventListener('pointerdown', (ev) => {
    seekFrom(ev);
    const move = (e) => seekFrom(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
  $$('.lane').forEach((l) => l.addEventListener('pointerdown', (ev) => { if (ev.target === l) seekFrom(ev); }));

  // ⌘/ctrl + wheel = zoom around the cursor; plain wheel = horizontal scroll
  scroll.addEventListener('wheel', (ev) => {
    if (ev.metaKey || ev.ctrlKey) {
      ev.preventDefault();
      setZoom(zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), ev.clientX);
    } else if (Math.abs(ev.deltaX) < Math.abs(ev.deltaY)) {
      scroll.scrollLeft += ev.deltaY;
    }
  }, { passive: false });

  $('#btnPrepare').onclick = () => runPrepare();
  $('#btnVerify').onclick = () => runVerify();
  $('#btnZoomSuggest').onclick = () => openZoomSuggestions();
  $('#btnZoomIn').onclick = () => setZoom(zoom * 1.5);
  $('#btnZoomOut').onclick = () => setZoom(zoom / 1.5);
  $('#btnFit').onclick = () => { fitZoom(); renderTimeline(); $('#tlScroll').scrollLeft = 0; };
  $('#btnAutoCut').onclick = () => runAutoCut();
  $('#btnTranscribe').onclick = () => openTranscribePanel();
  $('#btnTemplates').onclick = () => openTemplatesPanel();
  $('#btnLook').onclick = () => openLookPanel();
  $('#btnTranscriptEdit').onclick = () => openTranscriptEditor();
  $('#btnStartAgent').onclick = () => startAgentEdit();
  $('#btnAgentBrief').onclick = () => showAgentBrief();
}

// ---------------------------------------------------------------- selection + inspector
function select(kind, index) {
  sel = { kind, index };
  const el = elemOf(sel);
  if (el && el.start != null) video.currentTime = clamp(el.start, 0, dur);
  renderTimeline(); renderInspector();
  // scroll the selection into view
  const x = t2x(el?.start || 0), scroll = $('#tlScroll');
  if (x < scroll.scrollLeft || x > scroll.scrollLeft + scroll.clientWidth - 40) {
    scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35);
  }
}
function deselect() { sel = null; renderTimeline(); renderInspector(); }

function elemOf(s) {
  if (!s || !project) return null;
  if (s.kind === 'scene') return project.scenes?.[s.index];
  if (s.kind === 'caption') return project.captions?.cues?.[s.index];
  if (s.kind === 'music') return project.audio?.music?.[s.index];
  if (s.kind === 'sfx') return project.audio?.sfx?.[s.index];
  if (s.kind === 'cut') return project.cuts?.[s.index];
  if (s.kind === 'overlay') return project.overlays?.[s.index];
  if (s.kind === 'zoom') return project.zooms?.[s.index];
  if (s.kind === 'frame') return project.frames?.[s.index];
  return null;
}

function field(label, val, on, type = 'text') {
  const f = document.createElement('div'); f.className = 'field';
  const l = document.createElement('label'); l.textContent = label; f.appendChild(l);
  const inp = document.createElement(type === 'area' ? 'textarea' : 'input');
  if (type !== 'area') inp.type = type;
  if (type === 'number') inp.step = 'any';
  inp.value = val ?? '';
  inp.oninput = () => on(inp.value);
  f.appendChild(inp);
  return f;
}
function selectField(label, value, options, on) {
  const f = document.createElement('div'); f.className = 'field';
  const l = document.createElement('label'); l.textContent = label; f.appendChild(l);
  const sel = document.createElement('select');
  options.forEach(([v, text]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = text;
    if (String(v) === String(value)) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => on(sel.value);
  f.appendChild(sel); return f;
}
const rowOf = (fields) => { const r = document.createElement('div'); r.className = 'row'; fields.forEach((f) => r.appendChild(f)); return r; };
const hint = (t) => { const p = document.createElement('p'); p.className = 'hint'; p.textContent = t; return p; };
const sep = () => { const d = document.createElement('div'); d.className = 'sep'; return d; };
const sechead = (t) => { const d = document.createElement('div'); d.className = 'sechead'; d.textContent = t; return d; };
function btn(label, onClick, cls) {
  const b = document.createElement('button'); b.textContent = label; b.onclick = onClick;
  if (cls) b.className = cls; return b;
}
const btnRow = (...buttons) => { const d = document.createElement('div'); d.className = 'btnrow'; buttons.forEach((b) => d.appendChild(b)); return d; };

function renderInspector() {
  const box = $('#inspector'); box.innerHTML = '';
  const e = elemOf(sel);
  $('#selBadge').textContent = e ? `${sel.kind} · ${fmt(e.start || 0)}` : 'nothing selected';
  if (!e) {
    box.innerHTML = '';
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.innerHTML = 'Nothing selected. Click anything on the timeline to edit it — or start here:';
    box.appendChild(empty);
    box.appendChild(btnRow(
      btn('Edit by transcript', () => openTranscriptEditor(), 'primary'),
      btn('Find cuts for me', () => runAutoCut()),
      btn('Templates', () => openTemplatesPanel()),
      btn('Look', () => openLookPanel()),
    ));
    box.appendChild(btnRow(
      btn('Start a new project from a video…', () => openNewProject()),
      btn('Show me around', () => startTour(true)),
    ));
    box.appendChild(hint('Tip: run claude in the terminal below and ask for an edit in plain English — it changes the same project you are looking at.'));
    return;
  }

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = sel.kind;
  const when = document.createElement('span'); when.textContent = fmt(e.start || 0);
  title.append(kind, when);
  h.append(title, btn('Delete', remove, 'danger'));
  box.appendChild(h);

  if (sel.kind === 'caption') renderCaptionInspector(box, e);
  else if (sel.kind === 'scene') renderSceneInspector(box, e);
  else if (sel.kind === 'cut') renderCutInspector(box, e);
  else if (sel.kind === 'overlay') renderOverlayInspector(box, e);
  else if (sel.kind === 'zoom') renderZoomInspector(box, e);
  else if (sel.kind === 'frame') renderFrameInspector(box, e);
  else renderAudioInspector(box, e);
}

function renderCaptionInspector(box, e) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const l = document.createElement('label'); l.textContent = 'Words — click to highlight, double-click to edit';
  const toks = document.createElement('div'); toks.className = 'tokens';
  e.tokens.forEach((tk) => {
    const s = document.createElement('span');
    s.className = 'tok' + (tk.e ? ' e' : ''); s.textContent = tk.t;
    s.onclick = () => { tk.e = !tk.e; save(); renderInspector(); renderTimeline(); };
    s.ondblclick = () => { const v = prompt('Edit word', tk.t); if (v != null) { tk.t = v; save(); renderInspector(); } };
    toks.appendChild(s);
  });
  wrap.append(l, toks); box.appendChild(wrap);

  box.appendChild(field('Full text', e.tokens.map((t) => t.t).join(' '), (v) => {
    const ws = v.split(/\s+/).filter(Boolean);
    e.tokens = ws.map((w, i) => ({ t: w, e: e.tokens[i]?.e || false }));
    save(); renderTimeline();
  }));
  box.appendChild(rowOf([
    field('Start', e.start, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('End', e.end, (v) => { e.end = +v; save(); renderTimeline(); }, 'number'),
  ]));

  box.appendChild(sep());
  box.appendChild(sechead('This cue only'));
  const o = e.overrides = e.overrides || {};
  const d = project.captions.defaults;
  box.appendChild(rowOf([
    field('Y pos', o.cy ?? d.cy, (v) => { o.cy = +v; save(); }, 'number'),
    field('Size', o.fontsize ?? d.fontsize, (v) => { o.fontsize = +v; save(); }, 'number'),
    field('Highlight', o.highlight ?? d.highlight, (v) => { o.highlight = v; save(); }),
  ]));

  box.appendChild(sep());
  box.appendChild(sechead('All captions (defaults)'));
  box.appendChild(rowOf([
    field('All Y pos', d.cy, (v) => { d.cy = +v; save(); }, 'number'),
    field('All size', d.fontsize, (v) => { d.fontsize = +v; save(); }, 'number'),
    field('All highlight', d.highlight, (v) => { d.highlight = v; save(); }),
  ]));
}

function renderSceneInspector(box, e) {
  box.appendChild(field('Headline', e.headline, (v) => { e.headline = v; save(); renderTimeline(); }));

  // How the picture gets into the scene's card. Sliding is the default because cutting straight
  // to the layout is the thing that always looked cheap.
  const entry = document.createElement('div'); entry.className = 'btnrow';
  const cur = e.enter === 'cut' ? 'cut' : 'slide';
  [['Slides in', 'slide'], ['Cuts in', 'cut']].forEach(([label, v]) => {
    entry.appendChild(btn(label, () => {
      if (v === 'slide') delete e.enter; else e.enter = 'cut';
      save(); renderInspector();
    }, cur === v ? 'primary' : ''));
  });
  box.appendChild(sechead('Entrance'));
  box.appendChild(entry);
  box.appendChild(hint(cur === 'slide'
    ? 'The picture glides into the card on the right over half a second, the panel fades up around '
      + 'it, and it glides back out when the scene ends.'
    : 'The picture jumps straight into the card — the original behaviour.'));
  box.appendChild(rowOf([
    field('Type', e.type, (v) => { e.type = v; save(); renderTimeline(); }),
    field('Start', e.start, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Duration', e.dur, (v) => { e.dur = +v; save(); renderTimeline(); }, 'number'),
  ]));
  if (e.items) {
    box.appendChild(field('Items — one per line, TEXT|colour',
      e.items.map((it) => (typeof it === 'string' ? it : `${it.text}|${it.color || 'white'}`)).join('\n'),
      (v) => {
        e.items = v.split('\n').filter(Boolean).map((line) => {
          const [t, c] = line.split('|');
          return e.type === 'checklist' ? t.trim() : { text: t.trim(), color: (c || 'white').trim() };
        });
        save();
      }, 'area'));
  }
  if (e.big != null) box.appendChild(field('Big text', e.big, (v) => { e.big = v; save(); }));
  if (e.sub != null) box.appendChild(field('Sub', e.sub, (v) => { e.sub = v; save(); }));
  if (e.target != null) box.appendChild(field('Counter target', e.target, (v) => { e.target = +v; save(); }, 'number'));
  if (e.old != null) {
    box.appendChild(field('Old (struck through)', e.old, (v) => { e.old = v; save(); }));
    box.appendChild(field('New', e.new, (v) => { e.new = v; save(); }));
  }
  box.appendChild(btnRow(btn('Preview this scene', () => previewAround(e.start, e.dur))));
}

function renderCutInspector(box, e) {
  box.appendChild(hint('This range is removed on Export — the video splices together and every caption, scene, overlay and audio layer after it shifts earlier. Preview shows the original timeline.'));
  box.appendChild(rowOf([
    field('Cut start', e.start, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Cut end', e.end, (v) => { e.end = +v; save(); renderTimeline(); }, 'number'),
  ]));
  box.appendChild(btnRow(
    btn('Set start = playhead', () => { e.start = +video.currentTime.toFixed(2); save(); renderInspector(); renderTimeline(); }),
    btn('Set end = playhead', () => { e.end = +video.currentTime.toFixed(2); save(); renderInspector(); renderTimeline(); }),
  ));
  box.appendChild(sep());
  box.appendChild(sechead('Transition at this seam'));
  box.appendChild(rowOf([
    selectField('Type', e.transition || 'none', [
      ['none', 'Hard cut'], ['crossfade', 'Crossfade'], ['dip', 'Dip to black'], ['dipwhite', 'Dip to white'],
      ['whip', 'Whip / slide'], ['wiperight', 'Wipe'], ['circle', 'Circle open'], ['smooth', 'Smooth'], ['pixel', 'Pixelize'],
    ], (v) => { if (v === 'none') delete e.transition; else e.transition = v; save(); renderTimeline(); }),
    field('Length (s)', e.tdur ?? 0.3, (v) => { e.tdur = +v; save(); }, 'number'),
  ]));
  box.appendChild(hint('A transition blends the two sides of the cut instead of butting them together. It also shortens the export by its length — captions, scenes and overlays are re-timed to match.'));
}

function renderOverlayInspector(box, e) {
  box.appendChild(hint('Any clip with an alpha channel — a HyperFrames render (--format mov), a PNG sequence, a transparent WebM — composited over the video for this window.'));
  box.appendChild(field('Source', e.src, (v) => { e.src = v; save(); renderTimeline(); }));
  box.appendChild(btnRow(
    btn('Choose file…', async () => {
      const r = await E.pickOverlay();
      if (r?.path) { e.src = r.path; if (r.duration) e.dur = r.duration; save(); renderInspector(); renderTimeline(); }
    }),
    btn(e.enabled === false ? 'Enable' : 'Disable', () => { e.enabled = e.enabled === false; save(); renderInspector(); renderTimeline(); }),
    btn('Preview here', () => previewAround(e.start || 0, e.dur || 4)),
  ));
  box.appendChild(rowOf([
    field('Start', e.start || 0, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Duration', e.dur || 4, (v) => { e.dur = +v; save(); renderTimeline(); }, 'number'),
  ]));
  box.appendChild(rowOf([
    field('X offset', e.x || 0, (v) => { e.x = +v; save(); }, 'number'),
    field('Y offset', e.y || 0, (v) => { e.y = +v; save(); }, 'number'),
  ]));
}

function renderAudioInspector(box, e) {
  box.appendChild(field('Source path', e.src, (v) => { e.src = v; save(); renderTimeline(); }));
  box.appendChild(rowOf([
    field('Start', e.start || 0, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Duration', e.dur || 4, (v) => { e.dur = +v; save(); renderTimeline(); }, 'number'),
    field('Gain dB', e.gain ?? -18, (v) => { e.gain = +v; save(); }, 'number'),
  ]));
  box.appendChild(rowOf([
    field('Fade in', e.fadeIn || 0, (v) => { e.fadeIn = +v; save(); }, 'number'),
    field('Fade out', e.fadeOut || 0, (v) => { e.fadeOut = +v; save(); }, 'number'),
  ]));
  box.appendChild(hint('Layers are mixed under the voice and loudness-normalised on render. Ask Claude in the terminal to generate music or SFX and they appear here.'));
}

// A zoom is a push-in: how close, on what point, for how long. x/y are normalised 0..1 so the
// same project survives a change of resolution.
function addZoom() {
  project.zooms = project.zooms || [];
  project.zooms.push({ id: 'z' + Date.now(), start: +(video.currentTime || 0).toFixed(2),
                       dur: 2, scale: 1.3, x: 0.5, y: 0.5, source: 'manual' });
  project.zooms.sort((a, b) => a.start - b.start);
  save(); renderTimeline();
  select('zoom', project.zooms.findIndex((z) => z.source === 'manual' && z.start === +(video.currentTime || 0).toFixed(2)));
}

// A framing move: where the picture goes, what shape it becomes, and what sits behind it.
// The default is the one people actually want — shrink to a circle in the bottom-right on a
// branded wash — because the point of the button is not to make you fill in a form.
function addFrame() {
  project.frames = project.frames || [];
  const at = +(video.currentTime || 0).toFixed(2);
  const goingSmall = !lastFrameStateBefore(at) || lastFrameStateBefore(at).to === 'full';
  project.frames.push(goingSmall
    ? { id: 'fr' + Date.now(), start: at, dur: 0.8, to: 'corner', shape: 'circle',
        size: 0.26, corner: 'br', margin: 0.04, backdrop: 'brand', ease: 'inout' }
    : { id: 'fr' + Date.now(), start: at, dur: 0.7, to: 'full', ease: 'inout' });
  project.frames.sort((a, b) => a.start - b.start);
  save(); renderTimeline();
  select('frame', project.frames.findIndex((f) => f.start === at));
}

// What the picture is doing just before a given moment — so "+" offers the opposite.
function lastFrameStateBefore(t) {
  return (project.frames || []).filter((f) => f.start < t).slice(-1)[0] || null;
}

function renderFrameInspector(box, e) {
  const set = (patch) => { Object.assign(e, patch); save(); renderTimeline(); renderInspector(); };

  const modes = document.createElement('div'); modes.className = 'btnrow';
  [['Full frame', 'full'], ['To the side', 'side'], ['To a corner', 'corner']].forEach(([label, mode]) => {
    const b = btn(label, () => set({ to: mode }), e.to === mode ? 'primary' : '');
    modes.appendChild(b);
  });
  box.appendChild(modes);
  box.appendChild(hint(e.to === 'side'
    ? 'The picture keeps its shape and moves aside, leaving the other half for a scene or an overlay — '
      + 'the layout the info-point templates are built around.'
    : e.to === 'corner'
    ? 'The picture shrinks into a corner. A circle or a rounded square reads as "the presenter", '
      + 'so the screen behind can carry the detail.'
    : 'The picture returns to filling the frame.'));

  box.appendChild(rowOf([
    field('Starts (s)', e.start, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Takes (s)', e.dur ?? 0.8, (v) => { e.dur = +v; save(); renderTimeline(); }, 'number'),
  ]));

  if (e.to !== 'full') {
    box.appendChild(rowOf([
      field('Size (% of width)', Math.round((e.size ?? (e.to === 'side' ? 0.42 : 0.26)) * 100),
        (v) => { e.size = clamp(+v, 8, 90) / 100; save(); renderTimeline(); }, 'number'),
      field('Margin (%)', Math.round((e.margin ?? 0.04) * 100),
        (v) => { e.margin = clamp(+v, 0, 25) / 100; save(); renderTimeline(); }, 'number'),
    ]));

    const shapes = document.createElement('div'); shapes.className = 'btnrow';
    const shape = e.shape || (e.to === 'corner' ? 'circle' : 'rounded');
    [['Circle', 'circle'], ['Rounded', 'rounded'], ['Square', 'rect']].forEach(([label, v]) => {
      shapes.appendChild(btn(label, () => set({ shape: v }), shape === v ? 'primary' : ''));
    });
    box.appendChild(sechead('Shape'));
    box.appendChild(shapes);

    if (e.to === 'corner') {
      box.appendChild(sechead('Corner'));
      const grid = document.createElement('div'); grid.className = 'corner-grid';
      [['tl', '◤'], ['tr', '◥'], ['bl', '◣'], ['br', '◢']].forEach(([c, glyph]) => {
        const b = document.createElement('button');
        b.className = 'corner-cell' + ((e.corner || 'br') === c ? ' on' : '');
        b.textContent = glyph; b.title = c.toUpperCase();
        b.onclick = () => set({ corner: c });
        grid.appendChild(b);
      });
      box.appendChild(grid);
    } else {
      const sides = document.createElement('div'); sides.className = 'btnrow';
      [['Left', 'left'], ['Right', 'right']].forEach(([label, v]) => {
        sides.appendChild(btn(label, () => set({ side: v }), (e.side || 'right') === v ? 'primary' : ''));
      });
      box.appendChild(sechead('Which side'));
      box.appendChild(sides);
    }

    box.appendChild(sechead('Behind the picture'));
    const backs = document.createElement('div'); backs.className = 'btnrow';
    [['Brand wash', 'brand'], ['Blurred frame', 'blur'], ['Flat black', '#0a0a09']].forEach(([label, v]) => {
      backs.appendChild(btn(label, () => set({ backdrop: v }), (e.backdrop || 'brand') === v ? 'primary' : ''));
    });
    box.appendChild(backs);
  }

  box.appendChild(btnRow(
    btn('Preview this move', () => {
      video.currentTime = clamp(e.start - 0.7, 0, dur);
      video.play().catch(() => {});
      setTimeout(() => video.pause(), ((e.dur || 0.8) + 1.6) * 1000);
    }),
    btn('Add the move back to full', () => {
      project.frames.push({ id: 'fr' + Date.now(), start: +(e.start + (e.dur || 0.8) + 4).toFixed(2),
                            dur: 0.7, to: 'full', ease: 'inout' });
      project.frames.sort((a, b) => a.start - b.start);
      save(); renderTimeline(); renderInspector();
    }),
  ));
  box.appendChild(hint('The player shows the original video — framing is applied on export, like the '
    + 'grade and the zooms. Preview a range to see it.'));
}

function renderZoomInspector(box, e) {
  box.appendChild(rowOf([
    field('Start (s)', e.start, (v) => { e.start = +v; save(); renderTimeline(); }, 'number'),
    field('Length (s)', e.dur ?? 2, (v) => { e.dur = +v; save(); renderTimeline(); }, 'number'),
    field('Scale', e.scale ?? 1.3, (v) => { e.scale = +v; save(); renderTimeline(); }, 'number'),
  ]));

  // Pick the centre by clicking the picture — far easier than typing two numbers.
  const pad = document.createElement('div'); pad.className = 'zoom-pad';
  const dot = document.createElement('div'); dot.className = 'zoom-dot';
  const place = () => { dot.style.left = (e.x ?? 0.5) * 100 + '%'; dot.style.top = (e.y ?? 0.5) * 100 + '%'; };
  pad.appendChild(dot); place();
  pad.onclick = (ev) => {
    const r = pad.getBoundingClientRect();
    e.x = +clamp((ev.clientX - r.left) / r.width, 0, 1).toFixed(3);
    e.y = +clamp((ev.clientY - r.top) / r.height, 0, 1).toFixed(3);
    place(); save(); renderTimeline(); renderInspector();
  };
  const wrap = document.createElement('div'); wrap.className = 'field';
  const lab = document.createElement('label'); lab.textContent = 'Centre — click where the push-in should land';
  wrap.append(lab, pad);
  box.appendChild(wrap);

  box.appendChild(rowOf([
    field('Centre x', e.x ?? 0.5, (v) => { e.x = +v; save(); renderTimeline(); }, 'number'),
    field('Centre y', e.y ?? 0.5, (v) => { e.y = +v; save(); renderTimeline(); }, 'number'),
  ]));
  box.appendChild(btnRow(
    btn('Preview', () => { video.currentTime = clamp(e.start - 0.5, 0, dur); video.play().catch(() => {});
      setTimeout(() => video.pause(), ((e.dur || 2) + 1) * 1000); }),
    btn('1.2× subtle', () => { e.scale = 1.2; save(); renderInspector(); renderTimeline(); }),
    btn('1.5× punchy', () => { e.scale = 1.5; save(); renderInspector(); renderTimeline(); }),
  ));
  box.appendChild(hint('Zooms ramp in and out over half a second and are applied on export. They survive cuts — '
    + 'a zoom whose moment gets trimmed away goes with it.'));
}

// ---------------------------------------------------------------- zoom suggestions
// Recording watches the cursor, the clicks and the words. Those become suggestions, never
// edits: the user (or the agent) decides which ones land.
let zoomSuggest = { list: [] };

function openZoomSuggestions() {
  const s = project?.recording?.zoomSuggestions || [];
  if (!s.length) {
    setStatus(project?.recording
      ? 'No zoom suggestions in this recording — add one with + on the Zooms track'
      : 'Zoom suggestions come from a screen recording. Record one, or add a zoom with + on the track.', 'ok');
    return;
  }
  // Anything already on the track is the track's business now; delete it there and it comes
  // back here. So the list only ever shows what has not been applied.
  const already = new Set((project.zooms || []).map((z) => z.id));
  zoomSuggest.list = s.filter((z) => !already.has(z.id))
                      .map((z) => ({ ...z, take: z.confidence !== 'low' }));
  if (!zoomSuggest.list.length) {
    setStatus(`All ${s.length} suggested zooms are already on the track`, 'ok');
    return;
  }
  renderZoomSuggestPanel();
}

function renderZoomSuggestPanel() {
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'zoom suggestions';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'zooms';
  const when = document.createElement('span'); when.textContent = `${zoomSuggest.list.length} suggested`;
  title.append(kind, when);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const wrap = document.createElement('div'); wrap.className = 'autocut';
  const sum = document.createElement('div'); sum.className = 'ac-summary';
  const counts = zoomSuggest.list.reduce((a, z) => { a[z.source] = (a[z.source] || 0) + 1; return a; }, {});
  sum.innerHTML = `Selected <b>${zoomSuggest.list.filter((z) => z.take).length}</b> of ${zoomSuggest.list.length}`
    + `<br><span class="dim">${Object.entries(counts).map(([k, v]) => `${v} from ${k}`).join(' · ') || 'no sources'}</span>`;
  wrap.appendChild(sum);

  const list = document.createElement('div'); list.className = 'ac-list';
  zoomSuggest.list.forEach((z) => {
    const row = document.createElement('div'); row.className = 'ac-item';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = z.take;
    cb.onclick = (ev) => { ev.stopPropagation(); z.take = cb.checked; refreshZoomSuggestTotals(); };
    const t = document.createElement('span'); t.className = 't'; t.textContent = fmt(z.start);
    const lbl = document.createElement('span'); lbl.className = 'lbl';
    lbl.textContent = `${(z.scale || 1.3).toFixed(2)}× · ${(z.dur || 2).toFixed(1)}s${z.label ? ' · ' + z.label : ''}`;
    const rsn = document.createElement('span'); rsn.className = 'rsn ' + z.source; rsn.textContent = z.source;
    row.append(cb, t, lbl, rsn);
    row.onclick = () => { video.currentTime = clamp(z.start - 0.6, 0, dur); video.play().catch(() => {});
      setTimeout(() => video.pause(), ((z.dur || 2) + 1.2) * 1000); };
    row.title = `${z.source} at ${z.start}s · ${z.confidence || 'medium'} confidence · click to watch it`;
    list.appendChild(row);
  });
  wrap.appendChild(list);

  wrap.appendChild(btnRow(
    btn('Select all', () => { zoomSuggest.list.forEach((z) => { z.take = true; });
      document.querySelectorAll('.ac-item input').forEach((c) => { c.checked = true; }); refreshZoomSuggestTotals(); }),
    btn('Select none', () => { zoomSuggest.list.forEach((z) => { z.take = false; });
      document.querySelectorAll('.ac-item input').forEach((c) => { c.checked = false; }); refreshZoomSuggestTotals(); }),
    btn(`Add ${zoomSuggest.list.filter((z) => z.take).length} zooms`, applyZoomSuggestions, 'primary'),
  ));
  wrap.appendChild(hint('These come from where you clicked, paused on something, or said something worth landing on. '
    + 'Adding them puts real zooms on the track — edit or delete any of them afterwards.'));
  box.appendChild(wrap);
}

function refreshZoomSuggestTotals() {
  const taken = zoomSuggest.list.filter((z) => z.take);
  const sum = $('#inspector .ac-summary');
  if (sum) {
    const counts = zoomSuggest.list.reduce((a, z) => { a[z.source] = (a[z.source] || 0) + 1; return a; }, {});
    sum.innerHTML = `Selected <b>${taken.length}</b> of ${zoomSuggest.list.length}`
      + `<br><span class="dim">${Object.entries(counts).map(([k, v]) => `${v} from ${k}`).join(' · ')}</span>`;
  }
  const add = [...document.querySelectorAll('#inspector button')].find((b) => /^Add /.test(b.textContent));
  if (add) { add.textContent = `Add ${taken.length} zooms`; add.disabled = taken.length === 0; }
}

function applyZoomSuggestions() {
  const taken = zoomSuggest.list.filter((z) => z.take);
  if (!taken.length) return;
  project.zooms = project.zooms || [];
  const have = new Set(project.zooms.map((z) => z.id));
  taken.forEach((z) => {
    if (have.has(z.id)) return;
    project.zooms.push({ id: z.id, start: z.start, dur: z.dur, scale: z.scale,
                         x: z.x, y: z.y, source: z.source });
  });
  project.zooms.sort((a, b) => a.start - b.start);
  zoomSuggest.list = zoomSuggest.list.filter((z) => !z.take);
  save(); renderTimeline();
  setStatus(`Added ${taken.length} zooms — export to see them`, 'ok');
  renderZoomSuggestPanel();
}

function remove() {
  if (!sel) return;
  if (sel.kind === 'scene') project.scenes.splice(sel.index, 1);
  else if (sel.kind === 'caption') project.captions.cues.splice(sel.index, 1);
  else if (sel.kind === 'cut') project.cuts.splice(sel.index, 1);
  else if (sel.kind === 'overlay') project.overlays.splice(sel.index, 1);
  else if (sel.kind === 'zoom') project.zooms.splice(sel.index, 1);
  else if (sel.kind === 'frame') project.frames.splice(sel.index, 1);
  else project.audio[sel.kind].splice(sel.index, 1);
  sel = null; save(); renderTimeline(); renderInspector();
}

// ---------------------------------------------------------------- save (debounced)
let saveT, lastEdit = 0;
function save() {
  lastEdit = Date.now();
  setStatus('Unsaved…');
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    const r = await E.saveProject(project);
    lastEdit = Date.now();
    setStatus(r?.ok ? 'Saved' : 'Save failed: ' + (r?.error || ''), r?.ok ? 'ok' : 'error');
  }, 400);
}

// ---------------------------------------------------------------- add / generate
document.addEventListener('click', (ev) => {
  const k = ev.target.dataset?.add;
  if (k) {
    if (!project) return;
    if (k === 'overlay') return addOverlay();
    if (k === 'cut') return addCut();
    if (k === 'zoom') return addZoom();
    if (k === 'frame') return addFrame();
    project.audio = project.audio || { music: [], sfx: [] };
    project.audio[k] = project.audio[k] || [];
    project.audio[k].push({
      id: k + Date.now(), src: '', start: +(video.currentTime || 0).toFixed(2),
      dur: k === 'music' ? 30 : 1, gain: k === 'music' ? -18 : -6,
    });
    save(); renderTimeline(); select(k, project.audio[k].length - 1);
    return;
  }
  if (ev.target.dataset?.gen) genAudio();
});

function addCut() {
  project.cuts = project.cuts || [];
  const t = +(video.currentTime || 0).toFixed(2);
  project.cuts.push({ start: t, end: Math.min(dur, t + 2) });
  save(); renderTimeline(); select('cut', project.cuts.length - 1);
}

async function addOverlay() {
  const r = await E.pickOverlay();
  if (!r?.path) return;
  project.overlays = project.overlays || [];
  project.overlays.push({
    id: 'ov' + Date.now(), src: r.path, start: +(video.currentTime || 0).toFixed(2),
    dur: r.duration || 4, x: 0, y: 0,
  });
  save(); renderTimeline(); select('overlay', project.overlays.length - 1);
}

async function genAudio() {
  const kind = prompt('Generate what? sfx | voice | music', 'sfx');
  if (!kind) return;
  const text = prompt(kind === 'voice' ? 'Voiceover text:' : `Describe the ${kind}:`, kind === 'sfx' ? 'whoosh transition' : '');
  if (!text) return;
  const at = +(kind === 'music' ? 0 : video.currentTime).toFixed(1);
  setStatus(`Generating ${kind} with ElevenLabs…`, 'working');
  const r = await E.generateAudio({ kind, text, at });
  if (r.ok) { setStatus(`${kind} added`, 'ok'); await loadProject(); }
  else setStatus('Audio generation failed: ' + String(r.error || '').slice(0, 90), 'error');
}

// ---------------------------------------------------------------- home
// The app opens here, not on whatever was last edited: a project is a deliberate choice,
// and this is also where the product explains itself.
let homeOpen = false;

async function showHome() {
  const cfg = await E.config();
  homeOpen = true;
  $('#home').hidden = false;
  $('#welcome').hidden = true;

  const box = $('#homeRecent');
  box.innerHTML = '';
  const recents = (cfg.recent || []).filter(Boolean);
  if (!recents.length) {
    const d = document.createElement('div');
    d.className = 'recent-empty';
    d.textContent = 'Nothing yet. Start from a video and it will appear here.';
    box.appendChild(d);
  } else {
    recents.forEach((dir, i) => {
      const b = document.createElement('button');
      b.className = 'recent-item';
      const nm = document.createElement('span'); nm.className = 'rn';
      nm.textContent = dir.replace(/\/+$/, '').split('/').pop();
      const pa = document.createElement('span'); pa.className = 'rp'; pa.textContent = dir;
      b.append(nm, pa);
      b.title = (i === 0 ? 'Continue editing — ' : '') + dir;
      b.onclick = async () => {
        const r = await E.openWorkspace(dir);
        if (r?.ok) E.reload();
        else { pa.textContent = r?.error || 'could not open'; b.disabled = true; }
      };
      box.appendChild(b);
    });
  }

  $('#homeRecord').onclick = () => E.openRecorder();
  $('#homeNew').onclick = () => { $('#home').hidden = true; homeOpen = false; openNewProject(); };
  $('#homeOpen').onclick = () => E.chooseWorkspace().then((r) => r?.ok && E.reload());
  $('#homeTour').onclick = () => { $('#home').hidden = true; homeOpen = false; if (project) startTour(true); };
  $('#homeGuide').onclick = () => E.openGuide();
  $('#promoVisit').onclick = () => E.openExternal('https://viddescriptor.com');
  $('#homeBrandLink').onclick = (ev) => { ev.preventDefault(); E.openExternal('https://viddescriptor.com'); };
  $('#homeEnv').onclick = async (ev) => {
    ev.preventDefault();
    const env = await E.checkEnvironment();
    $('#homeEnv').textContent = env.ok ? 'Environment OK ✓'
      : 'Missing: ' + env.missing.map((m) => m.tool).join(', ');
  };
  $('#homeLogs').onclick = (ev) => { ev.preventDefault(); E.openLogs(); };
}

function hideHome() {
  if (!project) return;                 // nowhere to go back to
  homeOpen = false;
  $('#home').hidden = true;
}

// ---------------------------------------------------------------- guided tour
// Shown once, replayable from Help. Each step spotlights a real element, so the tour can
// never drift from the UI: if the selector stops matching, the step is skipped.
const TOUR_STEPS = [
  { el: '#btnWorkspace', title: 'This is your project',
    body: 'The chip shows the folder you are editing. Click it any time to start a new project from a video, open another one, or jump back to a recent project.' },
  { el: '#tlHeads', title: 'Everything is a track',
    body: 'Scenes, overlays, captions, cuts and audio. Click anything on a track to edit it on the right. The small buttons in each track header add to that track.' },
  { el: '#btnTranscriptEdit', title: 'Edit by reading',
    body: 'Open the transcript, select a sentence you want gone and press Delete — the video is cut there and every caption, scene and overlay after it moves up automatically.' },
  { el: '#btnAutoCut', title: 'Let it find the dead air',
    body: 'Auto-cut listens to the audio for silences and reads the transcript for “um”s and stutters, then proposes cuts. Click any proposal to hear it before you accept.' },
  { el: '#btnTemplates', title: 'Looks and motion graphics',
    body: 'A template sets the caption style and brings lower thirds, title cards and callouts. Fill in your text and it renders straight onto the Overlays track.' },
  { el: '#btnLook', title: 'Grade and polish',
    body: 'Film, warm, teal & orange, noir… plus grain and vignette, and a voice polish for the audio. Applied when rendering, so your master is never touched.' },
  { el: '.term', title: 'The agent works here',
    body: 'Run <code>claude</code> and ask for what you want — “cut the rambling in the middle”, “add a lower third when I say relay”. It edits the same project you are looking at, and the timeline updates live.' },
  { el: '#btnExport', title: 'Preview, then export',
    body: 'Preview section renders just the part you are looking at (seconds). Export renders the whole video with every cut, caption, scene, overlay and look applied.' },
];

let tour = { i: 0, active: false };

function startTour(fromStart = true) {
  if (!project) return;
  tour.i = fromStart ? 0 : tour.i;
  tour.active = true;
  $('#tour').hidden = false;
  $('#tourTotal').textContent = String(TOUR_STEPS.length);
  paintTour();
}
function endTour() {
  tour.active = false;
  $('#tour').hidden = true;
  try { localStorage.setItem('cutright.tourSeen', '1'); } catch {}
}
function stepTour(d) {
  const next = tour.i + d;
  if (next < 0) return;
  if (next >= TOUR_STEPS.length) return endTour();
  tour.i = next; paintTour();
}

function paintTour() {
  const step = TOUR_STEPS[tour.i];
  const el = document.querySelector(step.el);
  if (!el) return stepTour(1);                 // the UI moved on; skip rather than lie
  const r = el.getBoundingClientRect();
  const pad = 8;
  const spot = $('#tourSpot');
  spot.style.left = (r.left - pad) + 'px';
  spot.style.top = (r.top - pad) + 'px';
  spot.style.width = (r.width + pad * 2) + 'px';
  spot.style.height = (r.height + pad * 2) + 'px';

  $('#tourN').textContent = String(tour.i + 1);
  $('#tourTitle').textContent = step.title;
  $('#tourBody').innerHTML = step.body;

  const card = $('#tourCard');
  const cw = 340, ch = card.offsetHeight || 190;
  let left = r.left + r.width / 2 - cw / 2;
  let top = r.bottom + 16;
  if (top + ch > window.innerHeight - 12) top = Math.max(12, r.top - ch - 16);
  card.style.left = clamp(left, 12, window.innerWidth - cw - 12) + 'px';
  card.style.top = clamp(top, 12, window.innerHeight - ch - 12) + 'px';
  $('#tourPrev').disabled = tour.i === 0;
  $('#tourNext').textContent = tour.i === TOUR_STEPS.length - 1 ? 'Done' : 'Next';
}

function initTour() {
  $('#tourNext').onclick = () => stepTour(1);
  $('#tourPrev').onclick = () => stepTour(-1);
  $('#tourSkip').onclick = endTour;
  window.addEventListener('resize', () => { if (tour.active) paintTour(); });
  document.addEventListener('keydown', (ev) => {
    if (!tour.active) return;
    if (ev.key === 'Escape') { ev.preventDefault(); endTour(); }
    if (ev.key === 'ArrowRight' || ev.key === 'Enter') { ev.preventDefault(); stepTour(1); }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepTour(-1); }
  }, true);
  E.onShowTour?.(() => { hideHome(); startTour(true); });
  E.onShowHome?.(() => showHome());
  let seen = false;
  try { seen = localStorage.getItem('cutright.tourSeen') === '1'; } catch {}
  if (!seen) setTimeout(() => { if (!homeOpen) startTour(true); }, 900);
}

// ---------------------------------------------------------------- new project
// Raw recording in, workspace out. This is the only entry point that does not assume
// someone already prepared a project folder.
let np = { source: '', dest: '', ref: '', busy: false };

function openNewProject() {
  np.busy = false;
  $('#newproj').hidden = false;
  $('#npProgress').hidden = true;
  $('#npBar').style.width = '0%';
  $('#npGo').disabled = false;
  paintNewProject();
}
function closeNewProject() { if (!np.busy) $('#newproj').hidden = true; }

function paintNewProject() {
  const set = (id, val, placeholder) => {
    const el = $(id);
    el.textContent = val || placeholder;
    el.classList.toggle('set', !!val);
    el.title = val || '';
  };
  set('#npSource', np.source, 'No video chosen');
  set('#npDest', np.dest, '—');
  set('#npRef', np.ref, 'None — keep the original look');
  $('#npGo').disabled = np.busy || !np.source || !np.dest;
}

function initNewProject() {
  $('#npPickVideo').onclick = async () => {
    const r = await E.newProject.pickVideo();
    if (!r?.ok) return;
    np.source = r.source;
    if (!np.dest) np.dest = r.suggestedDest;
    paintNewProject();
  };
  $('#npPickDest').onclick = async () => {
    const r = await E.newProject.pickFolder({ defaultPath: np.dest, title: 'Where should the project go?' });
    if (r?.ok) { np.dest = r.dir; paintNewProject(); }
  };
  $('#npPickRef').onclick = async () => {
    const r = await E.newProject.pickVideo();
    if (r?.ok) { np.ref = r.source; paintNewProject(); }
  };
  $('#npClearRef').onclick = () => { np.ref = ''; paintNewProject(); };
  $('#npCancel').onclick = closeNewProject;
  $('#npGo').onclick = runNewProject;
  $('#newproj').addEventListener('click', (ev) => { if (ev.target.id === 'newproj') closeNewProject(); });
}

// Show a failure inside the dialog (the status bar is hidden behind it) and always offer
// a way out.
function npFailed(headline, detail, workDir) {
  $('#npStage').innerHTML = '';
  const h = document.createElement('div');
  h.style.cssText = 'color:#ff9c88;font-weight:600;margin-bottom:4px';
  h.textContent = headline;
  const d = document.createElement('div');
  d.style.cssText = 'color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-word';
  d.textContent = String(detail).slice(0, 400);
  $('#npStage').append(h, d);
  if (workDir) {
    const row = document.createElement('div'); row.className = 'btnrow'; row.style.marginTop = '10px';
    row.append(
      btn('Open it now', async () => {
        const r = await E.newProject.adopt(workDir);
        if (r?.ok) E.reload(); else npFailed('Still could not open it', r?.error || '', workDir);
      }, 'primary'),
      btn('Show in Finder', () => E.revealFolder(workDir)),
    );
    $('#npStage').appendChild(row);
  }
  setStatus(headline, 'error');
}

async function runNewProject() {
  if (np.busy || !np.source || !np.dest) return;
  np.busy = true;
  $('#npGo').disabled = true;
  $('#npProgress').hidden = false;
  $('#npStage').textContent = 'Starting…';

  const model = $('#npModel').value;
  const off = E.newProject.onEvent(async (m) => {
    if (m.type === 'progress') {
      $('#npBar').style.width = Math.max(2, Math.round(m.pct || 0)) + '%';
      $('#npStage').textContent = `${m.stage}: ${m.detail || ''}`;
      setStatus(`Building project — ${m.stage}`, 'working');
    }
    if (m.type === 'error') {
      np.busy = false; off();
      $('#npGo').disabled = false;
      npFailed('Could not build the project', String(m.error));
    }
    if (m.type === 'done') {
      np.busy = false; off();
      $('#npStage').textContent = `Done — ${m.cues} captions, ${Math.round(m.duration)}s. Opening…`;
      const r = await E.newProject.adopt(m.work);
      if (r?.ok) { E.reload(); return; }
      // The project exists on disk either way — never leave the user staring at a
      // finished progress bar with no way forward.
      npFailed('The project was built, but could not be opened automatically',
        (r?.error || 'unknown reason') + '\n' + m.work, m.work);
    }
  });

  const r = await E.newProject.create({
    source: np.source, dest: np.dest, gradeRef: np.ref,
    transcribe: !!model, model: model || 'small.en',
  });
  if (r?.error) {
    np.busy = false; off();
    $('#npGo').disabled = false;
    $('#npStage').textContent = 'Failed: ' + r.error;
  }
}

// ---------------------------------------------------------------- transcript editor
// Edit by reading: select words, press delete, and the video is cut there. Everything
// downstream (captions, scenes, overlays, audio) re-times through the engine's remap, so
// this is just a nicer way to author `cuts[]`.
let tx = { words: [], sel: null, anchor: null, open: false, prevSrc: null, onlyCuts: false };

async function openTranscriptEditor() {
  if (!project) return;
  const r = await E.getTranscript();
  if (r.error) { setStatus(r.error, 'error'); return; }
  tx.words = r.words;
  tx.open = true;
  // Transcript times are on the ORIGINAL timeline, so play the uncut master while editing.
  tx.prevSrc = $('#previewTag').textContent;
  loadVideo(project.meta.graded || 'graded_master.mp4', video.currentTime);
  renderTranscriptPanel();
}

function closeTranscriptEditor() {
  tx.open = false; tx.sel = null;
  if (tx.prevSrc) loadVideo(tx.prevSrc, 0);
  renderInspector();
}

const FILLER_WORDS = new Set(['um', 'uh', 'umm', 'uhh', 'erm', 'ehm', 'hmm', 'mmm', 'ah', 'er', 'uhm']);
const inAnyCut = (w) => (project.cuts || []).some((c) => c.start <= (w.start + w.end) / 2 && (w.start + w.end) / 2 <= c.end);

function renderTranscriptPanel() {
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'transcript';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'transcript';
  const when = document.createElement('span'); when.textContent = `${tx.words.length} words`;
  title.append(kind, when);
  h.append(title, btn('Close', closeTranscriptEditor));
  box.appendChild(h);

  const bar = document.createElement('div'); bar.className = 'tx-bar';
  bar.append(
    btn('Cut selection', cutSelection, 'danger'),
    btn('Restore selection', restoreSelection),
    btn('Cut all fillers', cutAllFillers),
    btn(tx.onlyCuts ? 'Show all' : 'Show only cuts', () => { tx.onlyCuts = !tx.onlyCuts; renderTranscriptPanel(); }),
  );
  box.appendChild(bar);
  box.appendChild(hint('Click a word to jump there. Drag (or shift-click) to select a phrase, then Cut — or press Delete. Struck-through words are already removed from the export; select them and Restore to bring them back.'));

  const doc = document.createElement('div'); doc.className = 'tx-doc';
  const frag = document.createDocumentFragment();
  tx.words.forEach((w, i) => {
    const cut = inAnyCut(w);
    if (tx.onlyCuts && !cut) return;
    const el = document.createElement('span');
    const clean = w.text.toLowerCase().replace(/[^a-z']/g, '');
    el.className = 'tx-w' + (cut ? ' cut' : '') + (FILLER_WORDS.has(clean) ? ' filler' : '')
      + (tx.sel && i >= tx.sel[0] && i <= tx.sel[1] ? ' sel' : '');
    el.textContent = w.text;
    el.dataset.i = i;
    frag.appendChild(el);
    frag.appendChild(document.createTextNode(' '));
    if (i + 1 < tx.words.length && tx.words[i + 1].start - w.end > 1.0) {
      const gap = document.createElement('span'); gap.className = 'tx-gap';
      gap.textContent = `[${(tx.words[i + 1].start - w.end).toFixed(1)}s] `;
      frag.appendChild(gap);
    }
  });
  doc.appendChild(frag);

  let dragging = false;
  doc.addEventListener('pointerdown', (ev) => {
    if (!ev.target.classList?.contains('tx-w')) return;
    const i = +ev.target.dataset.i;
    if (ev.shiftKey && tx.anchor != null) tx.sel = [Math.min(tx.anchor, i), Math.max(tx.anchor, i)];
    else { tx.anchor = i; tx.sel = [i, i]; video.currentTime = clamp(tx.words[i].start, 0, dur); }
    dragging = true; paintSelection(doc);
  });
  doc.addEventListener('pointermove', (ev) => {
    if (!dragging || !ev.target.classList?.contains('tx-w')) return;
    const i = +ev.target.dataset.i;
    if (Number.isNaN(i)) return;
    tx.sel = [Math.min(tx.anchor, i), Math.max(tx.anchor, i)];
    paintSelection(doc);
  });
  window.addEventListener('pointerup', () => { dragging = false; });
  box.appendChild(doc);

  const stats = document.createElement('div'); stats.className = 'tx-stats';
  const removed = (project.cuts || []).reduce((a, c) => a + (c.end - c.start), 0);
  const cutWords = tx.words.filter(inAnyCut).length;
  stats.textContent = `${cutWords} words cut - ${removed.toFixed(1)}s removed - export runs ${fmt(Math.max(0, dur - removed))} (from ${fmt(dur)})`;
  box.appendChild(stats);
}

function paintSelection(doc) {
  const [a, b] = tx.sel || [-1, -1];
  doc.querySelectorAll('.tx-w').forEach((el) => {
    const i = +el.dataset.i;
    el.classList.toggle('sel', i >= a && i <= b);
  });
}

// A cut derived from words snaps outward into the silence around them, so we never clip
// the tail of the previous word or the attack of the next one.
function spanForSelection() {
  if (!tx.sel) return null;
  const [a, b] = tx.sel;
  const first = tx.words[a], last = tx.words[b];
  const prev = tx.words[a - 1], next = tx.words[b + 1];
  const pad = 0.06;
  const start = prev ? Math.max(prev.end + pad, first.start - 0.12) : Math.max(0, first.start - 0.12);
  const end = next ? Math.min(next.start - pad, last.end + 0.12) : Math.min(dur, last.end + 0.12);
  return end > start ? { start: +start.toFixed(2), end: +end.toFixed(2) } : null;
}

function mergeCuts() {
  project.cuts.sort((x, y) => x.start - y.start);
  const merged = [];
  for (const c of project.cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  project.cuts = merged;
}

function cutSelection() {
  const span = spanForSelection();
  if (!span) { setStatus('Select some words first', 'error'); return; }
  project.cuts = project.cuts || [];
  project.cuts.push({ ...span, source: 'transcript' });
  mergeCuts();
  save(); renderTimeline(); renderTranscriptPanel();
  setStatus(`Cut ${(span.end - span.start).toFixed(1)}s at ${fmt(span.start)}`, 'ok');
}

function restoreSelection() {
  if (!tx.sel || !project.cuts?.length) return;
  // Restore over the same gap-padded span the cut used, otherwise trimming leaves
  // slivers of the old cut hanging in the silence either side (cut → restore must be
  // exactly reversible).
  const span = spanForSelection();
  const s = span ? span.start : tx.words[tx.sel[0]].start;
  const e = span ? span.end : tx.words[tx.sel[1]].end;
  const kept = [];
  project.cuts.forEach((c) => {
    if (c.end <= s || c.start >= e) { kept.push(c); return; }
    if (c.start < s - 0.01) kept.push({ ...c, end: Math.min(c.end, s) });
    if (c.end > e + 0.01) kept.push({ ...c, start: Math.max(c.start, e) });
  });
  // anything left shorter than a frame or two is a leftover, not an edit
  project.cuts = kept.filter((c) => c.end - c.start > 0.15);
  save(); renderTimeline(); renderTranscriptPanel();
  setStatus(`Restored ${fmt(s)} to ${fmt(e)}`, 'ok');
}

function cutAllFillers() {
  const spans = [];
  tx.words.forEach((w, i) => {
    const clean = w.text.toLowerCase().replace(/[^a-z']/g, '');
    if (!FILLER_WORDS.has(clean) || inAnyCut(w)) return;
    const prev = tx.words[i - 1], next = tx.words[i + 1];
    const start = prev ? Math.max(prev.end + 0.04, w.start - 0.1) : w.start;
    const end = next ? Math.min(next.start - 0.04, w.end + 0.1) : w.end;
    if (end > start) spans.push({ start: +start.toFixed(2), end: +end.toFixed(2), source: 'transcript:filler' });
  });
  if (!spans.length) { setStatus('No filler words left to cut', 'ok'); return; }
  project.cuts = [...(project.cuts || []), ...spans];
  mergeCuts();
  save(); renderTimeline(); renderTranscriptPanel();
  setStatus(`Cut ${spans.length} filler words`, 'ok');
}

let lastSpoken = -1;
function highlightSpokenWord(t) {
  const i = tx.words.findIndex((w) => t >= w.start && t <= w.end + 0.05);
  if (i === lastSpoken) return;
  lastSpoken = i;
  const doc = $('.tx-doc'); if (!doc) return;
  doc.querySelector('.tx-w.now')?.classList.remove('now');
  if (i < 0) return;
  const el = doc.querySelector(`.tx-w[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('now');
  const r = el.getBoundingClientRect(), dr = doc.getBoundingClientRect();
  if (r.top < dr.top || r.bottom > dr.bottom) el.scrollIntoView({ block: 'center' });
}

// ---------------------------------------------------------------- look (film grade)
// Applied at render time on top of the graded master, so it is free to change and never
// destroys the original grade.
const LOOK_PRESETS = [
  ['none', 'None', 'the graded master as-is'],
  ['film', 'Film', 'gentle S-curve, slightly desaturated'],
  ['warm', 'Warm', 'golden skin tones'],
  ['cool', 'Cool', 'cold, clean, corporate'],
  ['teal-orange', 'Teal & orange', 'the blockbuster split-tone'],
  ['bleach', 'Bleach bypass', 'harsh, desaturated, high contrast'],
  ['noir', 'Noir', 'black and white, strong contrast'],
  ['vhs', 'VHS', 'noisy, soft, nostalgic'],
];
const POLISH_PRESETS = [['none', 'None'], ['voice', 'Voice (compressed)'], ['warm', 'Warm voice'], ['podcast', 'Podcast (limited)']];

function openLookPanel() {
  if (!project) return;
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'look';
  project.grade = project.grade || {};
  const look = typeof project.grade.look === 'string' ? { preset: project.grade.look } : (project.grade.look || {});
  project.grade.look = look;
  project.audio = project.audio || {};

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'look';
  title.append(kind);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const grid = document.createElement('div'); grid.className = 'btnrow';
  LOOK_PRESETS.forEach(([id, name, desc]) => {
    const b = btn(name, () => {
      look.preset = id; save();
      grid.querySelectorAll('button').forEach((x) => x.classList.remove('primary'));
      b.classList.add('primary');
    });
    b.title = desc;
    if ((look.preset || 'none') === id) b.classList.add('primary');
    grid.appendChild(b);
  });
  box.appendChild(grid);

  box.appendChild(rowOf([
    field('Grain', look.grain ?? 0, (v) => { look.grain = +v; save(); }, 'number'),
    field('Vignette', look.vignette ?? 0, (v) => { look.vignette = +v; save(); }, 'number'),
    field('Bloom', look.bloom ?? 0, (v) => { look.bloom = +v; save(); }, 'number'),
  ]));
  box.appendChild(field('Extra ffmpeg filter (advanced)', look.filter || '', (v) => { look.filter = v; save(); }));

  box.appendChild(sep());
  box.appendChild(sechead('Audio'));
  box.appendChild(rowOf([
    selectField('Polish', project.audio.polish || 'none', POLISH_PRESETS, (v) => {
      if (v === 'none') delete project.audio.polish; else project.audio.polish = v; save();
    }),
    field('Loudness (LUFS)', project.audio.loudnessLUFS ?? -14, (v) => { project.audio.loudnessLUFS = +v; save(); }, 'number'),
  ]));

  box.appendChild(sep());
  box.appendChild(btnRow(btn('Preview this look here', () => previewAround(video.currentTime, 6), 'primary')));
  box.appendChild(hint('Grain 0–40, vignette and bloom 0–1. The look is applied when rendering, over the graded master — nothing is baked in, so you can change your mind at any time.'));
}

// ---------------------------------------------------------------- the agent hand-off
// The UI records intent; the agent does the editing. These two buttons are the seam.
function startAgentEdit() {
  // Bypass mode by default: the agent is working inside the user's own project folder and
  // a permission prompt per file edit makes the loop unusable. The user starts it knowingly.
  E.term.write('claude --dangerously-skip-permissions\r');
  setStatus('Starting the agent — then type what you want, e.g. “edit my video”', 'working');
  setTimeout(() => E.term.write('Edit my video. Read CLAUDE.md and project.json first.\r'), 4000);
}

async function showAgentBrief() {
  const brief = await E.templates.getBrief();
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'brief';
  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'agent brief';
  title.append(kind);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  if (!brief) {
    box.appendChild(hint('No brief yet — pick a template and the app will write one.'));
    box.appendChild(btnRow(btn('Choose a template', () => openTemplatesPanel(), 'primary')));
    return;
  }

  box.appendChild(hint('This is what the agent has been told. It lives in project.json → brief, and is mirrored into CLAUDE.md and AGENTS.md so any agent picks it up.'));

  const b = document.createElement('div'); b.className = 'brief-box';
  b.innerHTML = `Template <b>${brief.template.name}</b><br>` +
    `Scene types it may use: <b>${brief.capabilities.scenes.length}</b> · ` +
    `motion-graphics presets: <b>${brief.capabilities.overlays.length}</b><br>` +
    `Generated audio: <b>${brief.capabilities.mediaGeneration.audio.configured ? 'ElevenLabs ready' : 'not configured'}</b>`;
  box.appendChild(b);

  box.appendChild(sep());
  box.appendChild(sechead('What you want (the agent reads this)'));
  const f = field('Your intent, in plain English', brief.intent || '', () => {});
  const input = f.querySelector('input');
  input.placeholder = 'e.g. punchy 2-minute cut, heavy on captions, one title card per chapter';
  box.appendChild(f);
  box.appendChild(btnRow(
    btn('Save intent', async () => {
      const r = await E.templates.setIntent(input.value);
      setStatus(r?.ok ? 'Brief updated — the agent will read it' : 'Could not save', r?.ok ? 'ok' : 'error');
    }, 'primary'),
    btn('▶ Hand it to the agent', () => startAgentEdit()),
  ));

  box.appendChild(sep());
  box.appendChild(sechead('The agent is asked to'));
  const ul = document.createElement('ul'); ul.className = 'brief-list';
  brief.handoff.agentShouldDo.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  box.appendChild(ul);
}

// ---------------------------------------------------------------- templates
// A template gives the project its look (caption defaults + scene style) and brings a set
// of motion-graphics presets you can render straight onto the Overlays track.
let tpl = { list: [], expanded: null, values: {}, busy: false };

async function openTemplatesPanel() {
  tpl.list = await E.templates.list();
  renderTemplatesPanel();
}

function renderTemplatesPanel() {
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'templates';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'templates';
  title.append(kind);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const active = project?.meta?.template || project?.meta?.style;
  const grid = document.createElement('div'); grid.className = 'tpl-grid';
  tpl.list.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'tpl-card' + (t.id === active ? ' active' : '');
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    if (t.previewUrl) { const img = document.createElement('img'); img.src = t.previewUrl; thumb.appendChild(img); }
    const sw = document.createElement('div'); sw.className = 'swatches';
    Object.values(t.tokens || {}).filter((v) => typeof v === 'string' && v.startsWith('#')).slice(0, 5)
      .forEach((c) => { const d = document.createElement('div'); d.className = 'sw'; d.style.background = c; sw.appendChild(d); });
    thumb.appendChild(sw);
    const meta = document.createElement('div'); meta.className = 'meta';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = t.name;
    const ds = document.createElement('div'); ds.className = 'ds'; ds.textContent = t.description || '';
    const eng = document.createElement('div'); eng.className = 'eng';
    eng.textContent = `${t.engine} · ${t.overlays.length} presets${t.builtin ? '' : ' · installed'}`;
    meta.append(nm, ds, eng);
    card.append(thumb, meta);
    card.onclick = async () => {
      const r = await E.templates.apply(t.id);
      if (r.ok) {
        await loadProject();
        const b = r.brief || {};
        setStatus(`“${t.name}” applied — agent briefed with ${b.presets ?? '?'} presets and ${b.sceneTypes ?? '?'} scene types`, 'ok');
        renderTemplatesPanel();
      }
      else setStatus('Could not apply template: ' + r.error, 'error');
    };
    grid.appendChild(card);
  });
  box.appendChild(grid);
  box.appendChild(hint('Applying a template sets the caption look and the scene style for this project. It does not touch your cuts, timings or text.'));

  // presets of the active template
  const cur = tpl.list.find((t) => t.id === active) || tpl.list[0];
  if (cur) {
    box.appendChild(sep());
    box.appendChild(sechead(`Motion graphics — ${cur.name}`));
    const list = document.createElement('div'); list.className = 'preset-list';
    cur.overlays.forEach((preset) => {
      const wrap = document.createElement('div'); wrap.className = 'preset';
      const head = document.createElement('div'); head.className = 'ph';
      const b = document.createElement('b'); b.textContent = preset.name;
      const meta = document.createElement('span'); meta.className = 'dim'; meta.style.fontSize = '10.5px';
      meta.textContent = `${preset.duration || 4}s`;
      head.append(b, meta);
      head.onclick = () => { tpl.expanded = tpl.expanded === preset.id ? null : preset.id; renderTemplatesPanel(); };
      wrap.appendChild(head);

      if (tpl.expanded === preset.id) {
        const body = document.createElement('div'); body.className = 'pv';
        const key = `${cur.id}:${preset.id}`;
        tpl.values[key] = tpl.values[key] || Object.fromEntries((preset.vars || []).map((v) => [v.name, v.default ?? '']));
        (preset.vars || []).forEach((v) => {
          body.appendChild(field(v.label || v.name, tpl.values[key][v.name], (val) => { tpl.values[key][v.name] = val; }));
        });
        const go = btn(tpl.busy ? 'Rendering…' : 'Render & add to timeline',
          () => insertPreset(cur, preset, tpl.values[key]), 'primary');
        go.disabled = tpl.busy;
        body.appendChild(btnRow(go));
        wrap.appendChild(body);
      }
      list.appendChild(wrap);
    });
    box.appendChild(list);
  }

  box.appendChild(sep());
  box.appendChild(btnRow(
    btn('Open templates folder', () => E.templates.openFolder()),
    btn('Reload', async () => { tpl.list = await E.templates.list(); renderTemplatesPanel(); }),
  ));
  box.appendChild(hint('Drop a template folder into that directory and hit Reload — that is how downloaded template packs install.'));
}

async function insertPreset(template, preset, vars) {
  if (tpl.busy) return;
  tpl.busy = true; renderTemplatesPanel();
  setStatus(`Rendering “${preset.name}”…`, 'working');
  const off = E.templates.onEvent(async (m) => {
    if (m.type === 'progress') setStatus(`Rendering “${preset.name}” — ${m.detail || ''}`.slice(0, 90), 'working');
    if (m.type === 'error') { tpl.busy = false; off(); setStatus('Preset render failed: ' + String(m.error).slice(0, 120), 'error'); renderTemplatesPanel(); }
    if (m.type === 'done') {
      tpl.busy = false; off();
      const rel = m.path.startsWith(WORK + '/') ? m.path.slice(WORK.length + 1) : m.path;
      project.overlays = project.overlays || [];
      project.overlays.push({
        id: `${preset.id}-${Date.now()}`, src: rel,
        start: +(video.currentTime || 0).toFixed(2), dur: m.duration || preset.duration || 4,
        x: 0, y: 0, template: template.id, preset: preset.id, vars,
      });
      save(); renderTimeline();
      setStatus(`“${preset.name}” added at ${fmt(video.currentTime || 0)}`, 'ok');
      select('overlay', project.overlays.length - 1);
    }
  });
  const r = await E.templates.renderPreset({ template: template.id, preset: preset.id, vars, fps: fps });
  if (r?.error) { tpl.busy = false; off(); setStatus('Preset render failed: ' + r.error, 'error'); renderTemplatesPanel(); }
}

// ---------------------------------------------------------------- transcription
// Captions and auto-cut both live off transcript.json. This panel (re)builds it with a
// local engine by default; remote engines are available when a key is stored.
let stt = { engines: null, opts: { engine: 'hyperframes', model: 'small.en', language: '', rebuildCaptions: true, wordsPerCue: 3 }, busy: false, log: [] };

async function openTranscribePanel() {
  stt.engines = await E.transcribe.engines();
  renderTranscribePanel();
}

function renderTranscribePanel() {
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'transcribe';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'transcribe';
  title.append(kind);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  box.appendChild(hint('Rebuilds transcript.json (word-level), which drives both the captions and the auto-cut analysis. The previous transcript and project are kept as *.prev.json.'));

  const eng = stt.engines || {};
  const options = [
    ['hyperframes', 'Whisper (local, recommended)', eng.hyperframes],
    ['whisper-cli', 'whisper.cpp (local, own model)', eng['whisper-cli']],
    ['openai', 'OpenAI (remote, needs key)', eng.openai],
    ['elevenlabs', 'ElevenLabs Scribe (remote, needs key)', eng.elevenlabs],
  ];
  const pick = document.createElement('div'); pick.className = 'btnrow';
  options.forEach(([id, label, available]) => {
    const b = btn((stt.opts.engine === id ? '● ' : '○ ') + label, () => { stt.opts.engine = id; renderTranscribePanel(); });
    if (!available) { b.disabled = true; b.title = id === 'openai' || id === 'elevenlabs' ? 'Add an API key below' : 'Not installed'; }
    if (stt.opts.engine === id) b.classList.add('primary');
    pick.appendChild(b);
  });
  box.appendChild(pick);

  box.appendChild(rowOf([
    field('Model', stt.opts.model, (v) => { stt.opts.model = v; }),
    field('Language (blank = auto)', stt.opts.language, (v) => { stt.opts.language = v; }),
    field('Words per caption', stt.opts.wordsPerCue, (v) => { stt.opts.wordsPerCue = +v || 3; }, 'number'),
  ]));

  const flags = document.createElement('div'); flags.className = 'btnrow';
  flags.append(btn(`${stt.opts.rebuildCaptions ? '✓' : '✗'} rebuild captions from the new transcript`,
    () => { stt.opts.rebuildCaptions = !stt.opts.rebuildCaptions; renderTranscribePanel(); }));
  box.appendChild(flags);

  // API keys (stored encrypted in the OS keychain by main; never read back here)
  box.appendChild(sep());
  // null means "not asked yet" — the keychain is only touched when a key is actually stored,
  // because on macOS even asking can raise a dialog that blocks the app.
  const kc = eng.keys?.keychain;
  box.appendChild(sechead('Remote engine keys'
    + (kc === true ? ' — stored in the OS keychain' : kc === false ? ' — no keychain available' : ' — encrypted with the OS keychain')));
  ['openai', 'elevenlabs'].forEach((provider) => {
    const f = field(`${provider} key ${eng.keys?.[provider] ? '(saved)' : ''}`, '', () => {}, 'password');
    const input = f.querySelector('input');
    const row = document.createElement('div'); row.className = 'btnrow';
    row.append(btn('Save key', async () => {
      if (!input.value.trim()) return setStatus('Paste the key first', 'error');
      // Saving encrypts through the OS keychain, and macOS can take its time about authorising
      // an app whose signature changed since the last key was stored. Say so, rather than
      // letting the window go quiet for no visible reason.
      setStatus('Saving to the OS keychain — macOS may ask you to allow it…', 'working');
      const r = await E.transcribe.setKey(provider, input.value);
      input.value = '';
      setStatus(r.ok ? `${provider} key saved` : 'Could not save key', r.ok ? 'ok' : 'error');
      stt.engines = await E.transcribe.engines(); renderTranscribePanel();
    }), btn('Clear', async () => {
      await E.transcribe.setKey(provider, '');
      stt.engines = await E.transcribe.engines(); renderTranscribePanel();
    }));
    box.appendChild(f); box.appendChild(row);
  });

  box.appendChild(sep());
  const go = btn(stt.busy ? 'Transcribing…' : 'Transcribe', runTranscribe, 'primary');
  go.disabled = stt.busy;
  box.appendChild(btnRow(go));
  if (stt.log.length) {
    const logBox = document.createElement('div'); logBox.className = 'ac-summary';
    logBox.textContent = stt.log.slice(-6).join('\n');
    box.appendChild(logBox);
  }
}

async function runTranscribe() {
  if (stt.busy) return;
  stt.busy = true; stt.log = []; renderTranscribePanel();
  setStatus('Transcribing…', 'working');
  const off = E.transcribe.onEvent(async (m) => {
    if (m.type === 'progress') {
      stt.log.push(`${m.stage}: ${m.detail || ''}`.trim());
      setStatus(`Transcribing — ${m.stage}`, 'working');
      renderTranscribePanel();
    }
    if (m.type === 'error') {
      stt.busy = false; off();
      setStatus('Transcribe failed: ' + String(m.error).slice(0, 140), 'error');
      stt.log.push('error: ' + m.error); renderTranscribePanel();
    }
    if (m.type === 'done') {
      stt.busy = false; off();
      setStatus(`Transcribed ${m.words} words${m.cues ? `, ${m.cues} captions` : ''}`, 'ok');
      stt.log.push(`done: ${m.words} words, ${m.cues || 0} cues (${m.engine})`);
      await loadProject();
      renderTranscribePanel();
    }
  });
  const r = await E.transcribe.start(stt.opts);
  if (r?.error) { stt.busy = false; off(); setStatus('Transcribe failed: ' + r.error, 'error'); renderTranscribePanel(); }
}

// ---------------------------------------------------------------- check
// The same verifier the agent is told to run before it says it is finished. A render takes
// minutes to reveal that a scene straddling a cut was dropped; this takes a second.
async function runVerify() {
  if (!project) return;
  setStatus('Checking the edit…', 'working');
  const r = await E.verify();
  if (r?.error) return setStatus('Check failed: ' + r.error, 'error');

  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'check';
  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'check';
  const when = document.createElement('span');
  when.textContent = r.ok ? 'nothing to fix' : `${r.errors} to fix · ${r.warnings} to consider`;
  title.append(kind, when);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const wrap = document.createElement('div'); wrap.className = 'autocut';
  const sum = document.createElement('div'); sum.className = 'ac-summary';
  sum.innerHTML = r.ok
    ? 'Nothing will be silently dropped: no element straddles a cut, no two panels share the card, '
      + 'every file it refers to is there.'
    : `<b>${r.errors}</b> thing(s) a render would get wrong · <b>${r.warnings}</b> worth a look`;
  wrap.appendChild(sum);

  if (r.issues?.length) {
    const list = document.createElement('div'); list.className = 'ac-list';
    r.issues.forEach((i) => {
      const row = document.createElement('div'); row.className = 'ac-item';
      const t = document.createElement('span'); t.className = 't'; t.textContent = i.severity === 'error' ? '✗' : '!';
      const lbl = document.createElement('span'); lbl.className = 'lbl';
      lbl.textContent = `${i.what} — ${i.detail}`;
      const rsn = document.createElement('span'); rsn.className = 'rsn ' + i.severity; rsn.textContent = i.severity;
      row.append(t, lbl, rsn);
      row.title = 'Fix: ' + i.fix;
      list.appendChild(row);
    });
    wrap.appendChild(list);
    wrap.appendChild(hint('Hover any line for what to do about it. Claude runs this same check '
      + 'before it says an edit is finished.'));
  }
  box.appendChild(wrap);
  setStatus(r.ok ? 'Check passed' : `Check found ${r.errors} error(s)`, r.ok ? 'ok' : 'error');
}

// ---------------------------------------------------------------- prepare (structural pass)
// One action, in the order the work actually depends on: words, then cuts, then who has the
// frame, then the pack's look and pacing. Everything it decides is written down with a reason,
// because the next pass — the one that makes it look good — is done by an agent reading this.
let prep = { busy: false, log: [] };

async function runPrepare() {
  if (!project || prep.busy) return;
  prep = { busy: true, log: [] };
  $('#btnPrepare').disabled = true;
  setStatus('Preparing the edit…', 'working');
  renderPreparePanel();

  const off = E.prepare.onEvent((m) => {
    if (m.type === 'progress') {
      prep.log.push(`${m.stage}: ${m.detail || ''}`);
      setStatus(`${m.stage}: ${m.detail || ''}`, 'working');
      renderPreparePanel(m.pct);
    }
    if (m.type === 'error') {
      prep.busy = false; off(); $('#btnPrepare').disabled = false;
      setStatus('Prepare failed: ' + m.error, 'error');
      prep.log.push('failed: ' + m.error);
      renderPreparePanel();
    }
    if (m.type === 'done') {
      prep.busy = false; off(); $('#btnPrepare').disabled = false;
      prep.result = m;
      setStatus(`Prepared — ${m.did?.length || 0} decisions written`, 'ok');
      loadProject().then(() => renderPreparePanel(100));
    }
  });

  const r = await E.prepare.start({
    template: project.meta?.template || project.brief?.template?.id || null,
    options: {},
  });
  if (r?.error) {
    prep.busy = false; off(); $('#btnPrepare').disabled = false;
    setStatus('Prepare failed: ' + r.error, 'error');
  }
}

function renderPreparePanel(pct) {
  const box = $('#inspector'); box.innerHTML = '';
  $('#selBadge').textContent = 'prepare';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'prepare';
  const when = document.createElement('span'); when.textContent = prep.busy ? 'working…' : 'the structural pass';
  title.append(kind, when);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const wrap = document.createElement('div'); wrap.className = 'autocut';

  if (prep.busy || pct != null) {
    const bar = document.createElement('div'); bar.className = 'progress';
    const fill = document.createElement('div'); fill.style.width = Math.max(3, Math.round(pct || 3)) + '%';
    bar.appendChild(fill); wrap.appendChild(bar);
  }

  const sum = document.createElement('div'); sum.className = 'ac-summary';
  const r = prep.result;
  sum.innerHTML = r
    ? `<b>${r.did?.length || 0}</b> decisions · <b>${r.cuts}</b> cuts · <b>${r.frames}</b> framing moves`
      + `<br><span class="dim">${r.words} words · ${r.stillOnTheTable} doubtful cuts left for you to judge</span>`
    : 'Transcribes, finds the cuts, works out when you should have the frame instead of the screen, '
      + 'applies the pack’s look and sizes the panels to what they say. Nothing is rendered.';
  wrap.appendChild(sum);

  if (r?.did?.length) {
    const list = document.createElement('div'); list.className = 'ac-list';
    r.did.forEach((line) => {
      const row = document.createElement('div'); row.className = 'ac-item';
      const t = document.createElement('span'); t.className = 't'; t.textContent = '✓';
      const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = line;
      row.append(t, lbl); list.appendChild(row);
    });
    wrap.appendChild(list);
  } else if (prep.log.length) {
    const list = document.createElement('div'); list.className = 'ac-list';
    prep.log.slice(-6).forEach((line) => {
      const row = document.createElement('div'); row.className = 'ac-item';
      const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = line;
      row.appendChild(lbl); list.appendChild(row);
    });
    wrap.appendChild(list);
  }

  if (!prep.busy) {
    wrap.appendChild(btnRow(
      btn(r ? 'Run it again' : 'Prepare my edit', () => runPrepare(), 'primary'),
      btn('Review the doubtful cuts', () => runAutoCut()),
      btn('Hand it to Claude', () => startAgentEdit()),
    ));
  }
  wrap.appendChild(hint('This is the structural pass. The next one — motion graphics, music, the '
    + 'final grade — is the agent’s, and it reads every decision made here from project.json.'));
  box.appendChild(wrap);
}

// ---------------------------------------------------------------- auto-cut
// Two signals, one answer: ffmpeg silencedetect for real dead air, the word-level
// transcript for fillers/stutters (and to guarantee we never clip speech).
let autocut = { proposals: [], stats: null, opts: { minSilence: 0.7, pad: 0.15, noiseDb: -35, fillers: true, stutters: true, softFillers: false } };

async function runAutoCut() {
  if (!project) return;
  setStatus('Analysing audio and transcript…', 'working');
  $('#btnAutoCut').disabled = true;
  const r = await E.autoCut(autocut.opts);
  $('#btnAutoCut').disabled = false;
  if (r.error) { setStatus('Auto-cut failed: ' + r.error, 'error'); return; }
  autocut.proposals = r.proposals.map((p) => ({ ...p, take: p.confidence !== 'low' }));
  autocut.stats = r.stats;
  setStatus(`Auto-cut found ${r.proposals.length} places to trim (${r.stats.removedSeconds}s)`, 'ok');
  renderAutoCutPanel();
}

function renderAutoCutPanel() {
  const box = $('#inspector');
  box.innerHTML = '';
  $('#selBadge').textContent = 'auto-cut';

  const h = document.createElement('h3');
  const title = document.createElement('div'); title.className = 'title';
  const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = 'auto-cut';
  const when = document.createElement('span'); when.textContent = `${autocut.proposals.length} proposals`;
  title.append(kind, when);
  h.append(title, btn('Close', () => renderInspector()));
  box.appendChild(h);

  const wrap = document.createElement('div'); wrap.className = 'autocut';

  const st = autocut.stats || {};
  const sum = document.createElement('div'); sum.className = 'ac-summary';
  const taken = autocut.proposals.filter((p) => p.take);
  const removed = taken.reduce((a, p) => a + (p.end - p.start), 0);
  sum.innerHTML = `Selected <b>${taken.length}</b> of ${autocut.proposals.length} · removes <b>${removed.toFixed(1)}s</b>` +
    ` · new length <b>${fmt(Math.max(0, dur - removed))}</b> (from ${fmt(dur)})` +
    `<br><span class="dim">${st.silences || 0} silences · ${st.words || 0} transcript words</span>`;
  wrap.appendChild(sum);

  // tuning
  const controls = document.createElement('div'); controls.className = 'ac-controls';
  controls.append(
    field('Min silence (s)', autocut.opts.minSilence, (v) => { autocut.opts.minSilence = +v; }, 'number'),
    field('Keep pad (s)', autocut.opts.pad, (v) => { autocut.opts.pad = +v; }, 'number'),
  );
  wrap.appendChild(controls);
  const presets = document.createElement('div'); presets.className = 'btnrow';
  const preset = (name, o) => btn(name, () => { Object.assign(autocut.opts, o); runAutoCut(); });
  presets.append(
    preset('Gentle', { minSilence: 1.2, pad: 0.25, noiseDb: -38, fillers: true, stutters: false, softFillers: false }),
    preset('Balanced', { minSilence: 0.7, pad: 0.15, noiseDb: -35, fillers: true, stutters: true, softFillers: false }),
    preset('Tight', { minSilence: 0.45, pad: 0.08, noiseDb: -32, fillers: true, stutters: true, softFillers: true }),
  );
  wrap.appendChild(presets);

  const toggles = document.createElement('div'); toggles.className = 'btnrow';
  const tog = (label, key) => btn(`${autocut.opts[key] ? '✓' : '✗'} ${label}`, () => { autocut.opts[key] = !autocut.opts[key]; renderAutoCutPanel(); });
  toggles.append(tog('fillers', 'fillers'), tog('stutters', 'stutters'), tog('“like/actually”', 'softFillers'),
    btn('Re-analyse', () => runAutoCut()));
  wrap.appendChild(toggles);

  // proposals
  const list = document.createElement('div'); list.className = 'ac-list';
  autocut.proposals.forEach((p, i) => {
    const row = document.createElement('div'); row.className = 'ac-item';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.take;
    // update in place: re-rendering the whole list on every tick loses the user's scroll
    cb.onclick = (ev) => { ev.stopPropagation(); p.take = cb.checked; refreshAutoCutTotals(); };
    const t = document.createElement('span'); t.className = 't'; t.textContent = fmt(p.start);
    const lbl = document.createElement('span'); lbl.className = 'lbl'; lbl.textContent = p.label;
    const rsn = document.createElement('span'); rsn.className = 'rsn ' + p.reason; rsn.textContent = p.reason;
    row.append(cb, t, lbl, rsn);
    row.onclick = () => { video.currentTime = clamp(p.start - 0.6, 0, dur); video.play().catch(() => {});
      setTimeout(() => video.pause(), Math.min(4000, (p.end - p.start + 1.4) * 1000)); };
    row.title = `${p.start}s → ${p.end}s · ${p.confidence} confidence · click to hear it`;
    list.appendChild(row);
  });
  wrap.appendChild(list);

  const actions = document.createElement('div'); actions.className = 'btnrow';
  actions.append(
    btn('Select all', () => { autocut.proposals.forEach((p) => { p.take = true; });
      document.querySelectorAll('.ac-item input').forEach((c) => { c.checked = true; }); refreshAutoCutTotals(); }),
    btn('Select none', () => { autocut.proposals.forEach((p) => { p.take = false; });
      document.querySelectorAll('.ac-item input').forEach((c) => { c.checked = false; }); refreshAutoCutTotals(); }),
    btn(`Apply ${taken.length} cuts`, applyAutoCut, 'primary'),
  );
  wrap.appendChild(actions);
  wrap.appendChild(hint('Applying adds these to the Cuts track. Nothing is destroyed — remove any cut on the timeline to get the moment back. Export splices the video and re-times every caption, scene, overlay and audio layer.'));
  box.appendChild(wrap);
}

// Keep the summary and the Apply button honest without rebuilding the list.
function refreshAutoCutTotals() {
  const taken = autocut.proposals.filter((p) => p.take);
  const removed = taken.reduce((a, p) => a + (p.end - p.start), 0);
  const sum = $('#inspector .ac-summary');
  if (sum) {
    const st = autocut.stats || {};
    sum.innerHTML = `Selected <b>${taken.length}</b> of ${autocut.proposals.length} · removes <b>${removed.toFixed(1)}s</b>` +
      ` · new length <b>${fmt(Math.max(0, dur - removed))}</b> (from ${fmt(dur)})` +
      `<br><span class="dim">${st.silences || 0} silences · ${st.words || 0} transcript words</span>`;
  }
  const apply = [...document.querySelectorAll('#inspector button')].find((b) => /^Apply/.test(b.textContent));
  if (apply) { apply.textContent = `Apply ${taken.length} cuts`; apply.disabled = taken.length === 0; }
}

function applyAutoCut() {
  const taken = autocut.proposals.filter((p) => p.take);
  if (!taken.length) return;
  project.cuts = project.cuts || [];
  taken.forEach((p) => project.cuts.push({ start: p.start, end: p.end, source: 'auto:' + p.reason }));
  project.cuts.sort((a, b) => a.start - b.start);
  // merge anything that now overlaps, so the engine never sees nested cuts
  const merged = [];
  for (const c of project.cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 0.02) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  project.cuts = merged;
  autocut.proposals = autocut.proposals.filter((p) => !p.take);
  save(); renderTimeline();
  setStatus(`Applied ${taken.length} cuts — export to see them`, 'ok');
  renderAutoCutPanel();
}

// ---------------------------------------------------------------- render / export
let offRender = null;
function runRender({ range, out, label }) {
  setStatus(label + '…', 'working');
  busy(true);
  offRender?.();
  offRender = E.render.onEvent((m) => {
    if (job && m.id !== job) return;
    if (m.type === 'progress') {
      setStatus(`${label} — ${m.stage} ${m.pct}%`, 'working');
      $('#progressBar').style.width = clamp(m.pct, 0, 100) + '%';
    }
    if (m.type === 'stall') setStatus(`${label} — no output for ${Math.round(m.idleMs / 1000)}s, still waiting`, 'working');
    if (m.type === 'error') { finish(); setStatus(label + ' failed: ' + String(m.error).slice(0, 120), 'error'); }
    if (m.type === 'done') {
      finish();
      if (m.code === 0) {
        const secs = m.result?.duration ? ` (${(+m.result.duration).toFixed(1)}s)` : '';
        setStatus(`${label} done${secs}`, 'ok');
        loadVideo(out.split('/').pop(), range ? range[0] : 0);
      } else setStatus(`${label} failed (exit ${m.code}) — ${String(m.tail || '').slice(-140)}`, 'error');
    }
  });
  E.render.start({ out, range }).then((r) => { job = r.id; });

  function finish() { busy(false); offRender?.(); offRender = null; job = null; }
}
function busy(on) {
  $('#btnPreview').disabled = $('#btnExport').disabled = on;
  $('#btnCancel').hidden = !on;
  $('#progress').hidden = !on;
  if (!on) $('#progressBar').style.width = '0%';
}
function previewAround(start, span) {
  const a = Math.max(0, start - 2), b = Math.min(dur, start + (span || 8) + 2);
  runRender({ range: [+a.toFixed(1), +b.toFixed(1)], out: 'preview.mp4', label: 'Preview' });
}
$('#btnCancel').onclick = () => { if (job) { E.render.cancel(job); setStatus('Cancelling…', 'working'); } };
$('#btnPreview').onclick = () => {
  const e = elemOf(sel);
  previewAround(e ? (e.start || 0) : video.currentTime, e?.dur);
};
$('#btnExport').onclick = () => runRender({ range: null, out: 'FINAL.mp4', label: 'Export' });

// ---------------------------------------------------------------- keyboard
function initKeys() {
  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) ||
      document.activeElement?.closest?.('#terminal');
    if (typing) return;
    const frame = 1 / (fps || 30);
    switch (ev.key) {
      case ' ': ev.preventDefault(); video.paused ? video.play() : video.pause(); break;
      case 'ArrowLeft': ev.preventDefault(); video.currentTime = clamp(video.currentTime - (ev.shiftKey ? 1 : frame), 0, dur); break;
      case 'ArrowRight': ev.preventDefault(); video.currentTime = clamp(video.currentTime + (ev.shiftKey ? 1 : frame), 0, dur); break;
      case 'Home': video.currentTime = 0; break;
      case 'End': video.currentTime = Math.max(0, dur - 0.1); break;
      case 's': case 'S': if (project) addCut(); break;
      case 'Backspace': case 'Delete':
        if (tx.open && tx.sel) { ev.preventDefault(); cutSelection(); }
        else if (sel) { ev.preventDefault(); remove(); }
        break;
      case 'Escape': if (homeOpen) hideHome(); else deselect(); break;
      case 'h': case 'H': homeOpen ? hideHome() : showHome(); break;
      case '=': case '+': setZoom(zoom * 1.5); break;
      case '-': case '_': setZoom(zoom / 1.5); break;
      case 'f': case 'F': fitZoom(); renderTimeline(); break;
      case 'a': case 'A': runAutoCut(); break;
      case 't': case 'T': openTemplatesPanel(); break;
      case 'l': case 'L': openLookPanel(); break;
      case 'd': case 'D': openTranscriptEditor(); break;
      case 'p': case 'P': $('#btnPreview').click(); break;
      case 'e': case 'E': $('#btnExport').click(); break;
      default: return;
    }
  });
}

// ---------------------------------------------------------------- splitters
function initSplitters() {
  drag($('#splitTimeline'), 'y', (dy) => {
    const p = $('#timelinePanel');
    p.style.height = clamp(p.getBoundingClientRect().height + dy, 132, window.innerHeight - 260) + 'px';
    renderTimeline();
  });
  drag($('#splitRail'), 'x', (dx) => {
    const r = $('#rail');
    r.style.width = clamp(r.getBoundingClientRect().width + dx, 260, window.innerWidth - 520) + 'px';
    renderTimeline();
  });
  drag($('#splitTerm'), 'y', (dy) => {
    const t = $('.term');
    t.style.height = clamp(t.getBoundingClientRect().height + dy, 80, window.innerHeight - 220) + 'px';
    window.dispatchEvent(new Event('resize'));
  });
}
function drag(handle, axis, onDelta) {
  if (!handle) return;
  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    let last = axis === 'x' ? ev.clientX : ev.clientY;
    const move = (e) => {
      const now = axis === 'x' ? e.clientX : e.clientY;
      onDelta(last - now); last = now;
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}

// ---------------------------------------------------------------- terminal
async function initTerminal() {
  if (!window.Terminal) { $('#terminal').textContent = 'terminal library not loaded'; return; }
  const term = new Terminal({
    fontSize: 12, cursorBlink: true, allowProposedApi: true, fontFamily: 'SFMono-Regular, Menlo, monospace',
    theme: { background: '#0b0c10', foreground: '#e7e9ee', cursor: '#c4d82e', selectionBackground: '#33405a' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit); term.open($('#terminal')); fit.fit();
  E.term.onData((d) => { term.write(d); window.__cve.termLog = (window.__cve.termLog + d).slice(-8000); });
  E.term.onExit(() => term.write('\r\n[shell exited]\r\n'));
  term.onData((d) => E.term.write(d));
  const r = await E.term.start();
  if (!r?.ok) term.write('\r\n[terminal failed to start]\r\n');
  const doFit = () => { try { fit.fit(); E.term.resize(term.cols, term.rows); } catch {} };
  doFit();
  window.addEventListener('resize', doFit);
  new ResizeObserver(doFit).observe($('#terminal'));
}

// ---------------------------------------------------------------- utils
function fmt(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtMs(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

boot();
