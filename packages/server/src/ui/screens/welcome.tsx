import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { COLORS, GLYPHS } from '../tokens.js';
import { FooterKeys, MenuRow, SectionHead } from '../primitives/index.js';
import { I18N_WELCOME } from '../../commands/welcome.js';
import { VERSION } from '../../version.js';
import type { CommonProps } from './types.js';

/* Welcome screen — first-run gate.
 *
 * Two layouts in one component:
 *
 *   - **Compact (default)**: fits in ~16 rows so it never overflows a
 *     standard terminal viewport. Wordmark + one-paragraph mission +
 *     one-line warning + action rows + footer. The user lands on the
 *     wordmark, not on the footer.
 *
 *   - **Expanded** (toggle with `i`): the full v0.9.0 layout faithful to
 *     screens.jsx — three SectionHead blocks ("What this is", "What the
 *     agent can do", "What you should know") plus accountability lines.
 *     Same copy that lives in `About`, available here as a convenience
 *     during onboarding.
 *
 * The copy itself still comes from I18N_WELCOME — we shape the
 * presentation, not the words.
 */

interface WelcomeProps extends CommonProps {
  hideDismiss: boolean;
  onAccept: () => void;
  onDismiss: () => void;
  onSwapLang: () => void;
  onQuit: () => void;
}

type WelcomeAction = 'accept' | 'dismiss' | 'swap' | 'quit';

interface WelcomeActionRow {
  value: WelcomeAction;
  hotkey: string;
  label: string;
}

export function WelcomeScreen({
  language,
  hideDismiss,
  onAccept,
  onDismiss,
  onSwapLang,
  onQuit,
}: WelcomeProps) {
  const t = I18N_WELCOME[language];
  const [expanded, setExpanded] = useState(false);

  /* Hotkeys here are stable across languages — `c` for the primary
   * action ("continue"), `d` for dismiss, `l` for language, `q` for
   * quit. Picking them from the EN labels would drift between locales,
   * so we hard-code them. */
  const rows: WelcomeActionRow[] = [{ value: 'accept', hotkey: 'c', label: t.options.accept }];
  if (!hideDismiss) rows.push({ value: 'dismiss', hotkey: 'd', label: t.options.dismiss });
  rows.push(
    { value: 'swap', hotkey: 'l', label: t.options.swap },
    { value: 'quit', hotkey: 'q', label: t.options.quit },
  );

  const [idx, setIdx] = useState(0);

  const fire = (action: WelcomeAction): void => {
    if (action === 'accept') onAccept();
    else if (action === 'dismiss') onDismiss();
    else if (action === 'swap') onSwapLang();
    else onQuit();
  };

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + rows.length) % rows.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % rows.length);
    else if (key.return) fire(rows[idx].value);
    else if (input === 'q' || key.escape) onQuit();
    else if (input === 'l') onSwapLang();
    else if (input === 'i' || input === 'I') setExpanded((v) => !v);
    else {
      // Hotkey lookup — pressing the bracketed letter fires the row.
      const target = rows.find((r) => r.hotkey === input.toLowerCase());
      if (target) fire(target.value);
    }
  });

  const fk = t.footerKeys;
  const footerItems = [
    { k: `${GLYPHS.up}${GLYPHS.down}`, label: fk.navigate },
    { k: GLYPHS.enter, label: fk.select },
    { k: 'i', label: expanded ? fk.hide : fk.info },
    { k: 'l', label: fk.lang },
    { k: 'q', label: fk.quit },
  ];

  return (
    <Frame
      title={t.title}
      badge={
        <Text color={COLORS.muted} dimColor>
          v{VERSION}
        </Text>
      }
      footer={<FooterKeys items={footerItems} />}
    >
      <Wordmark />

      {expanded ? (
        <ExpandedBody t={t} />
      ) : (
        <CompactBody about={t.shortAbout} warningTitle={t.warningTitle} warning={t.shortWarning} />
      )}

      <Box marginTop={1}>
        <Text color="white" bold>
          {t.prompt}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, i) => (
          <MenuRow key={row.value} selected={i === idx} hotkey={row.hotkey} label={row.label} />
        ))}
      </Box>

      {!expanded && (
        <Box marginTop={1}>
          <Text color={COLORS.muted} italic>
            {t.detailHint}
          </Text>
        </Box>
      )}
    </Frame>
  );
}

interface CompactBodyProps {
  about: string;
  warningTitle: string;
  warning: string;
}

function CompactBody({ about, warningTitle, warning }: CompactBodyProps) {
  return (
    <>
      <Box marginTop={1}>
        <Text>{about}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={COLORS.warn} bold>
          {GLYPHS.warn} {warningTitle}
        </Text>
      </Box>
      <Text>{warning}</Text>
    </>
  );
}

interface ExpandedBodyProps {
  t: (typeof I18N_WELCOME)[keyof typeof I18N_WELCOME];
}

function ExpandedBody({ t }: ExpandedBodyProps) {
  return (
    <>
      <SectionHead>{t.aboutTitle}</SectionHead>
      <Text>{t.about}</Text>

      <SectionHead>{t.capabilitiesTitle}</SectionHead>
      <Text>{t.capabilities}</Text>

      <Box marginTop={1}>
        <Text color={COLORS.warn} bold>
          {GLYPHS.warn} {t.warningTitle}
        </Text>
      </Box>
      <Text>{t.warning}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text color={COLORS.muted} italic>
          {t.responsibility}
        </Text>
        <Text color={COLORS.muted} italic>
          {t.extensionNote}
        </Text>
      </Box>
    </>
  );
}

/* Logo A — typeset wordmark, single line. See system.jsx → LogoCard,
 * option A. `·` is the magenta hairline between "browser" and "link";
 * we render it in muted gray here because magenta is the Branded mood
 * primary and would clash with the Pragmatic palette. */
function Wordmark() {
  return (
    <Box>
      <Text color={COLORS.primary} bold>
        browser
      </Text>
      <Text color={COLORS.muted}> {GLYPHS.dot} </Text>
      <Text color={COLORS.primary} bold>
        link
      </Text>
      <Text color={COLORS.muted} dimColor>
        {`  v${VERSION}`}
      </Text>
    </Box>
  );
}
