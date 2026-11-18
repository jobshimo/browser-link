// lib.mjs helpers the harness shares: the one element-ref pattern and the
// error text that is never "undefined".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorText, REF_PATTERN, refOf } from './lib.mjs';

test('refOf reads the first element ref out of a find/snapshot answer', () => {
  assert.equal(refOf('[{"ref":"a1b2:e12","name":"Add item"}]'), 'a1b2:e12');
  assert.equal(refOf('x ab:e3 and cd:e4'), 'ab:e3');
  assert.ok(REF_PATTERN.test('doc9:e1'));
});

test('refOf is undefined when there is no ref, whatever the input', () => {
  assert.equal(refOf('no ref here'), undefined);
  assert.equal(refOf(''), undefined);
  assert.equal(refOf(undefined), undefined);
  assert.equal(refOf(null), undefined);
});

test('errorText is always a defined, non-empty string', () => {
  assert.equal(errorText(new Error('boom')), 'boom');
  assert.equal(errorText('plain'), 'plain');
  assert.equal(errorText({ message: 'from object' }), 'from object');
  for (const odd of [undefined, null, {}, new Error(''), { message: undefined }]) {
    const text = errorText(odd);
    assert.equal(typeof text, 'string');
    assert.notEqual(text, '');
    assert.ok(!/^undefined$|^null$/.test(text), `got ${text}`);
  }
});
