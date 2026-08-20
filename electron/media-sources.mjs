// Where to get footage, stills and sound you are allowed to use.
//
// Cutright hosts nothing and downloads nothing. This is a directory, so the agent can point you
// at the right place and — the part that matters — tell you what the licence asks of you BEFORE
// you build a video around a clip.
//
// The licence is the whole point of the file. "Free" covers at least four different things:
// free and unencumbered (CC0), free if you credit (CC BY), free but not for anything you make
// money from (CC BY-NC), and free on a site whose own terms rule out commercial use. Getting
// those confused is how a monetised video ends up carrying something it may not. So a source is
// never described as merely "free": every entry names its licence, and asking for commercially
// usable sources EXCLUDES anything that is not, rather than showing it with a warning.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cache = null;

export function load(dataDir) {
  if (cache) return cache;
  const file = join(dataDir, 'media-sources.json');
  if (!existsSync(file)) return (cache = { version: 0, licences: {}, sources: [] });
  try { cache = JSON.parse(readFileSync(file, 'utf8')); }
  catch { cache = { version: 0, licences: {}, sources: [] }; }
  return cache;
}

export function reset() { cache = null; }

// A source with its licence spelled out, rather than as an id nobody can interpret.
function expand(src, licences) {
  const lic = licences[src.licence] || { name: src.licence, commercial: null, attribution: 'check', plain: '' };
  return {
    ...src,
    licence: {
      id: src.licence, name: lic.name, url: lic.url || '',
      commercial: lic.commercial, attribution: lic.attribution, modify: lic.modify,
      plain: lic.plain || '',
    },
    // What a person actually needs to know at a glance.
    safeForPaidWork: lic.commercial === true,
    needsCredit: lic.attribution === 'required',
    checkEachItem: src.licence === 'mixed' || lic.attribution === 'check',
  };
}

export function list(dataDir, { kind = '', commercialOnly = false } = {}) {
  const data = load(dataDir);
  let out = (data.sources || []).map((s) => expand(s, data.licences || {}));
  if (kind) out = out.filter((s) => (s.kinds || []).includes(kind));
  if (commercialOnly) {
    // Deliberately strict: `mixed` sources are excluded too. They CONTAIN usable material, but a
    // list of "safe for paid work" that includes a site where half the items are CC BY-NC is a
    // list that will eventually be wrong about something a person shipped.
    out = out.filter((s) => s.licence.commercial === true);
  }
  return out;
}

export function byId(dataDir, id) {
  return list(dataDir).find((s) => s.id === id) || null;
}

// A credit line, recorded at the moment the material is taken. Going back afterwards to work out
// which of forty sounds needed crediting is the kind of job nobody does.
export function creditFor(source, { title = '', url = '', author = '' } = {}) {
  return {
    source: source.id, sourceName: source.name,
    title: String(title).slice(0, 160) || null,
    author: String(author).slice(0, 120) || null,
    url: String(url).slice(0, 400) || source.url,
    licence: source.licence.id,
    licenceName: source.licence.name,
    required: source.licence.attribution === 'required' || source.licence.attribution === 'check',
    at: new Date().toISOString(),
  };
}

// Rendered for a description box or an end card.
export function creditLines(credits) {
  return (credits || []).map((c) => {
    const what = c.title || 'material';
    const who = c.author ? ` by ${c.author}` : '';
    return `${what}${who} — ${c.sourceName} (${c.licenceName})${c.url ? ' · ' + c.url : ''}`;
  });
}

// Used by the test, and by anything that wants to fail loudly on a malformed catalogue rather
// than quietly show a source with no licence.
export function validate(data) {
  const problems = [];
  const licences = data?.licences || {};
  const ids = new Set();
  for (const s of data?.sources || []) {
    const where = s.id || '(no id)';
    if (!s.id) problems.push('a source has no id');
    if (ids.has(s.id)) problems.push(`${where}: id used twice`);
    ids.add(s.id);
    if (!s.name) problems.push(`${where}: no name`);
    if (!Array.isArray(s.kinds) || !s.kinds.length) problems.push(`${where}: no kinds`);
    for (const k of s.kinds || []) if (!['video', 'image', 'audio'].includes(k)) problems.push(`${where}: unknown kind "${k}"`);
    if (!licences[s.licence]) problems.push(`${where}: licence "${s.licence}" is not defined`);
    if (!/^https:\/\//.test(s.url || '')) problems.push(`${where}: url is not https`);
    if (s.api && !/^https:\/\//.test(s.api)) problems.push(`${where}: api url is not https`);
    if (!s.watch) problems.push(`${where}: no caveat — every source has one`);
  }
  for (const [id, l] of Object.entries(licences)) {
    if (!l.name) problems.push(`licence ${id}: no name`);
    if (!l.plain) problems.push(`licence ${id}: no plain-language summary`);
    if (!['required', 'appreciated', 'none', 'check'].includes(l.attribution)) {
      problems.push(`licence ${id}: attribution "${l.attribution}" is not one of required/appreciated/none/check`);
    }
  }
  return problems;
}
