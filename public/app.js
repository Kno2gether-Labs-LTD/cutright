// Claude Video Editor — frontend
const $ = s => document.querySelector(s);
const api = (p, o) => fetch('/api' + p, o).then(r => r.json());
let project = null, dur = 1, sel = null;   // sel = {kind, index}
const video = $('#video');

async function boot() {
  const cfg = await api('/config'); $('#work').textContent = cfg.work;
  await loadProject();
  loadVideo('FINAL.mp4');
  initTerminal();
  window.addEventListener('resize', renderTimeline);
  requestAnimationFrame(tickPlayhead);
}
async function loadProject() {
  project = await api('/project');
  if (project.error) { setStatus(project.error); return; }
  dur = project.meta.duration;
  renderTimeline();
}
function loadVideo(name, seek) {
  $('#previewTag').textContent = name;
  video.src = '/api/video?f=' + name + '&_=' + Date.now();
  if (seek != null) video.addEventListener('loadedmetadata', () => { video.currentTime = seek; }, { once: true });
}
function setStatus(t) { $('#status').textContent = t || ''; }

// ---------- timeline ----------
function laneW() { return $('#laneScenes').clientWidth; }
function x2t(px) { return px / laneW() * dur; }
function t2x(t) { return t / dur * laneW(); }

function renderTimeline() {
  if (!project) return;
  // ruler
  const r = $('#ruler'); r.innerHTML = '';
  const step = dur > 1200 ? 120 : dur > 300 ? 60 : 15;
  for (let t = 0; t <= dur; t += step) {
    const d = document.createElement('div'); d.className = 'tick'; d.style.left = t2x(t) + 'px';
    d.textContent = fmt(t); r.appendChild(d);
  }
  // scenes
  const ls = $('#laneScenes'); ls.innerHTML = '';
  (project.scenes || []).forEach((s, i) => {
    const b = document.createElement('div'); b.className = 'block scene ' + s.type;
    b.style.left = t2x(s.start) + 'px'; b.style.width = Math.max(24, t2x(s.dur)) + 'px';
    b.textContent = s.headline || s.type; b.title = `${s.type} @ ${fmt(s.start)}`;
    b.onclick = () => select('scene', i); if (sel?.kind === 'scene' && sel.index === i) b.classList.add('selected');
    ls.appendChild(b);
  });
  // captions (ticks)
  const lc = $('#laneCaps'); lc.innerHTML = '';
  (project.captions.cues || []).forEach((c, i) => {
    const t = document.createElement('div'); t.className = 'cap' + (c.tokens.some(x => x.e) ? ' emph' : '');
    t.style.left = t2x(c.start) + 'px'; t.title = c.tokens.map(x => x.t).join(' ');
    t.onclick = () => select('caption', i); if (sel?.kind === 'caption' && sel.index === i) t.classList.add('selected');
    lc.appendChild(t);
  });
  // cuts
  const lcut = $('#laneCuts'); [...lcut.querySelectorAll('.cutblock')].forEach(n => n.remove());
  (project.cuts || []).forEach((c, i) => {
    const b = document.createElement('div'); b.className = 'cutblock';
    b.style.left = t2x(c.start) + 'px'; b.style.width = Math.max(6, t2x(c.end - c.start)) + 'px';
    b.title = `cut ${fmt(c.start)}–${fmt(c.end)}`; b.onclick = () => select('cut', i);
    if (sel?.kind === 'cut' && sel.index === i) b.classList.add('selected'); lcut.appendChild(b);
  });
  // audio
  const la = $('#laneAudio'); [...la.querySelectorAll('.audioclip')].forEach(n => n.remove());
  const audio = project.audio || { music: [], sfx: [] };
  [['music', audio.music], ['sfx', audio.sfx]].forEach(([kind, arr]) => (arr || []).forEach((L, i) => {
    const b = document.createElement('div'); b.className = 'audioclip';
    b.style.left = t2x(L.start || 0) + 'px'; b.style.width = Math.max(30, t2x(L.dur || 4)) + 'px';
    b.textContent = kind + ':' + (L.src || '').split('/').pop(); b.onclick = () => select(kind, i);
    la.appendChild(b);
  }));
}

