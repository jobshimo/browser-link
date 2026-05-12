# Changelog

## [0.5.2](https://github.com/jobshimo/browser-link/compare/v0.5.1...v0.5.2) (2026-05-12)


### Bug Fixes

* **auth:** identify WS peer by local endpoint, not socket presence ([#23](https://github.com/jobshimo/browser-link/pull/23)) — Chrome handshakes were rejected with HTTP 403 on macOS/Linux because `lookupPeerProcess` returned the server's own identity for any loopback connection. The lsof lookup now filters by local endpoint and refuses to identify the server as its own peer.

## [0.5.1](https://github.com/jobshimo/browser-link/compare/v0.5.0...v0.5.1) (2026-05-12)


### Bug Fixes

* **deps:** bump react to ^19.2.0 to satisfy ink 7 peer dependency ([#20](https://github.com/jobshimo/browser-link/issues/20)) ([71c3919](https://github.com/jobshimo/browser-link/commit/71c3919c177b62d1afc76baf37677c77d5cbc2ac))

## [0.5.0](https://github.com/jobshimo/browser-link/compare/v0.4.1...v0.5.0) (2026-05-12)


### Features

* cut 0.5.0 — CI/CD setup + peerLookup DI + major dep bumps ([#18](https://github.com/jobshimo/browser-link/issues/18)) ([547af10](https://github.com/jobshimo/browser-link/commit/547af10cff851d0074dc00c415df1405dee98a52))
