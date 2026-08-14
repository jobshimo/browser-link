/**
 * Single semver-ish comparator used by both `agent-instructions/file-ops`
 * (deciding whether an installed block is outdated) and `commands/updates`
 * (deciding whether the npm registry has a newer version). Pre-release
 * suffixes like `0.3.0-beta.1` are NOT handled — both call sites only ever
 * compare plain MAJOR.MINOR.PATCH strings. Anything that does not parse
 * cleanly is treated as the segment integer `0`, which yields a stable
 * (if not semver-correct) ordering rather than throwing.
 *
 * The `null` branch represents the legacy unversioned marker the agent-
 * instructions installer used to write. By construction it predates any
 * real VERSION, so it always compares less than a real string.
 */

export function compareSemver(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
