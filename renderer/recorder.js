// Recorder — the renderer half. MediaRecorder only exists here, so this window captures and
// streams chunks to main; main owns the disk. Kept deliberately small.
const $ = (s) => document.querySelector(s);
const R = window.rec;

let sources = [], chosen = null, media = {}, recorders = [], pending = [], ticker = null, paused = false;

// ---------------------------------------------------------------- setup
async function boot() {
  const perms = await R.permissions();
  const warn = $('#permWarn');
  const missing = [];
  if (perms.screen !== 'granted') missing.push('Screen Recording');
  if (perms.microphone !== 'granted') missing.push('Microphone');
  if (missing.length) {
    warn.hidden = false;
    warn.textContent = `${missing.join(' and ')} permission is not granted yet. macOS will ask when you start — if it does not, enable it in System Settings → Privacy & Security.`;
  }
  // Say this before they go and grant something, not after it quietly stops working.
  if (perms.stableIdentity === false) {
    const note = $('#signWarn');
    note.hidden = false;
    note.textContent = 'This build is not signed with a certificate, so macOS treats every update '
      + 'as a different app — you will have to grant Screen Recording again after each one. '
      + 'Building with a signing certificate fixes that.';
  }

  const listed = await R.sources();
  sources = listed.sources || listed;               // tolerate the older flat shape
  if (listed.screenCaptureDenied) {
    warn.hidden = false;
    warn.innerHTML = 'macOS is not letting Cutright see your displays, so only windows are listed '
      + '(and a recording would come out empty). Open <b>Privacy &amp; Security → Screen Recording</b>, '
      + 'switch Cutright on — if it is already on, switch it off and on again — then quit and reopen the app. '
      + '<button type="button" id="btnPrivacy" class="link">Open the setting</button>';
    warn.querySelector('#btnPrivacy').onclick = () => R.privacy();
  }
  const list = $('#sourceList');
  list.innerHTML = '';
  sources.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'rec-src' + (i === 0 ? ' sel' : '');
    b.innerHTML = (s.thumbnail
        ? `<img src="${s.thumbnail}" alt="">`
        : `<span class="rec-noshot">${s.screen ? 'screen' : 'window'} — no preview available</span>`)
      + `<span>${s.screen ? 'Screen — ' : ''}${s.name}</span>`;
    b.onclick = () => { chosen = s.id; [...list.children].forEach((c) => c.classList.remove('sel')); b.classList.add('sel'); };
    list.appendChild(b);
  });
  chosen = sources[0]?.id || null;

  await listDevices();
  $('#useCam').onchange = async (e) => {
    $('#camDevice').disabled = !e.target.checked;
    if (e.target.checked) await showCamPreview(); else stopCamPreview();
  };
  $('#useMic').onchange = (e) => { $('#micDevice').disabled = !e.target.checked; };
  $('#camDevice').onchange = () => { if ($('#useCam').checked) showCamPreview(); };
  $('#btnStart').onclick = start;
  $('#btnCancel').onclick = () => R.close();
  // The overlay is the only thing on screen while recording, so its buttons have to reach the
  // same handlers as this window's.
  R.onRemote((kind) => {
    if (kind === 'stop') stop();
    else if (kind === 'pause') togglePause();
    else if (kind === 'mark') R.mark('mark');
  });
  $('#btnPause').onclick = togglePause;
  $('#btnStop').onclick = stop;
  $('#btnMark').onclick = () => { R.mark('mark'); flash('#btnMark'); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' || e.key === 'M') { R.mark('mark'); flash('#btnMark'); }
    if (e.key === 'Escape' && !recorders.length) R.close();
  });
}

async function listDevices() {
  // labels only appear once permission exists; ask for a throwaway stream if needed
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some((d) => d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* the user can still record without a mic */ }
  }
  const fill = (sel, kind, none) => {
    const el = $(sel); el.innerHTML = '';
    devices.filter((d) => d.kind === kind).forEach((d) => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || kind;
      el.appendChild(o);
    });
    if (!el.children.length) { const o = document.createElement('option'); o.textContent = none; el.appendChild(o); el.disabled = true; }
  };
  fill('#micDevice', 'audioinput', 'no microphone found');
  fill('#camDevice', 'videoinput', 'no camera found');
  $('#camDevice').disabled = !$('#useCam').checked;
}

