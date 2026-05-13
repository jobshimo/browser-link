import { Text } from 'ink';
import { COLORS, GLYPHS } from '../tokens.js';

/* Status badge — glyph + space + label, all in one role color.
 * Six kinds map to the design system's five status meanings (ok, warn,
 * fail, off, info) plus `noFile` which is a specialised "off" variant
 * for agent-instructions screens where "no file yet" reads more
 * accurately than the generic "not installed". */
type BadgeKind = 'ok' | 'warn' | 'fail' | 'off' | 'info' | 'noFile';

interface BadgeProps {
  kind: BadgeKind;
  /** Optional override for the rendered text. When omitted, the default
   * text comes from GLYPHS[badge*] (so callers reach for the same label
   * across screens). Use `label` for context-specific copy: an i18n
   * string, a version-suffixed label like "installed (v3)", etc. */
  label?: string;
}

const KIND_TO_COLOR: Record<BadgeKind, string> = {
  ok: COLORS.success,
  warn: COLORS.warn,
  fail: COLORS.error,
  off: COLORS.muted,
  info: COLORS.info,
  /* "no file yet" reads as muted, same as the generic off state. */
  noFile: COLORS.muted,
};

const KIND_TO_GLYPH: Record<BadgeKind, string> = {
  ok: GLYPHS.success,
  warn: GLYPHS.warn,
  fail: GLYPHS.error,
  off: GLYPHS.dot,
  info: GLYPHS.info,
  noFile: GLYPHS.dot,
};

const KIND_TO_DEFAULT_LABEL: Record<BadgeKind, string> = {
  ok: 'installed',
  warn: 'outdated',
  fail: 'failed',
  off: 'not installed',
  info: 'info',
  noFile: 'no file yet',
};

export function Badge({ kind, label }: BadgeProps) {
  const color = KIND_TO_COLOR[kind];
  const glyph = KIND_TO_GLYPH[kind];
  const text = label ?? KIND_TO_DEFAULT_LABEL[kind];
  return (
    <Text color={color}>
      {glyph} {text}
    </Text>
  );
}

export type { BadgeKind };
