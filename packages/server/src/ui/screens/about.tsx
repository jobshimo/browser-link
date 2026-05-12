import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import { I18N_ABOUT } from '../../commands/about.js';
import type { CommonProps } from './types.js';

interface AboutViewProps extends CommonProps {
  onBack: () => void;
}

export function AboutView({ language, onBack }: AboutViewProps) {
  const t = I18N_ABOUT[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const footer = language === 'es' ? '↵ / Esc volver al menú' : '↵ / Esc back to menu';
  return (
    <Frame title={t.title} footer={footer}>
      <AboutSection title={t.whatTitle} body={t.what} />
      <AboutSection title={t.howTitle} body={t.how} />
      <AboutSection title={t.bindingTitle} body={t.binding} />
      <AboutSection title={t.bridgeToolsTitle} body={t.bridgeTools} />
      <AboutSection title={t.mapToolsTitle} body={t.mapTools} />
      <AboutSection title={t.privacyTitle} body={t.privacy} />
      <AboutSection title={t.helpTitle} body={t.help} />
      <AboutSection title={t.authorTitle} body={t.author} />
    </Frame>
  );
}

function AboutSection({ title, body }: { title: string; body: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        {title}
      </Text>
      <Text>{body}</Text>
    </Box>
  );
}
