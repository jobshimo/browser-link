/**
 * Registry entries of `dialog_respond` and `set_permission` (design 3.3,
 * slice 16). Each handler is the body the extension ran in its own `case`
 * before (`background.ts` `handleDialogRespond`, `handleSetPermission`),
 * with the same result and error texts.
 *
 * - `dialog_respond` requires `dialog-input`: one `Page.handleJavaScriptDialog`,
 *   no probing; with no dialog showing the page's error is the answer.
 * - `set_permission` requires `content-settings`: CDP `Browser.setPermission`
 *   needs a browser-level target, which `chrome.debugger.attach({ tabId })`
 *   does not give in MV3, so the permission goes through the extension's
 *   content settings, under the names that have one.
 *
 * cdp-direct provides neither requirement (v1 scope), so the registry
 * refuses both there as `unsupported`, which cdp-direct maps to the text its
 * dispatcher gate always gave.
 */
import { providedPort } from './requirement.js';
import type { ToolOutcome } from './failure.js';
import type { ToolEntry } from './registry.js';

type Params = Record<string, unknown>;

const result = (value: unknown): ToolOutcome => ({ ok: true, result: value });
const failed = (message: string): ToolOutcome => ({
  ok: false,
  failure: { kind: 'action', message },
});

export interface DialogRespondParams {
  accept: boolean;
  prompt_text?: string;
}

function coerceDialogRespond(p: Params): DialogRespondParams {
  return {
    accept: p.accept === true,
    prompt_text: typeof p.prompt_text === 'string' ? p.prompt_text : undefined,
  };
}

export const dialogRespondTool: ToolEntry<DialogRespondParams, 'dialog-input'> = {
  name: 'dialog_respond',
  requires: ['dialog-input'],
  listed: true,
  coerce: { extension: coerceDialogRespond, 'cdp-direct': coerceDialogRespond },
  handler: async (deps, { accept, prompt_text }) => {
    // No probing: with no dialog open the page's error is propagated; the
    // caller decides whether "no dialog to respond to" is a problem or a race.
    await deps['dialog-input'].respond(accept, prompt_text);
    return result({ accepted: accept });
  },
};

/**
 * The CDP permission name `browser.set_permission` accepts on the wire,
 * mapped to its content setting. Only the names that have a content setting
 * in MV3 are listed; `Browser.setPermission` covers more.
 */
const CONTENT_SETTING_BY_PERMISSION: Record<string, string | undefined> = {
  geolocation: 'location',
  notifications: 'notifications',
  camera: 'camera',
  microphone: 'microphone',
  clipboardReadWrite: 'clipboard',
  clipboardSanitizedWrite: 'clipboard',
  sensors: 'sensors',
};

const STATE_TO_CONTENT_SETTING: Record<string, string | undefined> = {
  granted: 'allow',
  denied: 'block',
  prompt: 'ask',
};

export interface SetPermissionParams {
  origin: string;
  name: string;
  state: string;
}

/** Each field as a string; a non-string becomes its `String(...)` text. */
function coerceSetPermission(p: Params): SetPermissionParams {
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : String(p[key]));
  return { origin: str('origin'), name: str('name'), state: str('state') };
}

export const setPermissionTool: ToolEntry<SetPermissionParams, 'content-settings'> = {
  name: 'set_permission',
  requires: ['content-settings'],
  listed: true,
  coerce: { extension: coerceSetPermission, 'cdp-direct': coerceSetPermission },
  handler: async (deps, { origin, name, state }) => {
    const settingKey = CONTENT_SETTING_BY_PERMISSION[name];
    if (!settingKey) {
      return failed(
        `set_permission: '${name}' is not supported by chrome.contentSettings in MV3. Supported names: ${Object.keys(CONTENT_SETTING_BY_PERMISSION).join(', ')}.`,
      );
    }
    const setting = STATE_TO_CONTENT_SETTING[state];
    if (!setting) {
      return failed(
        `set_permission: unknown state '${state}' (expected granted | denied | prompt).`,
      );
    }
    // A content setting takes a URL pattern, not a bare origin: `/*` makes
    // the pattern cover every path on the origin.
    const primaryPattern = origin.endsWith('/*') ? origin : `${origin}/*`;
    const contentSettings = providedPort(deps['content-settings'], 'content-settings');
    try {
      await contentSettings.set(settingKey, primaryPattern, setting);
    } catch (err) {
      return failed(`set_permission: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result({ origin, name, state, applied_as: settingKey });
  },
};
