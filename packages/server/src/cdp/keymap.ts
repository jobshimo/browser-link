/**
 * Independent copy of `packages/extension/src/keymap.ts` — see
 * `inpage/deep-query.ts`'s header comment for why this package duplicates
 * rather than imports extension-side modules. Byte-identical logic;
 * `cdp/drift.test.ts` asserts the `MODIFIER_BITS` mapping stays in lockstep
 * with the sibling at `packages/extension/src/keymap.ts`.
 *
 * Keyboard key definitions for CDP `Input.dispatchKeyEvent`, driving
 * `browser.press` over the cdp-direct transport (`./transport.ts`).
 *
 * Modeled after Puppeteer's `USKeyboardLayout` (US keyboard — the only
 * layout CDP's `Input.dispatchKeyEvent` needs; Chrome maps
 * `windowsVirtualKeyCode` + `code` to the OS's actual layout on its own),
 * trimmed to what `browser.press` exposes: the named control/navigation
 * keys plus any single printable character.
 */

export interface KeyDefinition {
  /** DOM `KeyboardEvent.key` value. */
  key: string;
  /** DOM `KeyboardEvent.code` value — physical key identity. */
  code: string;
  /** CDP `windowsVirtualKeyCode` (mirrored into `nativeVirtualKeyCode`).
   * Chrome derives the platform-native key from this plus `code` — the
   * same numeric value works on every OS. */
  keyCode: number;
  /** Text CDP should insert via a `char` event. Only set for keys that
   * produce visible input (printable characters, Space). Control keys
   * (Enter, Escape, Tab, arrows, …) omit it — they dispatch keyDown/keyUp
   * only, no `char` event, matching real hardware. */
  text?: string;
  /** True when producing this exact character requires the Shift modifier
   * on a US layout (e.g. "@" is Shift+2, "_" is Shift+-). The caller ORs
   * this into the dispatched modifiers bitmask so `event.shiftKey`
   * reports correctly even when the caller only asked for the character,
   * not the physical chord. */
  needsShift?: boolean;
}

/** The named control/navigation keys `browser.press` accepts, keyed by
 * their canonical human name. Values are the standard Windows virtual-key
 * codes (VK_RETURN, VK_ESCAPE, VK_TAB, …) — well-known constants, stable
 * across every Chromium build. */
const NAMED_KEYS: Record<string, KeyDefinition> = {
  // Enter carries text '\r' (matching Puppeteer's USKeyboardLayout): the
  // WHATWG implicit form submission algorithm runs as the default action
  // of the KEYPRESS event, and the CDP sequence only produces a keypress
  // through the `char` event — which `buildKeyEventSequence` emits only
  // for text-bearing keys. Without this, pressing Enter in a form field
  // would fire keydown/keyup but never submit the form.
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** Lowercased lookup so NAME matching is case-insensitive ("arrowup",
 * "ENTER", "Escape" all resolve to the same definition). Single printable
 * characters are resolved separately and stay case-SENSITIVE — "a" and
 * "A" are different keystrokes. A `Map` (not a plain `Record`) so a missing
 * key types as `undefined` — a `Record<string, KeyDefinition>` index would
 * type as always-`KeyDefinition` (never falsy, since objects are always
 * truthy) without `noUncheckedIndexedAccess`, which would make the
 * presence check in `resolveKey` dead code from TypeScript's point of view. */
const NAMED_KEYS_LOWER: Map<string, KeyDefinition> = new Map(
  Object.entries(NAMED_KEYS).map(([name, def]) => [name.toLowerCase(), def]),
);

/** Physical key (code + Windows virtual-key code) for each punctuation key
 * on a US keyboard, keyed by the character it produces UNSHIFTED. Shared
 * with the shifted variant of the same physical key below. Values are the
 * standard VK_OEM_* constants. */
const PUNCTUATION_PHYSICAL: ReadonlyArray<readonly [string, string, number]> = [
  ['-', 'Minus', 189],
  ['=', 'Equal', 187],
  ['[', 'BracketLeft', 219],
  [']', 'BracketRight', 221],
  ['\\', 'Backslash', 220],
  [';', 'Semicolon', 186],
  ["'", 'Quote', 222],
  ['`', 'Backquote', 192],
  [',', 'Comma', 188],
  ['.', 'Period', 190],
  ['/', 'Slash', 191],
];

/** Shifted glyph produced by the same physical punctuation key, US layout. */
const SHIFTED_PUNCTUATION: Readonly<Record<string, string>> = {
  '-': '_',
  '=': '+',
  '[': '{',
  ']': '}',
  '\\': '|',
  ';': ':',
  "'": '"',
  '`': '~',
  ',': '<',
  '.': '>',
  '/': '?',
};

/** Shifted digit-row symbols, US layout — the physical key is the digit
 * itself (Shift+2 -> "@", Shift+1 -> "!", …). */
const SHIFTED_DIGITS: Readonly<Record<string, string>> = {
  '1': '!',
  '2': '@',
  '3': '#',
  '4': '$',
  '5': '%',
  '6': '^',
  '7': '&',
  '8': '*',
  '9': '(',
  '0': ')',
};

function buildPrintableTable(): Map<string, KeyDefinition> {
  const table = new Map<string, KeyDefinition>();

  // A literal ' ' resolves to the same definition as the named 'Space' key —
  // without this alias it would fall through to the generic printable
  // fallback and lose the physical Space code/keyCode.
  table.set(' ', NAMED_KEYS.Space);

  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(97 + i);
    const upper = String.fromCharCode(65 + i);
    const code = `Key${upper}`;
    const keyCode = upper.charCodeAt(0);
    table.set(lower, { key: lower, code, keyCode, text: lower });
    table.set(upper, { key: upper, code, keyCode, text: upper, needsShift: true });
  }

  for (let d = 0; d <= 9; d++) {
    const ch = String(d);
    const code = `Digit${ch}`;
    const keyCode = 48 + d;
    table.set(ch, { key: ch, code, keyCode, text: ch });
    const shifted = SHIFTED_DIGITS[ch];
    table.set(shifted, { key: shifted, code, keyCode, text: shifted, needsShift: true });
  }

  for (const [unshifted, code, keyCode] of PUNCTUATION_PHYSICAL) {
    table.set(unshifted, { key: unshifted, code, keyCode, text: unshifted });
    const shifted = SHIFTED_PUNCTUATION[unshifted];
    table.set(shifted, { key: shifted, code, keyCode, text: shifted, needsShift: true });
  }

  return table;
}

