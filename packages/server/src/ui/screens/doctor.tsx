import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, InlineSpinner } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { runDoctor, formatDoctor } from '../../commands/doctor.js';
import type { CommonProps } from './types.js';

/* Doctor — runs `runDoctor()` and dumps the formatted output.
 *
 * v0.9.0: replace the plain "Diagnosing…" string with an inline spinner
 * so the long-running check feels alive, and adopt the FooterKeys strip
 * for the keybindings. The formatted output itself comes from
 * `formatDoctor()` which is a pre-styled plain string — we render it
 * as-is so the existing tests keep passing.
 */
const DOCTOR_I18N: Record<
  Language,
  { title: string; loading: string; refreshLabel: string; backLabel: string }
> = {
  en: {
    title: 'Doctor — diagnose current setup',
    loading: 'Diagnosing…',
    refreshLabel: 'refresh',
    backLabel: 'back to menu',
  },
  es: {
    title: 'Diagnóstico — estado actual de la instalación',
    loading: 'Diagnosticando…',
    refreshLabel: 'refrescar',
    backLabel: 'volver al menú',
  },
};

interface DoctorViewProps extends CommonProps {
  onBack: () => void;
}

export function DoctorView({ language, onBack }: DoctorViewProps) {
  const t = DOCTOR_I18N[language];
  const [output, setOutput] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOutput(null);
    void runDoctor().then((r) => {
      if (!cancelled) setOutput(formatDoctor(r));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useInput((input, key) => {
    if (key.return || key.escape) onBack();
    else if (input === 'r') setRefreshKey((k) => k + 1);
  });

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: 'r', label: t.refreshLabel },
            { k: GLYPHS.enter, label: t.backLabel },
          ]}
        />
      }
    >
      {output === null ? (
        <Box>
          <InlineSpinner />
          <Text color={COLORS.muted}>{` ${t.loading}`}</Text>
        </Box>
      ) : (
        <Text>{output}</Text>
      )}
    </Frame>
  );
}
