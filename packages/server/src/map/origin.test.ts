import { describe, expect, test } from 'vitest';
import { canonicalOrigin } from './origin.js';

describe('canonicalOrigin', () => {
  test('strips a trailing slash (the classic browser.map.save free-text form)', () => {
    expect(canonicalOrigin('https://myapp.example.com/')).toBe('https://myapp.example.com');
  });

  test('strips a path from a full URL', () => {
    expect(canonicalOrigin('https://myapp.example.com/home/dashboard?tab=1')).toBe(
      'https://myapp.example.com',
    );
  });

  test('lowercases scheme and host', () => {
    expect(canonicalOrigin('HTTPS://App.Example.com')).toBe('https://app.example.com');
  });

  test('drops a default port, keeps a non-default one', () => {
    expect(canonicalOrigin('https://example.com:443')).toBe('https://example.com');
    expect(canonicalOrigin('http://localhost:3030')).toBe('http://localhost:3030');
  });

  test('an already-canonical origin passes through unchanged', () => {
    expect(canonicalOrigin('http://localhost:3030')).toBe('http://localhost:3030');
    expect(canonicalOrigin('https://app.example.com')).toBe('https://app.example.com');
  });

  test('unparseable input is returned raw, never thrown on', () => {
    expect(canonicalOrigin('not a url')).toBe('not a url');
    expect(canonicalOrigin('')).toBe('');
  });

  test('opaque-origin URLs (file:, about:) return the RAW input, not the string "null"', () => {
    // new URL('about:blank').origin === 'null' — collapsing every
    // opaque-origin value into the literal "null" would merge unrelated
    // apps under one key.
    expect(canonicalOrigin('about:blank')).toBe('about:blank');
    expect(canonicalOrigin('file:///home/user/index.html')).toBe('file:///home/user/index.html');
  });
});