const PRINTABLE_TABLE = buildPrintableTable();

/**
 * Resolve a human-provided `key` name (the `browser.press` `key` param)
 * into CDP dispatch parameters. Accepts:
 *  - a named control/navigation key, case-insensitive ("Enter", "arrowup"),
 *  - a single printable character, case-SENSITIVE ("a" vs "A", "@").
 *
 * Returns `null` when the name is neither — the caller surfaces that as a
 * validation error instead of silently no-op'ing on an unrecognized key.
 */
export function resolveKey(name: string): KeyDefinition | null {
  const named = NAMED_KEYS_LOWER.get(name.toLowerCase());
  if (named) return named;
  if (name.length === 1) {
    const printable = PRINTABLE_TABLE.get(name);
    if (printable) return printable;
    // Any other single printable character (unicode letters, symbols not
    // in the curated punctuation table): best-effort. `key`/`text` are
    // always correct — they drive what actually gets inserted via the
    // `char` event. `code`/`keyCode` degrade to a generic placeholder
    // since there is no physical-key mapping for it on a US layout.
    return { key: name, code: 'Unidentified', keyCode: name.charCodeAt(0), text: name };
  }
  return null;
}

/** CDP `Input.dispatchKeyEvent` modifiers bitmask. */
export const MODIFIER_BITS: Readonly<Record<string, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/** Fold a `modifiers` array (as accepted by `browser.press`) into the CDP
 * bitmask. Unknown entries are ignored defensively — the server-side
 * dispatcher already validates the enum, this is a second line of
 * defence for direct/test callers. */
export function modifiersToBitmask(modifiers: readonly string[] | undefined): number {
  if (!modifiers || modifiers.length === 0) return 0;
  let mask = 0;
  for (const m of modifiers) {
    const bit = MODIFIER_BITS[m];
    if (bit) mask |= bit;
  }
  return mask;
}

/** One CDP `Input.dispatchKeyEvent` command payload. A type alias (not an
 * interface) so it carries an implicit index signature and is directly
 * assignable to the `Record<string, unknown>` the transport's `cdp()`
 * helper takes. */
export type CdpKeyEvent = {
  type: 'keyDown' | 'rawKeyDown' | 'char' | 'keyUp';
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
};

/**
 * Build the CDP `Input.dispatchKeyEvent` sequence for one key press.
 * Pure function so the exact event shapes are unit-testable.
 *
 * Shape: a text-bearing key (printable characters, Space, Enter) gets a
 * `keyDown` (identity only, no `text` field — Chrome would insert text
 * from a text-bearing keyDown AND from a following char event, doubling
 * the input) followed by a separate `char` event carrying the text — the
 * `char` event is what produces the KEYPRESS whose default action drives
 * text insertion and, for Enter ('\r'), the WHATWG implicit form
 * submission. A control key with no text (Escape, Tab, arrows, …) gets
 * `rawKeyDown` with nothing to follow but `keyUp`, matching real hardware
 * (those keys never fire keypress in Blink).
 */
export function buildKeyEventSequence(def: KeyDefinition, modifiers: number): CdpKeyEvent[] {
  const base = {
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  };
  const hasText = typeof def.text === 'string' && def.text.length > 0;
  const events: CdpKeyEvent[] = [{ ...base, type: hasText ? 'keyDown' : 'rawKeyDown' }];
  if (hasText) {
    events.push({ ...base, type: 'char', text: def.text, unmodifiedText: def.text });
  }
  events.push({ ...base, type: 'keyUp' });
  return events;
}
