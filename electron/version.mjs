// Is one version newer than another?
//
// Small enough to look obvious and quietly easy to get wrong: "0.10.0" is newer than "0.9.0"
// even though it sorts earlier as text, and a tag may or may not carry a leading v. Getting this
// backwards means either nagging someone who is already up to date, or never telling them an
// update exists — and the second failure is silent.
export function parseVersion(v) {
  return String(v || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]                    // ignore a pre-release suffix for ordering
    .split('.')
    .map((n) => {
      const x = parseInt(n, 10);
      return Number.isFinite(x) ? x : 0;
    });
}

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) > 0;
