import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, InlineSpinner, MenuRow, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { runFreePort, type FreePortResult } from '../../commands/free-port.js';
import type { CommonProps } from './types.js';

/* Free port 17529. v0.9.0 phases (screens2.jsx → ScreenFreePort):
 *   - confirm: shows the port description + safety note + MenuRow yes/no.
 *   - running: inline spinner + "Stopping…" line.
 *   - done: success row showing the result (ok=green / guarded=warn).
 *
 * The `guarded` phase from the design corresponds to a real result where
 * `result.ok === false` (the kill was refused because the image name
 * doesn't start with "node"). We don't need a separate phase enum — we
 * branch on `result.ok` inside the `done` render.
 */
interface FreePortI18n {
  title: string;
  intro: string;
  safety: string;
  confirmPrompt: string;
  confirmYes: string;
  confirmNo: string;
  running: string;
  footerNav: string;
  footerSelect: string;
  footerBack: string;
  footerDone: string;
}

const FREE_PORT_I18N: Record<Language, FreePortI18n> = {
  en: {
    title: 'Free port 17529',
    intro: [
      'If an MCP client (Claude / OpenCode / Copilot) was closed without',
      'shutting down browser-link cleanly, the next client crashes with',
      '"port already in use". This screen finds the process holding',
      '127.0.0.1:17529 and stops it.',
    ].join('\n'),
    safety:
      'Safety: only processes whose image starts with "node" are killed. Anything else is left alone with an explanation.',
    confirmPrompt: 'Stop the process holding port 17529?',
    confirmYes: 'Yes — kill it',
    confirmNo: 'No — back to menu',
    running: 'Stopping…',
    footerNav: 'navigate',
    footerSelect: 'select',
    footerBack: 'back',
    footerDone: 'back to menu',
  },
  es: {
    title: 'Liberar puerto 17529',
    intro: [
      'Si un cliente MCP (Claude / OpenCode / Copilot) cerró sin bajar',
      'browser-link de forma limpia, el próximo cliente crashea con',
      '"port already in use". Esta pantalla busca el proceso que tiene',
      '127.0.0.1:17529 y lo para.',
    ].join('\n'),
    safety:
      'Seguridad: sólo se matan procesos cuyo nombre empieza con "node". Cualquier otro se deja vivo con una explicación.',
    confirmPrompt: '¿Parar el proceso que tiene el puerto 17529?',
    confirmYes: 'Sí — matalo',
    confirmNo: 'No — volver al menú',
    running: 'Parando…',
    footerNav: 'moverse',
    footerSelect: 'elegir',
    footerBack: 'volver',
    footerDone: 'volver al menú',
  },
};

interface FreePortViewProps extends CommonProps {
  onBack: () => void;
}

export function FreePortView({ language, onBack }: FreePortViewProps) {
  const t = FREE_PORT_I18N[language];
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<FreePortResult | null>(null);
  const rows: { value: 'yes' | 'no'; hotkey: string; label: string }[] = [
    { value: 'yes', hotkey: 'y', label: t.confirmYes },
    { value: 'no', hotkey: 'n', label: t.confirmNo },
  ];
  /* Default cursor on "No" — destructive action gates behind an explicit
   * confirmation, matching the previous behaviour. */
  const [idx, setIdx] = useState(1);

  const confirm = (value: 'yes' | 'no'): void => {
    if (value === 'no') {
      onBack();
      return;
    }
    setPhase('running');
    /* Defer the synchronous kill so Ink renders the "running" phase. */
    setTimeout(() => {
      const r = runFreePort(language);
      setResult(r);
      setPhase('done');
    }, 0);
  };

  useInput((input, key) => {
    if (phase === 'confirm') {
      if (key.upArrow) setIdx((i) => (i - 1 + rows.length) % rows.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % rows.length);
      else if (key.return) confirm(rows[idx].value);
      else if (key.escape) onBack();
      else {
        const target = rows.find((r) => r.hotkey === input.toLowerCase());
        if (target) confirm(target.value);
      }
    } else if (phase === 'done') {
      if (key.return || key.escape) onBack();
    }
  });

  const footer =
    phase === 'done' ? (
      <FooterKeys items={[{ k: GLYPHS.enter, label: t.footerDone }]} />
    ) : (
      <FooterKeys
        items={[
          { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
          { k: GLYPHS.enter, label: t.footerSelect },
          { k: 'Esc', label: t.footerBack },
        ]}
      />
    );

  return (
    <Frame title={t.title} footer={footer}>
      <Text>{t.intro}</Text>
      <Box marginTop={1}>
        <Text color={COLORS.warn}>{GLYPHS.warn} </Text>
        <Text>{t.safety}</Text>
      </Box>

      {phase === 'confirm' && (
        <>
          <SectionHead>{t.confirmPrompt}</SectionHead>
          {rows.map((row, i) => (
            <MenuRow key={row.value} selected={i === idx} hotkey={row.hotkey} label={row.label} />
          ))}
        </>
      )}

      {phase === 'running' && (
        <Box marginTop={1}>
          <InlineSpinner />
          <Text color={COLORS.primary}>{` ${t.running}`}</Text>
        </Box>
      )}

      {phase === 'done' && result && (
        <Box marginTop={1}>
          <Text color={result.ok ? COLORS.success : COLORS.warn}>
            {result.ok ? GLYPHS.success : GLYPHS.warn} {result.message}
          </Text>
        </Box>
      )}
    </Frame>
  );
}
