# Changelog

## [0.7.2](https://github.com/jobshimo/browser-link/compare/v0.7.1...v0.7.2) (2026-05-12)


### Bug Fixes

* **ci:** publish step on v0.7.1 failed with a misleading `404 Not Found` from npm. The `--provenance` attestation was signed and accepted by Sigstore, but the subsequent `PUT` to the registry was rejected. Diagnosis: npm Trusted Publishers validates the OIDC token's `workflow_ref` and `event_name` claims, and chained-workflow events (`workflow_run`, similar to `workflow_call`) ship claims that the direct-trigger contract on npmjs.com does not accept. Fix: collapse the release pipeline into `ci.yml` as a `release` job downstream of the test matrix (`needs: ci`, `if: event_name == 'push' && ref == refs/heads/main`). The OIDC token now carries `event_name: push` and `workflow_ref: …/ci.yml@…`, matching the Trusted Publisher contract.

### Refactor

* **ci:** delete `.github/workflows/release-finalize.yml`. Its three concerns (tag, GitHub Release, npm publish) live in the new `release` job inside `ci.yml`. One fewer workflow file, zero `workflow_run` chains, simpler OIDC story.

## [0.7.1](https://github.com/jobshimo/browser-link/compare/v0.7.0...v0.7.1) (2026-05-12)


### Features

