#!/usr/bin/env node
// The app's main process is an ES module. `require` does not exist there.
//
// This is not a style rule. Both places that used it wrapped the call in a try/catch for other
// reasons, so the ReferenceError was swallowed and the function returned its safe default — which
// meant the recorder's "this build will lose your Screen Recording permission" warning silently
// never fired, and About reported nothing about the signature. A mistake that throws loudly is
// cheap; one that quietly answers "everything is fine" is not.
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
console.log('esm — no require() where require does not exist\n');
ok('the package declares itself a module', pkg.type === 'module');

// .mjs and the .js files loaded by an ESM package are all ES modules. .cjs deliberately is not.
const esmFiles = [];
for (const dir of ['electron', 'renderer', 'scripts', 'engine']) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const n of names) {
    if (n.endsWith('.mjs')) esmFiles.push(join(dir, n));
    // renderer/*.js are plain browser scripts, not modules — require is equally absent there.
    else if (n.endsWith('.js') && dir !== 'engine') esmFiles.push(join(dir, n));
  }
}
ok('there are files to check', esmFiles.length > 5, `${esmFiles.length} found`);

const offenders = [];
for (const rel of esmFiles) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  // createRequire is the legitimate way in; a bare require() is not.
  const usesCreateRequire = /createRequire\s*\(/.test(src);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;            // a comment about it is fine
    if (usesCreateRequire) return;                      // it made itself one on purpose
    // Strip quoted text first, or a file that merely TALKS about the thing reports itself —
    // which this check did on its first run.
    const bare = line.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '``');
    if (!/(^|[^.\w])require\s*\(/.test(bare)) return;
    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 80)}`);
  });
}
ok('no ES module calls require() directly', offenders.length === 0, offenders.join('\n      '));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
