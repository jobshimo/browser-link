/**
 * The browser-link extension's id, the same on every install since 0.52.0:
 * Chrome derives it from the `key` (public key) in
 * `packages/extension/manifest.json`; `extension-id.test.ts` derives it again
 * from that key, so the two cannot drift. A stable id, not proof of identity:
 * any unpacked extension carrying the same public key gets the same id.
 *
 * 0.52.0 only logs a handshake from another origin; 1.0.0 refuses it.
 */
export const PINNED_EXTENSION_ID = 'celegobaahdoaigibmjmekhopegfkhpe';

export const PINNED_EXTENSION_ORIGIN = `chrome-extension://${PINNED_EXTENSION_ID}`;
