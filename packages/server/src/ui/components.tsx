import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { INSTALLERS } from '../installers/index.js';
import { COLORS, GLYPHS } from './tokens.js';
import { StatusBar, type ClientState, type StatusBarItem } from './primitives/index.js';

/* Shared visual building blocks for the Ink UI. Header is pinned at the top
 * of every screen and shows the live status of each MCP client. Footer is
 * pinned at the bottom and shows the contextual keybindings. Frame wraps
 * children with both, plus a soft border and consistent inner padding.
 *
 * As of v0.9.0:
 *   - Frame.footer accepts a ReactNode so callers can drop in a <FooterKeys>
 *     keycap strip (preferred) or fall back to a plain string (legacy paths
 *     that still need the inline-help shape).
 *   - Frame.badge optionally renders a right-aligned tag next to the title
 *     (`PRIMARY`, `v0.9.0 · EN · single-agent`).
 *   - StatusBar is the design-system primitive from `primitives/status-bar`
 *     — Frame stitches the live `INSTALLERS.detect()` output into that
 *     shape so every screen gets the same strip without rethreading props.
 *   - borderColor accepts an override so error states (port collision)
 *     can render a red frame without rebuilding the wrapper.
 */

interface FrameProps {
  title: ReactNode;
  /** Footer slot — typically a <FooterKeys> from primitives, but plain
   * strings are still accepted for the few screens that interleave help
   * text into the footer. */
  footer: ReactNode;
  /** Right-aligned tag rendered next to the title — e.g. "PRIMARY",
   * "v0.9.0 · EN · single-agent". */
  badge?: ReactNode;
  /** Override the border color. Defaults to gray; error screens pass red. */
  borderColor?: string;
  children: ReactNode;
}

export function Frame({ title, footer, badge, borderColor = 'gray', children }: FrameProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={COLORS.heading} bold>
            {title}
          </Text>
          {badge !== undefined && (
            <Box marginLeft={2} flexGrow={1} justifyContent="flex-end">
              {badge}
            </Box>
          )}
        </Box>
        <LiveStatusBar />
      </Box>
      <Box flexDirection="column">{children}</Box>
      <Box marginTop={1}>{typeof footer === 'string' ? <FooterText text={footer} /> : footer}</Box>
    </Box>
  );
}

function FooterText({ text }: { text: string }) {
  return (
    <Text color={COLORS.muted} dimColor>
      {text}
    </Text>
  );
}

/* Project the installer registry into the StatusBar primitive's input
 * shape. Held inside this module so the rest of the UI doesn't reach
 * into INSTALLERS just to render the header. */
function LiveStatusBar() {
  const items: StatusBarItem[] = INSTALLERS.map((inst) => {
    const d = inst.detect();
    let state: ClientState;
    let label: string;
    if (!d.installed) {
      state = 'not detected';
      label = 'not detected';
    } else if (d.registered) {
      state = 'registered';
      label = 'registered';
    } else {
      state = 'not registered';
      label = 'not registered';
    }
    return { name: inst.displayName, state, label };
  });
  return <StatusBar items={items} />;
}

interface MenuItem<V extends string> {
  value: V;
  label: string;
  hint?: string;
  /** Optional single-character hotkey marker — rendered as `[h]` before
   * the label. Screens that wire hotkeys via useInput should set this so
   * the visual cue and the keyboard handler stay in sync. */
  hotkey?: string;
}

interface MenuProps<V extends string> {
  items: MenuItem<V>[];
  selectedIndex: number;
}

/* Pure render of a vertical menu — the App owns the selectedIndex state and
 * the key handling (we don't pull in ink-select-input so we can colour and
 * format hints exactly the way we want). Items with a `hotkey` render a
 * `[h]` marker before the label; the keyboard binding itself is set up by
 * the screen's `useInput`. */
export function Menu<V extends string>({ items, selectedIndex }: MenuProps<V>) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const isSel = i === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={isSel ? COLORS.focus : COLORS.muted}>
              {isSel ? `${GLYPHS.cursor} ` : '  '}
            </Text>
            {item.hotkey !== undefined && item.hotkey !== '' && (
              <Text>
                <Text color={COLORS.muted}>[</Text>
                <Text color={isSel ? COLORS.focus : COLORS.primary} bold={isSel} underline>
                  {item.hotkey}
                </Text>
                <Text color={COLORS.muted}>] </Text>
              </Text>
            )}
            <Text color={isSel ? 'white' : COLORS.muted} bold={isSel}>
              {item.label}
            </Text>
            {item.hint !== undefined && item.hint !== '' && (
              <Text color={COLORS.muted} dimColor>
                {'  '}
                {item.hint}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

export type { MenuItem };
