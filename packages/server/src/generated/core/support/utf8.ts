// GENERATED from packages/core/src/support/utf8.ts. Do not edit.
/**
 * UTF-8 byte counting without `TextEncoder`, which core cannot use
 * (docs/design/service-worker-architecture.md, 5.1: core compiles with
 * `"lib": ["ES2022"]` and no DOM).
 */

/**
 * The number of bytes `s` takes encoded as UTF-8: the same number
 * `new TextEncoder().encode(s).length` returns. A surrogate pair is one code
 * point of 4 bytes; a lone surrogate encodes as U+FFFD, 3 bytes.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