// ---------- selection + inspector ----------
function select(kind, index) { sel = { kind, index }; renderTimeline(); renderInspector(); const el = elemOf(sel); if (el) video.currentTime = (el.start || 0); }
function elemOf(s) {
  if (!s) return null;
  if (s.kind === 'scene') return project.scenes[s.index];
  if (s.kind === 'caption') return project.captions.cues[s.index];
  if (s.kind === 'music') return project.audio.music[s.index];
  if (s.kind === 'sfx') return project.audio.sfx[s.index];
  if (s.kind === 'cut') return project.cuts[s.index];
}
function field(label, val, on, type = 'text') {
  const f = document.createElement('div'); f.className = 'field';
  f.innerHTML = `<label>${label}</label>`;
  const inp = document.createElement(type === 'area' ? 'textarea' : 'input');
  if (type !== 'area') inp.type = type; inp.value = val ?? '';
  inp.oninput = () => on(inp.value); f.appendChild(inp); return f;
}
function renderInspector() {
  const box = $('#inspector'); box.innerHTML = '';
  const e = elemOf(sel); if (!e) { box.innerHTML = '<div class="empty">Select an element on the timeline to edit it.</div>'; return; }
  const h = document.createElement('h3');
  h.innerHTML = `<span>${sel.kind.toUpperCase()} — ${fmt(e.start||0)}</span>`;
  const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Delete'; del.onclick = () => remove();
  h.appendChild(del); box.appendChild(h);

  if (sel.kind === 'caption') {
    const toks = document.createElement('div'); toks.className = 'tokens';
    e.tokens.forEach((tk, i) => { const s = document.createElement('span'); s.className = 'tok' + (tk.e ? ' e' : '');
      s.textContent = tk.t; s.title = 'click: toggle highlight · dblclick: edit text';
      s.onclick = () => { tk.e = !tk.e; save(); renderInspector(); };
      s.ondblclick = () => { const v = prompt('Edit word', tk.t); if (v != null) { tk.t = v; save(); renderInspector(); } };
      toks.appendChild(s); });
    const wrap = document.createElement('div'); wrap.className = 'field';
    wrap.innerHTML = '<label>Words</label>'; wrap.appendChild(toks); box.appendChild(wrap);
    box.appendChild(field('Full text', e.tokens.map(t => t.t).join(' '), v => { const ws = v.split(/\s+/).filter(Boolean); e.tokens = ws.map((w, i) => ({ t: w, e: e.tokens[i]?.e || false })); save(); }));
    const o = e.overrides = e.overrides || {};
    box.appendChild(rowOf([
      field('Start', e.start, v => { e.start = +v; save(); renderTimeline(); }, 'number'),
      field('End', e.end, v => { e.end = +v; save(); }, 'number'),
    ]));
    box.appendChild(rowOf([
      field('Y pos', o.cy ?? project.captions.defaults.cy, v => { o.cy = +v; save(); }, 'number'),
      field('Size', o.fontsize ?? project.captions.defaults.fontsize, v => { o.fontsize = +v; save(); }, 'number'),
      field('Highlight', o.highlight ?? project.captions.defaults.highlight, v => { o.highlight = v; save(); }),
    ]));
    box.appendChild(defaultsRow());
  } else if (sel.kind === 'scene') {
    box.appendChild(field('Headline', e.headline, v => { e.headline = v; save(); renderTimeline(); }));
    box.appendChild(rowOf([
      field('Type', e.type, v => { e.type = v; save(); }),
      field('Start', e.start, v => { e.start = +v; save(); renderTimeline(); }, 'number'),
      field('Duration', e.dur, v => { e.dur = +v; save(); renderTimeline(); }, 'number'),
    ]));
    if (e.items) box.appendChild(field('Items (one per line: TEXT|color)', e.items.map(it => typeof it === 'string' ? it : `${it.text}|${it.color || 'white'}`).join('\n'),
      v => { e.items = v.split('\n').filter(Boolean).map(l => { const [t, c] = l.split('|'); return e.type === 'checklist' ? t.trim() : { text: t.trim(), color: (c || 'white').trim() }; }); save(); }, 'area'));
    if (e.big != null) box.appendChild(field('Big text', e.big, v => { e.big = v; save(); }));
    if (e.sub != null) box.appendChild(field('Sub', e.sub, v => { e.sub = v; save(); }));
    if (e.target != null) box.appendChild(field('Counter target', e.target, v => { e.target = +v; save(); }, 'number'));
    if (e.old != null) { box.appendChild(field('Old (struck)', e.old, v => { e.old = v; save(); })); box.appendChild(field('New', e.new, v => { e.new = v; save(); })); }
  } else if (sel.kind === 'cut') {
    box.appendChild(hint('This range is REMOVED on Export — the video splices together and captions/scenes/audio after it shift earlier. (Preview shows the original timeline.)'));
    box.appendChild(rowOf([
      field('Cut start', e.start, v => { e.start = +v; save(); renderTimeline(); }, 'number'),
      field('Cut end', e.end, v => { e.end = +v; save(); renderTimeline(); }, 'number'),
    ]));
    const set = document.createElement('div'); set.className = 'field';
    const b1 = document.createElement('button'); b1.textContent = 'Set start = playhead'; b1.onclick = () => { e.start = +video.currentTime.toFixed(2); save(); renderInspector(); renderTimeline(); };
    const b2 = document.createElement('button'); b2.textContent = 'Set end = playhead'; b2.onclick = () => { e.end = +video.currentTime.toFixed(2); save(); renderInspector(); renderTimeline(); };
    set.append(b1, b2); box.appendChild(set);
  } else { // audio
    box.appendChild(field('Source path', e.src, v => { e.src = v; save(); renderTimeline(); }));
    box.appendChild(rowOf([
      field('Start', e.start || 0, v => { e.start = +v; save(); renderTimeline(); }, 'number'),
      field('Dur', e.dur || 4, v => { e.dur = +v; save(); renderTimeline(); }, 'number'),
      field('Gain dB', e.gain ?? -18, v => { e.gain = +v; save(); }, 'number'),
    ]));
    box.appendChild(rowOf([ field('Fade in', e.fadeIn || 0, v => { e.fadeIn = +v; save(); }, 'number'),
      field('Fade out', e.fadeOut || 0, v => { e.fadeOut = +v; save(); }, 'number') ]));
    box.appendChild(hint('Tip: ask Claude in the terminal to generate & add music/SFX (ElevenLabs), then it appears here to finalize.'));
  }
  box.appendChild(hint('Edits save automatically. Use “Preview section” to render this spot, or “Export” for the full video.'));
}
function defaultsRow() {
  const d = project.captions.defaults; const box = document.createElement('div');
  box.appendChild(hint('All captions (defaults):'));
  box.appendChild(rowOf([
    field('All Y pos', d.cy, v => { d.cy = +v; save(); }, 'number'),
    field('All size', d.fontsize, v => { d.fontsize = +v; save(); }, 'number'),
    field('All highlight', d.highlight, v => { d.highlight = v; save(); }),
  ]));
  return box;
}
function rowOf(fields) { const r = document.createElement('div'); r.className = 'row'; fields.forEach(f => r.appendChild(f)); return r; }
function hint(t) { const p = document.createElement('div'); p.className = 'small'; p.textContent = t; p.style.margin = '6px 0'; return p; }
function remove() {
  if (sel.kind === 'scene') project.scenes.splice(sel.index, 1);
  else if (sel.kind === 'caption') project.captions.cues.splice(sel.index, 1);
  else if (sel.kind === 'cut') project.cuts.splice(sel.index, 1);
  else project.audio[sel.kind].splice(sel.index, 1);
  sel = null; save(); renderTimeline(); renderInspector();
}

