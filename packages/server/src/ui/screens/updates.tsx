import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { Badge, FooterKeys, InlineSpinner, KeyCap } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { checkUpdates, type UpdateInfo } from '../../commands/updates.js';
import {
  runSelfUpdate,
  type SelfUpdateProgress,
  type SelfUpdateResult,
} from '../../commands/self-update.js';
import { PACKAGE_NAME } from '../../version.js';
import type { CommonProps } from './types.js';

/* Updates screen. Same async lifecycle, redesigned chrome:
 *   - "Current version" / "Latest on npm" as two value rows with the
 *     latest tagged with a <Badge> when newer.
 *   - When `available`, the "Press u to update" line uses a keycap.
 *   - When running, an InlineSpinner sits next to the status message.
 *   - When done, the success row + restart hint stays.
 */
const UPDATES_I18N: Record<
  Language,
  {
    title: string;
    checking: string;
    current: string;
    latest: string;
    newer: string;
    upToDate: string;
    available: string;
    upgradeCmd: string;
    updateKeyHint: string;
    updateRunning: string;
    error: string;
    footerIdle: string;
    footerWithUpdate: string;
    footerUpdating: string;
    footerDone: string;
    footerFailed: string;
    backLabel: string;
    retryLabel: string;
    updateLabel: string;
    waitLabel: string;
  }
> = {
  en: {
    title: 'Check for updates',
    checking: 'Checking the npm registry…',
    current: 'Current version',
    latest: 'Latest on npm  ',
    newer: 'newer',
    upToDate: 'You are on the latest published version.',
    available: 'A newer version is available.',
    upgradeCmd: 'Or, to upgrade manually, run:',
    updateKeyHint: 'to update now (stops any running primary, then installs).',
    updateRunning: 'Updating…',
    error: 'Could not check the registry',
    footerIdle: 'r retry · ↵ / Esc back to menu',
    footerWithUpdate: 'u update · r retry · ↵ / Esc back to menu',
    footerUpdating: 'updating — please wait…',
    footerDone: '↵ / Esc back to menu — restart your MCP client to pick up the new version',
    footerFailed: 'r retry check · ↵ / Esc back to menu',
    backLabel: 'back to menu',
    retryLabel: 'retry',
    updateLabel: 'update',
    waitLabel: 'updating — please wait',
  },
  es: {
    title: 'Buscar actualizaciones',
    checking: 'Consultando el registry de npm…',
    current: 'Versión instalada',
    latest: 'Última en npm    ',
    newer: 'más nueva',
    upToDate: 'Estás en la última versión publicada.',
    available: 'Hay una versión más nueva disponible.',
    upgradeCmd: 'O, para actualizar a mano, corré:',
    updateKeyHint: 'para actualizar ahora (corta el primary en uso e instala).',
    updateRunning: 'Actualizando…',
    error: 'No se pudo consultar el registry',
    footerIdle: 'r reintentar · ↵ / Esc volver al menú',
    footerWithUpdate: 'u actualizar · r reintentar · ↵ / Esc volver al menú',
    footerUpdating: 'actualizando — esperá…',
    footerDone: '↵ / Esc volver al menú — reiniciá tu cliente MCP para que tome la nueva versión',
    footerFailed: 'r reintentar el chequeo · ↵ / Esc volver al menú',
    backLabel: 'volver al menú',
    retryLabel: 'reintentar',
    updateLabel: 'actualizar',
    waitLabel: 'actualizando — esperá',
  },
};

interface UpdatesViewProps extends CommonProps {
  onBack: () => void;
}

type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'running'; stage: SelfUpdateProgress['stage']; message: string }
  | { kind: 'done'; message: string }
  | { kind: 'failed'; message: string };

