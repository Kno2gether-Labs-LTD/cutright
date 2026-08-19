#!/usr/bin/env node
// Does the packaged app keep the SAME identity between builds?
//
// This is the check behind scripts/afterpack-sign.cjs. macOS decides whether a permission grant
// (Screen Recording) still belongs to "this app" by comparing the bundle against its designated
// requirement. An ad-hoc signature's requirement is `cdhash H"..."`, a hash of the build — so
// every rebuild is a new app to macOS and the Screen Recording tick stops meaning anything.
//
// So: build two DIFFERENT bundles, sign both the way the packager does, and require that the
// designated requirement comes out identical. The second half of the check runs the same two
// bundles through the ad-hoc fallback and requires that it FAILS that test — otherwise the
// check would pass even if the fix were removed, which is how a test quietly stops working.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') { console.log('signing: skipped (macOS only)'); process.exit(0); }

const require = createRequire(import.meta.url);
const afterPack = require('./afterpack-sign.cjs').default;
const APP_ID = 'com.viddescriptor.cutright';
const root = mkdtempSync(join(tmpdir(), 'cutright-signing-'));
let failed = 0;

const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail && !cond ? `\n      ${detail}` : ''}`);
  if (!cond) failed++;
};

// A minimal but genuine .app: a real Mach-O executable and an Info.plist. `filler` is what
// differs between the two builds, which is exactly what a cdhash would notice.
function makeApp(dir, filler) {
  const app = join(dir, 'Cutright.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  copyFileSync('/bin/echo', join(app, 'Contents', 'MacOS', 'Cutright'));
  writeFileSync(join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Cutright</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleName</key><string>Cutright</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  writeFileSync(join(app, 'Contents', 'Resources.txt'), filler);
  return app;
}

async function sign(filler, tag) {
  const dir = join(root, tag);
  mkdirSync(dir, { recursive: true });
  makeApp(dir, filler);
  await afterPack({
    electronPlatformName: 'darwin',
    appOutDir: dir,
    packager: { appInfo: { productFilename: 'Cutright', id: APP_ID } },
  });
  const r = spawnSync('codesign', ['-d', '-r-', join(dir, 'Cutright.app')], { encoding: 'utf8' });
  // codesign writes "# designated => ..." when the requirement is implicit (ad-hoc), and
  // "designated => ..." when it comes from a certificate. Match the marker, not the line start.
  const line = ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.includes('designated =>'));
  return (line || '').slice((line || '').indexOf('designated =>') + 'designated =>'.length).trim();
}

const hasCert = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  .stdout?.includes('Cutright Local Signing');

console.log('signing — the app keeps one identity across rebuilds\n');

// Silence afterPack's own logging so the check output stays readable.
const log = console.log; const quiet = () => { console.log = () => {}; }; const loud = () => { console.log = log; };

try {
  if (!hasCert) {
    log('  ! no "Cutright Local Signing" certificate on this machine.');
    log('    Run: ./scripts/setup-signing.sh local');
    log('    Skipping the stability check — the fallback check below still runs.\n');
  } else {
    quiet();
    const a = await sign('build one', 'with-cert-a');
    const b = await sign('build two — different bytes', 'with-cert-b');
    loud();
    ok('two different builds produce the same designated requirement', a === b && !!a,
       `build A: ${a}\n      build B: ${b}`);
    // A self-signed certificate is its own chain, so macOS names it `certificate root`;
  // a Developer ID certificate chains to Apple and comes out as `certificate leaf`.
  // Either is fine — what matters is that a certificate, not a cdhash, is what is pinned.
  ok('the requirement is pinned to the certificate, not the build',
       /certificate (root|leaf)/.test(a) && !a.includes('cdhash'), a);
    ok('the requirement names our bundle id', a.includes(APP_ID), a);
  }

  // The fallback must be genuinely worse, or the check above proves nothing.
  process.env.CUTRIGHT_NO_LOCAL_CERT = '1';
  quiet();
  const c = await sign('build one', 'adhoc-a');
  const d = await sign('build two — different bytes', 'adhoc-b');
  loud();
  delete process.env.CUTRIGHT_NO_LOCAL_CERT;
  ok('without a certificate the requirement DOES change (so the check can fail)',
     c !== d && c.includes('cdhash'), `adhoc A: ${c}\n      adhoc B: ${d}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
