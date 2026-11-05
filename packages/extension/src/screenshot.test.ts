import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MAX_DIMENSION,
  MAX_IMAGE_BYTES,
  base64ByteLength,
  nextOversizeAttempt,
  planClip,
  runScreenshot,
  type ElementRectOutcome,
  type LayoutMetrics,
} from './screenshot.js';

const METRICS: LayoutMetrics = {
  cssContentSize: { width: 1200, height: 5000 },
  cssVisualViewport: { pageX: 0, pageY: 300, clientWidth: 1000, clientHeight: 700 },
};

describe('planClip', () => {
  test('viewport mode clips the visible viewport at its page offset, scale 1', () => {
    const plan = planClip('viewport', METRICS, undefined, 8000);
    expect(plan.clip).toEqual({ x: 0, y: 300, width: 1000, height: 700, scale: 1 });
    expect(plan).toMatchObject({ width: 1000, height: 700, scale: 1, truncated: false });
  });

  test('full_page mode clips the whole CSS content size', () => {
    const plan = planClip('full_page', METRICS, undefined, 8000);
    expect(plan.clip).toEqual({ x: 0, y: 0, width: 1200, height: 5000, scale: 1 });
    expect(plan.height).toBe(5000);
  });

  test('falls back to the device-pixel content size when css metrics are absent', () => {
    const plan = planClip(
      'full_page',
      { contentSize: { width: 800, height: 600 } },
      undefined,
      8000,
    );
    expect(plan.clip).toMatchObject({ width: 800, height: 600 });
  });

  test('element mode clips the resolved element rect', () => {
    const plan = planClip('element', METRICS, { x: 10, y: 20, width: 300, height: 100 }, 8000);
    expect(plan.clip).toEqual({ x: 10, y: 20, width: 300, height: 100, scale: 1 });
  });

  test('lowers scale so the longest side fits max_dimension', () => {
    const plan = planClip(
      'full_page',
      { cssContentSize: { width: 1000, height: 16000 } },
      undefined,
      8000,
    );
    expect(plan.scale).toBeCloseTo(0.5);
    expect(plan.height).toBe(8000);
    expect(plan.width).toBe(500);
    expect(plan.clip.height).toBe(16000);
    expect(plan.truncated).toBe(false);
  });

  test('never upscales a small region', () => {
    const plan = planClip('element', METRICS, { x: 0, y: 0, width: 50, height: 40 }, 8000);
    expect(plan.scale).toBe(1);
  });

  test('crops and flags truncated instead of shrinking below the minimum scale', () => {
    const plan = planClip(
      'full_page',
      { cssContentSize: { width: 1000, height: 100000 } },
      undefined,
      8000,
    );
    expect(plan.scale).toBe(0.25);
    expect(plan.truncated).toBe(true);
    expect(plan.clip.height).toBe(32000);
    expect(plan.height).toBe(8000);
    expect(plan.width).toBe(250);
  });

  test('throws a clear error for an empty region', () => {
    expect(() => planClip('element', METRICS, { x: 0, y: 0, width: 0, height: 10 }, 8000)).toThrow(
      /zero-sized/,
    );
    expect(() => planClip('full_page', {}, undefined, 8000)).toThrow(/layout metrics/);
  });

  test('element mode without a rect is a programming error', () => {
    expect(() => planClip('element', METRICS, undefined, 8000)).toThrow(/element rect/);
  });
});

describe('byte cap helpers', () => {
  test('base64ByteLength accounts for padding', () => {
    expect(base64ByteLength('')).toBe(0);
    expect(base64ByteLength('QUJD')).toBe(3);
    expect(base64ByteLength('QUI=')).toBe(2);
    expect(base64ByteLength('QQ==')).toBe(1);
  });

  test('png over the cap falls back to jpeg at the same scale first', () => {
    const next = nextOversizeAttempt(
      { format: 'png', scale: 1, quality: undefined },
      MAX_IMAGE_BYTES * 2,
      MAX_IMAGE_BYTES,
    );
    expect(next).toEqual({ format: 'jpeg', scale: 1, quality: 80 });
  });

  test('png fallback keeps a caller-supplied quality', () => {
    const next = nextOversizeAttempt(
      { format: 'png', scale: 1, quality: 40 },
      MAX_IMAGE_BYTES * 2,
      MAX_IMAGE_BYTES,
    );
    expect(next?.quality).toBe(40);
  });

  test('jpeg over the cap lowers scale proportionally to the overshoot', () => {
    const next = nextOversizeAttempt(
      { format: 'jpeg', scale: 1, quality: 80 },
      MAX_IMAGE_BYTES * 4,
      MAX_IMAGE_BYTES,
    );
    expect(next?.format).toBe('jpeg');
    expect(next?.scale).toBeLessThan(0.5);
    expect(next?.scale).toBeGreaterThan(0.3);
  });

  test('gives up (null) once the scale floor is reached', () => {
    expect(
      nextOversizeAttempt(
        { format: 'jpeg', scale: 0.1, quality: 80 },
        MAX_IMAGE_BYTES * 4,
        MAX_IMAGE_BYTES,
      ),
    ).toBeNull();
  });
});

