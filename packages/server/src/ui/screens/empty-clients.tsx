import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, SectionHead } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import type { CommonProps } from './types.js';

/* Empty clients — the "no MCP clients detected" state shown when
 * register would otherwise have rendered an unusable picker.
 *
 * Design source: states.jsx → StateEmpty.
 *
 * Triggered when none of the supported MCP installers' `detect().installed`
 * returns true. The screen tells the user which clients are supported
 * and where to install them, then offers rescan / back as the only
 * forward actions.
 */
const EMPTY_I18N: Record<
  Language,
  {
    title: string;
    headline: string;
    sub: string;
    supportedHeader: string;
    rescan: string;
    openRepo: string;
    back: string;
  }
> = {
  en: {
    title: 'Register browser-link in…',
    headline: 'No MCP clients detected on this machine.',
    sub: 'Install one of the supported clients, then re-run browser-link.',
    supportedHeader: 'Supported clients',
    rescan: 'rescan',
    openRepo: 'open repo',
    back: 'back',
  },
  es: {
    title: 'Registrar browser-link en…',
    headline: 'No se detectó ningún cliente MCP en esta máquina.',
    sub: 'Instalá alguno de los clientes soportados y volvé a correr browser-link.',
    supportedHeader: 'Clientes soportados',
    rescan: 'reescanear',
    openRepo: 'abrir repo',
    back: 'volver',
  },
};

interface EmptyClientsViewProps extends CommonProps {
  onRescan: () => void;
  onOpenRepo: () => void;
  onBack: () => void;
}

const SUPPORTED = [
  { name: 'Claude Code', where: 'claude.ai/code' },
  { name: 'OpenCode', where: 'opencode.ai' },
  { name: 'GitHub Copilot CLI', where: 'gh extension install github/gh-copilot' },
] as const;

export function EmptyClientsView({
  language,
  onRescan,
  onOpenRepo,
  onBack,
}: EmptyClientsViewProps) {
  const t = EMPTY_I18N[language];
  useInput((input, key) => {
    if (input === 'r') onRescan();
    else if (input === 'g') onOpenRepo();
    else if (key.escape || key.return || input === 'q') onBack();
  });
  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: 'r', label: t.rescan },
            { k: 'g', label: t.openRepo },
            { k: 'Esc', label: t.back },
          ]}
        />
      }
    >
      <Box marginTop={1} paddingLeft={2}>
        <Text color={COLORS.muted}>{`${GLYPHS.dot}  ${GLYPHS.dot}  ${GLYPHS.dot}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="white" bold>
          {t.headline}
        </Text>
      </Box>
      <Text color={COLORS.muted} dimColor>
        {t.sub}
      </Text>

      <SectionHead>{t.supportedHeader}</SectionHead>
      {SUPPORTED.map((c) => (
        <Box key={c.name} paddingLeft={2}>
          <Text>
            <Text color="white">{`${GLYPHS.dot} ${c.name}`}</Text>
            <Text color={COLORS.muted}>{'   '}</Text>
            <Text color={COLORS.primary}>{c.where}</Text>
          </Text>
        </Box>
      ))}
    </Frame>
  );
}
