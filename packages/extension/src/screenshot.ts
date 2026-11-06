/**
 * `browser.screenshot` planning and capture, shared by the extension
 * (`chrome.debugger`) and — as a verbatim copy at
 * `packages/server/src/cdp/screenshot.ts`, guarded by `cdp/drift.test.ts` —
 * the cdp-direct transport. Both speak raw CDP, so the logic is identical;
 * it only needs a `send(method, params)` primitive and an element-rect
 * resolver, which makes it unit-testable without Chrome.
 *
 * Coordinates: `Page.captureScreenshot`'s `clip` is in CSS pixels of the
 * page (document) space; `scale` multiplies it into output pixels.
 */

export type ScreenshotMode = 'viewport' | 'full_page' | 'element';
export type ScreenshotFormat = 'png' | 'jpeg';

export const DEFAULT_MAX_DIMENSION = 8000;
/** Below this scale the text in a page is unreadable; crop instead. */
export const MIN_SCALE = 0.25;
/** Hard floor when shrinking to satisfy the byte cap. */
const ABSOLUTE_MIN_SCALE = 0.1;
/** Cap on the decoded image size returned to the agent. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_JPEG_QUALITY = 80;
const MAX_ATTEMPTS = 4;

export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}
export interface LayoutMetrics {
  cssContentSize?: Size;
  contentSize?: Size;
  cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  visualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
  /** Layout viewport in device pixels / CSS pixels — their ratio is the DPR. */
  layoutViewport?: { clientWidth: number };
  cssLayoutViewport?: { clientWidth: number };
}
export interface ScreenshotPlan {
  clip: Rect & { scale: number };
  /** Output size in pixels. */
  width: number;
  height: number;
  scale: number;
  /** Device pixels per CSS pixel; the capture is clip x scale x dpr pixels. */
  dpr: number;
  truncated: boolean;
}

/**
 * Device pixels per CSS pixel, derived from the layout metrics (no extra
 * in-page round trip): layout-viewport width ratio, else content-size
 * ratio, else 1.
 */
export function dprFromMetrics(m: LayoutMetrics): number {
  const pairs: [number | undefined, number | undefined][] = [
    [m.layoutViewport?.clientWidth, m.cssLayoutViewport?.clientWidth],
    [m.contentSize?.width, m.cssContentSize?.width],
    [m.visualViewport?.clientWidth, m.cssVisualViewport?.clientWidth],
  ];
  for (const [device, css] of pairs) {
    if (positive(device) && positive(css)) return device / css;
  }
  return 1;
}

function positive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function planClip(
  mode: ScreenshotMode,
  metrics: LayoutMetrics,
  elementRect: Rect | undefined,
  maxDimension: number,
): ScreenshotPlan {
  const dpr = dprFromMetrics(metrics);
  let region: Rect;
  if (mode === 'element') {
    if (!elementRect) throw new Error('screenshot: element rect missing for element mode');
    region = { ...elementRect };
  } else if (mode === 'viewport') {
    // Device-pixel fallback values are converted to the CSS pixels clip uses.
    const css = metrics.cssVisualViewport;
    const dev = metrics.visualViewport;
    if (css) {
      region = { x: css.pageX, y: css.pageY, width: css.clientWidth, height: css.clientHeight };
    } else if (dev) {
      region = {
        x: dev.pageX / dpr,
        y: dev.pageY / dpr,
        width: dev.clientWidth / dpr,
        height: dev.clientHeight / dpr,
      };
    } else {
      throw new Error('screenshot: layout metrics have no viewport');
    }
  } else {
    const size = metrics.cssContentSize
      ? metrics.cssContentSize
      : metrics.contentSize
        ? { width: metrics.contentSize.width / dpr, height: metrics.contentSize.height / dpr }
        : undefined;
    if (!size) throw new Error('screenshot: layout metrics have no content size');
    region = { x: 0, y: 0, width: size.width, height: size.height };
  }
  if (!positive(region.width) || !positive(region.height)) {
    throw new Error(`screenshot: ${mode} region is zero-sized — nothing to capture`);
  }

  // The output is clip x scale x dpr DEVICE pixels, so max_dimension bounds
  // the longest side in device pixels.
  let scale = Math.min(1, maxDimension / (Math.max(region.width, region.height) * dpr));
  let truncated = false;
  if (scale < MIN_SCALE) {
    scale = MIN_SCALE;
    const limit = maxDimension / (MIN_SCALE * dpr);
    if (region.width > limit) region.width = limit;
    if (region.height > limit) region.height = limit;
    truncated = true;
  }
  return {
    clip: { ...region, scale },
    width: Math.max(1, Math.round(region.width * scale * dpr)),
    height: Math.max(1, Math.round(region.height * scale * dpr)),
    scale,
    dpr,
    truncated,
  };
}