// --- runScreenshot with a fake CDP --------------------------------------

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeDeps(opts: { metrics?: LayoutMetrics; images?: string[]; rect?: ElementRectOutcome }) {
  const calls: Call[] = [];
  const images = [...(opts.images ?? ['QUJD'])];
  return {
    calls,
    deps: {
      send: (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        if (method === 'Page.getLayoutMetrics') return Promise.resolve(opts.metrics ?? METRICS);
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: images.length > 1 ? images.shift() : images[0] });
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
      resolveElementRect: () =>
        Promise.resolve(opts.rect ?? { ok: true as const, x: 5, y: 6, width: 100, height: 50 }),
    },
  };
}

describe('runScreenshot', () => {
  test('full_page captures beyond the viewport with the planned clip', async () => {
    const { deps, calls } = fakeDeps({});
    const out = await runScreenshot(deps, { mode: 'full_page' });
    const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
    expect(shot?.params).toMatchObject({
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1200, height: 5000, scale: 1 },
    });
    expect(shot?.params).not.toHaveProperty('quality');
    expect(out).toMatchObject({
      ok: true,
      mode: 'full_page',
      format: 'png',
      width: 1200,
      height: 5000,
      scale: 1,
      bytes: 3,
      image_b64: 'QUJD',
    });
    expect(out.truncated).toBeUndefined();
  });

  test('viewport mode does not capture beyond the viewport', async () => {
    const { deps, calls } = fakeDeps({});
    await runScreenshot(deps, { mode: 'viewport' });
    const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
    expect(shot?.params.captureBeyondViewport).toBe(false);
  });

  test('jpeg forwards quality', async () => {
    const { deps, calls } = fakeDeps({});
    await runScreenshot(deps, { mode: 'viewport', format: 'jpeg', quality: 55 });
    const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
    expect(shot?.params).toMatchObject({ format: 'jpeg', quality: 55 });
  });

  test('element mode resolves the rect and skips layout metrics', async () => {
    const { deps, calls } = fakeDeps({});
    const out = await runScreenshot(deps, { mode: 'element', selector: '#card' });
    expect(calls.some((c) => c.method === 'Page.getLayoutMetrics')).toBe(false);
    const shot = calls.find((c) => c.method === 'Page.captureScreenshot');
    expect(shot?.params.clip).toEqual({ x: 5, y: 6, width: 100, height: 50, scale: 1 });
    expect(out).toMatchObject({ width: 100, height: 50 });
  });

  test('element mode needs a selector', async () => {
    const { deps } = fakeDeps({});
    await expect(runScreenshot(deps, { mode: 'element' })).rejects.toThrow(/selector/);
  });

  test('element not found and invalid selector become clear errors', async () => {
    const nf = fakeDeps({ rect: { ok: false, reason: 'not-found' } });
    await expect(runScreenshot(nf.deps, { mode: 'element', selector: '#nope' })).rejects.toThrow(
      'Element not found: #nope',
    );
    const bad = fakeDeps({ rect: { ok: false, reason: 'invalid-selector', error: 'bad' } });
    await expect(runScreenshot(bad.deps, { mode: 'element', selector: '(' })).rejects.toThrow(
      /Invalid selector "\(": bad/,
    );
  });

  test('reports truncated for pages beyond the crop limit', async () => {
    const { deps } = fakeDeps({ metrics: { cssContentSize: { width: 1000, height: 100000 } } });
    const out = await runScreenshot(deps, { mode: 'full_page' });
    expect(out.truncated).toBe(true);
    expect(out.scale).toBe(0.25);
  });

  test('max_dimension lowers scale', async () => {
    const { deps } = fakeDeps({});
    const out = await runScreenshot(deps, { mode: 'full_page', maxDimension: 2500 });
    expect(out.scale).toBe(0.5);
    expect(out.height).toBe(2500);
    expect(DEFAULT_MAX_DIMENSION).toBe(8000);
  });

  test('retries as jpeg when the png exceeds the byte cap', async () => {
    const big = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
    const { deps, calls } = fakeDeps({ images: [big, 'QUJD'] });
    const out = await runScreenshot(deps, { mode: 'full_page' });
    const shots = calls.filter((c) => c.method === 'Page.captureScreenshot');
    expect(shots).toHaveLength(2);
    expect(shots[1]?.params).toMatchObject({ format: 'jpeg', quality: 80 });
    expect(out).toMatchObject({ format: 'jpeg', size_reduced: true, bytes: 3 });
  });

  test('errors with the measured size when no attempt fits the cap', async () => {
    const big = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 40) / 3));
    const { deps } = fakeDeps({ images: [big] });
    await expect(runScreenshot(deps, { mode: 'full_page' })).rejects.toThrow(
      /exceeds the .* MB cap/,
    );
  });
});
