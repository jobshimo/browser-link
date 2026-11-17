// GENERATED from packages/core/src/inpage/canvas.ts. Do not edit.
// The canvas-screenshot in-page expression of `browser.canvas_screenshot`
// (moved from `background.ts` in slice 15, unchanged).

/** What `buildCanvasScreenshotJs` takes. */
export interface CanvasScreenshotOpts {
  selector?: string;
  region?: { x: number; y: number; w: number; h: number };
  format: 'png' | 'jpeg';
}

/** Build the canvas-screenshot expression. Walks nested Shadow DOM roots
 * (Qt-WASM apps hide their canvas behind two layers of attachShadow), then
 * either dumps the whole canvas via `toDataURL` or crops to a region via a
 * temp 2D canvas. Returns the base64 body (no `data:` prefix) plus enough
 * size metadata for callers to convert CSS-pixel coordinates to canvas
 * pixels and vice versa.
 *
 * Caveat (also documented in the tool's `doc.gotchas`): pure WebGL canvases
 * created without `preserveDrawingBuffer: true` may return blank pixels —
 * the framebuffer is cleared between frames. Qt-WASM enables preservation,
 * so the headline use case (Victron VRM Remote Console, Venus OS) works.
 */
export function buildCanvasScreenshotJs(opts: CanvasScreenshotOpts): string {
  const optsJson = JSON.stringify({
    selector: opts.selector ?? null,
    region: opts.region ?? null,
    format: opts.format,
  });
  return `
(() => {
  const opts = ${optsJson};

  function findCanvas(root) {
    if (!root) return null;
    // If a selector was provided, try it on this root first. The selector
    // may target the canvas directly or a host that contains it.
    if (opts.selector) {
      try {
        const direct = root.querySelector(opts.selector);
        if (direct) {
          if (direct.tagName === 'CANVAS') return direct;
          const nested = direct.querySelector ? direct.querySelector('canvas') : null;
          if (nested) return nested;
        }
      } catch (_) { /* invalid selector — fall through to heuristic */ }
    }
    // Heuristic: first visible canvas in this root.
    const c = root.querySelector && root.querySelector('canvas');
    if (c && c.offsetParent !== null) return c;
    if (root.querySelectorAll) {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const r = findCanvas(el.shadowRoot);
          if (r) return r;
        }
      }
    }
    return null;
  }

  const canvas = findCanvas(document);
  if (!canvas) {
    return { ok: false, reason: 'no-canvas', message: 'No <canvas> found in the document or any reachable Shadow DOM root.' };
  }

  const rect = canvas.getBoundingClientRect();
  const cssSize = { w: rect.width, h: rect.height };
  const pixelSize = { w: canvas.width, h: canvas.height };
  const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';

  let imageUrl;
  let region = { x: 0, y: 0, w: canvas.width, h: canvas.height };

  if (opts.region) {
    // Clamp the requested region against the canvas backing store so a
    // bad x/y/w/h never produces a black band outside the real pixels.
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(opts.region.x)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(opts.region.y)));
    const w = Math.max(1, Math.min(canvas.width - x, Math.round(opts.region.w)));
    const h = Math.max(1, Math.min(canvas.height - y, Math.round(opts.region.h)));
    region = { x, y, w, h };
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    if (!ctx) {
      return { ok: false, reason: 'crop-failed', message: '2D context unavailable for crop canvas.' };
    }
    try {
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      imageUrl = tmp.toDataURL(mime);
    } catch (err) {
      return { ok: false, reason: 'tainted', message: err && err.message ? err.message : String(err) };
    }
  } else {
    try {
      imageUrl = canvas.toDataURL(mime);
    } catch (err) {
      return { ok: false, reason: 'tainted', message: err && err.message ? err.message : String(err) };
    }
  }

  const commaIdx = imageUrl.indexOf(',');
  const imageB64 = commaIdx >= 0 ? imageUrl.slice(commaIdx + 1) : imageUrl;

  return {
    ok: true,
    canvas_size: cssSize,
    canvas_pixels: pixelSize,
    region,
    format: opts.format,
    image_b64: imageB64,
    taken_at_ms: Date.now(),
  };
})()
`;
}
