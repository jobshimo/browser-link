import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { INSTALLERS } from '../installers/index.js';

/* Shared visual building blocks for the Ink UI. Header is pinned at the top
 * of every screen and shows the live status of each MCP client. Footer is
 * pinned at the bottom and shows the contextual keybindings. Frame wraps
 * children with both, plus a soft border and consistent inner padding. */

interface FrameProps {
  title: string;
  footer: string;
  children: ReactNode;
}

export function Frame({ title, footer, children }: FrameProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan" bold>
          {title}
        </Text>
        <StatusBar />
      </Box>
      <Box flexDirection="column">{children}</Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          {footer}
        </Text>
      </Box>
    </Box>
  );
}

function StatusBar() {
  return (
    <Box>
      {INSTALLERS.map((inst, i) => {
        const d = inst.detect();
        const { color, label } = !d.installed
          ? { color: 'gray', label: 'not detected' }
          : d.registered
            ? { color: 'green', label: 'registered' }
            : { color: 'yellow', label: 'not registered' };
        return (
          <Box key={inst.id} marginRight={i === INSTALLERS.length - 1 ? 0 : 3}>
            <Text>
              <Text bold>{inst.displayName}</Text>
              <Text color="gray"> · </Text>
              <Text color={color}>{label}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface MenuItem<V extends string> {
  value: V;
  label: string;
  hint?: string;
}

interface MenuProps<V extends string> {
  items: MenuItem<V>[];
  selectedIndex: number;
}

/* Pure render of a vertical menu — the App owns the selectedIndex state and
 * the key handling (we don't pull in ink-select-input so we can colour and
 * format hints exactly the way we want). */
export function Menu<V extends string>({ items, selectedIndex }: MenuProps<V>) {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => {
        const isSel = i === selectedIndex;
        return (
          <Box key={item.value}>
            <Text color={isSel ? 'cyan' : 'gray'}>{isSel ? '❯ ' : '  '}</Text>
            <Text color={isSel ? 'white' : 'gray'} bold={isSel}>
              {item.label}
            </Text>
            {item.hint && (
              <Text color="gray" dimColor>
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