// ---------- save (debounced) ----------
let saveT, lastEdit = 0; function save() { lastEdit = Date.now(); setStatus('● unsaved'); clearTimeout(saveT); saveT = setTimeout(async () => { await api('/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(project) }); lastEdit = Date.now(); setStatus('saved'); }, 400); }

// ---------- add cut / audio ----------
document.addEventListener('click', e => {
  const k = e.target.dataset?.add; if (k) {
    if (k === 'cut') { project.cuts = project.cuts || []; const t = +video.currentTime.toFixed(2);
      project.cuts.push({ start: t, end: Math.min(dur, t + 2) }); save(); renderTimeline(); select('cut', project.cuts.length - 1); return; }
    project.audio = project.audio || { music: [], sfx: [] }; project.audio[k] = project.audio[k] || [];
    project.audio[k].push({ id: k + Date.now(), src: '', start: Math.round(video.currentTime), dur: k === 'music' ? 30 : 1, gain: k === 'music' ? -18 : -6 });
    save(); renderTimeline(); select(k, project.audio[k].length - 1); return;
  }
  if (e.target.dataset?.gen) genAudio();
});
async function genAudio() {
  const kind = prompt('Generate what? type: sfx | voice | music', 'sfx'); if (!kind) return;
  const text = prompt(kind === 'voice' ? 'Voiceover text:' : 'Describe the ' + kind + ':', kind === 'sfx' ? 'whoosh transition' : ''); if (!text) return;
  const at = +(kind === 'music' ? 0 : video.currentTime).toFixed(1);
  setStatus('generating ' + kind + ' (ElevenLabs)…');
  const r = await api('/audio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, text, at }) });
  if (r.ok) { setStatus(kind + ' added ✓'); await loadProject(); } else setStatus('audio gen failed: ' + (r.error || '').slice(0, 80));
}

// ---------- render / export ----------
function runRender(params, out, label) {
  setStatus(label + '…'); $('#btnPreview').disabled = $('#btnExport').disabled = true;
  const q = new URLSearchParams({ out, ...params });
  const es = new EventSource('/api/render?' + q);
  es.onmessage = ev => { const m = JSON.parse(ev.data);
    if (m.type === 'progress') setStatus(label + ' ' + m.t);
    if (m.type === 'done') { es.close(); $('#btnPreview').disabled = $('#btnExport').disabled = false;
      if (m.code === 0) { setStatus(label + ' ✓'); loadVideo(out, params.a ? +params.a : 0); }
      else setStatus(label + ' failed'); }
  };
  es.onerror = () => { es.close(); $('#btnPreview').disabled = $('#btnExport').disabled = false; setStatus('render error'); };
}
$('#btnPreview').onclick = () => { const e = elemOf(sel); const c = e ? (e.start || 0) : video.currentTime;
  runRender({ a: Math.max(0, c - 2).toFixed(1), b: (c + ((elemOf(sel)?.dur) || 8) + 2).toFixed(1) }, 'preview.mp4', 'Preview'); };
$('#btnExport').onclick = () => runRender({}, 'FINAL.mp4', 'Export');

// ---------- playhead ----------
function tickPlayhead() { $('#playhead').style.left = (74 + t2x(video.currentTime || 0)) + 'px'; requestAnimationFrame(tickPlayhead); }
$('#ruler').onclick = e => { const rect = e.currentTarget.getBoundingClientRect(); video.currentTime = x2t(e.clientX - rect.left); };

// ---------- terminal ----------
function initTerminal() {
  if (!window.Terminal) { $('#terminal').textContent = 'terminal lib not loaded (offline?)'; return; }
  const term = new Terminal({ fontSize: 12, theme: { background: '#0b0c10' }, cursorBlink: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('#terminal')); fit.fit();
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/pty');
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.t === 'out') term.write(d.d); };
  term.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'in', d })));
  const doFit = () => { fit.fit(); ws.readyState === 1 && ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows })); };
  ws.onopen = doFit; window.addEventListener('resize', doFit);
  // reload project when it changes on disk (e.g. Claude edited it)
  setInterval(async () => { if (Date.now() - lastEdit < 3000) return; // don't clobber a fresh local edit
    const p = await api('/project'); if (JSON.stringify(p) !== JSON.stringify(project)) { project = p; dur = p.meta.duration; renderTimeline(); if (sel) renderInspector(); setStatus('project reloaded (Claude edited it)'); } }, 4000);
}
function fmt(t) { t = Math.max(0, Math.round(t)); return (t/60|0) + ':' + String(t % 60).padStart(2, '0'); }
boot();
