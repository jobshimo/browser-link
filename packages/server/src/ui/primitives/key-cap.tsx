import { Text } from 'ink';

/* Visual keyboard cue. The design uses an inverted-block "keycap" style
 * for hotkey hints in footers (`↑↓`, `Enter`, `s`, `Esc`). We approximate
 * that in Ink with a single space of padding either side of the label and
 * the `inverse` text modifier — which swaps foreground and background.
 *
 * Spec reference: terminal.jsx → <Key>; system.jsx → TypeCard ("inverted").
 *
 * Why `inverse` and not `backgroundColor`: `backgroundColor` requires us
 * to also set a contrasting foreground, which forces a color choice the
 * terminal theme has no input on. Inverse picks up the user's actual
 * scheme — light terminal becomes dark keycap, dark terminal becomes
 * light keycap. Same code, both worlds.
 */
interface KeyCapProps {
  /** Visible label inside the cap — e.g. "↵", "Esc", "↑↓", "s". */
  label: string;
}

export function KeyCap({ label }: KeyCapProps) {
  return <Text inverse>{` ${label} `}</Text>;
}
