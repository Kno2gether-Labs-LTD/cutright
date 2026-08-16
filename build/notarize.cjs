// electron-builder `afterSign` hook — Phase 1 (signed release).
//
// It is a deliberate NO-OP until the Apple credentials exist, so the unsigned local
// build keeps working. Once the Apple Developer Program enrolment is done:
//
//   1. Install the "Developer ID Application" cert in the login keychain.
//   2. In package.json → build.mac: set `"identity": "Developer ID Application: … (TEAMID)"`,
//      `"hardenedRuntime": true`, and keep the entitlements already configured.
//   3. Export APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD (appleid.apple.com → app-specific
//      password) and APPLE_TEAM_ID, then `npm run dist`.
//
// Reminder: every bundled binary (a future LGPL ffmpeg/ffprobe sidecar, node-pty's
// spawn-helper) must itself be signed or notarization fails.
exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('  • notarization skipped  reason=APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
  }
  const appName = context.packager.appInfo.productFilename;
  const { notarize } = require('@electron/notarize');
  console.log(`  • notarizing  app=${appName}.app`);
  await notarize({
    tool: 'notarytool',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};
