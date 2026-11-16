import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { Badge, FooterKeys, InlineSpinner, KeyCap } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { checkUpdates, type UpdateInfo } from '../../commands/updates.js';
import {
  readUpdatePlan,
  runSelfUpdate,
  SELF_UPDATE_TIMEOUT_MS,
  type SelfUpdateProgress,
  type SelfUpdateProgressCallback,
  type SelfUpdateResult,
  type UpdatePlan,
} from '../../commands/self-update.js';
import { PACKAGE_NAME } from '../../version.js';
import type { CommonProps } from './types.js';

/* Updates screen. The registry check, then the update (owner decision D18):
 *   - u reads what the update would touch and shows it; nothing runs until
 *     y. n or Esc answers no.
 *   - While it runs, c cancels the install; it also ends by itself at the
 *     time limit. Every other key waits.
 *   - The result shows what was stopped, whether it installed, npm's real
 *     error and what to do next. Once finished, u is disabled.
 */
const LIMIT_MINUTES = SELF_UPDATE_TIMEOUT_MS / 60_000;

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
    press: string;
    updateKeyHint: string;
    planning: string;
    confirmTitle: (target: string) => string;
    serverRunning: (version: string, pid: number) => string;
    serverNone: string;
    serverUnreadable: string;
    sessionsUnreadable: string;
    sessionsInUse: (n: number) => string;
    others: (n: number) => string;
    othersUnreadable: string;
    willStop: string;
    willStopIfRunning: string;
    stoppedAgents: string;
    othersNotStopped: string;
    nothingWillStop: string;
    noStop: string;
    thenInstall: (target: string) => string;
    confirmQuestion: string;
    updateRunning: string;
    cancelHint: string;
    error: string;
    backLabel: string;
    retryLabel: string;
    updateLabel: string;
    yesLabel: string;
    noLabel: string;
    cancelLabel: string;
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
    press: 'Press',
    updateKeyHint: 'to update now (shows what it will do and asks first).',
    planning: 'Reading what the update would touch…',
    confirmTitle: (target) => `Update to ${target}?`,
    serverRunning: (version, pid) =>
      `A browser-link server is running: version ${version}, PID ${pid}.`,
    serverNone: 'No browser-link server is running.',
    serverUnreadable: 'Could not read whether a browser-link server is running.',
    sessionsUnreadable: 'How many agent sessions use it cannot be read from this console.',
    sessionsInUse: (n) => `It is in use by ${n} agent ${n === 1 ? 'session' : 'sessions'}.`,
    others: (n) =>
      n === 0
        ? 'No other browser-link process is running.'
        : `${n} other browser-link ${n === 1 ? 'process is' : 'processes are'} running (agents connected through the server, or other consoles).`,
    othersUnreadable: 'The other browser-link processes could not be listed.',
    willStop:
      'It will be stopped before the install: Windows keeps the files of a running server locked.',
    willStopIfRunning:
      'If a server is running, it will be stopped before the install (Windows keeps its files locked).',
    stoppedAgents: 'Agents using it lose browser-link until their MCP client restarts.',
    othersNotStopped: 'Other browser-link processes are not stopped.',
    nothingWillStop: 'Nothing will be stopped.',
    noStop:
      'Nothing will be stopped. A running server keeps the old version until its MCP client restarts.',
    thenInstall: (target) =>
      `Then: npm install -g ${PACKAGE_NAME}@${target}, stopped after ${LIMIT_MINUTES} minutes at most; press c to cancel it sooner.`,
    confirmQuestion: 'Update now?',
    updateRunning: 'Updating…',
    cancelHint: 'Press c to cancel the install.',
    error: 'Could not check the registry',
    backLabel: 'back to menu',
    retryLabel: 'retry',
    updateLabel: 'update',
    yesLabel: 'yes, update',
    noLabel: 'no',
    cancelLabel: 'cancel the install',
    waitLabel: 'reading — please wait',
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
    press: 'Apretá',
    updateKeyHint: 'para actualizar ahora (te muestra qué va a hacer y te pregunta antes).',
    planning: 'Leyendo qué tocaría la actualización…',
    confirmTitle: (target) => `¿Actualizar a ${target}?`,
    serverRunning: (version, pid) =>
      `Hay un servidor browser-link corriendo: versión ${version}, PID ${pid}.`,
    serverNone: 'No hay ningún servidor browser-link corriendo.',
    serverUnreadable: 'No se pudo leer si hay un servidor browser-link corriendo.',
    sessionsUnreadable: 'Desde esta consola no se puede leer cuántas sesiones de agentes lo usan.',
    sessionsInUse: (n) =>
      `Está en uso por ${n} ${n === 1 ? 'sesión de agente' : 'sesiones de agentes'}.`,
    others: (n) =>
      n === 0
        ? 'No hay otros procesos de browser-link corriendo.'
        : n === 1
          ? 'Hay 1 proceso más de browser-link corriendo (un agente conectado por el servidor, u otra consola).'
          : `Hay ${n} procesos más de browser-link corriendo (agentes conectados por el servidor, u otras consolas).`,
    othersUnreadable: 'No se pudo listar los otros procesos de browser-link.',
    willStop:
      'Se va a detener antes de instalar: Windows mantiene bloqueados los archivos de un servidor en marcha.',
    willStopIfRunning:
      'Si hay un servidor corriendo, se va a detener antes de instalar (Windows mantiene bloqueados sus archivos).',
    stoppedAgents:
      'Los agentes que lo usan se quedan sin browser-link hasta que su cliente MCP se reinicie.',
    othersNotStopped: 'Los otros procesos de browser-link no se detienen.',
    nothingWillStop: 'No se va a detener nada.',
    noStop:
      'No se va a detener nada. Un servidor en marcha sigue con la versión anterior hasta que su cliente MCP se reinicie.',
    thenInstall: (target) =>
      `Después: npm install -g ${PACKAGE_NAME}@${target}, se corta a los ${LIMIT_MINUTES} minutos como mucho; apretá c para cancelarla antes.`,
    confirmQuestion: '¿Actualizar ahora?',
    updateRunning: 'Actualizando…',
    cancelHint: 'Apretá c para cancelar la instalación.',
    error: 'No se pudo consultar el registry',
    backLabel: 'volver al menú',
    retryLabel: 'reintentar',
    updateLabel: 'actualizar',
    yesLabel: 'sí, actualizar',
    noLabel: 'no',
    cancelLabel: 'cancelar la instalación',
    waitLabel: 'leyendo — esperá',
  },
};

