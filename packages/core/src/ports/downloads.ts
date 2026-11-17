// The download capture of one tab (design 3.1; the `download` and
// `download_settle` tools, slice 16). Extension only: it returns data, and
// the held-download state stays behind the adapter (`download-capture.ts`).

import type { CaptureActOutcome, CaptureAroundResult, ChromeDownloadOutcome } from './values.js';

export interface Downloads {
  /** Arm a capture for the tab's downloads, run `act`, and report what
   * Chrome downloaded within `timeoutMs`; a captured download stays held for
   * `holdMs`. A failed `act` disarms the capture and answers its error. */
  captureAround(
    wait: { timeoutMs: number; holdMs: number },
    act: () => Promise<CaptureActOutcome>,
  ): Promise<CaptureAroundResult>;
  /** The fate of a held download: `saved` true only when the file was written. */
  settle(downloadId: number, saved: boolean): Promise<ChromeDownloadOutcome>;
}
