import { describe, expect, test } from 'vitest';
import {
  defaultLanguage,
  dictionaryKeys,
  isLanguage,
  isStaticKey,
  messages,
  resolveLanguage,
} from './i18n.js';

describe('dictionaries', () => {
  test('Spanish has exactly the English keys, each of the same kind', () => {
    const en = messages('en');
    const es = messages('es');
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const key of dictionaryKeys()) {
      expect(typeof es[key], key).toBe(typeof en[key]);
    }
  });

  test('no plain-string entry is empty in either language', () => {
    for (const lang of ['en', 'es'] as const) {
      const t = messages(lang);
      for (const key of dictionaryKeys()) {
        const value = t[key];
        if (typeof value === 'string') expect(value.trim(), `${lang}.${key}`).not.toBe('');
      }
    }
  });

  test('interpolated texts take their values instead of being glued from fragments', () => {
    expect(messages('en').popupRunningInstalled('0.40.0', '0.41.0')).toBe(
      'Server running 0.40.0 · installed 0.41.0',
    );
    expect(messages('es').popupRunningInstalled('0.40.0', '0.41.0')).toBe(
      'Servidor en ejecución 0.40.0 · instalado 0.41.0',
    );
    expect(messages('es').popupStepsCaptured(1, false)).toBe('1 paso capturado');
    expect(messages('es').popupStepsCaptured(3, true)).toBe(
      '3 pasos capturados — detenida: se alcanzó el límite de 20 pasos',
    );
  });

  test('the two languages differ where they should', () => {
    expect(messages('en').popupConnect).toBe('Connect this tab');
    expect(messages('es').popupConnect).toBe('Conectar esta pestaña');
  });
});

describe('language choice', () => {
  test('first run: Spanish for any es* browser language', () => {
    expect(defaultLanguage('es')).toBe('es');
    expect(defaultLanguage('es-ES')).toBe('es');
    expect(defaultLanguage('es-419')).toBe('es');
    expect(defaultLanguage('ES-mx')).toBe('es');
  });

  test('first run: English for everything else, including a missing language', () => {
    expect(defaultLanguage('en-US')).toBe('en');
    expect(defaultLanguage('fr')).toBe('en');
    expect(defaultLanguage('')).toBe('en');
    expect(defaultLanguage(undefined)).toBe('en');
  });

  test('a stored choice wins over the browser language', () => {
    expect(resolveLanguage('en', 'es-ES')).toBe('en');
    expect(resolveLanguage('es', 'en-US')).toBe('es');
  });

  test('a missing or corrupted stored value falls back to the first-run default', () => {
    expect(resolveLanguage(undefined, 'es-AR')).toBe('es');
    expect(resolveLanguage('fr', 'en-US')).toBe('en');
    expect(resolveLanguage(42, 'es')).toBe('es');
    expect(isLanguage('ES')).toBe(false);
  });
});

describe('isStaticKey', () => {
  test('only existing plain-string keys can be bound from markup', () => {
    expect(isStaticKey('popupConnect')).toBe(true);
    expect(isStaticKey('popupRunningInstalled')).toBe(false);
    expect(isStaticKey('noSuchKey')).toBe(false);
    expect(isStaticKey('toString')).toBe(false);
  });
});