type UpdatesStrings = (typeof UPDATES_I18N)[Language];

/** The update itself; `signal` cancels the install. */
export type RunUpdate = (
  target: string,
  language: Language,
  onProgress: SelfUpdateProgressCallback,
  signal: AbortSignal,
) => Promise<SelfUpdateResult>;

const defaultRunUpdate: RunUpdate = (target, language, onProgress, signal) =>
  runSelfUpdate(target, language, onProgress, { signal });

const defaultReadPlan = (): Promise<UpdatePlan> => readUpdatePlan();

interface UpdatesViewProps extends CommonProps {
  onBack: () => void;
  /** The registry check. Default `checkUpdates`; tests inject a stub. */
  checkUpdates?: () => Promise<UpdateInfo>;
  /** What the update would touch. Default `readUpdatePlan`. */
  readPlan?: () => Promise<UpdatePlan>;
  /** The update. Default `runSelfUpdate`. */
  runUpdate?: RunUpdate;
}

type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'planning' }
  | { kind: 'confirm'; plan: UpdatePlan }
  | { kind: 'running'; stage: SelfUpdateProgress['stage']; message: string }
  | { kind: 'finished'; result: SelfUpdateResult };

/** The preview's lines, each one a fact that was read or a rule that holds. */
function planLines(plan: UpdatePlan, target: string, t: UpdatesStrings): string[] {
  const lines: string[] = [];
  const { server } = plan;
  if (server.kind === 'running') lines.push(t.serverRunning(server.version, server.pid));
  else if (server.kind === 'none') lines.push(t.serverNone);
  else lines.push(t.serverUnreadable);
  if (server.kind === 'running' && server.sessions !== undefined) {
    lines.push(t.sessionsInUse(server.sessions));
  } else if (server.kind !== 'none') lines.push(t.sessionsUnreadable);
  lines.push(plan.otherProcesses === null ? t.othersUnreadable : t.others(plan.otherProcesses));
  if (!plan.stopsServer) lines.push(t.noStop);
  else if (server.kind === 'none') lines.push(t.nothingWillStop);
  else {
    lines.push(server.kind === 'running' ? t.willStop : t.willStopIfRunning);
    lines.push(t.stoppedAgents, t.othersNotStopped);
  }
  lines.push(t.thenInstall(target));
  return lines;
}

function failedResult(target: string, err: unknown): SelfUpdateResult {
  return {
    ok: false,
    outcome: 'failed',
    target,
    message: `${GLYPHS.error} ${err instanceof Error ? err.message : String(err)}`,
    stopReport: null,
    nextStep: '',
  };
}

