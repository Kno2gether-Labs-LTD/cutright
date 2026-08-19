// A panel stays up for as long as it earns, and no longer.
//
//   node scripts/check-pacing.mjs
//
// The rule is: max(time to read it, how long the speaker stays on the subject), held inside the
// pack's bounds. Easy to write, easy to break — a wordy panel that vanishes in two seconds and a
// three-word panel that sits there for ten both look like carelessness rather than a bug.
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine');
const fail = (m) => { console.error('✗ ' + m); process.exit(1); };

const ask = (scene, words, pacing) => {
  const r = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(ENGINE)})
from pacing import panel_duration
job = json.load(sys.stdin)
dur, why = panel_duration(job["scene"], job["words"], job["pacing"])
print(json.dumps({"dur": dur, "why": why}))
`], { input: JSON.stringify({ scene, words, pacing: pacing || {} }), encoding: 'utf8' });
  if (r.status !== 0) fail('pacing failed: ' + (r.stderr || '').slice(-300));
  return JSON.parse(r.stdout.trim().split('\n').pop());
};

// a speaker who stays on the subject for eight seconds, then moves on after a long gap
const words = [];
for (let t = 10; t < 18; t += 0.4) words.push({ text: 'word', start: t, end: t + 0.35 });
words.push({ text: 'next', start: 24, end: 24.4 });

const three = { start: 10, headline: 'WHY', items: [{ text: 'ONE' }] };
const wordy = { start: 10, headline: 'THE THREE REASONS THIS MATTERS MORE THAN YOU THINK',
                items: [{ text: 'PRIVACY BY DEFAULT' }, { text: 'CONTROL OF YOUR OWN DATA' },
                        { text: 'COST OVER TIME' }] };

const a = ask(three, words, { minPanel: 1.0, maxPanel: 12 });
console.log(`  short panel, speaker stays on it   ${a.dur}s — ${a.why}`);
if (a.dur < 7) fail(`a panel came down at ${a.dur}s while the speaker was still on the subject`);
if (!/speaker/.test(a.why)) fail('the reason does not mention the speech it followed: ' + a.why);

const b = ask(wordy, [], { minPanel: 1.0, maxPanel: 30 });
console.log(`  wordy panel, nothing to follow     ${b.dur}s — ${b.why}`);
if (b.dur < 6) fail(`${b.dur}s is not long enough to read a panel with that much on it`);
if (!/read/.test(b.why)) fail('the reason does not mention reading: ' + b.why);

const c = ask(three, [], { minPanel: 1.0, maxPanel: 30 });
console.log(`  three words, nothing to follow     ${c.dur}s — ${c.why}`);
if (c.dur > 4) fail(`${c.dur}s is far too long for three words`);
if (c.dur >= b.dur) fail('a three-word panel is not shorter than a wordy one — the rule is not reading anything');

const fast = ask(wordy, words, { minPanel: 1.0, maxPanel: 4.0 });
console.log(`  a pack that insists on 4s          ${fast.dur}s — ${fast.why}`);
if (fast.dur !== 4) fail(`the pack's ceiling was ignored: ${fast.dur}s`);
if (!/4s|held to/.test(fast.why)) fail('the reason does not say it was held to the pack: ' + fast.why);

const floor = ask(three, [], { minPanel: 5.0, maxPanel: 30 });
if (floor.dur !== 5) fail(`the pack's floor was ignored: ${floor.dur}s`);

// every pack must carry pacing, or preprocess has nothing to hold panels to
import { readFileSync, readdirSync } from 'node:fs';
const packs = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
for (const id of readdirSync(packs).filter((d) => !d.includes('.'))) {
  const t = JSON.parse(readFileSync(join(packs, id, 'template.json'), 'utf8'));
  if (!t.pacing?.minPanel || !t.pacing?.maxPanel)
    fail(`template "${id}" has no pacing — its panels would fall back to a guess`);
  if (t.pacing.minPanel >= t.pacing.maxPanel) fail(`template "${id}" has an impossible pacing range`);
  if (!t.grade?.look) fail(`template "${id}" carries no grade, so choosing it leaves the look unset`);
  console.log(`  ${id}: ${t.pacing.minPanel}–${t.pacing.maxPanel}s · grade "${t.grade.look}"`);
}

console.log('✓ pacing: panels follow the speech, the reading, and the pack — in that order');
