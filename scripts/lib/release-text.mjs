// User-facing text of scripts/release.mjs, kept pure so it is unit-tested.
//
// It must describe the real flow: merging a release PR to main runs the
// `ci` workflow, whose `release` job smoke-tests the npm tarball, creates
// the tag and the GitHub Release, and publishes to npm with OIDC
// provenance. Nothing is manual after the merge.

const PACKAGE_NAME = '@jobshimo/browser-link';

/** Body of the release PR opened by scripts/release.mjs. */
export function buildReleasePrBody({ version, changelogEntry }) {
  return [
    `Cut release \`v${version}\`.`,
    '',
    'Merging this PR runs the `ci` workflow on `main`. After the CI matrix passes, its `release` job:',
    `- smoke-tests the npm tarball (\`node scripts/smoke-tarball.mjs\`);`,
    `- creates the tag \`v${version}\` and the GitHub Release with the notes below;`,
    `- publishes \`${PACKAGE_NAME}@${version}\` to npm with OIDC provenance.`,
    '',
    'Nothing is manual after the merge.',
    '',
    '---',
    '',
    changelogEntry,
  ].join('\n');
}

/** Closing lines scripts/release.mjs prints once the PR is open. */
export function releaseDoneInstructions(version) {
  return [
    `Release PR opened for v${version}.`,
    'Review the diff and merge it via the GitHub UI once the checks pass.',
    'The merge runs the `release` job in ci.yml, which smoke-tests the tarball,',
    'creates the tag and GitHub Release, and publishes to npm. No manual step follows.',
  ];
}
