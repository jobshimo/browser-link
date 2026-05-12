# Changelog

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
