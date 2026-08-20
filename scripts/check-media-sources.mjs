#!/usr/bin/env node
// The media directory, and the one mistake it must never make.
//
// "Free" covers at least four different things: free and unencumbered, free if you credit, free
// but not for anything you make money from, and free on a site whose own terms rule out
// commercial use. If this list ever describes the last two as safe for paid work, somebody ships
// a monetised video carrying material they may not use — and they will find out from a claim,
// not from us. Everything here exists to make that specific failure impossible.
import { readFileSync } from 'node:fs';
import { list, byId, validate, creditFor, creditLines, reset } from '../electron/media-sources.mjs';

const DATA = new URL('../data/', import.meta.url).pathname;
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const raw = JSON.parse(readFileSync(new URL('../data/media-sources.json', import.meta.url), 'utf8'));

console.log('media sources — free, and what that actually means\n');

const problems = validate(raw);
ok('the catalogue is well formed', problems.length === 0, problems.join('\n      '));
ok('there is something to offer', list(DATA).length >= 10, `${list(DATA).length} sources`);

// ---- the safety property ----
const paid = list(DATA, { commercialOnly: true });
ok('every source offered for paid work is licensed for it',
   paid.every((s) => s.licence.commercial === true),
   paid.filter((s) => s.licence.commercial !== true).map((s) => s.id).join(', '));
ok('nothing whose licence varies per item is offered as safe',
   !paid.some((s) => s.licence.id === 'mixed'),
   'a site where half the items are CC BY-NC is not a safe list');
ok('a non-commercial site is never in it',
   !paid.some((s) => s.licence.commercial === false));
const bbc = byId(DATA, 'bbc-sfx');
ok('the BBC library is marked personal/educational only',
   bbc && bbc.licence.commercial === false && bbc.safeForPaidWork === false,
   JSON.stringify(bbc?.licence));
ok('and it is excluded from the paid list', !paid.some((s) => s.id === 'bbc-sfx'));

// ---- what a person needs to know at a glance ----
ok('a CC BY source says the credit is mandatory',
   byId(DATA, 'incompetech')?.needsCredit === true);
ok('a CC0 source does not', byId(DATA, 'nasa')?.needsCredit === false);
ok('a per-item site says to check each item',
   byId(DATA, 'freesound')?.checkEachItem === true);
ok('every licence has a plain-language line, not just a name',
   list(DATA).every((s) => (s.licence.plain || '').length > 20),
   list(DATA).filter((s) => (s.licence.plain || '').length <= 20).map((s) => s.id).join(', '));
ok('every source carries a caveat', list(DATA).every((s) => (s.watch || '').length > 10));
ok('every link is https', list(DATA).every((s) => /^https:\/\//.test(s.url)));

// ---- filtering ----
for (const kind of ['video', 'image', 'audio']) {
  const got = list(DATA, { kind });
  if (!got.length || !got.every((s) => s.kinds.includes(kind))) {
    ok(`filtering by ${kind} returns only ${kind} sources`, false, got.map((s) => s.id).join(', '));
  }
}
ok('filtering by kind returns only that kind',
   ['video', 'image', 'audio'].every((k) => list(DATA, { kind: k }).every((s) => s.kinds.includes(k))));
ok('an unknown kind returns nothing rather than everything', list(DATA, { kind: 'hologram' }).length === 0);
ok('both filters together still hold',
   list(DATA, { kind: 'audio', commercialOnly: true }).every((s) => s.kinds.includes('audio') && s.licence.commercial === true));

// ---- credits ----
const src = byId(DATA, 'incompetech');
const c = creditFor(src, { title: 'Cipher', author: 'Kevin MacLeod' });
ok('a credit records what the licence requires', c.required === true && c.licence === 'cc-by');
ok('and reads as a line you could paste into a description',
   /Cipher by Kevin MacLeod — Incompetech .*CC BY/.test(creditLines([c])[0]), creditLines([c])[0]);
const free = creditFor(byId(DATA, 'nasa'), { title: 'Earthrise' });
ok('a CC0 credit is recorded but not marked required', free.required === false);
ok('a credit falls back to the source link when no item url is given', !!free.url);
ok('no credits produces no lines', creditLines([]).length === 0 && creditLines(null).length === 0);

// ---- the awkward inputs ----
reset();
ok('a missing catalogue is empty, not a crash', list('/nowhere/at/all').length === 0);
reset();
ok('an unknown id is null, not an exception', byId(DATA, 'nope') === null);
ok('validate reports a licence that is not defined',
   validate({ licences: {}, sources: [{ id: 'x', name: 'X', kinds: ['video'], url: 'https://x.test', watch: 'careful' }] })
     .some((p) => /not defined/.test(p)));
ok('validate rejects a non-https link',
   validate({ licences: { a: { name: 'A', plain: 'a plain summary of the terms', attribution: 'none' } },
              sources: [{ id: 'x', name: 'X', kinds: ['video'], licence: 'a', url: 'http://x.test', watch: 'careful' }] })
     .some((p) => /not https/.test(p)));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
