import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import type { Language } from '../../commands/welcome.js';
import { getExtensionInfo } from '../../commands/extension.js';
import type { CommonProps } from './types.js';

const EXT_I18N: Record<
  Language,
  {
    title: string;
    pathLabel: string;
    stepsLabel: string;
    footer: string;
    afterLoading: string;
    notFound: string;
  }
> = {
  en: {
    title: 'Chrome extension — install steps',
    pathLabel: 'Extension assets are at:',
    stepsLabel: 'Install steps:',
    afterLoading:
      'After loading, open the extension popup on any tab and click "Conectar" to bridge it.',
    notFound:
      'Extension assets not found. Run `npm run build:extension` (dev) or reinstall the package.',
    footer: '↵ / Esc back to menu',
  },
  es: {
    title: 'Extensión de Chrome — pasos de instalación',
    pathLabel: 'Los assets de la extensión están en:',
    stepsLabel: 'Pasos:',
    afterLoading:
      'Después de cargarla, abrí el popup de la extensión en cualquier pestaña y hacé click en "Conectar" para puentearla.',
    notFound:
      'No se encontraron los assets. Corré `npm run build:extension` (dev) o reinstalá el paquete.',
    footer: '↵ / Esc volver al menú',
  },
};

interface ExtensionViewProps extends CommonProps {
  onBack: () => void;
}

export function ExtensionView({ language, onBack }: ExtensionViewProps) {
  const t = EXT_I18N[language];
  const info = getExtensionInfo();
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  return (
    <Frame title={t.title} footer={t.footer}>
      {info.path ? (
        <>
          <Text bold>{t.pathLabel}</Text>
          <Text color="cyan">{info.path}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>{t.stepsLabel}</Text>
            <Text>{info.hints}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray" italic>
              {t.afterLoading}
            </Text>
          </Box>
        </>
      ) : (
        <Text color="yellow">{t.notFound}</Text>
      )}
    </Frame>
  );
}