async function showCamPreview() {
  stopCamPreview();
  try {
    const id = $('#camDevice').value;
    media.camPreview = await navigator.mediaDevices.getUserMedia({
      video: id ? { deviceId: { exact: id } } : true, audio: false });
    const v = $('#camPreview'); v.srcObject = media.camPreview; v.hidden = false;
  } catch (e) { note('Camera unavailable: ' + e.message); }
}
function stopCamPreview() {
  media.camPreview?.getTracks().forEach((t) => t.stop());
  media.camPreview = null;
  const v = $('#camPreview'); v.srcObject = null; v.hidden = true;
}
const note = (t) => { $('#recNote').textContent = t; };
const flash = (sel) => { const b = $(sel); b.classList.add('primary'); setTimeout(() => b.classList.remove('primary'), 400); };

// ---------------------------------------------------------------- recording
async function start() {
  if (!chosen) return note('Pick a screen or window first.');
  $('#btnStart').disabled = true;
  const wantMic = $('#useMic').checked, wantCam = $('#useCam').checked;

  try {
    // A test may hand us a stream instead of asking the OS for one. Everything after this point
    // — the count-in, the controls, chunking, stop, finalising — is identical, so the whole
    // lifecycle can be exercised on a machine that has not granted Screen Recording. It is the
    // capture itself that is substituted, and nothing else.
    if (window.__recTestStream) {
      media.screen = window.__recTestStream();
    } else
    media.screen = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: chosen,
                            maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30 } },
    });
    if (wantMic) {
      const id = $('#micDevice').value;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: id ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: true } : true });
      mic.getAudioTracks().forEach((t) => media.screen.addTrack(t));   // one file, picture + voice
      media.mic = mic;
    }
    if (wantCam) {
      stopCamPreview();
      const id = $('#camDevice').value;
      media.camera = await navigator.mediaDevices.getUserMedia({
        video: id ? { deviceId: { exact: id }, width: 1280, height: 720 } : true, audio: false });
    }
  } catch (e) {
    $('#btnStart').disabled = false;
    return note('Could not start: ' + e.message + ' — check Screen Recording permission in System Settings.');
  }

  const started = await R.start({ name: $('#recName').value, screenId: chosen, camera: wantCam, mic: wantMic });
  if (started?.error) { $('#btnStart').disabled = false; return note(started.error); }

  await countdown(3);
  $('#setup').hidden = true;
  $('#bar').hidden = false;
  await R.compact(true);

  recorders = [];
  pending = [];
  recorders.push(makeRecorder(media.screen, 'screen', 8e6));
  if (media.camera) recorders.push(makeRecorder(media.camera, 'camera', 2.5e6));
  captured = 0;
  recorders.forEach((r) => r.start(1000));
  ticker = setInterval(tick, 500);

  // The OS can refuse a capture without raising anything: MediaRecorder runs, the timer ticks,
  // and every blob is empty. That has to be caught early rather than at the end of a take — but
  // the check has to ASK before it accuses. An MP4 recorder does not necessarily hand over a
  // chunk on the timeslice; it may hold everything until something requests it, and a guard that
  // reads "no bytes yet" as "the capture failed" cancels perfectly good recordings. It did.
  setTimeout(() => {
    if (!recorders.length || captured > 0) return;
    // Ask for a chunk, then decide.
    recorders.forEach((r) => { try { if (r.state === 'recording') r.requestData(); } catch {} });
    setTimeout(() => {
      if (recorders.length && captured === 0) abortEmptyCapture();
    }, 2500);
  }, 5000);
}

let captured = 0;
// A window onto what the recorder thinks is happening. Without this a failing recording is a
// black box: the page looks the same whether MediaRecorder is running or quietly dead.
window.__recDebug = { get recorders() { return recorders.length; }, get captured() { return captured; },
                      get paused() { return paused; }, get elapsed() { return elapsed; } };

function makeRecorder(stream, track, bitrate) {
  const rec = new MediaRecorder(stream, { mimeType: 'video/mp4;codecs=avc1', videoBitsPerSecond: bitrate });
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    captured += e.data.size;
    // Keep the promise. Finalising before these land truncates the file and it loses its
    // moov atom — the recording becomes unreadable.
    pending.push(e.data.arrayBuffer().then((b) => R.chunk(track, b)));
  };
  return rec;
}