/** Decoded byte length of a base64 string. */
export function base64ByteLength(b64: string): number {
  if (b64.length === 0) return 0;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export interface Attempt {
  format: ScreenshotFormat;
  scale: number;
  quality: number | undefined;
}

/**
 * What to try after an image came back over the byte cap: PNG → JPEG at the
 * same scale, then JPEG at a scale reduced in proportion to the overshoot.
 * `null` when nothing smaller is worth trying.
 */
export function nextOversizeAttempt(prev: Attempt, bytes: number, cap: number): Attempt | null {
  if (prev.format === 'png') {
    return { format: 'jpeg', scale: prev.scale, quality: prev.quality ?? DEFAULT_JPEG_QUALITY };
  }
  if (prev.scale <= ABSOLUTE_MIN_SCALE) return null;
  const next = Math.max(ABSOLUTE_MIN_SCALE, prev.scale * Math.sqrt(cap / bytes) * 0.85);
  return { format: 'jpeg', scale: next, quality: prev.quality ?? DEFAULT_JPEG_QUALITY };
}

export type ElementRectOutcome =
  ({ ok: true } & Rect) | { ok: false; reason: 'invalid-selector' | 'not-found'; error?: string };

export interface ScreenshotDeps {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  resolveElementRect: (selector: string) => Promise<ElementRectOutcome>;
}

export interface ScreenshotOptions {
  mode?: ScreenshotMode;
  selector?: string;
  format?: ScreenshotFormat;
  quality?: number;
  maxDimension?: number;
}

export interface ScreenshotResult {
  ok: true;
  mode: ScreenshotMode;
  format: ScreenshotFormat;
  width: number;
  height: number;
  scale: number;
  bytes: number;
  truncated?: true;
  size_reduced?: true;
  image_b64: string;
}

export async function runScreenshot(
  deps: ScreenshotDeps,
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const mode = opts.mode ?? 'viewport';
  const maxDimension = opts.maxDimension ?? DEFAULT_MAX_DIMENSION;

  let elementRect: Rect | undefined;
  if (mode === 'element') {
    if (!opts.selector) throw new Error('screenshot: selector is required for element mode');
    const r = await deps.resolveElementRect(opts.selector);
    if (!r.ok) {
      if (r.reason === 'invalid-selector') {
        throw new Error(`Invalid selector "${opts.selector}": ${r.error ?? 'syntax error'}`);
      }
      throw new Error(`Element not found: ${opts.selector}`);
    }
    elementRect = { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  // Always read the metrics: besides the page size they carry the DPR the
  // output dimensions depend on.
  const metrics = (await deps.send('Page.getLayoutMetrics')) as LayoutMetrics;
  const plan = planClip(mode, metrics, elementRect, maxDimension);

  let attempt: Attempt = {
    format: opts.format ?? 'png',
    scale: plan.scale,
    quality: opts.quality,
  };
  let reduced = false;
  let lastBytes = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const params: Record<string, unknown> = {
      format: attempt.format,
      captureBeyondViewport: mode !== 'viewport',
      clip: { ...plan.clip, scale: attempt.scale },
    };
    if (attempt.format === 'jpeg' && attempt.quality !== undefined) {
      params.quality = attempt.quality;
    }
    const res = (await deps.send('Page.captureScreenshot', params)) as { data: string };
    const bytes = base64ByteLength(res.data);
    lastBytes = bytes;
    if (bytes <= MAX_IMAGE_BYTES) {
      const result: ScreenshotResult = {
        ok: true,
        mode,
        format: attempt.format,
        width: Math.max(1, Math.round(plan.clip.width * attempt.scale * plan.dpr)),
        height: Math.max(1, Math.round(plan.clip.height * attempt.scale * plan.dpr)),
        scale: attempt.scale,
        bytes,
        image_b64: res.data,
      };
      if (plan.truncated) result.truncated = true;
      if (reduced) result.size_reduced = true;
      return result;
    }
    const next = nextOversizeAttempt(attempt, bytes, MAX_IMAGE_BYTES);
    if (!next) break;
    attempt = next;
    reduced = true;
  }
  const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  throw new Error(
    `screenshot: image is ${mb(lastBytes)} MB, which exceeds the ${mb(MAX_IMAGE_BYTES)} MB cap even after reducing quality and scale — use mode "element", a smaller max_dimension, or jpeg`,
  );
}
