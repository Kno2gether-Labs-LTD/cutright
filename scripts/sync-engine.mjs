// Keep the bundled engine (engine/) and the `video-edit` / `video-style-match` skills in
// sync. The app ships its own copy so it is self-contained; the skills keep theirs so
// `claude` can run the same pipeline standalone.
//
//   node scripts/sync-engine.mjs           # repo → skills
//   node scripts/sync-engine.mjs --from-skills
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'engine');
const VE = join(homedir(), '.claude/skills/video-edit/scripts');
const VSM = join(homedir(), '.claude/skills/video-style-match/scripts');
const MAP = [
  ['render_project.py', VE], ['build_project.py', VE], ['audio_agent.py', VE],
  ['captions_png.py', VSM], ['scenes_png.py', VSM], ['reveals_png.py', VSM],
  ['color-match.mjs', VSM], ['grade.mjs', VSM], ['watchdog.sh', VSM],
];
const fromSkills = process.argv.includes('--from-skills');
let n = 0;
for (const [file, skillDir] of MAP) {
  const a = join(ENGINE, file), b = join(skillDir, file);
  const [src, dst] = fromSkills ? [b, a] : [a, b];
  if (!existsSync(src)) { console.warn('skip (missing):', src); continue; }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst); n++;
}
console.log(`synced ${n} files ${fromSkills ? 'skills → repo' : 'repo → skills'}`);
