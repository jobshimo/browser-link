import { randomBytes } from 'node:crypto';

/**
 * Confirmation codes for admin actions that write (owner decision D11).
 *
 * The server, not the caller, enforces preview-then-apply: a preview issues a
 * code bound to that exact action (its id and its value), and the write runs
 * only when the same action comes back with that code. A code is single-use
 * (spent on its first presentation, whether or not it matches, so a caller
 * cannot probe variants with it) and short-lived. A frame's own claims, such
 * as `confirm: true`, carry no weight.
 *
 * The store is per primary process and not per socket on purpose: the Admin
 * window reaches the server through whichever tab's socket is open, and that
 * socket can change between the preview and the confirm.
 */

/** Long enough for a person to read a one-line preview and press Confirm,
 * short enough that a code left behind is useless soon after. */
export const CONFIRMATION_TTL_MS = 2 * 60_000;

/** Outstanding codes kept at most; the oldest goes first. Bounds memory
 * against a caller that asks for previews in a loop. */
export const MAX_PENDING_CONFIRMATIONS = 32;

/** What a code is bound to: the action id and its exact value. */
export interface ActionBinding {
  id: string;
  value?: string | number | boolean;
}

export interface ConfirmationCodes {
  /** A fresh code for this exact action. */
  issue: (binding: ActionBinding) => string;
  /** Spend `code`: true only when it was issued for this exact action and is
   * still within its lifetime. The code is gone afterwards either way. */
  redeem: (code: string, binding: ActionBinding) => boolean;
}

export interface ConfirmationCodesOptions {
  /** Clock seam for tests. */
  now?: () => number;
  /** Code generator seam for tests. */
  newCode?: () => string;
  ttlMs?: number;
}

/** Type-tagged so the boolean `true` and the string `'true'` never match. */
function bindingKey({ id, value }: ActionBinding): string {
  return JSON.stringify([id, typeof value, value ?? null]);
}

export function createConfirmationCodes(opts: ConfirmationCodesOptions = {}): ConfirmationCodes {
  const now = opts.now ?? Date.now;
  const newCode = opts.newCode ?? (() => randomBytes(16).toString('base64url'));
  const ttlMs = opts.ttlMs ?? CONFIRMATION_TTL_MS;
  // Insertion order is issue order, so the first key is the oldest.
  const pending = new Map<string, { key: string; expiresAt: number }>();

  const dropExpired = (at: number): void => {
    for (const [code, entry] of pending) if (entry.expiresAt < at) pending.delete(code);
  };

  return {
    issue: (binding) => {
      const at = now();
      dropExpired(at);
      while (pending.size >= MAX_PENDING_CONFIRMATIONS) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const code = newCode();
      pending.set(code, { key: bindingKey(binding), expiresAt: at + ttlMs });
      return code;
    },
    redeem: (code, binding) => {
      const entry = pending.get(code);
      pending.delete(code);
      if (!entry) return false;
      return entry.expiresAt >= now() && entry.key === bindingKey(binding);
    },
  };
}
