import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { COLORS, GLYPHS } from '../tokens.js';

/* Menu row — cursor + optional hotkey marker `[h]` + label + dim hint
 * + optional right-aligned badge. Drop-in replacement for the
 * Menu+MenuItem combo in components.tsx; this is the per-row component
 * so screens that want richer rows (badges, sub-rows) can compose them
 * directly without going through the all-or-nothing Menu shell.
 *
 * Design source: terminal.jsx → <MenuRow>; screens.jsx → ScreenMenu.
 */
interface MenuRowProps {
  selected?: boolean;
  /** Single-character hotkey marker rendered as `[h]` before the label.
   * Optional — items without a sensible letter just omit it. */
  hotkey?: string;
  label: string;
  /** Dim trailing string after the label. Examples: "trigger block in
   * global .md", "EN / ES". */
  hint?: string;
  /** Right-aligned status badge — typically a <Badge>. Used by the
   * client picker (registered / not registered per row) and the
   * language picker (current). */
  badge?: ReactNode;
}

export function MenuRow({ selected = false, hotkey, label, hint, badge }: MenuRowProps) {
  const cursor = selected ? GLYPHS.cursor : ' ';
  return (
    <Box>
      <Text color={selected ? COLORS.focus : COLORS.muted}>{cursor} </Text>
      {hotkey !== undefined && hotkey !== '' && (
        <Text>
          <Text color={COLORS.muted}>[</Text>
          <Text color={selected ? COLORS.focus : COLORS.primary} bold={selected} underline>
            {hotkey}
          </Text>
          <Text color={COLORS.muted}>] </Text>
        </Text>
      )}
      <Text color={selected ? 'white' : COLORS.muted} bold={selected}>
        {label}
      </Text>
      {hint !== undefined && hint !== '' && (
        <Text color={COLORS.muted} dimColor>
          {'  '}
          {hint}
        </Text>
      )}
      {badge !== undefined && (
        <Box marginLeft={2} flexGrow={1} justifyContent="flex-end">
          {badge}
        </Box>
      )}
    </Box>
  );
}
