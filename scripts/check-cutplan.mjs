#!/usr/bin/env node
// Letting a model choose cuts, without letting it near the video.
//
// The dangerous failure is not a crash, it is a confident wrong answer: cutting the good take
// instead of the abandoned one, or clipping a word in half. So the model's output is treated as
// a claim to be checked against the transcript we already have, and this is where those checks
// are proved. Everything runs offline — the transport is exercised against a fake endpoint, so
// nobody needs a key to run the suite.
import { createServer } from 'node:http';
import { segmentsFrom, chunk, promptFor, parsePlan, merge, SYSTEM } from '../electron/cutplan.mjs';
import { normaliseBase, chat, listModels, detectLocal } from '../electron/llm.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const words = (text, t0 = 0, step = 0.4) =>
  text.split(' ').map((w, i) => ({ text: w, start: +(t0 + i * step).toFixed(2), end: +(t0 + i * step + step * 0.9).toFixed(2) }));

console.log('cut planning — reading the words, not just the waveform\n');

// ---- turning a word list into something worth showing a model ----
const w = [...words('Hello and welcome to the thing.', 0), ...words('Today we will build it.', 8)];
const segs = segmentsFrom(w);
ok('a pause starts a new segment', segs.length === 2, `got ${segs.length}: ` + segs.map((s) => s.text).join(' | '));
ok('segments keep real timings', segs[0].start === w[0].start && segs[1].end === w[w.length - 1].end);
ok('a full stop ends a segment even without a pause',
   segmentsFrom(words('One. Two three.', 0, 0.1)).length === 2);
ok('rubbish in the transcript is skipped',
   segmentsFrom([{ text: '', start: 0, end: 1 }, { text: 'ok', start: NaN, end: 2 }]).length === 0);

// ---- chunking to a token budget ----
const many = Array.from({ length: 400 }, (_, i) => ({ text: `sentence number ${i} with some words in it.`, start: i * 5, end: i * 5 + 4 }));
const chunks = chunk(many, { maxTokens: 2000 });
ok('a long transcript is split', chunks.length > 1, `${chunks.length} chunks`);
const biggest = Math.max(...chunks.map((c) => promptFor(c).length));
ok('no chunk exceeds the budget', biggest <= 2000 * 4, `biggest prompt ${biggest} chars`);
ok('chunks overlap so a cut across a seam is still visible',
   chunks[1].segs[0].start <= chunks[0].segs[chunks[0].segs.length - 1].start);
ok('chunks are in order and cover the transcript',
   chunks[0].from === many[0].start && chunks[chunks.length - 1].to === many[many.length - 1].end);
