import { Box, Text } from 'ink';
import { COLORS } from '../tokens.js';

/* Section header inside a screen body. Cyan bold caps line — used to
 * group menu items (SETUP / DIAGNOSE / REFERENCE in the main menu) and
 * to label tool families (Browser bridge / Persistent UI map in
 * Permissions). Margin top of 1 separates it from the previous group;
 * children of the section follow with no extra margin. */
interface SectionHeadProps {
  /** Visible header text. The caller decides whether to upper-case it —
   * we don't transform here because some headers (e.g. "Author") look
   * better in title case. */
  children: string;
  /** Optional dim trailing string — e.g. "3 / 5 enabled" next to a
   * tool-family header. */
  hint?: string;
}

export function SectionHead({ children, hint }: SectionHeadProps) {
  return (
    <Box marginTop={1}>
      <Text color={COLORS.heading} bold>
        {children}
      </Text>
      {hint !== undefined && hint !== '' && (
        <Text color={COLORS.muted} dimColor>
          {'   '}
          {hint}
        </Text>
      )}
    </Box>
  );
}
