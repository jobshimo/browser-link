import { Box, Text } from 'ink';
import { COLORS } from '../tokens.js';

/* Status strip — `Claude · registered   OpenCode · not registered   …`.
 * Pinned at the top of every Frame so the user always sees the live
 * installation state for the three supported clients without leaving
 * the screen they're on.
 *
 * The state strings are passed in pre-resolved: the bar itself doesn't
 * call into `INSTALLERS.detect()` — it lets the caller (or a shared
 * hook) own that, which keeps tests deterministic and avoids touching
 * disk on every render. */
export type ClientState = 'registered' | 'not registered' | 'not detected';

export interface StatusBarItem {
  name: string;
  /** Localised display string. `state` is the *normalised* English key
   * used to pick the color; `label` is what the user reads. */
  state: ClientState;
  label: string;
}

interface StatusBarProps {
  items: StatusBarItem[];
}

function stateColor(state: ClientState): string {
  if (state === 'registered') return COLORS.success;
  if (state === 'not registered') return COLORS.warn;
  return COLORS.muted;
}

export function StatusBar({ items }: StatusBarProps) {
  return (
    <Box>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <Box key={item.name} marginRight={last ? 0 : 3}>
            <Text>
              <Text bold>{item.name}</Text>
              <Text color={COLORS.muted}> · </Text>
              <Text color={stateColor(item.state)}>{item.label}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
