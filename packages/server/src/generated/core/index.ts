// GENERATED from packages/core/src/index.ts. Do not edit.
// @browser-link/core: the transport-independent core of the browser-link
// service worker and cdp-direct (docs/design/service-worker-architecture.md).
// The ports and their contract suite (slice 5), and the pure modules slice
// 5b-2 created here: `support/utf8`, `support/flow-limits`, `policies/idle-rules`,
// the in-page JS builders (`inpage/*`, slice 6) and the support modules
// (`support/{settle,expect,keymap,screenshot,observer-host}`, slice 7), which
// the extension imports and the server compiles from its generated mirror.

export type * from './ports/index.js';
export * from './ports/contract/index.js';
export * from './support/utf8.js';
export * from './support/flow-limits.js';
export * from './support/settle.js';
export * from './support/expect.js';
export * from './support/keymap.js';
export * from './support/screenshot.js';
export * from './support/observer-host.js';
export * from './policies/idle-rules.js';
export * from './inpage/builders.js';
export * from './inpage/observer.js';
export * from './inpage/deep-query.js';
export * from './inpage/dom-helpers.js';
