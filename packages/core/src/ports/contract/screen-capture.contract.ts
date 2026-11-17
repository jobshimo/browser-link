// What every `ScreenCapture` guarantees (5.3, item 5): the page's answers to
// `Page.getLayoutMetrics` and `Page.captureScreenshot`, one command per call
// (slice 15). It runs against the page driver's screen capture over a
// `CdpSession`, on the in-memory fake and on a real Chrome target.

import type { ScreenCapture } from '../page-driver.js';
import type { CaptureParams } from '../values.js';
import { type ContractCase, check, equal } from './assert.js';

/** The first bytes of every PNG, base64. */
const PNG_BASE64_PREFIX = 'iVBORw0KGgo';

export interface ScreenCaptureHarness {
  screen: ScreenCapture;
  /** Capture params the page refuses, and the CDP error message it fails with. */
  failing: { params: CaptureParams; message: string };
  dispose?: () => Promise<void> | void;
}

export function defineScreenCaptureContract(
  make: () => Promise<ScreenCaptureHarness> | ScreenCaptureHarness,
): ContractCase[] {
  const withHarness =
    (body: (harness: ScreenCaptureHarness) => Promise<void>) => async (): Promise<void> => {
      const harness = await make();
      try {
        await body(harness);
      } finally {
        await harness.dispose?.();
      }
    };

  return [
    {
      name: 'layoutMetrics answers the content size and the layout viewport width in CSS pixels',
      run: withHarness(async ({ screen }) => {
        const metrics = await screen.layoutMetrics();
        check((metrics.cssContentSize?.width ?? 0) > 0, 'cssContentSize.width > 0');
        check((metrics.cssContentSize?.height ?? 0) > 0, 'cssContentSize.height > 0');
        check(
          (metrics.cssLayoutViewport?.clientWidth ?? 0) > 0,
          'cssLayoutViewport.clientWidth > 0',
        );
      }),
    },
    {
      name: 'capture answers the image the page renders, base64',
      run: withHarness(async ({ screen }) => {
        const data = await screen.capture({
          format: 'png',
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
        });
        check(typeof data === 'string', 'the image is a string');
        equal(data.slice(0, PNG_BASE64_PREFIX.length), PNG_BASE64_PREFIX, 'PNG signature');
      }),
    },
    {
      name: 'a refused capture rejects with the CDP error message unchanged',
      run: withHarness(async ({ screen, failing }) => {
        let message: string | null = null;
        try {
          await screen.capture(failing.params);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        equal(message, failing.message, 'error message');
      }),
    },
  ];
}
