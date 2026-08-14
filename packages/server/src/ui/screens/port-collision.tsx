import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, MenuRow, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

/* Port collision (EADDRINUSE) entry-point screen.
 *
 * Design source: states.jsx → StateError.
 *
 * Reached when the bootstrap detects port 17529 is already bound and the
 * server can't start. This is a full-frame replacement of the normal
 * Welcome/Menu path — the user has to resolve the collision before they
 * can do anything else.
 *
 * Four fix paths:
 *   - kill the stuck process (delegates to FreePortFlow via onKill)
 *   - switch to multi-agent mode (delegates to MultiAgent via onMultiAgent)
 *   - retry — re-check whether the port is now free (onRetry)
 *   - quit
 *
 * The screen is purely a router — it does NOT call `runFreePort()` or
 * `start()` directly; the caller wires those. Each handler is optional
 * because today's caller may not have all four entry points wired yet.
 * Missing handlers render their row dimmed, with no associated effect.
 */
interface PortCollisionInfo {
  /** PID currently holding 127.0.0.1:17529. null when the lookup failed
   * (we still show the screen — the headline still applies). */
  pid: number | null;
  /** Best-effort image or command line of the holder. null when we
   * couldn't extract it. */
  cmdline: string | null;
}

interface PortCollisionViewProps extends CommonProps {
  info: PortCollisionInfo;
  onKill?: () => void;
  onMultiAgent?: () => void;
  onRetry?: () => void;
  onQuit: () => void;
}

const PORT_I18N: Record<
  Language,
  {
    title: string;
    body1: string;
    body2: string;
    processHeader: string;
    fixHeader: string;
    kill: string;
    killHint: string;
    multi: string;
    multiHint: string;
    retry: string;
    quit: string;
    why1: string;
    why2: string;
    footerNav: string;
    footerSelect: string;
    footerQuit: string;
  }
> = {
  en: {
    title: 'Port 17529 is already in use',
    body1: 'browser-link could not bind 127.0.0.1:17529.',
    body2:
      "Another process is already holding it — usually a previous instance that didn't shut down cleanly.",
    processHeader: 'Process holding the port',
    fixHeader: 'Fix paths',
    kill: 'Kill the stuck process',
    killHint: 'safe — only node processes',
    multi: 'Switch to multi-agent mode',
    multiHint: 'run alongside, proxy to the holder',
    retry: 'Retry — check again',
    quit: 'Quit',
    why1: 'Why this happens: an MCP client crash leaves the bridge orphaned.',
    why2: 'Multi-agent mode prevents this by allowing parallel clients.',
    footerNav: 'navigate',
    footerSelect: 'select',
    footerQuit: 'quit',
  },
  es: {
    title: 'El puerto 17529 ya está en uso',
    body1: 'browser-link no pudo bindear 127.0.0.1:17529.',
    body2: 'Otro proceso lo tiene tomado — normalmente una instancia anterior que no cerró bien.',
    processHeader: 'Proceso que tiene el puerto',
    fixHeader: 'Cómo arreglarlo',
    kill: 'Matar el proceso colgado',
    killHint: 'seguro — sólo procesos node',
    multi: 'Pasar a modo multi-agente',
    multiHint: 'corré en paralelo, hacé proxy al que lo tiene',
    retry: 'Reintentar — chequear de nuevo',
    quit: 'Salir',
    why1: 'Por qué pasa: un crash de un cliente MCP deja el puente huérfano.',
    why2: 'Multi-agente evita esto permitiendo clientes en paralelo.',
    footerNav: 'moverse',
    footerSelect: 'elegir',
    footerQuit: 'salir',
  },
};

type FixAction = 'kill' | 'multi' | 'retry' | 'quit';

export function PortCollisionView({
  language,
  info,
  onKill,
  onMultiAgent,
  onRetry,
  onQuit,
}: PortCollisionViewProps) {
  const t = PORT_I18N[language];
  const rows: {
    value: FixAction;
    hotkey: string;
    label: string;
    hint?: string;
    enabled: boolean;
  }[] = [
    { value: 'kill', hotkey: 'k', label: t.kill, hint: t.killHint, enabled: onKill !== undefined },
    {
      value: 'multi',
      hotkey: 'm',
      label: t.multi,
      hint: t.multiHint,
      enabled: onMultiAgent !== undefined,
    },
    { value: 'retry', hotkey: 'r', label: t.retry, enabled: onRetry !== undefined },
    { value: 'quit', hotkey: 'q', label: t.quit, enabled: true },
  ];
  const [idx, setIdx] = useState(0);

  const fire = (value: FixAction): void => {
    if (value === 'kill') onKill?.();
    else if (value === 'multi') onMultiAgent?.();
    else if (value === 'retry') onRetry?.();
    else onQuit();
  };

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + rows.length) % rows.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % rows.length);
    else if (key.return) {
      const row = rows[idx];
      if (row.enabled) fire(row.value);
    } else if (input === 'q' || key.escape) onQuit();
    else {
      const target = rows.find((r) => r.hotkey === input.toLowerCase() && r.enabled);
      if (target) fire(target.value);
    }
  });

  const titleNode = (
    <Text>
      <Text color={COLORS.error} bold>
        {GLYPHS.error}
      </Text>
      <Text>{'  '}</Text>
      <Text color={COLORS.heading} bold>
        {t.title}
      </Text>
    </Text>
  );

  return (
    <Frame
      title={titleNode}
      borderColor={COLORS.error}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: GLYPHS.enter, label: t.footerSelect },
            { k: 'q', label: t.footerQuit },
          ]}
        />
      }
    >
      <Text>{t.body1}</Text>
      <Text>{t.body2}</Text>

      <SectionHead>{t.processHeader}</SectionHead>
      <Box paddingLeft={2}>
        <Text>
          <Text>PID </Text>
          <Text bold>{info.pid ?? 'unknown'}</Text>
          {info.cmdline !== null && (
            <>
              <Text color={COLORS.muted}>{`   ${GLYPHS.dot}   `}</Text>
              <Text color={COLORS.primary}>{info.cmdline}</Text>
            </>
          )}
        </Text>
      </Box>

      <SectionHead>{t.fixHeader}</SectionHead>
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <Box key={row.value}>
            {/* Dim the row when no handler is wired so the user can't act
             * on it. The hotkey marker still renders so users learn the
             * cue, but Enter on a disabled row is a no-op. */}
            {row.enabled ? (
              <MenuRow selected={i === idx} hotkey={row.hotkey} label={row.label} hint={row.hint} />
            ) : (
              <Box>
                <Text color={COLORS.muted}> </Text>
                <Text color={COLORS.muted}>[</Text>
                <Text color={COLORS.muted}>{row.hotkey}</Text>
                <Text color={COLORS.muted}>] </Text>
                <Text color={COLORS.muted} dimColor>
                  {row.label}
                </Text>
                {row.hint !== undefined && (
                  <Text color={COLORS.muted} dimColor>
                    {'  '}
                    {row.hint}
                  </Text>
                )}
              </Box>
            )}
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={COLORS.muted} italic dimColor>
          {t.why1}
        </Text>
        <Text color={COLORS.muted} italic dimColor>
          {t.why2}
        </Text>
      </Box>
    </Frame>
  );
}

export type { PortCollisionInfo };
