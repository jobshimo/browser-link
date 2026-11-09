import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { COLORS } from '../tokens.js';
import { SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { buildAdminState, type AdminInput } from '../../admin/descriptor.js';
import { gatherAdminInput, probeRunningServer } from '../../admin/sources.js';
import type { AdminItem } from '../../messages.js';
import { useBackgroundUpdateCheck, type UpdateCheckState } from '../hooks/use-update-check.js';
import { MainMenu, type MenuAction } from './menu.js';
import type { CommonProps } from './types.js';

/* Status view (S4) — the console's first screen. The top block is the
 * `status` section of the admin descriptor (`admin/descriptor.ts`), the
 * same source the popup's Admin section renders, built here out of
 * process: the running primary answers `/version` or the rows say it is
 * not running, and the tab count stays with the primary. Below it are the
 * existing menu rows with their hotkeys (it is `MainMenu` with a header),
 * so every screen is still one key away; Tab opens the full menu. */

const STATUS_I18N: Record<Language, { title: string; loading: string; menu: string }> = {
  en: { title: 'browser-link — status', loading: 'Reading status…', menu: 'menu' },
  es: { title: 'browser-link — estado', loading: 'Leyendo el estado…', menu: 'menú' },
};

/** The console's facts: the primary's `/version`, the local config and files. */
export function loadLocalAdminInput(): Promise<AdminInput> {
  return gatherAdminInput({ server: probeRunningServer });
}

interface StatusViewProps extends CommonProps {
  onSelect: (action: MenuAction) => void;
  onOpenMenu: () => void;
  onSwapLang: () => void;
  onQuit: () => void;
  /** Test seam: production reads the real machine. */
  loadInput?: () => Promise<AdminInput>;
  /** Test seams forwarded to the menu rows. */
  outdatedClientNames?: () => string[];
  updateState?: UpdateCheckState;
}

function display(value: AdminItem['value']): string {
  if (value === null || value === undefined) return '—';
  return String(value);
}

function StatusRows({ items, heading }: { items: AdminItem[]; heading: string }) {
  const width = Math.max(...items.map((i) => i.label.length), 0) + 2;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <SectionHead>{heading.toUpperCase()}</SectionHead>
      {items.map((item) => (
        <Box key={item.id}>
          <Text color={COLORS.muted}>{`  ${item.label.padEnd(width)}`}</Text>
          <Text>{display(item.value)}</Text>
          {item.hint !== undefined && (
            <Text color={COLORS.muted} dimColor>
              {`  ${item.hint}`}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export function StatusView({
  language,
  onSelect,
  onOpenMenu,
  onSwapLang,
  onQuit,
  loadInput = loadLocalAdminInput,
  outdatedClientNames,
  updateState,
}: StatusViewProps) {
  const t = STATUS_I18N[language];
  // One update check for both the status row and the menu's banner; an
  // injected state replaces the network call entirely.
  const injected = useMemo(
    () => (updateState ? { runCheck: () => Promise.resolve(updateState) } : undefined),
    [updateState],
  );
  const hookState = useBackgroundUpdateCheck(injected);
  const update = updateState ?? hookState;
  const [input, setInput] = useState<AdminInput | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadInput()
      .then((next) => {
        if (!cancelled) setInput(next);
      })
      .catch(() => {
        /* the rows stay on "reading"; the menu below still works */
      });
    return () => {
      cancelled = true;
    };
  }, [loadInput]);

  // The console's language wins over the config's: `l` swaps it live.
  const section = input
    ? buildAdminState({
        ...input,
        config: { ...input.config, language },
        update: update.latest === null ? input.update : update,
      }).sections.find((s) => s.id === 'status')
    : undefined;

  const header = section ? (
    <StatusRows items={section.items} heading={section.title} />
  ) : (
    <Box marginBottom={1}>
      <Text color={COLORS.muted} dimColor>
        {t.loading}
      </Text>
    </Box>
  );

  return (
    <MainMenu
      language={language}
      onSelect={onSelect}
      onSwapLang={onSwapLang}
      onQuit={onQuit}
      outdatedClientNames={outdatedClientNames}
      updateState={update}
      title={t.title}
      header={header}
      onOpenMenu={{ run: onOpenMenu, label: t.menu }}
    />
  );
}