// The count-in is drawn by the transparent overlay, over your actual screen — not inside this
// window, which would put a window in the shot and look like an app rather than like recording.
function countdown(n) {
  return new Promise((resolve) => {
    $('#setup').hidden = true;
    R.count(n);
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(iv); R.count(0); resolve(); }
      else R.count(n);
    }, 1000);
  });
}

let elapsed = 0;
function tick() {
  if (!paused) { elapsed += 0.5; $('#timer').textContent = fmt(elapsed); }
  // One clock, in one place. The overlay shows it but never counts it — two things counting is
  // how a timer drifts against the recording it claims to describe.
  R.state({ elapsed, paused });
}
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Nothing is arriving from the OS. Tear the take down and tell the user exactly what to fix.
async function abortEmptyCapture() {
  clearInterval(ticker);
  recorders.forEach((r) => { try { r.stop(); } catch {} });
  recorders = [];
  Object.values(media).forEach((s) => s?.getTracks?.().forEach((t) => t.stop()));
  media = {};
  await R.discard();
  await R.compact(false);
  $('#bar').hidden = true;
  $('#setup').hidden = false;
  $('#btnStart').disabled = false;
  const warn = $('#permWarn');
  warn.hidden = false;
  warn.innerHTML = 'Nothing came through from the screen — macOS blocked the capture, so the take was '
    + 'discarded rather than saved empty. Open <b>Privacy &amp; Security → Screen Recording</b>, switch '
    + 'Cutright on (off and on again if it already looks on), then quit and reopen the app. '
    + '<button type="button" id="btnPrivacy2" class="link">Open the setting</button>';
  warn.querySelector('#btnPrivacy2').onclick = () => R.privacy();
}

async function togglePause() {
  paused = !paused;
  recorders.forEach((r) => (paused ? r.pause() : r.resume()));
  paused ? await R.pause() : await R.resume();
  $('#bar').classList.toggle('paused', paused);
  $('#btnPause').textContent = paused ? 'Resume' : 'Pause';
  R.state({ elapsed, paused });
}

async function stop() {
  clearInterval(ticker);
  $('#btnStop').disabled = true;
  // Never wait forever on a recorder that will not answer. If MediaRecorder is already inactive,
  // or wedged, `onstop` never arrives — and the whole of finalisation waits behind it, so the
  // bar stays up, the controls never close, and Stop looks like it does nothing. It did.
  const settle = (r) => new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    try {
      r.onstop = finish;
      if (r.state === 'inactive') finish(); else r.stop();
    } catch { finish(); }
    setTimeout(finish, 3000);
  });
  await Promise.all(recorders.map(settle));
  // Same rule for the chunks: they should all land before finalising, but a write that never
  // settles must not take the recording with it — what has already been written is on disk.
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((res) => setTimeout(res, 8000)),
  ]);
  Object.values(media).forEach((s) => s?.getTracks?.().forEach((t) => t.stop()));

  const summary = await R.stop();
  await R.compact(false);
  $('#bar').hidden = true;
  $('#finish').hidden = false;
  if (summary?.error) return fail(summary.error);

  R.onProgress((m) => {
    if (m.type === 'progress') {
      $('#finBar').style.width = Math.max(3, Math.round(m.pct || 0)) + '%';
      $('#finStage').textContent = `${m.stage}: ${m.detail || ''}`;
    }
    if (m.type === 'error') fail(m.error);
    if (m.type === 'done') {
      $('#finTitle').textContent = 'Your project is ready';
      $('#finBar').style.width = '100%';
      $('#finStage').textContent =
        `${fmt(summary.duration)} recorded · ${m.cues || 0} captions · ${m.zoomSuggestions || 0} zoom suggestions`;
      $('#finActions').hidden = false;
      $('#btnOpenProject').onclick = () => R.close();
    }
  });
  await R.finalize({ transcribe: true, model: 'small.en' });
}

function fail(msg) {
  $('#finTitle').textContent = 'Recording saved, but the project could not be built';
  $('#finStage').textContent = String(msg).slice(0, 300);
  $('#finActions').hidden = false;
  $('#btnOpenProject').textContent = 'Close';
  $('#btnOpenProject').onclick = () => R.close();
}

boot();
