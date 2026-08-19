// Ad-hoc sign the packaged app with its OWN identity.
//
// electron-builder skips signing entirely when `mac.identity` is null (our default, because
// there is no Developer ID certificate yet). What it leaves behind is a bundle whose code
// signature says `Identifier=Electron` and carries none of our entitlements.
//
// That matters more than it sounds. macOS keys TCC permissions — Screen Recording, camera,
// microphone — to the code signature, not the bundle id in Info.plist. An "Electron" identity
// is shared with every other unsigned Electron app on the machine and is re-minted on each
// build, so a permission the user grants today is not recognised tomorrow: they tick the box,
// nothing changes, and the recorder silently captures nothing.
//
// Signing ad-hoc with the real identifier and our entitlements gives macOS something stable to
// hold the grant against. It is not a substitute for a Developer ID signature (see
// scripts/dist-signed.sh) — it is what makes the unsigned build usable at all.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');
const { existsSync } = require('node:fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_NAME || process.env.CSC_LINK) return;      // a real identity is in play

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id;
  const ents = join(__dirname, '..', 'build', 'entitlements.mac.plist');
  if (!existsSync(app)) throw new Error('afterPack: no app bundle at ' + app);

  const args = ['--force', '--deep', '--sign', '-', '--identifier', id, '--timestamp=none'];
  if (existsSync(ents)) args.push('--entitlements', ents);
  const r = spawnSync('codesign', [...args, app], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('afterPack: ad-hoc signing failed:\n' + (r.stderr || ''));

  const check = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' });
  const line = (check.stderr || '').split('\n').find((l) => l.startsWith('Identifier=')) || '';
  console.log(`  • ad-hoc signed with the app's own identity  ${line.trim()}`);
  if (!line.includes(id)) throw new Error(`afterPack: signature identity is ${line} — expected ${id}`);
};
