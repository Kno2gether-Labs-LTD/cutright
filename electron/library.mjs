// The project library — what the Home screen lists.
//
// Two sources, deliberately. `recent` is what the user has opened, which is the right list most
// of the time but is capped and forgets. Recordings are different: the app made them, it knows
// exactly where it put them (~/Movies/Cutright), and a take the user has not opened yet would
// otherwise be invisible — they would have to go and find a folder in Finder, which rather
// defeats recording from inside the editor. So the folder is scanned too, and the two merge.
//
// Everything here tolerates rubbish on disk. A project folder can be half-written, hand-edited,
// or moved out from under us; a library that throws is worse than one that shows less.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// project.json carries the whole edit and can be large, so parse at most once per change.
const cache = new Map();          // dir -> { mtimeMs, info }

function readInfo(dir, originHint = null) {
  const file = join(dir, 'project.json');
  let st;
  try { st = statSync(file); } catch { return null; }        // not a project folder
  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.hint === originHint) return hit.info;

  let p = {};
  try { p = JSON.parse(readFileSync(file, 'utf8')); } catch { p = {}; }
  const meta = p.meta || {};
  const rec = p.recording || null;
  const info = {
    dir,
    name: meta.title || basename(dir),
    // `origin` is stamped when the project is created. Older projects predate it, and an
    // unreadable one tells us nothing at all — so fall back to the evidence, in order: a
    // recording block, then where the folder lives. Calling a take "from a video" because its
    // project.json failed to parse would be a small lie in the one place provenance is claimed.
    origin: meta.origin || (rec ? 'recording' : originHint) || 'import',
    createdBy: meta.createdBy || null,
    createdAt: meta.createdAt || rec?.startedAt || null,
    // The length of the thing you would open, not how long the session ran. A take with a pause
    // in it has a wall-clock duration well over the footage it produced — one real recording
    // read 3:05 next to a 1:18 video — and the row is about the video.
    duration: Number(meta.duration || rec?.duration || 0) || 0,
    hasCamera: !!rec?.camera,
    cuts: (p.cuts || []).length,
    missing: !existsSync(dir),
  };
  cache.set(dir, { mtimeMs: st.mtimeMs, hint: originHint, info });
  return info;
}

// Recording folders are named "<stamp> <title>", so the newest sort first by name alone; but
// mtime is what the user actually means by recent, so sort on that and only use the name to
// break ties deterministically.
function scanRecordings(recordingsDir) {
  let names = [];
  try { names = readdirSync(recordingsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }                                        // no recordings folder yet
  return names.map((n) => join(recordingsDir, n)).filter((d) => existsSync(join(d, 'project.json')));
}

export function listLibrary({ recent = [], recordingsDir, limit = 24 } = {}) {
  const dirs = [];
  const seen = new Set();
  const fromRecordings = new Set(recordingsDir ? scanRecordings(recordingsDir) : []);
  for (const d of [...recent, ...fromRecordings]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    dirs.push(d);
  }

  const items = dirs.map((d) => readInfo(d, fromRecordings.has(d) ? 'recording' : null)).filter(Boolean);
  const order = new Map(recent.map((d, i) => [d, i]));
  items.sort((a, b) => {
    // Whatever the user opened most recently stays at the top — that is what "continue" means.
    const ra = order.has(a.dir) ? order.get(a.dir) : Infinity;
    const rb = order.has(b.dir) ? order.get(b.dir) : Infinity;
    if (ra !== rb) return ra - rb;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
  return items.slice(0, limit);
}

export const _internals = { readInfo, scanRecordings, cache };
