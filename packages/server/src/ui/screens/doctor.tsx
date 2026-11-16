import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, InlineSpinner } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { runDoctor, formatDoctor, type DoctorReport } from '../../commands/doctor.js';
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
  { title: string; loading: string; failed: string; refreshLabel: string; backLabel: string }
> = {
  en: {
    title: 'Doctor — diagnose current setup',
    loading: 'Diagnosing…',
    failed: 'Diagnosis failed:',
    refreshLabel: 'refresh',
    backLabel: 'back to menu',
  },
  es: {
    title: 'Diagnóstico — estado actual de la instalación',
    loading: 'Diagnosticando…',
    failed: 'El diagnóstico falló:',
    refreshLabel: 'refrescar',
    backLabel: 'volver al menú',
  },
};

interface DoctorViewProps extends CommonProps {
  onBack: () => void;
  /** The diagnosis. Default `runDoctor`; tests inject a stub. */
  runDoctor?: () => Promise<DoctorReport>;
}

export function DoctorView({ language, onBack, runDoctor: run = runDoctor }: DoctorViewProps) {
  const t = DOCTOR_I18N[language];
  const [output, setOutput] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setOutput(null);
    setFailure(null);
    // A rejection must end the spinner: it becomes an error state, never an
    // unhandled rejection.
    void run().then(
      (r) => {
        if (!cancelled) setOutput(formatDoctor(r, language));
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey, run, language]);

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
      {failure !== null ? (
        <Text color={COLORS.error}>{`${t.failed} ${failure}`}</Text>
      ) : output === null ? (
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
