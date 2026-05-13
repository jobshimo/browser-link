import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Frame } from '../components.js';
import { GLYPHS } from '../tokens.js';
import { Badge, FooterKeys, MenuRow } from '../primitives/index.js';
import type { Language } from '../../commands/welcome.js';
import { INSTALLERS, type ClientId } from '../../installers/index.js';
import type { CommonProps } from './types.js';

/* Client picker — pick an MCP client to register browser-link in.
 *
 * v0.9.0: each row carries a right-aligned <Badge> showing the live
 * registration status (registered / not registered / not detected),
 * replacing the dim hint string that used to follow the label. The
 * badge's color + glyph carry the meaning so the user reads it as a
 * shape, not as a sentence.
 */
interface ClientPickerProps extends CommonProps {
  onPick: (id: ClientId) => void;
  onBack: () => void;
}

const PICKER_I18N: Record<
  Language,
  {
    title: string;
    prompt: string;
    refreshHint: string;
    footerNav: string;
    footerRegister: string;
    footerBack: string;
    registered: string;
    notRegistered: string;
    notDetected: string;
  }
> = {
  en: {
    title: 'Register browser-link in…',
    prompt: 'Which MCP client?',
    refreshHint: 'Re-running install on a registered client refreshes the entry in place.',
    footerNav: 'navigate',
    footerRegister: 'register',
    footerBack: 'back',
    registered: 'registered',
    notRegistered: 'not registered',
    notDetected: 'not detected',
  },
  es: {
    title: 'Registrar browser-link en…',
    prompt: '¿Qué cliente MCP?',
    refreshHint:
      'Volver a correr el install en un cliente registrado refresca la entrada en el lugar.',
    footerNav: 'moverse',
    footerRegister: 'registrar',
    footerBack: 'volver',
    registered: 'registrado',
    notRegistered: 'no registrado',
    notDetected: 'no detectado',
  },
};

/* Hotkeys: lowercase initial of the client id, stable across languages.
 * `claude` → c, `opencode` → o, `copilot` → p (Copilot starts with 'c'
 * too — fall back to the second-most-distinctive letter, 'p' from
 * "Copilot"). */
const HOTKEY_BY_CLIENT: Record<ClientId, string> = {
  claude: 'c',
  opencode: 'o',
  copilot: 'p',
};

export function ClientPicker({ language, onPick, onBack }: ClientPickerProps) {
  const t = PICKER_I18N[language];
  const [idx, setIdx] = useState(0);

  /* Build the row payload once per render — calling detect() inside
   * the JSX leaks a stat() into every row's diff path. */
  const rows = INSTALLERS.map((inst) => {
    const d = inst.detect();
    let kind: 'ok' | 'warn' | 'off';
    let label: string;
    if (!d.installed) {
      kind = 'off';
      label = t.notDetected;
    } else if (d.registered) {
      kind = 'ok';
      label = t.registered;
    } else {
      kind = 'warn';
      label = t.notRegistered;
    }
    return {
      id: inst.id,
      displayName: inst.displayName,
      hotkey: HOTKEY_BY_CLIENT[inst.id],
      badgeKind: kind,
      badgeLabel: label,
    };
  });

  useInput((input, key) => {
    if (key.upArrow) setIdx((i) => (i - 1 + rows.length) % rows.length);
    else if (key.downArrow) setIdx((i) => (i + 1) % rows.length);
    else if (key.return) onPick(rows[idx].id);
    else if (input === 'q' || key.escape) onBack();
    else {
      const target = rows.find((r) => r.hotkey === input.toLowerCase());
      if (target) onPick(target.id);
    }
  });

  return (
    <Frame
      title={t.title}
      footer={
        <FooterKeys
          items={[
            { k: `${GLYPHS.up}${GLYPHS.down}`, label: t.footerNav },
            { k: GLYPHS.enter, label: t.footerRegister },
            { k: 'Esc', label: t.footerBack },
          ]}
        />
      }
    >
      <Text color="white" bold>
        {t.prompt}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row, i) => (
          <MenuRow
            key={row.id}
            selected={i === idx}
            hotkey={row.hotkey}
            label={row.displayName}
            badge={<Badge kind={row.badgeKind} label={row.badgeLabel} />}
          />
        ))}
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text italic dimColor>
          {t.refreshHint}
        </Text>
      </Box>
    </Frame>
  );
}
