import { Box, Text } from 'ink';
import { COLORS, GLYPHS } from '../tokens.js';

/* Checkbox row — cursor + `[x]`/`[ ]` + label + optional dim hint.
 * Used by Permissions and Multi-agent. The `dimmed` flag is for rows
 * that are visible but currently inert (e.g. "auto-reelect" while
 * multi-agent is OFF — the row exists, but you can't toggle it). */
interface CheckRowProps {
  selected?: boolean;
  on: boolean;
  label: string;
  hint?: string;
  /** When true, override the [x]/[ ] color to muted and the label to
   * the muted role — signals the row is currently inactive. */
  dimmed?: boolean;
}

export function CheckRow({ selected = false, on, label, hint, dimmed = false }: CheckRowProps) {
  const cursor = selected ? GLYPHS.cursor : ' ';
  const boxColor = dimmed ? COLORS.muted : on ? COLORS.success : COLORS.error;
  const boxMark = on ? '[x]' : '[ ]';
  return (
    <Box>
      <Text color={selected ? COLORS.focus : COLORS.muted}>{cursor} </Text>
      <Text color={boxColor}>{boxMark} </Text>
      <Text
        color={dimmed ? COLORS.muted : selected ? 'white' : COLORS.muted}
        bold={selected && !dimmed}
      >
        {label}
      </Text>
      {hint !== undefined && hint !== '' && (
        <Text color={COLORS.muted} dimColor>
          {'  '}
          {hint}
        </Text>
      )}
    </Box>
  );
}
