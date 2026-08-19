// Sign the packaged app with an identity that stays the same between builds.
//
// electron-builder skips signing entirely when `mac.identity` is null (our default, because
// there is no Developer ID certificate yet). What it leaves behind is a bundle whose code
// signature says `Identifier=Electron` and carries none of our entitlements.
//
// That matters more than it sounds. macOS keys TCC permissions — Screen Recording, camera,
// microphone — to the code signature, not the bundle id in Info.plist. So the signature has to
// be two things:
//
//   1. OURS. An "Electron" identity is shared with every other unsigned Electron app on the
//      machine, and carries none of our entitlements.
//   2. THE SAME EVERY BUILD. An ad-hoc signature's designated requirement is
//      `cdhash H"..."` — a hash of the build itself. macOS therefore treats each rebuild as a
//      different application, and Screen Recording has to be granted all over again.
//
//      Not the keychain, though — that was measured and it is not true here. safeStorage's item
//      carries no restrictive ACL, so an ad-hoc build reads what a signed build wrote just fine.
//      The 584-second freeze that looked like this was `isEncryptionAvailable()` blocking, and
//      it is bounded in electron/main.js. Signing does not fix it and never did.
//
// So we sign with a certificate when one is available. `scripts/setup-signing.sh local` makes a
// self-signed one in ten seconds and no Apple account; with it the requirement becomes
// `identifier "com.viddescriptor.cutright" and certificate leaf H"..."`, which survives
// rebuilds. A real Developer ID certificate (setup-signing.sh csr → import) is strictly better
// and is what distribution needs — this only fixes the machine that does the building.
//
// Falling back to ad-hoc is deliberate: a checkout with no certificate must still produce a
// runnable app. It logs loudly, because the permissions will be annoying.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync } = require('node:fs');

const LOCAL_CN = 'Cutright Local Signing';

function localIdentity() {
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find((l) => l.includes(LOCAL_CN));
  return line ? line.trim().split(/\s+/)[1] : null;      // the SHA-1, unambiguous
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return;      // a real identity is in play

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  const ents = join(__dirname, '..', 'build', 'entitlements.mac.plist');
  if (!existsSync(app)) throw new Error('afterPack: no app bundle at ' + app);

  const sha = process.env.CUTRIGHT_NO_LOCAL_CERT ? null : localIdentity();
  const args = ['--force', '--deep', '--sign', sha || '-', '--identifier', id, '--timestamp=none'];
  if (existsSync(ents)) args.push('--entitlements', ents);
  const r = spawnSync('codesign', [...args, app], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('afterPack: signing failed:\n' + (r.stderr || ''));

  const check = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
  const line = (check.stderr || '').split('\n').find((l) => l.startsWith('Identifier=')) || '';
  if (!line.includes(id)) throw new Error(`afterPack: signature identity is ${line} — expected ${id}`);

  // The designated requirement is the thing that has to be stable, so print it rather than
  // the identity: it is what macOS actually compares a permission grant against.
  const req = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' });
  // codesign prefixes the line with "# " when the requirement is implicit (the ad-hoc case),
  // so match the marker anywhere rather than at the start.
  const dr = ((req.stdout || '') + (req.stderr || '')).split('\n').find((l) => l.includes('designated =>')) || '';

  if (sha) {
    if (dr.includes('cdhash')) throw new Error('afterPack: signed with a certificate but the requirement is still cdhash-based:\n  ' + dr);
    console.log(`  • signed with a stable identity  ${line.trim()}`);
    console.log(`    ${dr.trim()}`);
  } else {
    console.log(`  • ad-hoc signed  ${line.trim()}`);
    console.log('    NOTE: no signing certificate, so this build has a new identity. macOS will');
    console.log('    ask for Screen Recording again and cannot read keys the last build stored.');
    console.log('    Fix in ten seconds:  ./scripts/setup-signing.sh local');
  }
};
