import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame, Menu, type MenuItem } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

const LANG_I18N: Record<
  Language,
  { title: string; prompt: string; saved: string; footer: string }
> = {
  en: {
    title: 'Language — switch between English and Español',
    prompt: 'Pick a language',
    saved: '✓ Saved. All output will now use the selected language.',
    footer: '↑↓ navigate · ↵ pick · Esc back',
  },
  es: {
    title: 'Idioma — cambiar entre English y Español',
    prompt: 'Elegí un idioma',
    saved: '✓ Guardado. Todo el output va a usar el idioma elegido.',
    footer: '↑↓ moverse · ↵ elegir · Esc volver',
  },
};

interface LanguageViewProps extends CommonProps {
  onPick: (next: Language) => void;
  onBack: () => void;
}

export function LanguageView({ language, onPick, onBack }: LanguageViewProps) {
  const t = LANG_I18N[language];
  const items: MenuItem<Language>[] = [
    { value: 'en', label: 'English' },
    { value: 'es', label: 'Español' },
  ];
  const [idx, setIdx] = useState<number>(language === 'es' ? 1 : 0);
  const [saved, setSaved] = useState(false);

  useInput((_input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % items.length);
    else if (key.return) {
      const next = items[idx].value;
      onPick(next);
      setSaved(true);
    } else if (key.escape) onBack();
  });

  return (
    <Frame title={t.title} footer={t.footer}>
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1}>
        <Menu items={items} selectedIndex={idx} />
      </Box>
      {saved && (
        <Box marginTop={1}>
          <Text color="green">{t.saved}</Text>
        </Box>
      )}
    </Frame>
  );
}
