import { beforeEach, describe, expect, test, vi } from 'vitest';
import { messages, type Language } from './i18n.js';
import {
  UI_LANGUAGE_STORAGE_KEY,
  applyStaticText,
  startUiLanguage,
  type LanguageStore,
} from './ui-language.js';

/** In-memory stand-in for chrome.storage.local: `external` plays another
 * extension window writing the same key. */
function fakeStore(initial: unknown): LanguageStore & {
  value: unknown;
  external: (value: unknown) => void;
} {
  const listeners: ((value: unknown) => void)[] = [];
  const store = {
    value: initial,
    read: () => Promise.resolve(store.value),
    write: (language: Language) => {
      store.value = language;
      for (const l of listeners) l(language);
      return Promise.resolve();
    },
    subscribe: (listener: (value: unknown) => void) => {
      listeners.push(listener);
    },
    external: (value: unknown) => {
      store.value = value;
      for (const l of listeners) l(value);
    },
  };
  return store;
}

const HEADER = `
  <header>
    <strong id="name" translate="no">browser-link</strong>
    <span id="sub" data-i18n="popupSubtitle">MCP bridge · per-tab manual</span>
    <input id="field" data-i18n-placeholder="popupRecordingNamePlaceholder" placeholder="x" />
    <button id="btn" data-i18n-title="activityRefreshTitle" title="x">x</button>
    <div class="lang-switch" role="group" data-i18n-aria-label="langSwitchLabel" aria-label="x">
      <button type="button" data-lang="en" aria-pressed="true" translate="no">EN</button>
      <button type="button" data-lang="es" aria-pressed="false" translate="no">ES</button>
    </div>
  </header>`;

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(id);
  return node;
}

function switchButton(lang: Language): HTMLButtonElement {
  const node = document.querySelector(`.lang-switch button[data-lang="${lang}"]`);
  if (!(node instanceof HTMLButtonElement)) throw new Error(lang);
  return node;
}

/** Let the click handler's storage write and re-render settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = HEADER;
  document.documentElement.lang = 'en';
});

describe('UI_LANGUAGE_STORAGE_KEY', () => {
  test('is the agreed chrome.storage.local key', () => {
    expect(UI_LANGUAGE_STORAGE_KEY).toBe('uiLanguage');
  });
});

describe('applyStaticText', () => {
  test('fills text, placeholder, title and aria-label from the bound keys', () => {
    applyStaticText(document, messages('es'));
    expect(el('sub').textContent).toBe('Puente MCP · manual por pestaña');
    expect(el('field').getAttribute('placeholder')).toBe(
      messages('es').popupRecordingNamePlaceholder,
    );
    expect(el('btn').title).toBe('Recargar ahora');
    expect(document.querySelector('.lang-switch')?.getAttribute('aria-label')).toBe(
      'Idioma de la interfaz',
    );
    expect(el('name').textContent).toBe('browser-link');
  });
});

describe('startUiLanguage', () => {
  test('first run with a Spanish browser renders Spanish and marks ES as active', async () => {
    const ui = await startUiLanguage({ store: fakeStore(undefined), navigatorLanguage: 'es-ES' });
    expect(ui.language).toBe('es');
    expect(el('sub').textContent).toBe('Puente MCP · manual por pestaña');
    expect(document.documentElement.lang).toBe('es');
    expect(switchButton('es').getAttribute('aria-pressed')).toBe('true');
    expect(switchButton('en').getAttribute('aria-pressed')).toBe('false');
  });

  test('first run with any other browser language renders English', async () => {
    const ui = await startUiLanguage({ store: fakeStore(undefined), navigatorLanguage: 'fr-FR' });
    expect(ui.language).toBe('en');
    expect(el('sub').textContent).toBe('MCP bridge · per-tab manual');
    expect(document.documentElement.lang).toBe('en');
  });

  test('a stored choice wins over the browser language', async () => {
    const ui = await startUiLanguage({ store: fakeStore('en'), navigatorLanguage: 'es-ES' });
    expect(ui.language).toBe('en');
  });

  test('pressing ES stores the choice and re-renders static and bound text without reload', async () => {
    const store = fakeStore('en');
    const ui = await startUiLanguage({ store, navigatorLanguage: 'en-US' });
    const status = document.createElement('span');
    document.body.append(status);
    ui.text(status, (t) => t.popupStatusConnected);
    ui.attr(status, 'title', (t) => t.popupRepairTitle);
    const seen: Language[] = [];
    ui.onChange((_t, lang) => seen.push(lang));

    switchButton('es').click();
    await settle();

    expect(store.value).toBe('es');
    expect(ui.language).toBe('es');
    expect(ui.t).toBe(messages('es'));
    expect(el('sub').textContent).toBe('Puente MCP · manual por pestaña');
    expect(status.textContent).toBe('Conectada');
    expect(status.title).toBe(messages('es').popupRepairTitle);
    expect(document.documentElement.lang).toBe('es');
    expect(switchButton('es').getAttribute('aria-pressed')).toBe('true');
    expect(seen).toEqual(['es']);
  });

  test('another window changing the stored language is followed without reload', async () => {
    const store = fakeStore('en');
    const ui = await startUiLanguage({ store, navigatorLanguage: 'en-US' });
    store.external('es');
    expect(ui.language).toBe('es');
    expect(el('sub').textContent).toBe('Puente MCP · manual por pestaña');
    expect(document.documentElement.lang).toBe('es');
  });

  test('an invalid value written elsewhere is ignored', async () => {
    const store = fakeStore('es');
    const ui = await startUiLanguage({ store, navigatorLanguage: 'en-US' });
    const listener = vi.fn();
    ui.onChange(listener);
    store.external('de');
    expect(ui.language).toBe('es');
    expect(listener).not.toHaveBeenCalled();
  });

  test('plain text replaces a binding so a later switch does not overwrite it', async () => {
    const ui = await startUiLanguage({ store: fakeStore('en'), navigatorLanguage: 'en-US' });
    const node = document.createElement('span');
    document.body.append(node);
    ui.text(node, (t) => t.popupStatusConnected);
    ui.plain(node, 'WebSocket closed before registration');
    await ui.set('es');
    expect(node.textContent).toBe('WebSocket closed before registration');
  });

  test('a store that fails to read still renders, with the first-run default', async () => {
    const store = fakeStore(undefined);
    store.read = () => Promise.reject(new Error('storage unavailable'));
    const ui = await startUiLanguage({ store, navigatorLanguage: 'es' });
    expect(ui.language).toBe('es');
  });
});
