import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { type InstallReport } from '../../commands/install.js';
import type { CommonProps } from './types.js';

interface InstallResultProps extends CommonProps {
  report: InstallReport;
  onBack: () => void;
}

const RESULT_I18N: Record<Language, { ok: string; warn: string; hint: string; footer: string }> = {
  en: {
    ok: 'Registered',
    warn: 'Not registered',
    hint: 'Restart the MCP client so it picks up the new entry.',
    footer: '↵ / Esc back to menu',
  },
  es: {
    ok: 'Registrado',
    warn: 'No registrado',
    hint: 'Reiniciá el cliente MCP para que tome la nueva entrada.',
    footer: '↵ / Esc volver al menú',
  },
};

export function InstallResultView({ language, report, onBack }: InstallResultProps) {
  const t = RESULT_I18N[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const ok = report.installedClient;
  return (
    <Frame title={`${report.displayName} — ${ok ? t.ok : t.warn}`} footer={t.footer}>
      <Text color={ok ? 'green' : 'yellow'}>
        {ok ? '✓ ' : '⚠ '}
        {report.message}
      </Text>
      {ok && (
        <Box marginTop={1}>
          <Text color="cyan">→ {t.hint}</Text>
        </Box>
      )}
    </Frame>
  );
}