ok('a short transcript is one chunk', chunk(segs, { maxTokens: 2000 }).length === 1);
ok('the numbering the model is asked for starts at 1', /^1\. \[/.test(promptFor(chunks[0])));
ok('the instructions tell it to keep when unsure', /when unsure, KEEP/i.test(SYSTEM));

// ---- the guardrails ----
const ch = { segs: [ { start: 0, end: 4, text: 'a' }, { start: 4, end: 9, text: 'b' },
                     { start: 9, end: 14, text: 'c' }, { start: 14, end: 30, text: 'd' } ],
             from: 0, to: 30 };
const plan = (o) => parsePlan(JSON.stringify(o), ch);

ok('a clean answer becomes a cut', plan({ cuts: [{ from: 2, to: 2, reason: 'restart', confidence: 'high' }] }).cuts.length === 1);
const snapped = plan({ cuts: [{ from: 2, to: 3, reason: 'tangent' }] }).cuts[0];
ok('boundaries land on the segments, so no word is clipped',
   snapped.start === 4 && snapped.end === 14, JSON.stringify(snapped));
ok('an unlisted confidence becomes the cautious one', snapped.confidence === 'low');
ok('the reason is carried through for the user to read', /tangent/.test(snapped.label));

ok('a segment number it was never shown is dropped', plan({ cuts: [{ from: 9, to: 9 }] }).cuts.length === 0);
ok('a backwards range is dropped', plan({ cuts: [{ from: 3, to: 2 }] }).cuts.length === 0);
ok('a zero or negative index is dropped', plan({ cuts: [{ from: 0, to: 1 }] }).cuts.length === 0);
ok('a non-numeric index is dropped', plan({ cuts: [{ from: 'two', to: 'three' }] }).cuts.length === 0);
ok('anything shorter than the minimum is dropped',
   parsePlan(JSON.stringify({ cuts: [{ from: 1, to: 1 }] }), ch, { minCut: 10 }).cuts.length === 0);

const runaway = plan({ cuts: [{ from: 1, to: 4 }] });
ok('a chunk it wants to gut is thrown away whole', runaway.cuts.length === 0 && !!runaway.rejected, runaway.rejected || '');
ok('and says why, so it is not a silent nothing', /remove \d+%/.test(runaway.rejected || ''));

ok('prose around the JSON is tolerated',
   parsePlan('Sure! Here you go:\n```json\n{"cuts":[{"from":2,"to":2}]}\n```\nHope that helps', ch).cuts.length === 1);
ok('no JSON at all is a rejection, not a crash', parsePlan('I cannot help with that', ch).cuts.length === 0);
ok('an empty list is a valid answer', parsePlan('{"cuts":[]}', ch).cuts.length === 0 && !parsePlan('{"cuts":[]}', ch).rejected);
ok('a null answer does not throw', parsePlan(null, ch).cuts.length === 0);

// ---- silence stays the authority ----
const acoustic = [{ start: 4, end: 9, reason: 'silence', confidence: 'high' }];
const ai = [{ start: 5, end: 8, reason: 'ai' }, { start: 20, end: 25, reason: 'ai' }];
const merged = merge(acoustic, ai);
ok('an AI cut that just restates a silence is not shown twice', merged.length === 2, JSON.stringify(merged.map((c) => c.reason)));
ok('one the waveform could not have found is kept', merged.some((c) => c.start === 20));
ok('the result is in time order', merged.every((c, i, arr) => i === 0 || arr[i - 1].start <= c.start));

// ---- the transport ----
ok('a base URL survives being pasted in any of its usual forms',
   ['http://x/v1', 'http://x', 'http://x/v1/chat/completions', 'http://x/'].every((u) => normaliseBase(u) === 'http://x/v1'),
   ['http://x/v1', 'http://x', 'http://x/v1/chat/completions', 'http://x/'].map((u) => `${u} -> ${normaliseBase(u)}`).join('\n      '));
ok('an empty endpoint is empty, not "undefined/v1"', normaliseBase('') === '' && normaliseBase(null) === '');

let seen = null, rejectFormat = false;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
    }
    seen = { headers: req.headers, body: JSON.parse(body || '{}') };
    if (rejectFormat && seen.body.response_format) {
      res.writeHead(400); return res.end('response_format is not supported');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"cuts":[{"from":2,"to":2}]}' } }] }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const good = await chat({ baseUrl: base, apiKey: 'sk-test', model: 'local-model', system: 'S', user: 'U' });
ok('a normal exchange comes back', good.ok && /cuts/.test(good.text || ''), good.error || '');
ok('the key is sent as a bearer token', seen?.headers?.authorization === 'Bearer sk-test');
ok('the model and both messages are sent',
   seen?.body?.model === 'local-model' && seen.body.messages.length === 2 && seen.body.messages[0].role === 'system');

rejectFormat = true;
const retried = await chat({ baseUrl: base, apiKey: '', model: 'local-model', system: 'S', user: 'U' });
ok('a server that rejects JSON mode is retried without it, not reported as broken',
   retried.ok === true && !seen.body.response_format, retried.error || '');
ok('no key means no Authorization header at all', !seen?.headers?.authorization);
rejectFormat = false;

ok('models can be listed from the endpoint', (await listModels({ baseUrl: base })).models?.includes('local-model'));

const dead = await chat({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm', system: 'S', user: 'U', timeoutMs: 400 });
ok('an endpoint that is not there fails quickly and says so', dead.ok === false && !!dead.error, JSON.stringify(dead));
ok('no endpoint is refused before any request', (await chat({ baseUrl: '', model: 'm', system: 'S', user: 'U' })).error === 'no endpoint set');
ok('no model is refused before any request', (await chat({ baseUrl: base, model: '', system: 'S', user: 'U' })).error === 'no model chosen');

const t0 = Date.now();
await detectLocal({ timeoutMs: 300 });
ok('looking for a local runner cannot hang the app', Date.now() - t0 < 2500, `${Date.now() - t0}ms`);

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
