// Cutwright — renderer.
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
  get zoom() { return zoom; }, loadVideo: (n, s) => loadVideo(n, s), termLog: '',
};

// ---------------------------------------------------------------- boot
async function boot() {
  const cfg = await E.config();
  WORK = cfg.work;
  $('#work').textContent = cfg.work ? cfg.work.replace(/^.*\//, '') : 'no workspace';
  $('#btnWorkspace').title = cfg.work || 'Choose a workspace';
  if (!cfg.hasWorkspace) { showWelcome(cfg); initTerminal(); return; }

  await loadProject();
  loadVideo('FINAL.mp4');
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
    await loadProject(); loadVideo('FINAL.mp4');
  });
  $('#btnWorkspace').onclick = () => E.chooseWorkspace();
}

function showWelcome(cfg) {
  $('#welcome').hidden = false;
  $('#wOpen').onclick = () => E.chooseWorkspace().then((r) => r?.ok && location.reload());
  const box = $('#wRecent'); box.innerHTML = '';
  (cfg.recent || []).forEach((dir) => {
    const b = document.createElement('button');
    b.textContent = dir;
    b.onclick = () => E.openWorkspace(dir).then((r) => r?.ok && location.reload());
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
  $('#tcDur').textContent = fmt(dur);
  renderTimeline(); renderInspector();
  setStatus('Project reloaded — edited on disk', 'ok');
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

  $('#btnZoomIn').onclick = () => setZoom(zoom * 1.5);
  $('#btnZoomOut').onclick = () => setZoom(zoom / 1.5);
  $('#btnFit').onclick = () => { fitZoom(); renderTimeline(); $('#tlScroll').scrollLeft = 0; };
  $('#btnAutoCut').onclick = () => runAutoCut();
  $('#btnTranscribe').onclick = () => openTranscribePanel();
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
    box.innerHTML = '<div class="empty">Select a scene, caption, cut, overlay or audio layer on the timeline.</div>';
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

function remove() {
  if (!sel) return;
  if (sel.kind === 'scene') project.scenes.splice(sel.index, 1);
  else if (sel.kind === 'caption') project.captions.cues.splice(sel.index, 1);
  else if (sel.kind === 'cut') project.cuts.splice(sel.index, 1);
  else if (sel.kind === 'overlay') project.overlays.splice(sel.index, 1);
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
  box.appendChild(sechead('Remote engine keys' + (eng.keys?.keychain ? ' — stored in the OS keychain' : ' — no keychain available')));
  ['openai', 'elevenlabs'].forEach((provider) => {
    const f = field(`${provider} key ${eng.keys?.[provider] ? '(saved)' : ''}`, '', () => {}, 'password');
    const input = f.querySelector('input');
    const row = document.createElement('div'); row.className = 'btnrow';
    row.append(btn('Save key', async () => {
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
    cb.onclick = (ev) => { ev.stopPropagation(); p.take = cb.checked; renderAutoCutPanel(); };
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
    btn('Select all', () => { autocut.proposals.forEach((p) => { p.take = true; }); renderAutoCutPanel(); }),
    btn('Select none', () => { autocut.proposals.forEach((p) => { p.take = false; }); renderAutoCutPanel(); }),
    btn(`Apply ${taken.length} cuts`, applyAutoCut, 'primary'),
  );
  wrap.appendChild(actions);
  wrap.appendChild(hint('Applying adds these to the Cuts track. Nothing is destroyed — remove any cut on the timeline to get the moment back. Export splices the video and re-times every caption, scene, overlay and audio layer.'));
  box.appendChild(wrap);
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
      case 'Backspace': case 'Delete': if (sel) { ev.preventDefault(); remove(); } break;
      case 'Escape': deselect(); break;
      case '=': case '+': setZoom(zoom * 1.5); break;
      case '-': case '_': setZoom(zoom / 1.5); break;
      case 'f': case 'F': fitZoom(); renderTimeline(); break;
      case 'a': case 'A': runAutoCut(); break;
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
