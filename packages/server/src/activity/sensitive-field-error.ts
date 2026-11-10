/**
 * A failed `browser.type` / `browser.press` whose executor had already
 * reported the focused field sensitive (`sensitive_field: true` on the
 * failure) before the call went wrong: an unmet `expect`, or any error after
 * the input was sent. The message is exactly the executor's, so the agent
 * sees the same error text; the class only tells the activity trail to
 * store `[sensitive field]` instead of the typed text or key.
 *
 * Thrown by the bridge (an extension error frame carrying the flag) and by
 * the cdp-direct transport. A plain `Error` (a plain field, or an older
 * extension that sends no flag) keeps the row exactly as before. `name`
 * stays `Error` on purpose: anything that prints the error prints exactly
 * what a plain failure would.
 */
export class SensitiveFieldError extends Error {}