export function UpdatesView({
  language,
  onBack,
  checkUpdates: check = checkUpdates,
  readPlan = defaultReadPlan,
  runUpdate = defaultRunUpdate,
}: UpdatesViewProps) {
  const t = UPDATES_I18N[language];
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [update, setUpdate] = useState<UpdatePhase>({ kind: 'idle' });
  const install = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    // A finished update stays on screen: a re-check does not hide it.
    setUpdate((prev) => (prev.kind === 'finished' ? prev : { kind: 'idle' }));
    void check().then((r) => {
      if (!cancelled) setInfo(r);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, check]);

  const target = info !== null && info.newer === true ? info.latest : null;
  const canUpdate = target !== null && update.kind === 'idle';

  const showPlan = (): void => {
    setUpdate({ kind: 'planning' });
    readPlan()
      .then((plan) => {
        setUpdate({ kind: 'confirm', plan });
      })
      .catch(() => {
        setUpdate({ kind: 'idle' });
      });
  };

  const startUpdate = (version: string): void => {
    // Set synchronously: two confirmations delivered in one tick both see the
    // phase the screen last rendered, so the phase cannot be the guard.
    if (install.current !== null) return;
    const controller = new AbortController();
    install.current = controller;
    setUpdate({ kind: 'running', stage: 'preflight', message: t.updateRunning });
    const done = (): void => {
      if (install.current === controller) install.current = null;
    };
    runUpdate(
      version,
      language,
      (event) => {
        setUpdate({ kind: 'running', stage: event.stage, message: event.message });
      },
      controller.signal,
    )
      .then((result) => {
        done();
        setUpdate({ kind: 'finished', result });
      })
      .catch((err: unknown) => {
        done();
        setUpdate({ kind: 'finished', result: failedResult(version, err) });
      });
  };

  // Leaving the screen (or the console exiting) with an install running
  // cancels it through the same signal the `c` key uses: nobody would be
  // watching it. `install.current` is non-null only while one runs.
  useEffect(
    () => () => {
      const running = install.current;
      if (running !== null && !running.signal.aborted) running.abort();
    },
    [],
  );

  useInput((input, key) => {
    switch (update.kind) {
      case 'planning':
        return;
      case 'running':
        if (input === 'c') install.current?.abort();
        return;
      case 'confirm':
        if (input === 'y' && target !== null) startUpdate(target);
        else if (input === 'n' || key.escape) setUpdate({ kind: 'idle' });
        return;
      case 'finished':
        if (key.return || key.escape) onBack();
        else if (input === 'r' && update.result.outcome !== 'installed') {
          setRefreshKey((k) => k + 1);
        }
        return;
      case 'idle':
        if (key.return || key.escape) onBack();
        else if (input === 'r') setRefreshKey((k) => k + 1);
        else if (input === 'u' && canUpdate) showPlan();
    }
  });

  const footerItems = (() => {
    switch (update.kind) {
      case 'planning':
        return [{ k: GLYPHS.dot, label: t.waitLabel }];
      case 'running':
        return [{ k: 'c', label: t.cancelLabel }];
      case 'confirm':
        return [
          { k: 'y', label: t.yesLabel },
          { k: 'n', label: t.noLabel },
        ];
      case 'finished':
        return update.result.outcome === 'installed'
          ? [{ k: GLYPHS.enter, label: t.backLabel }]
          : [
              { k: 'r', label: t.retryLabel },
              { k: GLYPHS.enter, label: t.backLabel },
            ];
      case 'idle':
        return canUpdate
          ? [
              { k: 'u', label: t.updateLabel },
              { k: 'r', label: t.retryLabel },
              { k: GLYPHS.enter, label: t.backLabel },
            ]
          : [
              { k: 'r', label: t.retryLabel },
              { k: GLYPHS.enter, label: t.backLabel },
            ];
    }
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
          {canUpdate && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text color={COLORS.primary}>{`${t.press} `}</Text>
                <KeyCap label="u" />
                <Text color={COLORS.primary}> {t.updateKeyHint}</Text>
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.muted}>{t.upgradeCmd}</Text>
                <Text color={COLORS.primary}>{`npm install -g ${PACKAGE_NAME}@latest`}</Text>
              </Box>
            </Box>
          )}
          {update.kind === 'planning' && (
            <Box marginTop={1}>
              <InlineSpinner />
              <Text color={COLORS.muted}>{` ${t.planning}`}</Text>
            </Box>
          )}
          {update.kind === 'confirm' && target !== null && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color={COLORS.warn}>
                {t.confirmTitle(target)}
              </Text>
              {planLines(update.plan, target, t).map((line) => (
                <Text key={line}>{line}</Text>
              ))}
              <Box marginTop={1}>
                <Text bold>{t.confirmQuestion}</Text>
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
              <Text color={COLORS.muted}>{t.cancelHint}</Text>
            </Box>
          )}
          {update.kind === 'finished' && (
            <Box flexDirection="column" marginTop={1}>
              {update.result.stopReport !== null && (
                <Text color={COLORS.muted}>{update.result.stopReport}</Text>
              )}
              {/* The message carries its own ✓ / ✗. */}
              <Text color={update.result.ok ? COLORS.success : COLORS.error}>
                {update.result.message}
              </Text>
              {update.result.nextStep !== '' && <Text>{update.result.nextStep}</Text>}
            </Box>
          )}
        </Box>
      )}
    </Frame>
  );
}
