import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, SectionHead } from '../primitives/index.js';
import { I18N_ABOUT } from '../../commands/about.js';
import type { CommonProps } from './types.js';

/* About / Help — sections layout from screens.jsx → ScreenAbout. The
 * copy still flows from I18N_ABOUT; we re-skin the section headers with
 * SectionHead and switch the footer to a FooterKeys strip. */
interface AboutViewProps extends CommonProps {
  onBack: () => void;
}

export function AboutView({ language, onBack }: AboutViewProps) {
  const t = I18N_ABOUT[language];
  useInput((_input, key) => {
    if (key.return || key.escape) onBack();
  });
  const footerItems = [
    { k: GLYPHS.enter, label: language === 'es' ? 'volver al menú' : 'back to menu' },
    { k: 'Esc', label: language === 'es' ? 'volver' : 'back' },
  ];
  return (
    <Frame title={t.title} footer={<FooterKeys items={footerItems} />}>
      <AboutSection title={t.whatTitle} body={t.what} first />
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

/* `first=true` for the top section so we don't double-pad against the
 * Frame's own marginBottom on the title row. SectionHead applies
 * marginTop=1 unconditionally — for the very first section that becomes
 * a no-op since the Frame already left a row of whitespace. */
function AboutSection({
  title,
  body,
  first = false,
}: {
  title: string;
  body: string;
  first?: boolean;
}) {
  return (
    <Box flexDirection="column">
      {first ? (
        <Text color={COLORS.heading} bold>
          {title}
        </Text>
      ) : (
        <SectionHead>{title}</SectionHead>
      )}
      <Text>{body}</Text>
    </Box>
  );
}
