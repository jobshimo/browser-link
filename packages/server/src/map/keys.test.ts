import { describe, expect, test } from 'vitest';
import { durableTarget, isIdSegment, pathPattern, splitUrl } from './keys.js';

describe('pathPattern', () => {
  test.each([
    ['/', '/'],
    ['', '/'],
    ['/facturas/48213', '/facturas/:id'],
    ['/facturas/48213/', '/facturas/:id'],
    ['/inbox', '/inbox'],
    ['/inbox/', '/inbox'],
    ['/users/550e8400-e29b-41d4-a716-446655440000/edit', '/users/:id/edit'],
    ['/commit/3f9a2b1c', '/commit/:id'],
    ['/commit/3F9A2B1C7D', '/commit/:id'],
    ['/short/3f9a2b1', '/short/3f9a2b1'],
    ['/share/k3j4h5g6f7d8s9a0', '/share/:id'],
    ['/s/aB3dE5fG7hJ9kL1m_x', '/s/:id'],
    ['/blog/annual-report-2024', '/blog/annual-report-2024'],
    ['/settings/notifications-and-privacy', '/settings/notifications-and-privacy'],
    ['/orders/12/items/7', '/orders/:id/items/:id'],
    ['/v2/api', '/v2/api'],
    ['/facturas/:id', '/facturas/:id'],
  ])('%s → %s', (input, expected) => {
    expect(pathPattern(input)).toBe(expected);
  });

  test('is idempotent', () => {
    for (const path of ['/a/123/b', '/x/550e8400-e29b-41d4-a716-446655440000', '/']) {
      expect(pathPattern(pathPattern(path))).toBe(pathPattern(path));
    }
  });

  test('isIdSegment rejects the empty segment and :id', () => {
    expect(isIdSegment('')).toBe(false);
    expect(isIdSegment(':id')).toBe(false);
  });
});

describe('splitUrl', () => {
  test('returns origin and pathname, dropping query and hash', () => {
    expect(splitUrl('https://app.example.com/a/1?x=2#y')).toEqual({
      origin: 'https://app.example.com',
      pathname: '/a/1',
    });
  });

  test('null for missing, malformed or opaque-origin URLs', () => {
    expect(splitUrl(null)).toBeNull();
    expect(splitUrl('not a url')).toBeNull();
    expect(splitUrl('about:blank')).toBeNull();
  });
});

describe('durableTarget', () => {
  test('a selector counts for every tool; a key only for find', () => {
    expect(durableTarget('browser.click', { selector: '#go' })).toEqual({
      target: '#go',
      target_kind: 'selector',
    });
    expect(durableTarget('browser.press', { key: 'Enter' })).toBeNull();
    expect(
      durableTarget('browser.find', { key: { path: [], name: 'Go', role: 'button' } }),
    ).toEqual({
      target: JSON.stringify({ role: 'button', name: 'Go', path: [] }),
      target_kind: 'key',
    });
    expect(durableTarget('browser.click', { ref: 'abc:e1' })).toBeNull();
  });
});
