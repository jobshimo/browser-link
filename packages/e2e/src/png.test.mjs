// decodePng: the pixel reader the capture cases use to check what Chrome drew.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { colorNear, decodePng } from './lib.mjs';

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  // The decoder does not check CRCs; four zero bytes keep the layout.
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

/** A PNG from rows already filtered: each row is `[filter, ...bytes]`. */
function png(width, height, colorType, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows.flat()))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('decodePng reads RGBA rows under the None, Sub, Up, Average and Paeth filters', () => {
  // 2x5 RGBA: row 0 red | blue (None); row 1 the same through Sub, rows 2-4
  // the same through Up, Average and Paeth (each reconstructs red | blue).
  const red = [255, 0, 0, 255];
  const blue = [0, 0, 255, 255];
  const rows = [
    [0, ...red, ...blue],
    [1, ...red, ...blue.map((v, i) => (v - red[i]) & 0xff)],
    [2, 0, 0, 0, 0, 0, 0, 0, 0],
    // Average: red = 0 + (0 + red) >> 1 needs the half back.
    [
      3,
      ...red.map((v) => (v - (v >> 1)) & 0xff),
      ...blue.map((v, i) => (v - ((red[i] + v) >> 1)) & 0xff),
    ],
    // Paeth with a = left, b = up, c = up-left: x=0 predicts b (the same
    // pixel above); x=1 predicts b too here, so the deltas are zero.
    [4, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  const img = decodePng(png(2, 5, 6, rows));
  assert.equal(img.width, 2);
  assert.equal(img.height, 5);
  for (let y = 0; y < 5; y++) {
    assert.deepEqual(img.pixel(0, y), red, `row ${String(y)} left`);
    assert.deepEqual(img.pixel(1, y), blue, `row ${String(y)} right`);
  }
});

test('decodePng reads RGB (no alpha) as opaque', () => {
  const img = decodePng(png(1, 1, 2, [[0, 10, 20, 30]]));
  assert.deepEqual(img.pixel(0, 0), [10, 20, 30, 255]);
});

test('decodePng refuses what is not an 8-bit RGB/RGBA PNG', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a')), /bad signature/);
  assert.throws(() => decodePng(png(1, 1, 3, [[0, 0]])), /unsupported PNG/);
});

test('colorNear allows a small per-channel difference only', () => {
  assert.equal(colorNear([250, 3, 0, 255], [255, 0, 0]), true);
  assert.equal(colorNear([200, 0, 0, 255], [255, 0, 0]), false);
});
