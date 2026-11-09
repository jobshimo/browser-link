import { Box, Text, useInput } from 'ink';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys } from '../primitives/index.js';
import { NOTICE } from '../../notice.js';
import type { CommonProps } from './types.js';

/* Notice screen — the console's first screen until the user confirms it.
 *
 * Renders the approved product notice (`notice.ts`) in the configured
 * language and accepts exactly one key: Enter, labelled "I understand" /
 * "Entendido". There is deliberately no dismiss, skip or language toggle
 * here; the App persists the acknowledgement and moves on. Ctrl+C still
 * quits through the App's global handler. */

interface NoticeProps extends CommonProps {
  onAcknowledge: () => void;
}

const CONFIRM_LABEL = { en: 'I understand', es: 'Entendido' } as const;

export function NoticeScreen({ language, onAcknowledge }: NoticeProps) {
  const notice = NOTICE[language];
  const confirm = CONFIRM_LABEL[language];

  useInput((_input, key) => {
    if (key.return) onAcknowledge();
  });

  return (
    <Frame
      title={`${GLYPHS.warn} ${notice.title}`}
      footer={<FooterKeys items={[{ k: GLYPHS.enter, label: confirm }]} />}
    >
      {notice.paragraphs.map((paragraph, i) => (
        <Box key={i} marginTop={i === 0 ? 0 : 1}>
          <Text>{paragraph}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={COLORS.warn} bold>
          {`${GLYPHS.enter} ${confirm}`}
        </Text>
      </Box>
    </Frame>
  );
}
