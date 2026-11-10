/**
 * The interface language of one extension window (popup, Activity, Admin):
 * which language is active, the `EN | ES` selector in the header, and keeping
 * every text on screen in that language.
 *
 * - The choice lives in `chrome.storage.local` under `uiLanguage`. With no
 *   stored choice, the browser language decides (i18n.ts `resolveLanguage`).
 * - Pressing the selector stores the choice and re-renders this window at
 *   once; every other open window follows through `chrome.storage.onChanged`.
 * - Static markup is re-read from its `data-i18n*` attributes. Text a script
 *   sets is registered with `text()`/`attr()` as a function of the
 *   dictionary, so a switch re-renders it in whatever state it is in (a
 *   "Stopping…" button stays "Stopping…", now in the other language).
 */
import {
  isLanguage,
  isStaticKey,
  messages,
  resolveLanguage,
  type Language,
  type Messages,
} from './i18n.js';

/** `chrome.storage.local` key holding the chosen language. */
export const UI_LANGUAGE_STORAGE_KEY = 'uiLanguage';

/** Where the choice is kept; `chromeLanguageStore()` in production, an
 * in-memory fake in tests. `subscribe` reports changes made by any window. */
export interface LanguageStore {
  read: () => Promise<unknown>;
  write: (language: Language) => Promise<void>;
  subscribe: (listener: (value: unknown) => void) => void;
}

export function chromeLanguageStore(): LanguageStore {
  return {
    read: async () =>
      (await chrome.storage.local.get(UI_LANGUAGE_STORAGE_KEY))[UI_LANGUAGE_STORAGE_KEY],
    write: (language) => chrome.storage.local.set({ [UI_LANGUAGE_STORAGE_KEY]: language }),
    subscribe: (listener) => {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!Object.hasOwn(changes, UI_LANGUAGE_STORAGE_KEY)) return;
        listener(changes[UI_LANGUAGE_STORAGE_KEY].newValue);
      });
    },
  };
}

type Render = (t: Messages) => string;

export interface UiLanguage {
  readonly language: Language;
  readonly t: Messages;
  /** Set `el`'s text now and again on every language switch. */
  text: (el: Element, render: Render) => void;
  /** Same as `text`, for one attribute (`title`, `aria-label`, …). */
  attr: (el: Element, name: string, render: Render) => void;
  /** Text that is not interface copy (a server error, a URL): set as is and
   * no longer re-rendered on a switch. */
  plain: (el: Element, value: string) => void;
  /** Switch language: store it and re-render this window. */
  set: (language: Language) => Promise<void>;
  /** Called after every switch, for what a window re-renders itself (tables,
   * option lists, a fresh request to the server). */
  onChange: (listener: (t: Messages, language: Language) => void) => void;
}

const ATTRIBUTE_BINDINGS: readonly (readonly [dataAttribute: string, target: string])[] = [
  ['data-i18n-title', 'title'],
  ['data-i18n-placeholder', 'placeholder'],
  ['data-i18n-aria-label', 'aria-label'],
];

/** Fill every `data-i18n*` binding under `root` from `t`. A key that is not a
 * plain-string entry leaves the markup as it is (the guard test reports it). */
export function applyStaticText(root: ParentNode, t: Messages): void {
  for (const node of Array.from(root.querySelectorAll('[data-i18n]'))) {
    const key = node.getAttribute('data-i18n') ?? '';
    if (isStaticKey(key)) node.textContent = t[key];
  }
  for (const [dataAttribute, target] of ATTRIBUTE_BINDINGS) {
    for (const node of Array.from(root.querySelectorAll(`[${dataAttribute}]`))) {
      const key = node.getAttribute(dataAttribute) ?? '';
      if (isStaticKey(key)) node.setAttribute(target, t[key]);
    }
  }
}

function markSwitch(doc: Document, language: Language): void {
  for (const button of Array.from(doc.querySelectorAll('.lang-switch button[data-lang]'))) {
    button.setAttribute('aria-pressed', String(button.getAttribute('data-lang') === language));
  }
}

export interface StartOptions {
  doc?: Document;
  store?: LanguageStore;
  navigatorLanguage?: string | undefined;
}

/** Resolve the language, render the window in it, wire the selector and
 * follow changes from other windows. Never rejects: a storage failure means
 * the first-run default. */
export async function startUiLanguage(options: StartOptions = {}): Promise<UiLanguage> {
  const doc = options.doc ?? document;
  const store = options.store ?? chromeLanguageStore();
  const navigatorLanguage =
    'navigatorLanguage' in options ? options.navigatorLanguage : navigator.language;

  let stored: unknown;
  try {
    stored = await store.read();
  } catch {
    stored = undefined;
  }
  let language = resolveLanguage(stored, navigatorLanguage);
  const bindings = new Map<Element, Map<string, Render>>();
  const listeners: ((t: Messages, language: Language) => void)[] = [];

  const renderBinding = (el: Element, target: string, render: Render): void => {
    const value = render(messages(language));
    if (target === '') el.textContent = value;
    else el.setAttribute(target, value);
  };

  const bind = (el: Element, target: string, render: Render): void => {
    const forElement = bindings.get(el) ?? new Map<string, Render>();
    forElement.set(target, render);
    bindings.set(el, forElement);
    renderBinding(el, target, render);
  };

  const render = (): void => {
    const t = messages(language);
    doc.documentElement.lang = language;
    applyStaticText(doc, t);
    markSwitch(doc, language);
    for (const [el, forElement] of bindings) {
      // Rows that left the page (a finished flow, a rebuilt list) are dropped
      // here rather than kept alive by the registry.
      if (!el.isConnected) {
        bindings.delete(el);
        continue;
      }
      for (const [target, fn] of forElement) renderBinding(el, target, fn);
    }
  };

  const switchTo = (next: Language): void => {
    if (next === language) return;
    language = next;
    render();
    const t = messages(language);
    for (const listener of listeners) listener(t, language);
  };

  render();

  for (const button of Array.from(doc.querySelectorAll('.lang-switch button[data-lang]'))) {
    button.addEventListener('click', () => {
      const next = button.getAttribute('data-lang');
      if (isLanguage(next)) void handle.set(next);
    });
  }
  store.subscribe((value) => {
    if (isLanguage(value)) switchTo(value);
  });

  const handle: UiLanguage = {
    get language() {
      return language;
    },
    get t() {
      return messages(language);
    },
    text: (el, fn) => {
      bind(el, '', fn);
    },
    attr: (el, name, fn) => {
      bind(el, name, fn);
    },
    plain: (el, value) => {
      bindings.get(el)?.delete('');
      el.textContent = value;
    },
    set: async (next) => {
      switchTo(next);
      try {
        await store.write(next);
      } catch {
        // This window already switched; other windows simply keep theirs.
      }
    },
    onChange: (listener) => {
      listeners.push(listener);
    },
  };
  return handle;
}
