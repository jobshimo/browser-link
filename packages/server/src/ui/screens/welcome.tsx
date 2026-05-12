import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import { I18N_WELCOME } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

interface WelcomeProps extends CommonProps {
  hideDismiss: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onSwapLang: () => void;
  onQuit: () => void;
}

export function WelcomeScreen({
  language,
  hideDismiss,
  onAccept,
  onDismiss,
  onSwapLang,
  onQuit,
}: WelcomeProps) {
  const t = I18N_WELCOME[language];
  const items: MenuItem<'accept' | 'dismiss' | 'swap' | 'quit'>[] = [
    { value: 'accept', label: t.options.accept },
  ];
  if (!hideDismiss) items.push({ value: 'dismiss', label: t.options.dismiss });
  items.push({ value: 'swap', label: t.options.swap }, { value: 'quit', label: t.options.quit });

  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const v = items[idx].value;
      if (v === 'accept') onAccept();
      else if (v === 'dismiss') onDismiss();
      else if (v === 'swap') onSwapLang();
      else onQuit();
    } else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
  });

  const footer =
    language === 'es'
      ? '↑↓ moverse · ↵ elegir · l idioma · q salir'
      : '↑↓ navigate · ↵ select · l language · q quit';

  return (
    <Frame title={t.title} footer={footer}>
      <Section title={t.aboutTitle} body={t.about} />
      <Section title={t.capabilitiesTitle} body={t.capabilities} />
      <Section title={t.warningTitle} body={t.warning} warn />
      <Box marginBottom={1} flexDirection="column">
        <Text color="gray" italic>
          {t.responsibility}
        </Text>
        <Text color="gray" italic>
          {t.extensionNote}
        </Text>
      </Box>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
    </Frame>
  );
}

interface SectionProps {
  title: string;
  body: string;
  warn?: boolean;
}
function Section({ title, body, warn }: SectionProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={warn ? 'yellow' : 'cyan'} bold>
        {warn ? '⚠  ' : ''}
        {title}
      </Text>
      <Text>{body}</Text>
    </Box>
  );
}
