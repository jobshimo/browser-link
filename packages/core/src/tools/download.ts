/**
 * Registry entries of `download` (`browser.download`'s selector mode) and
 * `download_settle` (design 3.3, slice 16). Each handler is the body the
 * extension ran in its own `case` before (`background.ts`
 * `handleDownloadCapture`, `handleDownloadSettle`), with the same result and
 * error texts. Both require `downloads`, which only the extension provides:
 * the held-download state stays behind its adapter (`download-capture.ts`).
 *
 * - `download` arms the capture, clicks, and waits for the download the
 *   click starts. Only a download the tab itself reported is taken; it is
 *   held and its URL handed back; the server fetches the bytes in the page,
 *   writes the file, then sends `download_settle`. A download that cannot be
 *   tied to the tab answers `state: "unattributed"`; nothing at all answers
 *   `state: "timeout"`.
 * - `download_settle` is the server's word on a held download (`saved` true
 *   only when the file was written); it answers what became of the browser's own
 *   download. An internal wire tool: not listed.
 */
import { performClick } from '../actions/perform-click.js';
import { providedPort } from './requirement.js';
import type { ToolOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';

type Params = Record<string, unknown>;

const result = (value: unknown): ToolOutcome => ({ ok: true, result: value });
const failed = (message: string): ToolOutcome => ({
  ok: false,
  failure: { kind: 'action', message },
});

/** How long a captured download stays held after the wait, beyond the
 * download's own budget: the server's fetch gets what the wait left plus one
 * bridge slack (10 s), then writes and sends `download_settle`. A hold nobody
 * settles is released untouched. */
export const DOWNLOAD_HOLD_SLACK_MS = 30_000;

export interface DownloadParams {
  selector: string;
  /** Checked by the handler: no local default, the server always sends a
   * clamped budget, and a second copy of its default here would only drift. */
  timeout_ms: unknown;
}

function coerceDownload(p: Params): DownloadParams {
  return { selector: typeof p.selector === 'string' ? p.selector : '', timeout_ms: p.timeout_ms };
}

export const downloadTool: ToolEntry<
  DownloadParams,
  'evaluator' | 'pointer' | 'settler' | 'downloads'
> = {
  name: 'download',
  requires: ['evaluator', 'pointer', 'settler', 'downloads'],
  listed: true,
  coerce: { extension: coerceDownload, 'cdp-direct': coerceDownload },
  handler: async (deps, { selector, timeout_ms }) => {
    if (typeof timeout_ms !== 'number' || !(timeout_ms > 0)) {
      return failed('download: timeout_ms required');
    }
    const outcome = await providedPort(deps.downloads, 'downloads').captureAround(
      { timeoutMs: timeout_ms, holdMs: timeout_ms + DOWNLOAD_HOLD_SLACK_MS },
      // settle_ms: 0, the thing to wait for is the download, not DOM quiet.
      () => performClick(deps, { selector, settle_ms: 0 }),
    );
    if (!outcome.ok) {
      // The click itself failed (not found, covered, or its press did not
      // reach the target): say so, not "no download started".
      return failed(
        `the click that should start the download failed, so no download was captured: ${outcome.error}`,
      );
    }
    return result(
      outcome.outcome.state === 'captured'
        ? { state: 'captured', ...outcome.outcome.download }
        : { state: outcome.outcome.state },
    );
  },
};

export interface DownloadSettleParams {
  download_id: unknown;
  saved: unknown;
}

function coerceDownloadSettle(p: Params): DownloadSettleParams {
  return { download_id: p.download_id, saved: p.saved };
}

export const downloadSettleTool: ToolEntry<DownloadSettleParams, 'downloads'> = {
  name: 'download_settle',
  requires: ['downloads'],
  listed: false,
  coerce: { extension: coerceDownloadSettle, 'cdp-direct': coerceDownloadSettle },
  handler: async (deps, { download_id, saved }) => {
    if (typeof download_id !== 'number' || typeof saved !== 'boolean') {
      return failed('download_settle: download_id and saved required');
    }
    const chromeDownload = await providedPort(deps.downloads, 'downloads').settle(
      download_id,
      saved,
    );
    return result({ chrome_download: chromeDownload });
  },
};
