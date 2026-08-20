#!/usr/bin/env node
// The Home list: does it find recordings the app made, and say where each project came from?
//
// The interesting cases are the messy ones. A project folder can be half-written or hand-edited,
// a recording can sit in ~/Movies/Cutright without ever having been opened, and projects made
// before provenance was stamped have no `origin` at all. A library that throws — or that quietly
// drops a take the user recorded — is worse than one that shows less, so each of those is a test.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLibrary } from '../electron/library.mjs';

const root = mkdtempSync(join(tmpdir(), 'cutright-library-'));
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !detail ? '' : `\n      ${detail}`}`);
  if (!cond) failed++;
};

const make = (dir, project) => {
  mkdirSync(dir, { recursive: true });
  if (project !== null) writeFileSync(join(dir, 'project.json'),
    typeof project === 'string' ? project : JSON.stringify(project));
  return dir;
};

const recordings = join(root, 'Movies', 'Cutright');
const takeA = make(join(recordings, '2026-08-19 1430 Demo'), {
  // The session ran 185s with a pause in it; the video it produced is 95s.
  meta: { origin: 'recording', createdBy: 'Cutright 0.1.0', createdAt: '2026-08-19T14:30:00Z', duration: 95 },
  recording: { camera: 'recording/camera.mp4', duration: 185 }, cuts: [1, 2] });
const takeB = make(join(recordings, '2026-08-18 0900 Older'), {
  meta: { origin: 'recording', createdAt: '2026-08-18T09:00:00Z' }, recording: { duration: 30 } });
// predates provenance: only the recording block says what it is
const legacy = make(join(recordings, '2026-08-01 1000 Legacy'), {
  meta: { duration: 12 }, recording: { startedAt: '2026-08-01T10:00:00Z', duration: 12 } });
const imported = make(join(root, 'imports', 'A talk'), {
  meta: { origin: 'import', createdBy: 'Cutright 0.1.0', createdAt: '2026-08-17T10:00:00Z', duration: 600 } });
const broken = make(join(recordings, '2026-08-19 1600 Broken'), '{ this is not json');
make(join(recordings, 'not-a-project'), null);          // a folder with nothing in it

console.log('library — what the Home screen lists\n');

const items = listLibrary({ recent: [imported], recordingsDir: recordings });
const by = (d) => items.find((i) => i.dir === d);

ok('a recording that was never opened still appears', !!by(takeA),
   'listed: ' + items.map((i) => i.dir.split('/').pop()).join(', '));
ok('the project the user last opened stays first', items[0]?.dir === imported,
   'first was ' + items[0]?.dir);
ok('a recording is labelled as one', by(takeA)?.origin === 'recording');
ok('an imported video is not', by(imported)?.origin === 'import');
ok('it carries who made it', by(takeA)?.createdBy === 'Cutright 0.1.0');
// The row shows the date separately, so repeating the stamp in the name just costs characters.
ok('the timestamp prefix is dropped from a recording name', by(takeA)?.name === 'Demo',
   'got ' + JSON.stringify(by(takeA)?.name));
ok('a folder that is ONLY a timestamp keeps it, rather than showing nothing',
   (() => { const d = make(join(recordings, '2026-08-02 1200'), { meta: {}, recording: { duration: 4 } });
            return listLibrary({ recordingsDir: recordings }).find((i) => i.dir === d)?.name === '2026-08-02 1200'; })());
ok('an explicit title always wins',
   (() => { const d = make(join(recordings, '2026-08-03 1200 Raw'), { meta: { title: 'The good take' } });
            return listLibrary({ recordingsDir: recordings }).find((i) => i.dir === d)?.name === 'The good take'; })());
ok('the length shown is the video, not how long the session ran',
   by(takeA)?.duration === 95, 'got ' + by(takeA)?.duration + ' (185 is the wall clock)');
ok('falling back to the session length when there is no video length',
   by(takeB)?.duration === 30, 'got ' + by(takeB)?.duration);
ok('and whether a camera was rolling', by(takeA)?.hasCamera === true && by(takeB)?.hasCamera === false);
ok('a project from before provenance is still recognised as a recording',
   by(legacy)?.origin === 'recording', 'got ' + by(legacy)?.origin);
ok('its date falls back to when the take started',
   by(legacy)?.createdAt === '2026-08-01T10:00:00Z', 'got ' + by(legacy)?.createdAt);
ok('unreadable project.json is listed, not thrown away', !!by(broken),
   'a corrupt file should degrade to a bare row, not vanish');
ok('and a corrupt one in the recordings folder is still called a recording',
   by(broken)?.origin === 'recording', 'got ' + by(broken)?.origin);
ok('a folder with no project.json is not offered', !items.some((i) => i.dir.endsWith('not-a-project')));
ok('nothing is listed twice', new Set(items.map((i) => i.dir)).size === items.length);

// A missing recordings folder is the first-run state, not an error.
const fresh = listLibrary({ recent: [imported], recordingsDir: join(root, 'nope') });
ok('no recordings folder yet is fine', fresh.length === 1 && fresh[0].dir === imported);
ok('no arguments at all is fine', listLibrary().length === 0);

// The cache is keyed on mtime, so an edit has to be picked up.
writeFileSync(join(takeB, 'project.json'), JSON.stringify({
  meta: { origin: 'recording', title: 'Renamed', duration: 30 }, recording: { duration: 30 } }));
const after = listLibrary({ recent: [], recordingsDir: recordings }).find((i) => i.dir === takeB);
ok('an edited project is re-read, not served from cache', after?.name === 'Renamed',
   'got ' + after?.name);

rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
