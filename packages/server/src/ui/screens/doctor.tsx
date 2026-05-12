import { Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { runDoctor, formatDoctor } from '../../commands/doctor.js';
import type { CommonProps } from './types.js';

const DOCTOR_I18N: Record<
  Language,
  { title: string; loading: string; footer: string; refresh: string }
> = {
  en: {
    title: 'Doctor — diagnose current setup',
    loading: 'Diagnosing…',
    refresh: 'r refresh · ↵ / Esc back to menu',
    footer: '↵ / Esc back to menu',
  },
  es: {
    title: 'Diagnóstico — estado actual de la instalación',
    loading: 'Diagnosticando…',
    refresh: 'r refrescar · ↵ / Esc volver al menú',
    footer: '↵ / Esc volver al menú',
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
    <Frame title={t.title} footer={t.refresh}>
      {output === null ? <Text color="gray">{t.loading}</Text> : <Text>{output}</Text>}
    </Frame>
  );
}
