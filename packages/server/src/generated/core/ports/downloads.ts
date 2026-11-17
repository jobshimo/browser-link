// GENERATED from packages/core/src/ports/downloads.ts. Do not edit.
// The download capture of one tab (design 3.1; the `download` and
// `download_settle` tools, slice 16). Extension only: it returns data, and
// the held-download state stays behind the adapter (`download-capture.ts`).
// What `captureAround` answers (captured, unattributed, timeout) is what the
// transport observed, but as the answer to a command the core issues (arm,
// act, wait), not ambient state read on the side (design revision 10).

import type { CaptureActOutcome, CaptureAroundResult, DownloadSettleOutcome } from './values.js';

export interface Downloads {
  /** Arm a capture for the tab's downloads, run `act`, and report what the
   * browser downloaded within `timeoutMs`; a captured download stays held
   * for `holdMs`. A failed `act` disarms the capture and answers its error;
   * a throwing `act` disarms it and the rejection propagates. */
  captureAround(
    wait: { timeoutMs: number; holdMs: number },
    act: () => Promise<CaptureActOutcome>,
  ): Promise<CaptureAroundResult>;
  /** The fate of a held download: `saved` true only when the file was written. */
  settle(downloadId: number, saved: boolean): Promise<DownloadSettleOutcome>;
}
