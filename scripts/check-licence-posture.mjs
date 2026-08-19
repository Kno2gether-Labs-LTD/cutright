// Guard for decision 0003: this app is Apache-2.0 and must never ship an ffmpeg binary.
// Nearly every prebuilt ffmpeg is an --enable-gpl build (x264/x265); redistributing one
// inside a non-GPL app relicenses the whole distribution. Run in CI and before release.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

// 1. no ffmpeg-shaped dependency may enter package.json
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const BANNED = /^(ffmpeg-static|ffmpeg-ffprobe-static|@ffmpeg-installer|@ffprobe-installer|ffbinaries|fluent-ffmpeg-static)/;
for (const field of ['dependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] || {})) {
    if (BANNED.test(name)) problems.push(`${field} contains "${name}" — ships an ffmpeg binary`);
  }
}

// 2. no ffmpeg/ffprobe binary anywhere in the tree we package
const SEARCH = ['engine', 'electron', 'renderer', 'templates', 'resources', 'bin'];
const walk = (dir) => {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { walk(p); continue; }
    if (/^(ffmpeg|ffprobe)(\.exe)?$/i.test(entry.name)) {
      problems.push(`${p} looks like a bundled ffmpeg binary`);
    }
    // a stray multi-MB executable is worth a human look
    if (!entry.name.includes('.') && statSync(p).size > 5_000_000) {
      problems.push(`${p} is a ${(statSync(p).size / 1e6).toFixed(0)} MB extensionless file — is it a binary?`);
    }
  }
};
SEARCH.forEach((d) => walk(join(ROOT, d)));

// 3. no stray duplicates at the repo root — an extracted or copied source file committed
//    by a careless `git add -A` (this has happened: an asar-extracted main.js).
const { createHash } = await import('node:crypto');
const hash = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
const KNOWN_ROOT_JS = new Set([]);
for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(js|cjs|mjs)$/.test(entry.name)) continue;
  if (KNOWN_ROOT_JS.has(entry.name)) continue;
  problems.push(`${entry.name} sits at the repo root — source belongs in electron/, renderer/, scripts/ or engine/`);
}

// 4. the licence must still be Apache-2.0 with a NOTICE
if (pkg.license !== 'Apache-2.0') problems.push(`package.json license is "${pkg.license}", expected Apache-2.0`);
if (!existsSync(join(ROOT, 'LICENSE'))) problems.push('LICENSE is missing');
if (!existsSync(join(ROOT, 'NOTICE'))) problems.push('NOTICE is missing');

if (problems.length) {
  console.error('Licence posture check FAILED:\n' + problems.map((p) => '  ✗ ' + p).join('\n'));
  console.error('\nSee docs/decisions/0003-ffmpeg-not-bundled.md before changing any of this.');
  process.exit(1);
}
console.log('✅ licence posture OK — Apache-2.0, no bundled ffmpeg, NOTICE present');
