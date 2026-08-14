import { Box, Text } from 'ink';
import { COLORS, GLYPHS } from '../tokens.js';
import { KeyCap } from './key-cap.js';

/* Footer keybinding strip — `[↑↓] navigate · [↵] select · [q] quit`.
 * Replaces the plain-text footer pattern that every screen had to
 * hand-roll before. The keycap visual sets the keys apart from the
 * labels so users find the hotkey at a glance even without color. */

export interface FooterKeyItem {
  /** Visible key label — single character ("q"), short word ("Esc"),
   * or a combined cue ("↑↓"). */
  k: string;
  /** What pressing the key does — "navigate", "back", "save", etc. */
  label: string;
}

interface FooterKeysProps {
  items: FooterKeyItem[];
}

export function FooterKeys({ items }: FooterKeysProps) {
  return (
    <Box>
      {items.map((it, i) => {
        const last = i === items.length - 1;
        return (
          <Box key={`${it.k}-${i}`}>
            <KeyCap label={it.k} />
            <Text color={COLORS.muted}> {it.label}</Text>
            {!last && (
              <Text color={COLORS.muted} dimColor>
                {`   ${GLYPHS.dot}   `}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
