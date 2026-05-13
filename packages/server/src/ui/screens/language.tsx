import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, MenuRow } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

/* Language picker — two MenuRows, the currently-selected language gets
 * a dim "current" badge so the user can tell at a glance which one is
 * active even if the cursor hasn't moved yet. */
const LANG_I18N: Record<
  Language,
  {
    title: string;
    prompt: string;
    saved: string;
    current: string;
    footerNav: string;
    footerPick: string;
    footerBack: string;
  }
> = {
  en: {
    title: 'Language — switch between English and Español',
    prompt: 'Pick a language',
    saved: 'Saved. All output will now use the selected language.',
    current: 'current',
    footerNav: 'navigate',
    footerPick: 'pick',
    footerBack: 'back',
  },
  es: {
    title: 'Idioma — cambiar entre English y Español',
    prompt: 'Elegí un idioma',
    saved: 'Guardado. Todo el output va a usar el idioma elegido.',
    current: 'actual',
    footerNav: 'moverse',
    footerPick: 'elegir',
    footerBack: 'volver',
  },
};

interface LanguageViewProps extends CommonProps {
  onPick: (next: Language) => void;
  onBack: () => void;
}

const ROWS: { value: Language; hotkey: string; label: string }[] = [
  { value: 'en', hotkey: 'e', label: 'English' },
  { value: 'es', hotkey: 's', label: 'Español' },
];

export function LanguageView({ language, onPick, onBack }: LanguageViewProps) {
  const t = LANG_I18N[language];
  const [idx, setIdx] = useState<number>(language === 'es' ? 1 : 0);
  const [saved, setSaved] = useState(false);

  const pick = (next: Language): void => {
    onPick(next);
    setSaved(true);
  };

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + ROWS.length) % ROWS.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % ROWS.length);
    else if (key.return) pick(ROWS[idx].value);
    else if (key.escape) onBack();
    else {
      const target = ROWS.find((r) => r.hotkey === input.toLowerCase());
      if (target) pick(target.value);
    }
  });

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: GLYPHS.enter, label: t.footerPick },
            { k: 'Esc', label: t.footerBack },
          ]}
        />
      }
    >
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {ROWS.map((row, i) => (
          <MenuRow
            key={row.value}
            selected={i === idx}
            hotkey={row.hotkey}
            label={row.label}
            badge={
              row.value === language ? (
                <Text color={COLORS.muted} dimColor>
                  {t.current}
                </Text>
              ) : undefined
            }
          />
        ))}
      </Box>
      {saved && (
        <Box marginTop={1}>
          <Text color={COLORS.success}>
            {GLYPHS.success} {t.saved}
          </Text>
        </Box>
      )}
    </Frame>
  );
}
