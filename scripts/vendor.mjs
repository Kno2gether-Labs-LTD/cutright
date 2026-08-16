// Copy the few browser assets we load with <script>/<link> out of node_modules into
// renderer/vendor. No bundler: the renderer is plain ES5-ish JS + two vendored libs, and
// a strict CSP means everything must be same-origin and local.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'renderer/vendor');
mkdirSync(OUT, { recursive: true });

const files = [
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];
for (const [src, dst] of files) copyFileSync(join(ROOT, src), join(OUT, dst));
console.log(`vendored ${files.length} files → renderer/vendor`);
