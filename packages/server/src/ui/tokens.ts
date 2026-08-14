/* Design tokens — the Pragmatic mood (Mood A) of the v0.9.0 visual refactor.
 *
 * Ink accepts ANSI color names directly via the `color` prop on <Text>,
 * so this module is a thin semantic-role → ANSI-name mapping, not a
 * hex-to-color translator. The full design source lives at
 * `~/browser-link/browser-link/tokens.jsx` (Mood A · Pragmatic).
 *
 * `dimColor` on Ink's <Text> handles the "muted" role; we still expose
 * `muted: 'gray'` so consumers reading from COLORS get a sensible fallback
 * when they want the muted *color* (e.g. a separator dot) and not the
 * dim *effect* (which is applied via the dimColor prop instead).
 */

export const COLORS = {
  primary: 'cyan',
  success: 'green',
  warn: 'yellow',
  error: 'red',
  info: 'blue',
  muted: 'gray',
  focus: 'cyan',
  heading: 'cyan',
} as const;

export type ColorRole = keyof typeof COLORS;

/* Glyph set A — Shapes. Chosen for max cross-terminal compatibility:
 * every glyph below renders cleanly on cmd.exe-equivalent terminals
 * (Windows Terminal, iTerm2, modern xterms). The corresponding
 * design source is `tokens.jsx` → GLYPHS.shapes. */
export const GLYPHS = {
  cursor: '❯',
  success: '✓',
  error: '✗',
  warn: '⚠',
  info: 'ℹ',
  dot: '·',
  arrow: '→',
  up: '↑',
  down: '↓',
  enter: '↵',
  esc: '⎋',
  space: '␣',
  /* Status badges — glyph + space + label. Kept here so the same string
   * is reused across screens (Agent Instructions, Client Picker, Doctor). */
  badgeOk: '✓ installed',
  badgeWarn: '⚠ outdated',
  badgeOff: '· not installed',
  badgeFail: '✗ failed',
  /* Agent-instructions specific — used when the target .md file does
   * not exist yet (install will create it). */
  badgeNoFile: '· no file yet',
} as const;

export type GlyphKey = keyof typeof GLYPHS;

/* Spacing scale — three levels only, mapped directly to Ink margin props.
 * See `~/browser-link/browser-link/tokens.jsx` → SPACE and `system.jsx` →
 * SpacingCard for the per-level usage spec. Don't introduce a fourth value. */
export const SPACE = {
  none: 0,
  gap: 1,
  block: 2,
} as const;

export type SpaceKey = keyof typeof SPACE;
