/**
 * Single semver-ish comparator used by `agent-instructions/file-ops`
 * (deciding whether an installed block is outdated), `commands/updates`
 * (deciding whether the npm registry has a newer version), `commands/doctor`,
 * `lifecycle/election` (which primary yields to which) and the extension
 * skew check in `tools/browser-dispatch`.
 *
 * Ordering follows semver 2.0 precedence:
 *  - the dotted numeric core is compared segment by segment (missing
 *    segments count as 0; a segment that does not parse counts as 0, which
 *    yields a stable ordering rather than throwing; more than three
 *    segments are tolerated);
 *  - when the cores are equal, a version WITH a pre-release (`1.1.0-rc.1`)
 *    ranks below the same core without one (`1.1.0`);
 *  - two pre-releases compare identifier by identifier (split on dots):
 *    numeric identifiers numerically, alphanumeric ones lexically in ASCII
 *    order, a numeric identifier below an alphanumeric one, and a shorter
 *    set below a longer one when every preceding identifier is equal;
 *  - build metadata (`+...`) is ignored.
 *
 * The `null` branch represents the legacy unversioned marker the agent-
 * instructions installer used to write. By construction it predates any
 * real VERSION, so it always compares less than a real string.
 */

const NUMERIC = /^\d+$/;

function parse(v: string): { core: number[]; pre: string[] | null } {
  const noBuild = v.split('+', 1)[0] ?? '';
  const dash = noBuild.indexOf('-');
  const coreText = dash === -1 ? noBuild : noBuild.slice(0, dash);
  const preText = dash === -1 ? null : noBuild.slice(dash + 1);
  return {
    core: coreText.split('.').map((s) => parseInt(s, 10) || 0),
    pre: preText === null || preText === '' ? null : preText.split('.'),
  };
}

function comparePre(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ia = a[i] ?? '';
    const ib = b[i] ?? '';
    const na = NUMERIC.test(ia);
    const nb = NUMERIC.test(ib);
    if (na && nb) {
      const d = Number(ia) - Number(ib);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function compareSemver(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const pa = parse(a);
  const pb = parse(b);
  const n = Math.max(pa.core.length, pb.core.length, 3);
  for (let i = 0; i < n; i++) {
    const da = pa.core[i] ?? 0;
    const db = pb.core[i] ?? 0;
    if (da !== db) return da - db;
  }
  if (pa.pre === null && pb.pre === null) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}