export function UpdatesView({ language, onBack }: UpdatesViewProps) {
  const t = UPDATES_I18N[language];
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [update, setUpdate] = useState<UpdatePhase>({ kind: 'idle' });

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setUpdate({ kind: 'idle' });
    void checkUpdates().then((r) => {
      if (!cancelled) setInfo(r);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const isUpdating = update.kind === 'running';
  const canUpdate = info !== null && info.newer === true && info.latest !== null && !isUpdating;

  const startUpdate = (): void => {
    if (info === null) return;
    const target = info.latest;
    if (target === null) return;
    if (!canUpdate) return;
    setUpdate({ kind: 'running', stage: 'preflight', message: t.updateRunning });
    runSelfUpdate(target, language, (event) => {
      setUpdate({ kind: 'running', stage: event.stage, message: event.message });
    })
      .then((result: SelfUpdateResult) => {
        setUpdate({
          kind: result.ok ? 'done' : 'failed',
          message: result.message,
        });
      })
      .catch((err: unknown) => {
        setUpdate({
          kind: 'failed',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  };

  useInput((input, key) => {
    if (isUpdating) return;
    if (key.return || key.escape) onBack();
    else if (input === 'r' && update.kind !== 'done') setRefreshKey((k) => k + 1);
    else if (input === 'u') startUpdate();
  });

  const footerItems = (() => {
    if (update.kind === 'running') return [{ k: GLYPHS.dot, label: t.waitLabel }];
    if (update.kind === 'done') return [{ k: GLYPHS.enter, label: t.backLabel }];
    if (canUpdate) {
      return [
        { k: 'u', label: t.updateLabel },
        { k: 'r', label: t.retryLabel },
        { k: GLYPHS.enter, label: t.backLabel },
      ];
    }
    return [
      { k: 'r', label: t.retryLabel },
      { k: GLYPHS.enter, label: t.backLabel },
    ];
  })();

  return (
    <Frame title={t.title} footer={<FooterKeys items={footerItems} />}>
      {info === null ? (
        <Box>
          <InlineSpinner />
          <Text color={COLORS.muted}>{` ${t.checking}`}</Text>
        </Box>
      ) : info.error || info.latest === null ? (
        <Box flexDirection="column">
          <Text>
            <Text color="white">{t.current}: </Text>
            <Text bold>{info.current}</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={COLORS.error}>
              {t.error}: {info.error ?? 'unknown error'}
            </Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text color="white">{t.current}: </Text>
            <Text bold>{info.current}</Text>
          </Text>
          <Box>
            <Text color="white">{t.latest}: </Text>
            <Text bold color={info.newer ? COLORS.warn : COLORS.success}>
              {info.latest}
            </Text>
            {info.newer && (
              <Box marginLeft={2}>
                <Badge kind="warn" label={t.newer} />
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={info.newer ? COLORS.warn : COLORS.success}>
              {info.newer ? `${GLYPHS.warn} ${t.available}` : `${GLYPHS.success} ${t.upToDate}`}
            </Text>
          </Box>
          {info.newer && update.kind === 'idle' && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text color={COLORS.primary}>Press </Text>
                <KeyCap label="u" />
                <Text color={COLORS.primary}> {t.updateKeyHint}</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.muted}>{t.upgradeCmd}</Text>
                <Text color={COLORS.primary}>{`npm install -g ${PACKAGE_NAME}@latest`}</Text>
              </Box>
            </Box>
          )}
          {update.kind === 'running' && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <InlineSpinner />
                <Text color={COLORS.primary}>{` ${t.updateRunning}`}</Text>
              </Box>
              <Text color={COLORS.muted}>{update.message}</Text>
            </Box>
          )}
          {update.kind === 'done' && (
            <Box marginTop={1}>
              <Text color={COLORS.success}>
                {GLYPHS.success} {update.message}
              </Text>
            </Box>
          )}
          {update.kind === 'failed' && (
            <Box marginTop={1}>
              <Text color={COLORS.error}>
                {GLYPHS.error} {update.message}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Frame>
  );
}
