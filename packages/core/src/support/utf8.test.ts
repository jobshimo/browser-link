import { describe, expect, test } from 'vitest';
import { utf8ByteLength } from './utf8.js';

const encoded = (s: string): number => new TextEncoder().encode(s).length;

describe('utf8ByteLength', () => {
  test.each([
    ['empty', ''],
    ['ASCII', 'hello, world {"a":1}'],
    ['two-byte Latin', 'ñandú café'],
    ['CJK', '日本語のテキスト'],
    ['emoji (surrogate pairs)', '👍🏽 🎉 ok'],
    ['a lone high surrogate in the middle', 'a\ud800b'],
    ['a lone high surrogate at the end', 'abc\ud83d'],
    ['a lone low surrogate', 'a\udc00b'],
    ['two high surrogates in a row', '\ud800𐀀'],
    ['mixed', 'x é 日 👍 \udfff'],
  ])('equals the TextEncoder length for %s', (_name, s) => {
    expect(utf8ByteLength(s)).toBe(encoded(s));
  });

  test('a lone surrogate counts as U+FFFD, 3 bytes', () => {
    expect(utf8ByteLength('\ud800')).toBe(3);
    expect(utf8ByteLength('\udc00')).toBe(3);
  });
});
