// electron-builder `afterAllArtifactBuild` hook — staple the DMG itself.
//
// build/notarize.cjs notarizes and staples the .app, but that happens in `afterSign`, which
// runs BEFORE the DMG is assembled. So the app inside the disk image carries its notarization
// ticket while the image around it does not.
//
// The difference shows up on someone else's Mac. Opening an unstapled DMG makes Gatekeeper ask
// Apple whether the image is notarized — fine on a good connection, a spinner or an outright
// "cannot be opened" on a bad one or none. Stapling attaches the ticket so the check is local.
//
// Like the notarize hook, this is a no-op without Apple credentials, so unsigned local builds
// keep working.
const { spawnSync } = require('node:child_process');

exports.default = async function stapleDmg(context) {
  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (!dmgs.length) return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('  • dmg stapling skipped  reason=APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
  }

  for (const dmg of dmgs) {
    console.log(`  • notarizing dmg  ${dmg}`);
    const submit = spawnSync('xcrun', [
      'notarytool', 'submit', dmg, '--wait',
      '--apple-id', APPLE_ID, '--team-id', APPLE_TEAM_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // Print the log line by line rather than the whole object: notarytool echoes the
    // submission id, which is what you need to fetch the rejection reason if it fails.
    process.stdout.write((submit.stdout || '').split('\n').map((l) => '    ' + l).join('\n'));
    if (submit.status !== 0) throw new Error('notarytool submit failed for ' + dmg + '\n' + (submit.stderr || ''));
    if (!/status:\s*Accepted/i.test(submit.stdout || '')) {
      throw new Error('the dmg was not accepted by notarization — run `xcrun notarytool log <id>` for the reason');
    }

    const staple = spawnSync('xcrun', ['stapler', 'staple', dmg], { encoding: 'utf8' });
    if (staple.status !== 0) throw new Error('stapler failed for ' + dmg + '\n' + (staple.stderr || staple.stdout || ''));
    console.log(`  • stapled  ${dmg}`);
  }
};
