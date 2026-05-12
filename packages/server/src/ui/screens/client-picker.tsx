import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { INSTALLERS, type ClientId } from '../../installers/index.js';
import type { CommonProps } from './types.js';

interface ClientPickerProps extends CommonProps {
  onPick: (id: ClientId) => void;
  onBack: () => void;
}

const PICKER_I18N: Record<Language, { title: string; prompt: string; footer: string }> = {
  en: {
    title: 'Register browser-link in…',
    prompt: 'Which MCP client?',
    footer: '↑↓ navigate · ↵ register · Esc back',
  },
  es: {
    title: 'Registrar browser-link en…',
    prompt: '¿Qué cliente MCP?',
    footer: '↑↓ moverse · ↵ registrar · Esc volver',
  },
};

export function ClientPicker({ language, onPick, onBack }: ClientPickerProps) {
  const t = PICKER_I18N[language];
  const STATUS: Record<
    Language,
    { registered: string; notRegistered: string; notDetected: string }
  > = {
    en: { registered: 'registered', notRegistered: 'not registered', notDetected: 'not detected' },
    es: { registered: 'registrado', notRegistered: 'no registrado', notDetected: 'no detectado' },
  };
  const s = STATUS[language];
  const items: MenuItem<ClientId>[] = INSTALLERS.map((inst) => {
    const d = inst.detect();
    const hint = !d.installed ? s.notDetected : d.registered ? s.registered : s.notRegistered;
    return { value: inst.id, label: inst.displayName, hint };
  });

  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) onPick(items[idx].value);
    else if (input === 'q' || key.escape) onBack();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}
