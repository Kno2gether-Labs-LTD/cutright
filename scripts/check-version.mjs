#!/usr/bin/env node
// Version comparison, which decides whether anyone is ever told an update exists.
//
// Both ways of being wrong matter, but not equally: nagging someone who is up to date is
// annoying, and failing to tell someone about a new version is invisible. So the cases below
// lean on the ones that go quiet.
import { isNewer, compareVersions, parseVersion } from '../electron/version.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

console.log('version — is there a newer one\n');

ok('a later patch is newer', isNewer('0.1.1', '0.1.0'));
ok('a later minor is newer', isNewer('0.2.0', '0.1.9'));
ok('a later major is newer', isNewer('1.0.0', '0.9.9'));
ok('the same version is not newer', !isNewer('0.1.0', '0.1.0'));
ok('an older one is not newer', !isNewer('0.1.0', '0.1.1'));

// The classic: text sorting says 0.10.0 < 0.9.0, and it is not.
ok('0.10.0 is newer than 0.9.0 (not a string comparison)', isNewer('0.10.0', '0.9.0'));
ok('1.0.0 is newer than 0.99.99', isNewer('1.0.0', '0.99.99'));

// Tags carry a v; package.json does not.
ok('a leading v is ignored', isNewer('v0.2.0', '0.1.0') && !isNewer('v0.1.0', '0.1.0'));
ok('both sides may carry one', compareVersions('v1.2.3', 'v1.2.3') === 0);

// Shapes that turn up in the wild.
ok('a missing patch part counts as zero', compareVersions('1.2', '1.2.0') === 0);
ok('and is still ordered correctly', isNewer('1.3', '1.2.9'));
ok('a pre-release is ordered by its numbers', compareVersions('1.2.0-beta.1', '1.2.0') === 0,
   'ordering pre-releases properly is a bigger job; treating them as equal is at least not wrong');
ok('rubbish does not throw', compareVersions('', null) === 0 && !isNewer(undefined, '1.0.0'));
ok('a non-numeric part is zero rather than NaN', parseVersion('1.x.3').join('.') === '1.0.3');
ok('nothing is never newer than something', !isNewer('', '0.1.0'));
ok('something IS newer than nothing', isNewer('0.1.0', ''));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
