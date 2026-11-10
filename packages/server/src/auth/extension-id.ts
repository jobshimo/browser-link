/**
 * The browser-link extension's id, the same on every install since 0.52.0:
 * Chrome derives it from the `key` (public key) in
 * `packages/extension/manifest.json`; `extension-id.test.ts` derives it again
 * from that key, so the two cannot drift. A stable id, not proof of identity:
 * any unpacked extension carrying the same public key gets the same id.
 *
 * Since 1.0.0 the bridge accepts only the Origin of this id or of an id in
 * the hand-edited `allowedExtensionIds` config list.
 */
export const PINNED_EXTENSION_ID = 'celegobaahdoaigibmjmekhopegfkhpe';

export const PINNED_EXTENSION_ORIGIN = `chrome-extension://${PINNED_EXTENSION_ID}`;

/** Whether `value` has the shape of a Chrome extension id: exactly 32
 * letters `a`–`p`. Anything else (a prefix, a wildcard, a full origin) is
 * not an id. */
export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

/** The extension ids allowed to open the bridge: the pinned id, then every
 * configured id that is a well-formed id, without repeats. */
export function allowedExtensionIds(configured: readonly unknown[] = []): string[] {
  const ids = [PINNED_EXTENSION_ID];
  for (const id of configured) {
    if (isExtensionId(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
