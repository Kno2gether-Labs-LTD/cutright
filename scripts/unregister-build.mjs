#!/usr/bin/env node
// Stop the build output being offered as a second copy of the app.
//
// macOS registers any .app it notices, so `dist/mac-arm64/Cutright.app` shows up in Spotlight,
// Launchpad and "Open With" alongside the real install — two Cutrights, one of them a build
// artefact that will be overwritten by the next build. Confusing at best; at worst you test the
// wrong one and wonder why your fix is not there.
//
// So each build unregisters its own output. Harmless anywhere else: on a non-Mac, or when the
// tool is missing, it does nothing.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LSREG = '/System/Library/Frameworks/CoreServices.framework/Frameworks/'
            + 'LaunchServices.framework/Support/lsregister';
if (!existsSync(LSREG)) process.exit(0);

let done = 0;
for (const arch of ['mac-arm64', 'mac', 'mac-x64', 'mac-universal']) {
  const app = join(ROOT, 'dist', arch, 'Cutright.app');
  if (!existsSync(app)) continue;
  spawnSync(LSREG, ['-u', app], { stdio: 'ignore' });
  spawnSync(LSREG, ['-u', join(app, 'Contents', 'Frameworks', 'Cutright Helper.app')], { stdio: 'ignore' });
  done++;
}
if (done) console.log(`  • unregistered ${done} build output(s) so they do not appear as a second app`);
