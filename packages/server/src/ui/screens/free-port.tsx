import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { runFreePort, type FreePortResult } from '../../commands/free-port.js';
import type { CommonProps } from './types.js';

interface FreePortI18n {
  title: string;
  intro: string;
  confirmPrompt: string;
  confirmYes: string;
  confirmNo: string;
  running: string;
  footer: string;
  doneFooter: string;
}

const FREE_PORT_I18N: Record<Language, FreePortI18n> = {
  en: {
    title: 'Free port 17529',
    intro: [
      'If an MCP client (Claude / OpenCode / Copilot) was closed without',
      'shutting down browser-link cleanly, the next client crashes with',
      '"port already in use". This screen finds the process holding',
      '127.0.0.1:17529 and stops it.',
      '',
      'Safety: only processes whose image starts with "node" are killed.',
      'Anything else is left alone with an explanation.',
    ].join('\n'),
    confirmPrompt: 'Stop the process holding port 17529?',
    confirmYes: 'Yes — kill it',
    confirmNo: 'No — back to menu',
    running: 'Stopping…',
    footer: '↑↓ navigate · ↵ select · Esc back',
    doneFooter: '↵ / Esc back to menu',
  },
  es: {
    title: 'Liberar puerto 17529',
    intro: [
      'Si un cliente MCP (Claude / OpenCode / Copilot) cerró sin bajar',
      'browser-link de forma limpia, el próximo cliente crashea con',
      '"port already in use". Esta pantalla busca el proceso que tiene',
      '127.0.0.1:17529 y lo para.',
      '',
      'Seguridad: sólo se matan procesos cuyo nombre empieza con "node".',
      'Cualquier otro se deja vivo con una explicación.',
    ].join('\n'),
    confirmPrompt: '¿Parar el proceso que tiene el puerto 17529?',
    confirmYes: 'Sí — matalo',
    confirmNo: 'No — volver al menú',
    running: 'Parando…',
    footer: '↑↓ moverse · ↵ elegir · Esc volver',
    doneFooter: '↵ / Esc volver al menú',
  },
};

interface FreePortViewProps extends CommonProps {
  onBack: () => void;
}

export function FreePortView({ language, onBack }: FreePortViewProps) {
  const t = FREE_PORT_I18N[language];
  const [phase, setPhase] = useState<'confirm' | 'running' | 'done'>('confirm');
  const [result, setResult] = useState<FreePortResult | null>(null);
  const items: MenuItem<'yes' | 'no'>[] = [
    { value: 'yes', label: t.confirmYes },
    { value: 'no', label: t.confirmNo },
  ];
  const [idx, setIdx] = useState(1);

  useInput((_input, key) => {
    if (phase === 'confirm') {
      if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
      else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
      else if (key.return) {
        const v = items[idx].value;
        if (v === 'no') onBack();
        else {
          setPhase('running');
          // Defer the synchronous kill so Ink renders the "running" state.
          setTimeout(() => {
            const r = runFreePort(language);
            setResult(r);
            setPhase('done');
          }, 0);
        }
      } else if (key.escape) onBack();
    } else if (phase === 'done') {
      if (key.return || key.escape) onBack();
    }
  });

  return (
    <Frame title={t.title} footer={phase === 'done' ? t.doneFooter : t.footer}>
      <Box marginBottom={1}>
        <Text>{t.intro}</Text>
      </Box>
      {phase === 'confirm' && (
        <>
          <Text color="white" bold>
            {t.confirmPrompt}
          </Text>
          <Box marginTop={1}>
            <Menu items={items} selectedIndex={idx} />
          </Box>
        </>
      )}
      {phase === 'running' && <Text color="gray">{t.running}</Text>}
      {phase === 'done' && result && (
        <Text color={result.ok ? 'green' : 'yellow'}>{result.message}</Text>
      )}
    </Frame>
  );
}
