import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { Badge, FooterKeys, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { type InstallReport } from '../../commands/install.js';
import type { CommonProps } from './types.js';

/* Install result — shown after Register completes. v0.9.0 splits success
 * and failure into the same shape: a badge in the title row, a single
 * status line, then numbered "Next step" / "Then" / "Fix" sections so
 * the user always knows what to do next.
 *
 * Design source: screens.jsx → ScreenInstallResultOk / Fail.
 */
interface InstallResultProps extends CommonProps {
  report: InstallReport;
  onBack: () => void;
}

const RESULT_I18N: Record<
  Language,
  {
    ok: string;
    warn: string;
    nextStep: string;
    nextStepBody: string;
    then: string;
    thenBody: string;
    thenAction: string;
    fix: string;
    fixBody: string;
    footerBack: string;
    footerRetry: string;
  }
> = {
  en: {
    ok: 'Registered',
    warn: 'Not registered',
    nextStep: 'Next step',
    nextStepBody: 'Restart the MCP client so it picks up the new entry.',
    then: 'Then',
    thenBody: 'Pick',
    thenAction: 'Agent instructions',
    fix: 'Fix',
    fixBody: 'Install the client first, then re-run this screen.',
    footerBack: 'back to menu',
    footerRetry: 'back',
  },
  es: {
    ok: 'Registrado',
    warn: 'No registrado',
    nextStep: 'Próximo paso',
    nextStepBody: 'Reiniciá el cliente MCP para que tome la nueva entrada.',
    then: 'Después',
    thenBody: 'Elegí',
    thenAction: 'Instrucciones del agente',
    fix: 'Arreglo',
    fixBody: 'Instalá el cliente primero, y volvé a esta pantalla.',
    footerBack: 'volver al menú',
    footerRetry: 'volver',
  },
};

export function InstallResultView({ language, report, onBack }: InstallResultProps) {
  const t = RESULT_I18N[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const ok = report.installedClient;

  /* Title is the client name followed by a colored status word. We feed
   * the title to Frame as a ReactNode so the colored portion renders
   * inline with the (always-cyan) frame heading style. */
  const title = (
    <Text>
      <Text color={COLORS.heading} bold>
        {report.displayName}
      </Text>
      <Text color={COLORS.muted}>{` ${GLYPHS.dot} `}</Text>
      <Text color={ok ? COLORS.success : COLORS.warn} bold>
        {ok ? t.ok : t.warn}
      </Text>
    </Text>
  );

  return (
    <Frame
      title={title}
      footer={
        <FooterKeys
          items={[
            { k: GLYPHS.enter, label: t.footerBack },
            { k: 'Esc', label: t.footerRetry },
          ]}
        />
      }
    >
      <Box>
        <Badge kind={ok ? 'ok' : 'warn'} label={report.message} />
      </Box>

      {ok ? (
        <>
          <SectionHead>{`${GLYPHS.arrow} ${t.nextStep}`}</SectionHead>
          <Box paddingLeft={2}>
            <Text>{t.nextStepBody}</Text>
          </Box>
          <SectionHead>{`${GLYPHS.arrow} ${t.then}`}</SectionHead>
          <Box paddingLeft={2}>
            <Text>
              {t.thenBody}{' '}
              <Text color={COLORS.primary} bold>
                {t.thenAction}
              </Text>
              .
            </Text>
          </Box>
        </>
      ) : (
        <>
          <SectionHead>{`${GLYPHS.arrow} ${t.fix}`}</SectionHead>
          <Box paddingLeft={2}>
            <Text>{t.fixBody}</Text>
          </Box>
        </>
      )}
    </Frame>
  );
}
