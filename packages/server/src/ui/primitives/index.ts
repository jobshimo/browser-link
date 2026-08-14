/* Single import surface for the v0.9.0 design-system primitives. Every
 * screen imports from here, never from individual files — keeps the
 * dependency graph one-deep and lets us swap a primitive's source file
 * without thrashing imports across 10+ callers. */

export { Badge, type BadgeKind } from './badge.js';
export { CheckRow } from './check-row.js';
export { FooterKeys, type FooterKeyItem } from './footer-keys.js';
export { InlineSpinner } from './inline-spinner.js';
export { KeyCap } from './key-cap.js';
export { MenuRow } from './menu-row.js';
export { SectionHead } from './section-head.js';
export { StatusBar, type ClientState, type StatusBarItem } from './status-bar.js';
