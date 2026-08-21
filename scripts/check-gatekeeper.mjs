#!/usr/bin/env node
// Reading Gatekeeper's answer, which About repeats to the user.
//
// The trap is one word: a build that is NOT notarised says "source=Unnotarized Developer ID",
// and a naive /Notarized/i match finds "notarized" inside "Unnotarized". The first version of
// this shipped that mistake and About told me a rejected build was notarised. These cases are
// the real strings spctl prints.
import { parseSpctl } from '../electron/gatekeeper.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const NOTARISED = `/Applications/Cutright.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: KNO2GETHER LABS LTD (YBPZTUP33D)`;

const SIGNED_ONLY = `/Applications/Cutright.app: rejected
source=Unnotarized Developer ID
origin=Developer ID Application: KNO2GETHER LABS LTD (YBPZTUP33D)`;

const UNSIGNED = `/Applications/Cutright.app: rejected
source=no usable signature`;

console.log('gatekeeper — what macOS actually said\n');

const a = parseSpctl(NOTARISED);
ok('a notarised build is reported as notarised', a.notarized === true && a.accepted === true);
ok('and its origin is read', /KNO2GETHER/.test(a.origin || ''), String(a.origin));

const b = parseSpctl(SIGNED_ONLY);
ok('"Unnotarized" is NOT read as notarised', b.notarized === false,
   'this is the bug that shipped: /Notarized/i matches inside "Unnotarized"');
ok('and it is reported as rejected', b.rejected === true && b.accepted === false);
ok('the plain wording says a download would be blocked', /downloaded copy will be blocked/.test(b.plain), b.plain);

const c = parseSpctl(UNSIGNED);
ok('an unsigned build is neither notarised nor accepted', !c.notarized && !c.accepted);

ok('empty input does not throw or claim anything', (() => {
  const d = parseSpctl('');
  return d.notarized === false && d.accepted === false && d.plain === 'unknown';
})());
ok('null does not throw', parseSpctl(null).notarized === false);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
