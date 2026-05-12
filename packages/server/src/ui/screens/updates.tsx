import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { checkUpdates, type UpdateInfo } from '../../commands/updates.js';
import {
  runSelfUpdate,
  type SelfUpdateProgress,
  type SelfUpdateResult,
} from '../../commands/self-update.js';
import { PACKAGE_NAME } from '../../version.js';
import type { CommonProps } from './types.js';

const UPDATES_I18N: Record<
  Language,
  {
    title: string;
    checking: string;
    current: string;
    latest: string;
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
  }
> = {
  en: {
    title: 'Check for updates',
    checking: 'Checking the npm registry…',
    current: 'Current version',
    latest: 'Latest on npm  ',
    upToDate: '✓ You are on the latest published version.',
    available: '⚠ A newer version is available.',
    upgradeCmd: 'Or, to upgrade manually, run:',
    updateKeyHint: 'Press u to update now (stops any running primary, then installs).',
    updateRunning: 'Updating…',
    error: 'Could not check the registry',
    footerIdle: 'r retry · ↵ / Esc back to menu',
    footerWithUpdate: 'u update · r retry · ↵ / Esc back to menu',
    footerUpdating: 'updating — please wait…',
    footerDone: '↵ / Esc back to menu — restart your MCP client to pick up the new version',
    footerFailed: 'r retry check · ↵ / Esc back to menu',
  },
  es: {
    title: 'Buscar actualizaciones',
    checking: 'Consultando el registry de npm…',
    current: 'Versión instalada',
    latest: 'Última en npm    ',
    upToDate: '✓ Estás en la última versión publicada.',
    available: '⚠ Hay una versión más nueva disponible.',
    upgradeCmd: 'O, para actualizar a mano, corré:',
    updateKeyHint: 'Tocá u para actualizar ahora (corta el primary en uso e instala).',
    updateRunning: 'Actualizando…',
    error: 'No se pudo consultar el registry',
    footerIdle: 'r reintentar · ↵ / Esc volver al menú',
    footerWithUpdate: 'u actualizar · r reintentar · ↵ / Esc volver al menú',
    footerUpdating: 'actualizando — esperá…',
    footerDone: '↵ / Esc volver al menú — reiniciá tu cliente MCP para que tome la nueva versión',
    footerFailed: 'r reintentar el chequeo · ↵ / Esc volver al menú',
  },
};

interface UpdatesViewProps extends CommonProps {
  onBack: () => void;
}

/** Local UI state for an in-flight self-update. Drives both the body and
 * the footer so the user sees one consistent stage label. */
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
    // Guard against the type-system view (info: UpdateInfo | null,
    // info.latest: string | null) — these are real runtime checks even
    // though `canUpdate` already implies both. Without them TS won't
    // narrow `info.latest` to `string` in the closure scope.
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
    if (isUpdating) return; // ignore keys while the install is in flight
    if (key.return || key.escape) onBack();
    else if (input === 'r' && update.kind !== 'done') setRefreshKey((k) => k + 1);
    else if (input === 'u') startUpdate();
  });

  const footer =
    update.kind === 'running'
      ? t.footerUpdating
      : update.kind === 'done'
        ? t.footerDone
        : update.kind === 'failed'
          ? t.footerFailed
          : canUpdate
            ? t.footerWithUpdate
            : t.footerIdle;

  return (
    <Frame title={t.title} footer={footer}>
      {info === null ? (
        <Text color="gray">{t.checking}</Text>
      ) : info.error || info.latest === null ? (
        <Box flexDirection="column">
          <Text>
            <Text color="white">{t.current}: </Text>
            <Text bold>{info.current}</Text>
          </Text>
          <Box marginTop={1}>
            <Text color="red">
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
          <Text>
            <Text color="white">{t.latest}: </Text>
            <Text bold color={info.newer ? 'yellow' : 'green'}>
              {info.latest}
            </Text>
          </Text>
          <Box marginTop={1}>
            <Text color={info.newer ? 'yellow' : 'green'}>
              {info.newer ? t.available : t.upToDate}
            </Text>
          </Box>
          {info.newer && update.kind === 'idle' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan">{t.updateKeyHint}</Text>
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">{t.upgradeCmd}</Text>
                <Text color="cyan">{`npm install -g ${PACKAGE_NAME}@latest`}</Text>
              </Box>
            </Box>
          )}
          {update.kind === 'running' && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="cyan">{t.updateRunning}</Text>
              <Text color="gray">{update.message}</Text>
            </Box>
          )}
          {update.kind === 'done' && (
            <Box marginTop={1}>
              <Text color="green">{update.message}</Text>
            </Box>
          )}
          {update.kind === 'failed' && (
            <Box marginTop={1}>
              <Text color="red">{update.message}</Text>
            </Box>
          )}
        </Box>
      )}
    </Frame>
  );
}
