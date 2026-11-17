// The bounded buffer that keeps the tail of Chrome's stderr for a failed start.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHROME_STDERR_MAX, boundedBuffer } from './lib.mjs';

test('the buffer keeps everything below its bound', () => {
  const b = boundedBuffer(10);
  b.push('abc');
  b.push(Buffer.from('def'));
  assert.equal(b.toString(), 'abcdef');
});

test('the buffer keeps only the last `max` characters across chunks', () => {
  const b = boundedBuffer(5);
  b.push('12345');
  b.push('678');
  assert.equal(b.toString(), '45678');
  b.push('x'.repeat(100));
  assert.equal(b.toString(), 'xxxxx');
});

test('Chrome stderr is bounded to 64 KB', () => {
  assert.equal(CHROME_STDERR_MAX, 65536);
});
