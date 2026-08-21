// The recording overlay's own little renderer. It owns no state — main tells it what to show,
// and it sends back what the user pressed. Deliberately dumb: the thing actually recording is
// the recorder window, and two places believing they own the clock is how a timer drifts.
const $ = (s) => document.querySelector(s);
const O = window.overlay;

O.onMode(({ mode, n }) => {
  $('#count').hidden = mode !== 'count';
  $('#controls').hidden = mode !== 'controls';
  if (mode === 'count' && n != null) {
    // Re-trigger the animation on every number rather than only on the first.
    const el = $('#countNum');
    el.textContent = n;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }
});

O.onState(({ elapsed, paused }) => {
  if (elapsed != null) $('#time').textContent = fmt(elapsed);
  $('#controls').classList.toggle('paused', !!paused);
  const l = $('#recLabel'); if (l) l.textContent = paused ? 'HELD' : 'REC';
  $('#btnPause').title = paused ? 'Carry on' : 'Pause (the clock stops too)';
});

$('#btnStop').onclick = () => O.action('stop');
$('#btnPause').onclick = () => O.action('pause');
$('#btnMark').onclick = () => {
  O.action('mark');
  // A mark is invisible by nature — say it landed.
  const b = $('#btnMark');
  b.textContent = '✓';
  setTimeout(() => { b.textContent = '★'; }, 700);
};

function fmt(s) {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