* **ci:** automate `npm publish` from the release-finalize workflow. After CI on `main` is green and the tag + GitHub Release are created, the same workflow now publishes the package to npm via [Trusted Publisher](https://docs.npmjs.com/trusted-publishers) (OIDC). No `NPM_TOKEN` is stored in GitHub secrets — the npm package is configured to trust this specific workflow file, and the OIDC handshake mints a short-lived credential per publish. The publish includes `--provenance`, so npm attaches a verifiable [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) that ties each tarball to the workflow run + commit that produced it.

### Miscellaneous

* idempotent publish: the workflow runs `npm view @jobshimo/browser-link@$VERSION` first and skips the publish step if the version is already on the registry. A partial-failure re-run (tag created, publish failed) can therefore retry publish without re-creating the tag.

## [0.7.0](https://github.com/jobshimo/browser-link/compare/v0.6.0...v0.7.0) (2026-05-12)


### ⚠ BREAKING CHANGES

* **node:** `engines.node` is now `>=22.13`. Users running Node 20 or earlier will get a hard refusal from `npm install -g @jobshimo/browser-link`. Upgrade to Node 22.13+ (current LTS). The README already documented Node 22+ as a requirement; this release makes it formal at the package level.

### Features

* **build:** migrate the monorepo to **pnpm 11.1.1**. The published tarball is identical — consumers keep installing with `npm i -g @jobshimo/browser-link` exactly as before. Maintainer-side, `npm install` becomes `pnpm install`, the lockfile is now `pnpm-lock.yaml`, and the pinned version lives in `packageManager` (so Corepack picks it up automatically — devs only need `corepack enable` once).
* **security:** explicit `allowBuilds` allowlist in `pnpm-workspace.yaml`. Only `better-sqlite3` and `esbuild` are allowed to run postinstall scripts; anything else in the dependency tree is silently blocked. This closes a supply-chain class of attacks that npm leaves wide open by default.

### Bug Fixes

* **ci:** drop Node 20 from the matrix. The README already required Node 22+, so the Node 20 jobs were testing a configuration we don't officially support — and they were the source of intermittent `actions/setup-node@v6` cache flakes on `windows-latest`. The matrix is now `[ubuntu-latest, windows-latest] × [22]`.

### Refactor

* **release:** `scripts/release.mjs` now invokes `pnpm install --lockfile-only` and stages `pnpm-lock.yaml`; `scripts/version-gate.mjs` error messages now suggest `pnpm run release`. `packages/server/scripts/prepare-publish.mjs` spawns `pnpm run build` instead of `npm run build` when rebuilding the extension during `pnpm publish`.

### Miscellaneous

* added `.npmrc` (`engine-strict=true`, `auto-install-peers=true`) and `pnpm-workspace.yaml`. Removed `package-lock.json`. README "Development setup" section updated to reflect the new toolchain (`corepack enable && pnpm install`).

## [0.6.0](https://github.com/jobshimo/browser-link/compare/v0.5.4...v0.6.0) (2026-05-12)


### Features

* **ci:** hard `Version Gate` workflow — every PR to `main` is required to bump all five versioned files (root `package.json`, `packages/server/package.json`, `packages/extension/package.json`, `packages/extension/manifest.json`, `packages/shared/package.json`) in lockstep, with the new version strictly greater than `origin/main`. Mark it as a required check on `main` after this PR merges so the rule becomes truly hard.
* **ci:** `release-finalize` is now driven by the version field in `packages/server/package.json` instead of the merge commit subject. Runs as a `workflow_run` listener on the CI workflow, only when CI on `main` is green. Creates the tag and the GitHub Release through the REST API (no `git push` anywhere). Idempotent — if the release for the current version already exists, the job is a no-op.

### Refactor

* **release:** version utilities extracted to `scripts/lib/versions.mjs`, shared by `scripts/release.mjs` and the new `scripts/version-gate.mjs`. Single source of truth for the list of versioned files.

### Miscellaneous

* removed `.githooks/pre-push` and its README section. The optional interactive release reminder is gone — the strict CI gate replaces it.

## [0.5.4](https://github.com/jobshimo/browser-link/compare/v0.5.3...v0.5.4) (2026-05-12)


### Bug Fixes

* **publish:** rebuild the Chrome extension before bundling it into the npm package, and refuse to publish when the extension manifest version disagrees with `packages/server/package.json`. v0.5.3 shipped with the extension manifest stuck at `0.4.0` because `prepare-publish.mjs` only ran an `npm run build` for the extension when its `dist/manifest.json` was missing — stale builds were copied as-is. The script now always cleans the extension `dist/` and rebuilds before copying, and aborts with a clear error on any version mismatch.

## [0.5.3](https://github.com/jobshimo/browser-link/compare/v0.5.2...v0.5.3) (2026-05-12)


### Features

* **claims:** cooperative tab ownership across agents — `browser.claim_tab`, `browser.release_tab`, `browser.my_tabs`, plus `claimed_by` / `claimed_by_me` on `browser.list_tabs`. Action tools auto-claim free tabs and reject when another agent holds the tab. TTL by inactivity, auto-release on IPC disconnect, full audit trail via `browser.events` ([#32](https://github.com/jobshimo/browser-link/pull/32)).
* **extension:** redesigned popup with English copy, brand-aligned visual, pulsing status dot, gradient action button ([#30](https://github.com/jobshimo/browser-link/pull/30)).
* **updates:** in-place self-update from the setup UI — press `u` in the Updates screen to stop the running primary and run `npm install -g` automatically ([#32](https://github.com/jobshimo/browser-link/pull/32)).
* **release:** self-serve PR-based release tooling — `npm run release -- <bump>` creates a release branch + PR, finalize workflow tags and creates the GitHub Release on merge ([#32](https://github.com/jobshimo/browser-link/pull/32)).

### Security

* Cleared all open CodeQL alerts: switch-dispatch over closed tool-name union (`unvalidated-dynamic-method-call`), `assertSafeNpmName` validates the registry URL parameter (`file-access-to-http`), `sanitizeLogValue` strips control characters from IPC bridge logs (`log-injection`), removed unused imports ([#32](https://github.com/jobshimo/browser-link/pull/32)).

### Configuration

* **multi-agent + auto-reelect default ON** for fresh installs; on-disk config only carries explicit overrides ([#32](https://github.com/jobshimo/browser-link/pull/32)).

## [0.5.2](https://github.com/jobshimo/browser-link/compare/v0.5.1...v0.5.2) (2026-05-12)


### Bug Fixes

* **auth:** identify WS peer by local endpoint, not socket presence ([#23](https://github.com/jobshimo/browser-link/pull/23)) — Chrome handshakes were rejected with HTTP 403 on macOS/Linux because `lookupPeerProcess` returned the server's own identity for any loopback connection. The lsof lookup now filters by local endpoint and refuses to identify the server as its own peer.

## [0.5.1](https://github.com/jobshimo/browser-link/compare/v0.5.0...v0.5.1) (2026-05-12)


### Bug Fixes

* **deps:** bump react to ^19.2.0 to satisfy ink 7 peer dependency ([#20](https://github.com/jobshimo/browser-link/issues/20)) ([71c3919](https://github.com/jobshimo/browser-link/commit/71c3919c177b62d1afc76baf37677c77d5cbc2ac))

## [0.5.0](https://github.com/jobshimo/browser-link/compare/v0.4.1...v0.5.0) (2026-05-12)


### Features

* cut 0.5.0 — CI/CD setup + peerLookup DI + major dep bumps ([#18](https://github.com/jobshimo/browser-link/issues/18)) ([547af10](https://github.com/jobshimo/browser-link/commit/547af10cff851d0074dc00c415df1405dee98a52))
